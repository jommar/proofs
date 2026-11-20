// Zero-code demo of the whole workflow, using the acme-1 checks and a tiny inventory app:
//   1. --worktree <base>:    the checks run against the base checkout and the claims fail.
//   2. --worktree <feature>: the same checks run against the feature checkout and pass.
//   3. --url app=<origin>:   the same checks run against an already-running copy of the feature build,
//      served on this machine's network address, the way a dev or UAT environment would be.
//   4. --summary:            the ticket's ledger merges the three runs into one AC x target matrix.
// The built-in runtime starts the checkouts from the manifest alone: no --runtime flag, no custom module.
//   node examples/built-in-demo.mjs
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));
const workspace = await mkdtemp(join(await realpath(tmpdir()), 'proofs-builtin-'));
const base = join(workspace, 'base');
const feature = join(workspace, 'feature');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Proof Demo', '-c', 'user.email=proof@example.test', ...args], { encoding: 'utf8' }).trim();

// Only the item's field name changes between the base and the feature.
const server = field => `import { createServer } from 'node:http';
const item = { ${field}: true };
createServer((req, res) => {
  if (req.url === '/api/item') return res.setHeader('content-type', 'application/json').end(JSON.stringify(item));
  if (req.url === '/') return res.setHeader('content-type', 'text/html').end('<!doctype html><h1>' + (item.available ? 'Available' : 'Unavailable') + '</h1>');
  res.writeHead(404).end();
}).listen(Number(process.env.PORT), process.env.HOST);
`;

async function commit(dir, field) {
  await writeFile(join(dir, 'server.mjs'), server(field));
  git(dir, 'add', 'server.mjs');
  git(dir, 'commit', '-qm', `Use ${field}`);
}

// Runs the harness; a failing run exits nonzero, which is expected for the base checkout.
async function proof(...target) {
  const { stdout } = await promisify(execFile)(process.execPath, [runner, 'ACME-1', '--workspace', workspace, ...target]).catch(error => error);
  const reportPath = stdout?.match(/^Report: (.+)$/m)?.[1];
  assert.ok(reportPath, 'The run did not produce a report');
  const report = await readFile(reportPath, 'utf8');
  const results = Object.fromEntries(['AC1', 'AC2'].map(id => [id, report.split('\n').find(line => line.startsWith(`| ${id} — `)).split('|')[2].trim()]));
  return { report, results };
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer().once('error', reject).listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

try {
  await mkdir(base);
  git(base, 'init', '-q', '-b', 'main');
  await commit(base, 'ready');
  git(base, 'worktree', 'add', '-q', '-b', 'feature', feature);
  await commit(feature, 'available');

  const ticket = join(workspace, '.proofs', 'ACME-1');
  await cp(new URL('./acme-1/', import.meta.url), ticket, { recursive: true });
  await writeFile(join(ticket, 'manifest.json'), JSON.stringify({
    acs: [
      { id: 'AC1', claim: 'A stocked item is labeled Available in the browser.' },
      { id: 'AC2', claim: 'The inventory API returns available as true for a stocked item.' },
    ],
    runtimeOptions: { services: { app: { app: 'inventory', start: 'node server.mjs' } } },
  }, null, 2));

  const onBase = await proof('--worktree', base);
  console.log(onBase.report.trimEnd());
  for (const [id, result] of Object.entries(onBase.results)) assert.ok(result.startsWith('Fail'), `${id} should fail on the base checkout: ${result}`);
  console.log('\nVerified: both ACs fail on the base checkout.');

  const onFeature = await proof('--worktree', feature);
  console.log(`\n${onFeature.report.split('\n').filter(line => /^(Mode|- |\| AC)/.test(line)).join('\n')}`);
  for (const [id, result] of Object.entries(onFeature.results)) assert.ok(result.startsWith('Pass'), `${id} should pass on the feature checkout: ${result}`);
  console.log('\nVerified: both ACs pass on the feature checkout, with the same checks and the built-in runtime.');

  // Serve the feature build ourselves and point the checks at its (non-loopback, when available) address.
  const lan = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  const host = lan ?? '127.0.0.1';
  const port = await freePort();
  const served = spawn(process.execPath, ['server.mjs'], { cwd: feature, env: { PATH: process.env.PATH, PORT: String(port), HOST: '0.0.0.0' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40 && !(await fetch(`http://${host}:${port}/api/item`).then(response => response.ok, () => false)); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const onUrl = await proof('--url', `app=http://${host}:${port}`);
    console.log(`\n${onUrl.report.split('\n').filter(line => /^(Mode|- |\| AC)/.test(line)).join('\n')}`);
    for (const [id, result] of Object.entries(onUrl.results)) assert.ok(result.startsWith('Pass'), `${id} should pass against the running environment: ${result}`);
    console.log(`\nVerified: the same checks pass against a running URL (${lan ? 'non-loopback address' : 'loopback; no network interface found'}).`);
  } finally {
    served.kill('SIGTERM');
  }

  const { stdout: summary } = await promisify(execFile)(process.execPath, [runner, 'ACME-1', '--workspace', workspace, '--summary']);
  console.log(`\n${summary.split('\n').filter(line => line.startsWith('|')).join('\n')}`);
  assert.match(summary, /\| AC1 — .* \| Fail \| Pass \| Pass \| Delivered \|/, 'the summary orders base and feature by Git ancestry');
  console.log('\nVerified: --summary shows the base as Before, the feature as After, and the running URL beside them.');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
