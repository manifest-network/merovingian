import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseSmokeArgs, runSmoke, smokeBudget, SmokeFailure } from '../scripts/smoke.js';
import { createApp, type SupportPort } from '../src/app.js';
import type { Config, Network } from '../src/config.js';
import { VisitCounter } from '../src/counts.js';
import { createSmokeFetch } from '../scripts/smoke-request.js';
import { MCP_SERVER_INFO } from '../src/identity.js';

const HASH = 'A'.repeat(64);
type Fault = (req: Request, res: Response, counts: VisitCounter) => boolean | Promise<boolean>;
interface RecordedRequest { method: string; path: string; body: any }

async function fixture(t: TestContext, network: Network = 'testnet', fault?: Fault, publicOrigin = (origin: string) => origin) {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-smoke-'));
  const servers: Server[] = [];
  let counts: VisitCounter | undefined;
  t.after(async () => {
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.filter(server => server.listening).map(server =>
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    ));
    counts?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const wrapper = express();
  const server = createServer(wrapper);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: Config = {
    network, chainId: `manifest-ledger-${network}`, publicOrigin: publicOrigin(origin), port: 8080,
    rpcUrl: 'https://unused-rpc.example', gasPrice: '1.1umfx', pwrDenom: 'upwr', tenant: '',
    trustedProxyCidrs: [], visitCountsPath: join(directory, 'counts.sqlite'),
  };
  counts = new VisitCounter(config, config.visitCountsPath);
  const environment = { network, chainId: config.chainId };
  const support: SupportPort = {
    getInfo: async () => ({
      ...environment, status: 'available', tenant: '', denom: 'upwr', optional: true,
      testTokensOnly: network === 'testnet', message: 'Local fixture', instructions: null,
      hostingCredit: { available: [], reserved: [], activeLeases: '0' }, checkedAt: '2026-09-21T00:00:00Z',
    }),
    getHistory: async () => ({
      ...environment, status: 'available', tenant: '', denom: 'upwr', checkedAt: '2026-09-21T00:00:00Z',
      entries: [{ transactionHash: HASH, height: '1', timestamp: '2026-09-21T00:00:00Z', sender: '', amount: '1000000' }],
      totals: { amount: '1000000', tenantAmount: '0', otherAmount: '1000000' },
      indexedTransactions: 1, scannedTransactions: 1, complete: true, message: 'Local fixture',
    }),
    verify: async input => input.transactionHash?.toUpperCase() === HASH ? {
      status: 'confirmed', receipt: {
        ...environment, id: 'fixture', transactionHash: HASH, height: '1', tenant: '',
        amount: { denom: 'upwr', amount: '1000000' }, contributions: [], message: 'Local fixture',
        transferable: false, provesOwnership: false,
      },
    } : { status: 'pending', message: 'Local fixture' },
  };
  // Fault injection lives in a loopback proxy. Forward the original bytes to
  // the unmodified production app, whose limiter, parsers and error handler run
  // in their real order. JSON decoding here is only for observations/faults.
  const backend = createServer(createApp(config, support, counts));
  servers.push(backend);
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendOrigin = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const requests: RecordedRequest[] = [];
  wrapper.use(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    try { req.body = JSON.parse(raw.toString()); } catch { /* Forward malformed bytes unchanged. */ }
    requests.push({ method: req.method, path: req.path, body: req.body });
    if (await fault?.(req, res, counts!)) return;
    const upstream = httpRequest(backendOrigin + req.originalUrl, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
    res.once('close', () => upstream.destroy());
    upstream.end(raw);
  });
  return { origin, counts, requests, directory };
}

function servingRequests(requests: RecordedRequest[]) {
  return requests.filter(req => req.method === 'POST' && /^\/(?:visit|api\/v1\/visits)\/?$/i.test(req.path)
    || req.body?.method === 'tools/call' && req.body.params?.name === 'enjoy_amenity');
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'Expected the local transport connection to close');
}

test('smoke argument parsing defaults to read-only and rejects ambiguous or unsafe input', () => {
  const origin = 'https://refuge.example';
  assert.deepEqual(parseSmokeArgs([origin]), { origin, network: 'testnet', serve: false, timeoutMs: 15000, contributionHash: undefined, liveServeAuthorization: undefined, expectUnchangedCounts: false });
  assert.equal(parseSmokeArgs([origin, HASH, '--mainnet']).serve, false);
  assert.equal(parseSmokeArgs(['--serve', origin, '--timeout-ms', '300', '--mainnet', '--live-serve-authorization', 'ENG-1032-test']).serve, true);
  for (const local of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
    assert.equal(parseSmokeArgs([local]).origin, local);
  }
  for (const args of [
    [], [origin, '--serv'], [origin, '--serve', '--serve'], [origin, 'bad-hash'], [origin, HASH, HASH],
    ['http://refuge.example'], [origin + '/'], [origin + '/visit'], [origin + '?q=1'], [origin + '#fragment'],
    ['https://user:secret@refuge.example'], ['file:///tmp/refuge'], ['not-a-url'],
    [origin, '--timeout-ms'], [origin, '--timeout-ms', '0'], [origin, '--timeout-ms', '60001'],
    [origin, '--timeout-ms', '1.5'], [origin, '--timeout-ms', '1e3'], [origin, '--timeout-ms', '-1'],
  ]) assert.throws(() => parseSmokeArgs(args), /Usage:/);
});

for (const network of ['testnet', 'mainnet'] as const) {
  for (const serve of [false, true]) {
    test(`${network} ${serve ? 'serving' : 'default read-only'} smoke has an exact isolated request and count budget`, async t => {
      const { origin, counts, requests } = await fixture(t, network);
      counts.record('rgb-sauna');
      const before = counts.snapshot();
      const close = t.mock.method(StreamableHTTPClientTransport.prototype, 'close');
      const report = await runSmoke(parseSmokeArgs([origin, ...(network === 'mainnet' ? ['--mainnet'] : []), ...(serve ? ['--serve'] : [])]));
      assert.equal(report.mode, serve ? 'serving' : 'read-only');
      assert.equal(report.servingChecks, serve ? 'passed' : 'not-run');
      assert.equal(report.httpAndMcpEquivalent, serve ? true : null);
      assert.equal(report.servings.unchanged, !serve);
      assert.equal(report.requestsAttempted, requests.length);
      assert.equal(requests.length, serve ? 27 : 20);
      assert.equal(report.budget.maxRequests, serve ? 28 : 21);
      assert.equal(report.servingRequestsAttempted, serve ? 7 : 0);
      assert.equal(servingRequests(requests).length, serve ? 7 : 0);
      assert.ok(close.mock.callCount() >= 1);
      assert.equal(counts.snapshot().since, before.since);
      assert.deepEqual(counts.snapshot().counts, serve
        ? { 'byte-chip-cookie': '2', 'rgb-sauna': '3', 'null-tea': '3' } : before.counts);
      assert.deepEqual(requests.filter(req => req.body?.method === 'tools/call').map(req => req.body.params.name),
        serve ? ['list_amenities', 'enjoy_amenity', 'enjoy_amenity', 'enjoy_amenity'] : ['list_amenities']);
      assert.equal(requests.filter(req => req.path === '/mcp' && req.method === 'GET').length, 1);
    });
  }
}

for (const serve of [false, true]) {
  test(`existing contribution verification adds three read-only requests with serve=${serve}`, async t => {
    const { origin, counts, requests } = await fixture(t);
    const report = await runSmoke(parseSmokeArgs([origin, HASH.toLowerCase(), ...(serve ? ['--serve'] : [])]));
    assert.equal((report.contribution as { status: string }).status, 'confirmed');
    assert.equal(report.requestsAttempted, serve ? 30 : 23);
    assert.equal(requests.length, report.requestsAttempted);
    assert.equal(report.budget.maxRequests, serve ? 31 : 24);
    assert.equal(servingRequests(requests).length, serve ? 7 : 0);
    assert.equal(counts.snapshot().total, serve ? '7' : '0');
  });
}

test('CLI writes separate private reports for both modes and leaves historical evidence alone', { timeout: 15000 }, async t => {
  const { origin, directory, counts } = await fixture(t);
  await mkdir(join(directory, '.local'));
  const legacy = join(directory, '.local/smoke-serving.json');
  await writeFile(legacy, 'older evidence', { mode: 0o644 });
  const reports: string[] = [];
  for (const serve of [false, true, true]) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../scripts/smoke.ts', import.meta.url)),
      origin, ...(serve ? ['--serve'] : []),
    ], { cwd: directory, timeout: 5000 });
    const result = JSON.parse(stdout);
    assert.equal(result.passed, true);
    assert.equal(result.mode, serve ? 'serving' : 'read-only');
    reports.push(result.report);
    const reportPath = join(directory, result.report);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.servingChecks, serve ? 'passed' : 'not-run');
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
    assert.equal(counts.snapshot().total, String((reports.length - 1) * 7));
  }
  assert.equal(new Set(reports).size, 3);
  assert.equal(JSON.parse(await readFile(join(directory, reports[1]), 'utf8')).servings.before.total, '0');
  assert.equal(JSON.parse(await readFile(join(directory, reports[2]), 'utf8')).servings.before.total, '7');
  await assert.rejects(stat(join(directory, '.local/live-acceptance.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(directory, reports[0]), 'utf8')).servingChecks, 'not-run');
  assert.equal(await readFile(legacy, 'utf8'), 'older evidence');
});

test('serving a live origin requires an explicit authorization reference before any request', () => {
  const origin = 'https://refuge.example';
  assert.throws(() => parseSmokeArgs([origin, '--serve', '--mainnet']), /Live --serve requires/);
  for (const reference of ['', '../private', 'contains spaces']) {
    assert.throws(() => parseSmokeArgs([origin, '--serve', '--live-serve-authorization', reference]), /authorization/);
  }
  assert.throws(() => parseSmokeArgs([origin, '--live-serve-authorization', 'ENG-1032-test']), /requires --serve/);
  const options = parseSmokeArgs([origin, '--serve', '--live-serve-authorization', 'ENG-1032-test']);
  assert.equal(options.liveServeAuthorization, 'ENG-1032-test');
  assert.equal(smokeBudget(options).maxServingRequests, 1 + 2 * 3);
  assert.equal(smokeBudget(options).maxServingRequests, Object.values(smokeBudget(options).servings).reduce((a, b) => a + b, 0));
  assert.throws(() => parseSmokeArgs(['http://localhost:8080', '--serve', '--expect-unchanged-counts']), /requires read-only/);
});

test('the request guard rejects all serving entry points and Express path aliases before dispatch', async t => {
  const { origin, counts, requests } = await fixture(t);
  const options = parseSmokeArgs([origin]);
  const guarded = createSmokeFetch(options, smokeBudget(options));
  const paths = ['/visit', '/visit/', '/VISIT', '/Visit', '/api/v1/visits', '/api/v1/visits/', '/API/V1/VISITS', '/mcp'];
  for (const path of paths) {
    const body = path === '/mcp'
      ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'enjoy_amenity', arguments: { amenity: 'null-tea' } } }
      : { amenity: 'null-tea' };
    const init = { method: 'post', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    await assert.rejects(guarded.fetch(origin + path, init), /Serving requests require|request not allowed/);
    await assert.rejects(guarded.fetch(new Request(origin + path, init)), /Serving requests require|request not allowed/);
    await assert.rejects(guarded.fetch(new Request(origin + path), init), /Serving requests require|request not allowed/);
  }
  assert.equal(guarded.requestsAttempted, 0);
  assert.equal(guarded.servingRequestsAttempted, 0);
  assert.equal(requests.length, 0);
  assert.equal(counts.snapshot().total, '0');
  // Independently demonstrate the production routes and test oracle recognize
  // these aliases; the guard must not quietly classify them as read-only.
  for (const path of paths.filter(path => path !== '/mcp')) {
    const response = await fetch(origin + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amenity: 'null-tea' }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(counts.snapshot().total, '7');
  assert.equal(servingRequests(requests).length, 7);
});

test('request and serving caps stop surplus calls at the transport boundary', async t => {
  const { origin, counts, requests } = await fixture(t);
  const options = parseSmokeArgs([origin, '--serve']);
  const guarded = createSmokeFetch(options, smokeBudget(options));
  for (let index = 0; index < 7; index++) {
    const response = await guarded.fetch(new Request(origin + '/api/v1/visits', {
      method: 'post', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amenity: 'null-tea' }),
    }));
    await response.json();
  }
  await assert.rejects(guarded.fetch(origin + '/visit', {
    method: 'post', body: 'amenity=null-tea', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }), /Serving requests require --serve and a remaining budget/);
  assert.equal(counts.snapshot().total, '7');
  assert.equal(requests.length, 7);
  const bounded = createSmokeFetch(options, { maxRequests: 1, maxServingRequests: 7 });
  await (await bounded.fetch(origin + '/healthz')).json();
  await assert.rejects(bounded.fetch(origin + '/healthz'), /Smoke request budget exceeded/);
  assert.equal(requests.length, 8);
  const concurrent = createSmokeFetch(options, { maxRequests: 1, maxServingRequests: 0 });
  const results = await Promise.allSettled([1, 2].map(id => concurrent.fetch(new Request(origin + '/mcp', {
    method: 'post', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }),
  }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) {
    if (result.status === 'fulfilled') await result.value.json();
    else assert.match(result.reason.message, /Smoke request budget exceeded/);
  }
  assert.equal(requests.length, 9);
});

test('read-only request policy fails closed for unexpected verbs, MCP tools, malformed messages and origins', async t => {
  const { origin, requests } = await fixture(t);
  const options = parseSmokeArgs([origin]);
  const guarded = createSmokeFetch(options, smokeBudget(options));
  for (const [path, init] of [
    ['/healthz', { method: 'DELETE' }], ['/unknown', {}], ['/healthz?extra=1', {}],
    ['/mcp', { method: 'POST', body: 'invalid' }],
    ['/mcp', { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', method: 'tools/list' }]) }],
    ['/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'unknown' } }) }],
    ['/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'unknown' }) }],
  ] as [string, RequestInit][]) await assert.rejects(guarded.fetch(origin + path, init));
  await assert.rejects(guarded.fetch('https://elsewhere.invalid/healthz'), /configured origin/);
  assert.equal(requests.length, 0);
});

test('the fixture preserves production body limits and JSON error handling', async t => {
  const { origin } = await fixture(t);
  for (const [path, type, body, status, message] of [
    ['/api/v1/visits', 'application/json', JSON.stringify({ amenity: 'null-tea', seed: 'x'.repeat(9000) }), 413, 'Request exceeds'],
    ['/visit', 'application/x-www-form-urlencoded', 'amenity=null-tea&a=1&b=2&c=3&d=4&e=5', 413, 'Request exceeds'],
    ['/api/v1/visits', 'application/json', '"hello"', 400, 'Malformed request body'],
  ] as const) {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal(response.status, status);
    assert.match((await response.json()).error, new RegExp(message));
  }
});

test('a symlinked CLI invocation performs checks and reports both success and failure', { timeout: 10000 }, async t => {
  let fail = false;
  const { origin, directory, requests } = await fixture(t, 'testnet', (req, res) => {
    if (fail && req.path === '/healthz') { res.status(503).end(); return true; }
    return false;
  });
  const link = join(directory, 'checkout');
  await symlink(fileURLToPath(new URL('../', import.meta.url)), link, 'dir');
  const command = ['--import', import.meta.resolve('tsx'), join(link, 'scripts/smoke.ts'), origin];
  const { stdout } = await promisify(execFile)(process.execPath, command, { cwd: directory, timeout: 5000 });
  assert.equal(JSON.parse(stdout).passed, true);
  assert.equal(requests.length, 20);
  fail = true;
  await assert.rejects(promisify(execFile)(process.execPath, command, { cwd: directory, timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    const result = JSON.parse(error.stderr);
    assert.equal(result.passed, false);
    assert.equal(result.requestsAttempted, 1);
    assert.match(result.error, /GET \/healthz.*503/);
    return true;
  });
});

test('importing the smoke module from a non-file entry point never runs the CLI', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
    `process.argv[1] = '-'; await import(${JSON.stringify(new URL('../scripts/smoke.ts', import.meta.url).href)});`,
  ], { timeout: 5000 });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('unwritable report storage fails preflight before creating any servings', async t => {
  const { origin, directory, counts, requests } = await fixture(t);
  await writeFile(join(directory, '.local'), 'blocked');
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../scripts/smoke.ts', import.meta.url)), origin, '--serve',
  ], { cwd: directory, timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    const result = JSON.parse(error.stderr);
    assert.equal(result.stage, 'preflight');
    assert.equal(result.servingRequestsAttempted, 0);
    return true;
  });
  assert.equal(requests.length, 0);
  assert.equal(counts.snapshot().total, '0');
});

test('report failure after successful serving preserves full evidence and a distinct exit code', async t => {
  let directory = '';
  let snapshots = 0;
  const fixtureResult = await fixture(t, 'testnet', async req => {
    if (req.path === '/api/v1/stats' && ++snapshots === 2) {
      const files = await readdir(join(directory, '.local'));
      const report = files.find(file => file.startsWith('smoke-serving-') && file.endsWith('.json'))!;
      await mkdir(join(directory, '.local', report + '.tmp'));
    }
    return false;
  });
  directory = fixtureResult.directory;
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../scripts/smoke.ts', import.meta.url)),
    fixtureResult.origin, HASH, '--serve',
  ], { cwd: directory, timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 2);
    const result = JSON.parse(error.stdout);
    assert.equal(result.passed, true);
    assert.equal(result.reportWritten, false);
    assert.equal(result.servingRequestsAttempted, 7);
    assert.equal(result.recoveryReport.souvenirs.length, 3);
    assert.equal(result.recoveryReport.servings.before.total, '0');
    assert.equal(result.recoveryReport.servings.after.total, '7');
    assert.equal(result.recoveryReport.contribution.status, 'confirmed');
    return true;
  });
  assert.equal(fixtureResult.counts.snapshot().total, '7');
});

for (const failure of ['redirect', '503', 'timeout']) {
  test(`MCP GET probe ${failure} fails acceptance before any serving request`, { timeout: 10000 }, async t => {
    const { origin, counts } = await fixture(t, 'testnet', (req, res) => {
      if (req.path !== '/mcp' || req.method !== 'GET') return false;
      if (failure === 'redirect') res.redirect(307, 'https://elsewhere.invalid/mcp');
      if (failure === '503') res.status(503).end();
      return true;
    });
    const close = t.mock.method(StreamableHTTPClientTransport.prototype, 'close');
    await assert.rejects(runSmoke(parseSmokeArgs([origin, '--serve', '--timeout-ms', '500'])), (error: any) => {
      assert.match(error.message, /GET \/mcp/);
      assert.equal(error.servingRequestsAttempted, 0);
      return true;
    });
    assert.ok(close.mock.callCount() >= 1);
    assert.equal(counts.snapshot().total, '0');
  });
}

test('SDK background errors fail the run and close the transport', async t => {
  const { origin, counts } = await fixture(t);
  const original = StreamableHTTPClientTransport.prototype.send;
  t.mock.method(StreamableHTTPClientTransport.prototype, 'send', async function (this: StreamableHTTPClientTransport, ...args: Parameters<typeof original>) {
    const [message, options] = args;
    await original.call(this, message, options);
    if ('method' in message && message.method === 'notifications/initialized') {
      this.onerror?.(new Error('SDK background failure'));
    }
  });
  const close = t.mock.method(StreamableHTTPClientTransport.prototype, 'close');
  await assert.rejects(runSmoke(parseSmokeArgs([origin, '--serve'])), /SDK background failure/);
  assert.ok(close.mock.callCount() >= 1);
  assert.equal(counts.snapshot().total, '0');
});

for (const result of [{ content: [], isError: true }, { content: [{ type: 'text', text: '{"status":"pending"}' }] }]) {
  test(`contribution diagnostics identify ${'isError' in result ? 'tool failure' : 'missing structured content'}`, async t => {
    const { origin } = await fixture(t, 'testnet', (req, res) => {
      if (req.body?.params?.name !== 'verify_contribution') return false;
      res.json({ jsonrpc: '2.0', id: req.body.id, result });
      return true;
    });
    await assert.rejects(runSmoke(parseSmokeArgs([origin, HASH])), /verify_contribution: (MCP tool returned isError|missing structuredContent)/);
  });
}

test('PUBLIC_ORIGIN mismatch fails early with actionable diagnostics', async t => {
  const { origin, requests, counts } = await fixture(t, 'testnet', undefined, value => value.replace('127.0.0.1', 'localhost'));
  await assert.rejects(runSmoke(parseSmokeArgs([origin, '--serve'])), /ORIGIN must exactly match the deployment PUBLIC_ORIGIN/);
  assert.equal(requests.length, 2);
  assert.equal(counts.snapshot().total, '0');
});

test('strict counter verification accepts quiet runs and fails on concurrent increments', async t => {
  for (const changed of [false, true]) {
    let snapshots = 0;
    const { origin } = await fixture(t, 'testnet', (req, _res, counts) => {
      if (req.path === '/api/v1/stats' && ++snapshots === 2 && changed) counts.record('null-tea');
      return false;
    });
    const operation = runSmoke(parseSmokeArgs([origin, '--expect-unchanged-counts']));
    if (changed) await assert.rejects(operation, /--expect-unchanged-counts: serving counters changed/);
    else assert.equal((await operation).servings.unchanged, true);
  }
});

test('HTTP status diagnostics survive a failed body cancellation', async () => {
  const options = parseSmokeArgs(['https://refuge.example']);
  const transport: typeof fetch = async () => new Response(new ReadableStream({
    cancel() { throw new Error('discard failed'); },
  }), { status: 503 });
  const guarded = createSmokeFetch(options, smokeBudget(options), transport);
  await assert.rejects(guarded.fetch(options.origin + '/api/v1/support'), /GET \/api\/v1\/support: expected HTTP 200, received 503/);
});

test('transport diagnostics distinguish DNS, TLS, refusal, reset and blocked redirects without leaking arbitrary causes', async () => {
  const options = parseSmokeArgs(['https://refuge.example']);
  for (const code of ['ENOTFOUND', 'CERT_HAS_EXPIRED', 'ECONNREFUSED', 'ECONNRESET', 'redirect']) {
    const cause = code === 'redirect' ? new Error('unexpected redirect') : Object.assign(new Error('private diagnostic'), { code });
    const transport: typeof fetch = async () => { throw new TypeError('fetch failed', { cause }); };
    const guarded = createSmokeFetch(options, smokeBudget(options), transport);
    await assert.rejects(guarded.fetch(options.origin + '/healthz'), (error: any) => {
      assert.match(error.message, /GET \/healthz/);
      assert.ok(error.message.includes(code === 'redirect' ? 'redirect blocked' : code));
      assert.doesNotMatch(error.message, /private diagnostic/);
      return true;
    });
  }
});

for (const path of ['/healthz', '/mcp/server-card', '/openapi.json', '/sitemap.xml', '/api/v1/amenities', '/api/v1/stats', '/visit.md', '/api/v1/support']) {
  test(`read-only HTTP deadline covers headers and incomplete bodies at ${path}`, { timeout: 10000 }, async t => {
    for (const body of [false, true]) {
      let interrupted = false;
      const { origin, requests, counts } = await fixture(t, 'testnet', (req, res) => {
        if (req.path !== path) return false;
        res.once('close', () => { interrupted = true; });
        if (body) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
        return true;
      });
      await assert.rejects(runSmoke(parseSmokeArgs([origin, '--timeout-ms', '500'])), error => {
        assert.ok(error instanceof SmokeFailure);
        assert.equal(error.servingRequestsAttempted, 0);
        return /timeout|aborted/i.test(error.message);
      });
      await waitFor(() => interrupted);
      assert.equal(requests.filter(req => req.path === path).length, 1);
      assert.equal(servingRequests(requests).length, 0);
      assert.equal(counts.snapshot().total, '0');
    }
  });
}

test('HTTP failures reject redirects, non-200 metadata and malformed JSON without serving', async t => {
  for (const fault of ['redirect', 'status', 'json']) {
    const { origin, requests, counts } = await fixture(t, 'testnet', (req, res) => {
      if (req.path !== '/mcp/server-card') return false;
      if (fault === 'redirect') res.redirect(307, '/visit');
      else if (fault === 'status') res.status(503).json(MCP_SERVER_INFO);
      else res.type('json').send('{');
      return true;
    });
    await assert.rejects(runSmoke(parseSmokeArgs([origin, '--serve'])), SmokeFailure);
    assert.equal(requests.filter(req => req.path === '/mcp/server-card').length, 1);
    assert.equal(servingRequests(requests).length, 0);
    assert.equal(counts.snapshot().total, '0');
  }
});

for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'resources/list', 'resources/read']) {
  test(`MCP deadline at ${method} closes the transport and never retries`, { timeout: 10000 }, async t => {
    let interrupted = false;
    const { origin, requests, counts } = await fixture(t, 'testnet', (req, res) => {
      if (req.body?.method !== method) return false;
      res.once('close', () => { interrupted = true; });
      // Notifications have no response body: the SDK cancels it immediately.
      // Stall their headers, and stall JSON bodies for requests with results.
      if (method !== 'notifications/initialized') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
      }
      return true;
    });
    const close = t.mock.method(StreamableHTTPClientTransport.prototype, 'close');
    await assert.rejects(runSmoke(parseSmokeArgs([origin, '--timeout-ms', '500'])), SmokeFailure);
    await waitFor(() => interrupted);
    assert.ok(close.mock.callCount() >= 1);
    assert.equal(requests.filter(req => req.body?.method === method).length, 1);
    assert.equal(servingRequests(requests).length, 0);
    assert.equal(counts.snapshot().total, '0');
  });
}

test('an unexpected MCP GET stream fails and closes without reconnecting', async t => {
  let streamClosed = false;
  const { origin, requests } = await fixture(t, 'testnet', (req, res) => {
    if (req.path === '/mcp' && req.method === 'GET') {
      res.once('close', () => { streamClosed = true; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': local stream\n\n');
      return true;
    }
    if (req.body?.method === 'tools/list') {
      res.json({ jsonrpc: '2.0', id: req.body.id, result: { tools: [] } });
      return true;
    }
    return false;
  });
  const close = t.mock.method(StreamableHTTPClientTransport.prototype, 'close');
  await assert.rejects(runSmoke(parseSmokeArgs([origin])), SmokeFailure);
  await waitFor(() => streamClosed);
  assert.ok(close.mock.callCount() >= 1);
  assert.equal(requests.filter(req => req.path === '/mcp' && req.method === 'GET').length, 1);
  assert.equal(servingRequests(requests).length, 0);
});

for (const channel of ['form', 'http', 'mcp']) {
  for (const failure of ['status', 'redirect', 'timeout']) {
    test(`${channel} serving ${failure} stops after the uncertain mutation without a retry`, { timeout: 10000 }, async t => {
      const { origin, requests, counts } = await fixture(t, 'testnet', (req, res, counter) => {
        const target = channel === 'form' ? req.path === '/visit'
          : channel === 'http' ? req.path === '/api/v1/visits'
          : req.body?.method === 'tools/call' && req.body.params?.name === 'enjoy_amenity';
        if (!target) return false;
        counter.record(channel === 'form' ? 'null-tea' : 'byte-chip-cookie');
        if (failure === 'status') res.status(503).end();
        else if (failure === 'redirect') res.redirect(307, '/api/v1/visits');
        else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
        return true;
      });
      const close = t.mock.method(StreamableHTTPClientTransport.prototype, 'close');
      const attempted = channel === 'form' ? 1 : channel === 'http' ? 2 : 3;
      await assert.rejects(runSmoke(parseSmokeArgs([origin, '--serve', '--timeout-ms', '500'])), error => {
        assert.ok(error instanceof SmokeFailure);
        assert.equal(error.servingRequestsAttempted, attempted);
        return true;
      });
      assert.ok(close.mock.callCount() >= 1);
      assert.equal(servingRequests(requests).length, attempted);
      assert.equal(counts.snapshot().total, String(attempted));
    });
  }
}

test('read-only counters allow concurrent visitor increases and reject resets', async t => {
  for (const reset of [false, true]) {
    let snapshots = 0;
    const { origin, counts, requests } = await fixture(t, 'testnet', (req, res, counter) => {
      if (req.path !== '/api/v1/stats' || ++snapshots !== 2) return false;
      if (reset) { res.json({ ...counter.snapshot(), since: '2000-01-01T00:00:00Z' }); return true; }
      counter.record('null-tea');
      return false;
    });
    if (reset) await assert.rejects(runSmoke(parseSmokeArgs([origin])), SmokeFailure);
    else {
      const report = await runSmoke(parseSmokeArgs([origin]));
      assert.equal(report.servings.unchanged, false);
      assert.equal(report.servingRequestsAttempted, 0);
      assert.equal(counts.snapshot().total, '1');
    }
    assert.equal(servingRequests(requests).length, 0);
  }
});
