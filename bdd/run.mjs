import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOrigin, proofContextKey, proofUrlKey } from '../lib/origins.mjs';
import { loopbackProxy } from './loopback.mjs';
import { acTag, blockRow } from './reporter.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const specFile = /\.spec\.(?:[cm]?js|[cm]?ts)$/;
const acTagGlobal = /@AC[1-9]\d*(?!\d)/g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/.*$/gm, '$1');
}

function parsedTags(source) {
  const clean = stripComments(source);
  const tags = [];
  // Match Playwright { tag: '@AC1' } or { tag: ['@AC1', '@AC2'] } options.
  for (const match of clean.matchAll(/\btag\s*:\s*(?:(['"`])(@AC[1-9]\d*)\1|\[([^\]]*)\])/g)) {
    if (match[2]) {
      tags.push(match[2]);
    } else if (match[3]) {
      for (const item of match[3].matchAll(/(['"`])(@AC[1-9]\d*)\1/g)) tags.push(item[2]);
    }
  }
  // Match Playwright inline tags inside test(...) or test.describe(...) titles.
  for (const match of clean.matchAll(/\btest(?:\.(?:describe|only|skip|fixme|fail))*\(\s*(['"`])([^'"`]*)\1/g)) {
    for (const token of match[2].match(acTagGlobal) ?? []) tags.push(token);
  }
  return tags;
}

async function taggedCriteria(dir) {
  const found = new Set();
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const source = join(path, entry.name);
      if (entry.isDirectory()) await walk(source);
      if (!entry.isFile() || !specFile.test(entry.name)) continue;
      for (const tag of parsedTags(await readFile(source, 'utf8'))) {
        if (acTag.test(tag)) found.add(tag.slice(1));
      }
    }
  }
  await walk(dir);
  return found;
}

async function cli(bin, args, cwd, env, logPath) {
  let log;
  if (logPath) {
    log = createWriteStream(logPath, { mode: 0o600, flags: 'a' });
    await new Promise(resolve => log.once('open', resolve));
  }
  try {
    return await new Promise(resolve => {
      // Framework errors can contain selectors, credentials or response data, so write only to private local diagnostics.
      const child = spawn(process.execPath, [join(directory, 'node_modules', '.bin', bin), ...args], {
        cwd, env, stdio: log ? ['ignore', log, log] : 'ignore',
      });
      child.once('error', () => resolve(1));
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    if (log) await new Promise(resolve => log.end(resolve));
  }
}

async function main() {
  const [, , ticket, ...args] = process.argv;
  const { PROOF_RESULTS: results, PROOF_RUN_DIR: runDir } = process.env;
  if (args.length || ![ticket, results, runDir].every(value => value && isAbsolute(value))) {
    throw new Error('Expected absolute ticket directory, PROOF_RESULTS and PROOF_RUN_DIR');
  }
  const realRunDir = await realpath(runDir);
  const resultDir = relative(realRunDir, await realpath(dirname(results)));
  if (resultDir === '..' || resultDir.startsWith(`..${sep}`) || isAbsolute(resultDir)) {
    throw new Error('Expected results inside private run directory');
  }
  let diagDir;
  if (process.env.PROOF_DIAGNOSTICS_DIR && isAbsolute(process.env.PROOF_DIAGNOSTICS_DIR)) {
    const relDiag = relative(realRunDir, await realpath(process.env.PROOF_DIAGNOSTICS_DIR).catch(() => ''));
    if (relDiag && relDiag !== '..' && !relDiag.startsWith(`..${sep}`) && !isAbsolute(relDiag)) {
      diagDir = process.env.PROOF_DIAGNOSTICS_DIR;
    }
  }
  const debug = process.env.PROOF_DEBUG === '1' && Boolean(diagDir);
  const allAcs = await taggedCriteria(ticket);
  if (!allAcs.size) throw new Error('No tagged acceptance criteria');
  const selectedAcs = process.env.PROOF_ACS ? new Set(process.env.PROOF_ACS.split(',').filter(Boolean)) : null;
  const acs = selectedAcs ? new Set([...allAcs].filter(ac => selectedAcs.has(ac))) : allAcs;
  if (!acs.size) {
    const output = await open(results, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await output.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('Expected a private regular result file');
      await output.truncate(0);
    } finally { await output.close(); }
    return;
  }

  let scratch, proxy, reason = 'invalid_runtime_origin';
  const rows = [];
  try {
    const origins = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => proofUrlKey.test(key)).map(([key, url]) => [key, localOrigin(url)]));
    if (!Object.keys(origins).length) throw new Error('Missing runtime origin');
    reason = 'bdd_setup_failed';
    scratch = await mkdtemp(join(runDir, 'bdd-'));
    proxy = await loopbackProxy(new Set(Object.values(origins)));
    await mkdir(join(scratch, 'tmp'));
    await writeFile(join(scratch, 'package.json'), '{"type":"module"}\n');
    await symlink(join(directory, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const envKeys = new Set([
      'PATH', 'LANG', 'LC_ALL', 'PROOF_CSV_DIR', 'PROOF_SIDE', 'PROOF_TICKET',
      'PROOF_USERNAME', 'PROOF_PASSWORD', 'PROOF_TARGET', 'PROOF_INSECURE_TLS', 'PROOF_PERSONA', 'PROOF_TARGET_NAME',
    ]);
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => envKeys.has(key) || (proofContextKey.test(key) && !key.endsWith('_URL'))));
    Object.assign(env, origins, {
      HOME: scratch,
      TMPDIR: join(scratch, 'tmp'),
      PROOF_RUN_DIR: scratch,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright'),
      PROOF_BDD_EVIDENCE: join(scratch, 'evidence.json'),
      ...(diagDir ? { PROOF_DIAGNOSTICS_DIR: diagDir } : {}),
      ...(debug ? { PROOF_DEBUG: '1' } : {}),
    });
    // Test configuration never lives in an authoring directory.
    const grepPattern = `@(?:${[...acs].join('|')})(?!\\d)`;
    await writeFile(join(scratch, 'playwright.config.mjs'), `
      import { defineConfig } from '@playwright/test';

      export default defineConfig({
        testDir: ${JSON.stringify(ticket)},
        testMatch: /.*\\.spec\\.(?:[cm]?js|[cm]?ts)$/,
        grep: new RegExp(${JSON.stringify(grepPattern)}),
        workers: 1, retries: 0, globalTimeout: 270000, timeout: 90000,
        outputDir: 'test-results', preserveOutput: ${JSON.stringify(debug ? 'failures-only' : 'never')},
        reporter: [[${JSON.stringify(join(directory, 'reporter.mjs'))}]],
        use: {
          browserName: 'chromium', headless: true,
          trace: ${JSON.stringify(debug ? 'retain-on-failure' : 'off')},
          screenshot: ${JSON.stringify(debug ? 'only-on-failure' : 'off')},
          video: 'off', serviceWorkers: 'block',
          ignoreHTTPSErrors: ${process.env.PROOF_TARGET !== '1' || process.env.PROOF_INSECURE_TLS === '1'},
          proxy: { server: ${JSON.stringify(proxy.url)}, bypass: '<-loopback>' },
          launchOptions: { args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] },
        },
      });
    `, { mode: 0o600 });
    reason = 'bdd_execution_failed';
    const code = await cli('playwright', ['test'], scratch, env, diagDir ? join(diagDir, 'playwright.log') : undefined);
    reason = code === 0 ? 'scenario_not_run' : 'bdd_execution_failed';
    if (debug) {
      const pwResults = join(scratch, 'test-results');
      const entries = await readdir(pwResults).catch(() => []);
      if (entries.length) await cp(pwResults, join(diagDir, 'playwright'), { recursive: true }).catch(() => {});
    }
    const evidence = JSON.parse(await readFile(env.PROOF_BDD_EVIDENCE, 'utf8'));
    const complete = evidence.complete && (code === 0 ? evidence.status === 'passed' : evidence.status === 'failed');
    const incompleteAcs = new Set(evidence.rows.filter(row => row.status !== 'pass').map(row => row.ac));
    for (const row of evidence.rows) {
      const invalidate = !complete && row.status === 'pass' && (evidence.status !== 'timedout' || incompleteAcs.has(row.ac));
      rows.push(invalidate ? { ac: row.ac, ...blockRow('bdd_execution_incomplete') } : row);
    }
  } catch {
    // Never write a child error message; append a safe stage code below.
  } finally {
    proxy?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }

  const reported = new Set(rows.map(({ ac }) => ac));
  for (const ac of acs) {
    if (!reported.has(ac)) rows.push({ ac, status: 'blocked', observed: { reason } });
  }
  const output = await open(results, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await output.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Expected a private regular result file');
    await output.truncate(0);
    await output.writeFile(rows.map(row => JSON.stringify(row) + '\n').join(''));
  }
  finally { await output.close(); }
}

main().catch(() => {
  console.error('BDD proof adapter could not publish evidence; check invocation, ticket tags and result path.');
  process.exitCode = 1;
});
