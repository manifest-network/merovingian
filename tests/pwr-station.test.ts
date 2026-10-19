import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
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

const transportChecks: (() => void)[] = [];
afterEach(() => { for (const check of transportChecks.splice(0)) check(); });

function fixture(responses: (() => Response | Promise<Response>)[], selectedTarget = target, clock = () => now, maxOrderCents = 100) {
  const violations: string[] = [];
  transportChecks.push(() => {
    assert.deepEqual(violations, [], 'Transport assertions must escape the client error sanitizer');
    assert.equal(responses.length, 0, 'Expected transport calls were skipped');
  });
  const calls: { path: string; method: string; body: any; headers: Headers; redirect?: RequestRedirect }[] = [];
  const client = new PwrStationClient(selectedTarget, maxOrderCents, { now: clock, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== PWR_STATION_QA) violations.push('Wrong origin');
    if (init?.redirect !== 'error') violations.push('Redirects were allowed');
    calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers), redirect: init?.redirect });
    const next = responses.shift();
    if (!next) { violations.push('Unexpected network request'); throw new Error('Unexpected network request'); }
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
  assert.throws(() => new PwrStationClient({ ...target, chainId: 'manifest-ledger-mainnet' as any }, 100), { code: 'TESTNET_REQUIRED' });
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
