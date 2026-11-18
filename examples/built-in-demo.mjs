// Zero-code demo of both ways to run a ticket, using the acme-1 checks and a tiny local server:
//   1. Local comparison: the built-in command runtime, configured only by the manifest, starts the Before
//      and After commits itself. No --runtime flag, no custom module.
//   2. Target: the checks run against an already-running URL (--url), here the After commit served on this
//      machine's network address, the same path used for a dev, UAT or other live environment.
//   node examples/built-in-demo.mjs
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));
const workspace = await mkdtemp(join(await realpath(tmpdir()), 'proofs-builtin-'));
const repo = join(workspace, 'inventory');
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Proof Demo', '-c', 'user.email=proof@example.test', ...args], { encoding: 'utf8' }).trim();

// Only the item's field name changes between the two commits.
const server = field => `import { createServer } from 'node:http';
const item = { ${field}: true };
createServer((req, res) => {
  if (req.url === '/api/item') return res.setHeader('content-type', 'application/json').end(JSON.stringify(item));
  if (req.url === '/') return res.setHeader('content-type', 'text/html').end('<!doctype html><h1>' + (item.available ? 'Available' : 'Unavailable') + '</h1>');
  res.writeHead(404).end();
}).listen(Number(process.env.PORT), process.env.HOST);
`;

async function commit(field) {
  await writeFile(join(repo, 'server.mjs'), server(field));
  git('add', 'server.mjs');
  git('commit', '-qm', `Use ${field}`);
  return git('rev-parse', 'HEAD');
}

try {
  await mkdir(repo);
  git('init', '-q', '-b', 'main');
  const before = await commit('ready');
  const after = await commit('available');
  const ticket = join(workspace, '.proofs', 'ACME-1');
  await cp(new URL('./acme-1/', import.meta.url), ticket, { recursive: true });
  await writeFile(join(ticket, 'manifest.json'), JSON.stringify({
    acs: [
      { id: 'AC1', claim: 'A stocked item is labeled Available in the browser.' },
      { id: 'AC2', claim: 'The inventory API returns available as true for a stocked item.' },
    ],
    apps: { inventory: { repo: 'inventory', before, after, mergedRef: 'refs/heads/main' } },
    runtimeOptions: { services: { app: { app: 'inventory', start: 'node server.mjs' } } },
  }, null, 2));

  const { stdout } = await promisify(execFile)(process.execPath, [runner, 'ACME-1', '--workspace', workspace]).catch(error => error);
  const reportPath = stdout?.match(/^Report: (.+)$/m)?.[1];
  assert.ok(reportPath, 'The run did not produce a report');
  const report = await readFile(reportPath, 'utf8');
  console.log(report.trimEnd());
  for (const [id, adapter] of [['AC1', 'bdd'], ['AC2', 'api']]) {
    const [, , beforeCell, afterCell] = report.split('\n').find(line => line.startsWith(`| ${id} — `)).split('|').map(cell => cell.trim());
    assert.ok(beforeCell.startsWith('Fail'), `${id} Before should fail: ${beforeCell}`);
    assert.ok(afterCell.startsWith('Pass'), `${id} After should pass: ${afterCell} (${adapter})`);
  }
  console.log('\nVerified: both ACs fail Before and pass After using only the manifest and the built-in runtime.');

  // Phase 2: serve the After commit ourselves and point the checks at its (non-loopback, when available) address.
  const lan = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  const host = lan ?? '127.0.0.1';
  const servedDir = join(workspace, 'served');
  await mkdir(servedDir);
  await writeFile(join(servedDir, 'server.mjs'), git('show', `${after}:server.mjs`));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const served = spawn(process.execPath, ['server.mjs'], { cwd: servedDir, env: { PATH: process.env.PATH, PORT: String(port), HOST: '0.0.0.0' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40 && !(await fetch(`http://${host}:${port}/api/item`).then(r => r.ok, () => false)); i++) await new Promise(r => setTimeout(r, 100));
    const target = await promisify(execFile)(process.execPath, [runner, 'ACME-1', '--workspace', workspace, '--url', `app=http://${host}:${port}`, '--branch', 'candidate']).catch(error => error);
    const targetReport = await readFile(target.stdout.match(/^Report: (.+)$/m)[1], 'utf8');
    console.log(`\n${targetReport.split('\n').filter(line => /^(Mode|- |\| AC)/.test(line)).join('\n')}`);
    for (const id of ['AC1', 'AC2']) {
      const [, , beforeCell, afterCell] = targetReport.split('\n').find(line => line.startsWith(`| ${id} — `)).split('|').map(cell => cell.trim());
      assert.equal(beforeCell, 'Not run — target verification');
      assert.ok(afterCell.startsWith('Pass'), `${id} should pass against the target: ${afterCell}`);
    }
    console.log(`\nVerified: the same checks pass against a running URL (${lan ? 'non-loopback address' : 'loopback; no network interface found'}).`);
  } finally {
    served.kill('SIGTERM');
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
