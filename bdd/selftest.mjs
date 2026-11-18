import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readEvidence } from '../lib/evidence.mjs';
import EvidenceReporter from './reporter.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const fixture = new URL('./fixtures.mjs', import.meta.url).href;

test('navigation and prerequisite blockers override failed observations in the same scenario', () => {
  const reporter = new EvidenceReporter();
  const reasons = ['non_local_navigation', 'missing_fixture'];
  for (const [index, reason] of reasons.entries()) {
    const note = row => ({ type: 'proof-evidence', description: JSON.stringify(row) });
    const failed = note({ status: 'fail', observed: { visible: false } });
    const blocked = note({ status: 'blocked', observed: { reason } });
    reporter.onTestEnd({ id: String(index), tags: [`@AC${index + 1}`] }, {
      status: 'failed', annotations: index === 0 ? [blocked, failed] : [failed, blocked],
    });
  }
  assert.deepEqual(reporter.rows, reasons.map((reason, index) => ({ ac: `AC${index + 1}`, status: 'blocked', observed: { reason } })));
});

test('reporter detects an interrupted run even when another scenario for the same AC passed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proof-bdd-reporter-test-'));
  const internal = join(root, 'evidence.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = process.env.PROOF_BDD_EVIDENCE;
  process.env.PROOF_BDD_EVIDENCE = internal;
  t.after(() => {
    if (old === undefined) delete process.env.PROOF_BDD_EVIDENCE;
    else process.env.PROOF_BDD_EVIDENCE = old;
  });
  const reporter = new EvidenceReporter();
  const cases = [1, 2].map(id => ({ id: String(id), tags: ['@AC1'] }));
  reporter.onBegin({}, { allTests: () => cases });
  reporter.onTestEnd(cases[0], { status: 'passed', annotations: [
    { type: 'proof-evidence', description: JSON.stringify({ status: 'pass', observed: { visible: true } }) },
  ] });
  reporter.onEnd({ status: 'interrupted' });
  assert.deepEqual(JSON.parse(await readFile(internal, 'utf8')), {
    complete: false,
    status: 'interrupted',
    rows: [
      { ac: 'AC1', status: 'pass', observed: { visible: true } },
      { ac: 'AC1', status: 'blocked', observed: { reason: 'scenario_not_run' } },
    ],
  });
});

async function serve(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

test('isolated BDD runs emit only checked facts, block unmet prerequisites and reject redirects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proof-bdd-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyPath = join(root, 'key.pem');
  const certPath = join(root, 'cert.pem');
  await exec('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-x509', '-days', '1',
    '-subj', '/CN=proof-selftest.localhost', '-keyout', keyPath, '-out', certPath]);
  const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };
  let forbiddenRequests = 0;
  const forbiddenPort = await serve(t, createHttpsServer(tls, (_, res) => {
    forbiddenRequests++;
    res.end('unexpected');
  }));
  const port = await serve(t, createHttpsServer(tls, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `https://proof-selftest.localhost:${forbiddenPort}/never` }).end();
    } else if (req.url === '/auth') {
      const login = req.headers.host.startsWith('auth.') && req.headers.authorization === 'Bearer fake-proof-secret';
      if (login) res.setHeader('Set-Cookie', 'proof_session=fake-private-session; Domain=proof-selftest.localhost; Path=/; Secure');
      res.writeHead(login ? 200 : 403).end();
    } else if (req.url === '/actual-502') {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'X-Proof-Proxy-Failure': '1' }).end('App returned an error');
    } else {
      const hasSession = req.headers.cookie === 'proof_session=fake-private-session';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<main>${hasSession ? 'Authenticated' : 'Anonymous'}</main><aside>fake-private-body</aside>`);
    }
  }));
  const origin = `https://proof-selftest.localhost:${port}`;
  const httpPort = await serve(t, createServer((req, res) => {
    if (req.url === '/download') {
      res.writeHead(200, { 'Content-Disposition': 'attachment; filename="fake.txt"' }).end('download');
    } else {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'X-Proof-Proxy-Failure': '1' }).end('App returned an error');
    }
  }));
  const identity = origin.replace('https://', 'https://auth.');
  const adapterMirror = join(root, 'checks', 'proofs', 'bdd');
  const ticket = join(adapterMirror, 'ticket');
  await mkdir(join(ticket, 'features'), { recursive: true });
  await mkdir(join(ticket, 'steps'));
  // A ticket snapshot can preserve the author-facing relative import without
  // creating a second playwright-bdd test instance.
  await writeFile(join(adapterMirror, 'fixtures.mjs'), `export * from ${JSON.stringify(fixture)};\n`);
  await writeFile(join(adapterMirror, 'package.json'), '{"type":"module"}\n');
  const scratch = join(root, 'shared-run-root');
  await mkdir(scratch);
  await writeFile(join(ticket, 'features', 'proof.feature'), `Feature: Synthetic local proof
  @AC1
  Scenario: Authenticate inside one browser context
    Given a signed-in browser
    Then the synthetic page is authenticated

  @AC2 @AC9
  Scenario: One result cannot prove distinct criteria
    Then an explicit check passes

  @AC3
  Scenario: Check an observed mismatch
    Then the count matches

  @AC4
  Scenario: Missing fixture
    Given the fixture is absent

  @AC5
  Scenario: Refuse origin outside this run
    When the browser is redirected

  @AC6
  Scenario: A noop is not evidence
    Given a noop
      """
      @AC999
      """

  @AC7
  Scenario: Refuse unsafe observation content
    Then a raw observation is attempted

  @AC8
  Scenario: Refuse an off-origin setup redirect
    Given the setup API is redirected

  @AC10
  Scenario: Unreachable HTTP service is not a product failure
    When the unavailable "HTTP" service is opened

  @AC11
  Scenario: Unreachable HTTPS service is not a product failure
    When the unavailable "HTTPS" service is opened

  @AC12
  Scenario: The application's own HTTP 502 is evidence
    Then the "HTTP" application returns a real 502

  @AC13
  Scenario: The application's own HTTPS 502 is evidence
    Then the "HTTPS" application returns a real 502

  @AC14
  Scenario: A normal download abort is harmless
    Then the download aborts the navigation as expected
`);
  await writeFile(join(ticket, 'steps', 'proof.js'), `
import { Given, When, Then } from '../../fixtures.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
Given('a signed-in browser', async ({ proof }) => {
  await writeFile(join(process.env.PROOF_RUN_DIR, 'synthetic-asset.txt'), 'synthetic', { flag: 'wx' });
  if (process.env.PROOF_CONTEXT_REGION2 !== 'synthetic-zone' || process.env.PROOF_API_HEADERS !== undefined) {
    proof.block('invalid_runtime_context');
  }
  await proof.fetch(process.env.PROOF_IDENTITY2_URL + '/auth', {
    headers: { Authorization: 'Bearer ' + process.env.PROOF_PASSWORD },
  });
});
Then('the synthetic page is authenticated', async ({ page, proof }) => {
  await page.goto(process.env.PROOF_STOREFRONT_URL);
  const signedIn = await page.locator('main').textContent() === 'Authenticated';
  proof.check(signedIn, { signedIn });
});
Then('the count matches', ({ proof }) => proof.check(false, { matching: 0 }));
Then('an explicit check passes', ({ proof }) => proof.check(true, { visible: true }));
Given('the fixture is absent', ({ proof }) => proof.block('missing_fixture'));
When('the browser is redirected', async ({ page, proof }) => {
  await page.goto(process.env.PROOF_STOREFRONT_URL + '/redirect').catch(() => undefined);
  proof.check(false, { reachedExpectedPage: false });
});
Given('a noop', ({}, _value) => {});
Then('a raw observation is attempted', ({ proof }) => proof.check(true, { body: 'fake-private-body' }));
Given('the setup API is redirected', async ({ proof }) => { await proof.fetch(process.env.PROOF_STOREFRONT_URL + '/redirect'); });
When('the unavailable {string} service is opened', async ({ page, proof }, scheme) => {
  await page.goto(process.env['PROOF_DEAD_' + scheme + '_URL']).catch(() => undefined);
  proof.check(false, { visible: false });
});
Then('the {string} application returns a real 502', async ({ page, proof }, scheme) => {
  const url = scheme === 'HTTP' ? process.env.PROOF_HTTP_URL : process.env.PROOF_STOREFRONT_URL;
  const response = await page.goto(url + '/actual-502');
  const appError = response.status() === 502;
  const forwardedMarker = response.headers()['x-proof-proxy-failure'] !== undefined;
  proof.check(appError && (scheme === 'HTTPS' || !forwardedMarker), { appError });
});
Then('the download aborts the navigation as expected', async ({ page, proof }) => {
  const failed = page.waitForEvent('requestfailed');
  await page.goto(process.env.PROOF_HTTP_URL + '/download').catch(() => undefined);
  const request = await failed;
  const expectedAbort = request.isNavigationRequest() && request.failure()?.errorText === 'net::ERR_ABORTED';
  proof.check(expectedAbort, { expectedAbort });
});
`);

  async function run(side, storefront = origin) {
    const resultPath = join(scratch, `${side}.ndjson`);
    const child = await exec(process.execPath, [runner, ticket], { env: {
      ...process.env,
      PROOF_RUN_DIR: scratch,
      PROOF_RESULTS: resultPath,
      PROOF_CSV_DIR: root,
      PROOF_SIDE: side,
      PROOF_TICKET: 'TEST',
      PROOF_CONTEXT_REGION2: 'synthetic-zone',
      PROOF_IDENTITY2_URL: identity,
      PROOF_STOREFRONT_URL: storefront,
      PROOF_HTTP_URL: `http://127.0.0.1:${httpPort}`,
      // The ephemeral port is reserved by the fake service on .1 only.
      PROOF_DEAD_HTTP_URL: `http://127.0.0.2:${httpPort}`,
      PROOF_DEAD_HTTPS_URL: `https://127.0.0.2:${httpPort}`,
      PROOF_API_HEADERS: JSON.stringify({ PROOF_IDENTITY2_URL: { authorization: 'fake-api-only' } }),
      PROOF_PASSWORD: 'fake-proof-secret',
    } }).catch(error => error);
    const raw = await readFile(resultPath, 'utf8');
    assert.doesNotMatch(raw + child.stdout + child.stderr, /fake-proof-secret|fake-private-(body|session)|synthetic-zone|fake-api-only/);
    assert.equal(child.code, undefined);
    const rows = raw.trim().split('\n').map(JSON.parse);
    const parsed = await readEvidence(resultPath, new Set(rows.map(({ ac }) => ac)), ['fake-proof-secret']);
    assert.deepEqual(parsed.map(({ ac, status }) => ({ ac, status })), rows.map(({ ac, status }) => ({ ac, status })));
    return rows;
  }

  const expected = [
    { ac: 'AC1', status: 'pass', observed: { signedIn: true } },
    { ac: 'AC2', status: 'blocked', observed: { reason: 'multiple_ac_tags' } },
    { ac: 'AC9', status: 'blocked', observed: { reason: 'multiple_ac_tags' } },
    { ac: 'AC3', status: 'fail', observed: { matching: 0 } },
    { ac: 'AC4', status: 'blocked', observed: { reason: 'missing_fixture' } },
    { ac: 'AC5', status: 'blocked', observed: { reason: 'non_local_navigation' } },
    { ac: 'AC6', status: 'blocked', observed: { reason: 'no_explicit_check' } },
    { ac: 'AC7', status: 'blocked', observed: { reason: 'scenario_incomplete' } },
    { ac: 'AC8', status: 'blocked', observed: { reason: 'invalid_request_origin' } },
    { ac: 'AC10', status: 'blocked', observed: { reason: 'navigation_transport_failure' } },
    { ac: 'AC11', status: 'blocked', observed: { reason: 'navigation_transport_failure' } },
    { ac: 'AC12', status: 'pass', observed: { appError: true } },
    { ac: 'AC13', status: 'pass', observed: { appError: true } },
    { ac: 'AC14', status: 'pass', observed: { expectedAbort: true } },
  ];
  const [base, head, refused] = await Promise.all([
    run('before'), run('after'), run('remote', 'https://example.invalid'),
  ]);
  assert.deepEqual(base, expected);
  assert.deepEqual(head, expected);
  assert.deepEqual(refused, expected.map(({ ac }) => ({ ac, status: 'blocked', observed: { reason: 'invalid_runtime_origin' } })));
  assert.equal(forbiddenRequests, 0);
  assert.deepEqual((await readdir(scratch)).sort(), ['after.ndjson', 'before.ndjson', 'remote.ndjson']);
  assert.deepEqual(await readdir(ticket), ['features', 'steps']);
});
