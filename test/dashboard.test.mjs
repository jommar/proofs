import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import {
  InvalidRunsIndexError,
  UnsafeOutputDirError,
  collectDashboardData,
  parseReportMarkdown,
  renderDashboardHtml,
  writeDashboard,
} from '../lib/dashboard.mjs';
import { recordRun, unindexedRunDirs } from '../lib/runs.mjs';
import { run } from '../run.mjs';

const execFileAsync = promisify(execFile);
const dashboardCli = fileURLToPath(new URL('../dashboard.mjs', import.meta.url));

function extractEmbeddedJson(html) {
  const match = /<script id="proofs-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'embedded proofs-data JSON script tag must exist');
  return JSON.parse(match[1]);
}

function extractClientScript(html) {
  const match = /<script id="proofs-data" type="application\/json">[\s\S]*?<\/script>\s*<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'inline client script tag must exist');
  return match[1];
}

async function privateTmpDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseReportMarkdown extracts digest, duration fallback, filtered ACs, escaped markdown, multi-adapter rows, and notes/issues', () => {
  const report = [
    '# Proof report — TEAM-1',
    '',
    'Proof inputs digest: `sha256:abcdef0123456789` (ticket check files).',
    'Duration: 12.5s (startup 2.0s, bdd 7.5s, perf 2.5s, teardown 0.5s)',
    'Filtered ACs: `AC1, AC2` (partial run — not full ticket coverage).',
    '',
    '| AC | Result |',
    '| --- | --- |',
    '| AC1 — Escaped \\| pipe \\*star\\* \\[b\\] &amp; &lt;tag&gt; — with dash | Pass — bdd: pass — ok=true; api: pass — HTTP 200 |',
    '| AC2 — Fails cleanly | Fail — bdd: fail — headingVisible=false |',
    '| AC3 — Missing evidence | Blocked — Uncovered: no adapter evidence |',
    '| AC4 — Adapter blocked | Blocked — bdd: blocked — reason=missing_fixture |',
    '| AC5 — Not selected | Skipped — filtered out by --ac |',
    '| ---AC6 — Starts with dashes | Pass — api: pass — HTTP 200 |',
    '',
    '## Execution notes',
    '',
    '- No validated adapter evidence.',
    '',
    '## Run issues',
    '',
    '- Failed during sandbox startup: app: start failed.',
    '',
  ].join('\n');

  const parsed = parseReportMarkdown(report);
  assert.equal(parsed.proofDigest, 'abcdef0123456789');
  assert.equal(parsed.partial, true);
  assert.deepEqual(parsed.selectedAcs, ['AC1', 'AC2']);
  assert.equal(parsed.durationMs, 12500);
  assert.deepEqual(parsed.timings, { durationMs: 12500, startupMs: 2000, teardownMs: 500, adapters: { bdd: 7500, perf: 2500 } });
  assert.deepEqual(parsed.counts, { pass: 2, fail: 1, blocked: 1, skipped: 1, uncovered: 1, na: 0, unknown: 0, total: 6 });
  assert.equal(parsed.acs[0].id, 'AC1');
  assert.equal(parsed.acs[0].claim, 'Escaped | pipe *star* [b] & <tag> — with dash');
  assert.equal(parsed.acs[0].status, 'pass');
  assert.equal(parsed.acs[1].status, 'fail');
  assert.equal(parsed.acs[2].status, 'uncovered');
  assert.equal(parsed.acs[3].status, 'blocked');
  assert.equal(parsed.acs[4].status, 'skipped');
  assert.equal(parsed.acs[5].id, '---AC6');
  assert.equal(parsed.acs[5].status, 'pass');
  assert.deepEqual(parsed.notes, ['No validated adapter evidence.']);
  assert.deepEqual(parsed.issues, ['Failed during sandbox startup: app: start failed.']);
});

test('writeDashboard enforces 0o600, redacts context values, blocks traversal/symlinks/hardlinks/prototype keys, and emits valid CSP + JS', async t => {
  const out = await privateTmpDir(t, 'proof-dash-sec-');
  const outsideSecret = join(out, '..', `proof-outside-${process.pid}.txt`);
  await writeFile(outsideSecret, 'OUTSIDE_SECRET_DO_NOT_READ', { mode: 0o600 });
  t.after(() => rm(outsideSecret, { force: true }));

  const ticket = 'SEC-1';
  const protoTicket = 'constructor';
  const runA = '11111111-1111-4111-8111-111111111111';
  const runB = '22222222-2222-4222-8222-222222222222';
  const runC = '33333333-3333-4333-8333-333333333333';
  const runD = '44444444-4444-4444-8444-444444444444';
  const dirA = join(out, ticket, runA);
  const dirB = join(out, ticket, runB);
  const dirC = join(out, ticket, runC);
  const dirD = join(out, protoTicket, runD);
  await mkdir(join(dirA, 'diagnostics'), { recursive: true, mode: 0o700 });
  await mkdir(dirB, { recursive: true, mode: 0o700 });
  await mkdir(dirC, { recursive: true, mode: 0o700 });
  await mkdir(dirD, { recursive: true, mode: 0o700 });

  await writeFile(join(dirA, 'diagnostics', 'service.log'), 'DIAG_SECRET_TOKEN_99999\npassword=supersecret\n', { mode: 0o600 });
  await writeFile(join(dirA, 'diagnostics', 'bdd-failures.json'), '{"error":"STACK_TRACE_SECRET_88888"}', { mode: 0o600 });

  await writeFile(join(dirA, 'report.md'), [
    '# Proof report — SEC-1',
    'Proof inputs digest: `sha256:1234567890abcdef`',
    '| AC | Result |',
    '| --- | --- |',
    '| AC1 — &lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; | Pass — bdd: pass — ok=true |',
  ].join('\n'), { mode: 0o600 });

  // Symlinked report.md (must be ignored by O_NOFOLLOW).
  await symlink(outsideSecret, join(dirB, 'report.md'));
  // Hard-linked report.md (must be ignored by nlink !== 1).
  await link(outsideSecret, join(dirC, 'report.md'));
  // Valid report under "constructor" ticket (tests Map grouping vs Object.prototype).
  await writeFile(join(dirD, 'report.md'), [
    '# Proof report — constructor',
    '| AC | Result |',
    '| --- | --- |',
    '| AC1 — Prototype safe | Pass — api: pass — HTTP 200 |',
  ].join('\n'), { mode: 0o600 });

  // Symlinked ticket directory pointing outside outDir.
  const outsideTicketDir = await privateTmpDir(t, 'proof-outside-dir-');
  const runSym = '55555555-5555-4555-8555-555555555555';
  await mkdir(join(outsideTicketDir, runSym), { recursive: true, mode: 0o700 });
  await writeFile(join(outsideTicketDir, runSym, 'report.md'), '| AC | Result |\n| --- | --- |\n| AC1 — SYMLINK_DIR_LEAK | Pass — ok |\n');
  await symlink(outsideTicketDir, join(out, 'SYM-1'));

  await writeFile(join(out, 'runs.json'), JSON.stringify({
    [ticket]: {
      [runA]: {
        startedAt: '2026-11-20T09:00:00.000Z',
        durationMs: 4200,
        timings: { durationMs: 4200, startupMs: 1000, adapters: { bdd: 3000, custom: 100 }, teardownMs: 100 },
        exitCode: 0,
        runtime: '/home/secretuser/private/custom-runtime.mjs',
        type: 'worktree',
        worktrees: [{ app: 'app', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', dirty: false }, null],
        context: { PROOF_CONTEXT_TENANT: 'SECRET_TENANT_SLUG_77777' },
        only: ['bdd', 123],
        report: `.proofs-out/${ticket}/${runA}/report.md`,
      },
      [runB]: {
        startedAt: '2026-11-20T08:00:00.000Z',
        exitCode: 1,
        type: 'url',
        urls: { PROOF_APP_URL: 'https://example.test/ignored-path', BAD_KEY: 'https://nope.test' },
      },
      [runC]: {
        startedAt: 'invalid-date',
        durationMs: -50,
        exitCode: 1,
        type: 'url',
        urls: [],
      },
      '..': { startedAt: '2026-11-20T07:00:00.000Z', exitCode: 0, type: 'url', urls: {} },
    },
    [protoTicket]: {
      [runD]: { startedAt: '2026-11-20T06:00:00.000Z', exitCode: 0, type: 'url', urls: { PROOF_APP_URL: 'https://proto.test' } },
    },
    'SYM-1': {
      [runSym]: { startedAt: '2026-11-20T05:00:00.000Z', exitCode: 0, type: 'url', urls: {} },
    },
    '.': { [runA]: { startedAt: '2026-11-20T04:00:00.000Z', exitCode: 0, type: 'url', urls: {} } },
    '..': { '..': { startedAt: '2026-11-20T03:00:00.000Z', exitCode: 0, type: 'url', urls: {} } },
    '../escape': { [runA]: { startedAt: '2026-11-20T02:00:00.000Z', exitCode: 0, type: 'url', urls: {} } },
  }, null, 2), { mode: 0o600 });

  const res = await writeDashboard(out);
  assert.equal(res.ticketCount, 3);
  assert.equal(res.runCount, 5);
  assert.equal((await stat(res.path)).mode & 0o777, 0o600);
  assert.equal(({}).runCount, undefined, 'Object.prototype must never be polluted');

  const html = await readFile(res.path, 'utf8');
  assert.doesNotMatch(html, /DIAG_SECRET_TOKEN_99999/);
  assert.doesNotMatch(html, /STACK_TRACE_SECRET_88888/);
  assert.doesNotMatch(html, /OUTSIDE_SECRET_DO_NOT_READ/);
  assert.doesNotMatch(html, /SECRET_TENANT_SLUG_77777/);
  assert.doesNotMatch(html, /SYMLINK_DIR_LEAK/);
  assert.doesNotMatch(html, /\/home\/secretuser\/private/);
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /<meta name="referrer" content="no-referrer"/);

  // Verify CSP script hash matches the exact inline client script, and that the JS compiles cleanly.
  const clientJs = extractClientScript(html);
  new vm.Script(clientJs);
  const expectedHash = createHash('sha256').update(clientJs, 'utf8').digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${expectedHash}'`), 'CSP sha256 hash must match inline script');

  const data = extractEmbeddedJson(html);
  const loadedA = data.runs.find(r => r.id === runA);
  const loadedB = data.runs.find(r => r.id === runB);
  const loadedC = data.runs.find(r => r.id === runC);
  const loadedSym = data.runs.find(r => r.id === runSym);
  assert.equal(loadedA.hasDiagnostics, true);
  assert.equal(loadedA.runtime, 'custom-runtime.mjs');
  assert.deepEqual(loadedA.contextKeys, ['tenant']);
  assert.deepEqual(loadedA.adapters, ['bdd']);
  assert.equal(loadedA.worktrees.length, 1);
  assert.equal(loadedA.acs[0].claim, '</script><img src=x onerror=alert(1)>');
  assert.equal(loadedB.reportMissing, true);
  assert.deepEqual(loadedB.urls, { PROOF_APP_URL: 'https://example.test' });
  assert.equal(loadedC.reportMissing, true);
  assert.equal(loadedC.durationMs, null);
  assert.equal(loadedSym.reportMissing, true);
  assert.ok(data.tickets.some(entry => entry.ticket === 'constructor' && entry.runCount === 1));

  // dashboard.html must not confuse prune's unindexedRunDirs check.
  const orphans = await unindexedRunDirs(out);
  assert.deepEqual(orphans, []);
});

test('collectDashboardData and writeDashboard reject non-private, symlinked, or corrupt output directories', async t => {
  const pubDir = await mkdtemp(join(tmpdir(), 'proof-dash-pub-'));
  await chmod(pubDir, 0o755);
  t.after(() => rm(pubDir, { recursive: true, force: true }));
  await writeFile(join(pubDir, 'runs.json'), '{}', { mode: 0o600 });
  await assert.rejects(writeDashboard(pubDir), UnsafeOutputDirError);

  const privDir = await privateTmpDir(t, 'proof-dash-priv-');
  const linkDir = `${privDir}-link`;
  await symlink(privDir, linkDir);
  t.after(() => rm(linkDir, { force: true }));
  await assert.rejects(writeDashboard(linkDir), UnsafeOutputDirError);

  await writeFile(join(privDir, 'runs.json'), 'null', { mode: 0o600 });
  await assert.rejects(collectDashboardData(privDir), InvalidRunsIndexError);

  await writeFile(join(privDir, 'runs.json'), '[]', { mode: 0o600 });
  await assert.rejects(collectDashboardData(privDir), InvalidRunsIndexError);
});

test('concurrent recordRun and writeDashboard updates serialize cleanly without losing runs', async t => {
  const out = await privateTmpDir(t, 'proof-dash-conc-');
  const r1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const r2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await Promise.all([
    recordRun(out, 'CONC-1', r1, { startedAt: '2026-11-20T10:00:00.000Z', exitCode: 0, type: 'url', urls: {} })
      .then(() => writeDashboard(out)),
    recordRun(out, 'CONC-1', r2, { startedAt: '2026-11-20T10:01:00.000Z', exitCode: 0, type: 'url', urls: {} })
      .then(() => writeDashboard(out)),
  ]);
  const html = await readFile(join(out, 'dashboard.html'), 'utf8');
  const data = extractEmbeddedJson(html);
  assert.deepEqual(data.runs.map(r => r.id).sort(), [r1, r2]);
});

test('run.mjs auto-generates dashboard.html and dashboard.mjs CLI handles valid and invalid invocations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proof-dash-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ticket = 'DASH-42';
  await mkdir(join(root, '.proofs', ticket, 'api'), { recursive: true });
  await writeFile(join(root, '.proofs', ticket, 'api', 'placeholder.check'), 'placeholder check');
  await writeFile(join(root, '.proofs', ticket, 'manifest.json'), JSON.stringify({
    acs: [{ id: 'AC1', claim: 'Dashboard shows pass verdict' }],
  }));

  const outcome = await run([ticket, '--url', 'https://app.example.test'], {
    workspace: root,
    parentEnv: { PATH: process.env.PATH },
    invoke: async ({ env }) => {
      await writeFile(env.PROOF_RESULTS, `${JSON.stringify({ ac: 'AC1', status: 'pass', observed: 'HTTP 200; ok' })}\n`);
      return 0;
    },
  });

  assert.equal(outcome.exitCode, 0);
  const outDir = join(root, '.proofs-out');
  assert.equal(outcome.dashboardPath, join(outDir, 'dashboard.html'));
  const html = await readFile(outcome.dashboardPath, 'utf8');
  const data = extractEmbeddedJson(html);
  assert.equal(data.ticketCount, 1);
  assert.equal(data.runCount, 1);
  assert.equal(data.runs[0].ticket, ticket);
  assert.equal(data.runs[0].counts.pass, 1);

  // CLI happy path.
  const { stdout } = await execFileAsync(process.execPath, [dashboardCli, '--out', outDir]);
  assert.match(stdout, /Dashboard: .*dashboard\.html \(1 ticket\(s\), 1 run\(s\)\)/);
  assert.match(stdout, /Open: file:\/\//);

  // CLI bad argument forms must exit 2.
  for (const badArgs of [['--out'], ['--out', outDir, '--out', outDir], ['--out', outDir, '--out'], ['--out', '--help'], ['--bogus']]) {
    await assert.rejects(
      execFileAsync(process.execPath, [dashboardCli, ...badArgs]),
      error => error.code === 2 && /Usage: node proofs\/dashboard\.mjs/.test(error.stderr),
    );
  }

  // CLI distinct errors for missing runs.json vs corrupt runs.json vs unsafe dir (exit 1).
  const emptyPriv = await privateTmpDir(t, 'proof-dash-empty-');
  await assert.rejects(
    execFileAsync(process.execPath, [dashboardCli, '--out', emptyPriv]),
    error => error.code === 1 && /Cannot read .*runs\.json/.test(error.stderr),
  );
  await writeFile(join(emptyPriv, 'runs.json'), '{not-json', { mode: 0o600 });
  await assert.rejects(
    execFileAsync(process.execPath, [dashboardCli, '--out', emptyPriv]),
    error => error.code === 1 && /Cannot parse .*runs\.json/.test(error.stderr),
  );
  await chmod(emptyPriv, 0o755);
  await assert.rejects(
    execFileAsync(process.execPath, [dashboardCli, '--out', emptyPriv]),
    error => error.code === 1 && /Refused unsafe output directory/.test(error.stderr),
  );

  // Direct render smoke check on empty payload.
  const emptyHtml = renderDashboardHtml({ generatedAt: '2026-11-20T00:00:00.000Z', ticketCount: 0, runCount: 0, tickets: [], runs: [] });
  assert.match(emptyHtml, /<title>Proofs Dashboard<\/title>/);
});
