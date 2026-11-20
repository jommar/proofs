import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectDashboardData, renderDashboardHtml, writeDashboard } from '../lib/dashboard.mjs';
import { startProgress } from '../lib/progress.mjs';
import { PROGRESS_STALE_MS, recordRun } from '../lib/runs.mjs';
import { run } from '../run.mjs';

const ticket = 'LIVE-1';
const REFRESH = /<meta http-equiv="refresh"/;
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const embedded = html => JSON.parse(/<script id="proofs-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);

async function privateDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// One checkout, one AC with browser and API checks, and fake runtime hooks.
async function workspace(t) {
  const root = await privateDir(t, 'proof-live-');
  const repo = join(root, 'app');
  await mkdir(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'base', '--allow-empty');
  for (const name of ['bdd', 'api']) {
    await mkdir(join(root, '.proofs', ticket, name), { recursive: true });
    await writeFile(join(root, '.proofs', ticket, name, 'placeholder.check'), 'placeholder check');
  }
  await writeFile(join(root, '.proofs', ticket, 'manifest.json'), JSON.stringify({ acs: [{ id: 'AC1', claim: 'Synthetic claim' }] }));
  await writeFile(join(root, 'runtime.mjs'), 'throw new Error("must not import the runtime fixture");\n');
  return { root, args: [ticket, '--worktree', 'app=app', '--runtime', 'runtime.mjs'] };
}

const out = root => join(root, '.proofs-out');
const liveEntry = async root => Object.values((await readJson(join(out(root), 'runs.json')))[ticket])[0];

test('a run shows as running with its current phase while it runs, then becomes the normal final record', async t => {
  const { root, args } = await workspace(t);
  const seen = [];
  // Snapshot what a refresh of the dashboard would show at each point of the run.
  const observe = async label => {
    const entry = await liveEntry(root);
    const html = await readFile(join(out(root), 'dashboard.html'), 'utf8');
    const [shown] = embedded(html).runs;
    seen.push({ label, phase: entry.phase, state: entry.state, status: shown.status, shownPhase: shown.phase, refresh: REFRESH.test(html) });
    assert.equal(entry.pid, process.pid);
    assert.deepEqual(entry.args, args);
    assert.equal(entry.exitCode, undefined);
    assert.equal(shown.exitCode, null);
    assert.ok(Date.parse(entry.updatedAt) >= Date.parse(entry.startedAt));
    // The durable ledger holds finished runs only.
    await assert.rejects(readFile(join(root, '.proofs', ticket, 'ledger.json')), { code: 'ENOENT' });
  };
  const outcome = await run(args, {
    workspace: root, parentEnv: { PATH: process.env.PATH },
    startSandbox: async () => {
      await observe('start');
      return { env: { PROOF_APP_URL: 'http://localhost:3333' }, close: () => observe('close') };
    },
    invoke: async ({ name, env }) => {
      await observe(name);
      await writeFile(env.PROOF_RESULTS, `${JSON.stringify({ ac: 'AC1', status: 'pass', observed: 'synthetic check' })}\n`);
      return 0;
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.progressWarning, undefined);
  assert.deepEqual(seen, [
    { label: 'start', phase: 'startup', state: 'running', status: 'running', shownPhase: 'startup', refresh: true },
    { label: 'bdd', phase: 'bdd', state: 'running', status: 'running', shownPhase: 'bdd', refresh: true },
    { label: 'api', phase: 'api', state: 'running', status: 'running', shownPhase: 'api', refresh: true },
    { label: 'close', phase: 'teardown', state: 'running', status: 'running', shownPhase: 'teardown', refresh: true },
  ]);

  const final = await liveEntry(root);
  for (const key of ['state', 'phase', 'pid', 'updatedAt']) assert.equal(final[key], undefined, key);
  assert.equal(final.exitCode, 0);
  assert.match(final.report, new RegExp(`^\\.proofs-out/${ticket}/[0-9a-f-]{36}/report\\.md$`));
  const html = await readFile(outcome.dashboardPath, 'utf8');
  assert.doesNotMatch(html, REFRESH);
  const [shown] = embedded(html).runs;
  assert.equal(shown.status, 'pass');
  assert.equal(shown.phase, null);
  const ledger = await readJson(join(root, '.proofs', ticket, 'ledger.json'));
  assert.equal(ledger.runs.length, 1);
  assert.equal(ledger.runs[0].exitCode, 0);
  assert.equal(ledger.runs[0].state, undefined);
});

test('a progress write that fails only warns: the run, its exit code, report and ledger are unchanged', async t => {
  const { root, args } = await workspace(t);
  // A directory where runs.json belongs makes every index write fail.
  await mkdir(join(out(root), 'runs.json'), { recursive: true, mode: 0o700 });
  await chmod(out(root), 0o700);
  const outcome = await run(args, {
    workspace: root, parentEnv: { PATH: process.env.PATH },
    startSandbox: async () => ({ env: { PROOF_APP_URL: 'http://localhost:3333' }, close: async () => {} }),
    invoke: async ({ env }) => {
      await writeFile(env.PROOF_RESULTS, `${JSON.stringify({ ac: 'AC1', status: 'pass', observed: 'synthetic check' })}\n`);
      return 0;
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.progressWarning, 'Live progress in .proofs-out/runs.json could not be updated.');
  assert.equal(outcome.runsWarning, 'Run was not added to .proofs-out/runs.json.');
  assert.match(await readFile(outcome.reportPath, 'utf8'), /^\| AC1 .*Pass/m);
  assert.equal((await readJson(join(root, '.proofs', ticket, 'ledger.json'))).runs.length, 1);

  // The tracker itself never rejects, even when every write fails.
  const tracker = await startProgress(join(out(root), 'missing'), ticket, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', phase => ({ phase }));
  await tracker.phase('bdd');
  assert.equal(await tracker.stop(), 'Live progress in .proofs-out/runs.json could not be updated.');
});

test('a running entry whose runner died or whose heartbeat stopped shows as interrupted, and only live runs refresh the page', async t => {
  const dir = await privateDir(t, 'proof-live-stale-');
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const ids = { live: '11111111-1111-4111-8111-111111111111', silent: '22222222-2222-4222-8222-222222222222', killed: '33333333-3333-4333-8333-333333333333' };
  // A runner that wrote its running entry and was then killed before its final record.
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { startProgress } from ${JSON.stringify(new URL('../lib/progress.mjs', import.meta.url).href)};
    await startProgress(${JSON.stringify(dir)}, ${JSON.stringify(ticket)}, ${JSON.stringify(ids.killed)},
      phase => ({ startedAt: new Date().toISOString(), state: 'running', phase, pid: process.pid, updatedAt: new Date().toISOString(), type: 'url', urls: {} }));
    process.kill(process.pid, 'SIGKILL');
  `]);
  assert.equal(crash.signal, 'SIGKILL');
  const running = (updatedAt, phase = 'bdd') => ({ startedAt: iso(now - 5_000), state: 'running', phase, pid: process.pid, updatedAt, type: 'url', urls: {} });
  await recordRun(dir, ticket, ids.live, running(iso(now)));
  await recordRun(dir, ticket, ids.silent, running(iso(now - PROGRESS_STALE_MS - 1_000), 'Not a phase: free text'));

  const data = await collectDashboardData(dir, { now });
  const byId = Object.fromEntries(data.runs.map(entry => [entry.id, entry]));
  assert.equal(byId[ids.live].status, 'running');
  assert.equal(byId[ids.live].phase, 'bdd');
  assert.equal(byId[ids.silent].status, 'interrupted');
  assert.equal(byId[ids.silent].phase, null);
  assert.equal(byId[ids.killed].status, 'interrupted');
  assert.equal(byId[ids.killed].phase, 'setup');
  assert.deepEqual([byId[ids.live].exitCode, byId[ids.killed].exitCode], [null, null]);
  const [entry] = data.tickets;
  assert.deepEqual([entry.passCount, entry.failCount, entry.blockedCount], [0, 0, 0]);
  assert.match(renderDashboardHtml(data), REFRESH);

  // Once the live run finishes, nothing is running and the page stops reloading itself.
  await recordRun(dir, ticket, ids.live, { startedAt: iso(now - 5_000), durationMs: 4_000, exitCode: 0, type: 'url', urls: {} });
  const { path } = await writeDashboard(dir, { now });
  const html = await readFile(path, 'utf8');
  assert.doesNotMatch(html, REFRESH);
  assert.deepEqual(embedded(html).runs.map(({ status }) => status).sort(), ['interrupted', 'interrupted', 'pass']);
});

test('concurrent runs updating progress in the same index never lose each other\'s entries', async t => {
  const dir = await privateDir(t, 'proof-live-conc-');
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  const startedAt = new Date().toISOString();
  const describe = side => phase => ({ startedAt, state: 'running', phase, pid: process.pid, updatedAt: new Date().toISOString(), type: 'url', urls: {}, args: [ticket, '--branch', side] });
  await Promise.all(ids.map(async (id, n) => {
    const tracker = await startProgress(dir, ticket, id, describe(n ? 'feature' : 'base'));
    for (const phase of ['startup', 'bdd', 'api', 'teardown']) await tracker.phase(phase);
    assert.equal(await tracker.stop(), undefined);
    const final = { startedAt, exitCode: n, type: 'url', urls: {} };
    await recordRun(dir, ticket, id, final);
  }));
  const index = await readJson(join(dir, 'runs.json'));
  assert.deepEqual(Object.keys(index[ticket]).sort(), ids);
  assert.deepEqual(ids.map(id => index[ticket][id].exitCode), [0, 1]);
  assert.ok(Object.values(index[ticket]).every(entry => entry.state === undefined));
  const { path } = await writeDashboard(dir);
  assert.doesNotMatch(await readFile(path, 'utf8'), REFRESH);
});
