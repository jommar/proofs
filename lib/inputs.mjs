import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOrigin, proofContextKey } from './origins.mjs';
import { validateOptions } from '../runtime/command.mjs';

const ADAPTERS = ['bdd', 'api'];
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USAGE = 'Usage: node <harness>/run.mjs <ID> [--workspace <path>] [--url [name=]<origin> ... | --worktree [app=]<dir> ...] [--login <userVar,passVar>] [--context key=value ...] [--branch <name>] [--insecure-tls] [--only bdd|api ...] [--ac <id[,id...]> ...] [--debug] [--check | --serve | --plan] [--runtime <trusted-module-path>]';
const URL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const MANIFEST_LIMIT = 1024 * 1024;
const BUILT_IN_RUNTIME = fileURLToPath(new URL('../runtime/command.mjs', import.meta.url));
const LOCAL_RUNTIME = '.proofs-runtime/runtime.mjs';
const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const envName = value => typeof value === 'string' && ENV_NAME.test(value);
const ENV_FILE_LIMIT = 64 * 1024;

// The workspace's own .env fills gaps in the operator's environment (the real environment always wins).
// Plain KEY=VALUE lines only: no expansion, no commands. Values are never printed.
async function loadEnvFile(workspace) {
  const path = join(workspace, '.env');
  const info = await localEntry(path, 'Workspace .env', false, true);
  if (!info || info.size > ENV_FILE_LIMIT) return {};
  const values = {};
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return values;
}

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() !== '' && !/[\x00-\x1f\x7f]/.test(value);

function parseArgs([ticket, ...flags]) {
  if (typeof ticket !== 'string' || !SAFE_NAME.test(ticket)) throw new Error(USAGE);
  let plan = false;
  let insecureTls = false;
  let check = false;
  let debug = false;
  let serve = false;
  let branch;
  let login;
  const only = [];
  const selectedAcs = [];
  const worktrees = [];
  const paths = {};
  const urls = [];
  const context = [];
  for (let i = 0; i < flags.length; i++) {
    if (['--workspace', '--runtime'].includes(flags[i]) && !Object.hasOwn(paths, flags[i])) {
      const flag = flags[i];
      const value = flags[++i];
      if (!text(value) || value.startsWith('--')) throw new Error(USAGE);
      paths[flag] = value;
    } else if (['--url', '--context'].includes(flags[i])) {
      const flag = flags[i];
      const value = flags[++i];
      if (!text(value) || value.startsWith('--')) throw new Error(USAGE);
      (flag === '--url' ? urls : context).push(value);
    } else if (flags[i] === '--worktree') {
      const value = flags[++i];
      if (!text(value) || value.startsWith('--')) throw new Error(USAGE);
      worktrees.push(value);
    } else if (flags[i] === '--login' && login === undefined) {
      const [usernameEnv, passwordEnv, ...extra] = String(flags[++i]).split(',');
      if (extra.length || !envName(usernameEnv) || !envName(passwordEnv)) {
        throw new Error('--login takes two environment variable names, like USER_VAR,PASS_VAR (never the values).');
      }
      login = { usernameEnv, passwordEnv };
    } else if (flags[i] === '--only') {
      const name = flags[++i];
      if (!ADAPTERS.includes(name) || only.includes(name)) throw new Error(USAGE);
      only.push(name);
    } else if (flags[i] === '--ac') {
      const raw = flags[++i];
      if (!text(raw) || raw.startsWith('--')) throw new Error(USAGE);
      const parts = raw.split(',').map(part => part.trim());
      if (parts.some(part => !part || !SAFE_NAME.test(part))) throw new Error('--ac takes comma-separated AC IDs, like AC1,AC3.');
      for (const part of parts) if (!selectedAcs.includes(part)) selectedAcs.push(part);
    } else if (flags[i] === '--debug' && !debug) {
      debug = true;
    } else if (flags[i] === '--serve' && !serve) {
      serve = true;
    } else if (flags[i] === '--check' && !check) {
      check = true;
    } else if (flags[i] === '--branch' && branch === undefined) {
      branch = flags[++i];
      if (!text(branch) || branch.startsWith('--') || branch.length > 128) throw new Error(USAGE);
    } else if (flags[i] === '--insecure-tls' && !insecureTls) {
      insecureTls = true;
    } else if (flags[i] === '--plan' && !plan) {
      plan = true;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!urls.length && !worktrees.length) throw new Error(`Give a target: --url <origin> or --worktree <dir>.\n${USAGE}`);
  if (urls.length && paths['--runtime']) throw new Error('--url checks a running environment; do not combine it with --runtime.');
  if (urls.length && worktrees.length) throw new Error('Give either --url or --worktree, not both.');
  if (!urls.length && (context.length || insecureTls || branch !== undefined)) throw new Error('--context, --branch and --insecure-tls apply only with --url.');
  if (serve && urls.length) throw new Error('--serve starts a local --worktree sandbox; do not combine it with --url.');
  if (serve && (plan || check || only.length || selectedAcs.length)) {
    throw new Error('--serve starts a local sandbox only; do not combine it with --plan, --check, --only or --ac.');
  }
  return { ticket, plan, check, debug, serve, only, selectedAcs, worktrees, login, urls, context, insecureTls, branch, workspacePath: paths['--workspace'], runtimePath: paths['--runtime'] };
}

// Build the sandbox environment for a running target from the operator's flags. Logins come from the
// operator's own environment, never from a manifest or a flag.
function targetEnvironment({ urls, context, insecureTls, branch }, env, login) {
  const out = {};
  for (const entry of urls) {
    const [, name = 'APP', value] = /^(?:([^=]+)=)?(.+)$/.exec(entry);
    if (!URL_NAME.test(name)) throw new Error('--url names must be letters, digits and underscores.');
    const key = `PROOF_${name.toUpperCase()}_URL`;
    if (Object.hasOwn(out, key)) throw new Error('Each --url name may be given once.');
    out[key] = localOrigin(value, true);
  }
  for (const entry of context) {
    const [, key, value] = /^([^=]+)=(.+)$/.exec(entry) ?? [];
    if (!CONTEXT_KEY.test(key ?? '') || !text(value)) throw new Error('--context needs key=value.');
    out[`PROOF_CONTEXT_${key.toUpperCase()}`] = value;
  }
  const username = login ? env[login.usernameEnv] : env.PROOF_USERNAME;
  const password = login ? env[login.passwordEnv] : env.PROOF_PASSWORD;
  if (username && password) Object.assign(out, { PROOF_USERNAME: username, PROOF_PASSWORD: password });
  if (env.PROOF_API_HEADERS) out.PROOF_API_HEADERS = env.PROOF_API_HEADERS;
  return { env: out, insecureTls, branch };
}

function under(root, path, label, { absolute = false, rootAllowed = false } = {}) {
  if (text(path) && absolute && isAbsolute(path)) return resolve(path);
  if (!text(path) || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`${label} must be ${absolute ? 'an absolute path or ' : ''}a relative path inside its root.`);
  }
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if ((!rel && !rootAllowed) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be inside its root.`);
  }
  return resolved;
}

async function localEntry(path, label, directory = false, optional = false) {
  let info;
  try {
    info = await lstat(path);
    if (await realpath(path) === path && (directory ? info.isDirectory() : info.isFile())) return info;
  } catch (error) {
    if (optional && !info && error.code === 'ENOENT') return null;
  }
  throw new Error(`${label} must be an existing ${directory ? 'directory' : 'regular file'} without symlinks.`);
}

async function loadManifest(path, info) {
  if (info.nlink !== 1 || info.size > MANIFEST_LIMIT) throw new Error('Ticket manifest must be a regular file without links and at most 1 MiB.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await file.stat();
    if (!current.isFile() || current.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) {
      throw new Error('Ticket manifest changed during setup.');
    }
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error('Ticket manifest changed during setup.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))); }
    catch { throw new Error('Ticket manifest must contain valid JSON.'); }
  } finally { await file.close(); }
}

function validateManifest(manifest) {
  if (!record(manifest)) throw new Error('Ticket manifest must be an object.');
  if (!Array.isArray(manifest.acs) || manifest.acs.length === 0) throw new Error('Manifest needs at least one AC.');
  const ids = new Set();
  for (const ac of manifest.acs) {
    if (!record(ac) || !text(ac.id) || ac.id.trim() !== ac.id || !text(ac.claim)) throw new Error('Each AC needs a nonempty id and claim.');
    if (ids.has(ac.id)) throw new Error('Duplicate AC id in manifest.');
    ids.add(ac.id);
  }
  if (Object.hasOwn(manifest, 'csv') && !Array.isArray(manifest.csv)) throw new Error('Manifest csv must be an array of ticket-relative paths.');
  if (Object.hasOwn(manifest, 'login') && !(record(manifest.login) && envName(manifest.login.usernameEnv) && envName(manifest.login.passwordEnv))) {
    throw new Error('Manifest login needs usernameEnv and passwordEnv: the names of environment variables, never their values.');
  }
  if (Object.hasOwn(manifest, 'runtimeOptions') && !record(manifest.runtimeOptions)) throw new Error('Manifest runtimeOptions must be a JSON object.');
}

async function loadFixtures(ticketDir, paths) {
  const names = new Set();
  const files = new Set();
  const fixtures = [];
  for (const entry of paths) {
    const path = under(ticketDir, entry, 'CSV path');
    const name = basename(path);
    if (!/\.csv$/i.test(name)) throw new Error('CSV path must end in .csv.');
    const info = await localEntry(path, 'CSV fixture');
    const file = `${info.dev}:${info.ino}`;
    if (names.has(name.toLowerCase()) || files.has(file)) throw new Error('Duplicate CSV fixture or output filename.');
    names.add(name.toLowerCase());
    files.add(file);
    fixtures.push({ path, name });
  }
  return fixtures;
}

function git(repo, env, args, error) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ENOENT') throw new Error('Git is required on PATH to validate the proof workspace.');
  if (result.error?.code === 'ETIMEDOUT') throw new Error('Git workspace validation timed out after 30 seconds.');
  // An ambiguous ref may print both a successful ID and a warning.
  if (result.status !== 0 || result.stderr !== '') throw new Error(error);
  return result.stdout.replace(/\r?\n$/, '');
}

const gitEnv = path => ({
  ...(path === undefined ? {} : { PATH: path }),
  LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
});

// --worktree [app=]<dir>: test the checkout's committed HEAD, whichever branch it is (base or feature).
// Uncommitted changes are not exported, so the report says when the checkout is dirty.
async function pinWorktrees(workspace, entries, services, path) {
  const apps = [...new Set(Object.entries(services ?? {}).map(([name, service]) => service?.app ?? name))];
  const env = gitEnv(path);
  const pinned = [];
  for (const entry of entries) {
    const [, named, dirPath] = /^(?:([A-Za-z0-9][A-Za-z0-9._-]{0,63})=)?(.+)$/.exec(entry);
    const app = named ?? (apps.length === 1 ? apps[0] : undefined);
    if (!app) throw new Error('Name the app: --worktree <app>=<dir> (the manifest has several apps).');
    if (pinned.some(item => item.app === app)) throw new Error(`${app}: give each app one --worktree.`);
    const dir = under(workspace, dirPath, `${app} worktree`, { absolute: true, rootAllowed: true });
    await localEntry(dir, `${app} worktree`, true);
    const message = `${app}: not a Git checkout root.`;
    if (git(dir, env, ['rev-parse', '--show-toplevel'], message) !== dir) throw new Error(message);
    const sha = git(dir, env, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], `${app}: cannot read HEAD.`);
    const dirty = git(dir, env, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=no'], `${app}: cannot read checkout status.`) !== '';
    pinned.push({ app, repo: dir, sha, dirty });
  }
  return pinned;
}

export async function resolveInputs(args, requestedWorkspace, env) {
  const parsed = parseArgs(args);
  const { ticket, plan, check, debug, serve, only, selectedAcs, workspacePath, runtimePath } = parsed;
  const workspace = await realpath(workspacePath ?? requestedWorkspace);
  await localEntry(workspace, 'Workspace', true);
  const operatorEnv = { ...await loadEnvFile(workspace), ...env };
  // A ticket's checks live in the harness's own gitignored .proofs/<ID>/ (reports go to .proofs-out/ beside it).
  // A workspace-level .proofs/<ID>/ is also accepted, so the harness works from any checkout.
  const inHarness = await localEntry(join(HARNESS_ROOT, '.proofs', ticket), 'Ticket input directory', true, true);
  const proofsRoot = inHarness ? HARNESS_ROOT : workspace;
  let runtime, runtimeLabel;
  if (!parsed.urls.length) {
    // The operator picks the trusted runtime, never the manifest: --runtime, then PROOFS_RUNTIME, then the
    // .proofs-runtime/runtime.mjs beside the ticket's .proofs/, then the built-in command runtime.
    let chosen = runtimePath ?? env.PROOFS_RUNTIME;
    const local = join(proofsRoot, LOCAL_RUNTIME);
    const useLocal = chosen === undefined && await localEntry(local, 'Local runtime', false, true);
    runtime = useLocal ? local : chosen === undefined ? BUILT_IN_RUNTIME : under(workspace, chosen, 'Runtime module', { absolute: true });
    await localEntry(runtime, 'Runtime module');
    runtimeLabel = chosen === undefined && !useLocal ? 'built-in command runtime' : relative(useLocal ? proofsRoot : workspace, runtime) || runtime;
  }
  const proofs = join(proofsRoot, '.proofs');
  await localEntry(proofs, 'Proof input directory', true);
  const ticketDir = join(proofs, ticket);
  await localEntry(ticketDir, 'Ticket input directory', true);
  const manifestPath = join(ticketDir, 'manifest.json');
  const manifest = await loadManifest(manifestPath, await localEntry(manifestPath, 'Ticket manifest'));
  validateManifest(manifest);
  if (selectedAcs.length) {
    const known = new Set(manifest.acs.map(({ id }) => id));
    const unknown = selectedAcs.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`Unknown AC in --ac: ${unknown.join(', ')}.`);
  }
  const login = parsed.login ?? manifest.login;
  const target = parsed.urls.length ? targetEnvironment(parsed, operatorEnv, login) : null;
  // The built-in runtime reads its services from the manifest: fail at --plan, not on a live run.
  // One top-level login serves both modes; explicit --login overrides manifest.runtimeOptions.login too.
  const runtimeLogin = parsed.login ?? manifest.runtimeOptions?.login ?? manifest.login;
  const runtimeOptions = runtimeLogin ? { ...manifest.runtimeOptions, login: runtimeLogin } : manifest.runtimeOptions ?? {};
  if (!target && runtime === BUILT_IN_RUNTIME) validateOptions(runtimeOptions);
  const fixtures = await loadFixtures(ticketDir, manifest.csv ?? []);
  const adapters = [];
  for (const name of ADAPTERS) {
    const checks = join(ticketDir, name);
    if ((!only.length || only.includes(name)) && await localEntry(checks, `${name} ticket directory`, true, true)) {
      adapters.push({ name, ticketDir: checks, entry: fileURLToPath(new URL(`../${name}/run.mjs`, import.meta.url)) });
    }
  }
  const worktrees = parsed.worktrees.length ? await pinWorktrees(workspace, parsed.worktrees, runtimeOptions.services, env.PATH) : [];
  const commits = { run: Object.fromEntries(worktrees.map(({ app, repo, sha }) => [app, { repo, sha }])) };
  return { plan, check, debug, serve, selectedAcs, target, worktrees, workspace, proofsRoot, ticket, ticketDir, runtime, runtimeLabel, env: operatorEnv, runtimeOptions, acs: manifest.acs, commits, adapters, fixtures };
}
