import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './demo-runtime.mjs';

const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));
const runtime = fileURLToPath(new URL('./demo-runtime.mjs', import.meta.url));
const workspace = await mkdtemp(join(await realpath(tmpdir()), 'proofs-acme-'));
const repo = join(workspace, 'inventory');
const ticket = join(workspace, '.proofs', 'ACME-1');
const baseArgs = [runner, 'ACME-1', '--workspace', workspace, '--runtime', runtime];
const acs = [
  { id: 'AC1', claim: 'A stocked item is labeled Available in the browser.' },
  { id: 'AC2', claim: 'The inventory API returns available as true for a stocked item.' },
];

// Only the item's field name changes between the two commits.
function app(field) {
  return `const item = { ${field}: true };

export function handler(req, res) {
  if (req.url === '/api/item') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(item));
  }
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    return res.end('<!doctype html><h1>' + (item.available ? 'Available' : 'Unavailable') + '</h1>');
  }
  res.writeHead(404).end();
}
`;
}

async function commit(field, message) {
  await writeFile(join(repo, 'app.mjs'), app(field));
  git(repo, 'add', '--', 'app.mjs');
  git(repo, '-c', 'user.name=Proof Demo', '-c', 'user.email=proof@example.test', 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

let child;
let killTimer;
let interrupted = false;
function cancel() {
  if (interrupted) return;
  interrupted = true;
  const active = child;
  if (active) {
    active.kill('SIGTERM');
    killTimer = setTimeout(() => active.kill('SIGKILL'), 15_000).unref();
  }
}

async function cli(...flags) {
  assert.ok(!interrupted, 'Demo interrupted');
  const result = await new Promise(resolve => {
    child = execFile(process.execPath, [...baseArgs, ...flags], (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  clearTimeout(killTimer);
  child = undefined;
  assert.ok(!interrupted, 'Demo interrupted');
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function reportDigest(text) {
  const digest = text.match(/^Proof inputs digest: `sha256:([a-f0-9]{64})`/m)?.[1];
  assert.ok(digest, 'Missing proof-input digest');
  return digest;
}

function assertPins(text, shas) {
  const line = text.split('\n').find(line => line.startsWith('- `inventory`:'));
  assert.ok(line, 'Missing inventory revision line');
  assert.deepEqual([...line.matchAll(/`([a-f0-9]{40,64})`/g)].map(([, sha]) => sha), shas);
  if (shas.length === 1) assert.ok(line.includes('Local ref `refs/heads/main`'));
}

const sandboxDirs = new Set();
async function verifyRun(pins, digest, postMerge = false) {
  const { error, stdout } = await cli(...(postMerge ? ['--post-merge'] : []));
  const reportPath = stdout.match(/^Report: (.+)$/m)?.[1];
  assert.ok(reportPath, error?.message ?? 'Missing report path');
  const report = await readFile(reportPath, 'utf8');
  console.log(`${report.trimEnd()}\n`);
  assertPins(report, pins);
  assert.equal(reportDigest(report), digest);
  for (const [id, adapter] of [['AC1', 'bdd'], ['AC2', 'api']]) {
    const row = report.split('\n').find(line => line.startsWith(`| ${id} — `));
    assert.ok(row, `Missing ${id} report row`);
    const [, , before, after] = row.split('|').map(cell => cell.trim());
    assert.ok(before.startsWith(postMerge ? 'Not run — post-merge' : `Fail — ${adapter}: fail`), row);
    assert.ok(after.startsWith(`Pass — ${adapter}: pass`), row);
  }
  assert.ifError(error);

  const events = stdout.split('\n').filter(line => line.startsWith('Demo sandbox: '))
    .map(line => JSON.parse(line.slice('Demo sandbox: '.length)));
  assert.equal(events.length, pins.length * 2);
  for (const sha of pins) {
    const side = events.filter(event => event.sha === sha);
    assert.equal(side.length, 2);
    const [start, close] = side;
    assert.equal(start.event, 'start');
    assert.match(start.origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    assert.ok(relative(dirname(reportPath), start.dir).startsWith(`.private${sep}`));
    assert.ok(!sandboxDirs.has(start.dir), 'A sandbox directory was reused');
    sandboxDirs.add(start.dir);
    assert.deepEqual(close, { ...start, event: 'close' });
    await assert.rejects(lstat(start.dir), { code: 'ENOENT' });
  }
}

process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  await mkdir(repo);
  git(repo, 'init', '-q', '--template=', '-b', 'main');
  const before = await commit('ready', 'Add synthetic inventory');
  git(repo, 'switch', '-q', '-c', 'candidate');
  const after = await commit('available', 'Use the availability field');
  git(repo, 'switch', '-q', 'main');
  const diff = git(repo, 'diff', '--no-ext-diff', before, after, '--', 'app.mjs');
  assert.ok(/^-const item = \{ ready: true \};\n\+const item = \{ available: true \};$/m.test(diff), 'The pinned app diff must fix the availability field');

  await cp(new URL('./acme-1/', import.meta.url), ticket, { recursive: true });
  await writeFile(join(ticket, 'manifest.json'), JSON.stringify({
    acs, apps: { inventory: { repo: 'inventory', before, after, mergedRef: 'refs/heads/main' } },
  }, null, 2));

  const plan = await cli('--plan');
  assert.ifError(plan.error);
  assertPins(plan.stdout, [before, after]);
  const digest = reportDigest(plan.stdout);
  const unmergedPlan = await cli('--post-merge', '--plan');
  assert.ifError(unmergedPlan.error);
  assertPins(unmergedPlan.stdout, [before]);
  assert.equal(reportDigest(unmergedPlan.stdout), digest);
  await assert.rejects(lstat(join(workspace, '.proofs-out')), { code: 'ENOENT' });

  await verifyRun([before, after], digest);
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), before);
  assert.equal(git(repo, 'status', '--porcelain'), '');

  git(repo, 'merge', '-q', '--ff-only', 'candidate');
  await verifyRun([after], digest, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), after);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  console.log('Verified unchanged proof inputs, the pinned Git change, and three private sandboxes started and closed.');
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  await rm(workspace, { recursive: true, force: true });
}
