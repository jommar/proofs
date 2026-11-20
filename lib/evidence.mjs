import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { record } from './inputs.mjs';

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

function verdict(side, id, selected) {
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

export function formatPlan({ ticket, adapters, fixtures, acs, selectedAcs = [], debug = false, proofDigest, runtimeLabel, target, worktrees }, adapterTimeoutMs) {
  return [
    `Plan: ${ticket}`, modeLine(target), ...pins(target, worktrees),
    digestLine(proofDigest),
    `Runtime: ${target ? 'none (running environment)' : runtimeLabel}`,
    `Adapters: ${adapters.map(({ name }) => name).join(', ') || 'none'}`,
    `ACs: ${acs.length}${selectedAcs.length ? ` (filtered: ${selectedAcs.join(', ')})` : ''} · CSV inputs: ${fixtures.length}`,
    ...(debug ? ['Debug: enabled (private local diagnostics and Playwright failure artifacts retained).'] : []),
    target ? 'No sandbox is started; the checks run against the listed origins.' : 'Optional dataset capture, then one sandbox for the checkout.',
    `Execution timeout: ${adapterTimeoutMs / 1000} seconds per adapter invocation.`,
    'No files written; runtime not imported and no services started.',
  ].join('\n');
}

export function makeReport({ ticket, acs, selectedAcs = [], debug = false, proofDigest, target, worktrees = [] }, id, { run }) {
  const issues = run.issues.map(issue => `- ${issue}`);
  const notes = !run.invoked ? ['- No adapter ran.'] : !run.rows.length ? ['- No validated adapter evidence.'] : [];
  const selected = selectedAcs.length ? new Set(selectedAcs) : null;
  let exitCode = issues.length ? 1 : 0;
  const rows = acs.map(({ id: ac, claim }) => {
    const result = verdict(run, ac, selected);
    if (result.status !== 'pass' && result.status !== 'skipped') exitCode = 1;
    return `| ${markdown(ac)} — ${markdown(claim)} | ${result.text} |`;
  });
  const timing = durationLine(run.timings);
  const report = [
    `# Proof report — ${ticket}`, '', `Run: \`${id}\``, '', modeLine(target), '',
    `## ${target ? 'Target' : 'Revisions'}`, '', ...pins(target, worktrees), '',
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
  return { report, exitCode };
}
