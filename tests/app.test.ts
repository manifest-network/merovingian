import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, REQUEST_LIMITS, type SupportPort } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { ContributionHistory, SupportInfo } from '../src/support.js';
import { VisitCounter } from '../src/counts.js';

const config: Config = {
  network: 'testnet',
  chainId: 'manifest-ledger-testnet',
  publicOrigin: 'https://proof.refuge.example',
  port: 8080,
  rpcUrl: 'https://unused-rpc.example',
  gasPrice: '1.1umfx',
  pwrDenom: 'upwr',
  tenant: '',
  trustedProxyCidrs: [],
};

function unavailableSupport(): SupportPort {
  return {
    getInfo: async () => ({
      status: 'unavailable', network: 'testnet', chainId: config.chainId, tenant: '', denom: 'upwr',
      optional: true, testTokensOnly: true, message: 'Chain unavailable.', instructions: null,
      hostingCredit: null, checkedAt: null,
    }),
    getHistory: async () => ({
      status: 'unavailable', network: 'testnet', chainId: config.chainId, tenant: '', denom: 'upwr',
      checkedAt: null, entries: [], totals: null, indexedTransactions: null, scannedTransactions: 0,
      complete: false, message: 'Chain unavailable. Funding history is unknown.',
    }),
    verify: async () => ({ status: 'unavailable', message: 'Chain unavailable.' }),
  };
}

async function fixture(t: TestContext, overrides: Partial<Config> = {}, support = unavailableSupport()) {
  const effectiveConfig = { ...config, ...overrides };
  const counts = new VisitCounter(effectiveConfig, effectiveConfig.visitCountsPath);
  const app = createApp(effectiveConfig, support, counts);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    counts.close();
  });
  const request = (path: string, options?: RequestInit) => fetch(base + path, options);
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { base, request, json, server };
}

async function mcpClient(t: TestContext, base: string) {
  const client = new Client({ name: 'merovingian-acceptance-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
  t.after(() => client.close());
  return client;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'Expected local requests to reach the handler');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function rawRequest(base: string, localAddress: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(new URL('/api/v1/amenities', base), { localAddress, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
}

test('served MCP identity, discovery cards, health and OpenAPI match the prepared release and package version', async t => {
  const prepared = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(prepared.version, packageJson.version);
  const expectedIdentity = { name: prepared.name, version: packageJson.version };
  const { base, request } = await fixture(t);
  const client = await mcpClient(t, base);
  assert.deepEqual(client.getServerVersion(), expectedIdentity);
  const card = await (await request('/mcp/server-card')).json();
  assert.deepEqual({ name: card.name, version: card.version }, expectedIdentity);
  const legacy = await (await request('/.well-known/mcp/server-card.json')).json();
  assert.deepEqual(legacy.serverInfo, expectedIdentity);
  assert.equal((await (await request('/healthz')).json()).version, packageJson.version);
  assert.equal((await (await request('/openapi.json')).json()).info.version, packageJson.version);
  assert.equal((await (await request('/api/v1/stats')).json()).total, '0');
});

test('public serving totals count successful HTTP, form and MCP visits, including repeated seeds', async t => {
  const { base, request, json } = await fixture(t);
  const client = await mcpClient(t, base);
  const initial = await (await request('/api/v1/stats')).json();
  assert.deepEqual(Object.keys(initial).sort(), ['chainId', 'counts', 'network', 'since', 'status', 'storage', 'total']);
  assert.equal(initial.total, '0');
  await request('/');
  await request('/healthz');
  await request('/api/v1/amenities');
  assert.equal((await json('/api/v1/visits', { amenity: 'unknown' })).status, 400);
  const cookie = { amenity: 'byte-chip-cookie', seed: 'same-souvenir' };
  for (let i = 0; i < 2; i++) assert.equal((await json('/api/v1/visits', cookie)).status, 200);
  assert.equal((await request('/visit', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'amenity=null-tea' })).status, 200);
  assert.equal((await client.callTool({ name: 'enjoy_amenity', arguments: { amenity: 'rgb-sauna' } })).isError, undefined);
  assert.equal((await client.callTool({ name: 'enjoy_amenity', arguments: { amenity: 'rgb-sauna', preference: 'invalid' } })).isError, true);
  const response = await request('/api/v1/stats');
  const current = await response.json();
  assert.equal(current.total, '4');
  assert.equal(current.since, initial.since);
  assert.deepEqual(current.counts, { 'byte-chip-cookie': '2', 'rgb-sauna': '1', 'null-tea': '1' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-robots-tag') || '', /noindex/);
  const home = await (await request('/')).text();
  assert.match(home, /Cookies served/);
  assert.match(home, /Sauna sessions/);
  assert.match(home, /Cups of (?:null )?tea/);
  const tools = await client.listTools();
  assert.equal(tools.tools.find(tool => tool.name === 'enjoy_amenity')?.annotations?.readOnlyHint, false);
});

test('homepage loads browser tools under a same-origin policy without counting page or script views', async t => {
  const { request } = await fixture(t);
  const home = await request('/');
  const html = await home.text();
  assert.match(html, /<script src="\/webmcp\.js" defer><\/script>/);
  assert.doesNotMatch(html, /toolname=|tooldescription=/);
  assert.match(home.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.match(home.headers.get('content-security-policy') || '', /connect-src 'self'/);
  const script = await request('/webmcp.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') || '', /application\/javascript/);
  assert.match(await script.text(), /merovingian_visit/);
  assert.equal((await (await request('/api/v1/stats')).json()).total, '0');
});

test('HTTP and remote MCP expose the same menu and seeded experiences during a chain outage', { timeout: 15_000 }, async t => {
  let chainCalls = 0;
  const support: SupportPort = {
    getInfo: async () => { chainCalls++; throw new Error('Chain offline'); },
    getHistory: async () => { chainCalls++; throw new Error('Chain offline'); },
    verify: async () => { chainCalls++; throw new Error('Chain offline'); },
  };
  const { base, request, json } = await fixture(t, {}, support);
  const client = await mcpClient(t, base);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['enjoy_amenity', 'hosting_support', 'list_amenities', 'verify_contribution']);
  const httpMenuResponse = await request('/api/v1/amenities');
  assert.equal(httpMenuResponse.status, 200);
  const httpMenu = await httpMenuResponse.json();
  const mcpMenu = await client.callTool({ name: 'list_amenities', arguments: {} });
  assert.deepEqual(mcpMenu.structuredContent, httpMenu);
  assert.equal(httpMenu.walletRequired, false);

  for (const amenity of ['byte-chip-cookie', 'rgb-sauna', 'null-tea']) {
    const input = { amenity, seed: 'a-night-at-the-inn' };
    const response = await json('/api/v1/visits', input);
    assert.equal(response.status, 200);
    const httpVisit = await response.json();
    const mcpVisit = await client.callTool({ name: 'enjoy_amenity', arguments: input });
    assert.equal(mcpVisit.isError, undefined);
    assert.deepEqual(mcpVisit.structuredContent, httpVisit);
    assert.ok(JSON.stringify(httpVisit).length <= httpMenu.maxVisitOutputBytes);
  }
  assert.equal(chainCalls, 0, 'Free visits must not query the chain');
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
});

test('testnet stays crawlable for retirement discovery but carries noindex and no sitemap entries', async t => {
  const { request } = await fixture(t);
  for (const path of ['/', '/about', '/visit.md', '/llms.txt', '/openapi.json', '/api/v1/amenities', '/healthz']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('X-Robots-Tag') || '', /noindex/);
    assert.equal(response.headers.get('X-Merovingian-Network'), 'testnet');
    if (path === '/' || path === '/about') {
      const html = await response.text();
      assert.match(html, /<meta name="robots" content="noindex, follow">/);
      assert.match(html, /Testnet proof of concept/);
      assert.doesNotMatch(html, /rel="canonical"/);
    }
  }
  const robots = await (await request('/robots.txt')).text();
  assert.match(robots, /Allow: \//);
  assert.doesNotMatch(robots, /Disallow: \//);
  assert.doesNotMatch(robots, /Sitemap:/);
  const sitemap = await (await request('/sitemap.xml')).text();
  assert.match(sitemap, /<urlset/);
  assert.doesNotMatch(sitemap, /<url>/);
});

test('mainnet publishes canonical metadata and production-only discovery URLs', async t => {
  const production = 'https://merovingian.example';
  const { request, json } = await fixture(t, {
    network: 'mainnet', chainId: 'manifest-ledger-mainnet', publicOrigin: production,
    rpcUrl: 'https://mainnet-rpc.example', pwrDenom: 'mainnet-upwr',
  });
  for (const path of ['/', '/about']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Robots-Tag'), null);
    const html = await response.text();
    assert.ok(html.includes(`<link rel="canonical" href="${production}${path}">`));
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.match(html, /<meta name="description"/);
    assert.ok(html.includes(`<meta property="og:url" content="${production}${path}">`));
    const structuredData = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
    assert.ok(structuredData);
    assert.equal(JSON.parse(structuredData).url, production);
    assert.doesNotMatch(html, /proof\.refuge\.example|Testnet proof of concept/);
  }
  const robots = await (await request('/robots.txt')).text();
  assert.ok(robots.includes(`Sitemap: ${production}/sitemap.xml`));
  const sitemap = await (await request('/sitemap.xml')).text();
  assert.ok(sitemap.includes(`<loc>${production}/</loc>`));
  assert.ok(sitemap.includes(`<loc>${production}/about</loc>`));
  assert.doesNotMatch(sitemap, /<loc>[^<]*(?:\/visit|\/api|\/mcp)/);
  const schema = await (await request('/openapi.json')).json();
  assert.deepEqual(schema.servers, [{ url: production }]);
  for (const path of ['/visit.md', '/llms.txt']) {
    const guide = await (await request(path)).text();
    assert.ok(guide.includes(`${production}/mcp`));
    assert.doesNotMatch(guide, /proof\.refuge\.example/);
  }
  const visitResponse = await json('/visit', { amenity: 'null-tea', seed: 'mainnet' });
  const visitHtml = await visitResponse.text();
  assert.match(visitHtml, /name="robots" content="noindex, follow"/);
  assert.doesNotMatch(visitHtml, /rel="canonical"/);
});

test('retirement redirects public pages and retires machine calls without changing their network', async t => {
  let supportCalls = 0;
  const support: SupportPort = {
    getInfo: async () => { supportCalls++; throw new Error('Retired support must not execute'); },
    getHistory: async () => { supportCalls++; throw new Error('Retired support must not execute'); },
    verify: async () => { supportCalls++; throw new Error('Retired support must not execute'); },
  };
  const mainnetOrigin = 'https://merovingian.example';
  const { request, json } = await fixture(t, { mainnetOrigin }, support);
  for (const path of ['/', '/about']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(path, { method, redirect: 'manual' });
      assert.equal(response.status, 301);
      assert.equal(response.headers.get('Location'), mainnetOrigin + path);
    }
  }
  for (const path of ['/api/v1/visits', '/api/v1/support/verify', '/mcp', '/visit']) {
    const response = await json(path, { amenity: 'null-tea' });
    assert.equal(response.status, 410, path);
    assert.equal(response.headers.get('Location'), null);
    const result = await response.json();
    assert.equal(result.error, 'testnet_retired');
    assert.equal(result.network, 'testnet');
    assert.equal(result.chainId, config.chainId);
    assert.equal(result.mainnetOrigin, mainnetOrigin);
  }
  for (const path of ['/api/v1/amenities', '/api/v1/support', '/api/v1/contributions', '/operator', '/mcp', '/visit.md']) {
    const response = await request(path, { redirect: 'manual' });
    assert.equal(response.status, 410);
    assert.equal(response.headers.get('Location'), null);
  }
  assert.equal((await (await request('/healthz')).json()).retired, true);
  assert.equal(supportCalls, 0);
});

test('HTTP input limits reject malformed, extra, oversized and cross-origin data', async t => {
  const { request, json } = await fixture(t);
  const valid = { amenity: 'rgb-sauna', seed: 'validation' };
  for (const body of [[], {}, { ...valid, preference: 'porcelain' }, { ...valid, seed: 'x'.repeat(65) }, { ...valid, privateContext: 'not needed' }]) {
    assert.equal((await json('/api/v1/visits', body)).status, 400);
  }
  assert.equal((await request('/api/v1/visits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  })).status, 400);
  assert.equal((await request('/api/v1/visits', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(valid),
  })).status, 415);
  assert.equal((await json('/api/v1/visits', { ...valid, seed: 'x'.repeat(9_000) })).status, 413);
  assert.equal((await json('/api/v1/visits', valid, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await json('/api/v1/visits', valid, { Origin: config.publicOrigin })).status, 200);
  assert.equal((await json('/mcp', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await json('/api/v1/support/verify', { transactionHash: 'A'.repeat(64), sender: 'unwanted' })).status, 400);
  assert.equal((await json('/api/v1/support/verify', [])).status, 400);
  assert.equal((await request('/visit', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://untrusted.example' },
    body: 'amenity=null-tea',
  })).status, 403);
});

test('MCP rejects invalid preferences, oversized seeds and unrecognized input properties', async t => {
  const { base } = await fixture(t);
  const client = await mcpClient(t, base);
  for (const args of [
    { amenity: 'rgb-sauna', preference: 'porcelain' },
    { amenity: 'rgb-sauna', seed: 'x'.repeat(65) },
    { amenity: 'rgb-sauna', privateContext: 'not needed' },
  ]) {
    const result = await client.callTool({ name: 'enjoy_amenity', arguments: args });
    assert.equal(result.isError, true, `Invalid MCP input accepted: ${JSON.stringify(args)}`);
  }
});

test('MCP rejects every batch shape before any tool executes across supported Streamable HTTP versions', async t => {
  let supportCalls = 0;
  const support: SupportPort = { ...unavailableSupport(), getInfo: async () => { supportCalls++; return unavailableSupport().getInfo(); } };
  const { request, json } = await fixture(t, {}, support);
  const visit = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'enjoy_amenity', arguments: { amenity: 'null-tea' } } };
  const read = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hosting_support', arguments: {} } };
  const bad = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'enjoy_amenity', arguments: { amenity: 'invalid' } } };
  for (const protocol of ['2025-03-26', '2025-06-18', '2025-11-25']) {
    const headers = { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol };
    for (const batch of [[], [visit], [visit, read, bad], [read, null, visit], Array.from({ length: 50 }, (_, id) => ({ ...visit, id }))]) {
      const response = await json('/mcp', batch, headers);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, -32600);
      assert.equal((await (await request('/api/v1/stats')).json()).total, '0');
    }
    const single = await json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers);
    assert.equal(single.status, 200);
    assert.equal((await single.json()).result.tools.length, 4);
  }
  assert.equal(supportCalls, 0);
  const oversized = await json('/mcp', [{ ...visit, padding: 'x'.repeat(8192) }], { Accept: 'application/json, text/event-stream' });
  assert.equal(oversized.status, 413);
  // Invalid MIME lists are accepted by the transport's substring check, but do
  // not select Express's JSON parser. They must never reach transport parsing.
  const unparsed = await request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json, text/plain', Accept: 'application/json, text/event-stream' }, body: JSON.stringify([visit]) });
  assert.equal(unparsed.status, 415);
  assert.equal((await (await request('/api/v1/stats')).json()).total, '0');
  let total = 0;
  for (const protocol of ['2025-03-26', '2025-06-18', '2025-11-25']) {
    const single = await json('/mcp', visit, { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol });
    assert.equal(single.status, 200);
    assert.equal((await single.json()).result.structuredContent.amenity, 'null-tea');
    assert.equal((await (await request('/api/v1/stats')).json()).total, String(++total));
  }
});

test('explicit trusted local proxy gives each visitor an allowance and ignores spoofed leftmost addresses', async t => {
  const { base } = await fixture(t, { trustedProxyCidrs: ['127.0.0.2/32'] });
  const target = new URL(base);
  const proxy = createServer((req, res) => {
    const forwarded = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
    const upstream = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method,
      localAddress: '127.0.0.2', headers: { ...req.headers, 'x-forwarded-for': forwarded } }, reply => {
      res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(upstream);
  }).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  const proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  for (let i = 0; i < REQUEST_LIMITS.perClient; i++) {
    assert.equal(await rawRequest(proxyBase, '127.0.0.3', { 'X-Forwarded-For': `192.0.2.${i + 1}` }), 200);
  }
  assert.equal(await rawRequest(proxyBase, '127.0.0.3', { 'X-Forwarded-For': '198.51.100.2' }), 429);
  assert.equal(await rawRequest(proxyBase, '127.0.0.4'), 200);
  // Bypassing the proxy does not permit arbitrary headers to select a bucket.
  for (let i = 0; i < REQUEST_LIMITS.perClient; i++) {
    assert.equal(await rawRequest(base, '127.0.0.5', { 'X-Forwarded-For': `203.0.113.${i + 1}` }), 200);
  }
  assert.equal(await rawRequest(base, '127.0.0.5', { 'X-Forwarded-For': '198.51.100.9' }), 429);
  assert.equal(await rawRequest(base, '127.0.0.6'), 200);
});

test('equivalent forwarded IPv6 addresses share a bucket and invalid values fall back to socket identity', async t => {
  const { request } = await fixture(t, { trustedProxyCidrs: ['127.0.0.1'] });
  for (let i = 0; i < REQUEST_LIMITS.perClient; i++) {
    const response = await request('/api/v1/amenities', { headers: { 'X-Forwarded-For': i % 2 ? '2001:db8::1' : '2001:0db8:0000:0000:0000:0000:0000:0001' } });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  assert.equal((await request('/api/v1/amenities', { headers: { 'X-Forwarded-For': '2001:db8::1' } })).status, 429);
  for (let i = 0; i < REQUEST_LIMITS.perClient; i++) {
    const response = await request('/api/v1/amenities', { headers: { 'X-Forwarded-For': `invalid-${i}` } });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  assert.equal((await request('/api/v1/amenities', { headers: { 'X-Forwarded-For': 'another-invalid-value' } })).status, 429);
});

test('aggregate allowance is explicit and per-client rejections cannot consume it', async t => {
  const { request } = await fixture(t, { trustedProxyCidrs: ['127.0.0.1'] });
  const menu = async (client: number) => {
    const response = await request('/api/v1/amenities', { headers: { 'X-Forwarded-For': `192.0.2.${client}` } });
    await response.arrayBuffer(); return response.status;
  };
  for (let client = 1; client <= REQUEST_LIMITS.aggregate / REQUEST_LIMITS.perClient; client++) {
    for (let i = 0; i < REQUEST_LIMITS.perClient; i++) assert.equal(await menu(client), 200);
    for (let i = 0; i < 3; i++) assert.equal(await menu(client), 429);
  }
  assert.equal(await menu(100), 429);
  assert.equal((await request('/healthz')).status, 200);
});

test('per-client concurrency holds aborted HTTP/MCP work until settlement and then releases slots', async t => {
  const gate = deferred();
  let entered = 0;
  const support: SupportPort = { ...unavailableSupport(), getInfo: async () => { entered++; await gate.promise; return unavailableSupport().getInfo(); } };
  const { request, json } = await fixture(t, { trustedProxyCidrs: ['127.0.0.1'] }, support);
  t.after(() => gate.resolve());
  const controllers = Array.from({ length: REQUEST_LIMITS.perClientConcurrent }, () => new AbortController());
  const pending = controllers.map((controller, i) => request(i % 2 ? '/mcp' : '/api/v1/support', {
    signal: controller.signal,
    ...(i % 2 ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'hosting_support', arguments: {} } }) } : {}),
  }).then(response => response.arrayBuffer()).catch(() => undefined));
  await waitFor(() => entered === REQUEST_LIMITS.perClientConcurrent);
  assert.equal((await json('/api/v1/visits', { amenity: 'null-tea' })).status, 429);
  assert.equal((await request('/api/v1/amenities', { headers: { 'X-Forwarded-For': '192.0.2.2' } })).status, 200);
  controllers.forEach(controller => controller.abort());
  await Promise.all(pending);
  assert.equal((await request('/api/v1/amenities')).status, 429, 'Disconnected handlers still consume their slots');
  gate.resolve();
  let released = false;
  for (let i = 0; i < 100 && !released; i++) {
    const response = await request('/api/v1/stats');
    if (response.status === 200) { assert.equal((await response.json()).total, '0'); released = true; }
    else { await response.arrayBuffer(); await delay(5); }
  }
  assert.ok(released, 'Settled work releases concurrency slots');
  assert.equal((await json('/api/v1/visits', { amenity: 'null-tea' })).status, 200);
});

test('aggregate concurrency bounds independent visitors and successful completion frees slots', async t => {
  const gate = deferred();
  let entered = 0;
  const support: SupportPort = { ...unavailableSupport(), getInfo: async () => { entered++; await gate.promise; return unavailableSupport().getInfo(); } };
  const { request } = await fixture(t, { trustedProxyCidrs: ['127.0.0.1'] }, support);
  t.after(() => gate.resolve());
  const pending = Array.from({ length: REQUEST_LIMITS.concurrent }, (_, i) => request('/api/v1/support', {
    headers: { 'X-Forwarded-For': `192.0.2.${Math.floor(i / REQUEST_LIMITS.perClientConcurrent) + 1}` },
  }));
  await waitFor(() => entered === REQUEST_LIMITS.concurrent);
  const headers = { 'X-Forwarded-For': '198.51.100.1' };
  assert.equal((await request('/api/v1/amenities', { headers })).status, 429);
  assert.equal((await request('/healthz')).status, 200);
  gate.resolve();
  for (const response of await Promise.all(pending)) { assert.equal(response.status, 200); await response.arrayBuffer(); }
  assert.equal((await request('/api/v1/amenities', { headers })).status, 200);
});

test('a failed parallel handler and a request-window reset cannot release unfinished work', async t => {
  const gate = deferred();
  const realNow = Date.now;
  let offset = 0, entered = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  t.mock.method(console, 'error', () => {});
  const support: SupportPort = { ...unavailableSupport(),
    getHistory: async () => { throw new Error('Expected mocked history failure'); },
    getInfo: async () => { entered++; await gate.promise; return unavailableSupport().getInfo(); },
  };
  const { request } = await fixture(t, {}, support);
  t.after(() => gate.resolve());
  for (let i = 0; i < REQUEST_LIMITS.perClientConcurrent; i++) {
    const response = await request('/operator');
    assert.equal(response.status, 500); await response.arrayBuffer();
  }
  assert.equal(entered, REQUEST_LIMITS.perClientConcurrent);
  offset = REQUEST_LIMITS.windowMs + 1;
  assert.equal((await request('/api/v1/amenities')).status, 429);
  gate.resolve();
  await delay(0);
  assert.equal((await request('/api/v1/amenities')).status, 200);
});

test('support outages are explicit and leave free HTTP visits usable', async t => {
  const { request, json } = await fixture(t);
  const support = await (await request('/api/v1/support')).json();
  assert.equal(support.status, 'unavailable');
  assert.equal(support.instructions, null);
  const verification = await (await json('/api/v1/support/verify', { transactionHash: 'A'.repeat(64) })).json();
  assert.equal(verification.status, 'unavailable');
  assert.ok(!('receipt' in verification));
  assert.equal((await json('/api/v1/visits', { amenity: 'null-tea' })).status, 200);
});

test('abuse limits return a retry interval while health remains available', async t => {
  const { request } = await fixture(t);
  for (let count = 0; count < 120; count++) {
    const response = await request('/api/v1/amenities');
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const limited = await request('/api/v1/amenities');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal((await request('/healthz')).status, 200);
});

test('unknown paths and unsupported discovery methods consume a budget before either body parser', async t => {
  const { request } = await fixture(t);
  const paths = ['/anything', '/healthz', '/openapi.json'];
  for (let i = 0; i < REQUEST_LIMITS.perClient; i++) {
    const response = await request(paths[i % paths.length]!, { method: 'POST',
      headers: { 'Content-Type': i % 2 ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: i % 2 ? '{}' : 'a=b' });
    assert.equal(response.status, 404); await response.arrayBuffer();
  }
  for (const contentType of ['application/json', 'application/x-www-form-urlencoded']) {
    const response = await request('/another-unknown-path', { method: 'POST', headers: { 'Content-Type': contentType }, body: 'x'.repeat(8193) });
    assert.equal(response.status, 429, 'Reject at the budget before parsing an oversized body');
    await response.arrayBuffer();
  }
  for (const method of ['GET', 'HEAD']) for (const path of ['/healthz', '/openapi.json', '/mcp/server-card']) {
    const response = await request(path, { method });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
});

test('unfinished bodies on unknown routes share concurrency slots and release them on completion', async t => {
  const { base, request, server } = await fixture(t);
  let arrived = 0;
  server.on('request', () => { arrived++; });
  const uploads = Array.from({ length: REQUEST_LIMITS.perClientConcurrent }, (_, i) => {
    const body = i % 2 ? '{"a":1}' : 'a=1';
    const req = httpRequest(new URL('/unknown-upload', base), { method: 'POST', headers: {
      'Content-Type': i % 2 ? 'application/json' : 'application/x-www-form-urlencoded', 'Content-Length': String(body.length),
    } });
    const response = new Promise<number>((resolve, reject) => {
      req.on('error', reject);
      req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    });
    t.after(() => req.destroy());
    req.write(body[0]);
    return { req, response, remainder: body.slice(1) };
  });
  await waitFor(() => arrived === REQUEST_LIMITS.perClientConcurrent);
  assert.equal((await request('/another-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 429);
  assert.equal((await request('/healthz')).status, 200);
  uploads.forEach(({ req, remainder }) => req.end(remainder));
  assert.deepEqual(await Promise.all(uploads.map(upload => upload.response)), Array(REQUEST_LIMITS.perClientConcurrent).fill(404));
  assert.equal((await request('/another-upload', { method: 'POST' })).status, 404);
});

const dashboardTenant = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';
const dashboardVisitor = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';

function dashboardSupport(historyOverrides: Partial<ContributionHistory> = {}, infoOverrides: Partial<SupportInfo> = {}) {
  const history: ContributionHistory = {
    status: 'available', network: 'testnet', chainId: config.chainId,
    tenant: dashboardTenant, denom: 'upwr', checkedAt: '2026-09-17T16:00:00Z',
    entries: [
      { transactionHash: 'A'.repeat(64), height: '142', timestamp: '2026-09-17T15:01:00Z', sender: dashboardTenant, amount: '9007199254740993' },
      { transactionHash: 'B'.repeat(64), height: '141', timestamp: '2026-09-17T15:00:00Z', sender: dashboardVisitor, amount: '992800745259012' },
    ],
    totals: { amount: '10000000000000005', tenantAmount: '9007199254740993', otherAmount: '992800745259012' },
    indexedTransactions: 2, scannedTransactions: 2, complete: true,
    message: 'All indexed funding transactions are included.',
    ...historyOverrides,
  };
  const info: SupportInfo = {
    status: 'available', network: 'testnet', chainId: config.chainId,
    tenant: dashboardTenant, denom: 'upwr', optional: true, testTokensOnly: true,
    message: 'Hosting credit is available.', instructions: null,
    hostingCredit: {
      available: [{ denom: 'upwr', amount: '123456789000000001' }, { denom: 'other-token', amount: '999999999999' }],
      reserved: [{ denom: 'upwr', amount: '2000001' }], activeLeases: '1',
    },
    checkedAt: '2026-09-17T16:00:00Z',
    ...infoOverrides,
  };
  const support: SupportPort = {
    getInfo: async () => structuredClone(info),
    getHistory: async () => structuredClone(history),
    verify: async () => ({ status: 'unavailable', message: 'Not used by this fixture.' }),
  };
  return { support, info, history };
}

test('operator dashboard shows exact PWR credit and funding history without signing or JavaScript', async t => {
  const { support, history } = dashboardSupport();
  const { request } = await fixture(t, { tenant: dashboardTenant }, support);
  const response = await request('/operator');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') || '', /text\/html/);
  assert.match(response.headers.get('X-Robots-Tag') || '', /noindex/);
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
  const html = await response.text();
  const ungrouped = html.replace(/,/g, '');
  for (const label of ['Total funding', 'Tenant wallet', 'Other wallet', 'Available hosting credit', 'Reserved hosting credit']) {
    assert.ok(html.includes(label), `Missing dashboard label: ${label}`);
  }
  for (const exactAmount of ['10000000000.000005', '9007199254.740993', '992800745.259012', '123456789000.000001', '2.000001']) {
    assert.ok(ungrouped.includes(exactAmount), `Missing exact six-decimal PWR amount: ${exactAmount}`);
  }
  assert.doesNotMatch(ungrouped, /999999\.999999/, 'Other token credit must not count as PWR');
  assert.ok(html.includes(dashboardTenant));
  assert.ok(html.includes(dashboardVisitor));
  for (const entry of history.entries) {
    assert.ok(html.includes(entry.transactionHash));
    assert.match(html, new RegExp(`href="[^"]*${entry.transactionHash}[^"]*"`));
  }
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<form\b[^>]*method="post"/i);
  const apiResponse = await request('/api/v1/contributions');
  assert.equal(apiResponse.status, 200);
  assert.match(apiResponse.headers.get('X-Robots-Tag') || '', /noindex/);
  assert.match(apiResponse.headers.get('Cache-Control') || '', /no-store/);
  assert.deepEqual(await apiResponse.json(), history);
});

test('partial history labels its subtotal honestly instead of claiming lifetime funding', async t => {
  const { support } = dashboardSupport({
    complete: false, indexedTransactions: 145, scannedTransactions: 100,
    message: 'Only the 100 most recent indexed transactions were scanned.',
  });
  const { request } = await fixture(t, { tenant: dashboardTenant }, support);
  const response = await request('/operator');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Funding in recent history/);
  assert.doesNotMatch(html, /Total funding/);
  assert.ok(html.includes('100'));
  assert.ok(html.includes('145'));
});

test('outages keep the dashboard readable and funding totals unknown', async t => {
  const { request, json } = await fixture(t);
  const response = await request('/operator');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /unknown|unavailable/i);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ' '), /\b0(?:\.0+)?\s+(?:test\s+)?PWR\b/);
  assert.doesNotMatch(html, /No (?:confirmed )?(?:funding|contributions)/i);
  const historyResponse = await request('/api/v1/contributions');
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.status, 'unavailable');
  assert.equal(history.totals, null);
  assert.equal(history.indexedTransactions, null);
  assert.equal((await json('/api/v1/visits', { amenity: 'null-tea' })).status, 200);
});

test('operator HTML escapes chain fields and does not turn transaction data into markup', async t => {
  const attack = '<svg onload="alert(1)">&';
  const { support } = dashboardSupport({
    entries: [{ transactionHash: attack, height: '142', timestamp: attack, sender: attack, amount: '1000000' }],
  });
  const { request } = await fixture(t, { tenant: dashboardTenant }, support);
  const response = await request('/operator');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(!html.includes(attack));
  assert.doesNotMatch(html, /<svg\b|<script\b/i);
  assert.ok(html.includes('&lt;svg onload=&quot;alert(1)&quot;&gt;&amp;'));
  assert.doesNotMatch(html, /href="[^"]*"alert\(1\)/);
});

test('mainnet operator views are nonindexable and excluded from the marketing sitemap', async t => {
  const { support } = dashboardSupport({ network: 'mainnet', chainId: 'manifest-ledger-mainnet' }, { network: 'mainnet', chainId: 'manifest-ledger-mainnet', testTokensOnly: false });
  const { request } = await fixture(t, {
    network: 'mainnet', chainId: 'manifest-ledger-mainnet', publicOrigin: 'https://merovingian.example', tenant: dashboardTenant,
  }, support);
  for (const path of ['/operator', '/api/v1/contributions']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('X-Robots-Tag') || '', /noindex/);
    assert.match(response.headers.get('Cache-Control') || '', /no-store/);
    if (path === '/operator') {
      const html = await response.text();
      assert.match(html, /name="robots" content="noindex/);
      assert.doesNotMatch(html, /rel="canonical"|<script\b/i);
    }
  }
  const sitemap = await (await request('/sitemap.xml')).text();
  assert.doesNotMatch(sitemap, /\/operator|\/api\/v1\/contributions/);
});

test('all MCP concurrency slots remain held after disconnect until tools settle, then all can be reused', async t => {
  const firstGate = deferred(), secondGate = deferred();
  let entered = 0, settled = 0;
  let activeGate = firstGate;
  const hold = async () => { entered++; await activeGate.promise; settled++; };
  const support: SupportPort = { ...unavailableSupport(),
    getInfo: async () => { await hold(); return unavailableSupport().getInfo(); },
    verify: async () => { await hold(); return { status: 'unavailable', message: 'Local fixture.' }; },
  };
  const { request } = await fixture(t, {}, support);
  const controllers = Array.from({ length: REQUEST_LIMITS.perClientConcurrent }, () => new AbortController());
  const call = (i: number, signal?: AbortSignal) => request('/mcp', {
    method: 'POST', ...(signal ? { signal } : {}),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: i % 2
      ? { name: 'verify_contribution', arguments: { transactionHash: 'A'.repeat(64) } }
      : { name: 'hosting_support', arguments: {} } }),
  });
  t.after(() => { controllers.forEach(controller => controller.abort()); firstGate.resolve(); secondGate.resolve(); });
  const disconnected = controllers.map((controller, i) => call(i, controller.signal)
    .then(response => response.arrayBuffer()).catch(() => undefined));
  await waitFor(() => entered === REQUEST_LIMITS.perClientConcurrent);
  controllers.forEach(controller => controller.abort());
  await Promise.all(disconnected);
  // Ensure the server observes close before checking retained tool work. Merely
  // awaiting client abort promises does not establish that server-side event.
  await delay(25);
  const busy = await request('/api/v1/amenities');
  assert.equal(busy.status, 429, 'Disconnect must not release still-running tools');
  await busy.arrayBuffer();
  firstGate.resolve();
  await waitFor(() => settled === REQUEST_LIMITS.perClientConcurrent);
  await delay(0);
  activeGate = secondGate;
  const reused = Array.from({ length: REQUEST_LIMITS.perClientConcurrent }, (_, i) => call(i + 10));
  await waitFor(() => entered === REQUEST_LIMITS.perClientConcurrent * 2);
  secondGate.resolve();
  for (const response of await Promise.all(reused)) { assert.equal(response.status, 200); await response.arrayBuffer(); }
  assert.equal(settled, REQUEST_LIMITS.perClientConcurrent * 2);
});

test('MCP validation resumed after disconnect cannot start chain reads or serving mutations', async t => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const prototype = McpServer.prototype as unknown as { validateToolInput: (...args: unknown[]) => Promise<unknown> };
  const validate = prototype.validateToolInput;
  const gate = deferred();
  let validated = 0, supportCalls = 0, verifyCalls = 0;
  t.mock.method(prototype, 'validateToolInput', async function (this: typeof prototype, ...args: unknown[]) {
    const input = await validate.apply(this, args);
    validated++;
    await gate.promise;
    return input;
  });
  const support: SupportPort = { ...unavailableSupport(),
    getInfo: async () => { supportCalls++; return unavailableSupport().getInfo(); },
    verify: async () => { verifyCalls++; return { status: 'unavailable', message: 'Local fixture.' }; },
  };
  const { request } = await fixture(t, {}, support);
  const tools = [
    { name: 'hosting_support', arguments: {} },
    { name: 'verify_contribution', arguments: { transactionHash: 'A'.repeat(64) } },
    { name: 'enjoy_amenity', arguments: { amenity: 'null-tea' } },
  ];
  const controllers = tools.map(() => new AbortController());
  t.after(() => { controllers.forEach(controller => controller.abort()); gate.resolve(); });
  const pending = tools.map((params, i) => request('/mcp', {
    method: 'POST', signal: controllers[i]!.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params }),
  }).then(response => response.arrayBuffer()).catch(() => undefined));
  await waitFor(() => validated === tools.length);
  controllers.forEach(controller => controller.abort());
  await Promise.all(pending);
  await delay(25);
  gate.resolve();
  await delay(25);
  assert.equal(supportCalls, 0);
  assert.equal(verifyCalls, 0);
  const stats = await request('/api/v1/stats');
  assert.equal(stats.status, 200);
  assert.equal((await stats.json()).total, '0');
});
