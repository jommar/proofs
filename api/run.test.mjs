import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('./run.mjs', import.meta.url));

function bru({ name = 'Fake local proof', seq, path, method = 'get', target = 'PROOF_CATALOG2_URL', headers = '', body, assertions = 'res.status: eq 200', extra = '' }) {
  return `meta {
  name: ${name}
  type: http
  seq: ${seq}
}
${method} {
  url: {{${target}}}${path}
  body: ${body === undefined ? 'none' : 'json'}
  auth: none
}
${headers ? `headers {\n  ${headers}\n}\n` : ''}
${body === undefined ? '' : `body:json {\n  ${JSON.stringify(body)}\n}\n`}
assert {
  ${assertions}
}
${extra}
`;
}

async function fixture(t, folders) {
  const root = await mkdtemp(join(tmpdir(), 'api-proof-test-'));
  t.after(() => rm(root, { recursive: true }));
  const ticket = join(root, 'ticket');
  await Promise.all(folders.map(async ({ path, files }) => {
    await mkdir(join(ticket, path), { recursive: true });
    await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(ticket, path, name), text)));
  }));
  const manifest = { folders: folders.map(({ files, ...folder }) => folder) };
  await writeFile(join(ticket, 'proof.json'), JSON.stringify(manifest));

  async function run(label, vars) {
    const dir = join(root, label);
    await mkdir(dir, { recursive: true });
    const resultsPath = join(dir, 'results.ndjson');
    const env = { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, PROOF_RUN_DIR: dir, PROOF_RESULTS: resultsPath, ...vars };
    const { stdout, stderr } = await exec(process.execPath, [entry, ticket], { env, timeout: 15_000 });
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    const text = await readFile(resultsPath, 'utf8');
    assert.ok(text.endsWith('\n'));
    return { text, rows: text.trim().split('\n').map(line => JSON.parse(line)) };
  }
  return { root, run };
}

async function fake(t, handler, address = '127.0.0.1') {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
    calls.push(call);
    const { status = 200, headers = {}, body = {}, raw = JSON.stringify(body) } = handler(call);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(raw);
  });
  server.listen(0, address);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return { calls, port, origin: `http://api.proof-fake.localhost:${port}` };
}

const verdicts = rows => rows.map(({ ac, status }) => [ac, status]);

test('sequences native Bruno cases, captures synthetic IDs and reports repeated ACs without response values', async t => {
  const hidden = 'sensitive-fake-private-field';
  const service = await fake(t, call => {
    if (call.method === 'POST' && call.path === '/api/v2/inventory') {
      const { name, group, ticket } = JSON.parse(call.body);
      return name === 'a, "quoted" case' && group === 'sandbox' && ticket === 'EXAMPLE-2' ?
        { status: 201, body: { id: 'synthetic/item', hidden } } : { status: 400 };
    }
    if (call.path === '/api/v2/inventory/synthetic%2Fitem?name=a%2C+%22quoted%22+case') return { body: { available: true, hidden } };
    return { status: 404 };
  });
  const spec = { ac: 'AC1', csv: { file: 'trial.csv', case: 'first' } };
  const proof = await fixture(t, [{ path: 'inventory', auth: 'none', requests: {
    'z-last.bru': { ac: 'AC1' }, 'a-read.bru': spec, 'b-create.bru': { ...spec, ac: 'AC2' },
  }, files: {
    'b-create.bru': bru({ name: 'Synthetic Secret', seq: 1, method: 'post', path: '/api/v2/inventory',
      body: { name: '{{csv.name}}', group: '{{PROOF_CONTEXT_GROUP2}}', ticket: '{{PROOF_TICKET}}' },
      assertions: 'res.status: eq 201\n  res.body.id: isDefined', extra: 'vars:post-response {\n  itemId: res.body.id\n}' }),
    'a-read.bru': bru({ name: 'Read created inventory', seq: 2, path: '/api/v2/inventory/{{itemId}}', assertions: 'res.status: eq 200\n  res.body.available: eq true',
      extra: 'params:query {\n  name: {{csv.name}}\n}' }),
    'z-last.bru': bru({ name: 'Private label /not-present', seq: 3, path: '/not-present' }),
    'not-listed.bru': 'this must never execute',
  } }]);
  await writeFile(join(proof.root, 'trial.csv'), 'case,name\r\nfirst,"a, ""quoted"" case"\r\n');
  const { rows, text } = await proof.run('result', {
    PROOF_CATALOG2_URL: service.origin, PROOF_CONTEXT_GROUP2: 'sandbox', PROOF_CSV_DIR: proof.root,
    PROOF_CONTEXT_LABEL: 'synthetic secret', PROOF_TICKET: 'EXAMPLE-2',
  });
  assert.deepEqual(verdicts(rows), [['AC2', 'pass'], ['AC1', 'pass'], ['AC1', 'fail']]);
  assert.match(rows[1].observed, /HTTP 200; all 2 checks matched.*Read created inventory/);
  assert.match(rows[2].observed, /HTTP 404; checks 1 contradicted/);
  assert.ok(!text.includes(hidden) && !text.includes('synthetic/item') && !text.includes('sandbox'));
  assert.doesNotMatch(text, /Synthetic Secret|Private label|\/not-present/);
  assert.deepEqual(service.calls.map(({ method }) => method), ['POST', 'GET', 'GET']);
});

test('missing fixtures and unsupported or ambiguous requests are blocked, without running later requests', async t => {
  const service = await fake(t, call => ({ status: call.path === '/seed' ? 404 : 200 }));
  const proof = await fixture(t, [{ path: 'condition', auth: 'none', requests: { 'case.bru': { ac: 'AC1' }, 'seed.bru': { role: 'prerequisite' } }, files: {
    'seed.bru': bru({ seq: 1, path: '/seed' }), 'case.bru': bru({ seq: 2, path: '/should-not-run' }),
  } }, { path: 'invalid', auth: 'none', requests: { 'case.bru': { ac: 'AC2' } }, files: {
    'case.bru': bru({ seq: 1, path: '/script-should-not-run', extra: 'script:pre-request {\n  console.log("no");\n}' }),
  } }, { path: 'order', auth: 'none', requests: { 'case.bru': { ac: 'AC3' }, 'two.bru': { ac: 'AC3' } }, files: {
    'case.bru': bru({ seq: 1, path: '/ambiguous-1' }), 'two.bru': bru({ seq: 1, path: '/ambiguous-2' }),
  } }, { path: 'csv', auth: 'none', requests: { 'case.bru': { ac: 'AC4', csv: { file: 'missing.csv', case: 'one' } } }, files: {
    'case.bru': bru({ seq: 1, path: '/fixture-should-not-run' }),
  } }]);
  const { rows } = await proof.run('result', { PROOF_CATALOG2_URL: service.origin });
  assert.deepEqual(verdicts(rows), [['AC1', 'blocked'], ['AC2', 'blocked'], ['AC3', 'blocked'], ['AC3', 'blocked'], ['AC4', 'blocked']]);
  assert.deepEqual(service.calls.map(({ path }) => path), ['/seed']);
});

test('body checks need a first status gate and auth errors are evidence only with explicit opt-in', async t => {
  const service = await fake(t, ({ path }) => ({ status: Number(path.slice(1)), body: { reason: 'denied' } }));
  const absent = 'res.body.inventory: isUndefined';
  const examples = [
    [401, 'res.status: eq 200', false, 'blocked', true],
    [403, `res.status: eq 200\n  ${absent}`, false, 'blocked', true],
    [200, absent, false, 'blocked', false],
    [200, `${absent}\n  res.status: eq 200`, false, 'blocked', false],
    [403, 'res.status: eq 403\n  res.body.reason: eq denied', true, 'pass', true],
    [200, 'res.status: eq 401\n  res.body.reason: eq denied', true, 'fail', true],
    [401, 'res.status: eq 401', false, 'blocked', true],
    [200, 'res.status: eq 200', true, 'blocked', false],
    [404, `res.status: eq 200\n  ${absent}`, false, 'blocked', true],
    [200, 'res.status: eq 200\n  res.body.inventory: isDefined', false, 'fail', true],
  ];
  const ac = index => `AC${index + 1}`;
  const proof = await fixture(t, examples.map(([code, assertions, expectAuthRejection], index) => ({
    path: `case-${index}`,
    auth: 'none',
    requests: { 'case.bru': { ac: ac(index), ...(expectAuthRejection ? { expectAuthRejection: true } : {}) } },
    files: { 'case.bru': bru({ seq: 1, path: `/${code}`, assertions }) },
  })));
  const { rows } = await proof.run('result', { PROOF_CATALOG2_URL: service.origin });
  assert.deepEqual(verdicts(rows), examples.map(([, , , status], index) => [ac(index), status]));
  assert.deepEqual(service.calls.map(({ path }) => path), examples.filter(([, , , , sent]) => sent).map(([code]) => `/${code}`));
});

test('concurrent invocations send runtime headers only to their selected origins and authenticated folders', async t => {
  async function stack(label) {
    const authorization = `Bearer Synthetic ${label}`;
    const cookie = `private_session=isolated-session-${label}`;
    const catalog = await fake(t, ({ path, headers }) => ({ status: path === '/public' ?
      (headers.authorization || headers.cookie ? 403 : 200) : (headers.authorization === authorization && !headers.cookie ? 200 : 401) }));
    const accounts = await fake(t, ({ headers }) => ({ status: headers.cookie === cookie && !headers.authorization ? 200 : 401 }));
    const headers = { PROOF_CATALOG2_URL: { authorization }, PROOF_ACCOUNTS_API_URL: { cookie } };
    const env = { PROOF_CATALOG2_URL: catalog.origin, PROOF_ACCOUNTS_API_URL: accounts.origin,
      PROOF_API_HEADERS: JSON.stringify(headers) };
    return { env, catalog, accounts, secrets: [authorization, cookie] };
  }
  const proof = await fixture(t, [{ path: 'auth', auth: 'runtime', requests: {
    'catalog.bru': { ac: 'AC1' }, 'accounts.bru': { ac: 'AC2' }, 'url.bru': { ac: 'AC3' },
  }, files: {
    'catalog.bru': bru({ name: 'Protected catalog', seq: 1, path: '/private' }),
    'accounts.bru': bru({ seq: 2, path: '/profile', target: 'PROOF_ACCOUNTS_API_URL' }),
    'url.bru': bru({ seq: 3, path: '/secret?value={{PROOF_API_HEADERS}}' }),
  } }, { path: 'public', auth: 'none', requests: { 'public.bru': { ac: 'AC4' } }, files: {
    'public.bru': bru({ seq: 1, path: '/public' }),
  } }, { path: 'author-header', auth: 'runtime', requests: { 'bad.bru': { ac: 'AC5' } }, files: {
    'bad.bru': bru({ seq: 1, path: '/do-not-send', headers: 'Authorization: Basic author-supplied' }),
  } }]);
  const [before, after, missing] = await Promise.all([stack('before'), stack('after'), stack('missing')]);
  const results = await Promise.all([
    proof.run('before', before.env), proof.run('after', after.env),
    proof.run('missing', { ...missing.env, PROOF_API_HEADERS: '{}' }),
    proof.run('invalid', { ...missing.env, PROOF_API_HEADERS: '{"PROOF_CATALOG2_URL":{"Host":"wrong.invalid"}}' }),
  ]);
  for (const [i, result] of results.entries()) {
    const expected = i < 2 ? 'pass' : 'blocked';
    assert.deepEqual(verdicts(result.rows), [['AC1', expected], ['AC2', expected], ['AC3', 'blocked'], ['AC4', 'pass'], ['AC5', 'blocked']]);
    for (const secret of (i === 0 ? before : i === 1 ? after : missing).secrets) assert.ok(!result.text.includes(secret));
  }
  for (const side of [before, after]) {
    assert.deepEqual(side.catalog.calls.map(({ path }) => path), ['/private', '/public']);
    assert.deepEqual(side.accounts.calls.map(({ path }) => path), ['/profile']);
  }
  assert.deepEqual(missing.catalog.calls.map(({ path }) => path), ['/public', '/public']);
  assert.deepEqual(missing.accounts.calls, []);
});

test('structural body checks block before asserting or capturing unusable HTTP 200 responses', async t => {
  const service = await fake(t, ({ path }) => ({
    '/html': { headers: { 'content-type': 'text/html' }, raw: '<h1>Sign in</h1>' },
    '/html-json': { headers: { 'content-type': 'text/html' }, raw: '{}' },
    '/invalid': { raw: '{bad JSON' },
    '/invalid-utf8': { raw: Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]) },
    '/string': { body: 'field' },
    '/array': { body: [{}] },
    '/json': { headers: { 'content-type': 'application/problem+json; charset=UTF-8' }, body: {} },
    '/text': { headers: { 'content-type': 'text/plain' }, raw: 'ready' },
  })[path] ?? {});
  const status = 'res.status: eq 200';
  const missing = `${status}\n  res.body.item: isUndefined`;
  const checks = [
    ['/html', missing, 'blocked'], ['/html-json', missing, 'blocked'], ['/invalid', missing, 'blocked'],
    ['/invalid-utf8', `${status}\n  res.body.name: isDefined`, 'blocked'], ['/invalid-utf8', status, 'pass'],
    ['/string', missing, 'blocked'], ['/array', missing, 'blocked'],
    ['/json', `${status}\n  res.body[0]: isUndefined`, 'blocked'],
    ['/json', missing, 'pass'], ['/json', `${status}\n  res.body.item: isDefined`, 'fail'],
    ['/array', `${status}\n  res.body[0]: isDefined`, 'pass'],
    ['/text', `${status}\n  res.body: eq ready`, 'pass'], ['/html', status, 'pass'],
  ];
  const ac = i => `AC${i + 1}`;
  const requests = Object.fromEntries(checks.map((_, i) => [`case-${i}.bru`, { ac: ac(i) }]));
  const files = Object.fromEntries(checks.map(([path, assertions], i) => [`case-${i}.bru`, bru({ seq: i + 1, path, assertions })]));
  const [seedAc, consumerAc] = [ac(checks.length), ac(checks.length + 1)];
  const proof = await fixture(t, [{ path: 'cases', auth: 'none', requests, files }, {
    path: 'capture', auth: 'none', requests: { 'seed.bru': { ac: seedAc }, 'use.bru': { ac: consumerAc } }, files: {
      'seed.bru': bru({ seq: 1, path: '/invalid-utf8', assertions: status, extra: 'vars:post-response {\n  itemId: res.body.name\n}' }),
      'use.bru': bru({ seq: 2, path: '/item/{{itemId}}' }),
    },
  }]);
  const result = await proof.run('result', { PROOF_CATALOG2_URL: service.origin });
  assert.deepEqual(verdicts(result.rows), [...checks.map(([, , outcome], i) => [ac(i), outcome]), [seedAc, 'blocked'], [consumerAc, 'blocked']]);
  assert.equal(service.calls.length, checks.length + 1);
  assert.doesNotMatch(result.text, /Sign in|bad JSON|ready/);
});

test('rejects non-local origins, /api/v2 origin suffixes, and cross-origin redirects without following any redirect', async t => {
  const trap = await fake(t, () => ({}));
  const service = await fake(t, call => ({ status: 302, headers: {
    location: call.path === '/external' ? 'https://no-http-request.invalid/private-sensitive-path' :
      call.path === '/cross-origin' ? `${trap.origin}/secret` : '/private-same-origin',
  } }));
  const proof = await fixture(t, [{ path: 'redirects', auth: 'none', requests: {
    'external.bru': { ac: 'AC1' }, 'cross.bru': { ac: 'AC2' }, 'same.bru': { ac: 'AC3' },
  }, files: {
    'external.bru': bru({ seq: 1, path: '/external' }), 'cross.bru': bru({ seq: 2, path: '/cross-origin' }),
    'same.bru': bru({ seq: 3, path: '/same-origin', assertions: 'res.status: eq 302' }),
  } }]);
  const denied = await proof.run('denied', { PROOF_CATALOG2_URL: service.origin, PROOF_OTHER_URL: 'https://no-http-request.invalid' });
  const ordinaryHost = await proof.run('ordinary-host', { PROOF_CATALOG2_URL: `http://ordinary-workspace.invalid:${service.port}` });
  const prefixed = await proof.run('prefixed', { PROOF_CATALOG2_URL: `${service.origin}/api/v2` });
  assert.ok([...denied.rows, ...ordinaryHost.rows, ...prefixed.rows].every(({ status }) => status === 'blocked'));
  assert.deepEqual(service.calls, []);
  const { rows, text } = await proof.run('result', { PROOF_CATALOG2_URL: service.origin });
  assert.deepEqual(verdicts(rows), [['AC1', 'blocked'], ['AC2', 'blocked'], ['AC3', 'pass']]);
  assert.ok(!text.includes('private-sensitive-path'));
  assert.deepEqual(service.calls.map(({ path }) => path), ['/external', '/cross-origin', '/same-origin']);
  assert.deepEqual(trap.calls, []);
});

test('runtime-style private HTTPS aliases share a port while retaining original Host, SNI, and CA checks', async t => {
  const proof = await fixture(t, [{ path: 'aliases', auth: 'none', requests: {
    'one.bru': { ac: 'AC1' }, 'two.bru': { ac: 'AC2' }, 'three.bru': { ac: 'AC3' },
  }, files: {
    'one.bru': bru({ seq: 1, path: '/one', target: 'PROOF_ONE_URL', assertions: 'res.status: eq 200\n  res.body.side: eq {{PROOF_SIDE}}',
      headers: 'X-Proof-Side: {{PROOF_SIDE}}' }),
    'two.bru': bru({ seq: 2, path: '/two', target: 'PROOF_TWO_URL' }),
    'three.bru': bru({ seq: 3, path: '/three' }),
  } }]);
  const domain = `proof-${process.pid}.localhost`;
  const hosts = [`one.${domain}`, domain, `three.${domain}`];
  const certPath = join(proof.root, 'cert.pem');
  const keyPath = join(proof.root, 'key.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${domain}`,
    '-addext', `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}`, '-keyout', keyPath, '-out', certPath]);
  const calls = [];
  const server = createTlsServer({ cert: await readFile(certPath), key: await readFile(keyPath) }, (req, res) => {
    calls.push([req.headers.host, req.socket.servername, req.url]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ side: req.headers['x-proof-side'] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const env = Object.fromEntries(['PROOF_ONE_URL', 'PROOF_TWO_URL', 'PROOF_CATALOG2_URL'].map((key, index) => [key, `https://${hosts[index]}:${port}`]));
  const untrusted = await proof.run('untrusted', { ...env, PROOF_SIDE: 'before', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1' });
  assert.ok(untrusted.rows.every(({ status }) => status === 'blocked'));
  assert.deepEqual(calls, []);
  const trusted = await proof.run('trusted', { ...env, PROOF_SIDE: 'after', NODE_EXTRA_CA_CERTS: certPath });
  assert.deepEqual(verdicts(trusted.rows), [['AC1', 'pass'], ['AC2', 'pass'], ['AC3', 'pass']]);
  assert.deepEqual(calls, hosts.map((host, i) => [`${host}:${port}`, host, ['/one', '/two', '/three'][i]]));
});

test('literal IPv4 and IPv6 loopbacks and generated localhost names reach local listeners', async t => {
  const proof = await fixture(t, [{ path: 'loopback', auth: 'none', requests: {
    'one.bru': { ac: 'AC1' }, 'two.bru': { ac: 'AC2' }, 'three.bru': { ac: 'AC3' },
  }, files: {
    'one.bru': bru({ seq: 1, path: '/one', target: 'PROOF_ONE_URL' }),
    'two.bru': bru({ seq: 2, path: '/two', target: 'PROOF_TWO_URL' }),
    'three.bru': bru({ seq: 3, path: '/three' }),
  } }]);
  const [ipv4, ipv6, named] = await Promise.all([fake(t, () => ({}), '127.0.0.2'), fake(t, () => ({}), '::1'), fake(t, () => ({}))]);
  const { rows } = await proof.run('result', {
    PROOF_ONE_URL: `http://127.0.0.2:${ipv4.port}`, PROOF_TWO_URL: `http://[::1]:${ipv6.port}`, PROOF_CATALOG2_URL: named.origin,
  });
  assert.deepEqual(verdicts(rows), [['AC1', 'pass'], ['AC2', 'pass'], ['AC3', 'pass']]);
  assert.deepEqual([ipv4, ipv6, named].map(service => service.calls[0]?.headers.host),
    [`127.0.0.2:${ipv4.port}`, `[::1]:${ipv6.port}`, new URL(named.origin).host]);
});

test('PROOF_ACS filters Bruno requests while keeping prerequisites and writes failure diagnostics to api.log', async t => {
  const proof = await fixture(t, [{ path: 'flow', auth: 'none', requests: {
    '01-seed.bru': { role: 'prerequisite' },
    '02-ac1.bru': { ac: 'AC1' },
    '03-ac2.bru': { ac: 'AC2' },
  }, files: {
    '01-seed.bru': bru({ seq: 1, path: '/seed', extra: 'vars:post-response {\n  itemId: res.body.id\n}' }),
    '02-ac1.bru': bru({ seq: 2, path: '/items/{{itemId}}', assertions: 'res.status: eq 200' }),
    '03-ac2.bru': bru({ seq: 3, path: '/fail', assertions: 'res.status: eq 200' }),
  } }]);
  const service = await fake(t, call => call.path === '/seed' ? { body: { id: 'item-7' } }
    : call.path === '/fail' ? { status: 500, body: { error: 'boom' } } : { body: { ok: true } });

  const filtered = await proof.run('filtered', { PROOF_CATALOG2_URL: service.origin, PROOF_ACS: 'AC1' });
  assert.deepEqual(verdicts(filtered.rows), [['AC1', 'pass']]);
  assert.deepEqual(service.calls.map(c => c.path), ['/seed', '/items/item-7']);

  const diagDir = join(proof.root, 'failing', 'diag');
  await mkdir(diagDir, { recursive: true, mode: 0o700 });
  const failing = await proof.run('failing', { PROOF_CATALOG2_URL: service.origin, PROOF_ACS: 'AC2', PROOF_DIAGNOSTICS_DIR: diagDir });
  assert.deepEqual(verdicts(failing.rows), [['AC2', 'fail']]);
  const diagLog = await readFile(join(diagDir, 'api.log'), 'utf8');
  assert.match(diagLog, /\[flow\/03-ac2\.bru\] fail:/);
});
