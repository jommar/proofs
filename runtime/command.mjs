// Built-in runtime: starts each configured service from its pinned commit as a local process.
// Configure it in the ticket manifest under runtimeOptions (see the README, "Built-in runtime").
// It runs the manifest's commands as the current user: review a manifest before running it.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const envName = value => typeof value === 'string' && ENV_NAME.test(value);
const STEP_TIMEOUT_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 2 * 60_000;
const GIT_ENV = {
  LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
};

// Messages built here hold only service names, step names and exit codes, never command text, environment
// values or output, so the runner may show them in the report (proofSafe).
const safe = message => Object.assign(new Error(message), { proofSafe: true });
const fail = message => { throw safe(message); };
const list = (value, label) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) fail(`${label} must be an array of nonempty strings.`);
  return value;
};

function parseOptions(options) {
  const { services, passEnv, teardown, login, context = {} } = options ?? {};
  if (!services || typeof services !== 'object' || Array.isArray(services) || !Object.keys(services).length) {
    fail('The built-in runtime is in use (no --runtime, PROOFS_RUNTIME or .proofs-runtime/runtime.mjs), so the manifest needs runtimeOptions.services naming at least one service. To test a running environment instead, pass --url.');
  }
  for (const [name, service] of Object.entries(services)) {
    if (!NAME.test(name)) fail(`Service name "${name}" must be letters, digits and underscores.`);
    if (typeof service?.start !== 'string' || !service.start.trim()) fail(`${name}: start command is required.`);
    list(service.setup, `${name}.setup`);
    for (const path of list(service.link, `${name}.link`)) {
      if (isAbsolute(path) || normalize(path).startsWith('..')) fail(`${name}.link entries must be relative paths inside the repository.`);
    }
  }
  for (const key of list(passEnv, 'passEnv')) if (!ENV_NAME.test(key)) fail(`passEnv entry "${key}" is not a variable name.`);
  list(teardown, 'teardown');
  if (login !== undefined && !(envName(login?.usernameEnv) && envName(login?.passwordEnv))) {
    fail('login needs usernameEnv and passwordEnv variable names.');
  }
  return { services, passEnv: passEnv ?? [], teardown: teardown ?? [], login, context };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Run `sh -c command` in its own process group so a timeout or cancel stops its children too.
function exec(command, { cwd, env, signal, timeoutMs = STEP_TIMEOUT_MS, log }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', log, log] });
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(safe(`exited with code ${code}`));
    });
  });
}

function exportCommit(repo, sha, src, { cwd, env, signal, log }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const git = spawn('git', ['-C', repo, 'archive', '--format=tar', sha], { cwd, env, detached: true, stdio: ['ignore', 'pipe', log] });
    const tar = spawn('tar', ['-x', '-C', src], { cwd, env, detached: true, stdio: ['pipe', log, log] });
    git.stdout.pipe(tar.stdin);
    const stop = () => {
      for (const child of [git, tar]) {
        if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(stop, STEP_TIMEOUT_MS);
    signal.addEventListener('abort', stop, { once: true });
    let pending = 2;
    let firstError;
    const finish = (code, err) => {
      if (err && !firstError) firstError = err;
      else if (code !== 0 && !firstError) firstError = safe(`exited with code ${code}`);
      if (--pending !== 0) return;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(signal.reason);
      else if (firstError) reject(firstError);
      else resolve();
    };
    for (const child of [git, tar]) {
      let ended = false;
      const onceEnd = (code, err) => { if (!ended) { ended = true; finish(code, err); } };
      child.once('error', err => { stop(); onceEnd(1, err); });
      child.once('close', code => onceEnd(code ?? 1));
    }
    tar.stdin.on('error', () => { /* broken pipe if tar exits early */ });
  });
}

async function waitReady(url, child, signal, timeoutMs, getSpawnError = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (getSpawnError()) fail('could not start process');
    if (child.exitCode !== null) fail(`exited with code ${child.exitCode} before it became ready`);
    try {
      // Any HTTP answer below 500 means the server is listening; a 401 or 404 is fine.
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return;
    } catch { /* not listening yet */ }
    await sleep(250, undefined, { signal });
  }
  fail(`did not answer ${url.replace(/^https?:\/\/[^/]+/, '')} within ${Math.round(timeoutMs / 1000)}s`);
}

// Plan-time check of the manifest's runtimeOptions, so a bad or missing services block fails before a run.
export const validateOptions = options => { parseOptions(options); };

// Optional runtime hook, also run by --plan for this built-in runtime: every problem at once, without starting
// anything. A passEnv variable that is not set is a warning (it may be optional); a missing link target is a problem
// because the start would fail on it. Messages hold names only, never values.
export async function preflight({ options, commits = {}, env = process.env }) {
  const config = parseOptions(options);
  const problems = [];
  const warnings = config.passEnv.filter(key => env[key] === undefined || env[key] === '').map(key => `passEnv variable ${key} is not set.`);
  for (const [name, service] of Object.entries(config.services)) {
    const pin = commits[service.app ?? name];
    if (!pin) continue;
    for (const path of list(service.link)) {
      if (!await lstat(join(pin.repo, path)).catch(() => null)) problems.push(`${name}: link target ${path} does not exist in the ${service.app ?? name} checkout.`);
    }
  }
  return { problems, warnings };
}

export async function startSandbox({ id, dir, workspace, commits, options, env: operatorEnv = process.env, signal }) {
  const config = parseOptions(options);
  const slug = id.replace(/[^A-Za-z0-9]/g, '_');
  const base = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', ...config.passEnv]
    .filter(key => operatorEnv[key] !== undefined).map(key => [key, operatorEnv[key]]));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const log = createWriteStream(join(dir, 'service.log'), { mode: 0o600, flags: 'a' });
  await new Promise(resolve => log.once('open', resolve));
  const urls = {};
  const started = [];
  const fill = (text, vars) => text.replace(/\{(port|dir|src|id|slug|workspace|url:[A-Za-z][A-Za-z0-9_]*)\}/g, (_, key) => {
    const value = key.startsWith('url:') ? urls[key.slice(4)] : vars[key];
    if (value === undefined) fail(`Unknown placeholder {${key}}.`);
    return String(value);
  });

  async function close() {
    const running = started.splice(0).reverse().filter(child => child.pid);
    for (const child of running) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    if (running.length) {
      const done = Promise.all(running.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once('close', resolve))));
      const timer = new AbortController();
      await Promise.race([done, sleep(5000, undefined, { signal: timer.signal }).catch(() => {})]);
      timer.abort();
      for (const child of running) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    const vars = { dir, id, slug, workspace };
    const errors = [];
    for (const command of config.teardown) {
      try { await exec(fill(command, vars), { cwd: dir, env: base, signal: new AbortController().signal, log }); } catch (error) { errors.push(error); }
    }
    await new Promise(resolve => log.end(resolve));
    if (errors.length) throw new AggregateError(errors, 'Teardown failed.');
  }

  try {
    for (const [name, service] of Object.entries(config.services)) {
      // Name the service and step in any failure: "app: setup command 2 failed (exited with code 1)".
      const step = async (label, work) => {
        try { return await work(); } catch (error) {
          if (signal.aborted) throw error;
          throw safe(`${name}: ${label} failed${error.proofSafe ? ` (${error.message})` : ''}`);
        }
      };
      const app = service.app ?? name;
      const pin = commits[app] ?? fail(`${name}: the manifest has no app "${app}".`);
      const src = join(dir, 'src', name);
      await mkdir(src, { recursive: true, mode: 0o700 });
      await step('exporting the pinned commit', () => exportCommit(pin.repo, pin.sha, src, {
        cwd: dir, signal, log,
        env: { PATH: base.PATH, ...GIT_ENV },
      }));
      for (const path of list(service.link)) {
        await mkdir(dirname(join(src, path)), { recursive: true });
        await symlink(join(pin.repo, path), join(src, path));
      }
      const port = await freePort();
      const vars = { port, dir, src, id, slug, workspace };
      urls[name] = `http://127.0.0.1:${port}`;
      const env = { ...base, PORT: String(port), HOST: '127.0.0.1', PROOF_ID: id };
      for (const [key, value] of Object.entries(service.env ?? {})) {
        if (!ENV_NAME.test(key) || typeof value !== 'string') fail(`${name}.env needs variable names with string values.`);
        env[key] = fill(value, vars);
      }
      for (const [index, command] of list(service.setup).entries()) {
        await step(`setup command ${index + 1}`, () => exec(fill(command, vars), { cwd: src, env, signal, log }));
      }
      const child = spawn('sh', ['-c', fill(service.start, vars)], { cwd: src, env, detached: true, stdio: ['ignore', log, log] });
      let spawnError;
      child.once('error', err => { spawnError = err; });
      started.push(child);
      await step('start', () => waitReady(`${urls[name]}${service.ready ?? '/'}`, child, signal, (service.readySeconds ?? READY_TIMEOUT_MS / 1000) * 1000, () => spawnError));
    }
  } catch (error) {
    let closeError;
    await close().catch(err => { closeError = err; });
    if (closeError) {
      const combined = new AggregateError([error, closeError], error?.proofSafe ? error.message : 'Startup and rollback failed.');
      if (error?.proofSafe) combined.proofSafe = true;
      throw combined;
    }
    throw error;
  }

  const env = Object.fromEntries(Object.entries(urls).map(([name, url]) => [`PROOF_${name.toUpperCase()}_URL`, url]));
  for (const [key, value] of Object.entries(config.context)) env[`PROOF_CONTEXT_${key.toUpperCase()}`] = String(value);
  if (config.login) {
    const username = operatorEnv[config.login.usernameEnv];
    const password = operatorEnv[config.login.passwordEnv];
    if (username && password) Object.assign(env, { PROOF_USERNAME: username, PROOF_PASSWORD: password });
  }
  return { env, close };
}
