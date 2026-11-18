import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startSandbox } from '../runtime/command.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
const server = body => `require('node:http').createServer((q, s) => s.end(${JSON.stringify(body)} + (process.env.GREETING || ''))).listen(Number(process.env.PORT), '127.0.0.1');\n`;

// Reports whether setup ran first, plus one forwarded and one withheld variable.
const envServer = `const fs = require('node:fs'); const q = process.env;
require('node:http').createServer((a, s) => s.end([fs.existsSync('ran.txt'), q.PROOFS_TEST_PASSED, q.PROOFS_TEST_SECRET].join(':'))).listen(Number(q.PORT), '127.0.0.1');\n`;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'proofs-cmd-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'app');
  await mkdir(repo);
  git(repo, 'init', '-q');
  const commits = [];
  for (const body of ['v1', 'v2']) {
    await writeFile(join(repo, 'server.js'), server(body));
    await writeFile(join(repo, 'env-server.js'), envServer);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', body);
    commits.push(git(repo, 'rev-parse', 'HEAD'));
  }
  return { root, repo, commits };
}

const body = async url => (await fetch(url)).text();
const live = async url => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);

test('starts each pinned commit on its own port, passes env, and stops on close', async t => {
  const { root, repo, commits } = await fixture(t);
  const options = {
    services: { app: { start: 'node server.js', ready: '/', env: { GREETING: '-{slug}' } } },
    context: { tenant: 'demo' },
  };
  const sides = [];
  for (const [side, sha] of [['before', commits[0]], ['after', commits[1]]]) {
    const dir = join(root, side);
    sides.push(await startSandbox({ id: `proof-x-${side}`, dir, commits: { app: { repo, sha } }, options, signal: new AbortController().signal }));
  }
  const [before, after] = sides;
  assert.notEqual(before.env.PROOF_APP_URL, after.env.PROOF_APP_URL);
  assert.equal(await body(before.env.PROOF_APP_URL), 'v1-proof_x_before');
  assert.equal(await body(after.env.PROOF_APP_URL), 'v2-proof_x_after');
  assert.equal(after.env.PROOF_CONTEXT_TENANT, 'demo');
  await Promise.all(sides.map(side => side.close()));
  assert.equal(await live(before.env.PROOF_APP_URL), false);
  assert.equal(await live(after.env.PROOF_APP_URL), false);
});

test('runs setup before start and teardown on close, and forwards only named variables and the login', async t => {
  const { root, repo, commits } = await fixture(t);
  const marker = join(root, 'torn-down');
  process.env.PROOFS_TEST_USER = 'u';
  process.env.PROOFS_TEST_PASS = 'p';
  process.env.PROOFS_TEST_SECRET = 'leaked';
  process.env.PROOFS_TEST_PASSED = 'ok';
  t.after(() => { for (const key of ['USER', 'PASS', 'SECRET', 'PASSED']) delete process.env[`PROOFS_TEST_${key}`]; });
  const options = {
    passEnv: ['PROOFS_TEST_PASSED'],
    services: { app: { setup: ['echo done > ran.txt'], start: 'node env-server.js' } },
    teardown: [`touch ${marker}`],
    login: { usernameEnv: 'PROOFS_TEST_USER', passwordEnv: 'PROOFS_TEST_PASS' },
  };
  const sandbox = await startSandbox({ id: 'proof-y-after', dir: join(root, 'side'), commits: { app: { repo, sha: commits[1] } }, options, signal: new AbortController().signal });
  assert.equal(await body(sandbox.env.PROOF_APP_URL), 'true:ok:');
  assert.deepEqual([sandbox.env.PROOF_USERNAME, sandbox.env.PROOF_PASSWORD], ['u', 'p']);
  assert.equal(sandbox.env.PROOF_API_HEADERS, undefined);
  assert.equal(existsSync(marker), false);
  await sandbox.close();
  assert.equal(existsSync(marker), true);
});

test('a service that never listens fails the start and leaves nothing running', async t => {
  const { root, repo, commits } = await fixture(t);
  const options = { services: { app: { start: 'sleep 30', readySeconds: 1 } } };
  await assert.rejects(startSandbox({ id: 'proof-z', dir: join(root, 'side'), commits: { app: { repo, sha: commits[0] } }, options, signal: new AbortController().signal }), /app: start failed \(did not answer \/ within 1s\)/);
});

test('a failing setup command and a canceled start both reject', async t => {
  const { root, repo, commits } = await fixture(t);
  const pins = { app: { repo, sha: commits[0] } };
  await assert.rejects(startSandbox({ id: 'proof-s', dir: join(root, 'a'), commits: pins, signal: new AbortController().signal,
    options: { services: { app: { setup: ['exit 3'], start: 'node server.js' } } } }), /app: setup command 1 failed \(exited with code 3\)/);
  const controller = new AbortController();
  controller.abort(new Error('canceled'));
  await assert.rejects(startSandbox({ id: 'proof-c', dir: join(root, 'b'), commits: pins, signal: controller.signal,
    options: { services: { app: { start: 'node server.js' } } } }), /canceled/);
});

test('rejects malformed options and unknown apps before starting anything', async t => {
  const { root, repo, commits } = await fixture(t);
  const pins = { app: { repo, sha: commits[0] } };
  const start = options => startSandbox({ id: 'proof-v', dir: join(root, 'v'), commits: pins, options, signal: new AbortController().signal });
  await assert.rejects(start(undefined), /services/);
  await assert.rejects(start({ services: { 'bad name': { start: 'x' } } }), /Service name/);
  await assert.rejects(start({ services: { app: {} } }), /start command/);
  await assert.rejects(start({ services: { app: { start: 'x', link: ['../etc'] } } }), /relative/);
  await assert.rejects(start({ services: { app: { start: 'x' } }, passEnv: ['bad-name'] }), /variable name/);
  await assert.rejects(start({ services: { other: { start: 'x' } } }), /no app "other"/);
  await assert.rejects(start({ services: { app: { start: 'x' } }, login: { usernameEnv: 'ONLY_USER' } }), /login needs/);
  assert.equal(existsSync(join(root, 'v', 'src')), false);
});

test('link symlinks a path from the primary checkout into the exported tree', async t => {
  const { root, repo, commits } = await fixture(t);
  await mkdir(join(repo, 'node_modules'));
  await writeFile(join(repo, 'node_modules', 'dep.txt'), 'linked');
  const options = { services: { app: { link: ['node_modules'], start: 'node server.js' } } };
  const sandbox = await startSandbox({ id: 'proof-l', dir: join(root, 'side'), commits: { app: { repo, sha: commits[0] } }, options, signal: new AbortController().signal });
  assert.equal(readFileSync(join(root, 'side', 'src', 'app', 'node_modules', 'dep.txt'), 'utf8'), 'linked');
  await sandbox.close();
});
