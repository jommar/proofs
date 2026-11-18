import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { run } from '../run.mjs';

const ticket = 'ACME-1';
const names = ['web_ui', 'service-v2'];
const mergedRefs = ['refs/heads/integration/main', 'refs/heads/release'];
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));
const ticketDir = root => join(root, '.proofs', ticket);

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'proof-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { acs: [{ id: 'AC1', claim: 'Main claim' }], apps: {} };
  for (const [i, app] of names.entries()) {
    const repo = join(root, app);
    await mkdir(repo);
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'before', '--allow-empty');
    const sha = git(repo, 'rev-parse', 'HEAD');
    manifest.apps[app] = { repo: app, before: sha, after: sha, mergedRef: mergedRefs[i] };
  }
  const manifestPath = join(ticketDir(root), 'manifest.json');
  await mkdir(ticketDir(root), { recursive: true });
  await writeFile(join(root, 'runtime.mjs'), 'throw new Error("must not import the runtime fixture");\n');
  const save = () => writeFile(manifestPath, JSON.stringify(manifest));
  await save();
  return { root, manifest, save, manifestPath };
}

async function changed(root, manifest) {
  const repo = join(root, names[0]);
  const worktree = join(root, 'candidate');
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
  git(worktree, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'after', '--allow-empty');
  const sha = git(worktree, 'rev-parse', 'HEAD');
  manifest.apps[names[0]] = { ...manifest.apps[names[0]], before: git(repo, 'rev-parse', 'HEAD'), after: undefined, worktree: 'candidate' };
  return { worktree, sha };
}

async function adapter(root, name = 'bdd') {
  const dir = join(ticketDir(root), name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function fixtureRunner(t, code) {
  const harness = await mkdtemp(join(tmpdir(), 'copied-proof-harness-'));
  t.after(() => rm(harness, { recursive: true, force: true }));
  for (const dir of ['bdd', 'lib']) await mkdir(join(harness, dir));
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

function execute(root, deps = {}, args = [ticket]) {
  return run([...args, '--runtime', 'runtime.mjs'], { workspace: root, ...deps });
}

test('plan is runnable from another cwd, pins commits, and creates no files', async t => {
  const { root, manifest, save } = await workspace(t);
  const { worktree, sha } = await changed(root, manifest);
  await save();
  const output = execFileSync(process.execPath, [runner, ticket, '--workspace', root, '--runtime', 'runtime.mjs', '--plan'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.match(output, new RegExp(sha));
  assert.match(output, new RegExp(names[0]));
  assert.match(output, /300 seconds per adapter invocation/);
  assert.equal(execFileSync(process.execPath, [runner, ticket, '--runtime', join(root, 'runtime.mjs'), '--plan'], { cwd: root, encoding: 'utf8' }), output);
  await assert.rejects(run([ticket, '--plan', '--runtime', 'missing.mjs'], { workspace: root }), /runtime.*existing/i);
  // Without a flag, PROOFS_RUNTIME, or a workspace runtime, the built-in command runtime is used; the plan says so.
  const builtIn = await run([ticket, '--plan'], { workspace: root, parentEnv: {} });
  assert.match(builtIn.plan, /Runtime: built-in command runtime/);
  assert.match(output, /Runtime: runtime\.mjs/);
  // PROOFS_RUNTIME stands in for --runtime; the flag wins when both are given.
  const viaEnv = await run([ticket, '--plan'], { workspace: root, parentEnv: { PROOFS_RUNTIME: join(root, 'runtime.mjs') } });
  assert.equal(viaEnv.plan, output.trimEnd());
  await assert.rejects(
    run([ticket, '--plan', '--runtime', 'missing.mjs'], { workspace: root, parentEnv: { PROOFS_RUNTIME: join(root, 'runtime.mjs') } }),
    /runtime.*existing/i,
  );
  // A workspace's own .proofs-runtime/runtime.mjs is the default when nothing else is chosen.
  await mkdir(join(root, '.proofs-runtime'));
  await copyFile(join(root, 'runtime.mjs'), join(root, '.proofs-runtime', 'runtime.mjs'));
  const viaWorkspace = await run([ticket, '--plan'], { workspace: root, parentEnv: {} });
  assert.match(viaWorkspace.plan, /Runtime: \.proofs-runtime\/runtime\.mjs/);
  assert.ok(!(await readdir(root)).includes('.proofs-out'));
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), sha);
});

test('one capture, before then after, allowlisted env, private CSVs, full pins and tables', async t => {
  const { root, manifest, save } = await workspace(t);
  const { worktree, sha } = await changed(root, manifest);
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
  const { plan } = await execute(root, {}, [ticket, '--plan']);
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
    input.options.profile.name = 'side override';
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
    assert.equal(await readFile(inputFile, 'utf8'), name === 'bdd' ? 'pinned browser check' : 'pinned API check');
    assert.equal((await stat(inputFile)).mode & 0o777, 0o400);
    assert.equal((await stat(stagedDir)).mode & 0o777, 0o500);
    assert.equal(cwd, env.PROOF_RUN_DIR);
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
    if (env.PROOF_SIDE === 'before' && name === 'bdd') {
      await writeFile(join(bddDir, 'features', 'check.feature'), 'changed browser check');
      await writeFile(join(apiDir, 'proof.json'), 'changed API check');
      await writeFile(join(ticketDir(root), 'examples', 'fixture.csv'), 'source changed');
    }
    const fail = name === 'bdd' && env.PROOF_SIDE === 'before';
    await writeResults(env.PROOF_RESULTS, [result(fail ? 'fail' : 'pass', name === 'bdd' ? 'checked | screen' : { matching: 1, visible: true }, name === 'bdd' ? 'AC1' : 'AC2'),
      ...(name === 'api' ? [result('pass', 'fake-api-token and fake-api-cookie', 'AC2')] : [])]);
    return fail ? 1 : 0;
  });
  const runResult = await execute(root, { ...deps, parentEnv: {
    PATH: process.env.PATH, AMBIENT_FAKE_SECRET: 'fake-ambient-secret', NODE_OPTIONS: '--inspect', NODE_EXTRA_CA_CERTS: '/ambient-cert',
  } });
  const report = await readFile(runResult.reportPath, 'utf8');
  assert.equal(runResult.exitCode, 0, report);
  assert.deepEqual(deps.events, ['capture', 'start-before', 'bdd-before', 'api-before', 'close-before', 'start-after', 'bdd-after', 'api-after', 'close-after']);
  assert.equal(deps.calls[0].commits[names[0]].repo, join(root, names[0]));
  assert.deepEqual(deps.calls[1].commits[names[0]], { repo: worktree, sha });
  assert.deepEqual(deps.calls[0].commits[names[1]], deps.calls[1].commits[names[1]]);
  assert.notEqual(deps.calls[0].id, deps.calls[1].id);
  assert.notEqual(deps.calls[0].dir, deps.calls[1].dir);
  assert.equal(getDigest(report), digest);
  assert.notEqual(getDigest((await execute(root, {}, [ticket, '--plan'])).plan), digest);
  for (const app of names) assert.match(report, new RegExp(git(join(root, app), 'rev-parse', 'HEAD')));
  assert.match(report, new RegExp(sha));
  assert.match(report, /^## Revisions$/m);
  assert.match(report, /^\| AC \| Before \| After \|$/m);
  assert.match(report, /^\| AC1 .*Fail.*checked \\\| screen.*Pass/m);
  assert.match(report, /^\| AC2 .*Pass.*Pass/m);
  assert.match(report, /matching=1, visible=true/);
  assert.doesNotMatch(report, /fake-fixture|private-csv-record|fake-ambient-secret|fake-runtime-secret|fake-api/);
  assert.match(report, /redacted local credential/);
  assert.deepEqual(await readdir(join(runResult.reportPath, '..')), ['report.md']);
});

test('proof inputs digest ignores app revisions but detects AC and CSV edits', async t => {
  const { root, manifest, save } = await workspace(t);
  const csv = join(ticketDir(root), 'fixture.csv');
  await writeFile(csv, 'first');
  manifest.csv = ['fixture.csv'];
  await save();
  const digest = async flags => (await execute(root, {}, [ticket, '--plan', ...flags])).plan.match(/^Proof inputs digest: `sha256:([a-f0-9]{64})`/m)?.[1];
  const before = await digest([]);
  assert.ok(before);
  for (const app of names) {
    const repo = join(root, app);
    git(repo, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'merged', '--allow-empty');
    git(repo, 'update-ref', manifest.apps[app].mergedRef, 'HEAD');
  }
  assert.equal(await digest(['--post-merge']), before);
  manifest.acs[0].claim = 'Changed claim';
  await save();
  const changedAC = await digest([]);
  assert.notEqual(changedAC, before);
  await writeFile(csv, 'second');
  assert.notEqual(await digest([]), changedAC);
});

test('rejects invalid manifest, missing/foreign/dirty worktrees, and unsafe or duplicate CSVs before runtime', async t => {
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
  const app = names[0];
  const unchanged = { ...manifest.apps[app] };
  manifest.apps[app].mergedRef = 'refs/remotes/origin/fallback';
  await validate(/mergedRef.*refs\/heads/i);
  manifest.apps[app].mergedRef = 'refs/heads/invalid..ref';
  await validate(/mergedRef.*branch/i);
  manifest.apps[app].mergedRef = unchanged.mergedRef;
  delete manifest.apps[app].after;
  await validate(/after.*required/i);
  manifest.apps[app] = { ...unchanged, worktree: 'missing' };
  await validate(/worktree/i);
  manifest.apps[app].worktree = names[1];
  await validate(/worktree/i);
  const { worktree } = await changed(root, manifest);
  manifest.apps[app].after = unchanged.after;
  await validate(/match.*HEAD/i);
  manifest.apps[app] = { ...unchanged, after: undefined, worktree };
  await writeFile(join(worktree, 'untracked.txt'), 'dirty');
  await validate(/clean/i);
  manifest.apps[app] = unchanged;
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

test('normal checkout accepts explicitly different pins (including an absolute repo path) without using or changing HEAD or dirty files', async t => {
  const { root, manifest, save } = await workspace(t);
  const primary = join(root, names[0]);
  const { sha } = await changed(root, manifest);
  const head = git(primary, 'rev-parse', 'HEAD');
  await writeFile(join(primary, 'not-part-of-proof.txt'), 'dirty');
  manifest.apps[names[0]] = { repo: primary, before: head, after: sha, mergedRef: mergedRefs[0] };
  await save();
  await adapter(root);
  const deps = fakes();
  const outcome = await execute(root, deps);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(deps.calls.map(call => call.commits[names[0]]), [{ repo: primary, sha: head }, { repo: primary, sha }]);
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
  await assert.rejects(run([ticket, '--plan', '--runtime', 'runtime-link.mjs'], { workspace: root }), /runtime.*symlinks/i);
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

test('reports the missing app or invalid root from manifest without requiring sibling applications', async t => {
  const { root, manifest, save } = await workspace(t);
  const app = names[0];
  manifest.apps[app].repo = 'missing';
  await save();
  await assert.rejects(execute(root, {}, [ticket, '--plan']), /web_ui.*repository.*existing/i);
  await mkdir(join(root, app, 'nested'));
  manifest.apps[app].repo = `${app}/nested`;
  await save();
  await assert.rejects(execute(root, {}, [ticket, '--plan']), /web_ui.*checkout root/i);
});

test('invalid, absent, and nonzero-pass results block candidate and do not echo raw values', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  await adapter(root, 'api');
  for (const failure of ['missing', 'malformed', 'unknown AC', 'invalid status', 'invalid observed', 'empty', 'nonzero-pass', 'launch']) {
    const deps = fakes();
    const write = deps.invoke;
    deps.invoke = async args => {
      const { env, name } = args;
      if (env.PROOF_SIDE === 'before' || name === 'api') return write(args);
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
    assert.ok(deps.events.includes('close-after'), failure);
    const report = await readFile(runResult.reportPath, 'utf8');
    assert.match(report, /^\| AC1 .*Pass.*Blocked/m, failure);
    assert.doesNotMatch(report, /RAW-PRIVATE-OUTPUT/, failure);
  }
});

test('missing adapters leave ACs uncovered; candidate fail or blocked cannot exit zero', async t => {
  const { root, manifest, save } = await workspace(t);
  manifest.acs.push({ id: 'AC2', claim: 'No adapter covers this' });
  await save();
  const absent = await execute(root, fakes());
  assert.equal(absent.exitCode, 1);
  assert.match(await readFile(absent.reportPath, 'utf8'), /^\| AC1 .*Uncovered.*Uncovered/m);
  await adapter(root);
  for (const status of ['fail', 'blocked']) {
    const deps = fakes();
    deps.invoke = async ({ env }) => {
      await writeResults(env.PROOF_RESULTS, [result(env.PROOF_SIDE === 'after' ? status : 'pass')]);
      return 0;
    };
    const outcome = await execute(root, deps);
    assert.equal(outcome.exitCode, 1);
    const report = await readFile(outcome.reportPath, 'utf8');
    assert.match(report, new RegExp(`^\\| AC1 .*Pass.*${status}`, 'im'));
    assert.match(report, /^\| AC2 .*Uncovered.*Uncovered/m);
  }
});

test('pre-merge requires baseline coverage and rejects blocked baseline checks despite a passing candidate', async t => {
  const { root, manifest, save } = await workspace(t);
  manifest.acs.push({ id: 'AC2', claim: 'Second check' });
  await save();
  await adapter(root);
  for (const before of ['pass', 'fail', 'blocked', 'uncovered', 'mixed']) {
    const deps = fakes();
    deps.invoke = async ({ env }) => {
      const evidence = [result('pass', 'guard passed', 'AC2')];
      if (env.PROOF_SIDE === 'after') evidence.push(result());
      else if (before === 'mixed') evidence.push(result('fail'), result('blocked', 'prerequisite missing'));
      else if (before !== 'uncovered') evidence.push(result(before));
      await writeResults(env.PROOF_RESULTS, evidence);
      return 0;
    };
    const outcome = await execute(root, deps);
    assert.equal(outcome.exitCode, ['pass', 'fail'].includes(before) ? 0 : 1, before);
    const report = await readFile(outcome.reportPath, 'utf8');
    const beforeText = before === 'mixed' ? 'Fail.*blocked' : before;
    assert.match(report, new RegExp(`^\\| AC1 .*${beforeText}.*\\| Pass`, 'im'), before);
    assert.doesNotMatch(report, /## Run issues/, before);
  }
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
      if (!input.id.endsWith('-before')) return start(input);
      if (stage === 'start') return fail();
      const side = await start(input);
      if (stage === 'env') side.env = {};
      if (stage === 'close') side.close = async () => {
        deps.events.push('attempted-close-before');
        await mkdir(join(input.dir, 'runtime-fake'));
        fail();
      };
      return side;
    };
    const outcome = await execute(root, deps);
    assert.equal(outcome.exitCode, 1, stage);
    const report = await readFile(outcome.reportPath, 'utf8');
    assert.doesNotMatch(report, /RAW-INFRA-SECRET/, stage);
    if (stage === 'capture') {
      assert.deepEqual(deps.events, []);
      assert.match(report, /^\| AC1 .*Blocked.*Blocked/m);
      assert.match(report, /Before: no adapter ran/);
      assert.match(report, /After: no adapter ran/);
      assert.match(report, /failed during dataset capture/i);
    } else {
      assert.ok(deps.events.includes('close-after'), stage);
      assert.match(report, /^\| AC1 .*Blocked.*Pass/m);
      if (stage === 'start') assert.match(report, /failed during sandbox startup/i);
      if (stage === 'env') assert.ok(deps.events.includes('close-before'));
      if (stage === 'close') {
        assert.ok(deps.events.includes('attempted-close-before'));
        const privateDir = join(outcome.reportPath, '..', '.private');
        assert.deepEqual(await readdir(privateDir), ['before']);
        assert.deepEqual(await readdir(join(privateDir, 'before')), ['sandbox']);
        assert.deepEqual(await readdir(join(privateDir, 'before', 'sandbox')), ['runtime-fake']);
      }
    }
  }
});

test('concurrent runs share neither run directories nor sandbox IDs, and cancellation closes the active side', async t => {
  const { root } = await workspace(t);
  await adapter(root);
  const a = fakes();
  const b = fakes();
  const [first, second] = await Promise.all([execute(root, a), execute(root, b)]);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.notEqual(first.reportPath, second.reportPath);
  const sides = [...a.calls, ...b.calls];
  assert.equal(new Set(sides.map(side => side.id)).size, 4);
  assert.equal(new Set(sides.map(side => side.dir)).size, 4);

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
  assert.deepEqual(deps.events, ['capture', 'start-before', 'close-before']);
  assert.match(await readFile(canceled.reportPath, 'utf8'), /^\| AC1 .*Blocked.*Blocked/m);
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
      if (!id.startsWith('proof-') || !dir.startsWith(workspace + '/.proofs-out/') ||
          !commits.web_ui || Object.keys(options).length || signal.aborted || dataset !== undefined) throw new Error('invalid contract');
      return {env: ${JSON.stringify(sandboxEnv())}, close() {}};
    }
  `);
  const output = execFileSync(process.execPath, [harness, ticket, '--workspace', root, '--runtime', 'runtime.mjs'], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, INSIDE_TEST_SECRET: 'ambient' },
  });
  const report = await readFile(output.trim().slice('Report: '.length), 'utf8');
  assert.doesNotMatch(report, /RAW-CHILD-SECRET|fake-fixture-password/);
  assert.match(report, /Pass.*Pass/);
});

test('a timed-out adapter cannot publish evidence; cleanup and the candidate still run', { timeout: 5000 }, async t => {
  const { root } = await workspace(t);
  await adapter(root);
  const harness = await fixtureRunner(t, `
    import { writeFile } from 'node:fs/promises';
    const side = process.env.PROOF_SIDE;
    const observed = side === 'before' ? 'UNTRUSTED-PARTIAL-EVIDENCE' : 'candidate completed';
    await writeFile(process.env.PROOF_RESULTS, JSON.stringify({ ac: 'AC1', status: 'pass', observed }) + '\\n');
    if (side === 'before') setInterval(() => {}, 1000);
  `);
  const { run: copiedRun } = await import(new URL(`file://${harness}`));
  const { invoke: _fake, ...deps } = fakes();
  const outcome = await copiedRun([ticket, '--runtime', 'runtime.mjs'], { ...deps, workspace: root, adapterTimeoutMs: 750 });
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(deps.events, ['capture', 'start-before', 'close-before', 'start-after', 'close-after']);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /^\| AC1 .*Blocked.*Pass.*candidate completed/m);
  assert.match(report, /before: bdd adapter timed out after 0\.75 seconds/);
  assert.doesNotMatch(report, /UNTRUSTED-PARTIAL-EVIDENCE/);
});

test('post-merge pins and runs only the configured local branches independently of old refs and worktrees', async t => {
  const { root, manifest, save } = await workspace(t);
  const { worktree } = await changed(root, manifest);
  const primary = join(root, names[0]);
  git(primary, 'worktree', 'remove', worktree);
  manifest.apps[names[0]] = { repo: names[0], mergedRef: mergedRefs[0], worktree, before: 'gone-baseline', after: { broken: true } };
  manifest.apps[names[1]] = { repo: names[1], mergedRef: mergedRefs[1] };
  await save();
  const merged = {};
  const oldHeads = {};
  for (const app of names) {
    const repo = join(root, app);
    git(repo, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'integration', '--allow-empty');
    merged[app] = git(repo, 'rev-parse', 'HEAD');
    const ref = manifest.apps[app].mergedRef;
    git(repo, 'update-ref', ref, merged[app]);
    git(repo, '-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'not integration', '--allow-empty');
    oldHeads[app] = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', ref.replace('refs/heads/', 'refs/remotes/origin/'), oldHeads[app]);
  }
  await adapter(root);
  const deps = fakes();
  const args = [ticket, '--post-merge'];
  const plan = await execute(root, deps, [...args, '--plan']);
  assert.equal(plan.exitCode, 0);
  assert.match(plan.plan, /post-merge/);
  assert.deepEqual(deps.events, []);
  assert.ok(!(await readdir(root)).includes('.proofs-out'));
  const outcome = await execute(root, deps, args);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(deps.events, ['capture', 'start-after', 'bdd-after', 'close-after']);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /^Mode: post-merge verification/m);
  assert.match(report, /^\| AC \| Before \| After \|$/m);
  assert.match(report, /^\| AC1 .*\| Not run — post-merge verification \| Pass —/m);
  for (const app of names) {
    const repo = join(root, app);
    assert.deepEqual(deps.calls[0].commits[app], { repo, sha: merged[app] });
    assert.ok(report.includes(manifest.apps[app].mergedRef));
    assert.ok(report.includes(merged[app]));
    assert.doesNotMatch(report, new RegExp(oldHeads[app]));
    assert.equal(git(repo, 'rev-parse', 'HEAD'), oldHeads[app]);
  }
  git(primary, 'update-ref', '-d', mergedRefs[0]);
  git(primary, 'tag', 'integration/main', merged[names[0]]);
  await assert.rejects(execute(root, deps, args), /local branch.*no fallback/i);
});

test('rejects a non-loopback runtime origin in both modes and closes without invoking an adapter', async t => {
  const { root, manifest } = await workspace(t);
  await adapter(root);
  for (const app of names) git(join(root, app), 'update-ref', manifest.apps[app].mergedRef, 'HEAD');
  for (const args of [[ticket], [ticket, '--post-merge']]) {
    const deps = fakes();
    const start = deps.startSandbox;
    deps.startSandbox = async input => {
      const side = await start(input);
      side.env.PROOF_API_URL = 'https://live.example.invalid';
      return side;
    };
    const outcome = await execute(root, deps, args);
    assert.equal(outcome.exitCode, 1);
    assert.ok(deps.events.includes('close-after'));
    assert.ok(!deps.events.includes('bdd-after'));
    const report = await readFile(outcome.reportPath, 'utf8');
    assert.match(report, /After: no adapter ran/);
    assert.doesNotMatch(report, /live\.example\.invalid/);
  }
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
    assert.ok(deps.events.includes('close-after'));
    assert.ok(!deps.events.includes('api-after'));
    const report = await readFile(outcome.reportPath, 'utf8');
    assert.match(report, /sandbox environment validation/);
    assert.doesNotMatch(report, /secret|wrong-host|other-localhost/);
  }
});

test('--url checks a running environment: no runtime, no pins, apps optional, bad flags rejected', async t => {
  const { root, manifest, save } = await workspace(t);
  delete manifest.apps;
  await save();
  const plan = await run([ticket, '--url', 'legacy=https://trips.example.test', '--context', 'tenant=acme', '--branch', 'feature/x', '--plan'], { workspace: root, parentEnv: {} });
  assert.match(plan.plan, /Mode: target verification/);
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
  await reject(['--url', 'https://x.test', '--post-merge'], /do not combine/);
  await reject(['--url', 'https://x.test', '--runtime', 'runtime.mjs'], /do not combine/);
  await reject(['--context', 'tenant=acme'], /only with --url/);
  await reject(['--branch', 'x'], /only with --url/);
  await reject(['--insecure-tls'], /only with --url/);
  // A manifest cannot enable target mode, and without --url the loopback rule still applies.
  await assert.rejects(execute(root, { startSandbox: async () => ({ env: { PROOF_APP_URL: 'https://trips.example.test' }, close: async () => {} }), invoke: async () => 0 }), /./);
});

test('--url runs only the After side against the named origins and passes the operator login through', async t => {
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
  assert.equal(calls.length, 1, 'only one side runs');
  const { env } = calls[0];
  assert.equal(env.PROOF_SIDE, 'after');
  assert.equal(env.PROOF_LEGACY_URL, 'https://trips.example.test:8443');
  assert.equal(env.PROOF_CONTEXT_TENANT, 'acme');
  assert.equal(env.PROOF_TARGET, '1');
  assert.equal(env.PROOF_INSECURE_TLS, '1');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/fake-ca.pem');
  assert.deepEqual([env.PROOF_USERNAME, env.PROOF_PASSWORD], ['fake-operator-user', 'fake-operator-pass'], 'the BDD adapter gets the operator login');
  assert.equal(env.OTHER_SECRET, undefined);
  const report = await readFile(outcome.reportPath, 'utf8');
  assert.match(report, /Mode: target verification/);
  assert.match(report, /## Target/);
  assert.match(report, /Not run — target verification \| Pass — bdd: pass/);
  assert.doesNotMatch(report, /fake-operator-pass/);
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
