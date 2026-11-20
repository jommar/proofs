import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseReportMarkdown } from '../lib/dashboard.mjs';
import { recordRun } from '../lib/runs.mjs';
import { run } from '../run.mjs';

const ticket = 'ACME-7';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', ...args], { encoding: 'utf8' }).trim();
const SECRET = 'fake-source-pw-9x';
const LOGIN = { APP_USER: 'fake-user', APP_PASS: 'fake-login-pass', DRIVER_USER: 'fake-driver', DRIVER_PASS: 'fake-driver-pass' };

const PROFILES = {
  targets: {
    local: {
      personas: { admin: {}, driver: {} }, defaultPersona: 'admin',
      login: { usernameEnv: 'APP_USER', passwordEnv: 'APP_PASS' },
      capabilities: { db: true, faultInjection: true },
      sourceEnv: 'PROOF_FROM',
      sources: {
        good: { kind: 'mysql', host: '127.0.0.1', port: 3317, database: 'seed_good', user: 'root', passwordEnv: 'SRC_PW' },
        bad: { kind: 'mysql', host: '127.0.0.1', port: 3317, database: 'seed_bad', user: 'root', passwordCommand: `printf '%s\\n' ${SECRET}` },
        big: { kind: 'mysql', host: '127.0.0.1', port: 3306, database: 'seed_big', user: 'root', passwordEnv: 'UNSET_PW' },
      },
      defaultSource: 'good',
    },
    dev: {
      urls: { app: 'https://dev.example.test' },
      context: { tenant: null },
      login: { usernameEnv: 'APP_USER', passwordEnv: 'APP_PASS' },
      personas: { admin: {}, driver: { usernameEnv: 'DRIVER_USER', passwordEnv: 'DRIVER_PASS' } }, defaultPersona: 'admin',
    },
    uat: { urls: { app: null } },
  },
};

const ACS = [
  { id: 'AC1', claim: 'Plain claim' },
  { id: 'AC2', claim: 'Writes data', writes: true },
  { id: 'AC3', claim: 'Needs a database', requires: ['db'] },
  { id: 'AC4', claim: 'Driver claim', persona: 'driver' },
];

async function workspace(t, manifest = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'proof-targets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'app');
  await mkdir(repo);
  git(repo, 'init', '-q');
  git(repo, 'commit', '-qm', 'base', '--allow-empty');
  const dir = join(root, '.proofs', ticket);
  await mkdir(join(dir, 'bdd'), { recursive: true });
  await writeFile(join(dir, 'bdd', 'placeholder.check'), 'placeholder check');
  await writeFile(join(root, '.proofs', 'targets.json'), JSON.stringify(PROFILES));
  await writeFile(join(root, 'runtime.mjs'), 'export {};\n');
  const save = extra => writeFile(join(dir, 'manifest.json'), JSON.stringify({ acs: ACS, ...manifest, ...extra }));
  await save();
  return { root, repo, dir, save };
}

const pass = ids => async ({ env }) => {
  const acs = env.PROOF_ACS ? env.PROOF_ACS.split(',') : ACS.map(({ id }) => id);
  await writeFile(env.PROOF_RESULTS, acs.map(ac => JSON.stringify({ ac, status: 'pass', observed: `saw ${ids ?? 'it'}` })).join('\n') + '\n');
  return 0;
};
const fakeSandbox = seen => ({
  startSandbox: async input => { seen?.push(input); return { env: { PROOF_APP_URL: 'http://127.0.0.1:3999', PROOF_CONTEXT_TENANT: 'demo' }, close: async () => {} }; },
});
const resultCell = (report, id) => report.split('\n').find(line => line.startsWith(`| ${id} — `)).split('|')[2].trim();

test('a target profile supplies urls, context, persona logins and capabilities; flags override it', async t => {
  const { root } = await workspace(t);
  const env = { PATH: process.env.PATH, ...LOGIN };
  const plan = (args, parentEnv = env) => run([ticket, ...args, '--plan'], { workspace: root, parentEnv });
  const missing = await plan(['--target', 'dev']);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.plan, /Problem: Target "dev" needs context\.tenant \(give --context tenant=<value>\)/);
  const ok = await plan(['--target', 'dev', '--context', 'tenant=demo']);
  assert.equal(ok.exitCode, 0, ok.plan);
  assert.match(ok.plan, /`app`: `https:\/\/dev\.example\.test`/);
  assert.match(ok.plan, /Target profile: `dev` \(`\.proofs\/targets\.json`\)/);
  assert.match(ok.plan, /Persona: `admin`/);
  assert.match(ok.plan, /Context: `tenant`=`demo`/);
  assert.match(ok.plan, /Login variables: `APP_USER`, `APP_PASS` \(set\)/);
  assert.match(ok.plan, /Capabilities: none \(writes denied\)/);
  assert.match((await plan(['--target', 'dev', '--context', 'tenant=demo', '--url', 'app=https://other.example.test'])).plan, /`app`: `https:\/\/other\.example\.test`/);
  assert.match((await plan(['--target', 'dev', '--context', 'tenant=demo', '--persona', 'driver'])).plan, /Login variables: `DRIVER_USER`, `DRIVER_PASS` \(set\)/);
  assert.match((await plan(['--target', 'uat'])).plan, /needs urls\.app \(give --url app=<origin>\)/);
  await assert.rejects(plan(['--target', 'nope']), /Unknown target "nope"; .*defines: local, dev, uat/);
  await assert.rejects(plan(['--target', 'dev', '--worktree', 'app']), /running environment.*--worktree/);
  await assert.rejects(plan(['--target', 'dev', '--persona', 'ghost']), /no persona "ghost"/);
  await assert.rejects(plan(['--target', 'local', '--url', 'https://dev.example.test']), /local profile: --url must be a loopback origin/);
  await assert.rejects(plan(['--target', 'local']), /local profile: add --worktree/);
  // A fatal preflight problem stops a real run before anything starts.
  await assert.rejects(run([ticket, '--target', 'dev'], { workspace: root, parentEnv: env, invoke: pass() }), /Cannot run: Target "dev" needs context\.tenant/);

  // Profiles hold names only: a stray secret field is refused.
  const bad = structuredClone(PROFILES);
  bad.targets.local.sources.good.password = 'x';
  await writeFile(join(root, '.proofs', 'targets.json'), JSON.stringify(bad));
  await assert.rejects(plan(['--target', 'dev']), /unknown field "password"/);
});

test('a real run records the profile and persona, and exposes them to the checks', async t => {
  const { root } = await workspace(t);
  const seen = [];
  const outcome = await run([ticket, '--target', 'dev', '--context', 'tenant=demo'], {
    workspace: root, parentEnv: { PATH: process.env.PATH, ...LOGIN },
    invoke: async input => { seen.push(input.env); return pass()(input); },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(seen[0].PROOF_APP_URL, 'https://dev.example.test');
  assert.equal(seen[0].PROOF_PERSONA, 'admin');
  assert.equal(seen[0].PROOF_TARGET_NAME, 'dev');
  assert.equal(seen[0].PROOF_CONTEXT_TENANT, 'demo');
  assert.deepEqual([seen[0].PROOF_USERNAME, seen[0].PROOF_PASSWORD], [LOGIN.APP_USER, LOGIN.APP_PASS]);
  const index = JSON.parse(await readFile(join(root, '.proofs-out', 'runs.json'), 'utf8'));
  const entry = Object.values(index[ticket])[0];
  assert.equal(entry.profile, 'dev');
  assert.equal(entry.persona, 'admin');
  assert.deepEqual(entry.notApplicable, { AC2: 'writes_denied', AC3: 'capability_missing: db', AC4: 'persona_mismatch: driver' });
});

test('capabilities, the write guard and personas mark ACs Not applicable here, which the exit code ignores', async t => {
  const { root, repo } = await workspace(t);
  const env = { PATH: process.env.PATH, ...LOGIN, SRC_PW: SECRET };
  const calls = [];
  const go = (args, invoke = pass()) => run([ticket, ...args], { workspace: root, parentEnv: env, invoke: async input => { calls.push(input.env.PROOF_ACS); return invoke(input); } });

  const dev = await go(['--target', 'dev', '--context', 'tenant=demo']);
  assert.equal(dev.exitCode, 0);
  assert.equal(calls.at(-1), 'AC1', 'only the applicable AC reaches the adapter');
  const report = await readFile(dev.reportPath, 'utf8');
  assert.match(resultCell(report, 'AC1'), /^Pass/);
  assert.equal(resultCell(report, 'AC2'), 'Not applicable here — writes\\_denied');
  assert.equal(resultCell(report, 'AC3'), 'Not applicable here — capability\\_missing: db');
  assert.equal(resultCell(report, 'AC4'), 'Not applicable here — persona\\_mismatch: driver');
  const parsed = parseReportMarkdown(report);
  assert.equal(parsed.counts.na, 3);
  assert.equal(parsed.counts.pass, 1);

  const driver = await go(['--target', 'dev', '--context', 'tenant=demo', '--persona', 'driver']);
  assert.equal(driver.exitCode, 0);
  assert.equal(calls.at(-1), 'AC4');
  assert.match(resultCell(await readFile(driver.reportPath, 'utf8'), 'AC1'), /persona\\_mismatch: admin/);

  // A failing applicable AC still fails the run.
  const failing = await go(['--target', 'dev', '--context', 'tenant=demo'], async ({ env: e }) => {
    await writeFile(e.PROOF_RESULTS, `${JSON.stringify({ ac: 'AC1', status: 'fail', observed: 'contradicted' })}\n`);
    return 1;
  });
  assert.equal(failing.exitCode, 1);

  // No profile: a running environment allows nothing an AC must declare; a local sandbox allows everything.
  await go(['--url', 'https://dev.example.test']);
  assert.equal(calls.at(-1), 'AC1');
  const local = await run([ticket, '--worktree', `app=${repo}`, '--runtime', 'runtime.mjs'], { workspace: root, parentEnv: env, ...fakeSandbox(), invoke: async input => { calls.push(input.env.PROOF_ACS); return pass()(input); } });
  assert.equal(local.exitCode, 0);
  assert.equal(calls.at(-1), 'AC1,AC2,AC3');
  // A local profile allows writes and the capabilities it lists.
  await run([ticket, '--target', 'local', '--worktree', `app=${repo}`, '--runtime', 'runtime.mjs'], { workspace: root, parentEnv: env, ...fakeSandbox(), invoke: async input => { calls.push(input.env.PROOF_ACS); return pass()(input); } });
  assert.equal(calls.at(-1), 'AC1,AC2,AC3');

  // Every AC not applicable: no adapter runs and the run still exits zero.
  const before = calls.length;
  const none = await go(['--target', 'dev', '--context', 'tenant=demo', '--ac', 'AC2,AC3']);
  assert.equal(none.exitCode, 0);
  assert.equal(calls.length, before);
});

test('named sources: default, --source, the raw override and passwords that never reach the report or ledger', async t => {
  const { root, repo, dir } = await workspace(t, { recordEnv: ['SAFE_LABEL', 'PROOF_FROM'] });
  const env = { PATH: process.env.PATH, ...LOGIN, SRC_PW: SECRET, SAFE_LABEL: 'build-42' };
  const starts = [];
  const go = (args, parentEnv = env) => run([ticket, '--target', 'local', '--worktree', `app=${repo}`, '--runtime', 'runtime.mjs', ...args], {
    workspace: root, parentEnv, ...fakeSandbox(starts),
    invoke: async ({ env: e }) => {
      await writeFile(e.PROOF_RESULTS, `${JSON.stringify({ ac: 'AC1', status: 'pass', observed: `leaked ${SECRET}` })}\n`);
      return 0;
    },
  });

  const byDefault = await go([]);
  assert.equal(starts.at(-1).env.PROOF_FROM, `mysql://root:${SECRET}@127.0.0.1:3317/seed_good`, 'the runtime gets the source URL in the profile\'s sourceEnv');
  assert.equal(starts.at(-1).env.PROOF_SOURCE_NAME, 'good');
  const report = await readFile(byDefault.reportPath, 'utf8');
  assert.match(report, /Source: `good` `mysql:\/\/127\.0\.0\.1:3317\/seed_good` \(profile default\)/);
  assert.match(report, /Recorded `SAFE_LABEL`: `build-42`/);
  assert.match(report, /Recorded `PROOF_FROM`: withheld/);
  assert.match(report, /Build: build not detected/);
  assert.match(report, /redacted local credential/);

  const picked = await go(['--source', 'bad']);
  assert.equal(starts.at(-1).env.PROOF_FROM, `mysql://root:${SECRET}@127.0.0.1:3317/seed_bad`, 'passwordCommand output is used, never shown');
  assert.match(await readFile(picked.reportPath, 'utf8'), /Source: `bad` `mysql:\/\/127\.0\.0\.1:3317\/seed_bad` \(--source\)/);

  // The raw override works exactly as before: it wins over the default and reaches the runtime unchanged.
  const raw = `mysql://root:${SECRET}@10.1.2.3:3399/seed_raw`;
  const overridden = await go([], { ...env, PROOF_FROM: raw });
  assert.equal(starts.at(-1).env.PROOF_FROM, raw);
  assert.match(await readFile(overridden.reportPath, 'utf8'), /Source: `PROOF_FROM override` `mysql:\/\/10\.1\.2\.3:3399\/seed_raw` \(raw PROOF_FROM\)/);
  // An explicit --source beats the raw override, and the plan says so.
  await go(['--source', 'good'], { ...env, PROOF_FROM: raw });
  assert.equal(starts.at(-1).env.PROOF_FROM, `mysql://root:${SECRET}@127.0.0.1:3317/seed_good`);
  const plan = await run([ticket, '--target', 'local', '--worktree', `app=${repo}`, '--runtime', 'runtime.mjs', '--source', 'good', '--plan'], { workspace: root, parentEnv: { ...env, PROOF_FROM: raw } });
  assert.match(plan.plan, /--source good replaces the raw PROOF_FROM already set/);

  // A missing source password stops a real run; --source without a profile or an unknown name is refused.
  await assert.rejects(go(['--source', 'big']), /Cannot run: Source "big": variable UNSET_PW is not set/);
  await assert.rejects(run([ticket, '--worktree', `app=${repo}`, '--runtime', 'runtime.mjs', '--source', 'good', '--plan'], { workspace: root, parentEnv: env }), /add --target/);
  await assert.rejects(go(['--source', 'ghost', '--plan']), /no source "ghost"; it defines: good, bad, big/);

  for (const path of [byDefault.reportPath, picked.reportPath, overridden.reportPath, join(root, '.proofs-out', 'runs.json'), join(dir, 'ledger.json')]) {
    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes(SECRET), `${path} must not hold the source password`);
    assert.ok(!text.includes('root:'), `${path} must not hold a connection string`);
    assert.ok(!text.includes(LOGIN.APP_PASS), `${path} must not hold the login`);
  }
});

test('a secret that is a common word is scrubbed from observed text but never from the harness\'s own lines', async t => {
  const { root, repo } = await workspace(t);
  const WORD = 'local';
  const env = { PATH: process.env.PATH, ...LOGIN, SRC_PW: WORD };
  const result = await run([ticket, '--target', 'local', '--worktree', `app=${repo}`, '--runtime', 'runtime.mjs'], {
    workspace: root, parentEnv: env, ...fakeSandbox([]),
    invoke: async ({ env: e }) => {
      await writeFile(e.PROOF_RESULTS, `${JSON.stringify({ ac: 'AC1', status: 'pass', observed: `leaked ${WORD}` })}\n`);
      return 0;
    },
  });
  const report = await readFile(result.reportPath, 'utf8');
  assert.match(report, /Mode: local checkout/, 'the mode line stays readable');
  assert.match(report, /Target profile: `local`/, 'the profile name stays readable');
  assert.ok(!report.includes(`leaked ${WORD}`), 'the observed text is still scrubbed');
});

test('source qualification lists every source with its verdict in one pass, from a probe or a recorded verdict', async t => {
  const { root, repo, dir, save } = await workspace(t);
  await mkdir(join(dir, 'setup'));
  // A probe that only reads: here it decides from the database name in PROOF_SOURCE_URL.
  await writeFile(join(dir, 'setup', 'probe.cjs'), `const url = new URL(process.env.PROOF_SOURCE_URL);
const checks = JSON.parse(process.env.PROOF_SOURCE_CHECKS);
for (const { id } of checks) console.log(JSON.stringify(url.pathname.endsWith('good') ? { id, ok: true } : { id, ok: false, reason: 'missing_open_order', row: 'private value' }));
`);
  await save({ sourceRequires: { probe: 'setup/probe.cjs', checks: [{ id: 'open_order', table: 'invoice', min: 1 }], known: { big: { qualifies: false, reason: 'too_large' } } } });
  const env = { PATH: process.env.PATH, ...LOGIN, SRC_PW: SECRET };
  const plan = args => run([ticket, '--target', 'local', '--worktree', `app=${repo}`, '--runtime', 'runtime.mjs', ...args, '--plan'], { workspace: root, parentEnv: env });
  const good = await plan([]);
  assert.equal(good.exitCode, 0, good.plan);
  assert.match(good.plan, /^- good \(chosen\) mysql:\/\/127\.0\.0\.1:3317\/seed_good: qualifies \(probe\)$/m);
  // A probe line with any field beyond id, ok and reason is refused, so a row value can never be shown.
  assert.match(good.plan, /^- bad mysql:\/\/127\.0\.0\.1:3317\/seed_bad: unknown \(probe: probe_output_invalid\)$/m);
  assert.match(good.plan, /^- big mysql:\/\/127\.0\.0\.1:3306\/seed_big: does not qualify \(recorded: too_large\)$/m);
  assert.doesNotMatch(good.plan, /private value/);

  await writeFile(join(dir, 'setup', 'probe.cjs'), `const url = new URL(process.env.PROOF_SOURCE_URL);
for (const { id } of JSON.parse(process.env.PROOF_SOURCE_CHECKS)) console.log(JSON.stringify(url.pathname.endsWith('good') ? { id, ok: true } : { id, ok: false, reason: 'missing_open_order' }));
`);
  const ok = await plan([]);
  assert.equal(ok.exitCode, 0, ok.plan);
  assert.match(ok.plan, /^- bad mysql:\/\/127\.0\.0\.1:3317\/seed_bad: does not qualify \(probe: open_order \(missing_open_order\)\)$/m);
  const chosenBad = await plan(['--source', 'bad']);
  assert.equal(chosenBad.exitCode, 1);
  assert.match(chosenBad.plan, /Problem: Source bad does not qualify for this ticket's fixtures \(open_order \(missing_open_order\)\); pick a qualifying one with --source/);
  for (const text of [good.plan, ok.plan, chosenBad.plan]) assert.ok(!text.includes(SECRET));

  // A ticket that declares nothing behaves as before: no qualification section.
  await save({});
  assert.doesNotMatch((await plan([])).plan, /Source qualification/);
});

test('--plan and --check collect every problem at once, and --check reads 401 as reachable but unauthenticated', async t => {
  const { root, repo, save } = await workspace(t, {
    login: { usernameEnv: 'MISSING_USER', passwordEnv: 'MISSING_PASS' },
    runtimeOptions: { services: { app: { start: 'node server.js', link: ['node_modules'] } }, passEnv: ['OPTIONAL_VAR'] },
  });
  await writeFile(join(repo, 'tracked.txt'), 'a');
  git(repo, 'add', 'tracked.txt');
  git(repo, 'commit', '-qm', 'tracked');
  await writeFile(join(repo, 'tracked.txt'), 'edited');
  await writeFile(join(repo, 'untracked.txt'), 'new');
  const env = { PATH: process.env.PATH };
  const plan = await run([ticket, '--worktree', repo, '--plan'], { workspace: root, parentEnv: env });
  assert.equal(plan.exitCode, 1);
  assert.match(plan.plan, /Preflight: 2 problems, 2 warnings/);
  assert.match(plan.plan, /Problem: Login variables MISSING_USER, MISSING_PASS not set/);
  assert.match(plan.plan, /Problem: app: link target node_modules does not exist in the app checkout/);
  assert.match(plan.plan, /Warning: app: checkout has uncommitted changes and untracked files; only the committed HEAD is tested/);
  assert.match(plan.plan, /Warning: passEnv variable OPTIONAL_VAR is not set/);
  const strict = await run([ticket, '--worktree', repo, '--plan', '--require-clean'], { workspace: root, parentEnv: env });
  assert.match(strict.plan, /Problem: app: checkout has .*\(--require-clean\)/);
  await assert.rejects(run([ticket, '--worktree', repo, '--require-clean'], { workspace: root, parentEnv: env }), /Cannot run: .*--require-clean/);
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.doesNotMatch((await run([ticket, '--worktree', repo, '--plan', '--expect-commit', head.slice(0, 10)], { workspace: root, parentEnv: env })).plan, /expect-commit/);
  assert.match((await run([ticket, '--worktree', repo, '--plan', '--expect-commit', 'deadbeef'], { workspace: root, parentEnv: env })).plan, /No --worktree checkout contains --expect-commit deadbeef/);

  // A custom runtime's preflight hook adds its own problems; nothing is started when anything is wrong.
  await save({ login: { usernameEnv: 'MISSING_USER', passwordEnv: 'MISSING_PASS' } });
  await writeFile(join(root, 'hooked.mjs'), `export async function preflight({ options }) { return { problems: ['database container is not running.'], warnings: ['cache is cold.'] }; }
export async function startSandbox() { throw new Error('must not start'); }
`);
  const check = await run([ticket, '--worktree', `app=${repo}`, '--runtime', 'hooked.mjs', '--check'], { workspace: root, parentEnv: env });
  assert.equal(check.exitCode, 1);
  assert.match(check.check, /^NOT READY — Login variables MISSING_USER, MISSING_PASS not set.* database container is not running\. Sandbox not started/);
  assert.match(check.check, /^- cache is cold\.$/m);

  const server = createServer((q, s) => { s.statusCode = q.url === '/version' ? 200 : 401; s.end(q.url === '/version' ? '{"commit":"abc1234def"}' : ''); }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const withLogin = await run([ticket, '--url', origin, '--check'], { workspace: root, parentEnv: { ...env, MISSING_USER: 'u', MISSING_PASS: 'fake-pass' } });
  assert.equal(withLogin.exitCode, 0);
  assert.match(withLogin.check, /^ready with warnings\nWarnings:\n- app answered HTTP 401: reachable but unauthenticated/);
});

test('build detection records the build and --expect-commit blocks a run on another build', async t => {
  const { root } = await workspace(t);
  const profiles = structuredClone(PROFILES);
  const server = createServer((q, s) => { s.end(q.url === '/version' ? '{"build":{"commit":"abc1234def"}}' : 'ok'); }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  profiles.targets.stage = { urls: { app: `http://127.0.0.1:${server.address().port}` }, version: { url: 'app', path: '/version', field: 'build.commit' } };
  await writeFile(join(root, '.proofs', 'targets.json'), JSON.stringify(profiles));
  const env = { PATH: process.env.PATH };
  const check = await run([ticket, '--target', 'stage', '--check'], { workspace: root, parentEnv: env });
  assert.match(check.check, /^Build: abc1234def$/m);
  const good = await run([ticket, '--target', 'stage', '--expect-commit', 'abc1234def0000'], { workspace: root, parentEnv: env, invoke: pass() });
  assert.equal(good.exitCode, 0);
  assert.match(await readFile(good.reportPath, 'utf8'), /Build: `abc1234def` \(from `app` `\/version`\)/);
  const other = await run([ticket, '--target', 'stage', '--expect-commit', '1234567'], { workspace: root, parentEnv: env, invoke: async () => assert.fail('no adapter on the wrong build') });
  assert.equal(other.exitCode, 1);
  const report = await readFile(other.reportPath, 'utf8');
  assert.match(report, /build does not match --expect-commit 1234567/);
  assert.match(resultCell(report, 'AC1'), /^Blocked/);
});

test('--summary merges the durable ledger into an AC x target matrix with Before/After and survives index pruning', async t => {
  const { root, repo, dir } = await workspace(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '--detach', join(root, 'feature'), 'HEAD');
  const feature = join(root, 'feature');
  git(feature, 'commit', '-qm', 'feature', '--allow-empty');
  const env = { PATH: process.env.PATH, ...LOGIN, SRC_PW: SECRET };
  const status = (map) => async ({ env: e }) => {
    const acs = e.PROOF_ACS ? e.PROOF_ACS.split(',') : ACS.map(({ id }) => id);
    await writeFile(e.PROOF_RESULTS, acs.map(ac => JSON.stringify({ ac, status: map[ac] ?? 'pass', observed: 'checked' })).join('\n') + '\n');
    return acs.some(ac => map[ac] === 'fail') ? 1 : 0;
  };
  const local = (dirPath, map, extra = []) => run([ticket, '--target', 'local', '--worktree', `app=${dirPath}`, '--runtime', 'runtime.mjs', ...extra], { workspace: root, parentEnv: env, ...fakeSandbox(), invoke: status(map) });
  await local(feature, {});
  await local(repo, { AC1: 'fail' });
  await local(feature, { AC4: 'pass' }, ['--persona', 'driver']);
  await local(repo, { AC1: 'fail' }, ['--ac', 'AC1']); // partial: excluded
  await local(repo, {}, ['--debug']); // debug: excluded
  await run([ticket, '--target', 'dev', '--context', 'tenant=demo'], { workspace: root, parentEnv: env, invoke: status({}) });

  // The 30-day index pruning drops every runs.json entry; the ledger beside the inputs is untouched.
  await recordRun(join(root, '.proofs-out'), 'OTHER-1', 'x', { startedAt: new Date().toISOString() }, Date.now() + 365 * 24 * 3600 * 1000);
  const index = JSON.parse(await readFile(join(root, '.proofs-out', 'runs.json'), 'utf8'));
  assert.equal(index[ticket], undefined);
  const ledger = JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8'));
  assert.equal(ledger.runs.length, 6);
  assert.ok(ledger.runs.every(entry => !JSON.stringify(entry).includes(SECRET) && !JSON.stringify(entry).includes('observed')));

  const { exitCode, summary } = await run([ticket, '--summary'], { workspace: root, parentEnv: env });
  assert.equal(exitCode, 0, summary);
  assert.match(summary, /6 complete run\(s\)|4 complete run\(s\) in the ledger; 2 partial/);
  assert.match(summary, /\| AC \| local before \| local after \| dev \| Verdict \|/);
  assert.match(summary, /\| AC1 — Plain claim \| Fail \| Pass \| Pass \| Delivered \|/);
  // The base adapter exited nonzero on its failure, so its passing rows were withheld (Blocked), as in a real run.
  assert.match(summary, /\| AC2 — Writes data \| Blocked \| Pass \| N\/A \| Not comparable \|/);
  assert.match(summary, /\| AC4 — Driver claim \| N\/A \| Pass \| N\/A \| Not comparable \|/);
  assert.match(summary, new RegExp(`local before: app@${base.slice(0, 7)}`));
  assert.match(summary, /- Not verified on uat\./);
  assert.match(summary, /Ticket comment \(markdown\):\n\n\*\*Acceptance-criteria proofs — ACME-7\*\*/);
  assert.doesNotMatch(summary, /Warning: Proof inputs digest differs/);

  // A check edited between runs is flagged: the columns are no longer like for like.
  await writeFile(join(dir, 'bdd', 'changed.feature'), 'Feature: changed\n');
  await run([ticket, '--target', 'dev', '--context', 'tenant=demo'], { workspace: root, parentEnv: env, invoke: status({}) });
  assert.match((await run([ticket, '--summary'], { workspace: root, parentEnv: env })).summary, /Warning: Proof inputs digest differs/);
  await assert.rejects(run([ticket, '--summary', '--target', 'dev'], { workspace: root, parentEnv: env }), /takes only --workspace/);
});
