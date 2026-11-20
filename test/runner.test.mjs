import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { writeDashboard } from '../lib/dashboard.mjs';
import { recordRun, unindexedRunDirs } from '../lib/runs.mjs';
import { unlockProofInputs } from '../lib/snapshot.mjs';
import { run } from '../run.mjs';

const ticket = 'ACME-1';
const names = ['web_ui', 'service-v2'];
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));
const ticketDir = root => join(root, '.proofs', ticket);

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'proof-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { acs: [{ id: 'AC1', claim: 'Main claim' }] };
  for (const app of names) {
    const repo = join(root, app);
    await mkdir(repo);
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'before', '--allow-empty');
  }
  const manifestPath = join(ticketDir(root), 'manifest.json');
  await mkdir(ticketDir(root), { recursive: true });
  await writeFile(join(root, 'runtime.mjs'), 'throw new Error("must not import the runtime fixture");\n');
  const save = () => writeFile(manifestPath, JSON.stringify(manifest));
  await save();
  return { root, manifest, save, manifestPath };
}

// A feature checkout: a linked worktree of the first repo with one extra commit on top of its base.
async function changed(root) {
  const repo = join(root, names[0]);
  const worktree = join(root, 'candidate');
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
  git(worktree, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'after', '--allow-empty');
  const sha = git(worktree, 'rev-parse', 'HEAD');
  return { worktree, sha };
}

// An adapter folder needs a check file to run: an empty one is skipped.
async function adapter(root, name = 'bdd') {
  const dir = join(ticketDir(root), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'placeholder.check'), 'placeholder check');
  return dir;
}

async function fixtureRunner(t, code) {
  const harness = await mkdtemp(join(tmpdir(), 'copied-proof-harness-'));
  t.after(() => rm(harness, { recursive: true, force: true }));
  for (const dir of ['bdd', 'lib', 'runtime']) await mkdir(join(harness, dir));
  await writeFile(join(harness, 'runtime', 'command.mjs'), await readFile(new URL('../runtime/command.mjs', import.meta.url)));
  await writeFile(join(harness, 'run.mjs'), await readFile(runner));
  for (const file of await readdir(new URL('../lib/', import.meta.url))) {
    await writeFile(join(harness, 'lib', file), await readFile(new URL(`../lib/${file}`, import.meta.url)));
  }
  await writeFile(join(harness, 'bdd', 'fixtures.mjs'), 'export const observation = "shared fixture loaded";\n');
  await writeFile(join(harness, 'bdd', 'run.mjs'), code);
  return join(harness, 'run.mjs');
}

const result = (status = 'pass', observed = 'one check', ac = 'AC1') => ({ ac, status, observed });
const writeResults = (file, rows) => writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const sandboxEnv = () => ({
  PROOF_CUSTOM_ORIGIN_URL: 'http://localhost:3333',
  PROOF_CONTEXT_REALM: 'synthetic-realm',
  PROOF_USERNAME: 'fake-fixture-user',
  PROOF_PASSWORD: 'fake-fixture-password',
  PROOF_API_HEADERS: JSON.stringify({ PROOF_CUSTOM_ORIGIN_URL: { Authorization: 'Bearer fake-api-token', Cookie: 'synthetic=fake-api-cookie' } }),
  DO_NOT_FORWARD: 'fake-runtime-secret',
});

function fakes() {
  const events = [];
  const calls = [];
  const dataset = { capture: 'fake' };
  return {
    dataset, events, calls,
    captureDataset: async ({ dir, workspace, options, signal }) => {
      events.push('capture');
      assert.equal(workspace, join(dir, '../../../..', '..'));
      assert.equal(typeof options, 'object');
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.ok(signal instanceof AbortSignal);
      return dataset;
    },
    startSandbox: async input => {
      const { id, dir, dataset: supplied } = input;
      const side = id.split('-').at(-1);
      events.push(`start-${side}`);
      calls.push(input);
      assert.equal(supplied, dataset);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      return { env: sandboxEnv(), close: async () => { events.push(`close-${side}`); } };
    },
    invoke: async ({ name, env }) => {
      events.push(`${name}-${env.PROOF_SIDE}`);
      await writeResults(env.PROOF_RESULTS, [result()]);
      return 0;
    },
  };
}

// Every repo the helper creates is a valid checkout, so a run targets them unless the test names its own target.
const checkouts = names.flatMap(app => ['--worktree', `${app}=${app}`]);
const feature = ['--worktree', 'web_ui=candidate'];

function execute(root, deps = {}, args = [ticket]) {
  const full = args.includes('--url') || args.includes('--worktree') ? args : [...args, ...checkouts];
  return run(full.includes('--url') ? full : [...full, '--runtime', 'runtime.mjs'], { workspace: root, ...deps });
}

test('plan is runnable from another cwd, pins the checkout HEAD, and creates no files', async t => {
  const { root, manifest, save } = await workspace(t);
  const { worktree, sha } = await changed(root);
  await save();
  const output = execFileSync(process.execPath, [runner, ticket, '--workspace', root, '--runtime', 'runtime.mjs', ...feature, '--plan'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.match(output, new RegExp(sha));
  assert.match(output, /Mode: local checkout/);
  assert.match(output, /`web_ui`: `[0-9a-f]{40}` \(clean checkout\)/);
  assert.match(output, /300 seconds per adapter invocation/);
  assert.equal(execFileSync(process.execPath, [runner, ticket, '--runtime', join(root, 'runtime.mjs'), ...feature, '--plan'], { cwd: root, encoding: 'utf8' }), output);
  await assert.rejects(run([ticket, '--plan', '--runtime', 'missing.mjs', ...feature], { workspace: root }), /runtime.*existing/i);
  // Without a flag, PROOFS_RUNTIME, or a workspace runtime, the built-in command runtime is used; the plan says so.
  await assert.rejects(run([ticket, '--plan', ...feature], { workspace: root, parentEnv: {} }), /runtimeOptions\.services.*--url/s);
  manifest.runtimeOptions = { services: { app: { start: 'node server.js' } } };
  await save();
  const builtIn = await run([ticket, '--plan', ...feature], { workspace: root, parentEnv: {} });
  assert.match(builtIn.plan, /Runtime: built-in command runtime/);
  assert.match(output, /Runtime: runtime\.mjs/);
  // PROOFS_RUNTIME stands in for --runtime; the flag wins when both are given.
  const viaEnv = await run([ticket, '--plan', ...feature], { workspace: root, parentEnv: { PROOFS_RUNTIME: join(root, 'runtime.mjs') } });
  assert.equal(viaEnv.plan, output.trimEnd());
  await assert.rejects(
    run([ticket, '--plan', '--runtime', 'missing.mjs', ...feature], { workspace: root, parentEnv: { PROOFS_RUNTIME: join(root, 'runtime.mjs') } }),
    /runtime.*existing/i,
  );
  // A workspace's own .proofs-runtime/runtime.mjs is the default when nothing else is chosen.
  await mkdir(join(root, '.proofs-runtime'));
  await copyFile(join(root, 'runtime.mjs'), join(root, '.proofs-runtime', 'runtime.mjs'));
  const viaWorkspace = await run([ticket, '--plan', ...feature], { workspace: root, parentEnv: {} });
  assert.match(viaWorkspace.plan, /Runtime: \.proofs-runtime\/runtime\.mjs/);
  assert.ok(!(await readdir(root)).includes('.proofs-out'));
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), sha);
});

test('one capture and one run: allowlisted env, scoped credentials, private CSVs, frozen inputs and report', async t => {
  const { root, manifest, save } = await workspace(t);
  const { worktree, sha } = await changed(root);
  manifest.acs.push({ id: 'AC2', claim: 'Second | claim' });
  manifest.runtimeOptions = { profile: { name: 'synthetic' } };
  manifest.csv = ['examples/fixture.csv'];
  await mkdir(join(ticketDir(root), 'examples'));
  await writeFile(join(ticketDir(root), 'examples', 'fixture.csv'), 'private-csv-record');
  await save();
  const bddDir = await adapter(root);
  const apiDir = await adapter(root, 'api');
  await mkdir(join(bddDir, 'features'));
  await writeFile(join(bddDir, 'features', 'check.feature'), 'pinned browser check');
  await writeFile(join(apiDir, 'proof.json'), 'pinned API check');
  const getDigest = text => text.match(/^Proof inputs digest: `sha256:([a-f0-9]{64})`/m)?.[1];
  const args = [ticket, ...feature, '--worktree', 'service-v2=service-v2'];
  const { plan } = await execute(root, {}, [...args, '--plan']);
  const digest = getDigest(plan);
  assert.ok(digest);
  const deps = fakes();
  const start = deps.startSandbox;
  const capture = deps.captureDataset;
  deps.captureDataset = async input => {
    assert.deepEqual(input.options, manifest.runtimeOptions);
    input.options.profile.name = 'capture override';
    return capture(input);
  };
  deps.startSandbox = async input => {
    assert.equal(input.workspace, root);
    assert.deepEqual(input.options, manifest.runtimeOptions);
    input.options.profile.name = 'run override';
    const side = await start(input);
    const caPath = join(input.dir, 'side-ca.pem');
    await writeFile(caPath, 'fake side CA');
    side.env.NODE_EXTRA_CA_CERTS = caPath;
    return side;
  };
  t.mock.method(deps, 'invoke', async ({ name, entry, ticketDir: stagedDir, cwd, env }) => {
    deps.events.push(`${name}-${env.PROOF_SIDE}`);
    assert.equal(entry, fileURLToPath(new URL(`../${name}/run.mjs`, import.meta.url)));
    assert.equal(stagedDir, join(cwd, 'proofs', name, ticket));
    const inputFile = join(stagedDir, name === 'bdd' ? 'features/check.feature' : 'proof.json');
    // The api adapter runs after the browser adapter edited the sources below, yet still sees the frozen copy.
    assert.equal(await readFile(inputFile, 'utf8'), name === 'bdd' ? 'pinned browser check' : 'pinned API check');
    assert.equal((await stat(inputFile)).mode & 0o777, 0o400);
    assert.equal((await stat(stagedDir)).mode & 0o777, 0o500);
    assert.equal(cwd, env.PROOF_RUN_DIR);
    assert.equal(env.PROOF_SIDE, 'run');
    assert.equal(env.PROOF_CONTEXT_REALM, 'synthetic-realm');
    assert.equal(env.PROOF_CUSTOM_ORIGIN_URL, 'http://localhost:3333');
    assert.equal(env.PROOF_TICKET, ticket);
    assert.equal(env.PROOF_PASSWORD, name === 'bdd' ? 'fake-fixture-password' : undefined);
    assert.equal(env.PROOF_USERNAME, name === 'bdd' ? 'fake-fixture-user' : undefined);
    assert.deepEqual(env.PROOF_API_HEADERS ? JSON.parse(env.PROOF_API_HEADERS) : undefined, name === 'api'
      ? { PROOF_CUSTOM_ORIGIN_URL: { authorization: 'Bearer fake-api-token', cookie: 'synthetic=fake-api-cookie' } } : undefined);
    assert.equal(env.HOME, env.PROOF_RUN_DIR);
    assert.equal(env.DO_NOT_FORWARD, undefined);
    assert.equal(env.AMBIENT_FAKE_SECRET, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NODE_EXTRA_CA_CERTS, join(cwd, '..', 'sandbox', 'side-ca.pem'));
    assert.equal((await stat(env.PROOF_CSV_DIR)).mode & 0o777, 0o500);
    const fixture = join(env.PROOF_CSV_DIR, 'fixture.csv');
    assert.equal((await stat(fixture)).mode & 0o777, 0o400);
    assert.equal(await readFile(fixture, 'utf8'), 'private-csv-record');
    if (name === 'bdd') {
      await writeFile(join(bddDir, 'features', 'check.feature'), 'changed browser check');
      await writeFile(join(apiDir, 'proof.json'), 'changed API check');
      await writeFile(join(ticketDir(root), 'examples', 'fixture.csv'), 'source changed');
    }
    await writeResults(env.PROOF_RESULTS, [result('pass', name === 'bdd' ? 'checked | screen' : { matching: 1, visible: true }, name === 'bdd' ? 'AC1' : 'AC2'),
      ...(name === 'api' ? [result('pass', 'fake-api-token and fake-api-cookie', 'AC2')] : [])]);
    return 0;
  });
  const runResult = await execute(root, { ...deps, parentEnv: {
    PATH: process.env.PATH, AMBIENT_FAKE_SECRET: 'fake-ambient-secret', NODE_OPTIONS: '--inspect', NODE_EXTRA_CA_CERTS: '/ambient-cert',
  } }, args);
  const report = await readFile(runResult.reportPath, 'utf8');
  assert.equal(runResult.exitCode, 0, report);
  assert.deepEqual(deps.events, ['capture', 'start-run', 'bdd-run', 'api-run', 'close-run']);
  assert.equal(deps.calls.length, 1);
  assert.match(deps.calls[0].id, /^proof-[0-9a-f-]{36}-run$/);
  assert.deepEqual(deps.calls[0].commits[names[0]], { repo: worktree, sha });
  assert.deepEqual(deps.calls[0].commits[names[1]], { repo: join(root, names[1]), sha: git(join(root, names[1]), 'rev-parse', 'HEAD') });
  assert.equal(getDigest(report), digest);
  assert.notEqual(getDigest((await execute(root, {}, [...args, '--plan'])).plan), digest);
  assert.match(report, new RegExp(sha));
  assert.match(report, /^## Revisions$/m);
  assert.match(report, /^Mode: local checkout/m);
  assert.match(report, /^\| AC \| Result \|$/m);
  assert.doesNotMatch(report, /Before|After/);
  assert.match(report, /^\| AC1 .*Pass.*checked \\\| screen/m);
  assert.match(report, /^\| AC2 .*Pass/m);
  assert.match(report, /matching=1, visible=true/);
  assert.doesNotMatch(report, /fake-fixture|private-csv-record|fake-ambient-secret|fake-runtime-secret|fake-api/);
  assert.match(report, /redacted local credential/);
  assert.deepEqual(await readdir(join(runResult.reportPath, '..')), ['report.md']);
  const index = JSON.parse(await readFile(join(root, '.proofs-out', 'runs.json'), 'utf8'));
  const [[runId, entry]] = Object.entries(index[ticket]);
  assert.equal(runResult.reportPath, join(root, '.proofs-out', ticket, runId, 'report.md'));
  assert.equal(entry.type, 'worktree');
  assert.equal(entry.exitCode, 0);
  assert.deepEqual(entry.args, [...args, '--runtime', 'runtime.mjs']);
  assert.equal(entry.worktrees[0].sha, sha);
  assert.doesNotMatch(JSON.stringify(index), /fake-fixture|fake-ambient-secret|fake-runtime-secret|fake-api/);
});

test('proof inputs digest ignores app revisions and runtime options but detects AC and CSV edits', async t => {
  const { root, manifest, save } = await workspace(t);
  const csv = join(ticketDir(root), 'fixture.csv');
  await writeFile(csv, 'first');
  manifest.csv = ['fixture.csv'];
  await save();
  const digest = async () => (await execute(root, {}, [ticket, '--plan'])).plan.match(/^Proof inputs digest: `sha256:([a-f0-9]{64})`/m)?.[1];
  const first = await digest();
  assert.ok(first);
  for (const app of names) git(join(root, app), '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'next', '--allow-empty');
  assert.equal(await digest(), first, 'a moved HEAD does not change the digest');
  manifest.runtimeOptions = { services: { app: { start: 'node other.js' } }, context: { tenant: 'other' } };
  await save();
  assert.equal(await digest(), first, 'runtime options do not change the digest');
  manifest.acs[0].claim = 'Changed claim';
  await save();
  const changedAC = await digest();
  assert.notEqual(changedAC, first);
  await writeFile(csv, 'second');
  assert.notEqual(await digest(), changedAC);
});

test('rejects invalid manifest and unsafe or duplicate CSVs before runtime', async t => {
  const { root, manifest, save, manifestPath } = await workspace(t);
  const validate = async pattern => {
    await save();
    await assert.rejects(execute(root), pattern);
    assert.ok(!(await readdir(root)).includes('.proofs-out'));
  };
  for (const invalid of ['../ACME-1', 'ACME/1', 'ACME\\1', 'X'.repeat(65)]) {
    await assert.rejects(execute(root, {}, [invalid]), /usage/i);
  }
  const secondId = 'docs-release_12.3';
  const secondTicket = join(root, '.proofs', secondId);
  await mkdir(join(secondTicket, 'bdd'), { recursive: true });
  await writeFile(join(secondTicket, 'bdd', 'placeholder.check'), 'placeholder check');
  await writeFile(join(secondTicket, 'manifest.json'), JSON.stringify(manifest));
  const { plan } = await execute(root, {}, [secondId, '--plan']);
  assert.match(plan, /^Plan: docs-release_12\.3/);
  assert.match(plan, /^Adapters: bdd$/m);
  manifest.acs.push(manifest.acs[0]);
  await validate(/duplicate AC/i);
  manifest.acs.pop();
  manifest.runtimeOptions = [];
  await validate(/runtimeOptions.*object/i);
  delete manifest.runtimeOptions;
  for (const invalid of ['../outside.csv', '/outside.csv']) {
    manifest.csv = [invalid];
    await validate(/CSV path/i);
  }
  const dir = ticketDir(root);
  await mkdir(join(dir, 'fixtures'));
  await writeFile(join(dir, 'same.csv'), 'a');
  await writeFile(join(dir, 'fixtures', 'same.csv'), 'b');
  manifest.csv = ['same.csv', 'fixtures/same.csv'];
  await validate(/duplicate CSV/i);
  await symlink(join(dir, 'same.csv'), join(dir, 'link.csv'));
  manifest.csv = ['link.csv'];
  await validate(/CSV/i);
  await link(join(dir, 'same.csv'), join(dir, 'hardlink.csv'));
  manifest.csv = ['hardlink.csv'];
  await validate(/CSV.*without links/i);
  await writeFile(manifestPath, 'not json');
  await assert.rejects(execute(root), /valid JSON/i);
});

test('--worktree runs the committed HEAD without using or changing the checkout\'s HEAD or dirty files', async t => {
  const { root, save } = await workspace(t);
  const primary = join(root, names[0]);
  const head = git(primary, 'rev-parse', 'HEAD');
  await writeFile(join(primary, 'not-part-of-proof.txt'), 'dirty');
  await save();
  await adapter(root);
  const deps = fakes();
  // An absolute checkout path works the same as a workspace-relative one.
  const outcome = await execute(root, deps, [ticket, '--worktree', `web_ui=${primary}`]);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(deps.calls.map(call => call.commits), [{ web_ui: { repo: primary, sha: head } }]);
  assert.equal(git(primary, 'rev-parse', 'HEAD'), head);
  assert.equal(git(primary, 'status', '--porcelain'), '?? not-part-of-proof.txt');
  assert.equal(await readFile(join(primary, 'not-part-of-proof.txt'), 'utf8'), 'dirty');
});

test('rejects symlinked output roots and adapter ticket directories', async t => {
  const { root } = await workspace(t);
  const other = join(root, 'unowned-target');
  await mkdir(other);
  await symlink(other, join(root, '.proofs-out'));
  await assert.rejects(execute(root, fakes()), /output directory/i);
  assert.deepEqual(await readdir(other), []);
  await symlink(other, join(ticketDir(root), 'bdd'));
  await assert.rejects(execute(root, {}, [ticket, '--plan']), /ticket directory.*symlinks/i);
  await symlink(join(root, 'runtime.mjs'), join(root, 'runtime-link.mjs'));
  await assert.rejects(run([ticket, '--plan', '--runtime', 'runtime-link.mjs', ...checkouts], { workspace: root }), /runtime.*symlinks/i);
});

test('rejects links, special files, and generated private artifacts in check directories', async t => {
  const { root } = await workspace(t);
  const dir = await adapter(root);
  const injected = join(dir, 'injected');
  await symlink(join(dir, '..', 'fixtures.mjs'), injected);
  await assert.rejects(execute(root, {}, [ticket, '--plan']), /ticket check.*links/i);
  await rm(injected);
  execFileSync('mkfifo', [injected]);
  await assert.rejects(execute(root, {}, [ticket, '--plan']), /ticket check.*regular/i);
  await rm(injected);
  await mkdir(join(dir, 'test-results'));
  await assert.rejects(execute(root, {}, [ticket, '--plan']), /generated or private/i);
});

test('invalid, absent, and nonzero-pass results block the result and do not echo raw values', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  await adapter(root, 'api');
  for (const failure of ['missing', 'malformed', 'unknown AC', 'invalid status', 'invalid observed', 'empty', 'nonzero-pass', 'launch']) {
    const deps = fakes();
    const write = deps.invoke;
    deps.invoke = async args => {
      const { env, name } = args;
      if (name === 'api') return write(args);
      switch (failure) {
        case 'missing': return 0;
        case 'malformed': await writeFile(env.PROOF_RESULTS, 'RAW-PRIVATE-OUTPUT'); return 0;
        case 'unknown AC': await writeResults(env.PROOF_RESULTS, [result('pass', 'RAW-PRIVATE-OUTPUT', 'UNKNOWN')]); return 0;
        case 'invalid status': await writeResults(env.PROOF_RESULTS, [result('success', 'RAW-PRIVATE-OUTPUT')]); return 0;
        case 'invalid observed': await writeResults(env.PROOF_RESULTS, [result('pass', { secret: 'RAW-PRIVATE-OUTPUT' })]); return 0;
        case 'empty': await writeFile(env.PROOF_RESULTS, '\n'); return 0;
        case 'nonzero-pass': await writeResults(env.PROOF_RESULTS, [result('pass', 'RAW-PRIVATE-OUTPUT')]); return 2;
        case 'launch': throw new Error('RAW-PRIVATE-OUTPUT');
      }
    };
    const runResult = await execute(root, deps);
    assert.equal(runResult.exitCode, 1, failure);
    assert.ok(deps.events.includes('close-run'), failure);
    const report = await readFile(runResult.reportPath, 'utf8');
    // The api adapter passed AC1, but the browser adapter's missing or invalid evidence still blocks it.
    assert.match(report, /^\| AC1 .*Blocked/m, failure);
    assert.match(report, /## Run issues[\s\S]*bdd adapter/, failure);
    assert.doesNotMatch(report, /RAW-PRIVATE-OUTPUT/, failure);
  }
});

test('missing adapters leave ACs uncovered; a fail or blocked result cannot exit zero', async t => {
  const { root, manifest, save } = await workspace(t);
  manifest.acs.push({ id: 'AC2', claim: 'No adapter covers this' });
  await save();
  const absent = await execute(root, fakes());
  assert.equal(absent.exitCode, 1);
  const absentReport = await readFile(absent.reportPath, 'utf8');
  assert.match(absentReport, /^\| AC1 .*Uncovered/m);
  assert.match(absentReport, /^\| AC2 .*Uncovered/m);
  await adapter(root);
  for (const status of ['fail', 'blocked']) {
    const deps = fakes();
    deps.invoke = async ({ env }) => {
      await writeResults(env.PROOF_RESULTS, [result(status)]);
      return 0;
    };
    const outcome = await execute(root, deps);
    assert.equal(outcome.exitCode, 1);
    const report = await readFile(outcome.reportPath, 'utf8');
    assert.match(report, new RegExp(`^\\| AC1 .*${status}`, 'im'));
    assert.match(report, /^\| AC2 .*Uncovered/m);
  }
});

test('an empty adapter folder is skipped with a warning instead of blocking every AC', async t => {
  const { root, manifest, save } = await workspace(t);
  manifest.acs.push({ id: 'AC2', claim: 'Only an API check would cover this' });
  await save();
  await adapter(root);
  await mkdir(join(ticketDir(root), 'api', 'empty-subfolder'), { recursive: true });
  const warning = `api adapter skipped: its folder .proofs/${ticket}/api/ holds no check files`;
  const { plan } = await execute(root, {}, [ticket, '--plan']);
  assert.match(plan, /^Adapters: bdd \(skipped, empty folder: api\)$/m);
  assert.ok(plan.includes(`- Warning: ${warning}`), plan);
  const { check } = await execute(root, fakes(), [ticket, '--check']);
  assert.ok(check.includes(`- ${warning}`), check);
  const invoked = [];
  const deps = fakes();
  // The real api adapter cannot produce evidence from an empty folder; running it used to block every AC.
  deps.invoke = async ({ name, env }) => {
    invoked.push(name);
    if (name === 'bdd') await writeResults(env.PROOF_RESULTS, [result()]);
    return 0;
  };
  const outcome = await execute(root, deps);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.deepEqual(invoked, ['bdd']);
  assert.match(report, /^\| AC1 .*\| Pass — bdd: pass/m);
  assert.match(report, /^\| AC2 .*Uncovered/m, 'a missing check is never a pass');
  assert.equal(outcome.exitCode, 1);
  assert.ok(report.includes(`## Execution notes\n\n- ${warning}.`), report);
  assert.doesNotMatch(report, /## Run issues/);
});

test('the plan and report digests match for the same checks, and the line names the adapters it covers', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  await mkdir(join(ticketDir(root), 'api'));
  const digestOf = text => text.match(/^Proof inputs digest: `sha256:([a-f0-9]{64})` \(adapters: ([a-z, ]+);/m)?.slice(1);
  // An empty api/ is not hashed, so a plan without --only and a run with --only bdd cover the same checks.
  const [planned, plannedAdapters] = digestOf((await execute(root, {}, [ticket, '--plan'])).plan);
  assert.equal(plannedAdapters, 'bdd');
  const outcome = await execute(root, fakes(), [ticket, '--only', 'bdd']);
  assert.deepEqual(digestOf(await readFile(outcome.reportPath, 'utf8')), [planned, 'bdd']);
  // Checks in api/ make it a different set of inputs, and the label says which.
  await adapter(root, 'api');
  const [both, bothAdapters] = digestOf((await execute(root, {}, [ticket, '--plan'])).plan);
  assert.equal(bothAdapters, 'bdd, api');
  assert.notEqual(both, planned);
  assert.deepEqual(digestOf((await execute(root, {}, [ticket, '--plan', '--only', 'bdd'])).plan), [planned, 'bdd']);
});

test('capture, start, env validation, and cleanup errors surface separately without leaked exception text', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  for (const stage of ['capture', 'start', 'env', 'close']) {
    const deps = fakes();
    const start = deps.startSandbox;
    const capture = deps.captureDataset;
    const fail = () => { throw new Error('RAW-INFRA-SECRET'); };
    deps.captureDataset = stage === 'capture' ? fail : capture;
    deps.startSandbox = async input => {
      if (stage === 'start') return fail();
      const side = await start(input);
      if (stage === 'env') side.env = {};
      if (stage === 'close') side.close = async () => {
        deps.events.push('attempted-close-run');
        await mkdir(join(input.dir, 'runtime-fake'));
        fail();
      };
      return side;
    };
    const outcome = await execute(root, deps);
    assert.equal(outcome.exitCode, 1, stage);
    const report = await readFile(outcome.reportPath, 'utf8');
    assert.doesNotMatch(report, /RAW-INFRA-SECRET/, stage);
    assert.match(report, /^\| AC1 .*Blocked/m, stage);
    if (stage === 'capture') {
      assert.deepEqual(deps.events, []);
      assert.match(report, /No adapter ran/);
      assert.match(report, /failed during dataset capture/i);
    } else {
      if (stage === 'start') assert.match(report, /failed during sandbox startup/i);
      if (stage === 'env') {
        assert.match(report, /failed during sandbox environment validation/i);
        assert.ok(deps.events.includes('close-run'));
      }
      if (stage === 'close') {
        assert.ok(deps.events.includes('attempted-close-run'));
        assert.match(report, /Sandbox cleanup incomplete; check runtime ID proof-[0-9a-f-]{36}-run and private setup at \.private\/run\/sandbox/);
        const privateDir = join(outcome.reportPath, '..', '.private');
        assert.deepEqual(await readdir(privateDir), ['run']);
        assert.deepEqual(await readdir(join(privateDir, 'run')), ['sandbox']);
        assert.deepEqual(await readdir(join(privateDir, 'run', 'sandbox')), ['runtime-fake']);
      }
    }
  }
});

test('concurrent runs share neither run directories nor sandbox IDs, and cancellation closes the sandbox', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  const a = fakes();
  const b = fakes();
  const [first, second] = await Promise.all([execute(root, a), execute(root, b)]);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.notEqual(first.reportPath, second.reportPath);
  const sandboxes = [...a.calls, ...b.calls];
  assert.equal(new Set(sandboxes.map(sandbox => sandbox.id)).size, 2);
  assert.equal(new Set(sandboxes.map(sandbox => sandbox.dir)).size, 2);

  const deps = fakes();
  const controller = new AbortController();
  deps.invoke = async ({ signal }) => {
    assert.equal(signal.aborted, false);
    controller.abort();
    assert.equal(signal.aborted, true);
    return 0;
  };
  const canceled = await execute(root, { ...deps, signal: controller.signal });
  assert.equal(canceled.exitCode, 1);
  assert.deepEqual(deps.events, ['capture', 'start-run', 'close-run']);
  const report = await readFile(canceled.reportPath, 'utf8');
  assert.match(report, /^\| AC1 .*Blocked/m);
  assert.match(report, /Run canceled\./);
});

test('real child invocation accepts only the absolute ticket-dir argument and suppresses raw output', async t => {
  const { root } = await workspace(t);
  const dir = await adapter(root);
  await mkdir(join(dir, 'steps'));
  await writeFile(join(dir, 'steps', 'check.mjs'), 'export { observation } from "../../fixtures.mjs";\n');
  const harness = await fixtureRunner(t, `
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const ticketDir = join(process.env.PROOF_RUN_DIR, 'proofs', 'bdd', process.env.PROOF_TICKET);
    if (process.argv.length !== 3 || process.argv[2] !== ticketDir || process.env.INSIDE_TEST_SECRET) process.exit(2);
    const { observation } = await import(pathToFileURL(join(ticketDir, 'steps', 'check.mjs')));
    if (observation !== 'shared fixture loaded') process.exit(2);
    console.log('RAW-CHILD-SECRET');
    console.error('RAW-CHILD-SECRET');
    await writeFile(process.env.PROOF_RESULTS, JSON.stringify({ ac: 'AC1', status: 'pass', observed: process.env.PROOF_PASSWORD + ' accepted' }) + '\\n');
  `);
  const decoy = join(root, 'proofs', 'bdd');
  await mkdir(decoy, { recursive: true });
  await writeFile(join(decoy, 'run.mjs'), 'process.exit(2);');
  await writeFile(join(root, 'runtime.mjs'), `
    export async function startSandbox({id, dir, workspace, commits, options, signal, dataset}) {
      if (!id.startsWith('proof-') || !id.endsWith('-run') || !dir.startsWith(workspace + '/.proofs-out/') ||
          !commits.web_ui || Object.keys(options).length || signal.aborted || dataset !== undefined) throw new Error('invalid contract');
      return {env: ${JSON.stringify(sandboxEnv())}, close() {}};
    }
  `);
  const output = execFileSync(process.execPath, [harness, ticket, '--workspace', root, '--runtime', 'runtime.mjs', '--worktree', 'web_ui=web_ui'], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, INSIDE_TEST_SECRET: 'ambient' },
  });
  const report = await readFile(output.trim().slice('Report: '.length), 'utf8');
  assert.doesNotMatch(report, /RAW-CHILD-SECRET|fake-fixture-password/);
  assert.match(report, /^\| AC1 .*Pass/m);
});

test('a timed-out adapter cannot publish evidence; cleanup still runs', { timeout: 5000 }, async t => {
  const { root } = await workspace(t);
  await adapter(root);
  const harness = await fixtureRunner(t, `
    import { writeFile } from 'node:fs/promises';
    await writeFile(process.env.PROOF_RESULTS, JSON.stringify({ ac: 'AC1', status: 'pass', observed: 'UNTRUSTED-PARTIAL-EVIDENCE' }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const { run: copiedRun } = await import(new URL(`file://${harness}`));
  const { invoke: _fake, ...deps } = fakes();
  const outcome = await copiedRun([ticket, '--runtime', 'runtime.mjs', '--worktree', 'web_ui=web_ui'], { ...deps, workspace: root, adapterTimeoutMs: 750 });
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(deps.events, ['capture', 'start-run', 'close-run']);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /^\| AC1 .*Blocked/m);
  assert.match(report, /bdd adapter timed out after 0\.75 seconds/);
  assert.doesNotMatch(report, /UNTRUSTED-PARTIAL-EVIDENCE/);
});

test('--post-merge no longer exists and a run without a target is rejected', async t => {
  const { root } = await workspace(t);
  const plan = args => run([ticket, ...args, '--plan'], { workspace: root, parentEnv: {} });
  await assert.rejects(plan(['--post-merge', ...feature, '--runtime', 'runtime.mjs']), /Usage/);
  await assert.rejects(plan(['--post-merge', '--url', 'https://x.test']), /Usage/);
  await assert.rejects(plan([]), /Give a target: --url <origin>, --worktree <dir> or --target <profile>/);
  await assert.rejects(plan(['--runtime', 'runtime.mjs']), /Give a target/);
  await assert.rejects(execute(root, fakes(), [ticket, '--post-merge']), /Usage/);
  await assert.rejects(run([ticket], { workspace: root, parentEnv: {}, startSandbox: async () => assert.fail('nothing starts without a target') }), /Give a target/);
});

test('rejects a non-loopback runtime origin in local mode and closes without invoking an adapter', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  const deps = fakes();
  const start = deps.startSandbox;
  deps.startSandbox = async input => {
    const side = await start(input);
    side.env.PROOF_API_URL = 'https://live.example.invalid';
    return side;
  };
  const outcome = await execute(root, deps);
  assert.equal(outcome.exitCode, 1);
  assert.ok(deps.events.includes('close-run'));
  assert.ok(!deps.events.includes('bdd-run'));
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /No adapter ran/);
  assert.doesNotMatch(report, /live\.example\.invalid/);
});

test('rejects origin-shaped URLs with paths or credentials and invalid header/context scopes', async t => {
  const { root } = await workspace(t);
  await adapter(root, 'api');
  for (const invalid of [
    { PROOF_CUSTOM_ORIGIN_URL: 'http://user:secret@localhost' },
    { PROOF_CUSTOM_ORIGIN_URL: 'http://localhost/../' },
    { PROOF_CUSTOM_ORIGIN_URL: 'http://localhost?' },
    { PROOF_CUSTOM_ORIGIN_URL: 'http://other-localhost' },
    { PROOF_API_HEADERS: JSON.stringify({ PROOF_WRONG_URL: { Authorization: 'Bearer secret' } }) },
    { PROOF_API_HEADERS: JSON.stringify({ PROOF_CUSTOM_ORIGIN_URL: { Host: 'wrong-host' } }) },
    { PROOF_API_HEADERS: JSON.stringify({ PROOF_CUSTOM_ORIGIN_URL: { Cookie: 'synthetic=secret\r\nX-Header: value' } }) },
    { PROOF_CONTEXT_REALM: 'first\nsecond' },
  ]) {
    const deps = fakes();
    const start = deps.startSandbox;
    deps.startSandbox = async input => {
      const { env, close } = await start(input);
      return { env: { ...env, ...invalid }, close };
    };
    const outcome = await execute(root, deps);
    assert.equal(outcome.exitCode, 1);
    assert.ok(deps.events.includes('close-run'));
    assert.ok(!deps.events.includes('api-run'));
    const report = await readFile(outcome.reportPath, 'utf8');
    assert.match(report, /sandbox environment validation/);
    assert.doesNotMatch(report, /secret|wrong-host|other-localhost/);
  }
});

test('--url checks a running environment: no runtime, no pins, bad flags rejected', async t => {
  const { root } = await workspace(t);
  const plan = await run([ticket, '--url', 'legacy=https://trips.example.test', '--context', 'tenant=acme', '--branch', 'feature/x', '--plan'], { workspace: root, parentEnv: {} });
  assert.match(plan.plan, /Mode: running environment/);
  assert.match(plan.plan, /`legacy`: `https:\/\/trips\.example\.test`/);
  assert.match(plan.plan, /Branch label: `feature\/x` \(stated by the operator, not verified\)/);
  assert.match(plan.plan, /Runtime: none \(running environment\)/);
  assert.match(plan.plan, /No sandbox is started/);
  assert.ok(!(await readdir(root)).includes('.proofs-out'));
  const reject = (args, pattern) => assert.rejects(run([ticket, ...args, '--plan'], { workspace: root, parentEnv: {} }), pattern);
  await reject(['--url', 'ftp://trips.example.test'], /Invalid origin/);
  await reject(['--url', 'https://trips.example.test/admin'], /Invalid origin/);
  await reject(['--url', 'https://user:pw@trips.example.test'], /Invalid origin/);
  await reject(['--url', 'a=https://x.test', '--url', 'a=https://y.test'], /once/);
  await reject(['--url', 'bad name=https://x.test'], /names must be/);
  await reject(['--url', 'https://x.test', '--runtime', 'runtime.mjs'], /do not combine/);
  await reject([...feature, '--context', 'tenant=acme'], /only with --url/);
  await reject([...feature, '--branch', 'x'], /only with --url/);
  await reject([...feature, '--insecure-tls'], /only with --url/);
});

test('--url runs the checks once against the named origins and passes the operator login through', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  const calls = [];
  const parentEnv = { PATH: process.env.PATH, PROOF_USERNAME: 'fake-operator-user', PROOF_PASSWORD: 'fake-operator-pass', NODE_EXTRA_CA_CERTS: '/etc/ssl/fake-ca.pem', OTHER_SECRET: 'withheld' };
  const outcome = await run([ticket, '--url', 'legacy=https://trips.example.test:8443', '--context', 'tenant=acme', '--branch', 'feature/x', '--insecure-tls'], {
    workspace: root, parentEnv,
    invoke: async ({ name, env }) => {
      calls.push({ name, env });
      await writeResults(env.PROOF_RESULTS, [result('pass', 'the check passed against the environment')]);
      return 0;
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(calls.length, 1, 'one run only');
  const { env } = calls[0];
  assert.equal(env.PROOF_SIDE, 'run');
  assert.equal(env.PROOF_LEGACY_URL, 'https://trips.example.test:8443');
  assert.equal(env.PROOF_CONTEXT_TENANT, 'acme');
  assert.equal(env.PROOF_TARGET, '1');
  assert.equal(env.PROOF_INSECURE_TLS, '1');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/fake-ca.pem');
  assert.deepEqual([env.PROOF_USERNAME, env.PROOF_PASSWORD], ['fake-operator-user', 'fake-operator-pass'], 'the BDD adapter gets the operator login');
  assert.equal(env.OTHER_SECRET, undefined);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /Mode: running environment/);
  assert.match(report, /## Target/);
  assert.match(report, /^\| AC \| Result \|$/m);
  assert.match(report, /^\| AC1 .*Pass — bdd: pass/m);
  assert.doesNotMatch(report, /fake-operator-pass|Before|After/);
});

test('--url without --insecure-tls verifies TLS and does not forward the flag', async t => {
  const { root } = await workspace(t);
  await adapter(root, 'api');
  let seen;
  await run([ticket, '--url', 'https://trips.example.test'], {
    workspace: root, parentEnv: { PATH: process.env.PATH },
    invoke: async ({ env }) => { seen = env; await writeResults(env.PROOF_RESULTS, [result()]); return 0; },
  });
  assert.equal(seen.PROOF_APP_URL, 'https://trips.example.test');
  assert.equal(seen.PROOF_INSECURE_TLS, undefined);
  assert.equal(seen.NODE_EXTRA_CA_CERTS, undefined);
});

const SERVER = `node -e "require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')"`;
const builtIn = (manifest, services) => { manifest.runtimeOptions = { services }; };

test('a built-in runtime startup failure names the service, step and exit code in the report', async t => {
  const { root, manifest, save } = await workspace(t);
  builtIn(manifest, { app: { app: names[0], setup: ['true', 'exit 3'], start: 'node nothing.js' } });
  await save();
  await adapter(root);
  const outcome = await run([ticket, '--worktree', names[0]], { workspace: root, parentEnv: { PATH: process.env.PATH }, invoke: async () => assert.fail('no adapter runs when startup fails') });
  assert.equal(outcome.exitCode, 1);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /^- Failed during sandbox startup: app: setup command 2 failed \(exited with code 3\)\./m);
  assert.doesNotMatch(report, /nothing\.js|node -e/, 'command text is never shown');
});

test('--check starts the sandbox without running adapters and leaves no report', async t => {
  const { root, manifest, save } = await workspace(t);
  builtIn(manifest, { app: { app: names[0], start: SERVER } });
  await save();
  await adapter(root);
  const noAdapters = { workspace: root, parentEnv: { PATH: process.env.PATH }, invoke: async () => assert.fail('--check must not run adapters') };
  const ready = await run([ticket, '--check', '--worktree', names[0]], noAdapters);
  assert.equal(ready.exitCode, 0);
  assert.equal(ready.check, 'ready');
  assert.deepEqual(await readdir(join(root, '.proofs-out', ticket)), [], 'the check run directory is removed');

  builtIn(manifest, { app: { app: names[0], start: 'exit 5' } });
  await save();
  const broken = await run([ticket, '--check', '--worktree', names[0]], noAdapters);
  assert.equal(broken.exitCode, 1);
  assert.match(broken.check, /^NOT READY — Failed during sandbox startup: app: start failed \(exited with code 5 before it became ready\)\./);
});

test('--check --url probes each origin and --only limits the adapters that run', async t => {
  const { root } = await workspace(t);
  await adapter(root, 'bdd');
  await adapter(root, 'api');
  const server = createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const up = `http://127.0.0.1:${server.address().port}`;
  const check = url => run([ticket, '--check', '--url', `legacy=${url}`], { workspace: root, parentEnv: { PATH: process.env.PATH }, invoke: async () => assert.fail('no adapters') });
  assert.deepEqual(await check(up), { exitCode: 0, check: 'ready' });
  const down = await check('http://127.0.0.1:1');
  assert.equal(down.exitCode, 1);
  assert.equal(down.check, 'NOT READY — legacy is not reachable (DNS, connection or TLS).');

  const ran = [];
  await run([ticket, '--url', up, '--only', 'api'], {
    workspace: root, parentEnv: { PATH: process.env.PATH },
    invoke: async ({ name, env }) => { ran.push(name); await writeResults(env.PROOF_RESULTS, [result()]); return 0; },
  });
  assert.deepEqual(ran, ['api']);
  await assert.rejects(run([ticket, '--url', up, '--only', 'sql', '--plan'], { workspace: root, parentEnv: {} }), /Usage/);
  await assert.rejects(run([ticket, '--url', up, '--only', 'api', '--only', 'api', '--plan'], { workspace: root, parentEnv: {} }), /Usage/);
});

test('manifest login names env variables; the workspace .env fills gaps and the real environment wins', async t => {
  const { root, manifest, save } = await workspace(t);
  manifest.login = { usernameEnv: 'FAKE_APP_USER', passwordEnv: 'FAKE_APP_PASS' };
  await save();
  await adapter(root);
  await writeFile(join(root, '.env'), '# comment\nFAKE_APP_USER=file-user\nexport FAKE_APP_PASS="file pass $NOT_EXPANDED"\nUNRELATED=ignored\n');
  const seen = [];
  const invoke = async ({ env }) => { seen.push(env); await writeResults(env.PROOF_RESULTS, [result()]); return 0; };
  const go = parentEnv => run([ticket, '--url', 'https://trips.example.test'], { workspace: root, parentEnv: { PATH: process.env.PATH, ...parentEnv }, invoke });

  await go({});
  assert.deepEqual([seen[0].PROOF_USERNAME, seen[0].PROOF_PASSWORD], ['file-user', 'file pass $NOT_EXPANDED'], 'read from .env without shell expansion');
  assert.equal(seen[0].UNRELATED, undefined);

  await go({ FAKE_APP_USER: 'env-user' });
  assert.deepEqual([seen[1].PROOF_USERNAME, seen[1].PROOF_PASSWORD], ['env-user', 'file pass $NOT_EXPANDED'], 'the real environment overrides the file');

  await rm(join(root, '.env'));
  await go({});
  assert.equal(seen[2].PROOF_USERNAME, undefined, 'no login values means no login is passed');

  manifest.login = { usernameEnv: 'literal-secret value', passwordEnv: 'FAKE_APP_PASS' };
  await save();
  await assert.rejects(go({}), /names of environment variables, never their values/);
});

test('--worktree tests one checkout\'s committed HEAD, reports clean or dirty, and ignores manifest apps', async t => {
  const { root, manifest, save } = await workspace(t);
  const { worktree, sha } = await changed(root);
  // A leftover `apps` block from the old two-sided format is ignored, never validated.
  manifest.apps = { web_ui: { repo: 'gone', before: 'x', after: 'y', mergedRef: 'refs/heads/none' } };
  await save();
  const plan = args => run([ticket, '--runtime', 'runtime.mjs', '--plan', ...args], { workspace: root, parentEnv: {} });

  const clean = await plan(['--worktree', 'web_ui=candidate']);
  assert.match(clean.plan, /Mode: local checkout/);
  assert.match(clean.plan, new RegExp(`- \`web_ui\`: \`${sha}\` \\(clean checkout\\)`));
  assert.match(clean.plan, /one sandbox for the checkout/);

  await writeFile(join(worktree, 'tracked.txt'), 'a');
  git(worktree, 'add', 'tracked.txt');
  git(worktree, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'tracked');
  await writeFile(join(worktree, 'tracked.txt'), 'edited');
  const dirty = await plan(['--worktree', 'web_ui=candidate']);
  assert.match(dirty.plan, /`web_ui`: `[0-9a-f]{40}` \(checkout has uncommitted changes that were not tested\)/);
  assert.ok(!dirty.plan.includes(sha), 'the pin is the checkout\'s current HEAD');

  // The base is just another directory: the primary checkout works the same way.
  assert.match((await plan(['--worktree', `web_ui=${join(root, 'web_ui')}`])).plan, /`web_ui`: `[0-9a-f]{40}` \(clean checkout\)/);

  await assert.rejects(plan(['--worktree', 'candidate']), /Name the app/);
  await assert.rejects(plan(['--worktree', 'web_ui=candidate', '--worktree', 'web_ui=web_ui']), /one --worktree/);
  await assert.rejects(plan(['--worktree', 'web_ui=missing']), /worktree must be an existing directory/);
  await mkdir(join(root, 'plain'));
  await assert.rejects(plan(['--worktree', 'web_ui=plain']), /not a Git checkout root/);
  await assert.rejects(run([ticket, '--plan', '--worktree', 'web_ui=candidate', '--url', 'https://x.test'], { workspace: root, parentEnv: {} }), /either --url or --worktree/);
});

test('--worktree names the app on its own when the manifest has one service, and starts a single sandbox', async t => {
  const { root, manifest, save } = await workspace(t);
  const { sha } = await changed(root);
  manifest.runtimeOptions = { services: { app: { app: 'web_ui', start: 'node server.js' } } };
  await save();
  await adapter(root);
  const starts = [];
  const outcome = await run([ticket, '--worktree', 'candidate'], {
    workspace: root, parentEnv: { PATH: process.env.PATH },
    startSandbox: async input => { starts.push(input); return { env: { PROOF_APP_URL: 'http://127.0.0.1:3999' }, close: async () => {} }; },
    invoke: async ({ env }) => { await writeResults(env.PROOF_RESULTS, [result()]); return 0; },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(starts.length, 1, 'one sandbox only');
  assert.match(starts[0].id, /-run$/);
  assert.deepEqual(Object.keys(starts[0].commits), ['web_ui']);
  assert.equal(starts[0].commits.web_ui.sha, sha);
  assert.equal(starts[0].commits.web_ui.repo, join(root, 'candidate'));
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /Mode: local checkout/);
  assert.match(report, /^\| AC1 .*Pass — bdd: pass/m);
});

test('the same checks run against a base checkout and a feature checkout with the same digest and different revisions', async t => {
  const { root, save } = await workspace(t);
  const { sha } = await changed(root);
  await save();
  await adapter(root);
  const getDigest = text => text.match(/^Proof inputs digest: `sha256:([a-f0-9]{64})`/m)?.[1];
  const reports = [];
  for (const dir of ['web_ui', 'candidate']) {
    const deps = fakes();
    const outcome = await execute(root, deps, [ticket, '--worktree', `web_ui=${dir}`]);
    assert.equal(outcome.exitCode, 0);
    assert.equal(deps.calls[0].commits.web_ui.repo, join(root, dir));
    reports.push(await readFile(outcome.reportPath, 'utf8'));
  }
  assert.equal(getDigest(reports[0]), getDigest(reports[1]));
  assert.ok(!reports[0].includes(sha));
  assert.ok(reports[1].includes(sha));
});

test('--login names two env variables, overrides the manifest, and rejects values', async t => {
  const { root, manifest, save } = await workspace(t);
  manifest.login = { usernameEnv: 'MANIFEST_USER', passwordEnv: 'MANIFEST_PASS' };
  await save();
  await adapter(root);
  const seen = [];
  const invoke = async ({ env }) => { seen.push(env); await writeResults(env.PROOF_RESULTS, [result()]); return 0; };
  const parentEnv = { PATH: process.env.PATH, MANIFEST_USER: 'm-user', MANIFEST_PASS: 'm-pass', FLAG_USER: 'f-user', FLAG_PASS: 'f-pass' };
  await run([ticket, '--url', 'https://trips.example.test'], { workspace: root, parentEnv, invoke });
  assert.deepEqual([seen[0].PROOF_USERNAME, seen[0].PROOF_PASSWORD], ['m-user', 'm-pass']);
  await run([ticket, '--url', 'https://trips.example.test', '--login', 'FLAG_USER,FLAG_PASS'], { workspace: root, parentEnv, invoke });
  assert.deepEqual([seen[1].PROOF_USERNAME, seen[1].PROOF_PASSWORD], ['f-user', 'f-pass'], 'the flag wins over the manifest');
  manifest.login = { usernameEnv: 'MANIFEST_USER' };
  await save();
  await assert.rejects(run([ticket, '--url', 'https://x.test', '--plan'], { workspace: root, parentEnv }), /names of environment variables/, 'a manifest login missing passwordEnv');
  for (const bad of ['onlyone', 'a,b,c', 'has space,B', 'real-password-value,B']) {
    await assert.rejects(run([ticket, '--url', 'https://x.test', '--login', bad, '--plan'], { workspace: root, parentEnv }), /environment variable names/, bad);
  }
});

test('a ticket in the harness\'s own .proofs/ is found first, and its report goes to the harness\'s .proofs-out/', async t => {
  const harness = fileURLToPath(new URL('..', import.meta.url));
  const id = `HLOCAL-${process.pid}`;
  const inputs = join(harness, '.proofs', id);
  const outputs = join(harness, '.proofs-out', id);
  const index = join(harness, '.proofs-out', 'runs.json');
  const dashboard = join(harness, '.proofs-out', 'dashboard.html');
  const forgetRuns = async () => {
    const runs = JSON.parse(await readFile(index, 'utf8').catch(() => '{}'));
    delete runs[id];
    if (Object.keys(runs).length) {
      await writeFile(index, JSON.stringify(runs, null, 2));
      await writeDashboard(join(harness, '.proofs-out')).catch(() => {});
    } else {
      await rm(index, { force: true });
      await rm(dashboard, { force: true });
    }
  };
  t.after(() => Promise.all([rm(inputs, { recursive: true, force: true }), rm(outputs, { recursive: true, force: true }), forgetRuns()]));
  await mkdir(join(inputs, 'api'), { recursive: true });
  await writeFile(join(inputs, 'api', 'placeholder.check'), 'placeholder check');
  await writeFile(join(inputs, 'manifest.json'), JSON.stringify({ acs: [{ id: 'AC1', claim: 'harness-local claim' }] }));

  // A workspace with no .proofs/ of its own: only the harness copy can satisfy the lookup.
  const empty = await mkdtemp(join(tmpdir(), 'proof-empty-ws-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const outcome = await run([id, '--url', 'https://trips.example.test'], {
    workspace: empty, parentEnv: { PATH: process.env.PATH },
    invoke: async ({ env }) => { await writeResults(env.PROOF_RESULTS, [result()]); return 0; },
  });
  assert.equal(outcome.exitCode, 0);
  assert.ok(outcome.reportPath.startsWith(join(harness, '.proofs-out', id)), 'the report sits beside the harness inputs');
  assert.deepEqual(await readdir(empty), [], 'nothing is written into the workspace');

  // When the workspace has the same ticket too, the harness copy wins.
  const both = await mkdtemp(join(tmpdir(), 'proof-both-ws-'));
  t.after(() => rm(both, { recursive: true, force: true }));
  await mkdir(join(both, '.proofs', id, 'api'), { recursive: true });
  await writeFile(join(both, '.proofs', id, 'api', 'placeholder.check'), 'placeholder check');
  await writeFile(join(both, '.proofs', id, 'manifest.json'), JSON.stringify({ acs: [{ id: 'AC1', claim: 'workspace claim' }] }));
  const preferred = await run([id, '--url', 'https://trips.example.test'], {
    workspace: both, parentEnv: { PATH: process.env.PATH },
    invoke: async ({ env }) => { await writeResults(env.PROOF_RESULTS, [result()]); return 0; },
  });
  const report = await readFile(preferred.reportPath, 'utf8');
  assert.match(report, /harness-local claim/);
  assert.doesNotMatch(report, /workspace claim/);
  await rm(inputs, { recursive: true, force: true });
  await assert.rejects(run([id, '--url', 'https://trips.example.test', '--plan'], { workspace: empty, parentEnv: {} }), /input directory must be an existing directory/);
});

test('recording a run drops index entries older than 30 days and leaves run folders alone', async t => {
  const out = await mkdtemp(join(tmpdir(), 'proof-runs-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-12-01T00:00:00Z');
  const at = days => ({ startedAt: new Date(now - days * DAY).toISOString() });
  await mkdir(join(out, 'T-1', 'old-run'), { recursive: true });
  await writeFile(join(out, 'runs.json'), JSON.stringify({ 'T-1': { old: at(31), recent: at(29) }, 'T-2': { older: at(45) } }));
  await recordRun(out, 'T-3', 'fresh', at(0), now);
  const index = JSON.parse(await readFile(join(out, 'runs.json'), 'utf8'));
  assert.deepEqual(Object.keys(index).sort(), ['T-1', 'T-3']);
  assert.deepEqual(Object.keys(index['T-1']), ['recent']);
  assert.deepEqual(await readdir(join(out, 'T-1')), ['old-run'], 'run folders are not deleted');
  assert.ok(!(await readdir(out)).includes('.runs.lock'));
});

test('prune.mjs lists unindexed run folders, deletes them only with --yes, and spares indexed, young and foreign folders', async t => {
  const out = await mkdtemp(join(tmpdir(), 'proof-prune-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const prune = fileURLToPath(new URL('../prune.mjs', import.meta.url));
  const [kept, orphan, young] = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map(x => `${x}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  for (const [id, when] of [[kept, old], [orphan, old], [young, new Date()]]) {
    await mkdir(join(out, 'T-1', id), { recursive: true });
    await utimes(join(out, 'T-1', id), when, when);
  }
  await mkdir(join(out, 'T-1', 'notes'), { recursive: true });
  await utimes(join(out, 'T-1', 'notes'), old, old);

  assert.throws(() => execFileSync('node', [prune, '--out', out], { stdio: 'pipe' }), /runs\.json/, 'no index, no deletion');
  assert.deepEqual((await readdir(join(out, 'T-1'))).sort(), [kept, orphan, young, 'notes'].sort());

  await writeFile(join(out, 'runs.json'), JSON.stringify({ 'T-1': { [kept]: { startedAt: old.toISOString() } } }));
  assert.deepEqual((await unindexedRunDirs(out)).map(({ id }) => id), [orphan]);
  const dry = execFileSync('node', [prune, '--out', out], { encoding: 'utf8' });
  assert.match(dry, /would delete T-1\/bbbbbbbb/);
  assert.equal((await readdir(join(out, 'T-1'))).length, 4, 'a dry run deletes nothing');

  execFileSync('node', [prune, '--out', out, '--yes']);
  assert.deepEqual((await readdir(join(out, 'T-1'))).sort(), [kept, young, 'notes'].sort());
});

test('--ac filters adapters, skips unselected ACs, records phase timings, and rejects unknown ACs', async t => {
  const { root, manifest, save } = await workspace(t);
  manifest.acs = [{ id: 'AC1', claim: 'First claim' }, { id: 'AC2', claim: 'Second claim' }];
  await save();
  await adapter(root, 'bdd');
  await adapter(root, 'api');
  const seen = [];
  const plan = await run([ticket, '--url', 'https://trips.example.test', '--ac', 'AC1', '--plan'], { workspace: root, parentEnv: {} });
  assert.match(plan.plan, /ACs: 2 \(filtered: AC1\)/);
  await assert.rejects(run([ticket, '--url', 'https://trips.example.test', '--ac', 'AC99', '--plan'], { workspace: root, parentEnv: {} }), /Unknown AC in --ac: AC99/);
  await assert.rejects(run([ticket, '--url', 'https://trips.example.test', '--ac', 'bad/ac', '--plan'], { workspace: root, parentEnv: {} }), /--ac takes comma-separated/);

  const outcome = await run([ticket, '--url', 'https://trips.example.test', '--ac', 'AC1'], {
    workspace: root, parentEnv: { PATH: process.env.PATH },
    invoke: async ({ name, env }) => {
      seen.push({ name, acs: env.PROOF_ACS });
      if (name === 'bdd') await writeResults(env.PROOF_RESULTS, [result('pass', 'one check', 'AC1')]);
      else await writeFile(env.PROOF_RESULTS, '');
      return 0;
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.diagnosticsDir, undefined, 'passing run without --debug leaves no diagnostics');
  assert.deepEqual(seen, [{ name: 'bdd', acs: 'AC1' }, { name: 'api', acs: 'AC1' }]);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /Filtered ACs: `AC1`/);
  assert.match(report, /^Duration: \d+\.\ds \(startup \d+\.\ds, bdd \d+\.\ds, api \d+\.\ds, teardown \d+\.\ds\)$/m);
  assert.match(report, /^\| AC1 — First claim \| Pass — bdd: pass/m);
  assert.match(report, /^\| AC2 — Second claim \| Skipped — filtered out by --ac \|$/m);
  const runs = JSON.parse(await readFile(join(root, '.proofs-out', 'runs.json'), 'utf8'));
  const entry = Object.values(runs[ticket])[0];
  assert.deepEqual(entry.selectedAcs, ['AC1']);
  assert.equal(typeof entry.durationMs, 'number');
  assert.equal(typeof entry.timings?.startupMs, 'number');
  assert.equal(typeof entry.timings?.adapters?.bdd, 'number');
  assert.equal(typeof entry.timings?.teardownMs, 'number');
});

test('private diagnostics retain service.log on startup/--check failure and adapter logs on --debug without leaking into report.md', async t => {
  const { root, manifest, save } = await workspace(t);
  builtIn(manifest, { app: { app: names[0], start: 'echo SECRET_STARTUP_ERR >&2; exit 7' } });
  await save();
  await adapter(root);

  const checkFail = await run([ticket, '--check', '--worktree', names[0]], { workspace: root, parentEnv: { PATH: process.env.PATH } });
  assert.equal(checkFail.exitCode, 1);
  assert.ok(checkFail.diagnosticsDir, '--check failure retains diagnosticsDir');
  const checkLog = await readFile(join(checkFail.diagnosticsDir, 'service.log'), 'utf8');
  assert.match(checkLog, /SECRET_STARTUP_ERR/);
  assert.equal((await stat(join(checkFail.diagnosticsDir, 'service.log'))).mode & 0o777, 0o600);

  const runFail = await run([ticket, '--worktree', names[0]], { workspace: root, parentEnv: { PATH: process.env.PATH } });
  assert.equal(runFail.exitCode, 1);
  assert.ok(runFail.diagnosticsDir);
  assert.match(await readFile(join(runFail.diagnosticsDir, 'service.log'), 'utf8'), /SECRET_STARTUP_ERR/);
  assert.doesNotMatch(await readFile(runFail.reportPath, 'utf8'), /SECRET_STARTUP_ERR/, 'report stays redacted');

  const debugPass = await run([ticket, '--url', 'https://trips.example.test', '--debug'], {
    workspace: root, parentEnv: { PATH: process.env.PATH },
    invoke: async ({ env }) => {
      assert.equal(env.PROOF_DEBUG, '1');
      await writeFile(join(env.PROOF_DIAGNOSTICS_DIR, 'debug.log'), 'debug-trace-line\n');
      await writeResults(env.PROOF_RESULTS, [result()]);
      return 0;
    },
  });
  assert.equal(debugPass.exitCode, 0);
  assert.ok(debugPass.diagnosticsDir);
  assert.match(await readFile(join(debugPass.diagnosticsDir, 'bdd', 'debug.log'), 'utf8'), /debug-trace-line/);
  assert.match(await readFile(debugPass.reportPath, 'utf8'), /--debug/);
});

test('--serve keeps the local sandbox running until aborted and prints iterate command', async t => {
  const { root, manifest, save } = await workspace(t);
  builtIn(manifest, { app: { app: names[0], start: SERVER } });
  await save();
  await adapter(root);
  await assert.rejects(run([ticket, '--serve', '--url', 'http://127.0.0.1:8080'], { workspace: root, parentEnv: {} }), /do not combine it with --url/);
  await assert.rejects(run([ticket, '--serve', '--worktree', names[0], '--check'], { workspace: root, parentEnv: {} }), /do not combine it with --plan, --check, --only or --ac/);

  const controller = new AbortController();
  let observedReady;
  const outcome = await run([ticket, '--serve', '--worktree', names[0]], {
    workspace: root,
    parentEnv: { PATH: process.env.PATH },
    signal: controller.signal,
    onReady: async info => {
      observedReady = info;
      const res = await fetch(info.urls.PROOF_APP_URL);
      assert.equal(res.status, 200);
      controller.abort();
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.served, true);
  assert.match(observedReady.message, /Sandbox ready for ACME-1/);
  assert.match(observedReady.message, /Iterate with: node proofs\/run\.mjs ACME-1 --url app=http:\/\/127\.0\.0\.1:\d+/);
  assert.deepEqual(await readdir(join(root, '.proofs-out', ticket)), [], 'clean --serve exit leaves no leftover run dir');
});

test('cleanup failure re-renders report.md with the issue and sets exitCode to 1', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  const outcome = await run([ticket, '--url', 'https://trips.example.test'], {
    workspace: root,
    parentEnv: { PATH: process.env.PATH },
    invoke: async ({ env }) => { await writeResults(env.PROOF_RESULTS, [result()]); return 0; },
    cleanup: async scratch => { await unlockProofInputs(scratch); throw new Error('EACCES simulated cleanup failure'); },
  });
  assert.equal(outcome.exitCode, 1);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /Private run files could not be removed; check the run directory\./);
  assert.match(report, /Blocked — see run issues below/);
  const runs = JSON.parse(await readFile(join(root, '.proofs-out', 'runs.json'), 'utf8'));
  assert.equal(Object.values(runs[ticket])[0].exitCode, 1);
});

test('CLI --login overrides manifest.runtimeOptions.login in --worktree mode', async t => {
  const { root, manifest, save } = await workspace(t);
  builtIn(manifest, { app: { app: names[0], start: SERVER } });
  manifest.runtimeOptions.login = { usernameEnv: 'MANIFEST_USER', passwordEnv: 'MANIFEST_PASS' };
  await save();
  await adapter(root);
  let seen;
  const outcome = await run([ticket, '--worktree', names[0], '--login', 'CLI_USER,CLI_PASS'], {
    workspace: root,
    parentEnv: { PATH: process.env.PATH, MANIFEST_USER: 'old', MANIFEST_PASS: 'oldp', CLI_USER: 'fresh', CLI_PASS: 'freshp' },
    invoke: async ({ env }) => {
      seen = [env.PROOF_USERNAME, env.PROOF_PASSWORD];
      await writeResults(env.PROOF_RESULTS, [result()]);
      return 0;
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(seen, ['fresh', 'freshp']);
});

test('recordRun automatically recovers a stale .runs.lock left by a killed process', async t => {
  const out = await mkdtemp(join(tmpdir(), 'proof-stale-lock-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const lock = join(out, '.runs.lock');
  await mkdir(lock, { mode: 0o700 });
  const stale = new Date(Date.now() - 60_000);
  await utimes(lock, stale, stale);
  const t0 = Date.now();
  await recordRun(out, 'T-STALE', 'run-1', { startedAt: new Date().toISOString() });
  assert.ok(Date.now() - t0 < 1500, 'stale lock recovered without waiting out retries');
  const index = JSON.parse(await readFile(join(out, 'runs.json'), 'utf8'));
  assert.ok(index['T-STALE']['run-1']);
  assert.ok(!(await readdir(out)).includes('.runs.lock'));
});
