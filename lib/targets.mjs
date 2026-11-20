import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localOrigin } from './origins.mjs';

// Target profiles: a tracked, secret-free file that names each environment a ticket's checks run on
// (`--target <name>`). It holds origins, non-secret context, the names (never the values) of login variables,
// what the target allows (capabilities) and the data sources a local run may read from. Explicit flags override it.
export const PROFILE_FILE = 'targets.json';
const PROFILE_LIMIT = 256 * 1024;
export const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const PERSONA_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const CAPABILITY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:.]{2,45}\]$/;
const DATABASE = /^[A-Za-z0-9_.-]{1,64}$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,15}$/;
const PROFILE_KEYS = new Set(['description', 'urls', 'context', 'insecureTls', 'login', 'personas', 'defaultPersona', 'capabilities', 'sources', 'defaultSource', 'sourceEnv', 'version']);
const SOURCE_KEYS = new Set(['description', 'kind', 'host', 'port', 'database', 'user', 'passwordEnv', 'passwordCommand']);
export const SOURCE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const VERSION_PATH = /^\/[A-Za-z0-9._~/-]{0,200}(?:\?[A-Za-z0-9._~=&-]{0,200})?$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() !== '' && !/[\x00-\x1f\x7f]/.test(value);

function loginNames(value, label) {
  if (!(record(value) && ENV_NAME.test(value.usernameEnv ?? '') && ENV_NAME.test(value.passwordEnv ?? '') && Object.keys(value).length === 2)) {
    throw new Error(`${label} needs usernameEnv and passwordEnv: the names of environment variables, never their values.`);
  }
  return { usernameEnv: value.usernameEnv, passwordEnv: value.passwordEnv };
}

// A profile never holds a secret: unknown keys are rejected (so a stray "password" cannot slip in), and the only
// values kept are origins, identifiers, variable names and short descriptions.
export function validateProfile(name, raw) {
  const label = `Target "${name}"`;
  if (!record(raw)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(raw)) if (!PROFILE_KEYS.has(key)) throw new Error(`${label}: unknown field "${key}" (a profile holds names and origins only, never a secret).`);
  const profile = { name, urls: null, context: {}, insecureTls: false, login: null, personas: {}, defaultPersona: null, capabilities: {}, sources: {}, defaultSource: null, sourceEnv: 'PROOF_SOURCE_URL', version: null, required: [] };
  if (raw.description !== undefined && !text(raw.description)) throw new Error(`${label}: description must be text.`);
  if (raw.urls !== undefined) {
    if (!record(raw.urls) || !Object.keys(raw.urls).length) throw new Error(`${label}: urls must map names to origins.`);
    profile.urls = {};
    for (const [key, origin] of Object.entries(raw.urls)) {
      if (!KEY.test(key)) throw new Error(`${label}: url names must be letters, digits and underscores.`);
      // null marks a value the operator must supply (here or with --url <name>=<origin>).
      if (origin === null) { profile.urls[key] = null; continue; }
      try { profile.urls[key] = localOrigin(origin, true); } catch { throw new Error(`${label}: urls.${key} is not an http(s) origin.`); }
    }
  }
  if (raw.context !== undefined) {
    if (!record(raw.context)) throw new Error(`${label}: context must be an object.`);
    for (const [key, value] of Object.entries(raw.context)) {
      if (!KEY.test(key)) throw new Error(`${label}: context keys must be letters, digits and underscores.`);
      if (value !== null && !(text(value) && /^[\x20-\x7e]{1,256}$/.test(value))) throw new Error(`${label}: context.${key} must be short printable text, or null when the operator must supply it.`);
      profile.context[key] = value;
    }
  }
  if (raw.insecureTls !== undefined) {
    if (typeof raw.insecureTls !== 'boolean') throw new Error(`${label}: insecureTls must be true or false.`);
    profile.insecureTls = raw.insecureTls;
  }
  if (raw.login !== undefined) profile.login = loginNames(raw.login, `${label} login`);
  if (raw.personas !== undefined) {
    if (!record(raw.personas)) throw new Error(`${label}: personas must map persona names to logins.`);
    for (const [persona, login] of Object.entries(raw.personas)) {
      if (!PERSONA_NAME.test(persona)) throw new Error(`${label}: persona names must be letters, digits, "_" or "-".`);
      // An empty persona reuses the profile's own login (for example a role the runtime grants to the same account).
      profile.personas[persona] = record(login) && !Object.keys(login).length ? null : loginNames(login, `${label} persona ${persona}`);
    }
  }
  if (raw.defaultPersona !== undefined) {
    if (!Object.hasOwn(profile.personas, raw.defaultPersona)) throw new Error(`${label}: defaultPersona must name one of its personas.`);
    profile.defaultPersona = raw.defaultPersona;
  }
  if (raw.capabilities !== undefined) {
    if (!record(raw.capabilities)) throw new Error(`${label}: capabilities must map names to true or false.`);
    for (const [key, value] of Object.entries(raw.capabilities)) {
      if (!CAPABILITY.test(key) || typeof value !== 'boolean') throw new Error(`${label}: capabilities must map names to true or false.`);
      profile.capabilities[key] = value;
    }
  }
  if (raw.sources !== undefined) {
    if (!record(raw.sources)) throw new Error(`${label}: sources must map source names to descriptors.`);
    for (const [key, source] of Object.entries(raw.sources)) {
      if (!SOURCE_NAME.test(key)) throw new Error(`${label}: source names must be letters, digits, "_" or "-".`);
      profile.sources[key] = validateSource(source, `${label} source ${key}`);
    }
  }
  if (raw.defaultSource !== undefined) {
    if (!Object.hasOwn(profile.sources, raw.defaultSource)) throw new Error(`${label}: defaultSource must name one of its sources.`);
    profile.defaultSource = raw.defaultSource;
  }
  if (raw.sourceEnv !== undefined) {
    if (!ENV_NAME.test(raw.sourceEnv)) throw new Error(`${label}: sourceEnv must be an environment variable name.`);
    profile.sourceEnv = raw.sourceEnv;
  }
  if (raw.version !== undefined) {
    const { url, path, field, ...extra } = record(raw.version) ? raw.version : {};
    if (!record(raw.version) || Object.keys(extra).length || !KEY.test(url ?? '') || !VERSION_PATH.test(path ?? '') ||
        (field !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,31}(?:\.[A-Za-z_][A-Za-z0-9_]{0,31}){0,3}$/.test(field))) {
      throw new Error(`${label}: version needs { url: <url name>, path: "/<path>", field?: "<json.field>" }.`);
    }
    profile.version = { url, path, ...(field ? { field } : {}) };
  }
  return profile;
}

function validateSource(raw, label) {
  if (!record(raw)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(raw)) {
    if (!SOURCE_KEYS.has(key)) throw new Error(`${label} has unknown field "${key}" (never put a password or connection string in a profile; name a variable with passwordEnv or a command with passwordCommand).`);
  }
  const source = {};
  if (raw.description !== undefined) {
    if (!text(raw.description) || raw.description.length > 200 || /:\/\/|@/.test(raw.description)) throw new Error(`${label}: description must be short text without a URL or credentials.`);
    source.description = raw.description;
  }
  if (!SCHEME.test(raw.kind ?? '')) throw new Error(`${label}: kind must be the URL scheme of the database (a short lowercase name).`);
  source.kind = raw.kind;
  if (!HOST.test(raw.host ?? '')) throw new Error(`${label}: host must be a host name or address.`);
  source.host = raw.host;
  if (raw.port !== undefined) { if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) throw new Error(`${label}: port must be a port number.`); source.port = raw.port; }
  if (!DATABASE.test(raw.database ?? '')) throw new Error(`${label}: database must be a database name.`);
  source.database = raw.database;
  if (raw.user !== undefined) { if (!/^[A-Za-z0-9_.-]{1,64}$/.test(raw.user)) throw new Error(`${label}: user must be a database user name.`); source.user = raw.user; }
  if (raw.passwordEnv !== undefined && raw.passwordCommand !== undefined) throw new Error(`${label}: give passwordEnv or passwordCommand, not both.`);
  if (raw.passwordEnv !== undefined) { if (!ENV_NAME.test(raw.passwordEnv)) throw new Error(`${label}: passwordEnv must be an environment variable name.`); source.passwordEnv = raw.passwordEnv; }
  if (raw.passwordCommand !== undefined) {
    if (!text(raw.passwordCommand) || raw.passwordCommand.length > 400) throw new Error(`${label}: passwordCommand must be a one-line command.`);
    source.passwordCommand = raw.passwordCommand;
  }
  return source;
}

// The profile file lives in a `.proofs/` directory: the ticket's own root first, then the workspace.
export async function loadProfiles(roots) {
  for (const root of [...new Set(roots)]) {
    const path = join(root, '.proofs', PROFILE_FILE);
    let raw;
    try { raw = await readFile(path, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Target profiles (.proofs/${PROFILE_FILE}) could not be read.`);
    }
    if (raw.length > PROFILE_LIMIT) throw new Error(`Target profiles (.proofs/${PROFILE_FILE}) must be at most 256 KiB.`);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`Target profiles (.proofs/${PROFILE_FILE}) must contain valid JSON.`); }
    if (!record(parsed) || !record(parsed.targets) || Object.keys(parsed).some(key => !['targets', 'description'].includes(key))) {
      throw new Error(`Target profiles (.proofs/${PROFILE_FILE}) need a top-level "targets" object.`);
    }
    const profiles = {};
    for (const [name, profile] of Object.entries(parsed.targets)) {
      if (!PROFILE_NAME.test(name)) throw new Error(`Target names must be letters, digits, "_" or "-" (at most 32).`);
      profiles[name] = validateProfile(name, profile);
    }
    return { path, root, profiles };
  }
  return null;
}

// What the target allows. Without a profile a local sandbox is fully capable (today's behavior) and a running
// environment allows nothing an AC has to declare. A profile lists its capabilities; writes are allowed by default
// only for a profile that names no urls (a local profile). Everything else is denied unless the profile says true.
export function capabilitiesFor(profile, urlMode) {
  if (!profile) return { all: !urlMode, set: urlMode ? { writes: false } : {} };
  return { all: false, set: { writes: !profile.urls, ...profile.capabilities } };
}

export const hasCapability = (caps, name) => caps.all || caps.set[name] === true;

// Each AC runs under one persona: its own `persona`, or the default persona when it names none. A run executes
// only the ACs whose persona is the run's, whose required capabilities the target has, and whose writes it allows.
export function applicability(acs, caps, runPersona, defaultPersona) {
  const reasons = new Map();
  for (const ac of acs) {
    const wanted = ac.persona ?? defaultPersona ?? null;
    if (wanted !== (runPersona ?? defaultPersona ?? null)) {
      reasons.set(ac.id, `persona_mismatch: ${wanted ?? 'default'}`);
      continue;
    }
    const missing = (ac.requires ?? []).filter(name => !hasCapability(caps, name));
    if (missing.length) {
      reasons.set(ac.id, `capability_missing: ${missing.join(', ')}`);
      continue;
    }
    if (ac.writes === true && !hasCapability(caps, 'writes')) reasons.set(ac.id, 'writes_denied');
  }
  return reasons;
}
