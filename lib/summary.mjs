// `run.mjs <ID> --summary`: merge the ticket's durable ledger into one AC x target matrix and a comment ready to
// paste into a ticket tracker. Only complete runs count (no --ac filter, no --debug). For each target it takes the
// latest run per persona and, per AC, the latest of those where the AC applied. Two local runs on different commits
// become Before/After when Git shows one commit is an ancestor of the other.
const LABEL = { pass: 'Pass', fail: 'Fail', blocked: 'Blocked', uncovered: 'Uncovered', skipped: 'Skipped', na: 'N/A' };
const short = sha => String(sha ?? '').slice(0, 7);
const cell = status => LABEL[status] ?? '—';
const escape = value => String(value).replace(/[\\|`*_[\]<>]/g, '\\$&');

const groupKey = entry => entry.target ?? (entry.mode === 'worktree' ? 'local' : `url ${Object.values(entry.urls ?? {}).sort().join(' ')}`);
const groupLabel = entry => entry.target ?? (entry.mode === 'worktree' ? 'local' : (() => {
  try { return new URL(Object.values(entry.urls ?? {})[0]).host; } catch { return 'url'; }
})());
const signature = entry => (entry.worktrees ?? []).map(({ app, sha }) => `${app}@${sha}`).sort().join(' ');
const newestFirst = (a, b) => String(b.startedAt).localeCompare(String(a.startedAt));

function latestPerPersona(runs) {
  const seen = new Map();
  for (const run of [...runs].sort(newestFirst)) if (!seen.has(run.persona ?? '')) seen.set(run.persona ?? '', run);
  return [...seen.values()];
}

function mergeStatus(runs, ac) {
  let na = false;
  for (const run of [...runs].sort(newestFirst)) {
    const status = run.results[ac];
    if (status === 'na') na = true;
    else if (status) return status;
  }
  return na ? 'na' : 'missing';
}

// Order two local commit sets as base and feature, or return null when Git cannot tell.
function orderLocal(a, b, isAncestor) {
  for (const left of a.worktrees ?? []) {
    const right = (b.worktrees ?? []).find(({ app }) => app === left.app);
    if (!right || right.sha === left.sha) continue;
    const repo = left.repo ?? right.repo;
    if (!repo) continue;
    if (isAncestor(repo, left.sha, right.sha) === true) return [a, b];
    if (isAncestor(repo, right.sha, left.sha) === true) return [b, a];
  }
  return null;
}

function columnsFor(runs, isAncestor) {
  const label = groupLabel(runs[0]);
  if (runs[0].mode !== 'worktree') return [{ label, runs: latestPerPersona(runs) }];
  const bySignature = new Map();
  for (const run of [...runs].sort(newestFirst)) {
    if (!bySignature.has(signature(run))) bySignature.set(signature(run), []);
    bySignature.get(signature(run)).push(run);
  }
  const sets = [...bySignature.values()];
  if (sets.length === 1) return [{ label, runs: latestPerPersona(sets[0]) }];
  const [newest, previous] = sets;
  const ordered = orderLocal(previous[0], newest[0], isAncestor);
  if (ordered) {
    const [base] = ordered;
    const [before, after] = base === previous[0] ? [previous, newest] : [newest, previous];
    return [{ label: `${label} before`, role: 'before', runs: latestPerPersona(before) }, { label: `${label} after`, role: 'after', runs: latestPerPersona(after) }];
  }
  return [newest, previous].map(set => ({ label: `${label} @${(set[0].worktrees ?? []).map(({ sha }) => short(sha)).join('+')}`, runs: latestPerPersona(set) }));
}

function verdict(before, after) {
  if (before === 'fail' && after === 'pass') return 'Delivered';
  if (before === 'pass' && after === 'pass') return 'Holds (base already passed)';
  if (before === 'fail' && after === 'fail') return 'Not met';
  if (before === 'pass' && after === 'fail') return 'Regression';
  if (before === 'na' && after === 'na') return 'N/A';
  return 'Not comparable';
}

function describeColumn({ label, runs }) {
  const run = [...runs].sort(newestFirst)[0];
  const parts = [];
  if (run.mode === 'worktree') parts.push((run.worktrees ?? []).map(({ app, sha, dirty }) => `${app}@${short(sha)}${dirty ? ' (dirty checkout)' : ''}`).join(', '));
  else parts.push(Object.values(run.urls ?? {}).join(', '));
  if (run.build) parts.push(`build ${run.build}`);
  if (run.source) parts.push(`source ${run.source.name}`);
  const personas = runs.map(({ persona }) => persona ?? 'default');
  parts.push(`persona${personas.length > 1 ? 's' : ''} ${personas.join(', ')}`);
  parts.push(`run ${String(run.startedAt).slice(0, 10)}`);
  return `- ${label}: ${parts.join('; ')}`;
}

export function summarize({ ticket, acs, entries, profileNames = [], isAncestor = () => undefined }) {
  const complete = entries.filter(entry => !entry.partial && !entry.debug);
  const groups = new Map();
  for (const entry of complete) {
    const key = groupKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const order = [...profileNames.filter(name => groups.has(name)), ...[...groups.keys()].filter(key => !profileNames.includes(key))];
  // Local first, then the profile order.
  order.sort((a, b) => (groups.get(b)[0].mode === 'worktree') - (groups.get(a)[0].mode === 'worktree'));
  const columns = order.flatMap(key => columnsFor(groups.get(key), isAncestor));
  const missing = profileNames.filter(name => !groups.has(name));
  const warnings = [];
  const digests = new Set(columns.flatMap(({ runs }) => runs.map(({ digest }) => digest)).filter(Boolean));
  if (digests.size > 1) warnings.push(`Proof inputs digest differs across the runs below (${[...digests].map(short).join(', ')}): the checks, ACs or CSVs changed between runs, so the columns are not like for like.`);
  const excluded = entries.length - complete.length;
  const before = columns.find(({ role }) => role === 'before');
  const after = columns.find(({ role }) => role === 'after');

  const header = ['AC', ...columns.map(({ label }) => label), ...(before && after ? ['Verdict'] : [])];
  const rows = acs.map(({ id, claim }) => {
    const statuses = columns.map(({ runs }) => mergeStatus(runs, id));
    const claimText = claim.length > 70 ? `${claim.slice(0, 67)}...` : claim;
    return [`${id} — ${claimText}`, ...statuses.map(cell), ...(before && after ? [verdict(mergeStatus(before.runs, id), mergeStatus(after.runs, id))] : [])];
  });
  const table = [header, header.map(() => '---'), ...rows].map(cells => `| ${cells.map(escape).join(' | ')} |`);
  const notes = [
    ...columns.map(describeColumn),
    ...missing.map(name => `- Not verified on ${name}.`),
    ...(rows.some(cells => cells.includes('N/A')) ? ['- N/A: not applicable on that target (a capability it lacks, writes it denies, or a persona not run there).'] : []),
  ];
  const digestText = digests.size === 1 ? ` (proof inputs \`sha256:${short([...digests][0])}\`)` : '';
  const comment = [`**Acceptance-criteria proofs — ${ticket}**${digestText}`, '', ...table, '', ...notes, ...warnings.map(text => `- Warning: ${text}`)].join('\n');
  const text = [
    `Summary: ${ticket} — ${complete.length} complete run(s) in the ledger${excluded ? `; ${excluded} partial (--ac) or --debug run(s) excluded` : ''}.`,
    ...warnings.map(text => `Warning: ${text}`),
    '', ...table, '', ...notes, '', 'Ticket comment (markdown):', '', comment,
  ].join('\n');
  return { text, comment, columns: columns.map(({ label }) => label), missing, warnings, complete: complete.length };
}
