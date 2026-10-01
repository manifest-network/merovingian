import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PWR_STATION_QA, TEST_USDC, PwrStationClient, StationError,
  type PaymentRequired, type Quote, type StationOrder, type StationSigner,
} from '../scripts/pwr-station-client.js';

// Protocol fixtures only: signatures below are synthetic and cannot authorize a payment.
const wallet = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const creditAddress = 'manifest1u38rpxv2ynqy5fe8xsqyzp6w37qkmdcya9jmuqwfxqxrldru0wrqqd8yzt';
const target = { recipient: creditAddress, chainId: 'manifest-ledger-testnet' as const, denom: 'upwr' };
const now = Date.parse('2026-10-01T00:00:00Z');
const pack = { id: 'apk_fixture', price_cents: 100, fees_cents: 0, net_pwr_base_units: 1000000 };
const quote: Quote = { ...pack, id: 'aqt_fixture', package: pack.id, payment_path: 'x402', recipient: creditAddress,
  total_cents: 100, environment: 'sandbox', chain_id: target.chainId, denom: target.denom, expires_at: '2026-10-01T00:10:00Z' };
const { expires_at: _expiry, ...orderTerms } = quote;
const order: StationOrder = { ...orderTerms, id: 'aor_fixture', quote: quote.id, payment_state: 'awaiting',
  recording_state: 'n_a', delivery_state: 'not_started', refund_state: 'none', next_action: 'retry_same_request',
  payment_deadline: '2026-10-01T00:10:00Z' };
const required: PaymentRequired = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: TEST_USDC,
  amount: '1000000', payTo: '0x' + '11'.repeat(20), maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' } }] };
const delivered = { order: { ...order, payment_state: 'settled', recording_state: 'confirmed', delivery_state: 'confirmed',
  next_action: 'complete' }, receipt: { tx_hash: 'a'.repeat(64), chain_id: target.chainId, denom: target.denom, delivered_base_units: 1000000 } };
const ok = (data: unknown) => Response.json({ success: true, data });
const error = (code: string, status: number) => Response.json({ success: false, error: { code, message: 'private remote details' } }, { status });
const challenge = (header = true) => Response.json({ success: false, error: { code: 'AGENT_PAYMENT_REQUIRED',
  details: { payment_required: required } } }, { status: 402,
  headers: header ? { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') } : {} });

function fixture(responses: (() => Response)[], selectedTarget = target) {
  const calls: { path: string; method: string; body: any; headers: Headers; redirect?: RequestRedirect }[] = [];
  const client = new PwrStationClient(selectedTarget, 100, { now: () => now, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, PWR_STATION_QA);
    calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers), redirect: init?.redirect });
    const next = responses.shift();
    assert.ok(next, 'Unexpected network request');
    return next();
  } });
  return { client, calls };
}

function signedPayment(changes: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: required.accepts[0], payload: {
    signature: '0x' + '55'.repeat(65), authorization: {
      from: '0x' + '22'.repeat(20), to: required.accepts[0]!.payTo, value: '1000000', nonce: '0x' + '33'.repeat(32),
      validAfter: String(now / 1000 - 1), validBefore: String(now / 1000 + 60),
    },
  }, ...changes })).toString('base64');
}

test('authenticates with ADR-036, quotes a 32-byte recipient and follows test-USDC delivery to a receipt', async () => {
  const nonce = 'ab'.repeat(16);
  const f = fixture([
    () => ok({ nonce }), () => ok({ wallet_address: wallet, token: 'fixture-token' }),
    () => ok([pack]), () => ok(quote), () => ok({ order, receipt: null }),
    () => challenge(), () => ok({ order: { ...order, payment_state: 'settled', delivery_state: 'queued', next_action: 'poll' }, receipt: null }),
    () => ok(delivered),
  ]);
  const signedMessages: string[] = [];
  const signer: StationSigner = { getAddress: async () => wallet, signArbitrary: async (address, message) => {
    assert.equal(address, wallet); signedMessages.push(message);
    return { signature: 'fixture-signature', pub_key: { value: 'fixture-pubkey' } };
  } };
  await f.client.login(signer);
  assert.deepEqual(signedMessages, ['powerstation:nonce=' + nonce]);
  assert.deepEqual(await f.client.packages(), [pack]);
  const q = await f.client.quote(pack.id);
  const created = await f.client.createOrder(q, 'persisted-fixture-key');
  const payment = await f.client.paymentRequirements(created.order);
  const settled = await f.client.submitPayment(created.order, payment, signedPayment());
  assert.equal(settled.receipt, null, 'USDC settlement alone does not prove PWR delivery');
  const complete = await f.client.getOrder(settled.order);
  assert.equal(complete.receipt?.tx_hash, 'A'.repeat(64));
  assert.equal(complete.receipt?.delivered_base_units, 1000000);
  assert.deepEqual(f.calls[1]!.body, { address: wallet, message: 'powerstation:nonce=' + nonce,
    signature: 'fixture-signature', pub_key: 'fixture-pubkey' });
  assert.deepEqual(f.calls[3]!.body, { package: pack.id, payment_path: 'x402', recipient: creditAddress });
  assert.deepEqual(f.calls[4]!.body, { quote: q.id, idempotency_key: 'persisted-fixture-key' });
  assert.equal(f.calls[5]!.headers.has('PAYMENT-SIGNATURE'), false);
  assert.equal(f.calls[6]!.headers.get('PAYMENT-SIGNATURE'), signedPayment());
  assert.ok(f.calls.every(c => c.redirect === 'error'));
  assert.ok(f.calls.slice(2).every(c => c.headers.get('Authorization') === 'Bearer fixture-token'));
});

test('unknown outcomes recover the same order and replay the exact authorization, without automatic retries', async () => {
  const pending = { ...order, payment_state: 'outcome_unknown', next_action: 'poll' } as StationOrder;
  const uncertain = () => { throw new Error('private payment diagnostics'); };
  const f = fixture([uncertain, () => ok({ order, receipt: null }), () => challenge(false), uncertain,
    () => ok({ order: pending, receipt: null }), () => ok(delivered)]);
  await assert.rejects(f.client.createOrder(quote, 'durable-key'), { code: 'REQUEST_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.length, 1);
  const recovered = await f.client.createOrder(quote, 'durable-key');
  assert.deepEqual(f.calls[0]!.body, f.calls[1]!.body);
  const payment = await f.client.paymentRequirements(recovered.order);
  const exactAuthorization = signedPayment();
  await assert.rejects(f.client.submitPayment(recovered.order, payment, exactAuthorization), { code: 'REQUEST_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.length, 4);
  const polled = await f.client.getOrder(recovered.order);
  await assert.rejects(f.client.paymentRequirements(polled.order), { code: 'POLL_ORDER_BEFORE_PAYING' });
  const result = await f.client.submitPayment(polled.order, payment, exactAuthorization);
  assert.equal(result.receipt?.delivered_base_units, 1000000);
  assert.equal(f.calls[3]!.headers.get('PAYMENT-SIGNATURE'), f.calls[5]!.headers.get('PAYMENT-SIGNATURE'));
  assert.equal(f.calls.filter(c => c.path.includes('/quotes')).length, 0);
});

test('a previously submitted order can be recovered after its quote expires', async () => {
  const f = fixture([() => ok({ order, receipt: null })]);
  const result = await f.client.createOrder({ ...quote, expires_at: '2026-09-30T00:00:00Z' }, 'persisted-key');
  assert.equal(result.order.id, order.id);
});

test('QA origin and sandbox flags never authorize Base mainnet, another token or extra spend', () => {
  const f = fixture([]);
  for (const patch of [
    { network: 'eip155:8453' }, { asset: '0x' + '44'.repeat(20) }, { scheme: 'upto' },
    { extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2' } },
    { extra: { assetTransferMethod: 'permit2', name: 'USDC', version: '2' } },
    { amount: '1000001' }, { maxTimeoutSeconds: 301 }, { payTo: 'bad' },
  ]) {
    assert.throws(() => f.client.validatePayment({ ...required, accepts: [{ ...required.accepts[0], ...patch }] }, order), StationError);
  }
  assert.throws(() => f.client.validatePayment({ ...required, x402Version: 1 }, order), StationError);
  assert.throws(() => f.client.validatePayment({ ...required, accepts: [required.accepts[0], required.accepts[0]] }, order), StationError);
  assert.throws(() => new PwrStationClient({ ...target, chainId: 'manifest-ledger-mainnet' as any }, 100), { code: 'TESTNET_REQUIRED' });
  assert.equal(f.calls.length, 0);
});

test('rejects wrong recipient, chain, token, expired quotes and amounts beyond the caller budget', async () => {
  for (const patch of [
    { recipient: wallet }, { chain_id: 'manifest-ledger-mainnet' }, { denom: 'umfx' }, { environment: 'production' },
    { total_cents: 101, fees_cents: 1 }, { net_pwr_base_units: 0 }, { price_cents: 99 },
    { expires_at: '2026-09-30T00:00:00Z' }, { package: 'apk_different' }, { payment_path: 'checkout' },
  ]) {
    const f = fixture([() => ok({ ...quote, ...patch })]);
    await assert.rejects(f.client.quote(pack.id), StationError);
    assert.equal(f.calls.length, 1, 'No fallback creates an order or changes the recipient');
  }
});

test('provider payout recipient is kept distinct from the credit recipient', async () => {
  const f = fixture([() => ok({ ...quote, recipient: wallet })], { ...target, recipient: wallet });
  assert.equal((await f.client.quote(pack.id)).recipient, wallet);
  assert.equal(f.calls[0]!.body.recipient, wallet);
});

test('refunded completion is not delivery; mismatched orders or receipts never become confirmation', async () => {
  const refund = fixture([() => ok({ order: { ...order, payment_state: 'settled', refund_state: 'succeeded', next_action: 'complete' }, receipt: null })]);
  assert.equal((await refund.client.getOrder(order)).receipt, null);
  for (const data of [
    { order: delivered.order, receipt: null },
    { ...delivered, receipt: { ...delivered.receipt, delivered_base_units: 999999 } },
    { ...delivered, receipt: { ...delivered.receipt, chain_id: 'manifest-ledger-mainnet' } },
    { ...delivered, order: { ...delivered.order, recipient: wallet } },
    { ...delivered, order: { ...delivered.order, id: 'aor_different' } },
    { ...delivered, order: { ...delivered.order, quote: 'aqt_different' } },
    { ...delivered, order: { ...delivered.order, refund_state: 'pending' } },
    { ...delivered, order: { ...delivered.order, payment_state: 'outcome_unknown' } },
  ]) await assert.rejects(fixture([() => ok(data)]).client.getOrder(order), StationError);
});

test('signed authorization must match the exact approved test-USDC terms before transport', async () => {
  const f = fixture([]);
  const original = JSON.parse(Buffer.from(signedPayment(), 'base64').toString('utf8'));
  for (const changes of [
    { accepted: { ...required.accepts[0], network: 'eip155:8453' } },
    { accepted: { ...required.accepts[0], extra: { name: 'Different', version: '2' } } },
    { payload: { ...original.payload, authorization: { ...original.payload.authorization, value: '2000000' } } },
    { payload: { ...original.payload, authorization: { ...original.payload.authorization, validBefore: String(now / 1000 + 301) } } },
    { payload: { ...original.payload, authorization: { ...original.payload.authorization, nonce: 'bad' } } },
  ]) await assert.rejects(f.client.submitPayment(order, required, signedPayment(changes)), StationError);
  await assert.rejects(f.client.paymentRequirements({ ...order, payment_deadline: '2026-09-30T00:00:00Z' }), { code: 'ORDER_EXPIRED' });
  assert.equal(f.calls.length, 0);
});

test('upstream blockers and malformed responses expose stable codes without remote secrets', async () => {
  for (const [code, status] of [['AGENT_X402_UNAVAILABLE', 501], ['WALLET_ADDRESS_INVALID', 400]] as const) {
    const f = fixture([() => error(code, status)]);
    await assert.rejects(f.client.quote(pack.id), { code, status, message: code });
    assert.equal(f.calls.length, 1);
  }
  await assert.rejects(fixture([() => error('private remote detail', 500)]).client.quote(pack.id), { message: 'STATION_UNAVAILABLE' });
  await assert.rejects(fixture([() => new Response('<html>private details</html>')]).client.packages(), { message: 'REQUEST_OUTCOME_UNKNOWN' });
  await assert.rejects(fixture([() => new Response(' '.repeat(256 * 1024 + 1))]).client.packages(), { message: 'RESPONSE_TOO_LARGE' });
});
