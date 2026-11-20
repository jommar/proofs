import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { emptyAdapterText, record } from './inputs.mjs';
import { formatSource } from './sources.mjs';

const STATUSES = ['pass', 'fail', 'blocked'];
const RESULT_LIMIT = 1024 * 1024;

function observation(value) {
  if (typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)) {
    return value.trim();
  }
  if (!record(value)) return null;
  // BDD declares typed facts; never serialize arbitrary objects or string-valued fixture fields.
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32 || !entries.every(([key, fact]) =>
    /^[a-z][a-z0-9_]{0,47}$/i.test(key) && (typeof fact === 'boolean' || (Number.isSafeInteger(fact) && fact >= 0) ||
      (key === 'reason' && typeof fact === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(fact))))) return null;
  return entries.map(([key, fact]) => `${key}=${fact}`).join(', ');
}

export async function readEvidence(path, ids, credentials, { allowEmpty = false } = {}) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let stdout;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > RESULT_LIMIT) throw new Error('Invalid result file');
    if (!info.size) {
      if (allowEmpty) return [];
      throw new Error('Invalid result file');
    }
    const data = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== info.size) throw new Error('Result file changed during validation');
    stdout = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead));
  } finally { await file.close(); }
  if (!stdout.trim()) {
    if (allowEmpty) return [];
    throw new Error('Invalid result file');
  }
  return stdout.trimEnd().split(/\r?\n/).map(line => {
    const row = JSON.parse(line);
    const observed = record(row) && observation(row.observed);
    if (!observed || !ids.has(row.ac) || !STATUSES.includes(row.status)) throw new Error('Invalid evidence row');
    const safeText = credentials.some(value => observed.includes(value)) ? '[redacted local credential]' : observed;
    return { ac: row.ac, status: row.status, observed: safeText };
  });
}

function markdown(value) {
  return value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/[\\|`*[\]_~]/g, '\\$&');
}

export const NOT_APPLICABLE = 'Not applicable here';

function verdict(side, id, selected, notApplicable) {
  // Declared by the manifest against the chosen target (capability, write guard or persona); never a product result.
  if (notApplicable?.has(id)) return { status: 'na', complete: true, text: `${NOT_APPLICABLE} — ${markdown(notApplicable.get(id))}` };
  if (selected && !selected.has(id)) {
    return { status: 'skipped', complete: true, text: 'Skipped — filtered out by --ac' };
  }
  const rows = side.rows.filter(row => row.ac === id);
  if (side.issues.length && !rows.some(row => row.status === 'fail')) {
    return { status: 'blocked', complete: false, text: 'Blocked — see run issues below' };
  }
  const status = ['fail', 'blocked', 'pass'].find(value => rows.some(row => row.status === value));
  if (!status) return { status: 'uncovered', complete: false, text: 'Blocked — Uncovered: no adapter evidence' };
  const text = rows.map(row => `${row.adapter}: ${row.status} — ${markdown(row.observed)}`).join('; ');
  return { status, complete: rows.every(row => row.status !== 'blocked'), text: `${status[0].toUpperCase()}${status.slice(1)} — ${text}` };
}

function inlineCode(value) {
  const fence = '`'.repeat(1 + Math.max(0, ...(value.match(/`+/g) ?? []).map(sequence => sequence.length)));
  return fence.length === 1 ? `${fence}${value}${fence}` : `${fence} ${value} ${fence}`;
}

function pins(target, worktrees = []) {
  if (worktrees.length) {
    return worktrees.map(({ app, sha, dirty }) => `- \`${app}\`: \`${sha}\` (${dirty ? 'checkout has uncommitted changes that were not tested' : 'clean checkout'})`);
  }
  const origins = Object.entries(target.env).filter(([key]) => /^PROOF_[A-Z0-9_]+_URL$/.test(key))
    .map(([key, origin]) => `- ${inlineCode(key.slice(6, -4).toLowerCase())}: ${inlineCode(origin)}`);
  return [...origins, ...(target.branch ? [`- Branch label: ${inlineCode(target.branch)} (stated by the operator, not verified)`] : [])];
}

const code = value => inlineCode(String(value));

// Non-secret inputs only: names, identifiers and parsed host/port/database. Values come from validated fields.
function inputLines({ profile, persona, target, login, source, recorded = [], capabilities, version }, { context, build, scrub = text => text } = {}) {
  const lines = [`- Target profile: ${profile ? `${code(profile.name)} (${code(profile.file)})` : 'none (flags only)'}`];
  lines.push(`- Persona: ${persona ? code(persona) : 'default'}`);
  const ctx = context ?? Object.fromEntries(Object.entries(target?.env ?? {}).filter(([key]) => /^PROOF_CONTEXT_/.test(key))
    .map(([key, value]) => [key.slice('PROOF_CONTEXT_'.length).toLowerCase(), value]));
  if (Object.keys(ctx).length) lines.push(`- Context: ${Object.entries(ctx).map(([key, value]) => `${code(key)}=${code(scrub(String(value)))}`).join(', ')}`);
  lines.push(`- Login variables: ${login ? `${code(login.usernameEnv)}, ${code(login.passwordEnv)} (${login.set ? 'set' : 'not set: no login was passed'})` : 'none named'}`);
  if (source) lines.push(`- Source: ${code(source.name)} ${code(formatSource(source.parts))} (${source.via === 'flag' ? '--source' : source.via === 'default' ? 'profile default' : `raw ${source.env}`})`);
  for (const item of recorded) lines.push(`- Recorded ${code(item.name)}: ${item.state === 'set' ? code(scrub(item.value)) : item.state === 'unset' ? 'not set' : 'withheld'}`);
  if (capabilities && !capabilities.all) {
    const allowed = Object.entries(capabilities.set).filter(([, on]) => on).map(([name]) => name);
    lines.push(`- Capabilities: ${allowed.length ? allowed.map(code).join(', ') : 'none'}${capabilities.set.writes ? '' : ' (writes denied)'}`);
  }
  if (build !== undefined) lines.push(`- Build: ${build ? `${code(scrub(String(build)))} (from ${code(version.url)} ${code(version.path)})` : 'build not detected'}`);
  return lines;
}

const modeLine = target => target
  ? 'Mode: running environment (no revision is pinned; results describe what it served during this run)'
  : 'Mode: local checkout (the committed HEAD of each --worktree; run again on another branch to compare)';

const digestLine = digest => `Proof inputs digest: \`sha256:${digest}\` (ticket check files, AC definitions, and CSV inputs; excludes runtime options and shared tooling).`;

const fmtSec = ms => `${(ms / 1000).toFixed(1)}s`;

function durationLine(timings) {
  if (!timings || !Number.isFinite(timings.durationMs)) return null;
  const parts = [];
  if (Number.isFinite(timings.startupMs)) parts.push(`startup ${fmtSec(timings.startupMs)}`);
  for (const [name, ms] of Object.entries(timings.adapters ?? {})) {
    if (Number.isFinite(ms)) parts.push(`${name} ${fmtSec(ms)}`);
  }
  if (Number.isFinite(timings.teardownMs)) parts.push(`teardown ${fmtSec(timings.teardownMs)}`);
  return `Duration: ${fmtSec(timings.durationMs)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

export function formatPreflight({ problems = [], warnings = [] }) {
  if (!problems.length && !warnings.length) return ['Preflight: no problems found.'];
  return [
    `Preflight: ${problems.length} problem${problems.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    ...problems.map(({ text }) => `- Problem: ${text}`),
    ...warnings.map(text => `- Warning: ${text}`),
  ];
}

export function formatPlan(input, adapterTimeoutMs) {
  const { ticket, adapters, emptyAdapters = [], fixtures, acs, selectedAcs = [], debug = false, proofDigest, runtimeLabel, target, worktrees, notApplicable = new Map(), qualificationText = [] } = input;
  return [
    `Plan: ${ticket}`, modeLine(target), ...pins(target, worktrees),
    'Inputs:', ...inputLines(input),
    ...(notApplicable.size ? [`${NOT_APPLICABLE}: ${[...notApplicable].map(([id, reason]) => `${id} (${reason})`).join('; ')}`] : []),
    ...(qualificationText.length ? ['Source qualification:', ...qualificationText.map(line => `- ${line}`)] : []),
    digestLine(proofDigest),
    `Runtime: ${target ? 'none (running environment)' : runtimeLabel}`,
    `Adapters: ${adapters.map(({ name }) => name).join(', ') || 'none'}${emptyAdapters.length ? ` (skipped, empty folder: ${emptyAdapters.join(', ')})` : ''}`,
    `ACs: ${acs.length}${selectedAcs.length ? ` (filtered: ${selectedAcs.join(', ')})` : ''} · CSV inputs: ${fixtures.length}`,
    ...(debug ? ['Debug: enabled (private local diagnostics and Playwright failure artifacts retained).'] : []),
    target ? 'No sandbox is started; the checks run against the listed origins.' : 'Optional dataset capture, then one sandbox for the checkout.',
    `Execution timeout: ${adapterTimeoutMs / 1000} seconds per adapter invocation.`,
    'No files written; runtime not imported and no services started.',
    ...formatPreflight(input.preflight ?? {}),
  ].join('\n');
}

export function makeReport(input, id, { run }) {
  const { ticket, acs, selectedAcs = [], debug = false, proofDigest, target, worktrees = [], notApplicable } = input;
  // Only text that comes from outside the harness is scrubbed; its own fixed lines (mode, profile name) must stay readable.
  const scrub = text => (input.secrets ?? []).reduce((acc, secret) => acc.split(secret).join('[redacted]'), text);
  const issues = run.issues.map(issue => `- ${scrub(issue)}`);
  const notes = [
    ...(input.emptyAdapters ?? []).map(name => `- ${emptyAdapterText(ticket, name)}.`),
    ...(!run.invoked ? ['- No adapter ran.'] : !run.rows.length ? ['- No validated adapter evidence.'] : []),
  ];
  const selected = selectedAcs.length ? new Set(selectedAcs) : null;
  let exitCode = issues.length ? 1 : 0;
  const statuses = {};
  const rows = acs.map(({ id: ac, claim }) => {
    const result = verdict(run, ac, selected, notApplicable);
    statuses[ac] = result.status;
    if (!['pass', 'skipped', 'na'].includes(result.status)) exitCode = 1;
    return `| ${markdown(ac)} — ${markdown(claim)} | ${scrub(result.text)} |`;
  });
  const timing = durationLine(run.timings);
  const body = [
    `# Proof report — ${ticket}`, '', `Run: \`${id}\``, '', modeLine(target), '',
    `## ${target ? 'Target' : 'Revisions'}`, '', ...pins(target, worktrees), '',
    '## Inputs', '', ...inputLines(input, { context: run.context, build: input.version ? run.build ?? null : null, scrub }), '',
    digestLine(proofDigest), '',
    ...(timing ? [timing, ''] : []),
    ...(selected ? [`Filtered ACs: \`${selectedAcs.join(', ')}\` (partial run — not full ticket coverage).`, ''] : []),
    ...(debug ? ['Diagnostic run (`--debug` enabled; private local diagnostics retained outside this report).', ''] : []),
    ...(target ? ['Ticket checks run from private, read-only copies against the named environment. The runner limits adapter environment variables and only lets the checks reach the listed origins; it cannot verify which revision the environment serves. Checks that write data change that environment.', '']
      : ['Ticket checks run from private, read-only copies. Runtime modules and BDD steps are trusted same-user code, not host-isolated. The runner limits adapter environment variables and validates loopback origins; it cannot verify service ownership or that the runtime serves the checkout.', '']),
    '| AC | Result |', '| --- | --- |', ...rows,
    ...(notes.length ? ['', '## Execution notes', '', ...notes] : []),
    ...(issues.length ? ['', '## Run issues', '', ...issues] : []), '',
  ].join('\n');
  return { report: body, exitCode, statuses };
}
