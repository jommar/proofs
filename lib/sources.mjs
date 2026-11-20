import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Data sources: the database a local run copies its dataset from. The harness never connects to one itself. It picks
// a source (from a profile or the raw environment override), hands its URL to the runtime through one variable, and
// can ask a ticket's probe whether the source holds what the fixtures need. Only kind, host, port and database names
// are ever printed or recorded; a password, user, connection string or row value never is.
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:.]{2,45}\]$/;
const DATABASE = /^[A-Za-z0-9_.-]{1,64}$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,15}$/;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
const PROBE_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 64 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Parse a source URL into printable parts only.
export function parseSourceUrl(value) {
  try {
    const url = new URL(value);
    const kind = url.protocol.slice(0, -1);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return {
      kind: SCHEME.test(kind) ? kind : null,
      host: HOST.test(url.hostname) ? url.hostname : null,
      port: url.port ? Number(url.port) : null,
      database: DATABASE.test(database) ? database : null,
    };
  } catch {
    return null;
  }
}

// Which source this run reads: --source names one, else a raw URL already in the profile's sourceEnv variable (the
// operator's override, honored exactly as before), else the profile's defaultSource. No profile: nothing is chosen
// and the environment is left alone.
export function chooseSource(profile, flag, env) {
  if (flag !== undefined) {
    if (!profile) throw new Error('--source picks one of a target profile\'s sources; add --target <profile>.');
    if (!Object.hasOwn(profile.sources, flag)) {
      throw new Error(`Target "${profile.name}" has no source "${flag}"; it defines: ${Object.keys(profile.sources).join(', ') || 'none'}.`);
    }
    return { name: flag, via: 'flag', descriptor: profile.sources[flag], overridden: Boolean(env[profile.sourceEnv]) };
  }
  if (!profile) return null;
  const raw = env[profile.sourceEnv];
  if (typeof raw === 'string' && raw) return { name: null, via: 'environment', parsed: parseSourceUrl(raw) };
  if (profile.defaultSource) return { name: profile.defaultSource, via: 'default', descriptor: profile.sources[profile.defaultSource] };
  return null;
}

// A source's password: from the variable it names, or the first line printed by its passwordCommand (trusted
// operator code from the profile, run without a shell environment beyond PATH and HOME; its output is never shown).
export function resolvePassword(descriptor, env, cwd) {
  if (descriptor.passwordEnv) {
    const value = env[descriptor.passwordEnv];
    return typeof value === 'string' && value ? { password: value } : { problem: `variable ${descriptor.passwordEnv} is not set` };
  }
  if (descriptor.passwordCommand) {
    const result = spawnSync('sh', ['-c', descriptor.passwordCommand], {
      cwd, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: OUTPUT_LIMIT,
      env: Object.fromEntries(['PATH', 'HOME'].filter(key => env[key] !== undefined).map(key => [key, env[key]])),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const password = result.status === 0 ? result.stdout.split(/\r?\n/)[0] : '';
    return password ? { password } : { problem: `its passwordCommand ${result.status === 0 ? 'printed nothing' : 'failed'}` };
  }
  return { password: undefined };
}

export function sourceUrl({ kind, host, port, database, user }, password) {
  const auth = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@` : '';
  return `${kind}://${auth}${host}${port ? `:${port}` : ''}/${encodeURIComponent(database)}`;
}

export const sourceParts = descriptor => ({ kind: descriptor.kind, host: descriptor.host, port: descriptor.port ?? null, database: descriptor.database });

export function formatSource(parts) {
  if (!parts) return 'unparsable (value not shown)';
  return `${parts.kind ?? '?'}://${parts.host ?? '?'}${parts.port ? `:${parts.port}` : ''}/${parts.database ?? '?'}`;
}

// Values that must never appear anywhere: a resolved URL, its password, and a raw override.
export function sourceSecrets(values) {
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 4) continue;
    out.push(value);
    try {
      const url = new URL(value);
      if (url.password) out.push(url.password, decodeURIComponent(url.password));
    } catch { /* not a URL: the value itself is listed */ }
  }
  return out.filter(value => value.length >= 4);
}

// manifest.sourceRequires: { probe?: "<ticket-relative script>", checks?: [{ id, ... }], known?: { <source>: { qualifies, reason? } } }
// The checks are opaque to the harness and handed to the probe as JSON; `known` records verdicts already learned.
export function validateSourceRequires(value) {
  if (value === undefined) return null;
  if (!record(value) || Object.keys(value).some(key => !['probe', 'checks', 'known', 'description'].includes(key))) {
    throw new Error('Manifest sourceRequires takes probe, checks, known and description.');
  }
  if (value.probe !== undefined && (typeof value.probe !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(value.probe) || value.probe.split('/').includes('..') || value.probe.startsWith('/'))) {
    throw new Error('sourceRequires.probe must be a relative path inside the ticket directory.');
  }
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks) || !value.checks.every(check => record(check) && CODE.test(check.id ?? ''))) {
      throw new Error('sourceRequires.checks must be objects with a lowercase id (letters, digits, "_").');
    }
    if (JSON.stringify(value.checks).length > 32 * 1024) throw new Error('sourceRequires.checks must be at most 32 KiB.');
  }
  if (value.known !== undefined) {
    if (!record(value.known)) throw new Error('sourceRequires.known must map source names to { qualifies, reason }.');
    for (const verdict of Object.values(value.known)) {
      if (!record(verdict) || typeof verdict.qualifies !== 'boolean' || (verdict.reason !== undefined && !CODE.test(verdict.reason))) {
        throw new Error('sourceRequires.known entries need qualifies: true|false and an optional lowercase reason code.');
      }
    }
  }
  return { probe: value.probe ?? null, checks: value.checks ?? [], known: value.known ?? {} };
}

async function probePath(ticketDir, probe) {
  const path = resolve(ticketDir, probe);
  const rel = relative(ticketDir, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const info = await lstat(path).catch(() => null);
  return info?.isFile() && await realpath(path) === path ? path : null;
}

// Run the ticket's probe against one source. It reads PROOF_SOURCE_URL and PROOF_SOURCE_CHECKS and prints one JSON
// line per check: { "id": "<check id>", "ok": true|false, "reason"?: "<code>" }. Only those fields are kept, so a
// probe cannot leak a row value through the harness. Probes must only read: they are trusted ticket code.
export async function runProbe(requires, ticketDir, url, env) {
  const path = await probePath(ticketDir, requires.probe);
  if (!path) return { error: 'probe_not_found' };
  const result = spawnSync(process.execPath, [path], {
    cwd: ticketDir, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: OUTPUT_LIMIT,
    env: {
      ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'HOME'].filter(key => env[key] !== undefined).map(key => [key, env[key]])),
      PROOF_SOURCE_URL: url, PROOF_SOURCE_CHECKS: JSON.stringify(requires.checks),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error?.code === 'ETIMEDOUT') return { error: 'probe_timed_out' };
  if (result.status !== 0 && !result.stdout) return { error: 'probe_failed' };
  const ids = new Set(requires.checks.map(({ id }) => id));
  const checks = new Map();
  for (const line of String(result.stdout).split(/\r?\n/).filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { return { error: 'probe_output_invalid' }; }
    if (!record(row) || Object.keys(row).some(key => !['id', 'ok', 'reason'].includes(key)) || !ids.has(row.id) || typeof row.ok !== 'boolean' || (row.reason !== undefined && !CODE.test(row.reason))) {
      return { error: 'probe_output_invalid' };
    }
    checks.set(row.id, { ok: row.ok, reason: row.reason ?? null });
  }
  const failed = [...ids].filter(id => checks.get(id)?.ok !== true);
  return { qualifies: failed.length === 0, failed: failed.map(id => checks.get(id)?.reason ? `${id} (${checks.get(id).reason})` : checks.has(id) ? id : `${id} (not reported)`) };
}

// Qualify every source the run could use: the profile's named sources plus a raw override. A probe decides when the
// ticket has one and the source's password resolves; otherwise a verdict recorded in sourceRequires.known is used.
export async function qualifySources({ requires, profile, chosen, env, ticketDir, workspace, rawUrl }) {
  if (!requires) return null;
  const candidates = [];
  if (chosen?.via === 'environment') candidates.push({ name: null, url: rawUrl, parts: chosen.parsed });
  for (const [name, descriptor] of Object.entries(profile?.sources ?? {})) candidates.push({ name, descriptor, parts: sourceParts(descriptor) });
  const results = [];
  for (const candidate of candidates) {
    const label = candidate.name ?? `${profile?.sourceEnv ?? 'source'} override`;
    const isChosen = candidate.name === null ? true : chosen?.name === candidate.name;
    const known = candidate.name ? requires.known[candidate.name] : undefined;
    let verdict;
    if (requires.probe && requires.checks.length) {
      let url = candidate.url;
      let problem;
      if (!url) {
        const resolved = resolvePassword(candidate.descriptor, env, workspace);
        problem = resolved.problem;
        if (!problem) url = sourceUrl(candidate.descriptor, resolved.password);
      }
      if (url) {
        const probed = await runProbe(requires, ticketDir, url, env);
        verdict = probed.error
          ? { qualifies: null, how: 'probe', detail: probed.error }
          : { qualifies: probed.qualifies, how: 'probe', detail: probed.failed.join(', ') || null };
      } else {
        verdict = { qualifies: null, how: 'probe', detail: `not probed: ${problem}` };
      }
      if (verdict.qualifies === null && known) verdict = { qualifies: known.qualifies, how: 'recorded', detail: known.reason ?? null };
    } else if (known) {
      verdict = { qualifies: known.qualifies, how: 'recorded', detail: known.reason ?? null };
    } else {
      verdict = { qualifies: null, how: 'unknown', detail: 'no probe and no recorded verdict' };
    }
    results.push({ label, name: candidate.name, chosen: isChosen, where: formatSource(candidate.parts), ...verdict });
  }
  return results;
}

export function formatQualification(results) {
  return results.map(({ label, chosen, where, qualifies, how, detail }) => {
    const state = qualifies === true ? 'qualifies' : qualifies === false ? 'does not qualify' : 'unknown';
    return `${label}${chosen ? ' (chosen)' : ''} ${where}: ${state} (${how === 'unknown' ? detail : `${how}${detail ? `: ${detail}` : ''}`})`;
  });
}
