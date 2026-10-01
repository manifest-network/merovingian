import { parseAddress } from '@manifest-network/manifest-sdk';
import { isDeepStrictEqual } from 'node:util';

/** Client-side purchase plumbing only. Never imported by the hosted refuge. */
export const PWR_STATION_QA = 'https://testnet.pwr-station.com';
export const TEST_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
export interface PurchaseTarget { recipient: string; chainId: 'manifest-ledger-testnet'; denom: string }
export interface StationPackage { id: string; price_cents: number; fees_cents: number; net_pwr_base_units: number }
export interface Quote extends StationPackage {
  package: string; payment_path: 'x402' | 'checkout'; recipient: string; total_cents: number;
  environment: 'sandbox'; chain_id: string; denom: string; expires_at: string;
}
export interface StationOrder extends Omit<Quote, 'expires_at'> {
  quote: string; payment_state: string; recording_state: string; delivery_state: string;
  refund_state: string; next_action: 'poll' | 'retry_same_request' | 'requote' | 'contact_support' | 'complete';
  payment_deadline: string;
}
export interface OrderResult {
  order: StationOrder;
  receipt: null | { tx_hash: string; chain_id: string; denom: string; delivered_base_units: number };
}
export interface PaymentRequired {
  x402Version: 2;
  accepts: { scheme: 'exact'; network: 'eip155:84532'; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; [key: string]: unknown }[];
  [key: string]: unknown;
}
export interface StationSigner {
  getAddress(): Promise<string>;
  signArbitrary(address: string, message: string): Promise<{ signature: string; pub_key: { value: string } }>;
}
export class StationError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); this.name = 'StationError'; }
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
 * Testnet-only until QA end-to-end acceptance. A QA hostname or sandbox
 * flag never authorizes Base mainnet payments. No automatic retries or signing.
 * The caller must persist quote, idempotency key, order and exact signed payment
 * privately before the corresponding request, and reuse them after a timeout.
 */
export class PwrStationClient {
  private token?: string;
  private readonly target: Readonly<PurchaseTarget>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(target: PurchaseTarget, private readonly maxTotalCents: number,
    options: { fetch?: typeof fetch; now?: () => number } = {}) {
    address(target.recipient);
    if (target.chainId !== 'manifest-ledger-testnet' || !/^[a-zA-Z][a-zA-Z0-9/:._-]{2,255}$/.test(target.denom)) throw new StationError('TESTNET_REQUIRED');
    integer(maxTotalCents, true);
    this.target = Object.freeze({ ...target });
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async request(path: string, body?: object, payment?: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(PWR_STATION_QA + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(payment ? { 'PAYMENT-SIGNATURE': payment } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.body) throw new StationError('INVALID_RESPONSE');
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
      const envelope = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (response.status === 402 && envelope.error?.code === 'AGENT_PAYMENT_REQUIRED') {
        const header = response.headers.get('PAYMENT-REQUIRED');
        const required = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : envelope.error?.details?.payment_required;
        return { status: 402, data: required };
      }
      if (!response.ok || envelope.success !== true) {
        const code = envelope.error?.code;
        throw new StationError(typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'STATION_UNAVAILABLE', response.status);
      }
      return { status: response.status, data: envelope.data };
    } catch (error) {
      // Remote errors and fetch diagnostics may contain credentials or signed
      // authorizations. Only stable, locally constructed codes leave this client.
      if (error instanceof StationError) throw error;
      throw new StationError('REQUEST_OUTCOME_UNKNOWN');
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
    if (q.environment !== 'sandbox' || q.chain_id !== this.target.chainId || q.denom !== this.target.denom || q.recipient !== this.target.recipient) throw new StationError('TARGET_MISMATCH');
    identifier(q.package, 'apk');
    if (!['x402', 'checkout'].includes(q.payment_path)) throw new StationError('INVALID_PAYMENT_PATH');
    integer(q.price_cents); integer(q.fees_cents); integer(q.total_cents, true); integer(q.net_pwr_base_units, true);
    if (BigInt(q.total_cents) !== BigInt(q.price_cents) + BigInt(q.fees_cents) || q.total_cents > this.maxTotalCents) throw new StationError('SPEND_LIMIT_EXCEEDED');
    return q;
  }

  async quote(packageId: string, paymentPath: 'x402' | 'checkout' = 'x402'): Promise<Quote> {
    identifier(packageId, 'apk');
    const q = this.terms((await this.request('/api/v1/agent/quotes', { package: packageId, payment_path: paymentPath, recipient: this.target.recipient })).data);
    identifier(q.id, 'aqt');
    if (q.package !== packageId || q.payment_path !== paymentPath) throw new StationError('QUOTE_MISMATCH');
    if (time(q.expires_at) <= this.now()) throw new StationError('QUOTE_EXPIRED');
    return structuredClone(q) as Quote;
  }

  private result(value: unknown, expected: Quote | StationOrder): OrderResult {
    const data = record(value), order = this.terms(data.order);
    identifier(order.id, 'aor'); identifier(order.quote, 'aqt');
    equalTerms(order, expected);
    if (order.quote !== ('quote' in expected ? expected.quote : expected.id)
      || ('quote' in expected && order.id !== expected.id)) throw new StationError('ORDER_MISMATCH');
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
    this.terms(quote); identifier(quote.id, 'aqt');
    if (!idempotencyKey || idempotencyKey.length > 128) throw new StationError('INVALID_IDEMPOTENCY_KEY');
    // Do not reject an expired quote locally: replaying a previously submitted
    // request must remain possible after expiry to recover an existing order.
    return this.result((await this.request('/api/v1/agent/orders', { quote: quote.id, idempotency_key: idempotencyKey })).data, quote);
  }

  async getOrder(order: StationOrder): Promise<OrderResult> {
    identifier(order.id, 'aor');
    return this.result((await this.request(`/api/v1/agent/orders/${order.id}`)).data, order);
  }

  validatePayment(required: unknown, order: StationOrder): PaymentRequired {
    this.terms(order);
    if (order.payment_path !== 'x402') throw new StationError('X402_ORDER_REQUIRED');
    const payment = record(required);
    if (payment.x402Version !== 2 || !Array.isArray(payment.accepts) || payment.accepts.length !== 1) throw new StationError('INVALID_PAYMENT_REQUIREMENTS');
    const a = record(payment.accepts[0]);
    if (a.scheme !== 'exact' || a.network !== 'eip155:84532' || typeof a.asset !== 'string' || a.asset.toLowerCase() !== TEST_USDC) throw new StationError('TEST_USDC_REQUIRED');
    const extra = record(a.extra);
    if (extra.assetTransferMethod !== 'eip3009' || extra.name !== 'USDC' || extra.version !== '2') throw new StationError('TEST_USDC_DOMAIN_REQUIRED');
    if (a.amount !== (BigInt(order.total_cents) * 10000n).toString()
      || typeof a.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.payTo)) throw new StationError('INVALID_PAYMENT_TERMS');
    integer(a.maxTimeoutSeconds, true);
    if (a.maxTimeoutSeconds > 300) throw new StationError('AUTHORIZATION_WINDOW_TOO_LONG');
    return structuredClone(payment) as PaymentRequired;
  }

  async paymentRequirements(order: StationOrder): Promise<PaymentRequired> {
    identifier(order.id, 'aor');
    this.terms(order);
    if (!['awaiting', 'failed'].includes(order.payment_state) || order.refund_state !== 'none') throw new StationError('POLL_ORDER_BEFORE_PAYING');
    if (time(order.payment_deadline) <= this.now()) throw new StationError('ORDER_EXPIRED');
    const response = await this.request(`/api/v1/agent/orders/${order.id}/pay`, {});
    if (response.status !== 402) throw new StationError('POLL_ORDER_BEFORE_PAYING');
    return this.validatePayment(response.data, order);
  }

  async submitPayment(order: StationOrder, required: PaymentRequired, signedPayment: string): Promise<OrderResult> {
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
    // Exact replay only; this method never generates a nonce, signature or order.
    const response = await this.request(`/api/v1/agent/orders/${order.id}/pay`, {}, signedPayment);
    if (response.status === 402) throw new StationError('PAYMENT_REJECTED_POLL_ORDER');
    return this.result(response.data, order);
  }
}
