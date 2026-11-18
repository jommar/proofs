import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOrigin, proofContextKey } from './origins.mjs';
import { validateOptions } from '../runtime/command.mjs';

const ADAPTERS = ['bdd', 'api'];
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USAGE = 'Usage: node <harness>/run.mjs <ID> [--workspace <path>] [--url [name=]<origin> ...] [--context key=value ...] [--branch <name>] [--insecure-tls] [--only bdd|api ...] [--check] [--runtime <trusted-module-path>] [--plan] [--post-merge]';
const URL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const MANIFEST_LIMIT = 1024 * 1024;
const BUILT_IN_RUNTIME = fileURLToPath(new URL('../runtime/command.mjs', import.meta.url));
const WORKSPACE_RUNTIME = '.proofs-runtime/runtime.mjs';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
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
  let postMerge = false;
  let insecureTls = false;
  let check = false;
  let branch;
  const only = [];
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
    } else if (flags[i] === '--only') {
      const name = flags[++i];
      if (!ADAPTERS.includes(name) || only.includes(name)) throw new Error(USAGE);
      only.push(name);
    } else if (flags[i] === '--check' && !check) {
      check = true;
    } else if (flags[i] === '--branch' && branch === undefined) {
      branch = flags[++i];
      if (!text(branch) || branch.startsWith('--') || branch.length > 128) throw new Error(USAGE);
    } else if (flags[i] === '--insecure-tls' && !insecureTls) {
      insecureTls = true;
    } else if (flags[i] === '--plan' && !plan) {
      plan = true;
    } else if (flags[i] === '--post-merge' && !postMerge) {
      postMerge = true;
    } else {
      throw new Error(USAGE);
    }
  }
  if (urls.length && (postMerge || paths['--runtime'])) throw new Error('--url checks a running environment; do not combine it with --post-merge or --runtime.');
  if (!urls.length && (context.length || insecureTls || branch !== undefined)) throw new Error('--context, --branch and --insecure-tls apply only with --url.');
  return { ticket, plan, postMerge, check, only, urls, context, insecureTls, branch, workspacePath: paths['--workspace'], runtimePath: paths['--runtime'] };
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

function validateManifest(manifest, postMerge, target) {
  if (!record(manifest)) throw new Error('Ticket manifest must be an object.');
  if (!Array.isArray(manifest.acs) || manifest.acs.length === 0) throw new Error('Manifest needs at least one AC.');
  const ids = new Set();
  for (const ac of manifest.acs) {
    if (!record(ac) || !text(ac.id) || ac.id.trim() !== ac.id || !text(ac.claim)) throw new Error('Each AC needs a nonempty id and claim.');
    if (ids.has(ac.id)) throw new Error('Duplicate AC id in manifest.');
    ids.add(ac.id);
  }
  // Target mode checks a running environment, so a manifest's apps (pins) are not used.
  if (!target) {
    if (!record(manifest.apps) || !Object.keys(manifest.apps).length) throw new Error('Manifest apps must specify at least one application.');
    for (const [app, config] of Object.entries(manifest.apps)) {
      if (!SAFE_NAME.test(app)) throw new Error('Application names must be safe file segments of at most 64 characters.');
      if (!record(config)) throw new Error(`${app}: application input must be an object.`);
      if (!text(config.repo)) throw new Error(`${app}: repo must be a path.`);
      if (!text(config.mergedRef) || !config.mergedRef.startsWith('refs/heads/') || config.mergedRef === 'refs/heads/') {
        throw new Error(`${app}: mergedRef must be a fully qualified local refs/heads/ branch.`);
      }
      if (postMerge) continue;
      if (!text(config.before)) throw new Error(`${app}: valid before ref is required.`);
      if (Object.hasOwn(config, 'after') && !text(config.after)) throw new Error(`${app}: after ref must be nonempty.`);
      if (Object.hasOwn(config, 'worktree') && !text(config.worktree)) throw new Error(`${app}: worktree must be a path.`);
      if (config.worktree === undefined && config.after === undefined) throw new Error(`${app}: after is required when no worktree is supplied.`);
    }
  }
  if (Object.hasOwn(manifest, 'csv') && !Array.isArray(manifest.csv)) throw new Error('Manifest csv must be an array of ticket-relative paths.');
  if (Object.hasOwn(manifest, 'login') && !(record(manifest.login) && ENV_NAME.test(manifest.login.usernameEnv) && ENV_NAME.test(manifest.login.passwordEnv))) {
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

async function pinCommits(workspace, apps, path, postMerge) {
  const env = {
    ...(path === undefined ? {} : { PATH: path }),
    LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
  };
  const before = {};
  const after = {};
  for (const [app, { repo: repoPath, worktree, before: beforeRef, after: afterRef, mergedRef }] of Object.entries(apps)) {
    const primary = under(workspace, repoPath, `${app} repository`, { absolute: true, rootAllowed: true });
    await localEntry(primary, `${app} repository`, true);
    const readGit = (repo, args, message) => git(repo, env, args, `${app}: ${message}`);
    const verifyRoot = (repo, label) => {
      if (readGit(repo, ['rev-parse', '--show-toplevel'], `cannot read ${label} as a Git checkout root.`) !== repo) {
        throw new Error(`${app}: ${label} is not a Git checkout root.`);
      }
    };
    const commit = (repo, ref, label) => {
      const sha = readGit(repo, ['-c', 'core.warnAmbiguousRefs=true', 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], `cannot unambiguously resolve ${label} as a commit.`);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new Error(`${app}: invalid resolved ${label} commit.`);
      return sha;
    };
    verifyRoot(primary, 'repository');
    readGit(primary, ['check-ref-format', mergedRef], 'mergedRef must be a valid local branch name.');
    if (postMerge) {
      const sha = readGit(primary, ['show-ref', '--verify', '--hash', mergedRef], 'configured local branch is required (no fallback).');
      if (commit(primary, sha, 'local branch') !== sha) throw new Error(`${app}: local branch must point directly to a commit.`);
      after[app] = { repo: primary, sha };
      continue;
    }
    let repo = primary;
    if (worktree !== undefined) {
      const target = under(workspace, worktree, `${app} worktree`, { absolute: true });
      await localEntry(target, `${app} worktree`, true);
      verifyRoot(target, 'worktree');
      const common = location => readGit(location, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'cannot verify worktree identity.');
      const gitDir = readGit(target, ['rev-parse', '--absolute-git-dir'], 'cannot verify worktree identity.');
      const shared = await realpath(common(target));
      if (target === primary || await realpath(gitDir) === shared || shared !== await realpath(common(primary))) {
        throw new Error(`${app}: worktree must be a linked worktree of this app, not its primary checkout.`);
      }
      repo = target;
    }
    const baseline = commit(repo, beforeRef, 'before ref');
    const candidate = commit(repo, worktree === undefined ? afterRef : 'HEAD', worktree === undefined ? 'after ref' : 'worktree HEAD');
    if (worktree !== undefined) {
      if (afterRef !== undefined && candidate !== commit(repo, afterRef, 'after ref')) throw new Error(`${app}: after ref does not match worktree HEAD.`);
      const status = readGit(repo, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], 'cannot verify worktree cleanliness.');
      if (status || commit(repo, 'HEAD', 'worktree HEAD') !== candidate) throw new Error(`${app}: worktree must have a clean, stable HEAD.`);
    }
    before[app] = { repo: primary, sha: baseline };
    after[app] = { repo, sha: candidate };
  }
  return postMerge ? { after } : { before, after };
}

export async function resolveInputs(args, requestedWorkspace, env) {
  const parsed = parseArgs(args);
  const { ticket, plan, postMerge, check, only, workspacePath, runtimePath } = parsed;
  const workspace = await realpath(workspacePath ?? requestedWorkspace);
  await localEntry(workspace, 'Workspace', true);
  const operatorEnv = { ...await loadEnvFile(workspace), ...env };
  let runtime, runtimeLabel;
  if (!parsed.urls.length) {
    // The operator picks the trusted runtime, never the manifest: --runtime, then PROOFS_RUNTIME, then the
    // workspace's own .proofs-runtime/runtime.mjs, then the built-in command runtime.
    let chosen = runtimePath ?? env.PROOFS_RUNTIME;
    if (chosen === undefined && await localEntry(join(workspace, WORKSPACE_RUNTIME), 'Workspace runtime', false, true)) chosen = WORKSPACE_RUNTIME;
    runtime = chosen === undefined ? BUILT_IN_RUNTIME : under(workspace, chosen, 'Runtime module', { absolute: true });
    await localEntry(runtime, 'Runtime module');
    runtimeLabel = chosen === undefined ? 'built-in command runtime' : relative(workspace, runtime) || runtime;
  }
  const proofs = join(workspace, '.proofs');
  await localEntry(proofs, 'Proof input directory', true);
  const ticketDir = join(proofs, ticket);
  await localEntry(ticketDir, 'Ticket input directory', true);
  const manifestPath = join(ticketDir, 'manifest.json');
  const manifest = await loadManifest(manifestPath, await localEntry(manifestPath, 'Ticket manifest'));
  validateManifest(manifest, postMerge, !!parsed.urls.length);
  const target = parsed.urls.length ? targetEnvironment(parsed, operatorEnv, manifest.login) : null;
  // The built-in runtime reads its services from the manifest: fail at --plan, not on a live run.
  // One top-level login serves both modes; the built-in runtime reads it from its options.
  const runtimeOptions = manifest.login && !manifest.runtimeOptions?.login ? { ...manifest.runtimeOptions, login: manifest.login } : manifest.runtimeOptions ?? {};
  if (!target && runtime === BUILT_IN_RUNTIME) validateOptions(runtimeOptions);
  const fixtures = await loadFixtures(ticketDir, manifest.csv ?? []);
  const adapters = [];
  for (const name of ADAPTERS) {
    const checks = join(ticketDir, name);
    if ((!only.length || only.includes(name)) && await localEntry(checks, `${name} ticket directory`, true, true)) {
      adapters.push({ name, ticketDir: checks, entry: fileURLToPath(new URL(`../${name}/run.mjs`, import.meta.url)) });
    }
  }
  const commits = target ? { after: {} } : await pinCommits(workspace, manifest.apps, env.PATH, postMerge);
  const mergedRefs = target ? {} : Object.fromEntries(Object.entries(manifest.apps).map(([app, { mergedRef }]) => [app, mergedRef]));
  return { plan, postMerge, check, target, workspace, ticket, ticketDir, runtime, runtimeLabel, mergedRefs, env: operatorEnv, runtimeOptions, acs: manifest.acs, commits, adapters, fixtures };
}
