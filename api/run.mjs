import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { validateHeaderValue } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { localOrigin, proofContextKey, proofUrlKey } from '../lib/origins.mjs';
import { check, parseRequest, prepare, responseValue } from './bruno.mjs';
import { exchange } from './local-http.mjs';

const require = createRequire(import.meta.url);
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (item, allowed) => object(item) && Object.keys(item).every(key => allowed.includes(key));

function escapes(root, path) {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function privateInput(root, name, limit) {
  const file = await realpath(resolve(root, name));
  if (escapes(root, file)) throw new Error('Invalid input path');
  const info = await stat(file);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid input file');
  return readFile(file, 'utf8');
}

async function loadManifest(ticket) {
  const manifest = JSON.parse(await privateInput(ticket, 'proof.json', 128 * 1024));
  if (!fields(manifest, ['folders']) || !Array.isArray(manifest.folders) || !manifest.folders.length) throw new Error();
  const folderPaths = new Set();
  for (const folder of manifest.folders) {
    if (!fields(folder, ['path', 'auth', 'requests']) || typeof folder.path !== 'string' ||
        !folder.path.split('/').every(name => namePattern.test(name)) || folderPaths.has(folder.path) ||
        !['none', 'runtime'].includes(folder.auth) || !object(folder.requests) || !Object.keys(folder.requests).length) {
      throw new Error();
    }
    folderPaths.add(folder.path);
    for (const [file, spec] of Object.entries(folder.requests)) {
      if (!namePattern.test(file) || !file.endsWith('.bru') || !fields(spec, ['ac', 'role', 'csv', 'expectAuthRejection']) ||
          (spec.role === 'prerequisite' ? spec.ac !== undefined : spec.role !== undefined ||
             typeof spec.ac !== 'string' || !/^AC[1-9]\d*$/.test(spec.ac))) throw new Error();
      if (spec.expectAuthRejection !== undefined && (spec.expectAuthRejection !== true || !spec.ac)) throw new Error();
      if (spec.csv !== undefined && (!fields(spec.csv, ['file', 'case']) || typeof spec.csv.file !== 'string' ||
          !namePattern.test(spec.csv.file) || !spec.csv.file.endsWith('.csv') || typeof spec.csv.case !== 'string' || !spec.csv.case)) {
        throw new Error();
      }
    }
    if (!Object.values(folder.requests).some(spec => spec.ac)) throw new Error();
  }
  return manifest;
}

function blocked(requests, observed) {
  return requests.filter(({ ac }) => ac).map(({ ac }) => ({ ac, status: 'blocked', observed }));
}

async function csvVars(spec, directory) {
  if (!spec) return [];
  if (!directory || !isAbsolute(directory)) throw new Error('Missing CSV directory');
  const input = await privateInput(await realpath(directory), spec.file, 2 * 1024 * 1024);
  const { parse } = require('csv-parse/sync');
  const rows = parse(input, {
    bom: true, skip_empty_lines: true,
    columns: names => {
      if (!names.includes('case') || new Set(names).size !== names.length || names.some(name => !/^[A-Za-z_][\w]*$/.test(name))) {
        throw new Error('Invalid CSV headings');
      }
      return names;
    },
  }).filter(row => row.case === spec.case);
  if (rows.length !== 1) throw new Error('Missing or ambiguous CSV case');
  return Object.entries(rows[0]).map(([key, value]) => [`csv.${key}`, value]);
}

function assessResponse(request, response, assertions) {
  const { status } = response;
  if ((status === 401 || status === 403) && !request.expectAuthRejection) {
    return ['blocked', `HTTP ${status}; authentication or authorization prevented the check`];
  }
  if (request.bodyStatus !== undefined && status !== request.bodyStatus) {
    return request.expectAuthRejection
      ? ['fail', `HTTP ${status}; expected rejection status did not match; body checks not run`]
      : ['blocked', `HTTP ${status}; response status prerequisite did not match; body checks not run`];
  }
  if (request.bodyShape && (!response.json ||
      !(request.bodyShape === 'array' ? Array.isArray(response.body) : object(response.body)))) {
    return ['blocked', `HTTP ${status}; expected a usable JSON ${request.bodyShape}; body checks not run`];
  }
  const failed = assertions.flatMap((assertion, i) => check(response, assertion) ? [] : [i + 1]);
  const count = assertions.length;
  return failed.length
    ? ['fail', `HTTP ${status}; checks ${failed.slice(0, 8).join(', ')} contradicted (${failed.length} of ${count})`]
    : ['pass', `HTTP ${status}; all ${count} checks matched`];
}

function labelObservation(label, observation, privateValues) {
  if (!label || privateValues.some(value => label.toLowerCase().includes(value))) {
    return observation;
  }
  return `${observation} — ${label}`;
}

function readAuthHeaders(value, origins) {
  const headers = JSON.parse(value ?? '{}');
  if (!object(headers)) throw new Error('Invalid runtime headers');
  for (const [key, entry] of Object.entries(headers)) {
    if (!Object.hasOwn(origins, key) || !fields(entry, ['authorization', 'cookie'])) throw new Error('Invalid runtime headers');
    for (const [name, value] of Object.entries(entry)) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid runtime header value');
      validateHeaderValue(name, value);
    }
  }
  return headers;
}

async function runFolder(ticket, folder, parser, { origins, globals, runtimeHeaders, privateValues, csvDir }) {
  const specs = Object.values(folder.requests);
  if (folder.auth === 'runtime' && !runtimeHeaders) return blocked(specs, 'Invalid runtime authentication header configuration');
  let requests;
  try {
    requests = await Promise.all(Object.entries(folder.requests).map(async ([name, spec]) => ({
      ...spec, ...parseRequest(parser, await privateInput(ticket, `${folder.path}/${name}`, 256 * 1024), spec.expectAuthRejection),
    })));
    if (new Set(requests.map(({ sequence }) => sequence)).size !== requests.length) throw new Error();
    requests.sort((a, b) => a.sequence - b.sequence);
  } catch {
    return blocked(specs, 'Invalid or missing Bruno request, assertion, or sequence');
  }
  const rows = [];
  const state = new Map(globals);
  for (const [index, request] of requests.entries()) {
    let status;
    let observed;
    try {
      const authHeaders = folder.auth === 'runtime' ? runtimeHeaders[request.originKey] : undefined;
      if (folder.auth === 'runtime' && (!authHeaders || !Object.keys(authHeaders).length)) {
        [status, observed] = ['blocked', 'Runtime authentication headers missing for the selected origin'];
      } else {
        const vars = new Map([...state, ...await csvVars(request.csv, csvDir)]);
        const prepared = prepare(request, origins, vars, authHeaders);
        const response = await exchange(prepared.url, prepared);
        [status, observed] = assessResponse(request, response, prepared.assertions);
        for (const { name, value } of request.captures) {
          state.delete(name);
          if (status === 'pass') {
            const captured = responseValue(response, value);
            if (['string', 'number', 'boolean'].includes(typeof captured)) state.set(name, captured);
          }
        }
      }
      if (request.role === 'prerequisite' && request.captures.some(({ name }) => !state.has(name))) status = 'blocked';
    } catch (error) {
      status = 'blocked';
      observed = error.message === 'Unsafe redirect' ? 'Cross-origin or invalid redirect refused' :
        'Request could not exercise the checks: missing input or usable local response';
    }
    if (status !== 'pass') for (const { name } of request.captures) state.delete(name);
    if (request.ac) rows.push({ ac: request.ac, status, observed: labelObservation(request.label, observed, privateValues) });
    else if (status !== 'pass') {
      rows.push(...blocked(requests.slice(index + 1), `Folder prerequisite at sequence ${request.sequence} did not hold`));
      break;
    }
  }
  return rows;
}

async function run(ticket, manifest, env) {
  const specs = manifest.folders.flatMap(folder => Object.values(folder.requests));
  let parser;
  try {
    if (require('@usebruno/lang/package.json').version !== '0.36.0') throw new Error();
    parser = require('@usebruno/lang').bruToJsonV2;
  } catch {
    return blocked(specs, 'Pinned Bruno parser not installed: run npm --prefix api ci from the harness root');
  }
  const origins = {};
  const globals = new Map([['runId', randomUUID()]]);
  for (const [key, value] of Object.entries(env)) {
    if (proofUrlKey.test(key)) {
      try { origins[key] = localOrigin(value); } catch {
        return blocked(specs, 'Invalid runtime origin; expected a loopback HTTP(S) origin');
      }
    } else if (['PROOF_SIDE', 'PROOF_TICKET'].includes(key) || (proofContextKey.test(key) && !key.endsWith('_URL'))) {
      globals.set(key, value);
    }
  }
  if (!Object.keys(origins).length) return blocked(specs, 'Missing runtime origin');
  let runtimeHeaders;
  try { runtimeHeaders = readAuthHeaders(env.PROOF_API_HEADERS, origins); } catch { /* authenticated folders will block */ }
  const privateValues = [...globals.values(), ...Object.values(runtimeHeaders ?? {}).flatMap(Object.values)]
    .filter(Boolean).map(value => value.toLowerCase());
  const config = { origins, globals, runtimeHeaders, privateValues, csvDir: env.PROOF_CSV_DIR };
  const rows = [];
  for (const folder of manifest.folders) rows.push(...await runFolder(ticket, folder, parser, config));
  return rows;
}

async function main() {
  const [, , ticketArg, ...extra] = process.argv;
  const env = process.env;
  if (extra.length || !ticketArg || !isAbsolute(ticketArg) || !env.PROOF_RESULTS || !isAbsolute(env.PROOF_RESULTS)) {
    throw new Error();
  }
  if (env.PROOF_RUN_DIR !== undefined && (!isAbsolute(env.PROOF_RUN_DIR) ||
      escapes(await realpath(env.PROOF_RUN_DIR), await realpath(dirname(env.PROOF_RESULTS))))) throw new Error();
  const ticket = await realpath(ticketArg);
  const manifest = await loadManifest(ticket);
  const out = await open(env.PROOF_RESULTS, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND |
    constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await out.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error();
    const rows = await run(ticket, manifest, env);
    await out.writeFile(rows.map(row => `${JSON.stringify(row)}\n`).join(''));
  } finally {
    await out.close();
  }
}

try {
  await main();
} catch {
  // Never emit exceptions: parser and transport errors can include input or request details.
  console.error('API proof could not start or write evidence; check the absolute ticket path, proof.json, and private PROOF_RESULTS path.');
  process.exitCode = 1;
}
