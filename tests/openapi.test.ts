import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { liftedinit } from '@manifest-network/manifestjs';
import { parseAddress } from '@manifest-network/manifest-sdk';
import { TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { createApp, REQUEST_LIMITS } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { VisitCounter } from '../src/counts.js';
import { FUND_CREDIT_TYPE, SupportService, type ChainGateway, type ChainTransaction, type FundingHistoryPage, type SupportInfo, type ContributionHistory, type VerificationResult } from '../src/support.js';
import { API_MESSAGES, MAX_VISIT_OUTPUT_BYTES, OPENAPI_MEDIA_TYPE } from '../src/protocol.js';

// Synthetic addresses and indexed transaction bytes; no keys, signing or network access.
const tenant = 'manifest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpn3rfe5';
const sender = 'manifest1qgpqyqszqgpqyqszqgpqyqszqgpqyqszz49vjz';
const checkedAt = '2026-09-21T00:00:00.000Z';
const pwrDenom = loadConfig({}).pwrDenom;
const config: Config = {
  network: 'testnet', chainId: 'manifest-ledger-testnet', publicOrigin: 'https://refuge.example', port: 8080,
  rpcUrl: 'https://unused-rpc.example', restUrl: 'https://unused-rest.example',
  gasPrice: '1umfx', pwrDenom, tenant, trustedProxyCidrs: [],
};
const apiOperations = [
  ['/api/v1/amenities', 'get'], ['/api/v1/visits', 'post'], ['/api/v1/stats', 'get'],
  ['/api/v1/support', 'get'], ['/api/v1/contributions', 'get'], ['/api/v1/support/verify', 'post'],
] as const;
const funding = (address = sender, amount = '9007199254740993', denom = pwrDenom) => ({
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
      tenant, sender: message.sender, amount: `${message.amount.amount}${message.amount.denom}`, credit_address: tenant,
      new_balance: `9007199254741000${message.amount.denom}`,
    }).map(([key, value]) => ({ key, value })) })),
  }] };
}

async function fixture(t: TestContext, overrides: Partial<Config> = {}, gatewayOverrides: Partial<ChainGateway> | null = {}) {
  const effectiveConfig = { ...config, ...overrides };
  const gateway: ChainGateway = {
    getChainId: async () => effectiveConfig.chainId, getTransaction: async () => transaction(),
    getCredit: async () => ({ available: [{ denom: effectiveConfig.pwrDenom, amount: '9007199254740993' }],
      reserved: [{ denom: effectiveConfig.pwrDenom, amount: '7' }], activeLeases: '1' }),
    getFundingHistory: async () => historyPage(), ...gatewayOverrides,
  };
  const support = new SupportService(effectiveConfig, gatewayOverrides === null ? undefined : gateway, { now: () => Date.parse(checkedAt) });
  const counts = new VisitCounter(effectiveConfig, effectiveConfig.visitCountsPath);
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
  const example = (path: string, method: string, status: number, name: string) => {
    const value = responseContract(path, method, status).content['application/json']!.examples?.[name]?.value;
    assert.ok(value, `Missing example ${name}`);
    return value;
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
  return { document, ajv, resolve, validate, responseContract, response, agreement, example };
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
    const supportExample = c.example('/api/v1/support', 'get', 200, 'available') as SupportInfo;
    assert.equal(supportExample.message, info.message);
    assert.equal(supportExample.instructions!.notice, info.instructions.notice);
    await c.agreement(client, 'hosting_support', {}, info, 'SupportInfo');
    const history = await c.response('/api/v1/contributions', 'get', await f.request('/api/v1/contributions'), 200);
    assert.equal(history.complete, true);
    assert.equal(history.entries.length, 2);
    assert.equal(history.scannedTransactions, 1);
    assert.deepEqual(history.totals, { amount: '9007199254741000', tenantAmount: '7', otherAmount: '9007199254740993' });
    assert.equal((c.example('/api/v1/contributions', 'get', 200, 'complete') as ContributionHistory).message, history.message);
    const input = { transactionHash: transaction().hash.toLowerCase() };
    const verified = await c.response('/api/v1/support/verify', 'post', await f.json('/api/v1/support/verify', input), 200);
    assert.equal(verified.status, 'confirmed');
    assert.equal(verified.receipt.amount.amount, history.totals.amount);
    const verificationExample = c.example('/api/v1/support/verify', 'post', 200, 'confirmed') as VerificationResult;
    assert.equal(verificationExample.status, 'confirmed');
    if (verificationExample.status === 'confirmed') assert.equal(verificationExample.receipt.message, verified.receipt.message);
    await c.agreement(client, 'verify_contribution', input, verified, 'VerificationResult');
    const stats = await c.response('/api/v1/stats', 'get', await f.request('/api/v1/stats'), 200);
    assert.equal(stats.total, String(servings));
    assert.deepEqual(Object.keys(stats).sort(), ['chainId', 'counts', 'network', 'since', 'status', 'storage', 'total']);
    const health = await c.response('/healthz', 'get', await f.request('/healthz'), 200);
    assert.equal(health.network, network);
    assert.equal(health.retired, false);
  });
}

test('examples use configured denominations and storage, safe address placeholders and matching network identities', async t => {
  for (const mode of ['memory', 'explicitMemory', 'persistent'] as const) await t.test(mode, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'merovingian-contracts-'));
    const configured = loadConfig({
      NETWORK: mode === 'persistent' ? 'mainnet' : 'testnet', PUBLIC_ORIGIN: config.publicOrigin,
      MANIFEST_RPC_URL: config.rpcUrl, MANIFEST_REST_URL: config.restUrl, REFUGE_TENANT: tenant,
      PWR_DENOM: mode === 'persistent' ? `factory/${tenant}/custompwr` : pwrDenom,
      ...(mode === 'persistent' ? { VISIT_COUNTS_PATH: join(directory, 'visits.sqlite') } : {}),
    });
    const f = await fixture(t, { ...configured, ...(mode === 'explicitMemory' ? { visitCountsPath: ':memory:' } : {}) });
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const c = await contracts(f);
    const menu = await (await f.request('/api/v1/amenities')).json();
    const bounds = c.document.components.schemas.AmenityMenu!.properties.amenities;
    assert.equal(bounds.minItems, menu.amenities.length);
    assert.equal(bounds.maxItems, menu.amenities.length);
    const support = await (await f.request('/api/v1/support')).json();
    const available = c.example('/api/v1/support', 'get', 200, 'available') as SupportInfo;
    assert.equal(available.denom, configured.pwrDenom);
    assert.equal(available.instructions!.value.amount.denom, support.instructions.value.amount.denom);
    assert.match(available.instructions!.value.tenant, /example only.*GET \/api\/v1\/support/);
    assert.throws(() => parseAddress(available.instructions!.value.tenant, 'manifest'));
    const stats = await (await f.request('/api/v1/stats')).json();
    for (const [status, name] of [[200, 'available'], [503, 'unavailable']] as const) {
      const example = c.example('/api/v1/stats', 'get', status, name) as { storage: string };
      assert.equal(example.storage, stats.storage);
      assert.equal(example.storage, mode === 'persistent' ? 'persistent' : 'memory');
    }
    const inspect = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'denom') assert.equal(child, configured.pwrDenom);
        if (key === 'network') assert.equal(child, configured.network);
        if (key === 'chainId') assert.equal(child, configured.chainId);
        inspect(child);
      }
    };
    for (const operations of Object.values(c.document.paths)) for (const operation of Object.values(operations)) {
      for (const response of Object.values(operation.responses)) {
        const content = c.resolve(response).content['application/json']!;
        for (const { value } of Object.values(content.examples!)) { c.validate(content.schema, value); inspect(value); }
      }
      if (configured.network === 'mainnet') assert.equal(operation.responses['410'], undefined);
    }
    if (configured.network === 'mainnet') assert.equal(c.document.components.schemas.Retired, undefined);
    assert.equal((c.example('/healthz', 'get', 200, 'current') as { retired: boolean }).retired, false);
    assert.ok(!JSON.stringify(c.document).includes(directory), 'Storage paths are never published');
  });
});

test('OpenAPI discovery serves cached bytes, conditional GET/HEAD, public CORS and consistent catalog media types', async t => {
  const f = await fixture(t);
  const first = await f.request('/openapi.json', { headers: { Origin: 'https://agent.example' } });
  assert.equal(first.status, 200);
  const body = await first.text();
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal(etag, `"${createHash('sha256').update(body).digest('hex')}"`);
  assert.equal(first.headers.get('content-type'), `${OPENAPI_MEDIA_TYPE}; charset=utf-8`);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(first.headers.get('access-control-allow-origin'), '*');
  assert.ok(first.headers.get('link')!.includes(`rel="service-desc"; type="${OPENAPI_MEDIA_TYPE}"`));
  const second = await f.request('/openapi.json');
  assert.equal(await second.text(), body);
  assert.equal(second.headers.get('etag'), etag);
  const head = await f.request('/openapi.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)));
  const fresh = await f.request('/openapi.json', { cache: 'no-cache', headers: { 'If-None-Match': etag } });
  assert.equal(fresh.status, 304);
  assert.equal(await fresh.text(), '');
  const api = await (await f.request('/.well-known/api-catalog')).json();
  const ai = await (await f.request('/.well-known/ai-catalog.json')).json();
  assert.equal(api.linkset[1]['service-desc'][0].type, OPENAPI_MEDIA_TYPE);
  assert.equal(ai.entries.find((entry: { url: string }) => entry.url.endsWith('/openapi.json')).type, OPENAPI_MEDIA_TYPE);
  const other = await fixture(t, { pwrDenom: `factory/${tenant}/alternate` });
  const changed = await other.request('/openapi.json', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.equal((await (await f.request('/api/v1/stats')).json()).total, '0');
});

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
    assert.equal((c.example('/api/v1/support', 'get', 200, status) as SupportInfo).message, info.message);
    await c.agreement(client, 'hosting_support', {}, info, 'SupportInfo');
    const history = await c.response('/api/v1/contributions', 'get', await f.request('/api/v1/contributions'), 200);
    assert.equal(history.status, status);
    assert.equal(history.totals, null);
    assert.equal((c.example('/api/v1/contributions', 'get', 200, status) as ContributionHistory).message, history.message);
    const input = { transactionHash: transaction().hash };
    const verified = await c.response('/api/v1/support/verify', 'post', await f.json('/api/v1/support/verify', input), 200);
    assert.equal(verified.status, status);
    assert.deepEqual(c.example('/api/v1/support/verify', 'post', 200, status), verified);
    await c.agreement(client, 'verify_contribution', input, verified, 'VerificationResult');
    await c.response('/api/v1/visits', 'post', await f.json('/api/v1/visits', { amenity: 'null-tea' }), 200);
  });
});

test('the real gateway distinguishes an absent credit account from missing REST configuration', async t => {
  for (const absentAccount of [true, false]) await t.test(absentAccount ? 'gRPC NotFound' : 'missing REST', async t => {
    const f = await fixture(t, absentAccount ? {} : { restUrl: undefined }, null);
    const c = await contracts(f);
    const nativeFetch = globalThis.fetch;
    const queries: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === f.base) return nativeFetch(input, init);
      queries.push(url.href);
      if (url.href === `${config.rpcUrl}/status`) return Response.json({ result: { node_info: { network: config.chainId } } });
      assert.equal(absentAccount, true, 'Missing REST must never query credit');
      if (url.href === `${config.restUrl}/cosmos/base/tendermint/v1beta1/node_info`) return Response.json({ default_node_info: { network: config.chainId } });
      assert.equal(url.href, `${config.restUrl}/liftedinit/billing/v1/credit/${tenant}`);
      return Response.json({ code: 5, message: 'Credit account not found' }, { status: 404 });
    });
    const info = await c.response('/api/v1/support', 'get', await f.request('/api/v1/support'), 200);
    assert.equal(info.status, absentAccount ? 'available' : 'unavailable');
    assert.equal(info.hostingCredit, null);
    assert.equal(info.checkedAt, absentAccount ? checkedAt : null);
    if (absentAccount) assert.ok(info.instructions);
    else assert.equal(info.instructions, null);
    await c.agreement(await f.mcp(), 'hosting_support', {}, info, 'SupportInfo');
    assert.equal(queries.length, absentAccount ? 3 : 1);
    if (!absentAccount) {
      const history = await c.response('/api/v1/contributions', 'get', await f.request('/api/v1/contributions'), 200);
      assert.equal(history.status, 'unconfigured');
    }
  });
});

test('real history handling distinguishes empty, partial and failed reads', async t => {
  for (const mode of ['empty', 'partial', 'unavailable', 'malformed', 'inconsistentTotal', 'missingAttribute'] as const) await t.test(mode, async t => {
    const f = await fixture(t, {}, { getFundingHistory: async () => {
      if (mode === 'unavailable') throw new Error('Fixture history unavailable');
      if (mode === 'empty') return { total: '0', txResponses: [] };
      if (mode === 'malformed') return { total: '1', txResponses: [{}] };
      if (mode === 'inconsistentTotal') return historyPage('0');
      if (mode === 'missingAttribute') {
        const page = historyPage();
        const row = page.txResponses[0] as { events: { attributes: { key: string; value?: string }[] }[] };
        row.events[0]!.attributes.push({ key: 'omitted-value' });
        return page;
      }
      return historyPage('101');
    } });
    const c = await contracts(f);
    const history = await c.response('/api/v1/contributions', 'get', await f.request('/api/v1/contributions'), 200);
    assert.equal(history.status, ['empty', 'partial'].includes(mode) ? 'available' : 'unavailable');
    assert.equal(history.complete, mode === 'empty');
    if (mode === 'empty') assert.deepEqual(history.totals, { amount: '0', tenantAmount: '0', otherAmount: '0' });
    if (mode === 'partial') assert.equal(history.indexedTransactions, 101);
    const name = history.status === 'available' ? mode : 'unavailable';
    assert.equal((c.example('/api/v1/contributions', 'get', 200, name) as ContributionHistory).message, history.message);
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
    assert.deepEqual(c.example('/api/v1/support/verify', 'post', 200,
      scenario.name === 'inconsistent confirmation' ? 'inconsistentTransaction' : scenario.status), verified);
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
function withBody(base: string, path: string, method: string, body: string | Buffer, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, base), { method: method.toUpperCase(), headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers,
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

test('parser encoding errors return sanitized 400/415 responses without logging server failures or serving', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  const logged = t.mock.method(console, 'error', () => {});
  for (const [path, method] of apiOperations) {
    for (const encoding of ['gzip', 'br', 'deflate']) {
      const reply = await withBody(f.base, path, method, 'private-request-marker', { 'Content-Encoding': encoding });
      const body = await c.response(path, method, reply, 400);
      assert.deepEqual(body, { error: API_MESSAGES.malformedBody });
    }
    const unsupported: Record<string, string>[] = [{ 'Content-Encoding': 'unsupported-private-marker' }, { 'Content-Type': 'application/json; charset=iso-8859-1' }];
    for (const headers of unsupported) {
      const reply = await withBody(f.base, path, method, '{}', headers);
      const body = await c.response(path, method, reply, 415);
      assert.deepEqual(body, { error: API_MESSAGES.unsupportedEncoding });
    }
  }
  const compressors = { gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync };
  for (const [encoding, compress] of Object.entries(compressors)) {
    const reply = await withBody(f.base, '/api/v1/amenities', 'get', compress('{}'), { 'Content-Encoding': encoding });
    await c.response('/api/v1/amenities', 'get', reply, 200);
  }
  const oversized = await withBody(f.base, '/api/v1/visits', 'post', gzipSync(JSON.stringify({ seed: 'x'.repeat(9000) })), { 'Content-Encoding': 'gzip' });
  await c.response('/api/v1/visits', 'post', oversized, 413);
  assert.equal(logged.mock.calls.length, 0);
  assert.equal((await (await f.request('/api/v1/stats')).json()).total, '0');
});

test('HTTP routing fallback documents unknown paths and unsupported methods without conflating MCP envelopes', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  for (const [path, method] of [['/unknown', 'GET'], ['/api/v1/visits', 'GET'], ['/healthz', 'POST']]) {
    const reply = await f.request(path!, { method });
    assert.equal(reply.status, 404);
    const body = await reply.json();
    c.validate({ $ref: '#/components/schemas/NotFound' }, body);
    for (const [path, method] of apiOperations) {
      const fallback = c.resolve(c.document.paths[path]![method]!.responses.default!);
      c.validate(fallback.content['application/json']!.schema, body);
    }
    assert.equal(c.ajv.compile({ $ref: '#/components/schemas/Error' })(body), false);
  }
  const mcp = await f.request('/mcp');
  assert.equal(mcp.status, 405);
  assert.equal(mcp.headers.get('allow'), 'POST');
  const body = await mcp.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, null);
  assert.equal(body.error.code, -32000);
  assert.equal(c.ajv.compile({ $ref: '#/components/schemas/HttpError' })(body), false);
});

test('oversized visit results fail before counting over HTTP, HTML and MCP', async t => {
  const f = await fixture(t, { chainId: 'c'.repeat(MAX_VISIT_OUTPUT_BYTES) });
  const c = await contracts(f);
  t.mock.method(console, 'error', () => {});
  const input = { amenity: 'null-tea', seed: 'oversized-output' };
  const error = await c.response('/api/v1/visits', 'post', await f.json('/api/v1/visits', input), 500);
  assert.deepEqual(error, { error: API_MESSAGES.internalError });
  const form = await f.request('/visit', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'amenity=null-tea' });
  assert.equal(form.status, 500);
  assert.deepEqual(await form.json(), error);
  const mcp = await (await f.mcp()).callTool({ name: 'enjoy_amenity', arguments: input });
  assert.equal(mcp.isError, true);
  assert.deepEqual(mcp.content, [{ type: 'text', text: error.error }]);
  assert.equal((await (await f.request('/api/v1/stats')).json()).total, '0');
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
  const available = await c.response('/api/v1/stats', 'get', await f.request('/api/v1/stats'), 200);
  f.closeCounts();
  const statsReply = await f.request('/api/v1/stats');
  assert.equal(statsReply.headers.get('retry-after'), null);
  const stats = await c.response('/api/v1/stats', 'get', statsReply, 503);
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.counts, null);
  assert.equal(stats.total, null);
  assert.equal(stats.since, null);
  c.validate({ $ref: '#/components/schemas/VisitStats' }, stats);
  assert.equal(c.ajv.compile(c.responseContract('/api/v1/stats', 'get', 200).content['application/json']!.schema)(stats), false);
  assert.equal(c.ajv.compile(c.responseContract('/api/v1/stats', 'get', 503).content['application/json']!.schema)(available), false);
  const input = { amenity: 'null-tea', seed: 'failed-storage' };
  const error = await c.response('/api/v1/visits', 'post', await f.json('/api/v1/visits', input), 503);
  const mcp = await client.callTool({ name: 'enjoy_amenity', arguments: input });
  assert.equal(mcp.isError, true);
  assert.deepEqual(mcp.content, [{ type: 'text', text: error.error }]);
  await c.response('/healthz', 'get', await f.request('/healthz'), 200);
});

test('retired deployments publish their own readable contract with only 410 API responses', async t => {
  const retired = await fixture(t, { mainnetOrigin: 'https://mainnet.example' });
  const c = await contracts(retired);
  for (const [path, method] of apiOperations) {
    assert.deepEqual(Object.keys(c.document.paths[path]![method]!.responses), ['410']);
    const reply = await retired.request(path, { method: method.toUpperCase() });
    assert.match(reply.headers.get('link')!, /openapi\.json.*service-desc/);
    const body = await c.response(path, method, reply, 410);
    assert.deepEqual(c.example(path, method, 410, 'retired'), body);
  }
  const health = await c.response('/healthz', 'get', await retired.request('/healthz'), 200);
  assert.equal(health.retired, true);
  assert.deepEqual(c.example('/healthz', 'get', 200, 'current'), health);
  assert.deepEqual(Object.keys(c.document.paths['/healthz']!.get!.responses), ['200']);
});

test('unexpected handler failures use the published 500 contract', async t => {
  const f = await fixture(t);
  const c = await contracts(f);
  t.mock.method(console, 'error', () => {});
  const fail = async () => { throw Object.assign(new Error('Fixture handler failure'), { status: 400 }); };
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
