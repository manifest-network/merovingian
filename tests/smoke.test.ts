import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseSmokeArgs, runSmoke, SmokeFailure } from '../scripts/smoke.js';
import { createApp, type SupportPort } from '../src/app.js';
import type { Config, Network } from '../src/config.js';
import { VisitCounter } from '../src/counts.js';

const HASH = 'A'.repeat(64);
type Fault = (req: Request, res: Response, counts: VisitCounter) => boolean;
interface RecordedRequest { method: string; path: string; body: any }

async function fixture(t: TestContext, network: Network = 'testnet', fault?: Fault) {
  const directory = await mkdtemp(join(tmpdir(), 'merovingian-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = express();
  const server = createServer(wrapper);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: Config = {
    network, chainId: `manifest-ledger-${network}`, publicOrigin: origin, port: 8080,
    rpcUrl: 'https://unused-rpc.example', gasPrice: '1.1umfx', pwrDenom: 'upwr', tenant: '',
    trustedProxyCidrs: [], visitCountsPath: join(directory, 'counts.sqlite'),
  };
  const counts = new VisitCounter(config, config.visitCountsPath);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    counts.close();
  });
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
  const requests: RecordedRequest[] = [];
  wrapper.use(express.json(), express.urlencoded({ extended: false }));
  wrapper.use((req, res, next) => {
    requests.push({ method: req.method, path: req.path, body: req.body });
    if (!fault?.(req, res, counts)) next();
  });
  wrapper.use(createApp(config, support, counts));
  return { origin, counts, requests, directory };
}

function servingRequests(requests: RecordedRequest[]) {
  return requests.filter(req => ['/visit', '/api/v1/visits'].includes(req.path)
    || req.body?.method === 'tools/call' && req.body.params?.name === 'enjoy_amenity');
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'Expected the local transport connection to close');
}

test('smoke argument parsing defaults to read-only and rejects ambiguous or unsafe input', () => {
  const origin = 'https://refuge.example';
  assert.deepEqual(parseSmokeArgs([origin]), { origin, network: 'testnet', serve: false, timeoutMs: 15000, contributionHash: undefined });
  assert.equal(parseSmokeArgs([origin, HASH, '--mainnet']).serve, false);
  assert.equal(parseSmokeArgs(['--serve', origin, '--timeout-ms', '300', '--mainnet']).serve, true);
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
  for (const serve of [false, true]) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../scripts/smoke.ts', import.meta.url)),
      origin, ...(serve ? ['--serve'] : []),
    ], { cwd: directory, timeout: 5000 });
    const result = JSON.parse(stdout);
    assert.equal(result.passed, true);
    assert.equal(result.mode, serve ? 'serving' : 'read-only');
    const reportPath = join(directory, result.report);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.servingChecks, serve ? 'passed' : 'not-run');
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
    assert.equal(counts.snapshot().total, serve ? '7' : '0');
  }
  await assert.rejects(stat(join(directory, '.local/live-acceptance.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(directory, '.local/smoke-read-only.json'), 'utf8')).servingChecks, 'not-run');
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
      else if (fault === 'status') res.status(503).json({ name: 'io.github.manifest-network/merovingian', version: '0.4.5' });
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

test('MCP discovery assertion failure closes an outstanding GET stream without reconnecting', async t => {
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
