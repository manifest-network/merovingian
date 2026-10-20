import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  PwrStationClient, StationError,
  type PaymentRequired, type PurchaseTarget, type Quote, type StationOrder, type StationSigner,
} from '../scripts/pwr-station-client.js';
import { PWR_STATION_PROFILES, type PwrStationNetwork } from '../scripts/pwr-station-config.js';

// Protocol fixtures only: signatures below are synthetic and cannot authorize a payment.
const wallet = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const creditAddress = 'manifest1u38rpxv2ynqy5fe8xsqyzp6w37qkmdcya9jmuqwfxqxrldru0wrqqd8yzt';
const target = { recipient: creditAddress, chainId: 'manifest-ledger-testnet' as const,
  denom: 'factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr' };
const now = Date.parse('2026-10-01T00:00:00Z');
const pack = { id: 'apk_fixture', price_cents: 100, fees_cents: 0, net_pwr_base_units: 1000000 };
const quote: Quote = { ...pack, id: 'aqt_fixture', package: pack.id, payment_path: 'x402', recipient: creditAddress,
  total_cents: 100, environment: 'sandbox', chain_id: target.chainId, denom: target.denom, expires_at: '2026-10-01T00:10:00Z' };
const { expires_at: _expiry, ...orderTerms } = quote;
const order: StationOrder = { ...orderTerms, id: 'aor_fixture', quote: quote.id, payment_state: 'awaiting',
  recording_state: 'n_a', delivery_state: 'not_started', refund_state: 'none', next_action: 'retry_same_request',
  payment_deadline: '2026-10-01T00:10:00Z' };
const required: PaymentRequired = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:84532',
  asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  amount: '1000000', payTo: '0x' + '11'.repeat(20), maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' } }] };
const delivered = { order: { ...order, payment_state: 'settled', recording_state: 'confirmed', delivery_state: 'confirmed',
  next_action: 'complete' }, receipt: { tx_hash: 'a'.repeat(64), chain_id: target.chainId, denom: target.denom, delivered_base_units: 1000000 } };
// Independent wire fixtures pin the documented production terms, rather than
// obtaining expected network/token/domain values from the configuration under test.
const mainnetTarget: PurchaseTarget = { ...target, chainId: 'manifest-ledger-mainnet' };
const mainnetQuote: Quote = { ...quote, environment: 'production', chain_id: mainnetTarget.chainId };
const mainnetOrder: StationOrder = { ...order, environment: 'production', chain_id: mainnetTarget.chainId };
const mainnetRequired: PaymentRequired = { ...required, accepts: [{ ...required.accepts[0]!,
  network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2' } }] };
const mainnetDelivered = { order: { ...delivered.order, environment: 'production', chain_id: mainnetTarget.chainId },
  receipt: { ...delivered.receipt, chain_id: mainnetTarget.chainId } };
const scenarios = [
  { network: 'testnet' as const, target, quote, order, required, delivered },
  { network: 'mainnet' as const, target: mainnetTarget, quote: mainnetQuote, order: mainnetOrder,
    required: mainnetRequired, delivered: mainnetDelivered },
];
const ok = (data: unknown) => Response.json({ success: true, data });
const error = (code: string, status: number) => Response.json({ success: false, error: { code, message: 'private remote details' } }, { status });
const challenge = (header = true, payment = required) => Response.json({ success: false, error: { code: 'AGENT_PAYMENT_REQUIRED',
  details: { payment_required: payment } } }, { status: 402,
  headers: header ? { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(payment)).toString('base64') } : {} });

const transportChecks: (() => void)[] = [];
afterEach(() => { for (const check of transportChecks.splice(0)) check(); });

function fixture(responses: (() => Response | Promise<Response>)[], selectedTarget: PurchaseTarget = target,
  clock = () => now, maxOrderCents = 100, network?: PwrStationNetwork) {
  const violations: string[] = [];
  transportChecks.push(() => {
    assert.deepEqual(violations, [], 'Transport assertions must escape the client error sanitizer');
    assert.equal(responses.length, 0, 'Expected transport calls were skipped');
  });
  const calls: { path: string; method: string; body: any; headers: Headers; redirect?: RequestRedirect }[] = [];
  const client = new PwrStationClient(selectedTarget, maxOrderCents, { network, now: clock, fetch: async (input, init) => {
    const url = new URL(String(input));
    const expectedOrigin = network === 'mainnet' ? 'https://pwr-station.com' : 'https://testnet.pwr-station.com';
    if (url.origin !== expectedOrigin) violations.push('Wrong origin');
    if (init?.redirect !== 'error') violations.push('Redirects were allowed');
    calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers), redirect: init?.redirect });
    const next = responses.shift();
    if (!next) { violations.push('Unexpected network request'); throw new Error('Unexpected network request'); }
    return next();
  } });
  return { client, calls };
}

function signedPayment(changes: Record<string, unknown> = {}, payment = required) {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: payment.accepts[0], payload: {
    signature: '0x' + '55'.repeat(65), authorization: {
      from: '0x' + '22'.repeat(20), to: payment.accepts[0]!.payTo, value: payment.accepts[0]!.amount, nonce: '0x' + '33'.repeat(32),
      validAfter: String(now / 1000 - 1), validBefore: String(now / 1000 + 60),
    },
  }, ...changes })).toString('base64');
}

for (const scenario of scenarios) {
  test(`${scenario.network}: authenticates with ADR-036, quotes a 32-byte recipient and follows USDC delivery to a receipt`, async () => {
    const { target, quote, order, required, delivered } = scenario;
    const signed = signedPayment({}, required);
    const nonce = 'ab'.repeat(16);
    const f = fixture([
      () => ok({ nonce }), () => ok({ wallet_address: wallet, token: 'fixture-token' }),
      () => ok([pack]), () => ok(quote), () => ok({ order, receipt: null }),
      () => challenge(true, required), () => ok({ order: { ...order, payment_state: 'settled', delivery_state: 'queued', next_action: 'poll' }, receipt: null }),
      () => ok(delivered),
    ], target, () => now, 100, scenario.network);
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
    const settled = await f.client.submitPayment(created.order, payment, signed);
    assert.equal(settled.receipt, null, 'USDC settlement alone does not prove PWR delivery');
    const complete = await f.client.getOrder(settled.order);
    assert.equal(complete.receipt?.tx_hash, 'A'.repeat(64));
    assert.equal(complete.receipt?.delivered_base_units, 1000000);
    assert.deepEqual(f.calls[1]!.body, { address: wallet, message: 'powerstation:nonce=' + nonce,
      signature: 'fixture-signature', pub_key: 'fixture-pubkey' });
    assert.deepEqual(f.calls[3]!.body, { package: pack.id, payment_path: 'x402', recipient: creditAddress });
    assert.deepEqual(f.calls[4]!.body, { quote: q.id, idempotency_key: 'persisted-fixture-key' });
    assert.equal(f.calls[5]!.headers.has('PAYMENT-SIGNATURE'), false);
    assert.equal(f.calls[6]!.headers.get('PAYMENT-SIGNATURE'), signed);
    assert.ok(f.calls.every(c => c.redirect === 'error'));
    assert.ok(f.calls.slice(2).every(c => c.headers.get('Authorization') === 'Bearer fixture-token'));
  });
}

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
  await assert.rejects(f.client.paymentRequirements(polled.order), { code: 'PAYMENT_ALREADY_SUBMITTED' });
  const result = await f.client.submitPayment(polled.order, payment, exactAuthorization);
  assert.equal(result.receipt?.delivered_base_units, 1000000);
  assert.equal(f.calls[3]!.headers.get('PAYMENT-SIGNATURE'), f.calls[5]!.headers.get('PAYMENT-SIGNATURE'));
  assert.equal(f.calls.filter(c => c.path.includes('/quotes')).length, 0);
});

test('gateway 502 responses require explicit replay and do not confirm an awaiting order', async () => {
  const gateway = () => Response.json({ title: 'Error 502: Bad gateway', status: 502,
    error_name: 'origin_bad_gateway', detail: 'private upstream diagnostics', retryable: true, retry_after: 60 },
  { status: 502, headers: { 'Content-Type': 'application/problem+json' } });
  const f = fixture([gateway, () => ok({ order, receipt: null }), gateway, () => ok({ order, receipt: null })]);
  const exactAuthorization = signedPayment();
  const expectedError = { code: 'REQUEST_OUTCOME_UNKNOWN', status: 502, message: 'REQUEST_OUTCOME_UNKNOWN', sent: true };
  await assert.rejects(f.client.submitPayment(order, required, exactAuthorization), expectedError);
  assert.equal(f.calls.length, 1, 'A retryable gateway error must not trigger an automatic payment retry');
  const polled = await f.client.getOrder(order);
  assert.equal(polled.order.payment_state, 'awaiting');
  assert.equal(polled.receipt, null);
  await assert.rejects(f.client.paymentRequirements(polled.order), { code: 'PAYMENT_ALREADY_SUBMITTED', sent: false });
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.client.submitPayment(polled.order, required, exactAuthorization), expectedError);
  assert.equal(f.calls.length, 3);
  const afterReplay = await f.client.getOrder(polled.order);
  assert.equal(afterReplay.order.payment_state, 'awaiting');
  assert.equal(afterReplay.receipt, null);
  assert.deepEqual(f.calls.map(c => [c.method, c.path]), [
    ['POST', `/api/v1/agent/orders/${order.id}/pay`], ['GET', `/api/v1/agent/orders/${order.id}`],
    ['POST', `/api/v1/agent/orders/${order.id}/pay`], ['GET', `/api/v1/agent/orders/${order.id}`],
  ]);
  assert.equal(f.calls[0]!.headers.get('PAYMENT-SIGNATURE'), exactAuthorization);
  assert.equal(f.calls[2]!.headers.get('PAYMENT-SIGNATURE'), exactAuthorization);
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
    { extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '1' } },
    { amount: '1000001' }, { maxTimeoutSeconds: 301 }, { payTo: 'bad' },
  ]) {
    assert.throws(() => f.client.validatePayment({ ...required, accepts: [{ ...required.accepts[0], ...patch }] }, order), StationError);
  }
  assert.throws(() => f.client.validatePayment({ ...required, x402Version: 1 }, order), StationError);
  assert.throws(() => f.client.validatePayment({ ...required, accepts: [required.accepts[0], required.accepts[0]] }, order), StationError);
  assert.throws(() => new PwrStationClient({ ...target, chainId: 'manifest-ledger-mainnet' }, 100), { code: 'TARGET_MISMATCH' });
  assert.throws(() => f.client.validatePayment(required, { ...order, payment_path: 'checkout' }), { code: 'X402_ORDER_REQUIRED' });
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
    { ...delivered, receipt: { ...delivered.receipt, denom: 'umfx' } },
    { ...delivered, order: { ...delivered.order, delivery_state: 'queued' } },
    { ...delivered, order: { ...delivered.order, recipient: wallet } },
    { ...delivered, order: { ...delivered.order, id: 'aor_different' } },
    { ...delivered, order: { ...delivered.order, quote: 'aqt_different' } },
    { ...delivered, order: { ...delivered.order, refund_state: 'pending' } },
    { ...delivered, order: { ...delivered.order, payment_state: 'outcome_unknown' } },
  ]) {
    const f = fixture([() => ok(data)]);
    await assert.rejects(f.client.getOrder(order), StationError);
    assert.equal(f.calls.length, 1);
  }
});

test('signed authorization must match the exact approved test-USDC terms before transport', async () => {
  const f = fixture([]);
  const original = JSON.parse(Buffer.from(signedPayment(), 'base64').toString('utf8'));
  for (const changes of [
    { x402Version: 1 },
    { accepted: { ...required.accepts[0], network: 'eip155:8453' } },
    { accepted: { ...required.accepts[0], extra: { name: 'Different', version: '2' } } },
    { payload: { ...original.payload, authorization: { ...original.payload.authorization, value: '2000000' } } },
    { payload: { ...original.payload, authorization: { ...original.payload.authorization, validBefore: String(now / 1000 + 301) } } },
    { payload: { ...original.payload, authorization: { ...original.payload.authorization, nonce: 'bad' } } },
    { payload: { ...original.payload, signature: 'bad' } },
    ...[
      { to: '0x' + '44'.repeat(20) }, { from: 'bad' },
      { validBefore: original.payload.authorization.validAfter },
    ].map(patch => ({ payload: { ...original.payload, authorization: { ...original.payload.authorization, ...patch } } })),
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
  await assert.rejects(fixture([() => new Response('<html>private details</html>')]).client.packages(), { message: 'INVALID_RESPONSE', status: 200 });
  await assert.rejects(fixture([() => new Response(' '.repeat(256 * 1024 + 1))]).client.packages(), { message: 'RESPONSE_TOO_LARGE' });
});

test('quote extensions do not change quote identity and changed order amounts are rejected after dispatch', async () => {
  const f = fixture([() => ok({ ...quote, quote: null }), () => ok({ order, receipt: null })]);
  const extended = await f.client.quote(pack.id);
  assert.equal((await f.client.createOrder(extended, 'durable-key')).order.id, order.id);
  for (const patch of [
    { net_pwr_base_units: 1 }, { price_cents: 90, total_cents: 90 },
    { price_cents: 99, fees_cents: 1 }, { package: 'apk_other' }, { payment_path: 'checkout' },
  ]) {
    const changed = fixture([() => ok({ order: { ...order, ...patch }, receipt: null })]);
    await assert.rejects(changed.client.createOrder(quote, 'durable-key'), { code: 'REQUEST_OUTCOME_UNKNOWN', sent: true, status: 200 });
    assert.equal(changed.calls.length, 1);
  }
});

test('all failures after a signed POST or order creation are marked sent and uncertain', async () => {
  const failures: [() => Response, number][] = [
    [() => { throw new Error('private transport diagnostics'); }, 0],
    [() => new Response(null, { status: 200 }), 200],
    [() => new Response(' '.repeat(256 * 1024 + 1)), 200],
    [() => new Response('<html>private proxy details</html>', { status: 502 }), 502],
    [() => error('SIGNED_TERMS_MISMATCH', 409), 409],
    [() => ok(null), 200],
    [() => ok({ order: { ...order, net_pwr_base_units: 1 }, receipt: null }), 200],
    [() => ok({ order: { ...order, id: 'aor_other' }, receipt: null }), 200],
    [() => ok({ order: { ...order, quote: 'aqt_other' }, receipt: null }), 200],
  ];
  for (const [response, status] of failures) {
    const f = fixture([response]);
    await assert.rejects(f.client.submitPayment(order, required, signedPayment()), {
      code: 'REQUEST_OUTCOME_UNKNOWN', message: 'REQUEST_OUTCOME_UNKNOWN', sent: true, status,
      authorizationValidBefore: String(now / 1000 + 60),
    });
    assert.equal(f.calls.length, 1);
  }
  // A created order's ID is assigned by the service, so only quote identity is
  // checked there. Use the other response failures for creation recovery.
  for (const [response, status] of failures.filter((_, index) => index !== 7)) {
    const f = fixture([response]);
    await assert.rejects(f.client.createOrder(quote, 'durable-key'), { code: 'REQUEST_OUTCOME_UNKNOWN', sent: true, status });
    assert.equal(f.calls.length, 1);
  }
  const before = fixture([]);
  await assert.rejects(before.client.submitPayment(order, required, signedPayment({ accepted: null })), { code: 'INVALID_RESPONSE', sent: false });
  await assert.rejects(before.client.createOrder(quote, ''), { code: 'INVALID_IDEMPOTENCY_KEY', sent: false });
  assert.equal(before.calls.length, 0);
});

test('an attempt restored after restart permits exact replay but no fresh challenge or replacement', async () => {
  let current = now;
  const f = fixture([() => ok(delivered)], target, () => current);
  const signed = signedPayment();
  f.client.restoreSubmittedPayment(order, required, signed);
  const original = JSON.parse(Buffer.from(signed, 'base64').toString('utf8'));
  const replacement = signedPayment({ payload: { ...original.payload,
    authorization: { ...original.payload.authorization, nonce: '0x' + '44'.repeat(32) } } });
  for (const payment_state of ['awaiting', 'failed', 'outcome_unknown']) {
    await assert.rejects(f.client.paymentRequirements({ ...order, payment_state }), { code: 'PAYMENT_ALREADY_SUBMITTED', sent: false });
    await assert.rejects(f.client.submitPayment({ ...order, payment_state }, required, replacement), { code: 'PAYMENT_REPLACEMENT_FORBIDDEN', sent: false });
  }
  assert.equal(f.calls.length, 0);
  current += 61_000;
  await assert.rejects(f.client.paymentRequirements(order), { code: 'PAYMENT_ALREADY_SUBMITTED' });
  assert.equal((await f.client.submitPayment(order, required, signed)).receipt?.tx_hash, delivered.receipt.tx_hash.toUpperCase());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.headers.get('PAYMENT-SIGNATURE'), signed);
});

test('a signed submission blocks overlapping fresh challenges and replacement authorizations', async () => {
  let respond!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { respond = resolve; });
  const f = fixture([() => pending]);
  const signed = signedPayment();
  const first = f.client.submitPayment(order, required, signed);
  const original = JSON.parse(Buffer.from(signed, 'base64').toString('utf8'));
  const replacement = signedPayment({ payload: { ...original.payload,
    authorization: { ...original.payload.authorization, nonce: '0x' + '44'.repeat(32) } } });
  try {
    await assert.rejects(f.client.paymentRequirements(order), { code: 'PAYMENT_ALREADY_SUBMITTED',
      authorizationValidBefore: String(now / 1000 + 60), sent: false });
    await assert.rejects(f.client.submitPayment(order, required, replacement), { code: 'PAYMENT_REPLACEMENT_FORBIDDEN', sent: false });
    assert.equal(f.calls.length, 1);
  } finally { respond(ok(delivered)); }
  assert.equal((await first).receipt?.tx_hash, delivered.receipt.tx_hash.toUpperCase());
});

test('failed restores keep challenges and signed payments blocked despite clock or spending-policy changes', async () => {
  for (const scenario of [
    { clock: now - 1000, ceiling: 100, signed: signedPayment(), code: 'INVALID_PAYMENT_AUTHORIZATION' },
    { clock: now, ceiling: 99, signed: signedPayment(), code: 'SPEND_LIMIT_EXCEEDED' },
    { clock: now, ceiling: 100, signed: 'corrupt-fixture', code: 'INVALID_PAYMENT_SIGNATURE' },
  ]) {
    const f = fixture([], target, () => scenario.clock, scenario.ceiling);
    assert.throws(() => f.client.restoreSubmittedPayment(order, required, scenario.signed), { code: scenario.code });
    for (const payment_state of ['awaiting', 'failed']) {
      await assert.rejects(f.client.paymentRequirements({ ...order, payment_state }), { code: 'PAYMENT_ALREADY_SUBMITTED', sent: false });
      await assert.rejects(f.client.submitPayment({ ...order, payment_state }, required, signedPayment()), { code: 'PAYMENT_RESTORE_REQUIRED', sent: false });
    }
    assert.equal(f.calls.length, 0);
  }
});

test('the original attempt can be restored after correcting the clock; a failed later restore preserves its guard', async () => {
  let current = now - 1000;
  const signed = signedPayment();
  const f = fixture([() => ok(delivered)], target, () => current);
  assert.throws(() => f.client.restoreSubmittedPayment(order, required, signed), { code: 'INVALID_PAYMENT_AUTHORIZATION' });
  current = now;
  f.client.restoreSubmittedPayment(order, required, signed);
  assert.throws(() => f.client.restoreSubmittedPayment(order, required, 'corrupt-fixture'), { code: 'INVALID_PAYMENT_SIGNATURE' });
  await assert.rejects(f.client.paymentRequirements(order), { code: 'PAYMENT_ALREADY_SUBMITTED',
    authorizationValidBefore: String(now / 1000 + 60) });
  assert.equal((await f.client.submitPayment(order, required, signed)).receipt?.tx_hash, delivered.receipt.tx_hash.toUpperCase());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.headers.get('PAYMENT-SIGNATURE'), signed);
});

test('a rejected fresh authorization does not mark an unsubmitted order as paid', async () => {
  const f = fixture([() => challenge()]);
  await assert.rejects(f.client.submitPayment(order, required, 'corrupt-fixture'), { code: 'INVALID_PAYMENT_SIGNATURE', sent: false });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.client.paymentRequirements(order), required);
  assert.equal(f.calls.length, 1);
});

test('refund and in-flight states cannot request payment terms', async () => {
  const f = fixture([]);
  for (const refund_state of ['pending', 'succeeded', 'failed']) {
    await assert.rejects(f.client.paymentRequirements({ ...order, refund_state }), { code: 'POLL_ORDER_BEFORE_PAYING', sent: false });
  }
  for (const payment_state of ['attempt_pending', 'outcome_unknown', 'settled']) {
    await assert.rejects(f.client.paymentRequirements({ ...order, payment_state }), { code: 'POLL_ORDER_BEFORE_PAYING', sent: false });
  }
  assert.equal(f.calls.length, 0);
});

test('header-only payment challenges work; read-only gateway failures retain HTTP status', async () => {
  const headers = { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') };
  for (const body of [null, '<html>Payment required</html>', '']) {
    const f = fixture([() => new Response(body, { status: 402, headers })]);
    assert.deepEqual(await f.client.paymentRequirements(order), required);
    assert.equal(f.calls.length, 1);
  }
  for (const status of [502, 503]) {
    for (const body of [null, '<html>private details</html>']) {
      const f = fixture([() => new Response(body, { status })]);
      await assert.rejects(f.client.getOrder(order), { code: 'STATION_UNAVAILABLE', status, sent: false });
      assert.equal(f.calls.length, 1);
    }
  }
  const rejected = fixture([() => new Response(null, { status: 402, headers })]);
  await assert.rejects(rejected.client.submitPayment(order, required, signedPayment()), { code: 'REQUEST_OUTCOME_UNKNOWN', sent: true, status: 402 });
});

test('login rejects another wallet identity and never keeps its token', async () => {
  const f = fixture([() => ok({ nonce: 'ab'.repeat(16) }), () => ok({ wallet_address: creditAddress, token: 'private-token' }), () => ok([pack])]);
  const signer = { getAddress: async () => wallet, signArbitrary: async () => ({ signature: 'fixture', pub_key: { value: 'fixture' } }) };
  await assert.rejects(f.client.login(signer), { code: 'INVALID_LOGIN' });
  await f.client.packages();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2]!.headers.has('Authorization'), false);
});

test('oversized valid PAYMENT-REQUIRED headers are refused before payment validation', async () => {
  const header = Buffer.from(JSON.stringify({ ...required, padding: 'x'.repeat(16384) })).toString('base64');
  assert.ok(header.length > 16384);
  const f = fixture([() => new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': header } })]);
  await assert.rejects(f.client.paymentRequirements(order), { code: 'INVALID_PAYMENT_REQUIREMENTS', status: 402, sent: false });
  assert.equal(f.calls.length, 1);
});

test('receipt transaction hashes must be exactly 32 hexadecimal bytes', async () => {
  for (const tx_hash of ['g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    const f = fixture([() => ok({ ...delivered, receipt: { ...delivered.receipt, tx_hash } })]);
    await assert.rejects(f.client.getOrder(order), { code: 'INVALID_DELIVERY_RECEIPT' });
    assert.equal(f.calls.length, 1);
  }
});

test('authorization validAfter requires a canonical nonnegative decimal string before transport', async () => {
  const original = JSON.parse(Buffer.from(signedPayment(), 'base64').toString('utf8'));
  const f = fixture([]);
  for (const validAfter of ['-1', '01', ' 1', '0x1']) {
    const signed = signedPayment({ payload: { ...original.payload,
      authorization: { ...original.payload.authorization, validAfter } } });
    await assert.rejects(f.client.submitPayment(order, required, signed), { code: 'INVALID_PAYMENT_AUTHORIZATION', sent: false });
  }
  assert.equal(f.calls.length, 0);
});

test('malformed login nonces never reach the signer or wallet authentication endpoint', async () => {
  for (const nonce of ['g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
    const f = fixture([() => ok({ nonce })]);
    let signatures = 0;
    const signer = { getAddress: async () => wallet, signArbitrary: async () => {
      signatures++; return { signature: 'fixture', pub_key: { value: 'fixture' } };
    } };
    await assert.rejects(f.client.login(signer), { code: 'INVALID_NONCE' });
    assert.equal(signatures, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('unknown order states cannot become an accepted poll result', async () => {
  for (const field of ['payment_state', 'recording_state', 'delivery_state', 'refund_state', 'next_action']) {
    const f = fixture([() => ok({ order: { ...order, [field]: 'unrecognized' }, receipt: null })]);
    await assert.rejects(f.client.getOrder(order), { code: 'INVALID_ORDER_STATE' });
    assert.equal(f.calls.length, 1);
  }
});

test('a failed repeat login clears the previous token before any further request', async () => {
  const f = fixture([() => ok({ nonce: 'ab'.repeat(16) }), () => ok({ wallet_address: wallet, token: 'fixture-token' }),
    () => ok([pack]), () => ok({ nonce: 'invalid' }), () => ok([pack])]);
  const signer = { getAddress: async () => wallet, signArbitrary: async () => ({ signature: 'fixture', pub_key: { value: 'fixture' } }) };
  await f.client.login(signer);
  await f.client.packages();
  assert.equal(f.calls[2]!.headers.get('Authorization'), 'Bearer fixture-token');
  await assert.rejects(f.client.login(signer), { code: 'INVALID_NONCE' });
  await f.client.packages();
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[3]!.headers.has('Authorization'), false);
  assert.equal(f.calls[4]!.headers.has('Authorization'), false);
});

test('invalid order identifiers cannot dispatch a poll request', async () => {
  const f = fixture([]);
  for (const id of ['', 'aqt_fixture', 'aor_../fixture']) {
    await assert.rejects(f.client.getOrder({ ...order, id }), { code: 'INVALID_ID', sent: false });
  }
  assert.equal(f.calls.length, 0);
});

test('restore guards the supplied order ID and relies on the host to authenticate its identity', async () => {
  const f = fixture([() => challenge()]);
  for (const saved of [undefined, null, 'garbage', {}, { ...order, id: 'damaged' }]) {
    assert.throws(() => f.client.restoreSubmittedPayment(saved as StationOrder, required, signedPayment()), { code: 'INVALID_ID' });
  }
  const damaged = { ...order, id: 'aor_different' };
  f.client.restoreSubmittedPayment(damaged, required, signedPayment());
  await assert.rejects(f.client.paymentRequirements(damaged), { code: 'PAYMENT_ALREADY_SUBMITTED' });
  assert.equal(f.calls.length, 0);
  // A well-formed but incorrect ID cannot be detected from this signature.
  // The host must verify journal identity and stop on corruption before paying.
  assert.deepEqual(await f.client.paymentRequirements(order), required);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.headers.has('PAYMENT-SIGNATURE'), false);
});

test('authorization validBefore requires a canonical positive decimal string before transport', async () => {
  const original = JSON.parse(Buffer.from(signedPayment(), 'base64').toString('utf8'));
  const expiry = original.payload.authorization.validBefore as string;
  const f = fixture([]);
  for (const validBefore of ['0x' + BigInt(expiry).toString(16), expiry + '.0', ' ' + expiry, '0' + expiry]) {
    const signed = signedPayment({ payload: { ...original.payload,
      authorization: { ...original.payload.authorization, validBefore } } });
    await assert.rejects(f.client.submitPayment(order, required, signed), { code: 'INVALID_PAYMENT_AUTHORIZATION', sent: false });
  }
  assert.equal(f.calls.length, 0);
});

test('transport errors on reads, unsigned challenges and login expose only sanitized errors', async () => {
  const failure = () => { throw new Error('fixture-private-transport-diagnostic', { cause: 'fixture-private-cause' }); };
  const signer = { getAddress: async () => wallet, signArbitrary: async () => ({ signature: 'fixture', pub_key: { value: 'fixture' } }) };
  for (const operation of ['getOrder', 'paymentRequirements', 'nonce', 'walletLogin']) {
    const f = fixture(operation === 'walletLogin' ? [() => ok({ nonce: 'ab'.repeat(16) }), failure] : [failure]);
    const result = operation === 'getOrder' ? f.client.getOrder(order)
      : operation === 'paymentRequirements' ? f.client.paymentRequirements(order) : f.client.login(signer);
    await assert.rejects(result, error => {
      assert.ok(error instanceof StationError);
      assert.equal(error.code, 'REQUEST_OUTCOME_UNKNOWN');
      assert.equal(error.message, 'REQUEST_OUTCOME_UNKNOWN');
      assert.equal(error.status, 0);
      assert.equal(error.sent, false);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error.stack), /fixture-private/);
      return true;
    });
    assert.equal(f.calls.length, operation === 'walletLogin' ? 2 : 1);
    assert.ok(f.calls.every(call => !call.headers.has('PAYMENT-SIGNATURE')));
  }
});

test('replacement errors retain the original authorization expiry', async () => {
  const signed = signedPayment();
  const original = JSON.parse(Buffer.from(signed, 'base64').toString('utf8'));
  const replacement = signedPayment({ payload: { ...original.payload, authorization: { ...original.payload.authorization,
    nonce: '0x' + '44'.repeat(32), validBefore: String(now / 1000 + 30) } } });
  const f = fixture([]);
  f.client.restoreSubmittedPayment(order, required, signed);
  const expected = { code: 'PAYMENT_REPLACEMENT_FORBIDDEN', sent: false, authorizationValidBefore: String(now / 1000 + 60) };
  assert.throws(() => f.client.restoreSubmittedPayment(order, required, replacement), expected);
  await assert.rejects(f.client.submitPayment(order, required, replacement), expected);
  assert.equal(f.calls.length, 0);
});

test('signed payment size is bounded at 16 KiB before transport', async () => {
  const emptySize = Buffer.from(signedPayment({ padding: '' }), 'base64').byteLength;
  const padding = 'x'.repeat(12 * 1024 - emptySize);
  const atLimit = signedPayment({ padding });
  assert.equal(atLimit.length, 16 * 1024);
  const accepted = fixture([() => ok(delivered)]);
  assert.ok((await accepted.client.submitPayment(order, required, atLimit)).receipt);
  assert.equal(accepted.calls.length, 1);
  const oversized = signedPayment({ padding: padding + 'x' });
  assert.ok(oversized.length > 16 * 1024);
  const rejected = fixture([]);
  await assert.rejects(rejected.client.submitPayment(order, required, oversized), { code: 'INVALID_PAYMENT_SIGNATURE', sent: false });
  assert.equal(rejected.calls.length, 0);
});

test('mainnet requires explicit selection and invalid profiles or targets fail before transport', () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return ok([]); };
  assert.throws(() => new PwrStationClient(mainnetTarget, 100, { fetch: fetcher }), { code: 'TARGET_MISMATCH' });
  for (const network of ['', 'production', 'MAINNET', 'toString', '__proto__', null, {}, PWR_STATION_PROFILES.mainnet]) {
    assert.throws(() => new PwrStationClient(mainnetTarget, 100, { network: network as PwrStationNetwork, fetch: fetcher }), { code: 'INVALID_NETWORK' });
  }
  for (const scenario of scenarios) {
    const opposite = scenario.network === 'testnet' ? mainnetTarget : target;
    for (const invalid of [opposite, { ...scenario.target, denom: 'upwr' }, { ...scenario.target, denom: 'umfx' }]) {
      assert.throws(() => new PwrStationClient(invalid, 100, { network: scenario.network, fetch: fetcher }), { code: 'TARGET_MISMATCH' });
    }
  }
  assert.equal(requests, 0);
});

test('profiles are immutable and mutating caller options cannot switch an existing client', async () => {
  assert.equal(Reflect.set(PWR_STATION_PROFILES, 'testnet', PWR_STATION_PROFILES.mainnet), false);
  for (const profile of Object.values(PWR_STATION_PROFILES)) {
    assert.throws(() => Object.assign(profile, { baseUrl: 'https://untrusted.example' }), TypeError);
  }
  const calls: string[] = [];
  const options = { network: 'mainnet' as PwrStationNetwork, now: () => now,
    fetch: async (input: string | URL | Request) => { calls.push(String(input)); return ok(mainnetQuote); } };
  const selectedTarget = { ...mainnetTarget };
  const client = new PwrStationClient(selectedTarget, 100, options);
  options.network = 'testnet';
  selectedTarget.chainId = 'manifest-ledger-testnet';
  selectedTarget.recipient = wallet;
  assert.deepEqual(await client.quote(pack.id), mainnetQuote);
  assert.deepEqual(calls, ['https://pwr-station.com/api/v1/agent/quotes']);
});

for (const scenario of scenarios) {
  test(`${scenario.network}: rejects mixed payment networks, contracts and signing domains`, async () => {
    const opposite = scenario.network === 'testnet' ? mainnetRequired : required;
    const terms = scenario.required.accepts[0]!;
    const f = fixture([], scenario.target, () => now, 100, scenario.network);
    for (const [patch, code] of [
      [{ network: opposite.accepts[0]!.network }, 'USDC_REQUIRED'],
      [{ asset: opposite.accepts[0]!.asset }, 'USDC_REQUIRED'],
      [{ scheme: 'upto' }, 'USDC_REQUIRED'],
      [{ extra: opposite.accepts[0]!.extra }, 'USDC_DOMAIN_REQUIRED'],
      [{ extra: { ...(terms.extra as object), assetTransferMethod: 'permit2' } }, 'USDC_DOMAIN_REQUIRED'],
      [{ extra: { ...(terms.extra as object), version: '1' } }, 'USDC_DOMAIN_REQUIRED'],
      [{ amount: '1000001' }, 'INVALID_PAYMENT_TERMS'],
      [{ maxTimeoutSeconds: 301 }, 'AUTHORIZATION_WINDOW_TOO_LONG'],
    ] as const) {
      const payment = { ...scenario.required, accepts: [{ ...terms, ...patch }] } as PaymentRequired;
      assert.throws(() => f.client.validatePayment(payment, scenario.order), { code, sent: false });
      await assert.rejects(f.client.submitPayment(scenario.order, payment, signedPayment({}, payment)), { code, sent: false });
    }
    assert.equal(f.calls.length, 0);
  });

  test(`${scenario.network}: quote and receipt validation preserve network identity and the spending ceiling`, async () => {
    const opposite = scenario.network === 'testnet' ? mainnetQuote : quote;
    for (const patch of [
      { environment: opposite.environment }, { chain_id: opposite.chain_id },
      { denom: 'umfx' }, { recipient: wallet },
    ]) {
      const f = fixture([() => ok({ ...scenario.quote, ...patch })], scenario.target, () => now, 100, scenario.network);
      await assert.rejects(f.client.quote(pack.id), { code: 'TARGET_MISMATCH' });
      assert.equal(f.calls.length, 1);
    }
    const limited = fixture([() => ok(scenario.quote)], scenario.target, () => now, 99, scenario.network);
    await assert.rejects(limited.client.quote(pack.id), { code: 'SPEND_LIMIT_EXCEEDED' });
    await assert.rejects(limited.client.submitPayment(scenario.order, scenario.required, signedPayment({}, scenario.required)), {
      code: 'SPEND_LIMIT_EXCEEDED', sent: false,
    });
    assert.equal(limited.calls.length, 1);
    const wrongReceipt = { ...scenario.delivered, receipt: { ...scenario.delivered.receipt, chain_id: opposite.chain_id } };
    const receipt = fixture([() => ok(wrongReceipt)], scenario.target, () => now, 100, scenario.network);
    await assert.rejects(receipt.client.getOrder(scenario.order), { code: 'INVALID_DELIVERY_RECEIPT' });
    assert.equal(receipt.calls.length, 1);
  });

  test(`${scenario.network}: orders and signed payments from another profile cannot dispatch`, async () => {
    const opposite = scenarios.find(value => value.network !== scenario.network)!;
    const f = fixture([], scenario.target, () => now, 100, scenario.network);
    await assert.rejects(f.client.createOrder(opposite.quote, 'fixture-key'), { code: 'TARGET_MISMATCH', sent: false });
    await assert.rejects(f.client.getOrder(opposite.order), { code: 'TARGET_MISMATCH', sent: false });
    await assert.rejects(f.client.paymentRequirements(opposite.order), { code: 'TARGET_MISMATCH', sent: false });
    const otherSignature = signedPayment({}, opposite.required);
    await assert.rejects(f.client.submitPayment(opposite.order, opposite.required, otherSignature), { code: 'TARGET_MISMATCH', sent: false });
    await assert.rejects(f.client.submitPayment(scenario.order, scenario.required, otherSignature), { code: 'SIGNED_TERMS_MISMATCH', sent: false });
    assert.throws(() => f.client.restoreSubmittedPayment(opposite.order, opposite.required, otherSignature), { code: 'TARGET_MISMATCH', sent: false });
    assert.equal(f.calls.length, 0);
  });

  test(`${scenario.network}: uncertain payment recovery retains the selected profile and exact authorization`, async () => {
    const signed = signedPayment({}, scenario.required);
    // Synthetic serialization models the host's private, integrity-checked journal.
    const saved = JSON.parse(JSON.stringify({ network: scenario.network, target: scenario.target,
      order: scenario.order, required: scenario.required, signed }));
    const initial = fixture([() => { throw new Error('fixture lost response'); }], scenario.target, () => now, 100, scenario.network);
    await assert.rejects(initial.client.submitPayment(scenario.order, scenario.required, signed), {
      code: 'REQUEST_OUTCOME_UNKNOWN', sent: true, authorizationValidBefore: String(now / 1000 + 60),
    });
    assert.equal(initial.calls.length, 1);
    if (saved.network === 'mainnet') {
      const wrongNetwork = fixture([]);
      assert.throws(() => wrongNetwork.client.restoreSubmittedPayment(saved.order, saved.required, saved.signed), { code: 'TARGET_MISMATCH' });
      await assert.rejects(wrongNetwork.client.getOrder(saved.order), { code: 'TARGET_MISMATCH' });
      assert.equal(wrongNetwork.calls.length, 0);
    }
    const restarted = fixture([() => ok(scenario.delivered)], saved.target, () => now, 100, saved.network);
    restarted.client.restoreSubmittedPayment(saved.order, saved.required, saved.signed);
    await assert.rejects(restarted.client.paymentRequirements(scenario.order), { code: 'PAYMENT_ALREADY_SUBMITTED', sent: false });
    const replacement = JSON.parse(Buffer.from(signed, 'base64').toString('utf8'));
    replacement.payload.authorization.nonce = '0x' + '44'.repeat(32);
    await assert.rejects(restarted.client.submitPayment(scenario.order, scenario.required,
      Buffer.from(JSON.stringify(replacement)).toString('base64')), { code: 'PAYMENT_REPLACEMENT_FORBIDDEN', sent: false });
    const result = await restarted.client.submitPayment(scenario.order, scenario.required, signed);
    assert.equal(result.receipt?.chain_id, scenario.target.chainId);
    assert.equal(restarted.calls.length, 1);
    assert.equal(restarted.calls[0]!.headers.get('PAYMENT-SIGNATURE'), initial.calls[0]!.headers.get('PAYMENT-SIGNATURE'));
  });

  test(`${scenario.network}: checksum and lowercase USDC addresses validate without rewriting signed terms`, async () => {
    const configured = PWR_STATION_PROFILES[scenario.network].usdcContract;
    assert.notEqual(configured, configured.toLowerCase(), 'Exercise a checksum-cased profile contract');
    for (const asset of [configured, configured.toLowerCase(), '0x' + configured.slice(2).toUpperCase()]) {
      const payment: PaymentRequired = { ...scenario.required, accepts: [{ ...scenario.required.accepts[0]!, asset }] };
      const f = fixture([() => ok(scenario.delivered)], scenario.target, () => now, 100, scenario.network);
      assert.equal(f.client.validatePayment(payment, scenario.order).accepts[0]!.asset, asset);
      const signed = signedPayment({}, payment);
      assert.ok((await f.client.submitPayment(scenario.order, payment, signed)).receipt);
      assert.equal(f.calls[0]!.headers.get('PAYMENT-SIGNATURE'), signed);
    }
  });

  test(`${scenario.network}: a lower spending ceiling permits reconciliation reads but blocks all payment work`, async () => {
    const pending = { ...scenario.order, payment_state: 'outcome_unknown', next_action: 'poll' } as StationOrder;
    const signed = signedPayment({}, scenario.required);
    const recovery = fixture([() => ok({ order: pending, receipt: null }), () => ok(scenario.delivered)],
      scenario.target, () => now, 99, scenario.network);
    assert.throws(() => recovery.client.restoreSubmittedPayment(scenario.order, scenario.required, signed), { code: 'SPEND_LIMIT_EXCEEDED' });
    const polled = await recovery.client.getOrder(scenario.order);
    assert.equal(polled.order.payment_state, 'outcome_unknown');
    assert.equal(polled.receipt, null);
    const complete = await recovery.client.getOrder(polled.order);
    assert.equal(complete.receipt?.delivered_base_units, 1000000);
    await assert.rejects(recovery.client.paymentRequirements(scenario.order), { code: 'PAYMENT_ALREADY_SUBMITTED', sent: false });
    await assert.rejects(recovery.client.submitPayment(scenario.order, scenario.required, signed), { code: 'PAYMENT_RESTORE_REQUIRED', sent: false });
    assert.equal(recovery.calls.length, 2);
    assert.ok(recovery.calls.every(call => call.method === 'GET' && !call.headers.has('PAYMENT-SIGNATURE')));

    const fresh = fixture([], scenario.target, () => now, 99, scenario.network);
    const blocked = { code: 'SPEND_LIMIT_EXCEEDED', sent: false };
    await assert.rejects(fresh.client.createOrder(scenario.quote, 'fixture-key'), blocked);
    await assert.rejects(fresh.client.paymentRequirements(scenario.order), blocked);
    assert.throws(() => fresh.client.validatePayment(scenario.required, scenario.order), blocked);
    await assert.rejects(fresh.client.submitPayment(scenario.order, scenario.required, signed), blocked);
    assert.equal(fresh.calls.length, 0);
  });

  test(`${scenario.network}: reads above the spending ceiling still reject malformed or changed order terms`, async () => {
    const opposite = scenarios.find(value => value.network !== scenario.network)!;
    const before = fixture([], scenario.target, () => now, 99, scenario.network);
    for (const [patch, code] of [
      [{ chain_id: opposite.target.chainId }, 'TARGET_MISMATCH'],
      [{ recipient: wallet }, 'TARGET_MISMATCH'], [{ denom: 'umfx' }, 'TARGET_MISMATCH'],
      [{ total_cents: 99 }, 'INVALID_AMOUNT'], [{ price_cents: -1 }, 'INVALID_AMOUNT'],
    ] as const) await assert.rejects(before.client.getOrder({ ...scenario.order, ...patch }), { code, sent: false });
    assert.equal(before.calls.length, 0);

    for (const [patch, code] of [
      [{ id: 'aor_other' }, 'ORDER_MISMATCH'], [{ quote: 'aqt_other' }, 'ORDER_MISMATCH'],
      [{ recipient: wallet }, 'TARGET_MISMATCH'], [{ environment: opposite.order.environment }, 'TARGET_MISMATCH'],
      [{ price_cents: 101, total_cents: 101 }, 'ORDER_TERMS_CHANGED'],
      [{ total_cents: 99 }, 'INVALID_AMOUNT'],
    ] as const) {
      const f = fixture([() => ok({ order: { ...scenario.order, ...patch }, receipt: null })], scenario.target, () => now, 99, scenario.network);
      await assert.rejects(f.client.getOrder(scenario.order), { code });
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0]!.method, 'GET');
    }
    const invalidReceipt = fixture([() => ok({ ...scenario.delivered, receipt: { ...scenario.delivered.receipt, delivered_base_units: 1 } })],
      scenario.target, () => now, 99, scenario.network);
    await assert.rejects(invalidReceipt.client.getOrder(scenario.order), { code: 'INVALID_DELIVERY_RECEIPT' });
  });
}
