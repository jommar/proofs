import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { maskCommand } from '../lib/command.mjs';
import { writeDashboard } from '../lib/dashboard.mjs';
import { ledgerEntry } from '../lib/ledger.mjs';
import { recordRun } from '../lib/runs.mjs';

test('maskCommand keeps the flags and masks paths, context values and URL credentials', () => {
  assert.equal(
    maskCommand(['ACME-1', '--target', 'local', '--worktree', 'app=/home/someone/repo', '--context', 'tenant=acme-co', '--persona', 'driver', '--only', 'bdd']),
    'node proofs/run.mjs ACME-1 --target local --worktree app=<dir> --context tenant=<value> --persona driver --only bdd',
  );
  const inline = maskCommand(['ACME-1', '--context=tenant=x', '--url', 'dev=https://user:pw@host.example/path', '--runtime', '/abs/runtime.mjs', '--workspace', '/w', '--worktree=/only/path']);
  assert.match(inline, /--context=tenant=<value>/);
  assert.match(inline, /--url dev=https:\/\/<redacted>@host\.example\/path/);
  assert.match(inline, /--runtime <file> --workspace <dir> --worktree=<dir>/);
  for (const leaked of ['pw', '/abs', '/only', 'user:']) assert.ok(!inline.includes(leaked), `must not contain ${leaked}`);
});

test('maskCommand quotes odd tokens and refuses input that is not a plain argument list', () => {
  assert.equal(maskCommand(['ACME-1', '--branch', 'has space']), "node proofs/run.mjs ACME-1 --branch 'has space'");
  assert.equal(maskCommand(['ACME-1', '--ac', "it's"]), "node proofs/run.mjs ACME-1 --ac 'it'\\''s'");
  for (const bad of [undefined, 'ACME-1', [], [''], [1], ['x'.repeat(401)], Array(61).fill('a')]) assert.equal(maskCommand(bad), null);
});

test('a ledger entry carries the masked command', () => {
  const input = { profile: { name: 'local' }, persona: 'admin', target: null, worktrees: [], workspace: '/w', source: null, proofDigest: 'abc', selectedAcs: [], debug: false };
  const entry = ledgerEntry(input, 'id1', { startedAt: '2026-11-20T10:00:00.000Z', exitCode: 0, statuses: { AC1: 'pass' }, build: null, args: ['ACME-1', '--target', 'local', '--context', 'tenant=secret-client'] });
  assert.equal(entry.command, 'node proofs/run.mjs ACME-1 --target local --context tenant=<value>');
  assert.equal(ledgerEntry(input, 'id2', { startedAt: 'x', exitCode: 0, statuses: {}, build: null }).command, null);
});

test('the dashboard shows each run\'s masked command and never the tenant or a local path', async t => {
  const out = await mkdtemp(join(tmpdir(), 'proof-cmd-'));
  await chmod(out, 0o700);
  t.after(() => rm(out, { recursive: true, force: true }));
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await recordRun(out, 'CMD-1', id, {
    startedAt: '2026-11-20T10:00:00.000Z', exitCode: 0, type: 'worktree', worktrees: [],
    args: ['CMD-1', '--target', 'local', '--worktree', 'app=/home/someone/repo', '--context', 'tenant=secret-client'],
  });
  await writeDashboard(out);
  const html = await readFile(join(out, 'dashboard.html'), 'utf8');
  const data = JSON.parse(/<script id="proofs-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.runs[0].command, 'node proofs/run.mjs CMD-1 --target local --worktree app=<dir> --context tenant=<value>');
  assert.ok(!html.includes('secret-client'), 'the tenant value must not reach the page');
  assert.ok(!html.includes('/home/someone'), 'a local path must not reach the page');
});
