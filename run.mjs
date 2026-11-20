import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeDashboard } from './lib/dashboard.mjs';
import { formatPlan, makeReport, readEvidence } from './lib/evidence.mjs';
import { isAncestor, record, resolveInputs } from './lib/inputs.mjs';
import { appendLedger, ledgerEntry, readLedger } from './lib/ledger.mjs';
import { summarize } from './lib/summary.mjs';
import { localOrigin, proofContextKey, proofUrlKey } from './lib/origins.mjs';
import { describeRun, recordRun } from './lib/runs.mjs';
import { readProofInputs, stageProofInputs, unlockProofInputs } from './lib/snapshot.mjs';

const CREDENTIAL_KEYS = ['PROOF_USERNAME', 'PROOF_PASSWORD'];
const ADAPTER_TIMEOUT_MS = 5 * 60_000;

// Only errors a runtime marks proofSafe (names and exit codes, never command text or output) are shown.
function runIssue(stage, signal, error) {
  if (signal.aborted) return 'Run canceled.';
  return `Failed during ${stage}${error?.proofSafe ? `: ${error.message}` : ''}.`;
}

// Any HTTP answer proves the host is reachable (the status is returned, 0 when nothing answered); TLS is
// verified unless --insecure-tls. With `limit`, also returns up to that many bytes of the body.
function request(url, insecure, { method = 'HEAD', limit = 0 } = {}) {
  return new Promise(resolve => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(url, { method, agent: false, rejectUnauthorized: !insecure, signal: AbortSignal.timeout(15_000) }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        if (size < limit) chunks.push(chunk.subarray(0, limit - size));
        size += chunk.length;
      });
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => resolve({ status: response.statusCode, body: '' }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

const BUILD = /^[A-Za-z0-9._+:-]{1,80}$/;

// How a build exposes its version is app-specific: the profile names an origin, a path and optionally a JSON field.
// Only a short identifier-like value is kept; anything else counts as not detected.
async function detectBuild(version, env, insecure) {
  const origin = env[`PROOF_${version.url.toUpperCase()}_URL`];
  if (!origin) return null;
  const { status, body } = await request(`${origin}${version.path}`, insecure, { method: 'GET', limit: 64 * 1024 });
  if (status < 200 || status >= 300) return null;
  let value = body.trim();
  if (version.field) {
    try {
      value = version.field.split('.').reduce((node, key) => (record(node) ? node[key] : undefined), JSON.parse(body));
    } catch { return null; }
  }
  value = typeof value === 'number' ? String(value) : value;
  return typeof value === 'string' && BUILD.test(value.trim()) ? value.trim() : null;
}

// For a running environment the build must name the commit: some hex token in it is a prefix of the expected SHA
// (or the other way round). Ancestry cannot be checked remotely.
const buildMatches = (build, sha) => (build?.match(/[0-9a-f]{7,40}/gi) ?? []).some(token => sha.startsWith(token.toLowerCase()) || token.toLowerCase().startsWith(sha));

async function privateDir(path, existing = false) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!existing || error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('Proof output directory must be private, owned by the current user, and not a symlink.');
  }
  return path;
}

function parseApiHeaders(raw, origins, credentials) {
  if (typeof raw !== 'string' || raw.length > 32_768) throw new Error('Invalid API header map.');
  const parsed = JSON.parse(raw);
  if (!record(parsed)) throw new Error('Invalid API header map.');
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).map(([key, headers]) => {
    if (!origins.has(key) || !record(headers)) throw new Error('Invalid API header origin.');
    const normalized = {};
    for (const [header, value] of Object.entries(headers)) {
      const field = header.toLowerCase();
      if (!['authorization', 'cookie'].includes(field) || Object.hasOwn(normalized, field) ||
          typeof value !== 'string' || !/^[\x20-\x7e]{1,8192}$/.test(value) || !value.trim()) {
        throw new Error('Invalid API header.');
      }
      normalized[field] = value;
      credentials.add(value);
      if (field === 'authorization') {
        const token = value.trim().match(/^\S+ +(.+)$/)?.[1];
        if (token) credentials.add(token);
      } else {
        for (const cookie of value.split(';')) {
          const separator = cookie.indexOf('=');
          if (separator === -1) continue;
          const token = cookie.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
          if (token) credentials.add(token);
        }
      }
    }
    return [key, normalized];
  })));
}

async function adapterEnv(sandbox, { ticket, target, persona, profile, secrets = [] }, side, dir, sandboxDir, parentEnv) {
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(key => parentEnv[key] !== undefined).map(key => [key, parentEnv[key]]));
  if (!record(sandbox.env)) throw new Error('Sandbox environment is required.');
  const origins = new Set();
  for (const [key, value] of Object.entries(sandbox.env)) {
    if (proofUrlKey.test(key)) {
      env[key] = localOrigin(value, !!target);
      origins.add(key);
    } else if (proofContextKey.test(key) && !key.endsWith('_URL')) {
      if (typeof value !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(value) || !value.trim()) throw new Error('Invalid runtime context.');
      env[key] = value;
    }
  }
  if (!origins.size) throw new Error('At least one sandbox origin is required.');
  const credentials = new Set();
  const bdd = {};
  for (const key of CREDENTIAL_KEYS) {
    const value = sandbox.env[key];
    if (typeof value === 'string' && value) {
      if (value.includes('\0') || Buffer.byteLength(value) > 8192) throw new Error('Invalid BDD credential.');
      bdd[key] = value;
      credentials.add(value);
    }
  }
  const api = sandbox.env.PROOF_API_HEADERS === undefined ? {} : {
    PROOF_API_HEADERS: parseApiHeaders(sandbox.env.PROOF_API_HEADERS, origins, credentials),
  };
  if (target) {
    // A running environment may use a private CA: pass the operator's own CA file through, plus the TLS switch.
    const ca = parentEnv.NODE_EXTRA_CA_CERTS;
    if (typeof ca === 'string' && isAbsolute(ca)) env.NODE_EXTRA_CA_CERTS = ca;
    env.PROOF_TARGET = '1';
    if (target.insecureTls) env.PROOF_INSECURE_TLS = '1';
  } else if (sandbox.env.NODE_EXTRA_CA_CERTS !== undefined) {
    const caPath = sandbox.env.NODE_EXTRA_CA_CERTS;
    const rel = typeof caPath === 'string' && isAbsolute(caPath) ? relative(sandboxDir, caPath) : null;
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || await realpath(caPath) !== caPath) {
      throw new Error('Sandbox CA must be a regular file owned by the proof side.');
    }
    const info = await lstat(caPath);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1) {
      throw new Error('Sandbox CA must be a regular file owned by the proof side.');
    }
    env.NODE_EXTRA_CA_CERTS = caPath;
  }
  // Keep HOME private; pass only the location of already installed browser binaries.
  const browserPath = parentEnv.PLAYWRIGHT_BROWSERS_PATH;
  env.PLAYWRIGHT_BROWSERS_PATH = browserPath === '0' || (browserPath && isAbsolute(browserPath))
    ? browserPath : join(parentEnv.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright');
  Object.assign(env, {
    HOME: dir, TMPDIR: dir, PROOF_RUN_DIR: dir, PROOF_CSV_DIR: join(dir, 'csv'),
    PROOF_SIDE: side, PROOF_TICKET: ticket,
    ...(persona ? { PROOF_PERSONA: persona } : {}),
    ...(profile ? { PROOF_TARGET_NAME: profile.name } : {}),
  });
  for (const secret of secrets) credentials.add(secret);
  return { env, scoped: { bdd, api }, credentials: [...credentials] };
}

async function invokeChild({ entry, ticketDir, cwd, env, signal, logPath }) {
  if (!(await lstat(entry)).isFile() || await realpath(entry) !== entry) throw new Error('Invalid adapter entry');
  signal.throwIfAborted();
  let log;
  if (logPath) {
    log = createWriteStream(logPath, { mode: 0o600, flags: 'a' });
    await new Promise(resolve => log.once('open', resolve));
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, ticketDir], { cwd, env, stdio: log ? ['ignore', log, log] : 'ignore', detached: true });
      let launchError;
      const cancel = () => {
        if (child.pid) {
          // The adapter can itself spawn test workers. Stop the whole proof-owned group.
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
        }
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      child.once('error', error => { launchError = error; });
      child.once('close', code => {
        signal.removeEventListener('abort', cancel);
        if (launchError) reject(launchError);
        else resolve(code);
      });
    });
  } finally {
    if (log) await new Promise(resolve => log.end(resolve));
  }
}

async function copyNonEmptyDiagnostics(src, dest) {
  let copied = false;
  const entries = await readdir(src, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      const sub = await copyNonEmptyDiagnostics(from, to);
      if (sub) copied = true;
    } else if (entry.isFile()) {
      const info = await stat(from).catch(() => null);
      if (!info?.size) continue;
      await mkdir(dest, { recursive: true, mode: 0o700 });
      await copyFile(from, to);
      await chmod(to, 0o600);
      copied = true;
    }
  }
  return copied;
}

async function collectDiagnostics(scratch, runDir, side = 'run') {
  const diagDest = join(runDir, 'diagnostics');
  let copied = false;
  const serviceLog = join(scratch, side, 'sandbox', 'service.log');
  const serviceInfo = await stat(serviceLog).catch(() => null);
  if (serviceInfo?.isFile() && serviceInfo.size > 0) {
    await mkdir(diagDest, { recursive: true, mode: 0o700 });
    const destLog = join(diagDest, 'service.log');
    await copyFile(serviceLog, destLog);
    await chmod(destLog, 0o600);
    copied = true;
  }
  const checksDiag = join(scratch, side, 'checks', 'diagnostics');
  if (await copyNonEmptyDiagnostics(checksDiag, diagDest)) copied = true;
  return copied ? diagDest : undefined;
}

async function cleanupScratch(scratch, phases) {
  // A read-only directory must be made writable before recursively removing our snapshot.
  for (const [side, phase] of Object.entries(phases)) {
    const checkDir = join(scratch, side, 'checks');
    for (const name of ['proofs', 'csv']) await unlockProofInputs(join(checkDir, name));
    await rm(phase.retainSandbox ? checkDir : join(scratch, side), { recursive: true, force: true });
  }
  if (Object.values(phases).some(phase => phase.retainSandbox)) {
    await rm(join(scratch, 'capture'), { recursive: true, force: true });
  } else {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runSide({ side, dir, input, id, dataset, startSandbox, invoke, adapterTimeoutMs, parentEnv, signal }) {
  const outcome = { rows: [], issues: [], warnings: [], invoked: false, timings: { adapters: {} } };
  const sandboxDir = join(dir, 'sandbox');
  const checksDir = join(dir, 'checks');
  let sandbox;
  let stage = 'sandbox startup';
  const startupStart = Date.now();
  try {
    signal.throwIfAborted();
    sandbox = await startSandbox({
      id: `proof-${id}-${side}`, dir: sandboxDir, workspace: input.workspace, dataset,
      commits: structuredClone(input.commits[side]), options: structuredClone(input.runtimeOptions), env: input.env, signal,
    });
    if (typeof sandbox?.close !== 'function') throw new Error('Sandbox close is required.');
    stage = 'sandbox environment validation';
    const { env: shared, scoped, credentials } = await adapterEnv(sandbox, input, side, checksDir, sandboxDir, parentEnv);
    outcome.timings.startupMs = Date.now() - startupStart;
    const ids = new Set(input.acs.map(({ id }) => id));
    outcome.context = Object.fromEntries(Object.entries(shared).filter(([key]) => proofContextKey.test(key) && !key.endsWith('_URL'))
      .map(([key, value]) => [key.slice('PROOF_CONTEXT_'.length).toLowerCase(), value]));
    const insecure = input.target ? input.target.insecureTls : true;
    if (input.check && input.target) {
      for (const [key, origin] of Object.entries(sandbox.env).filter(([name]) => /^PROOF_[A-Z0-9_]+_URL$/.test(name))) {
        const name = key.slice(6, -4).toLowerCase();
        const { status } = await request(origin, insecure);
        if (!status) outcome.issues.push(`${name} is not reachable (DNS, connection or TLS).`);
        else if ([401, 403].includes(status)) {
          outcome.warnings.push(input.login
            ? `${name} answered HTTP ${status}: reachable but unauthenticated. --check does not log in, so the configured login is not verified.`
            : `${name} answered HTTP ${status} and no login is configured; checks that need a session will block.`);
        }
      }
    }
    if (input.version) {
      outcome.build = await detectBuild(input.version, shared, insecure);
    }
    if (input.expectCommit && input.target && !buildMatches(outcome.build, input.expectCommit)) {
      outcome.issues.push(`The environment's build ${outcome.build ? 'does not match' : 'could not be detected, so it cannot be matched to'} --expect-commit ${input.expectCommit}.`);
    }
    const diagRoot = await privateDir(join(checksDir, 'diagnostics'), true);
    const adapters = input.check || outcome.issues.length || input.runAcs?.length === 0 ? [] : input.adapters;
    for (const adapter of adapters) {
      signal.throwIfAborted();
      const adapterStart = Date.now();
      const adapterDiag = await privateDir(join(diagRoot, adapter.name), true);
      const env = {
        ...shared, ...scoped[adapter.name],
        PROOF_RESULTS: join(checksDir, `${adapter.name}.ndjson`),
        PROOF_DIAGNOSTICS_DIR: adapterDiag,
        ...(input.debug ? { PROOF_DEBUG: '1' } : {}),
        ...(input.runAcs ? { PROOF_ACS: input.runAcs.join(',') } : {}),
      };
      const deadline = AbortSignal.timeout(adapterTimeoutMs);
      let code;
      let invocationFailed = false;
      try {
        const ticketDir = join(checksDir, 'proofs', adapter.name, input.ticket);
        code = await invoke({ ...adapter, ticketDir, cwd: checksDir, env, logPath: join(adapterDiag, 'stdio.log'), signal: AbortSignal.any([signal, deadline]) });
        outcome.invoked = true;
      } catch {
        invocationFailed = true;
      }
      outcome.timings.adapters[adapter.name] = Date.now() - adapterStart;
      signal.throwIfAborted();
      if (deadline.aborted) {
        outcome.issues.push(`${adapter.name} adapter timed out after ${adapterTimeoutMs / 1000} seconds; partial evidence discarded.`);
        continue;
      }
      if (invocationFailed) {
        outcome.issues.push(`${adapter.name} adapter could not execute.`);
        continue;
      }
      let rows;
      try {
        rows = await readEvidence(env.PROOF_RESULTS, ids, credentials, { allowEmpty: Boolean(input.runAcs) });
      } catch {
        outcome.issues.push(`${adapter.name} adapter did not produce valid evidence.`);
        continue;
      }
      if (code !== 0) {
        if (!Number.isInteger(code) || !rows.some(row => row.status === 'fail')) {
          outcome.issues.push(`${adapter.name} adapter exited unsuccessfully without an assertion failure.`);
          continue;
        }
        // A nonzero process cannot establish a passing check. Preserve explicit adverse evidence.
        rows = rows.map(row => row.status === 'pass'
          ? { ...row, status: 'blocked', observed: 'Adapter exited unsuccessfully; passing evidence withheld' } : row);
      }
      outcome.rows.push(...rows.map(row => ({ ...row, adapter: adapter.name })));
    }
    signal.throwIfAborted();
  } catch (error) {
    if (outcome.timings.startupMs === undefined) outcome.timings.startupMs = Date.now() - startupStart;
    outcome.issues.push(runIssue(stage, signal, error));
    // Runtime reports startup plus failed rollback as an AggregateError.
    if ((sandbox && typeof sandbox.close !== 'function') || (!sandbox && error instanceof AggregateError)) outcome.retainSandbox = true;
  } finally {
    if (typeof sandbox?.close === 'function') {
      const teardownStart = Date.now();
      try { await sandbox.close(); } catch { outcome.retainSandbox = true; }
      outcome.timings.teardownMs = Date.now() - teardownStart;
    }
    if (signal.aborted && !outcome.issues.includes('Run canceled.')) outcome.issues.push('Run canceled.');
    if (outcome.retainSandbox) {
      outcome.issues.push(`Sandbox cleanup incomplete; check runtime ID proof-${id}-${side} and private setup at .private/${side}/sandbox.`);
    }
  }
  return outcome;
}

function formatServeReady(ticket, env, login, { profile, persona } = {}) {
  const urls = Object.entries(env).filter(([key]) => proofUrlKey.test(key))
    .map(([key, origin]) => [key.slice(6, -4).toLowerCase(), origin]);
  const contexts = Object.entries(env).filter(([key]) => proofContextKey.test(key) && !key.endsWith('_URL'))
    .map(([key, value]) => [key.slice('PROOF_CONTEXT_'.length).toLowerCase(), value]);
  const urlFlags = urls.map(([name, origin]) => `--url ${name}=${origin}`).join(' ');
  const ctxFlags = contexts.map(([key, value]) => `--context ${key}=${value}`).join(' ');
  const loginFlag = login ? ` --login ${login.usernameEnv},${login.passwordEnv}` : '';
  const profileFlags = `${profile ? ` --target ${profile.name}` : ''}${persona ? ` --persona ${persona}` : ''}`;
  const cmd = `node proofs/run.mjs ${ticket}${profileFlags} ${urlFlags}${ctxFlags ? ` ${ctxFlags}` : ''}${loginFlag} --debug`;
  return [
    `Sandbox ready for ${ticket} (Ctrl-C to stop):`,
    ...urls.map(([name, origin]) => `  ${name}: ${origin}`),
    ...contexts.map(([key, value]) => `  context.${key}: ${value}`),
    `Iterate with: ${cmd}`,
  ].join('\n');
}

async function runServe(input, id, scratch, { parentEnv, signal, captureDataset, startSandbox, onReady }) {
  const captureDir = await privateDir(join(scratch, 'capture'));
  const sideDir = await privateDir(join(scratch, 'run'));
  const sandboxDir = await privateDir(join(sideDir, 'sandbox'));
  const checksDir = await privateDir(join(sideDir, 'checks'));
  let sandbox;
  let stage = 'runtime loading';
  try {
    const runtime = startSandbox ? { captureDataset, startSandbox } : await import(pathToFileURL(input.runtime).href);
    if (typeof runtime.startSandbox !== 'function' || (runtime.captureDataset !== undefined && typeof runtime.captureDataset !== 'function')) {
      throw new Error('Invalid runtime exports.');
    }
    let dataset;
    if (runtime.captureDataset) {
      stage = 'dataset capture';
      dataset = await runtime.captureDataset({ dir: captureDir, workspace: input.workspace, options: structuredClone(input.runtimeOptions), signal });
      if (dataset == null) throw new Error('Dataset capture returned no dataset.');
    }
    stage = 'sandbox startup';
    sandbox = await runtime.startSandbox({
      id: `proof-${id}-run`, dir: sandboxDir, workspace: input.workspace, dataset,
      commits: structuredClone(input.commits.run), options: structuredClone(input.runtimeOptions), env: input.env, signal,
    });
    if (typeof sandbox?.close !== 'function') throw new Error('Sandbox close is required.');
    stage = 'sandbox environment validation';
    const { env: shared } = await adapterEnv(sandbox, input, 'run', checksDir, sandboxDir, parentEnv);
    const urls = Object.fromEntries(Object.entries(shared).filter(([key]) => proofUrlKey.test(key)));
    const message = formatServeReady(input.ticket, shared, input.runtimeOptions?.login, input);
    if (onReady) await onReady({ urls, env: shared, message });
    else console.log(message);
    if (!signal.aborted) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
    return { exitCode: 0, served: true, message };
  } catch (error) {
    return { exitCode: 1, served: false, issue: runIssue(stage, signal, error) };
  } finally {
    if (typeof sandbox?.close === 'function') {
      await sandbox.close().catch(() => {});
    }
  }
}

// Target mode starts nothing: the sandbox is the running environment the operator named with --url.
const targetRuntime = target => ({ startSandbox: async () => ({ env: { ...target.env }, close: async () => {} }) });

// A runtime may export preflight({ workspace, commits, options, env, signal }) returning { problems, warnings }
// (arrays of short strings, shown on the console only). --check calls it before starting anything.
async function runtimePreflight(input, options) {
  if (input.target || input.builtInRuntime) return { problems: [], warnings: [] };
  const runtime = options.startSandbox ? options : await import(pathToFileURL(input.runtime).href);
  if (typeof runtime.preflight !== 'function') return { problems: [], warnings: [] };
  const clean = list => (Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item.trim() && item.length <= 300 && !/[\x00-\x1f\x7f]/.test(item));
  try {
    const found = await runtime.preflight({
      workspace: input.workspace, commits: structuredClone(input.commits.run), options: structuredClone(input.runtimeOptions), env: input.env, signal: options.signal,
    });
    return Array.isArray(found) ? { problems: clean(found), warnings: [] } : { problems: clean(found?.problems), warnings: clean(found?.warnings) };
  } catch (error) {
    return { problems: [`Runtime preflight failed${error?.proofSafe ? `: ${error.message}` : ''}.`], warnings: [] };
  }
}

const formatCheck = (issues, warnings, build) => [
  issues.length ? `NOT READY — ${issues.join(' ')}` : warnings.length ? 'ready with warnings' : 'ready',
  ...(build !== undefined ? [`Build: ${build ?? 'build not detected'}`] : []),
  ...(warnings.length ? ['Warnings:', ...warnings.map(text => `- ${text}`)] : []),
].join('\n');

async function runPhases(input, snapshot, id, scratch, options) {
  const { signal } = options;
  const sides = Object.keys(input.commits);
  const sideDirs = sides.map(side => join(scratch, side));
  const captureDir = join(scratch, 'capture');
  let stage = 'input snapshot setup';
  let dataset;
  let runtime;
  try {
    signal.throwIfAborted();
    await privateDir(captureDir);
    for (const dir of sideDirs) {
      await privateDir(dir);
      await privateDir(join(dir, 'sandbox'));
      await privateDir(join(dir, 'checks'));
      await stageProofInputs(snapshot, input, join(dir, 'checks'));
    }
    stage = 'runtime loading';
    // This is explicitly selected trusted same-user code, never a path from the ticket.
    runtime = input.target ? targetRuntime(input.target) : options.startSandbox ? options : await import(pathToFileURL(input.runtime).href);
    if (typeof runtime.startSandbox !== 'function' || (runtime.captureDataset !== undefined && typeof runtime.captureDataset !== 'function')) {
      throw new Error('Invalid runtime exports.');
    }
    signal.throwIfAborted();
    if (runtime.captureDataset) {
      stage = 'dataset capture';
      dataset = await runtime.captureDataset({ dir: captureDir, workspace: input.workspace, options: structuredClone(input.runtimeOptions), signal });
      if (dataset == null) throw new Error('Dataset capture returned no dataset.');
    }
  } catch (error) {
    const issue = runIssue(stage, signal, error);
    return Object.fromEntries(sides.map(side => [side, { rows: [], issues: [issue], invoked: false }]));
  }
  const phases = {};
  for (const side of sides) {
    phases[side] = await runSide({
      ...options, side, dir: join(scratch, side), input, id, dataset, startSandbox: runtime.startSandbox,
    });
  }
  return phases;
}

export async function run(args, {
  workspace = process.cwd(), parentEnv = process.env, signal = new AbortController().signal,
  captureDataset, startSandbox, invoke = invokeChild, adapterTimeoutMs = ADAPTER_TIMEOUT_MS, onReady, cleanup = cleanupScratch,
} = {}) {
  const input = await resolveInputs(args, workspace, parentEnv);
  if (input.summary) {
    const entries = await readLedger(input.ticketDir);
    if (!entries.length) return { exitCode: 1, summary: `No runs recorded for ${input.ticket} yet (.proofs/${input.ticket}/ledger.json).` };
    const { text, complete } = summarize({
      ticket: input.ticket, acs: input.acs, entries, profileNames: Object.keys(input.profiles),
      isAncestor: (repo, a, b) => isAncestor(join(input.workspace, repo), a, b, parentEnv.PATH),
    });
    return { exitCode: complete ? 0 : 1, summary: text };
  }
  const snapshot = await readProofInputs(input);
  input.proofDigest = snapshot.digest;
  if (input.plan) return { exitCode: input.preflight.problems.length ? 1 : 0, plan: formatPlan(input, adapterTimeoutMs) };
  const fatal = input.preflight.problems.filter(({ fatal }) => fatal);
  if (!input.check && fatal.length) throw new Error(`Cannot run: ${fatal.map(({ text }) => text).join(' ')}`);

  if (input.check) {
    // Collect every problem at once: the offline preflight, the runtime's own hook, then the start or probes.
    const hook = await runtimePreflight(input, { signal, startSandbox, captureDataset });
    const issues = [...input.preflight.problems.map(({ text }) => text), ...hook.problems];
    const warnings = [...input.preflight.warnings, ...hook.warnings];
    if (issues.length && !input.target) {
      return { exitCode: 1, check: formatCheck([...issues, 'Sandbox not started: fix the problems above, then run --check again.'], warnings) };
    }
    input.preflightIssues = issues;
    input.preflightWarnings = warnings;
  }

  const id = randomUUID();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const out = await privateDir(join(input.proofsRoot, '.proofs-out'), true);
  const ticketOut = await privateDir(join(out, input.ticket), true);
  const runDir = await privateDir(join(ticketOut, id));
  const scratch = await privateDir(join(runDir, '.private'));

  if (input.serve) {
    const served = await runServe(input, id, scratch, { parentEnv, signal, captureDataset, startSandbox, onReady });
    let diagnosticsDir;
    if (!served.served) diagnosticsDir = await collectDiagnostics(scratch, runDir, 'run');
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (!diagnosticsDir) await rm(runDir, { recursive: true, force: true }).catch(() => {});
    return { ...served, ...(diagnosticsDir ? { diagnosticsDir } : {}) };
  }

  const phases = await runPhases(input, snapshot, id, scratch, { parentEnv, signal, captureDataset, startSandbox, invoke, adapterTimeoutMs });
  const durationMs = Date.now() - startedMs;
  if (phases.run) phases.run.timings = { ...(phases.run.timings ?? { adapters: {} }), durationMs };

  if (input.check) {
    const { issues: runIssues } = phases.run;
    const issues = [...input.preflightIssues, ...runIssues];
    const warnings = [...input.preflightWarnings, ...(phases.run.warnings ?? [])];
    let diagnosticsDir;
    if (runIssues.length) diagnosticsDir = await collectDiagnostics(scratch, runDir, 'run');
    try { await cleanupScratch(scratch, phases); } catch { /* best-effort cleanup */ }
    if (!diagnosticsDir && !phases.run.retainSandbox) await rm(runDir, { recursive: true, force: true }).catch(() => {});
    return {
      exitCode: issues.length ? 1 : 0,
      check: formatCheck(issues, warnings, input.version ? phases.run.build ?? null : undefined),
      ...(diagnosticsDir ? { diagnosticsDir } : {}),
    };
  }

  let { report, exitCode, statuses } = makeReport(input, id, phases);
  let diagnosticsDir;
  if (exitCode !== 0 || input.debug || phases.run.issues.length > 0) {
    diagnosticsDir = await collectDiagnostics(scratch, runDir, 'run');
  }
  try {
    await cleanup(scratch, phases);
  } catch {
    phases.run.issues.push('Private run files could not be removed; check the run directory.');
    if (!diagnosticsDir) diagnosticsDir = await collectDiagnostics(scratch, runDir, 'run');
    ({ report, exitCode, statuses } = makeReport(input, id, phases));
  }
  const reportPath = join(runDir, 'report.md');
  await writeFile(reportPath, report, { flag: 'wx', mode: 0o600 });
  // The report is the deliverable: a failed index write is reported beside it, never as a failed run.
  const runsWarning = await recordRun(out, input.ticket, id, describeRun(input, args, id, {
    startedAt, exitCode, reportPath, durationMs, timings: phases.run.timings,
  }))
    .then(() => undefined, () => 'Run was not added to .proofs-out/runs.json.');
  // The durable ledger feeds --summary; like the index, a failed write is a warning beside the report.
  const ledgerWarning = await appendLedger(input.ticketDir, input.ticket, ledgerEntry(input, id, { startedAt, exitCode, statuses, build: phases.run.build, args }))
    .then(() => undefined, () => `Run was not added to .proofs/${input.ticket}/ledger.json.`);
  let dashboardPath;
  let dashboardWarning;
  if (!runsWarning) {
    try {
      ({ path: dashboardPath } = await writeDashboard(out));
    } catch {
      dashboardWarning = 'Dashboard .proofs-out/dashboard.html could not be updated.';
    }
  }
  return {
    exitCode, reportPath, runsWarning,
    ...(ledgerWarning ? { ledgerWarning } : {}),
    ...(dashboardPath ? { dashboardPath } : {}),
    ...(dashboardWarning ? { dashboardWarning } : {}),
    ...(diagnosticsDir ? { diagnosticsDir } : {}),
  };
}

async function main() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const result = await run(process.argv.slice(2), { signal: controller.signal });
    if (result.summary !== undefined) {
      console.log(result.summary);
      process.exitCode = result.exitCode;
      return;
    }
    if (result.served) {
      // Ready banner was already printed before awaiting Ctrl-C.
    } else if (result.issue) {
      console.error(result.issue);
    } else {
      console.log(result.plan ?? result.check ?? `Report: ${result.reportPath}`);
    }
    if (result.diagnosticsDir) console.error(`Diagnostics: ${result.diagnosticsDir}`);
    if (result.runsWarning) console.error(result.runsWarning);
    if (result.ledgerWarning) console.error(result.ledgerWarning);
    if (result.dashboardWarning) console.error(result.dashboardWarning);
    process.exitCode = result.exitCode;
  } catch (error) {
    // Native filesystem errors can contain arbitrary input paths; do not forward them.
    console.error(error.code ? 'Proof runner could not read inputs or write its report.' : error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) await main();
