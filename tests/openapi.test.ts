import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { liftedinit } from '@manifest-network/manifestjs';
import { TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { createApp, REQUEST_LIMITS } from '../src/app.js';
import type { Config } from '../src/config.js';
import { VisitCounter } from '../src/counts.js';
import { FUND_CREDIT_TYPE, SupportService, type ChainGateway, type ChainTransaction, type FundingHistoryPage } from '../src/support.js';

// Synthetic addresses and indexed transaction bytes; no keys, signing or network access.
const tenant = 'manifest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpn3rfe5';
const sender = 'manifest1qgpqyqszqgpqyqszqgpqyqszqgpqyqszz49vjz';
const checkedAt = '2026-09-21T00:00:00.000Z';
const config: Config = {
  network: 'testnet', chainId: 'manifest-ledger-testnet', publicOrigin: 'https://refuge.example', port: 8080,
  rpcUrl: 'https://unused-rpc.example', restUrl: 'https://unused-rest.example',
  gasPrice: '1umfx', pwrDenom: 'upwr', tenant, trustedProxyCidrs: [],
};
const apiOperations = [
  ['/api/v1/amenities', 'get'], ['/api/v1/visits', 'post'], ['/api/v1/stats', 'get'],
  ['/api/v1/support', 'get'], ['/api/v1/contributions', 'get'], ['/api/v1/support/verify', 'post'],
] as const;
const funding = (address = sender, amount = '9007199254740993', denom = 'upwr') => ({
  sender: address, tenant, amount: { denom, amount },
});

function transaction(messages = [funding(), funding(tenant, '7')]): ChainTransaction {
  const bytes = TxRaw.encode(TxRaw.fromPartial({
    bodyBytes: TxBody.encode(TxBody.fromPartial({ messages: messages.map(value => ({
      typeUrl: FUND_CREDIT_TYPE, value: liftedinit.billing.v1.MsgFundCredit.encode(value).finish(),
    })) })).finish(), signatures: [new Uint8Array([1, 2, 3])],
  })).finish();
  return { hash: createHash('sha256').update(bytes).digest('hex').toUpperCase(), height: '1542', code: 0, bytes };
}

function historyPage(total = '1'): FundingHistoryPage {
  const messages = [funding(), funding(tenant, '7')];
  return { total, txResponses: [{
    txhash: transaction().hash, height: '1542', code: 0, timestamp: '2026-09-21T00:00:00.123456789Z',
    tx: { '@type': '/cosmos.tx.v1beta1.Tx', body: { messages: messages.map(message => ({ '@type': FUND_CREDIT_TYPE, ...message })) } },
    events: messages.map(message => ({ type: 'credit_funded', attributes: Object.entries({
      tenant, sender: message.sender, amount: `${message.amount.amount}upwr`, credit_address: tenant,
      new_balance: '9007199254741000upwr',
    }).map(([key, value]) => ({ key, value })) })),
  }] };
}

async function fixture(t: TestContext, overrides: Partial<Config> = {}, gatewayOverrides: Partial<ChainGateway> = {}) {
  const effectiveConfig = { ...config, ...overrides };
  const gateway: ChainGateway = {
    getChainId: async () => effectiveConfig.chainId, getTransaction: async () => transaction(),
    getCredit: async () => ({ available: [{ denom: 'upwr', amount: '9007199254740993' }],
      reserved: [{ denom: 'upwr', amount: '7' }], activeLeases: '1' }),
    getFundingHistory: async () => historyPage(), ...gatewayOverrides,
  };
  const support = new SupportService(effectiveConfig, gateway, { now: () => Date.parse(checkedAt) });
  const counts = new VisitCounter(effectiveConfig);
  let countsClosed = false;
  const closeCounts = () => { if (!countsClosed) { counts.close(); countsClosed = true; } };
  const server = createApp(effectiveConfig, support, counts).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closeCounts(); support.dispose();
  });
  const request = (path: string, options?: RequestInit) => fetch(base + path, options);
  const json = (path: string, body: unknown) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const client = new Client({ name: 'openapi-contract-fixture', version: '1.0.0' });
  const mcp = async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
    t.after(() => client.close());
    return client;
  };
  return { base, request, json, mcp, support, closeCounts };
}

interface MediaContract { schema: AnySchemaObject; examples?: Record<string, { value: unknown }>; example?: unknown }
interface ResponseContract { content: Record<string, MediaContract>; headers?: Record<string, { schema: AnySchemaObject; required?: boolean }> }
type ResponseReference = ResponseContract | { $ref: string };
interface Operation { responses: Record<string, ResponseReference>; requestBody?: { content: Record<string, MediaContract> } }
interface ApiDocument {
  openapi: string; jsonSchemaDialect: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, AnySchemaObject>; responses: Record<string, ResponseContract> };
}

/** Compile the schemas served by /openapi.json, resolving their published component references. */
async function contracts(f: Awaited<ReturnType<typeof fixture>>) {
  const document: ApiDocument = await (await f.request('/openapi.json')).json();
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
  const ajv = new Ajv2020({ strict: true, allErrors: true, formats: fullFormats });
  for (const [name, schema] of Object.entries(document.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`);
  const resolve = (response: ResponseReference): ResponseContract => {
    if (!('$ref' in response)) return response;
    assert.match(response.$ref, /^#\/components\/responses\/[^/]+$/);
    const resolved = document.components.responses[response.$ref.split('/').at(-1)!];
    assert.ok(resolved, response.$ref);
    return resolved;
  };
  const responseContract = (path: string, method: string, status: number) => {
    const response = document.paths[path]?.[method]?.responses[String(status)];
    assert.ok(response, `Missing ${method} ${path} ${status} response contract`);
    return resolve(response);
  };
  const validate = (schema: AnySchemaObject, value: unknown) => {
    const check = ajv.compile(schema);
    assert.ok(check(value), ajv.errorsText(check.errors, { separator: '\n' }));
  };
  const response = async (path: string, method: string, reply: Response, status: number) => {
    assert.equal(reply.status, status, `${method} ${path}`);
    assert.match(reply.headers.get('content-type') || '', /^application\/json\b/);
    const contract = responseContract(path, method, status);
    const body = await reply.json();
    validate(contract.content['application/json']!.schema, body);
    for (const [name, header] of Object.entries(contract.headers || {})) {
      const value = reply.headers.get(name);
      if (header.required) assert.notEqual(value, null, name);
      if (value !== null) validate(header.schema, header.schema.type === 'integer' ? Number(value) : value);
    }
    return body;
  };
  const agreement = async (client: Client, name: string, args: Record<string, unknown>, httpBody: unknown, schema: string) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    validate({ $ref: `#/components/schemas/${schema}` }, result.structuredContent);
    assert.deepEqual(result.structuredContent, httpBody);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(httpBody) }]);
  };
  return { document, ajv, resolve, validate, responseContract, response, agreement };
}

for (const network of ['testnet', 'mainnet'] as const) {
  test(`published ${network} schemas and every response/request example validate strictly`, async t => {
    const f = await fixture(t, { network, chainId: `manifest-ledger-${network}` });
    const c = await contracts(f);
    for (const schema of Object.values(c.document.components.schemas)) c.ajv.compile(schema);
    assert.deepEqual(Object.keys(c.document.paths).sort(), [...apiOperations.map(([path]) => path), '/healthz'].sort());
    for (const operations of Object.values(c.document.paths)) for (const operation of Object.values(operations)) {
      for (const ref of Object.values(operation.responses)) {
        const content = c.resolve(ref).content['application/json']!;
        assert.ok(Object.keys(content.examples || {}).length > 0, 'Every documented response has examples');
        for (const { value } of Object.values(content.examples!)) c.validate(content.schema, value);
      }
      for (const content of Object.values(operation.requestBody?.content || {})) c.validate(content.schema, content.example);
    }
    // Document generation and discovery must not count as visits.
    assert.equal((await (await f.request('/api/v1/stats')).json()).total, '0');
  });

  test(`real ${network} HTTP responses conform and agree with all four MCP tools`, async t => {
    const f = await fixture(t, { network, chainId: `manifest-ledger-${network}` });
    const c = await contracts(f);
    const client = await f.mcp();
    const menu = await c.response('/api/v1/amenities', 'get', await f.request('/api/v1/amenities'), 200);
    await c.agreement(client, 'list_amenities', {}, menu, 'AmenityMenu');
    let servings = 0;
    for (const amenity of menu.amenities) for (const preference of amenity.preferences) {
      const input = { amenity: amenity.id, preference, seed: 'contract-fixture' };
      c.validate({ $ref: '#/components/schemas/VisitInput' }, input);
      c.validate(amenity.inputSchema, input);
      const visit = await c.response('/api/v1/visits', 'post', await f.json('/api/v1/visits', input), 200);
      assert.equal(Object.hasOwn(visit.experience, 'fortune'), amenity.id === 'byte-chip-cookie');
      assert.ok(Buffer.byteLength(JSON.stringify(visit)) <= menu.maxVisitOutputBytes);
      await c.agreement(client, 'enjoy_amenity', input, visit, 'VisitResult');
      servings += 2;
    }
    const info = await c.response('/api/v1/support', 'get', await f.request('/api/v1/support'), 200);
    assert.equal(info.status, 'available');
    assert.equal(info.testTokensOnly, network === 'testnet');
    await c.agreement(client, 'hosting_support', {}, info, 'SupportInfo');
    const history = await c.response('/api/v1/contributions', 'get', await f.request('/api/v1/contributions'), 200);
    assert.equal(history.complete, true);
    assert.equal(history.entries.length, 2);
    assert.equal(history.scannedTransactions, 1);
    assert.deepEqual(history.totals, { amount: '9007199254741000', tenantAmount: '7', otherAmount: '9007199254740993' });
    const input = { transactionHash: transaction().hash.toLowerCase() };
    const verified = await c.response('/api/v1/support/verify', 'post', await f.json('/api/v1/support/verify', input), 200);
    assert.equal(verified.status, 'confirmed');
    assert.equal(verified.receipt.amount.amount, history.totals.amount);
    await c.agreement(client, 'verify_contribution', input, verified, 'VerificationResult');
    const stats = await c.response('/api/v1/stats', 'get', await f.request('/api/v1/stats'), 200);
    assert.equal(stats.total, String(servings));
    assert.deepEqual(Object.keys(stats).sort(), ['chainId', 'counts', 'network', 'since', 'status', 'storage', 'total']);
    const health = await c.response('/healthz', 'get', await f.request('/healthz'), 200);
    assert.equal(health.network, network);
    assert.equal(health.retired, false);
  });
}

test('support and history unavailable/unconfigured variants preserve nulls and agree with MCP', async t => {
  for (const status of ['unavailable', 'unconfigured'] as const) await t.test(status, async t => {
    const f = await fixture(t, status === 'unconfigured' ? { tenant: '' } : {}, {
      getChainId: async () => { throw new Error('Fixture chain unavailable'); },
    });
    const c = await contracts(f);
    const client = await f.mcp();
    const info = await c.response('/api/v1/support', 'get', await f.request('/api/v1/support'), 200);
    assert.equal(info.status, status);
    assert.equal(info.instructions, null);
    await c.agreement(client, 'hosting_support', {}, info, 'SupportInfo');
    const history = await c.response('/api/v1/contributions', 'get', await f.request('/api/v1/contributions'), 200);
    assert.equal(history.status, status);
    assert.equal(history.totals, null);
    const input = { transactionHash: transaction().hash };
    const verified = await c.response('/api/v1/support/verify', 'post', await f.json('/api/v1/support/verify', input), 200);
    assert.equal(verified.status, status);
    await c.agreement(client, 'verify_contribution', input, verified, 'VerificationResult');
    await c.response('/api/v1/visits', 'post', await f.json('/api/v1/visits', { amenity: 'null-tea' }), 200);
  });
});

test('available instructions can have null credit while history is unconfigured without REST', async t => {
  const f = await fixture(t, { restUrl: undefined }, { getCredit: async () => null });
  const c = await contracts(f);
  const info = await c.response('/api/v1/support', 'get', await f.request('/api/v1/support'), 200);
  assert.equal(info.status, 'available');
  assert.equal(info.hostingCredit, null);
  assert.equal(info.checkedAt, checkedAt);
  await c.agreement(await f.mcp(), 'hosting_support', {}, info, 'SupportInfo');
  const history = await c.response('/api/v1/contributions', 'get', await f.request('/api/v1/contributions'), 200);
  assert.equal(history.status, 'unconfigured');
});

test('real history handling distinguishes empty, partial and failed reads', async t => {
  for (const mode of ['empty', 'partial', 'unavailable', 'malformed'] as const) await t.test(mode, async t => {
    const f = await fixture(t, {}, { getFundingHistory: async () => {
      if (mode === 'unavailable') throw new Error('Fixture history unavailable');
      if (mode === 'empty') return { total: '0', txResponses: [] };
      if (mode === 'malformed') return { total: '1', txResponses: [{}] };
      return historyPage('101');
    } });
    const c = await contracts(f);
    const history = await c.response('/api/v1/contributions', 'get', await f.request('/api/v1/contributions'), 200);
    assert.equal(history.status, ['unavailable', 'malformed'].includes(mode) ? 'unavailable' : 'available');
    assert.equal(history.complete, mode === 'empty');
    if (mode === 'empty') assert.deepEqual(history.totals, { amount: '0', tenantAmount: '0', otherAmount: '0' });
    if (mode === 'partial') assert.equal(history.indexedTransactions, 101);
  });
});

test('pending, failed, unrelated and inconsistent indexed transactions conform over HTTP and MCP', async t => {
  const cases = [
    { name: 'pending', tx: null, status: 'pending' },
    { name: 'failed', tx: { ...transaction(), code: 7 }, status: 'failed' },
    { name: 'other denomination', tx: transaction([funding(sender, '1', 'umfx')]), status: 'not_a_contribution' },
    { name: 'inconsistent confirmation', tx: { ...transaction(), height: '0' }, status: 'unavailable' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const f = await fixture(t, {}, { getTransaction: async () => scenario.tx });
    const c = await contracts(f);
    const input = { transactionHash: scenario.tx?.hash || 'A'.repeat(64) };
    const verified = await c.response('/api/v1/support/verify', 'post', await f.json('/api/v1/support/verify', input), 200);
    assert.equal(verified.status, scenario.status);
    assert.equal(Object.hasOwn(verified, 'receipt'), false);
    await c.agreement(await f.mcp(), 'verify_contribution', input, verified, 'VerificationResult');
  });
});

test('invalid HTTP inputs match their 400/415 contracts and visit errors agree with MCP text', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  for (const body of [{}, { transactionHash: 'invalid' }, { transactionHash: null }, [], { transactionHash: 'A'.repeat(64), expectedSender: sender }]) {
    const result = await c.response('/api/v1/support/verify', 'post', await f.json('/api/v1/support/verify', body), 400);
    assert.equal(result.status, 'invalid_request');
    assert.equal(Object.hasOwn(result, 'error'), Array.isArray(body) || Object.hasOwn(body, 'expectedSender'));
  }
  for (const path of ['/api/v1/visits', '/api/v1/support/verify']) {
    await c.response(path, 'post', await f.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), 400);
    await c.response(path, 'post', await f.request(path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }), 415);
  }
  const input = { amenity: 'rgb-sauna', preference: 'porcelain' };
  const error = await c.response('/api/v1/visits', 'post', await f.json('/api/v1/visits', input), 400);
  const result = await (await f.mcp()).callTool({ name: 'enjoy_amenity', arguments: input });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: error.error }]);
  assert.equal((await (await f.request('/api/v1/stats')).json()).total, '0');
});

// Fetch forbids GET bodies; a raw local request exercises the API's shared parsers.
function withBody(base: string, path: string, method: string, body: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, base), { method: method.toUpperCase(), headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode, headers: res.headers as Record<string, string>,
      })));
    });
    req.on('error', reject); req.end(body);
  });
}

test('all API operations publish the origin and body-parser errors their middleware returns', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  for (const [path, method] of apiOperations) {
    await c.response(path, method, await f.request(path, { method: method.toUpperCase(), headers: { Origin: 'https://untrusted.example' } }), 403);
    await c.response(path, method, await withBody(f.base, path, method, '{'), 400);
    await c.response(path, method, await withBody(f.base, path, method, JSON.stringify({ excess: 'x'.repeat(8192) })), 413);
  }
});

test('rate limits match the 429 body and required Retry-After contract while health bypasses limits', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  for (let i = 0; i < REQUEST_LIMITS.perClient; i++) {
    const reply = await f.request('/api/v1/amenities');
    assert.equal(reply.status, 200); await reply.arrayBuffer();
  }
  for (const [path, method] of apiOperations) await c.response(path, method, await f.request(path, { method: method.toUpperCase() }), 429);
  await c.response('/healthz', 'get', await f.request('/healthz'), 200);
});

test('closed serving storage returns the unchanged stats shape and a distinct visit 503 error', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  const client = await f.mcp();
  f.closeCounts();
  const statsReply = await f.request('/api/v1/stats');
  assert.equal(statsReply.headers.get('retry-after'), null);
  const stats = await c.response('/api/v1/stats', 'get', statsReply, 503);
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.counts, null);
  assert.equal(stats.total, null);
  assert.equal(stats.since, null);
  c.validate(c.responseContract('/api/v1/stats', 'get', 200).content['application/json']!.schema, stats);
  const input = { amenity: 'null-tea', seed: 'failed-storage' };
  const error = await c.response('/api/v1/visits', 'post', await f.json('/api/v1/visits', input), 503);
  const mcp = await client.callTool({ name: 'enjoy_amenity', arguments: input });
  assert.equal(mcp.isError, true);
  assert.deepEqual(mcp.content, [{ type: 'text', text: error.error }]);
  await c.response('/healthz', 'get', await f.request('/healthz'), 200);
});

test('retirement responses validate against the active publication and health remains 200', async t => {
  const c = await contracts(await fixture(t));
  const retired = await fixture(t, { mainnetOrigin: 'https://mainnet.example' });
  for (const [path, method] of apiOperations) await c.response(path, method, await retired.request(path, { method: method.toUpperCase() }), 410);
  const health = await c.response('/healthz', 'get', await retired.request('/healthz'), 200);
  assert.equal(health.retired, true);
  assert.deepEqual(Object.keys(c.document.paths['/healthz']!.get!.responses), ['200']);
});

test('unexpected handler failures use the published 500 contract', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  t.mock.method(console, 'error', () => {});
  const fail = async () => { throw new Error('Fixture handler failure'); };
  t.mock.method(f.support, 'getInfo', fail);
  t.mock.method(f.support, 'getHistory', fail);
  t.mock.method(f.support, 'verify', fail);
  for (const path of ['/api/v1/support', '/api/v1/contributions']) await c.response(path, 'get', await f.request(path), 500);
  await c.response('/api/v1/support/verify', 'post', await f.json('/api/v1/support/verify', { transactionHash: transaction().hash }), 500);
});

test('schemas reject missing fields, wrong nested types, invalid formats and contradictory status variants', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  const menu = await (await f.request('/api/v1/amenities')).json();
  const visit = await (await f.json('/api/v1/visits', { amenity: 'byte-chip-cookie', seed: 'mutations' })).json();
  const support = await (await f.request('/api/v1/support')).json();
  const history = await (await f.request('/api/v1/contributions')).json();
  const verification = await (await f.json('/api/v1/support/verify', { transactionHash: transaction().hash })).json();
  const stats = await (await f.request('/api/v1/stats')).json();
  const health = await (await f.request('/healthz')).json();
  const rejects = (schema: string, value: unknown) => assert.equal(c.ajv.compile({ $ref: `#/components/schemas/${schema}` })(value), false, schema);
  rejects('AmenityMenu', { ...menu, walletRequired: undefined });
  const brokenMenu = structuredClone(menu);
  brokenMenu.amenities[0].inputSchema.properties.seed.minLength = '1';
  rejects('AmenityMenu', brokenMenu);
  rejects('VisitResult', { ...visit, preference: 'porcelain' });
  rejects('VisitResult', { ...visit, experience: { ...visit.experience, fortune: null } });
  rejects('VisitResult', { ...visit, souvenir: { ...visit.souvenir, mediaType: 'application/json' } });
  rejects('VisitResult', { ...visit, souvenir: { ...visit.souvenir, chainId: undefined } });
  rejects('SupportInfo', { ...support, status: 'unavailable' });
  rejects('SupportInfo', { ...support, checkedAt: 'not-a-date' });
  rejects('SupportInfo', { ...support, hostingCredit: { ...support.hostingCredit, activeLeases: 1 } });
  rejects('SupportInfo', { ...support, instructions: { ...support.instructions, value: {
    ...support.instructions.value, amount: { denom: 'upwr', amount: 1 },
  } } });
  rejects('ContributionHistory', { ...history, totals: null });
  rejects('ContributionHistory', { ...history, totals: { ...history.totals, amount: 9007199254741000 } });
  rejects('ContributionHistory', { ...history, entries: [{ ...history.entries[0], timestamp: '2026-02-30T00:00:00Z' }] });
  rejects('ContributionHistory', { ...history, entries: [{ ...history.entries[0], transactionHash: 'not-a-hash' }] });
  rejects('ContributionHistory', { ...history, entries: [{ ...history.entries[0], amount: '-1' }] });
  rejects('VerificationResult', { status: 'confirmed' });
  rejects('VerificationResult', { status: 'pending', message: 'Waiting', receipt: verification.receipt });
  rejects('VerificationResult', { ...verification, receipt: { ...verification.receipt, transferable: true } });
  rejects('VerificationResult', { status: 'invalid_request', message: 'Invalid hash' });
  rejects('InvalidVerificationRequest', { status: 'invalid_request', error: 'Bad shape', message: 'Bad hash' });
  rejects('VisitStats', { ...stats, total: 1 });
  rejects('VisitStats', { ...stats, counts: { ...stats.counts, 'null-tea': '-1' } });
  rejects('VisitStats', { ...stats, since: 'not-a-date' });
  rejects('Health', { ...health, retired: null });
  rejects('Error', {});
  for (const [schema, value] of Object.entries({ AmenityMenu: menu, VisitResult: visit, SupportInfo: support,
    ContributionHistory: history, VerificationResult: verification, VisitStats: stats, Health: health })) {
    rejects(schema, { ...value, unexpected: true });
  }
});
