import { parseAddress } from '@manifest-network/manifest-sdk';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { PWR_STATION_PROFILES, type PwrStationNetwork, type PwrStationProfile } from './pwr-station-config.js';

/** Independently verified destination metadata, not copied from the purchase profile. */
export interface PurchaseTarget { recipient: string; chainId: string; denom: string }
export interface StationPackage { id: string; price_cents: number; fees_cents: number; net_pwr_base_units: number }
export interface Quote extends StationPackage {
  package: string; payment_path: 'x402' | 'checkout'; recipient: string; total_cents: number;
  environment: PwrStationProfile['environment']; chain_id: string; denom: string; expires_at: string;
}
export interface StationOrder extends Omit<Quote, 'expires_at'> {
  quote: string; payment_state: string; recording_state: string; delivery_state: string;
  refund_state: string; next_action: 'poll' | 'retry_same_request' | 'requote' | 'contact_support' | 'complete';
  payment_deadline: string;
}
export interface OrderResult {
  order: StationOrder;
  /** Station-reported delivery only. The host must independently verify the
   * transaction, recipient and amount on Manifest before acknowledging credit. */
  receipt: null | { tx_hash: string; chain_id: string; denom: string; delivered_base_units: number };
}
export interface PaymentRequired {
  x402Version: 2;
  accepts: { scheme: 'exact'; network: PwrStationProfile['paymentNetwork']; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; [key: string]: unknown }[];
  [key: string]: unknown;
}
export interface StationSigner {
  getAddress(): Promise<string>;
  signArbitrary(address: string, message: string): Promise<{ signature: string; pub_key: { value: string } }>;
}
export class StationError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly sent = false,
    readonly authorizationValidBefore?: string) { super(code); this.name = 'StationError'; }
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StationError('INVALID_RESPONSE');
  return value as Record<string, any>;
}
function integer(value: unknown, positive = false): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) throw new StationError('INVALID_AMOUNT');
}
function identifier(value: unknown, prefix: string): asserts value is string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,128}$`).test(value)) throw new StationError('INVALID_ID');
}
function time(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new StationError('INVALID_DEADLINE');
  return Date.parse(value);
}
function address(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new StationError('INVALID_RECIPIENT');
  try { parseAddress(value, 'manifest'); } catch { throw new StationError('INVALID_RECIPIENT'); }
}
function equalTerms(actual: Record<string, any>, expected: Record<string, any>) {
  for (const key of ['package', 'payment_path', 'recipient', 'environment', 'chain_id', 'denom',
    'price_cents', 'fees_cents', 'total_cents', 'net_pwr_base_units']) {
    if (actual[key] !== expected[key]) throw new StationError('ORDER_TERMS_CHANGED');
  }
}

/**
 * Purchase client defaulting to testnet. Mainnet requires an explicit network
 * option; targets and server responses cannot select it. No automatic retries
 * or signing. Never imported by the hosted refuge.
 * The caller must persist the network, quote, idempotency key, order and exact
 * signed payment privately before the corresponding request, and reuse them
 * after a timeout. On restart, select the saved network; restoreSubmittedPayment
 * must precede any payment work for each journaled attempt. The spending limit
 * is per order; the host owns total spend.
 */
export class PwrStationClient {
  private token?: string;
  private readonly profile: PwrStationProfile;
  private readonly target: Readonly<PurchaseTarget>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  // Null blocks a journaled order whose restore has not passed validation.
  private readonly submitted = new Map<string, { digest: string; validBefore: string } | null>();
  constructor(target: PurchaseTarget, private readonly maxOrderCents: number,
    options: { network?: PwrStationNetwork; fetch?: typeof fetch; now?: () => number } = {}) {
    const network = options.network === undefined ? 'testnet' : options.network;
    if (network !== 'testnet' && network !== 'mainnet') throw new StationError('INVALID_NETWORK');
    this.profile = PWR_STATION_PROFILES[network];
    address(target.recipient);
    if (target.chainId !== this.profile.chainId || target.denom !== this.profile.pwrDenom) throw new StationError('TARGET_MISMATCH');
    integer(maxOrderCents, true);
    this.target = Object.freeze({ ...target });
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async request(path: string, body?: object, payment?: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let status = 0;
    try {
      const response = await this.fetcher(this.profile.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(payment ? { 'PAYMENT-SIGNATURE': payment } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      // x402 v2 permits a header-only challenge, regardless of the body format.
      const header = response.headers.get('PAYMENT-REQUIRED');
      if (status === 402 && header) {
        if (header.length > 16384) throw new StationError('INVALID_PAYMENT_REQUIREMENTS', status);
        try { return { status, data: JSON.parse(Buffer.from(header, 'base64').toString('utf8')) }; }
        catch { throw new StationError('INVALID_PAYMENT_REQUIREMENTS', status); }
      }
      if (!response.body) throw new StationError(response.ok ? 'INVALID_RESPONSE' : 'STATION_UNAVAILABLE', status);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 256 * 1024) throw new StationError('RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let envelope;
      try { envelope = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { throw new StationError(response.ok ? 'INVALID_RESPONSE' : 'STATION_UNAVAILABLE', status); }
      if (response.status === 402 && envelope.error?.code === 'AGENT_PAYMENT_REQUIRED') {
        return { status: 402, data: envelope.error?.details?.payment_required };
      }
      if (!response.ok || envelope.success !== true) {
        const code = envelope.error?.code;
        throw new StationError(typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'STATION_UNAVAILABLE', response.status);
      }
      return { status: response.status, data: envelope.data };
    } catch (error) {
      // Remote errors and fetch diagnostics may contain credentials or signed
      // authorizations. Only stable, locally constructed codes leave this client.
      if (error instanceof StationError) throw new StationError(error.code, error.status || status);
      throw new StationError('REQUEST_OUTCOME_UNKNOWN', status);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async login(signer: StationSigner): Promise<void> {
    this.token = undefined;
    const wallet = await signer.getAddress();
    address(wallet);
    const nonce = record((await this.request(`/api/v1/auth/nonce?address=${encodeURIComponent(wallet)}`)).data).nonce;
    if (typeof nonce !== 'string' || !/^[0-9a-fA-F]{32}$/.test(nonce)) throw new StationError('INVALID_NONCE');
    const message = `powerstation:nonce=${nonce}`;
    const signed = await signer.signArbitrary(wallet, message);
    const auth = record((await this.request('/api/v1/auth/wallet', { address: wallet, message, signature: signed.signature, pub_key: signed.pub_key.value })).data);
    if (auth.wallet_address !== wallet || typeof auth.token !== 'string' || !auth.token || auth.token.length > 8192) throw new StationError('INVALID_LOGIN');
    this.token = auth.token;
  }

  async packages(): Promise<StationPackage[]> {
    const data = (await this.request('/api/v1/agent/packages')).data;
    if (!Array.isArray(data)) throw new StationError('INVALID_PACKAGES');
    return data.map(value => {
      const p = record(value); identifier(p.id, 'apk');
      integer(p.price_cents); integer(p.fees_cents); integer(p.net_pwr_base_units, true);
      return { id: p.id, price_cents: p.price_cents, fees_cents: p.fees_cents, net_pwr_base_units: p.net_pwr_base_units };
    });
  }

  private terms(value: unknown): Record<string, any> {
    const q = record(value);
    if (q.environment !== this.profile.environment || q.chain_id !== this.target.chainId || q.denom !== this.target.denom || q.recipient !== this.target.recipient) throw new StationError('TARGET_MISMATCH');
    identifier(q.package, 'apk');
    if (!['x402', 'checkout'].includes(q.payment_path)) throw new StationError('INVALID_PAYMENT_PATH');
    integer(q.price_cents); integer(q.fees_cents); integer(q.total_cents, true); integer(q.net_pwr_base_units, true);
    if (BigInt(q.total_cents) !== BigInt(q.price_cents) + BigInt(q.fees_cents)) throw new StationError('INVALID_AMOUNT');
    return q;
  }

  private spendingTerms(value: unknown): Record<string, any> {
    const q = this.terms(value);
    if (q.total_cents > this.maxOrderCents) throw new StationError('SPEND_LIMIT_EXCEEDED');
    return q;
  }

  async quote(packageId: string, paymentPath: 'x402' | 'checkout' = 'x402'): Promise<Quote> {
    identifier(packageId, 'apk');
    const q = this.spendingTerms((await this.request('/api/v1/agent/quotes', { package: packageId, payment_path: paymentPath, recipient: this.target.recipient })).data);
    identifier(q.id, 'aqt');
    if (q.package !== packageId || q.payment_path !== paymentPath) throw new StationError('QUOTE_MISMATCH');
    if (time(q.expires_at) <= this.now()) throw new StationError('QUOTE_EXPIRED');
    return structuredClone(q) as Quote;
  }

  private result(value: unknown, expected: { quote: Quote } | { order: StationOrder }): OrderResult {
    // Polling must validate results even when the host has lowered its spend cap.
    const data = record(value), order = this.terms(data.order);
    identifier(order.id, 'aor'); identifier(order.quote, 'aqt');
    equalTerms(order, 'order' in expected ? expected.order : expected.quote);
    if (order.quote !== ('order' in expected ? expected.order.quote : expected.quote.id)
      || ('order' in expected && order.id !== expected.order.id)) throw new StationError('ORDER_MISMATCH');
    time(order.payment_deadline);
    const states = { payment_state: ['awaiting', 'attempt_pending', 'outcome_unknown', 'settled', 'failed'],
      recording_state: ['n_a', 'pending', 'confirmed', 'reconciliation_required'],
      delivery_state: ['not_started', 'queued', 'signed_broadcast', 'confirmed', 'review_required'],
      refund_state: ['none', 'pending', 'succeeded', 'failed'],
      next_action: ['poll', 'retry_same_request', 'requote', 'contact_support', 'complete'] };
    for (const [key, values] of Object.entries(states)) if (!values.includes(order[key])) throw new StationError('INVALID_ORDER_STATE');
    let receipt: OrderResult['receipt'] = null;
    if (data.receipt != null) {
      const r = record(data.receipt);
      if (typeof r.tx_hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(r.tx_hash)
        || r.chain_id !== this.target.chainId || r.denom !== this.target.denom
        || r.delivered_base_units !== order.net_pwr_base_units || order.delivery_state !== 'confirmed'
        || order.payment_state !== 'settled' || order.refund_state !== 'none') throw new StationError('INVALID_DELIVERY_RECEIPT');
      receipt = { tx_hash: r.tx_hash.toUpperCase(), chain_id: r.chain_id, denom: r.denom, delivered_base_units: r.delivered_base_units };
    }
    if (order.next_action === 'complete' && !receipt && order.refund_state !== 'succeeded') throw new StationError('MISSING_DELIVERY_RECEIPT');
    return { order: structuredClone(order) as StationOrder, receipt };
  }

  async createOrder(quote: Quote, idempotencyKey: string): Promise<OrderResult> {
    this.spendingTerms(quote); identifier(quote.id, 'aqt');
    if (!idempotencyKey || idempotencyKey.length > 128) throw new StationError('INVALID_IDEMPOTENCY_KEY');
    // Do not reject an expired quote locally: replaying a previously submitted
    // request must remain possible after expiry to recover an existing order.
    let status = 0;
    try {
      const response = await this.request('/api/v1/agent/orders', { quote: quote.id, idempotency_key: idempotencyKey });
      status = response.status;
      return this.result(response.data, { quote });
    } catch (error) {
      // Even invalid JSON, a misleading remote code or a mismatched 200 body
      // cannot prove that order creation did not happen. Recover the same key.
      throw new StationError('REQUEST_OUTCOME_UNKNOWN', error instanceof StationError ? error.status || status : status, true);
    }
  }

  async getOrder(order: StationOrder): Promise<OrderResult> {
    identifier(order.id, 'aor');
    // Reconciliation reads remain available when the host lowers its spend cap.
    this.terms(order);
    return this.result((await this.request(`/api/v1/agent/orders/${order.id}`)).data, { order });
  }

  validatePayment(required: unknown, order: StationOrder): PaymentRequired {
    this.spendingTerms(order);
    if (order.payment_path !== 'x402') throw new StationError('X402_ORDER_REQUIRED');
    const payment = record(required);
    if (payment.x402Version !== 2 || !Array.isArray(payment.accepts) || payment.accepts.length !== 1) throw new StationError('INVALID_PAYMENT_REQUIREMENTS');
    const a = record(payment.accepts[0]);
    if (a.scheme !== 'exact' || a.network !== this.profile.paymentNetwork || typeof a.asset !== 'string' || a.asset.toLowerCase() !== this.profile.usdcContract.toLowerCase()) throw new StationError('USDC_REQUIRED');
    const extra = record(a.extra);
    if (extra.assetTransferMethod !== 'eip3009' || extra.name !== this.profile.usdcDomainName || extra.version !== this.profile.usdcDomainVersion) throw new StationError('USDC_DOMAIN_REQUIRED');
    if (a.amount !== (BigInt(order.total_cents) * 10000n).toString()
      || typeof a.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.payTo)) throw new StationError('INVALID_PAYMENT_TERMS');
    integer(a.maxTimeoutSeconds, true);
    if (a.maxTimeoutSeconds > 300) throw new StationError('AUTHORIZATION_WINDOW_TOO_LONG');
    return structuredClone(payment) as PaymentRequired;
  }

  async paymentRequirements(order: StationOrder): Promise<PaymentRequired> {
    identifier(order.id, 'aor');
    const submitted = this.submitted.get(order.id);
    if (this.submitted.has(order.id)) throw new StationError('PAYMENT_ALREADY_SUBMITTED', 0, false, submitted?.validBefore);
    this.spendingTerms(order);
    if (!['awaiting', 'failed'].includes(order.payment_state) || order.refund_state !== 'none') throw new StationError('POLL_ORDER_BEFORE_PAYING');
    if (time(order.payment_deadline) <= this.now()) throw new StationError('ORDER_EXPIRED');
    const response = await this.request(`/api/v1/agent/orders/${order.id}/pay`, {});
    if (response.status !== 402) throw new StationError('POLL_ORDER_BEFORE_PAYING');
    return this.validatePayment(response.data, order);
  }

  private authorization(order: StationOrder, required: PaymentRequired, signedPayment: string) {
    const terms = this.validatePayment(required, order).accepts[0]!;
    identifier(order.id, 'aor');
    if (!signedPayment || signedPayment.length > 16384) throw new StationError('INVALID_PAYMENT_SIGNATURE');
    let p;
    try { p = record(JSON.parse(Buffer.from(signedPayment, 'base64').toString('utf8'))); }
    catch { throw new StationError('INVALID_PAYMENT_SIGNATURE'); }
    const accepted = record(p.accepted), payload = record(p.payload), auth = record(payload.authorization);
    if (!isDeepStrictEqual(accepted, terms)) throw new StationError('SIGNED_TERMS_MISMATCH');
    if (p.x402Version !== 2 || auth.to !== terms.payTo || auth.value !== terms.amount
      || typeof auth.from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(auth.from)
      || typeof auth.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)
      || typeof payload.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(payload.signature)
      || typeof auth.validAfter !== 'string' || !/^(0|[1-9][0-9]{0,11})$/.test(auth.validAfter)
      || typeof auth.validBefore !== 'string' || !/^[1-9][0-9]{0,11}$/.test(auth.validBefore)
      || BigInt(auth.validBefore) <= BigInt(auth.validAfter)
      || BigInt(auth.validBefore) > BigInt(Math.floor(this.now() / 1000) + terms.maxTimeoutSeconds)) throw new StationError('INVALID_PAYMENT_AUTHORIZATION');
    return { digest: createHash('sha256').update(signedPayment).digest('hex'), validBefore: auth.validBefore as string };
  }

  private rememberSubmission(orderId: string, authorization: { digest: string; validBefore: string }): void {
    const previous = this.submitted.get(orderId);
    if (previous && previous.digest !== authorization.digest) {
      throw new StationError('PAYMENT_REPLACEMENT_FORBIDDEN', 0, false, previous.validBefore);
    }
    this.submitted.set(orderId, authorization);
  }

  /** Restore a private journaled attempt before using a fresh client instance.
   * The host must first authenticate the saved order identity: the payment
   * signature does not bind it. Once a valid ID is supplied, failed payment
   * validation keeps that ID blocked. Expiry alone never clears the guard. */
  restoreSubmittedPayment(order: StationOrder, required: PaymentRequired, signedPayment: string): void {
    identifier(order?.id, 'aor');
    // With a trusted order ID, clock drift, a reduced ceiling or damaged payment
    // data cannot establish non-submission. Block before validating the payment.
    if (!this.submitted.has(order.id)) this.submitted.set(order.id, null);
    this.rememberSubmission(order.id, this.authorization(order, required, signedPayment));
  }

  async submitPayment(order: StationOrder, required: PaymentRequired, signedPayment: string): Promise<OrderResult> {
    identifier(order.id, 'aor');
    if (this.submitted.get(order.id) === null) throw new StationError('PAYMENT_RESTORE_REQUIRED');
    // All local validation precedes dispatch. Record the exact attempt before
    // awaiting transport so overlapping callers cannot replace it or re-challenge.
    const authorization = this.authorization(order, required, signedPayment);
    this.rememberSubmission(order.id, authorization);
    const { validBefore } = authorization;
    let status = 0;
    try {
      const response = await this.request(`/api/v1/agent/orders/${order.id}/pay`, {}, signedPayment);
      status = response.status;
      if (status === 402) throw new StationError('PAYMENT_REJECTED_POLL_ORDER', status);
      return this.result(response.data, { order });
    } catch (error) {
      // Every post-dispatch failure, including result validation, is uncertain.
      // Expose no remote diagnostics or reusable authorization material.
      throw new StationError('REQUEST_OUTCOME_UNKNOWN', error instanceof StationError ? error.status || status : status, true, validBefore);
    }
  }
}
