import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOrigin, proofContextKey } from './origins.mjs';
import { applicability, capabilitiesFor, CAPABILITY, loadProfiles, PERSONA_NAME, PROFILE_FILE, PROFILE_NAME, SOURCE_NAME } from './targets.mjs';
import { chooseSource, formatQualification, qualifySources, resolvePassword, sourceParts, sourceSecrets, sourceUrl, validateSourceRequires } from './sources.mjs';
import { preflight as builtInPreflight, validateOptions } from '../runtime/command.mjs';

const ADAPTERS = ['bdd', 'api'];
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USAGE = 'Usage: node <harness>/run.mjs <ID> [--workspace <path>] [--target <profile>] [--persona <name>] [--source <name>] [--url [name=]<origin> ... | --worktree [app=]<dir> ...] [--login <userVar,passVar>] [--context key=value ...] [--branch <name>] [--insecure-tls] [--only bdd|api ...] [--ac <id[,id...]> ...] [--require-clean] [--expect-commit <sha>] [--debug] [--check | --serve | --plan] [--runtime <trusted-module-path>]\n       node <harness>/run.mjs <ID> --summary [--workspace <path>]\n       node <harness>/run.mjs --help';
export const MANIFEST_LIMIT = 1024 * 1024;
const URL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const BUILT_IN_RUNTIME = fileURLToPath(new URL('../runtime/command.mjs', import.meta.url));
const LOCAL_RUNTIME = '.proofs-runtime/runtime.mjs';
export const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

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
  let summary = false;
  let requireClean = false;
  let branch;
  let login;
  let targetName;
  let persona;
  let source;
  let expectCommit;
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
    } else if (flags[i] === '--summary' && !summary) {
      summary = true;
    } else if (flags[i] === '--require-clean' && !requireClean) {
      requireClean = true;
    } else if (flags[i] === '--target' && targetName === undefined) {
      targetName = flags[++i];
      if (!PROFILE_NAME.test(targetName ?? '')) throw new Error(`--target names a profile in .proofs/${PROFILE_FILE} (letters, digits, "_" or "-").`);
    } else if (flags[i] === '--persona' && persona === undefined) {
      persona = flags[++i];
      if (!PERSONA_NAME.test(persona ?? '')) throw new Error('--persona takes a persona name (letters, digits, "_" or "-").');
    } else if (flags[i] === '--source' && source === undefined) {
      source = flags[++i];
      if (!SOURCE_NAME.test(source ?? '')) throw new Error('--source names one of the target profile\'s sources (letters, digits, "_" or "-").');
    } else if (flags[i] === '--expect-commit' && expectCommit === undefined) {
      expectCommit = flags[++i];
      if (!/^[0-9a-f]{7,40}$/i.test(expectCommit ?? '')) throw new Error('--expect-commit takes a commit SHA (7 to 40 hex characters).');
      expectCommit = expectCommit.toLowerCase();
    } else {
      throw new Error(USAGE);
    }
  }
  if (summary) {
    if (flags.some(flag => flag.startsWith('--') && !['--summary', '--workspace'].includes(flag))) throw new Error(`--summary reads the ticket's recorded runs; it takes only --workspace.\n${USAGE}`);
    return { ticket, summary, workspacePath: paths['--workspace'] };
  }
  if (!urls.length && !worktrees.length && targetName === undefined) throw new Error(`Give a target: --url <origin>, --worktree <dir> or --target <profile>.\n${USAGE}`);
  if (urls.length && paths['--runtime']) throw new Error('--url checks a running environment; do not combine it with --runtime.');
  if (urls.length && worktrees.length) throw new Error('Give either --url or --worktree, not both.');
  if (serve && urls.length) throw new Error('--serve starts a local --worktree sandbox; do not combine it with --url.');
  if (serve && (plan || check || only.length || selectedAcs.length)) {
    throw new Error('--serve starts a local sandbox only; do not combine it with --plan, --check, --only or --ac.');
  }
  return { ticket, plan, check, debug, serve, summary, requireClean, only, selectedAcs, worktrees, login, urls, context, insecureTls, branch, targetName, persona, source, expectCommit, workspacePath: paths['--workspace'], runtimePath: paths['--runtime'] };
}

// The URL-mode-only flags make sense once a profile may supply the origins.
function checkUrlFlags({ context, insecureTls, branch }, urlMode) {
  if (!urlMode && (context.length || insecureTls || branch !== undefined)) throw new Error('--context, --branch and --insecure-tls apply only with --url.');
}

// Build the sandbox environment for a running target from the operator's flags. Logins come from the
// operator's own environment, never from a manifest or a flag.
// A profile supplies defaults; each --url name and --context key overrides the profile's entry of the same name.
// A profile entry left null must be supplied by a flag; until then it is listed in `required`.
function targetEnvironment({ urls, context, insecureTls, branch }, env, login, profile) {
  const out = {};
  const required = [];
  const origins = new Map(Object.entries(profile?.urls ?? {}).map(([name, origin]) => [`PROOF_${name.toUpperCase()}_URL`, { name, origin }]));
  const given = new Set();
  for (const entry of urls) {
    const [, name = 'APP', value] = /^(?:([^=]+)=)?(.+)$/.exec(entry);
    if (!URL_NAME.test(name)) throw new Error('--url names must be letters, digits and underscores.');
    const key = `PROOF_${name.toUpperCase()}_URL`;
    if (given.has(key)) throw new Error('Each --url name may be given once.');
    given.add(key);
    // A local profile (one without urls) may iterate against a local sandbox only.
    if (profile && !profile.urls) {
      try { localOrigin(value, false); } catch { throw new Error(`Target "${profile.name}" is a local profile: --url must be a loopback origin. Add urls to the profile for a running environment.`); }
    }
    origins.set(key, { name, origin: localOrigin(value, true) });
  }
  for (const [key, { name, origin }] of origins) {
    if (origin === null) required.push(`urls.${name} (give --url ${name}=<origin>)`);
    else out[key] = origin;
  }
  const contexts = new Map(Object.entries(profile?.context ?? {}).map(([key, value]) => [`PROOF_CONTEXT_${key.toUpperCase()}`, { key, value }]));
  for (const entry of context) {
    const [, key, value] = /^([^=]+)=(.+)$/.exec(entry) ?? [];
    if (!CONTEXT_KEY.test(key ?? '') || !text(value)) throw new Error('--context needs key=value.');
    contexts.set(`PROOF_CONTEXT_${key.toUpperCase()}`, { key, value });
  }
  for (const [envKey, { key, value }] of contexts) {
    if (value === null) required.push(`context.${key} (give --context ${key}=<value>)`);
    else out[envKey] = value;
  }
  const username = login ? env[login.usernameEnv] : env.PROOF_USERNAME;
  const password = login ? env[login.passwordEnv] : env.PROOF_PASSWORD;
  if (username && password) Object.assign(out, { PROOF_USERNAME: username, PROOF_PASSWORD: password });
  if (env.PROOF_API_HEADERS) out.PROOF_API_HEADERS = env.PROOF_API_HEADERS;
  return { env: out, insecureTls: insecureTls || profile?.insecureTls === true, branch, required };
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
    if (Object.hasOwn(ac, 'requires') && !(Array.isArray(ac.requires) && ac.requires.every(name => CAPABILITY.test(name)))) {
      throw new Error(`${ac.id}: requires must be an array of capability names.`);
    }
    if (Object.hasOwn(ac, 'writes') && typeof ac.writes !== 'boolean') throw new Error(`${ac.id}: writes must be true or false.`);
    if (Object.hasOwn(ac, 'persona') && !PERSONA_NAME.test(ac.persona)) throw new Error(`${ac.id}: persona must be a persona name.`);
  }
  validateSourceRequires(manifest.sourceRequires);
  if (Object.hasOwn(manifest, 'recordEnv') && !(Array.isArray(manifest.recordEnv) && manifest.recordEnv.every(envName))) {
    throw new Error('Manifest recordEnv must be an array of environment variable names whose values are safe to print.');
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

// The --worktree app names a manifest's services expect: each service's `app`, defaulting to the service name.
export const serviceApps = services => [...new Set(Object.entries(services ?? {}).map(([name, service]) => service?.app ?? name))];

// --worktree [app=]<dir>: test the checkout's committed HEAD, whichever branch it is (base or feature).
// Uncommitted changes are not exported, so the report says when the checkout is dirty.
async function pinWorktrees(workspace, entries, services, path) {
  const apps = serviceApps(services);
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
    const status = git(dir, env, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=normal'], `${app}: cannot read checkout status.`);
    const lines = status ? status.split('\n') : [];
    const dirty = lines.some(line => !line.startsWith('??'));
    const untracked = lines.some(line => line.startsWith('??'));
    const branch = spawnSync('git', ['--no-optional-locks', '-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', env, timeout: 30_000 }).stdout?.trim() || null;
    pinned.push({ app, repo: dir, sha, dirty, untracked, branch });
  }
  return pinned;
}

// True when `ancestor` is `commit` or one of its ancestors in `repo`; undefined when Git cannot tell.
export function isAncestor(repo, ancestor, commit, path) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', repo, 'merge-base', '--is-ancestor', ancestor, commit], {
    encoding: 'utf8', env: gitEnv(path), timeout: 30_000, killSignal: 'SIGKILL',
  });
  return result.status === 0 ? true : result.status === 1 ? false : undefined;
}

// Where a ticket's checks live: the harness's own .proofs/<ID>/ first, then the workspace's.
export async function locateTicket(ticket, workspace) {
  const inHarness = await localEntry(join(HARNESS_ROOT, '.proofs', ticket), 'Ticket input directory', true, true);
  const proofsRoot = inHarness ? HARNESS_ROOT : workspace;
  const proofs = join(proofsRoot, '.proofs');
  await localEntry(proofs, 'Proof input directory', true);
  const ticketDir = join(proofs, ticket);
  await localEntry(ticketDir, 'Ticket input directory', true);
  const manifestPath = join(ticketDir, 'manifest.json');
  const manifest = await loadManifest(manifestPath, await localEntry(manifestPath, 'Ticket manifest'));
  validateManifest(manifest);
  return { proofsRoot, ticketDir, manifest, siblings: await siblingTickets(proofs, ticket) };
}

// Other folders for the same ticket (`<ID>-*`, for example one per app), which a run of <ID> alone does not cover.
async function siblingTickets(proofs, ticket) {
  return (await readdir(proofs, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(`${ticket}-`) && SAFE_NAME.test(entry.name))
    .map(({ name }) => name).sort();
}

export async function resolveWorkspace(requested) {
  const workspace = await realpath(requested);
  await localEntry(workspace, 'Workspace', true);
  return workspace;
}

// Printable values from the manifest's recordEnv allowlist. Anything that could hold a credential (a value equal
// to a login or source secret, or one with URL credential characters) is withheld.
function recordedEnv(names, env, secrets) {
  return names.map(name => {
    const value = env[name];
    if (typeof value !== 'string' || value === '') return { name, state: 'unset' };
    if (!/^[A-Za-z0-9._:/+=,-]{1,128}$/.test(value) || secrets.some(secret => secret && value.includes(secret))) return { name, state: 'withheld' };
    return { name, state: 'set', value };
  });
}


// Links count as content, so the snapshot still rejects them instead of the folder being skipped.
async function holdsFiles(dir) {
  return (await readdir(dir, { recursive: true, withFileTypes: true })).some(entry => !entry.isDirectory());
}

export const emptyAdapterText = (ticket, name) => `${name} adapter skipped: its folder .proofs/${ticket}/${name}/ holds no check files`;

const loginState = (login, env) => login ? {
  usernameEnv: login.usernameEnv, passwordEnv: login.passwordEnv,
  set: Boolean(env[login.usernameEnv]) && Boolean(env[login.passwordEnv]),
  missing: [login.usernameEnv, login.passwordEnv].filter(name => !env[name]),
} : null;

// Problems a run would hit, collected all at once for --plan and --check. `fatal` ones also stop a real run.
async function offlinePreflight(input, parsed, { builtIn, operatorEnv }) {
  const problems = [];
  const warnings = [];
  const problem = (text, fatal = false) => problems.push({ text, fatal });
  for (const field of input.target?.required ?? []) problem(`Target "${input.profile.name}" needs ${field}.`, true);
  for (const name of input.emptyAdapters) warnings.push(`${emptyAdapterText(input.ticket, name)}; ACs only it would cover report Uncovered.`);
  if (input.login && input.login.missing.length) {
    problem(`Login variable${input.login.missing.length > 1 ? 's' : ''} ${input.login.missing.join(', ')} not set (shell or <workspace>/.env); no login would be passed.`);
  }
  if (input.source?.problem) problem(`Source "${input.source.name}": ${input.source.problem}.`, !input.plan && !input.check);
  if (input.source?.overridden) warnings.push(`--source ${input.source.name} replaces the raw ${input.source.env} already set in the environment for this run.`);
  if (input.source?.via === 'environment' && !input.source.parts) warnings.push(`${input.source.env} is not a URL; its host, port and database are not recorded.`);
  for (const result of input.qualification ?? []) {
    if (!result.chosen) continue;
    if (result.qualifies === false) problem(`Source ${result.label} does not qualify for this ticket's fixtures${result.detail ? ` (${result.detail})` : ''}; pick a qualifying one with --source.`);
    else if (result.qualifies === null) warnings.push(`Source ${result.label} is not known to qualify for this ticket's fixtures (${result.detail ?? 'unknown'}).`);
  }
  for (const { name, state } of input.recorded) {
    if (state === 'unset') warnings.push(`recordEnv variable ${name} is not set.`);
    if (state === 'withheld') warnings.push(`recordEnv variable ${name} is withheld from the report (unsafe characters or a credential).`);
  }
  for (const { app, dirty, untracked } of input.worktrees) {
    const what = [dirty && 'uncommitted changes', untracked && 'untracked files'].filter(Boolean).join(' and ');
    if (!what) continue;
    const text = `${app}: checkout has ${what}; only the committed HEAD is tested.`;
    if (parsed.requireClean) problem(`${text} (--require-clean)`, true);
    else warnings.push(text);
  }
  if (parsed.expectCommit && input.worktrees.length) {
    const found = input.worktrees.some(({ repo, sha }) => sha.startsWith(parsed.expectCommit) || isAncestor(repo, parsed.expectCommit, sha, operatorEnv.PATH) === true);
    if (!found) problem(`No --worktree checkout contains --expect-commit ${parsed.expectCommit}.`, true);
  }
  if (input.version && input.target && !Object.hasOwn(input.target.env, `PROOF_${input.version.url.toUpperCase()}_URL`)) {
    warnings.push(`Version url "${input.version.url}" is not one of the target's urls; the build will not be detected.`);
  }
  if (builtIn) {
    // A chosen source fills its variable at run time, so it is not missing even though --plan leaves it unset.
    const env = input.source && !input.source.problem ? { ...operatorEnv, [input.source.env]: operatorEnv[input.source.env] || 'set at run time' } : operatorEnv;
    const found = await builtInPreflight({ options: input.runtimeOptions, commits: input.commits.run, env });
    for (const text of found.problems) problem(text);
    warnings.push(...found.warnings);
  }
  return { problems, warnings };
}

export async function resolveInputs(args, requestedWorkspace, env) {
  const parsed = parseArgs(args);
  const { ticket, plan, check, debug, serve, only, selectedAcs, runtimePath } = parsed;
  const workspace = await resolveWorkspace(parsed.workspacePath ?? requestedWorkspace);
  // A ticket's checks live in the harness's own gitignored .proofs/<ID>/ (reports go to .proofs-out/ beside it).
  // A workspace-level .proofs/<ID>/ is also accepted, so the harness works from any checkout.
  const { proofsRoot, ticketDir, manifest, siblings } = await locateTicket(ticket, workspace);
  if (parsed.summary) {
    const loaded = await loadProfiles([proofsRoot, workspace]);
    return { summary: true, ticket, workspace, proofsRoot, ticketDir, siblings, acs: manifest.acs, profiles: loaded?.profiles ?? {}, path: env.PATH };
  }
  const operatorEnv = { ...await loadEnvFile(workspace), ...env };
  let profile = null;
  if (parsed.targetName !== undefined) {
    const loaded = await loadProfiles([proofsRoot, workspace]);
    if (!loaded) throw new Error(`--target needs .proofs/${PROFILE_FILE} beside the ticket's .proofs/ or in the workspace.`);
    profile = loaded.profiles[parsed.targetName];
    if (!profile) throw new Error(`Unknown target "${parsed.targetName}"; .proofs/${PROFILE_FILE} defines: ${Object.keys(loaded.profiles).join(', ') || 'none'}.`);
    profile.file = relative(workspace, loaded.path) || loaded.path;
  }
  if (profile?.urls && parsed.worktrees.length) throw new Error(`Target "${profile.name}" is a running environment (it names urls); do not combine it with --worktree.`);
  if (profile && !profile.urls && !parsed.worktrees.length && !parsed.urls.length) {
    throw new Error(`Target "${profile.name}" is a local profile: add --worktree <dir> (or --url <loopback origin> for a sandbox kept up with --serve).`);
  }
  const urlMode = parsed.urls.length > 0 || Boolean(profile?.urls);
  checkUrlFlags(parsed, urlMode);
  if (urlMode && runtimePath) throw new Error('--url checks a running environment; do not combine it with --runtime.');
  if (serve && urlMode) throw new Error('--serve starts a local --worktree sandbox; do not combine it with --url.');

  // One persona per run: --persona, then PROOF_PERSONA from the environment, then the profile's default.
  const envPersona = operatorEnv.PROOF_PERSONA;
  if (parsed.persona === undefined && envPersona !== undefined && envPersona !== '' && !PERSONA_NAME.test(envPersona)) {
    throw new Error('PROOF_PERSONA must be a persona name (letters, digits, "_" or "-").');
  }
  const persona = parsed.persona ?? (envPersona || undefined) ?? profile?.defaultPersona ?? null;
  if (persona && profile && Object.keys(profile.personas).length && !Object.hasOwn(profile.personas, persona)) {
    throw new Error(`Target "${profile.name}" has no persona "${persona}"; it defines: ${Object.keys(profile.personas).join(', ')}.`);
  }
  if (persona) operatorEnv.PROOF_PERSONA = persona;
  const profileLogin = (persona && profile?.personas[persona]) || profile?.login || null;

  if (selectedAcs.length) {
    const known = new Set(manifest.acs.map(({ id }) => id));
    const unknown = selectedAcs.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`Unknown AC in --ac: ${unknown.join(', ')}.`);
  }
  let runtime, runtimeLabel;
  if (!urlMode) {
    // The operator picks the trusted runtime, never the manifest: --runtime, then PROOFS_RUNTIME, then the
    // .proofs-runtime/runtime.mjs beside the ticket's .proofs/, then the built-in command runtime.
    let chosen = runtimePath ?? env.PROOFS_RUNTIME;
    const local = join(proofsRoot, LOCAL_RUNTIME);
    const useLocal = chosen === undefined && await localEntry(local, 'Local runtime', false, true);
    runtime = useLocal ? local : chosen === undefined ? BUILT_IN_RUNTIME : under(workspace, chosen, 'Runtime module', { absolute: true });
    await localEntry(runtime, 'Runtime module');
    runtimeLabel = chosen === undefined && !useLocal ? 'built-in command runtime' : relative(useLocal ? proofsRoot : workspace, runtime) || runtime;
  }
  const login = parsed.login ?? profileLogin ?? manifest.login;
  const target = urlMode ? targetEnvironment(parsed, operatorEnv, login, profile) : null;
  // The built-in runtime reads its services from the manifest: fail at --plan, not on a live run.
  // One top-level login serves both modes; explicit --login overrides manifest.runtimeOptions.login too.
  const runtimeLogin = parsed.login ?? profileLogin ?? manifest.runtimeOptions?.login ?? manifest.login;
  const runtimeOptions = runtimeLogin ? { ...manifest.runtimeOptions, login: runtimeLogin } : manifest.runtimeOptions ?? {};
  const builtIn = !target && runtime === BUILT_IN_RUNTIME;
  if (builtIn) validateOptions(runtimeOptions);
  const fixtures = await loadFixtures(ticketDir, manifest.csv ?? []);
  const adapters = [];
  // An adapter folder with no check files is treated as absent: running it could only block every AC.
  const emptyAdapters = [];
  for (const name of ADAPTERS) {
    const checks = join(ticketDir, name);
    if ((!only.length || only.includes(name)) && await localEntry(checks, `${name} ticket directory`, true, true)) {
      if (!await holdsFiles(checks)) emptyAdapters.push(name);
      else adapters.push({ name, ticketDir: checks, entry: fileURLToPath(new URL(`../${name}/run.mjs`, import.meta.url)) });
    }
  }
  const worktrees = parsed.worktrees.length ? await pinWorktrees(workspace, parsed.worktrees, runtimeOptions.services, env.PATH) : [];
  const commits = { run: Object.fromEntries(worktrees.map(({ app, repo, sha }) => [app, { repo, sha }])) };

  const capabilities = capabilitiesFor(profile, urlMode);
  const notApplicable = applicability(manifest.acs, capabilities, persona, profile?.defaultPersona ?? null);
  const pool = selectedAcs.length ? selectedAcs : manifest.acs.map(({ id }) => id);
  const runAcs = selectedAcs.length || notApplicable.size ? pool.filter(id => !notApplicable.has(id)) : null;
  const usedLogin = urlMode ? login : runtimeLogin;
  const loginInfo = loginState(usedLogin, operatorEnv);
  // The chosen source reaches the runtime as a URL in the profile's sourceEnv; its password is resolved only when
  // something will read the source (never by --plan, unless a qualification probe needs it).
  const chosen = chooseSource(profile, parsed.source, operatorEnv);
  const rawSource = chosen?.via === 'environment' ? operatorEnv[profile.sourceEnv] : undefined;
  const source = chosen ? {
    name: chosen.name ?? `${profile.sourceEnv} override`, via: chosen.via, env: profile.sourceEnv, overridden: chosen.overridden === true,
    parts: chosen.descriptor ? sourceParts(chosen.descriptor) : chosen.parsed,
  } : null;
  const sourceValues = [rawSource];
  if (chosen?.descriptor) {
    if (plan) {
      if (chosen.descriptor.passwordEnv && !operatorEnv[chosen.descriptor.passwordEnv]) source.problem = `variable ${chosen.descriptor.passwordEnv} is not set`;
    } else {
      const resolved = resolvePassword(chosen.descriptor, operatorEnv, workspace);
      if (resolved.problem) source.problem = resolved.problem;
      else {
        const url = sourceUrl(chosen.descriptor, resolved.password);
        sourceValues.push(url, resolved.password);
        operatorEnv[profile.sourceEnv] = url;
        operatorEnv.PROOF_SOURCE_NAME = chosen.name;
      }
    }
  }
  const sourceRequires = validateSourceRequires(manifest.sourceRequires);
  const qualification = (plan || check) && sourceRequires && profile
    ? await qualifySources({ requires: sourceRequires, profile, chosen, env: operatorEnv, ticketDir, workspace, rawUrl: rawSource })
    : null;
  const secrets = [
    ...sourceSecrets(sourceValues),
    ...(usedLogin ? [operatorEnv[usedLogin.usernameEnv], operatorEnv[usedLogin.passwordEnv]] : []),
  ].filter(value => typeof value === 'string' && value.length >= 4);
  const recorded = recordedEnv(manifest.recordEnv ?? [], operatorEnv, secrets);
  const input = {
    plan, check, debug, serve, selectedAcs, target, worktrees, workspace, proofsRoot, ticket, ticketDir, siblings, runtime, runtimeLabel,
    env: operatorEnv, runtimeOptions, acs: manifest.acs, commits, adapters, emptyAdapters, fixtures,
    profile: profile ? { name: profile.name, file: profile.file } : null, persona, capabilities, notApplicable, runAcs,
    login: loginInfo, source, qualification, qualificationText: qualification ? formatQualification(qualification) : [], recorded, secrets, version: profile?.version ?? null, expectCommit: parsed.expectCommit ?? null,
    requireClean: parsed.requireClean, builtInRuntime: builtIn,
  };
  input.preflight = await offlinePreflight(input, parsed, { builtIn, operatorEnv });
  return input;
}
