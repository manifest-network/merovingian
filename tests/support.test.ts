import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { liftedinit } from '@manifest-network/manifestjs';
import { TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import {
  FUND_CREDIT_TYPE, SupportService,
  type ChainGateway, type ChainTransaction, type FundingHistoryPage, type SupportConfig,
} from '../src/support.js';

const tenant = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';
const sender = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const config: SupportConfig = {
  network: 'testnet', chainId: 'manifest-testnet-1', rpcUrl: 'https://rpc.example.com',
  gasPrice: '1umfx', pwrDenom: 'upwr', tenant,
};

function funding(overrides: { sender?: string; tenant?: string; denom?: string; amount?: string; typeUrl?: string } = {}) {
  return {
    typeUrl: overrides.typeUrl ?? FUND_CREDIT_TYPE,
    value: liftedinit.billing.v1.MsgFundCredit.encode({
      sender: overrides.sender ?? sender,
      tenant: overrides.tenant ?? tenant,
      amount: { denom: overrides.denom ?? 'upwr', amount: overrides.amount ?? '1000000' },
    }).finish(),
  };
}

function transaction(messages = [funding()], signatures = [new Uint8Array([1, 2, 3])]): ChainTransaction {
  // Fixture bytes model an already indexed transaction; the chain is the signature authority.
  const bytes = TxRaw.encode(TxRaw.fromPartial({
    bodyBytes: TxBody.encode(TxBody.fromPartial({ messages })).finish(), signatures,
  })).finish();
  return { hash: createHash('sha256').update(bytes).digest('hex').toUpperCase(), height: '1542', code: 0, bytes };
}

function fixture(tx: ChainTransaction | null = transaction(), overrides: Partial<ChainGateway> = {}, options = {}) {
  let reads = 0;
  const gateway: ChainGateway = {
    getChainId: async () => { reads++; return config.chainId; },
    getTransaction: async () => tx,
    getCredit: async () => ({ available: [{ denom: 'upwr', amount: '2200' }], reserved: [], activeLeases: '1' }),
    ...overrides,
  };
  return { service: new SupportService(config, gateway, options), reads: () => reads, gateway };
}

test('confirms matching signed credit message with a deterministic network-scoped public receipt', async () => {
  const tx = transaction();
  const { service } = fixture(tx);
  const first = await service.verify({ transactionHash: tx.hash });
  assert.equal(first.status, 'confirmed');
  if (first.status !== 'confirmed') return;
  assert.equal(first.receipt.amount.amount, '1000000');
  assert.equal(first.receipt.amount.denom, 'upwr');
  assert.deepEqual(first.receipt.contributions, [{ sender, amount: '1000000' }]);
  assert.equal(first.receipt.transferable, false);
  assert.equal(first.receipt.provesOwnership, false);
  assert.match(first.receipt.id, /^merovingian:testnet:manifest-testnet-1:/);
  assert.deepEqual(await service.verify({ transactionHash: tx.hash.toLowerCase() }), first);
  assert.deepEqual(await service.verify({ transactionHash: tx.hash, expectedSender: sender }), first);
  const mainnet = new SupportService({ ...config, network: 'mainnet' }, fixture(tx).gateway);
  const other = await mainnet.verify({ transactionHash: tx.hash });
  assert.equal(other.status, 'confirmed');
  if (other.status === 'confirmed') assert.notEqual(other.receipt.id, first.receipt.id);
});

test('sums matching messages exactly above Number.MAX_SAFE_INTEGER and separates senders', async () => {
  const tx = transaction([
    funding({ amount: '9007199254740993' }), funding({ amount: '2' }),
    funding({ sender: tenant, amount: '4' }),
    funding({ denom: 'umfx', amount: '5000' }), funding({ tenant: sender, amount: '5000' }),
  ]);
  const { service } = fixture(tx);
  const result = await service.verify({ transactionHash: tx.hash });
  assert.equal(result.status, 'confirmed');
  if (result.status !== 'confirmed') return;
  assert.equal(result.receipt.amount.amount, '9007199254740999');
  assert.deepEqual(result.receipt.contributions, [
    { sender, amount: '9007199254740995' }, { sender: tenant, amount: '4' },
  ]);
  assert.deepEqual(await service.verify({ transactionHash: tx.hash, expectedSender: tenant }), result);
});

test('unindexed hash is uncertain, failed transaction gets no receipt', async () => {
  const absent = await fixture(null).service.verify({ transactionHash: 'A'.repeat(64) });
  assert.equal(absent.status, 'pending');
  assert.ok(!('receipt' in absent));
  const tx = { ...transaction(), code: 7 };
  assert.equal((await fixture(tx).service.verify({ transactionHash: tx.hash })).status, 'failed');
});

test('rejects wrong tenant, token, message, sender and nested authz funding', async () => {
  for (const message of [
    funding({ tenant: sender }), funding({ denom: 'umfx' }),
    funding({ typeUrl: '/cosmos.bank.v1beta1.MsgSend' }),
    funding({ typeUrl: '/cosmos.authz.v1beta1.MsgExec' }), funding({ sender: 'invalid-sender' }),
  ]) {
    const tx = transaction([message]);
    const result = await fixture(tx).service.verify({ transactionHash: tx.hash });
    assert.equal(result.status, 'not_a_contribution');
    assert.ok(!('receipt' in result));
  }
  const tx = transaction();
  assert.equal((await fixture(tx).service.verify({ transactionHash: tx.hash, expectedSender: tenant })).status, 'not_a_contribution');
});

test('rejects nonpositive, malformed, fractional, overly large and noncanonical integers', async () => {
  for (const amount of ['0', '-1', '+1', '01', '1.0', '1e6', '', 'NaN', '9'.repeat(79)]) {
    const tx = transaction([funding({ amount })]);
    assert.equal((await fixture(tx).service.verify({ transactionHash: tx.hash })).status, 'not_a_contribution', amount);
  }
});

test('rejects unsigned transactions and malformed signed protobuf', async () => {
  const unsigned = transaction([funding()], []);
  assert.equal((await fixture(unsigned).service.verify({ transactionHash: unsigned.hash })).status, 'not_a_contribution');
  const tx = transaction([{ typeUrl: FUND_CREDIT_TYPE, value: new Uint8Array([255]) }]);
  assert.equal((await fixture(tx).service.verify({ transactionHash: tx.hash })).status, 'not_a_contribution');
});

test('rejects incomplete inclusion or mismatched transaction bytes', async () => {
  const original = transaction();
  for (const patch of [
    { height: '0' }, { height: '-1' }, { height: 'not-height' }, { code: NaN },
    { code: -1 }, { hash: 'B'.repeat(64) }, { bytes: new Uint8Array([4, 5]) },
  ]) {
    const tx = { ...original, ...patch };
    assert.equal((await fixture(tx).service.verify({ transactionHash: original.hash })).status, 'unavailable');
  }
});

test('validates input before querying; unconfigured service leaves free visits independent', async () => {
  const f = fixture();
  for (const hash of ['', 'A'.repeat(63), 'A'.repeat(65), 'g'.repeat(64), ` ${'A'.repeat(64)}`, 'https://evil.example']) {
    assert.equal((await f.service.verify({ transactionHash: hash })).status, 'invalid_request');
  }
  assert.equal(f.reads(), 0);
  const unconfigured = new SupportService({ ...config, tenant: '' }, f.gateway);
  assert.equal((await unconfigured.getInfo()).status, 'unconfigured');
  assert.equal((await unconfigured.verify({ transactionHash: 'A'.repeat(64) })).status, 'unconfigured');
  assert.equal(f.reads(), 0);
});

test('wrong network and provider errors never confirm or expose contribution instructions', async () => {
  for (const gateway of [
    { getChainId: async () => 'other-chain' },
    { getChainId: async () => { throw new Error('secret endpoint error'); } },
    { getTransaction: async () => { throw new Error('unavailable'); } },
  ]) {
    const tx = transaction();
    const f = fixture(tx, gateway);
    const result = await f.service.verify({ transactionHash: tx.hash });
    assert.equal(result.status, 'unavailable');
    assert.ok(!JSON.stringify(result).includes('secret'));
    const info = await f.service.getInfo();
    assert.equal(info.status, 'unavailable');
    assert.equal(info.instructions, null);
  }
});

test('caches support queries and returns independent copies of available credit', async () => {
  let now = 1_000_000;
  const f = fixture(transaction(), {}, { now: () => now, cacheMs: 100 });
  const [a, b] = await Promise.all([f.service.getInfo(), f.service.getInfo()]);
  assert.equal(f.reads(), 1);
  assert.equal(a.status, 'available');
  assert.equal(a.testTokensOnly, true);
  assert.equal(a.instructions?.value.amount.denom, 'upwr');
  a.hostingCredit!.available[0]!.amount = '999';
  assert.equal(b.hostingCredit!.available[0]!.amount, '2200');
  assert.equal((await f.service.getInfo()).hostingCredit!.available[0]!.amount, '2200');
  now += 101;
  await f.service.getInfo();
  assert.equal(f.reads(), 2);
});

test('outages time out quickly and open a circuit instead of repeating chain requests', async () => {
  let reads = 0;
  const f = fixture(transaction(), {
    getChainId: async (signal) => {
      reads++;
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  }, { timeoutMs: 15, circuitMs: 1000 });
  const start = Date.now();
  assert.equal((await f.service.getInfo()).status, 'unavailable');
  assert.ok(Date.now() - start < 1000);
  assert.equal((await f.service.verify({ transactionHash: 'A'.repeat(64) })).status, 'unavailable');
  assert.equal(reads, 1);
});

test('published SDK gateway recognizes CometBFT absent transaction despite HTTP 500', async (context) => {
  const hash = 'A'.repeat(64);
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/status')) return Response.json({ result: { node_info: { network: config.chainId } } });
    if (url.endsWith('/node_info')) return Response.json({ default_node_info: { network: config.chainId } });
    assert.ok(url.includes(`tx?hash=0x${hash}`));
    return Response.json({ jsonrpc: '2.0', id: -1, error: {
      code: -32603, message: 'Internal error', data: `tx (${hash}) not found`,
    } }, { status: 500 });
  });
  const service = new SupportService({ ...config, restUrl: 'https://rest.example.com' });
  try {
    assert.equal((await service.verify({ transactionHash: hash })).status, 'pending');
  } finally {
    service.dispose();
  }
});

test('published SDK gateway stops oversized chain streams before parsing', async (context) => {
  let cancelled = false;
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1_100_000)); },
    cancel() { cancelled = true; },
  })));
  const service = new SupportService({ ...config, restUrl: 'https://rest.example.com' });
  try {
    assert.equal((await service.verify({ transactionHash: 'A'.repeat(64) })).status, 'unavailable');
    assert.equal(cancelled, true);
  } finally {
    service.dispose();
  }
});

function historyMessage(overrides: Record<string, unknown> = {}) {
  return { '@type': FUND_CREDIT_TYPE, sender, tenant, amount: { denom: 'upwr', amount: '10' }, ...overrides };
}

function historyEvent(overrides: Record<string, string> = {}) {
  const attributes = { tenant, sender, amount: '10upwr', credit_address: tenant, new_balance: '10000000upwr', ...overrides };
  return { type: 'credit_funded', attributes: Object.entries(attributes).map(([key, value]) => ({ key, value, index: true })) };
}

function historyRecord(id: number, messages = [historyMessage()], overrides: Record<string, unknown> = {}) {
  const events = messages.filter((message) => message['@type'] === FUND_CREDIT_TYPE).map((message) => {
    const coin = message.amount as { amount: string; denom: string };
    return historyEvent({ tenant: String(message.tenant), sender: String(message.sender), amount: `${coin.amount}${coin.denom}`, new_balance: `10000000${coin.denom}` });
  });
  return {
    txhash: id.toString(16).padStart(64, '0').toUpperCase(), height: String(1000 + id), code: 0,
    timestamp: '2026-09-17T16:53:10Z', tx: { '@type': '/cosmos.tx.v1beta1.Tx', body: { messages } }, events, ...overrides,
  };
}

function historyFixture(page: FundingHistoryPage, overrides: Partial<ChainGateway> = {}, options = {}) {
  const f = fixture(null, { getFundingHistory: async () => page, ...overrides });
  return { ...f, service: new SupportService({ ...config, restUrl: 'https://rest.example.com' }, f.gateway, options) };
}

test('history aggregates matching senders exactly and excludes failed, wrong-denom, other-tenant and other messages', async () => {
  const rows = [
    historyRecord(1, [historyMessage({ amount: { denom: 'upwr', amount: '9007199254740993' } }),
      historyMessage({ amount: { denom: 'upwr', amount: '2' } }), historyMessage({ sender: tenant })]),
    historyRecord(2, [historyMessage()], { code: 7 }),
    historyRecord(3, [historyMessage({ amount: { denom: 'umfx', amount: '50000' } })]),
    historyRecord(4, [historyMessage({ tenant: sender })]),
    historyRecord(5, [historyMessage({ '@type': '/cosmos.authz.v1beta1.MsgExec' })], {
      events: [historyEvent({ amount: '20umfx', new_balance: '100umfx' }), { type: 'transfer', attributes: [] }],
    }),
  ];
  const result = await historyFixture({ total: '5', txResponses: rows }).service.getHistory();
  assert.equal(result.status, 'available');
  assert.equal(result.complete, true);
  assert.equal(result.scannedTransactions, 5);
  assert.equal(result.indexedTransactions, 5);
  assert.deepEqual(result.totals, { amount: '9007199254741005', tenantAmount: '10', otherAmount: '9007199254740995' });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map((entry) => [entry.sender, entry.amount]), [[sender, '9007199254740995'], [tenant, '10']]);
  assert.equal(result.entries[0]!.timestamp, '2026-09-17T16:53:10Z');
});

test('history deduplicates identical hashes without inflating totals, rejects conflicting duplicate bodies', async () => {
  const row = historyRecord(1);
  const result = await historyFixture({ total: '1', txResponses: [row, structuredClone(row)] }).service.getHistory();
  assert.equal(result.status, 'available');
  assert.equal(result.entries.length, 1);
  assert.equal(result.totals?.amount, '10');
  assert.equal(result.scannedTransactions, 1);
  assert.equal(result.complete, true);
  const duplicatePage = await historyFixture({ total: '2', txResponses: [row, structuredClone(row)] }).service.getHistory();
  assert.equal(duplicatePage.complete, false);
  assert.equal(duplicatePage.scannedTransactions, 1);
  const conflicting = await historyFixture({ total: '1', txResponses: [row,
    historyRecord(1, [historyMessage({ amount: { denom: 'upwr', amount: '20' } })]),
  ] }).service.getHistory();
  assert.equal(conflicting.status, 'unavailable');
  assert.equal(conflicting.totals, null);
  assert.deepEqual(conflicting.entries, []);
  const conflictingEvents = await historyFixture({ total: '1', txResponses: [row,
    historyRecord(1, undefined, { events: [historyEvent({ amount: '20upwr' })] }),
  ] }).service.getHistory();
  assert.equal(conflictingEvents.status, 'unavailable');
  assert.equal(conflictingEvents.totals, null);
});

test('history includes executed authz and group funding events without requiring direct message bodies', async () => {
  const authz = historyRecord(1, [historyMessage({ '@type': '/cosmos.authz.v1beta1.MsgExec', msgs: [historyMessage()] })], {
    events: [historyEvent()],
  });
  const group = historyRecord(2, [historyMessage({ '@type': '/cosmos.group.v1.MsgExec', proposal_id: '42', executor: sender })], {
    events: [historyEvent({ sender: tenant, amount: '25upwr' })],
  });
  const result = await historyFixture({ total: '2', txResponses: [authz, group] }).service.getHistory();
  assert.equal(result.status, 'available');
  assert.equal(result.complete, true);
  assert.deepEqual(result.totals, { amount: '35', tenantAmount: '25', otherAmount: '10' });
  assert.equal(result.entries.length, 2);
});

test('history accepts canonical-equivalent uppercase wire addresses and a real 32-byte credit address', async () => {
  const row = historyRecord(1, [historyMessage({ sender: sender.toUpperCase(), tenant: tenant.toUpperCase() })], {
    events: [historyEvent({ credit_address: 'manifest1u38rpxv2ynqy5fe8xsqyzp6w37qkmdcya9jmuqwfxqxrldru0wrqqd8yzt' })],
  });
  const result = await historyFixture({ total: '1', txResponses: [row] }).service.getHistory();
  assert.equal(result.status, 'available');
  assert.equal(result.entries[0]!.sender, sender);
  assert.equal(result.totals?.amount, '10');
});

test('history counts legitimate identical funding events, ignores logs and never sums new_balance', async () => {
  const events = [historyEvent(), historyEvent(), { type: 'transfer', attributes: [{ key: 'amount', value: '9999upwr' }] }];
  const row = historyRecord(1, [historyMessage({ '@type': '/cosmos.authz.v1beta1.MsgExec' })], {
    events, logs: [{ events }],
  });
  const result = await historyFixture({ total: '1', txResponses: [row] }).service.getHistory();
  assert.equal(result.status, 'available');
  assert.equal(result.entries.length, 1);
  assert.equal(result.totals?.amount, '20');
});

test('history fails closed for absent events, body/event disagreement and malformed critical event attributes', async () => {
  const malformed = [
    undefined, [], [{ type: 'transfer', attributes: [] }], [historyEvent({ amount: '20upwr' })],
    [historyEvent({ amount: '0upwr' })], [historyEvent({ amount: '-1upwr' })],
    [historyEvent({ amount: '1.5upwr' })], [historyEvent({ amount: '10upwr,20umfx' })],
    [historyEvent({ sender: 'bad' })], [historyEvent({ credit_address: 'bad' })],
    [historyEvent({ new_balance: '100umfx' })],
  ];
  for (const key of ['tenant', 'sender', 'amount', 'credit_address', 'new_balance']) {
    const event = historyEvent();
    malformed.push([{ ...event, attributes: event.attributes.filter((attribute) => attribute.key !== key) }]);
    malformed.push([{ ...event, attributes: [...event.attributes, event.attributes.find((attribute) => attribute.key === key)!] }]);
  }
  for (const events of malformed) {
    const result = await historyFixture({ total: '1', txResponses: [historyRecord(1, undefined, { events })] }).service.getHistory();
    assert.equal(result.status, 'unavailable', JSON.stringify(events));
    assert.equal(result.totals, null);
    assert.equal(result.complete, false);
  }
});

test('history states that a latest-100 page is partial and totals only returned entries', async () => {
  const page = { total: '105', txResponses: Array.from({ length: 100 }, (_, i) => historyRecord(i + 1)) };
  const result = await historyFixture(page).service.getHistory();
  assert.equal(result.status, 'available');
  assert.equal(result.complete, false);
  assert.equal(result.scannedTransactions, 100);
  assert.equal(result.indexedTransactions, 105);
  assert.equal(result.totals?.amount, '1000');
  assert.match(result.message, /Partial history/);
  assert.match(result.message, /only the returned rows/);
  assert.equal(result.entries[0]!.height, '1100');
});

test('history returns zeros only for a successfully verified empty or non-PWR history', async () => {
  const empty = await historyFixture({ total: '0', txResponses: [] }).service.getHistory();
  assert.equal(empty.status, 'available');
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.totals, { amount: '0', tenantAmount: '0', otherAmount: '0' });
  const missing = await historyFixture({ total: '2', txResponses: [] }).service.getHistory();
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.totals, null);
  const unrelated = await historyFixture({ total: '1', txResponses: [historyRecord(1, [historyMessage({ tenant: sender })])] }).service.getHistory();
  assert.equal(unrelated.status, 'available');
  assert.equal(unrelated.totals?.amount, '0');
});

test('history rejects malformed committed records and inconsistent page totals without claiming zero funds', async () => {
  for (const patch of [
    { txhash: 'bad' }, { height: '0' }, { height: '2.2' }, { code: '0' }, { code: -1 },
    { timestamp: 'not-a-date' }, { timestamp: '2026-02-31T16:53:10Z' },
    { tx: { '@type': '/wrong.Tx', body: { messages: [] } } },
  ]) {
    const result = await historyFixture({ total: '1', txResponses: [historyRecord(1, undefined, patch)] }).service.getHistory();
    assert.equal(result.status, 'unavailable', JSON.stringify(patch));
    assert.equal(result.complete, false);
    assert.equal(result.totals, null);
  }
  for (const message of [historyMessage({ sender: 'bad' }), historyMessage({ amount: { denom: 'upwr', amount: '0' } }),
    historyMessage({ amount: { denom: 'upwr', amount: '-1' } }), historyMessage({ amount: { denom: 'upwr', amount: '1.5' } })]) {
    const result = await historyFixture({ total: '1', txResponses: [historyRecord(1, [message])] }).service.getHistory();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.totals, null);
  }
  for (const total of ['0', '-1', '01', '9007199254740992']) {
    assert.equal((await historyFixture({ total, txResponses: [historyRecord(1)] }).service.getHistory()).status, 'unavailable');
  }
});

test('history caches and coalesces queries, returns independent snapshots, refreshes after expiry', async () => {
  let now = 1_000_000;
  let calls = 0;
  const page = { total: '1', txResponses: [historyRecord(1)] };
  const f = historyFixture(page, { getFundingHistory: async () => { calls++; return page; } }, { now: () => now, cacheMs: 100 });
  const [a, b] = await Promise.all([f.service.getHistory(), f.service.getHistory()]);
  assert.equal(calls, 1);
  assert.equal(f.reads(), 1);
  a.entries[0]!.amount = '9999';
  assert.equal(b.entries[0]!.amount, '10');
  assert.equal((await f.service.getHistory()).entries[0]!.amount, '10');
  assert.equal(calls, 1);
  now += 101;
  await f.service.getHistory();
  assert.equal(calls, 2);
});

test('history missing configuration, chain mismatches and outages return no totals and no success claim', async () => {
  const f = fixture();
  assert.equal((await f.service.getHistory()).status, 'unconfigured');
  assert.equal(f.reads(), 0);
  for (const overrides of [
    { getChainId: async () => 'wrong-chain' },
    { getFundingHistory: async () => { throw new Error('private error'); } },
    { getFundingHistory: undefined },
  ]) {
    const failing = historyFixture({ total: '1', txResponses: [historyRecord(1)] }, overrides);
    const result = await failing.service.getHistory();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.totals, null);
    assert.equal(result.indexedTransactions, null);
    assert.equal(result.checkedAt, null);
    assert.equal(result.complete, false);
    assert.ok(!JSON.stringify(result).includes('private error'));
  }
});

test('history timeout and circuit keep chain outages bounded', async () => {
  let calls = 0;
  const f = historyFixture({ total: '0', txResponses: [] }, {
    getFundingHistory: async (_tenant, signal) => {
      calls++;
      return new Promise<FundingHistoryPage>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  }, { timeoutMs: 15, circuitMs: 1000 });
  assert.equal((await f.service.getHistory()).status, 'unavailable');
  assert.equal((await f.service.getHistory()).totals, null);
  assert.equal(calls, 1);
});

test('published SDK gateway uses only the fixed tenant history query and validates live network identities', async (context) => {
  let queries = 0;
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/status')) return Response.json({ result: { node_info: { network: config.chainId } } });
    if (url.pathname.endsWith('/node_info')) return Response.json({ default_node_info: { network: config.chainId } });
    assert.equal(url.origin, 'https://rest.example.com');
    assert.equal(url.pathname, '/cosmos/tx/v1beta1/txs');
    assert.equal(url.searchParams.get('query'), `credit_funded.tenant='${tenant}'`);
    assert.equal(url.searchParams.get('order_by'), 'ORDER_BY_DESC');
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('page'), '1');
    queries++;
    return Response.json({ total: '1', tx_responses: [historyRecord(1)] });
  });
  const service = new SupportService({ ...config, restUrl: 'https://rest.example.com' });
  try {
    assert.equal((await service.getHistory()).totals?.amount, '10');
    assert.equal(queries, 1);
  } finally { service.dispose(); }
});
