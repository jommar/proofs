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

export async function readEvidence(path, ids, credentials) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let stdout;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !info.size || info.size > RESULT_LIMIT) throw new Error('Invalid result file');
    const data = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== info.size) throw new Error('Result file changed during validation');
    stdout = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead));
  } finally { await file.close(); }
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

function verdict(side, id) {
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

function pins(commits, mergedRefs, target, worktrees = []) {
  if (worktrees.length) {
    return worktrees.map(({ app, sha, dirty }) => `- \`${app}\`: \`${sha}\` (${dirty ? 'checkout has uncommitted changes that were not tested' : 'clean checkout'})`);
  }
  if (target) {
    const origins = Object.entries(target.env).filter(([key]) => /^PROOF_[A-Z0-9_]+_URL$/.test(key))
      .map(([key, origin]) => `- ${inlineCode(key.slice(6, -4).toLowerCase())}: ${inlineCode(origin)}`);
    return [...origins, ...(target.branch ? [`- Branch label: ${inlineCode(target.branch)} (stated by the operator, not verified)`] : [])];
  }
  return Object.entries(commits.after).map(([app, { sha }]) => {
    const before = commits.before ? `Before \`${commits.before[app].sha}\` · ` : '';
    const ref = commits.before ? '' : ` · Local ref ${inlineCode(mergedRefs[app])}`;
    return `- \`${app}\`: ${before}After \`${sha}\`${ref}`;
  });
}

function modeLine(postMerge, target, worktrees = []) {
  if (worktrees.length) return 'Mode: single checkout (the committed HEAD of each --worktree; run it again on another branch to compare)';
  if (target) return 'Mode: target verification of a running environment (no revisions pinned; results describe what it served during this run)';
  return postMerge ? 'Mode: post-merge verification (local branches only; remote freshness and ancestry not checked)' : 'Mode: pre-merge comparison';
}

const digestLine = digest => `Proof inputs digest: \`sha256:${digest}\` (ticket check files, AC definitions, and CSV inputs; excludes app pins, runtime options, and shared tooling).`;

export function formatPlan({ ticket, commits, mergedRefs, adapters, fixtures, acs, postMerge, proofDigest, runtimeLabel, target, worktrees }, adapterTimeoutMs) {
  return [
    `Plan: ${ticket}`, modeLine(postMerge, target, worktrees), ...pins(commits, mergedRefs, target, worktrees),
    digestLine(proofDigest),
    `Runtime: ${target ? 'none (running environment)' : runtimeLabel}`,
    `Adapters: ${adapters.map(({ name }) => name).join(', ') || 'none'}`,
    `ACs: ${acs.length} · CSV inputs: ${fixtures.length}`,
    target ? 'No sandbox is started; the checks run against the listed origins.' : worktrees?.length ? 'Optional dataset capture, then one sandbox for the checkout.' : postMerge ? 'Optional dataset capture, then one After sandbox.' : 'Optional dataset capture, then separate Before and After sandboxes.',
    `Execution timeout: ${adapterTimeoutMs / 1000} seconds per adapter invocation.`,
    'No files written; runtime not imported and no services started.',
  ].join('\n');
}

export function makeReport({ ticket, commits, mergedRefs, acs, postMerge, proofDigest, target, worktrees = [] }, id, phases) {
  const single = postMerge || !!target || worktrees.length > 0;
  const issues = Object.entries(phases).flatMap(([side, { issues }]) => issues.map(issue => `- ${side}: ${issue}`));
  const notes = Object.entries(phases).flatMap(([side, { invoked, rows }]) => {
    const label = side === 'before' ? 'Before' : 'After';
    if (!invoked) return [`- ${label}: no adapter ran against the selected revision.`];
    if (!rows.length) return [`- ${label}: no validated adapter evidence.`];
    return [];
  });
  let exitCode = issues.length ? 1 : 0;
  const rows = acs.map(({ id: ac, claim }) => {
    const before = single ? null : verdict(phases.before, ac);
    const after = verdict(phases.after, ac);
    if (after.status !== 'pass' || before?.complete === false) exitCode = 1;
    return `| ${markdown(ac)} — ${markdown(claim)} | ${before?.text ?? (target ? 'Not run — target verification' : worktrees.length ? 'Not run — single checkout' : 'Not run — post-merge verification')} | ${after.text} |`;
  });
  const report = [
    `# Proof report — ${ticket}`, '', `Run: \`${id}\``, '', modeLine(postMerge, target, worktrees), '',
    `## ${target ? 'Target' : 'Revisions'}`, '', ...pins(commits, mergedRefs, target, worktrees), '',
    digestLine(proofDigest), '',
    ...(target ? ['Ticket checks run from private, read-only copies against the named environment. The runner limits adapter environment variables and only lets the checks reach the listed origins; it cannot verify which revision the environment serves. Checks that write data change that environment.', '']
      : ['Ticket checks run from private, read-only copies. Runtime modules and BDD steps are trusted same-user code, not host-isolated. The runner limits adapter environment variables and validates loopback origins; it cannot verify service ownership or that the runtime serves the pinned revisions.', '']),
    '| AC | Before | After |', '| --- | --- | --- |', ...rows,
    ...(notes.length ? ['', '## Execution notes', '', ...notes] : []),
    ...(issues.length ? ['', '## Run issues', '', ...issues] : []), '',
  ].join('\n');
  return { report, exitCode };
}
