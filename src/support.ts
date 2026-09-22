import { createHash } from 'node:crypto';
import { parseAddress } from '@manifest-network/manifest-sdk';
import { liftedinit } from '@manifest-network/manifestjs';
import { TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { FUND_CREDIT_TYPE, FUNDING_PLACEHOLDERS, HISTORY_LIMIT, SUPPORT_MESSAGES } from './protocol.js';

export { FUND_CREDIT_TYPE } from './protocol.js';
const HASH = /^[0-9a-fA-F]{64}$/;
const INTEGER = /^(0|[1-9][0-9]{0,77})$/;
const MAX_TX_BYTES = 1_000_000;
const MAX_CREDIT_RESPONSE_BYTES = 64 * 1024;
const BODY_CLEANUP_GRACE_MS = 100;
const UINT64_MAX = 18_446_744_073_709_551_615n;

export interface SupportConfig {
  chainId: string;
  rpcUrl: string;
  restUrl?: string;
  gasPrice: string;
  pwrDenom: string;
  tenant: string;
  network: 'testnet' | 'mainnet';
}

export interface ChainTransaction {
  hash: string;
  height: string;
  code: number;
  bytes: Uint8Array;
}

export interface HostingCredit {
  available: { denom: string; amount: string }[];
  reserved: { denom: string; amount: string }[];
  activeLeases: string;
}

/** REST transaction records stay unknown until all contribution fields are validated. */
export interface FundingHistoryPage {
  total: string;
  txResponses: readonly unknown[];
}

export interface ContributionHistory {
  status: 'available' | 'unavailable' | 'unconfigured';
  network: SupportConfig['network'];
  chainId: string;
  tenant: string;
  denom: string;
  checkedAt: string | null;
  entries: {
    transactionHash: string;
    height: string;
    timestamp: string;
    sender: string;
    amount: string;
  }[];
  totals: { amount: string; tenantAmount: string; otherAmount: string } | null;
  indexedTransactions: number | null;
  scannedTransactions: number;
  complete: boolean;
  message: string;
}

/** Read-only seam; endpoints always come from the operator's configuration. */
export interface ChainGateway {
  getChainId(signal: AbortSignal): Promise<string>;
  getTransaction(hash: string, signal: AbortSignal): Promise<ChainTransaction | null>;
  getCredit(tenant: string, signal: AbortSignal): Promise<HostingCredit | null>;
  getFundingHistory?(tenant: string, signal: AbortSignal): Promise<FundingHistoryPage>;
  dispose?(): void;
}

export interface ContributionReceipt {
  id: string;
  network: SupportConfig['network'];
  chainId: string;
  transactionHash: string;
  height: string;
  tenant: string;
  amount: { denom: string; amount: string };
  contributions: { sender: string; amount: string }[];
  message: string;
  transferable: false;
  provesOwnership: false;
}

export type VerificationResult =
  | { status: 'confirmed'; receipt: ContributionReceipt }
  | {
      status: 'pending' | 'failed' | 'not_a_contribution' | 'invalid_request' | 'unavailable' | 'unconfigured';
      message: string;
    };

export interface SupportInfo {
  status: 'available' | 'unavailable' | 'unconfigured';
  network: SupportConfig['network'];
  chainId: string;
  tenant: string;
  denom: string;
  optional: true;
  testTokensOnly: boolean;
  message: string;
  instructions: {
    typeUrl: typeof FUND_CREDIT_TYPE;
    value: { sender: string; tenant: string; amount: { denom: string; amount: string } };
    notice: string;
  } | null;
  hostingCredit: HostingCredit | null;
  checkedAt: string | null;
}

function addressIsValid(address: unknown): address is string {
  if (typeof address !== 'string') return false;
  try {
    parseAddress(address, 'manifest');
    return true;
  } catch {
    return false;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function timestampIsValid(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19);
}

function fundingCoin(value: unknown): { amount: bigint; denom: string } {
  if (typeof value !== 'string') throw new Error('Missing funding coin');
  const coin = /^([1-9][0-9]{0,77})([a-zA-Z][a-zA-Z0-9/:._-]{2,255})$/.exec(value);
  if (!coin) throw new Error('Invalid funding coin');
  return { amount: BigInt(coin[1]!), denom: coin[2]! };
}

function fundingEvent(value: unknown, tenant: string) {
  const event = object(value);
  if (!event || typeof event.type !== 'string') throw new Error('Invalid transaction event');
  if (event.type !== 'credit_funded') return null;
  if (!Array.isArray(event.attributes)) throw new Error('Missing funding event attributes');
  const critical = new Set(['tenant', 'sender', 'amount', 'credit_address', 'new_balance']);
  const attributes = new Map<string, string>();
  for (const value of event.attributes) {
    const attribute = object(value);
    if (!attribute || typeof attribute.key !== 'string' || typeof attribute.value !== 'string') {
      throw new Error('Invalid funding event attribute');
    }
    if (!critical.has(attribute.key)) continue;
    if (attributes.has(attribute.key)) throw new Error('Duplicate funding event attribute');
    attributes.set(attribute.key, attribute.value);
  }
  const eventTenant = attributes.get('tenant');
  if (!addressIsValid(eventTenant)) throw new Error('Invalid funding event tenant');
  if (eventTenant.toLowerCase() !== tenant) return null;
  const sender = attributes.get('sender');
  const creditAddress = attributes.get('credit_address');
  if (!addressIsValid(sender) || !addressIsValid(creditAddress)) throw new Error('Invalid funding event address');
  const amount = fundingCoin(attributes.get('amount'));
  const balance = fundingCoin(attributes.get('new_balance'));
  if (balance.denom !== amount.denom) throw new Error('Inconsistent funding event denomination');
  // new_balance validates the event shape only; the deposit is always the amount attribute.
  return { sender: sender.toLowerCase(), ...amount };
}

function summarizeHistory(page: FundingHistoryPage, config: Readonly<SupportConfig>) {
  if (typeof page.total !== 'string' || !INTEGER.test(page.total)
    || BigInt(page.total) > BigInt(Number.MAX_SAFE_INTEGER)
    || !Array.isArray(page.txResponses) || page.txResponses.length > HISTORY_LIMIT) {
    throw new Error('Invalid contribution history page');
  }
  const indexedTransactions = Number(page.total);
  const historyTenant = config.tenant.toLowerCase();
  if (indexedTransactions > 0 && page.txResponses.length === 0) throw new Error('Missing history records');
  const seen = new Map<string, string>();
  const entries: ContributionHistory['entries'] = [];
  let tenantAmount = 0n;
  let otherAmount = 0n;
  for (const value of page.txResponses) {
    const response = object(value);
    if (!response || typeof response.txhash !== 'string' || !HASH.test(response.txhash)
      || typeof response.height !== 'string' || !INTEGER.test(response.height) || BigInt(response.height) <= 0n
      || typeof response.code !== 'number' || !Number.isSafeInteger(response.code) || response.code < 0
      || !timestampIsValid(response.timestamp)) throw new Error('Invalid indexed transaction');
    const transaction = object(response.tx);
    const messages = object(transaction?.body)?.messages;
    if (transaction?.['@type'] !== '/cosmos.tx.v1beta1.Tx' || !Array.isArray(messages) || messages.length === 0
      || messages.some((message) => typeof object(message)?.['@type'] !== 'string')) {
      throw new Error('Missing indexed transaction body');
    }
    if (!Array.isArray(response.events)) throw new Error('Missing indexed transaction events');
    const hash = response.txhash.toUpperCase();
    const fingerprint = JSON.stringify([response.height, response.code, response.timestamp, transaction, response.events]);
    if (seen.has(hash)) {
      if (seen.get(hash) !== fingerprint) throw new Error('Conflicting copies of indexed transaction');
      continue;
    }
    seen.set(hash, fingerprint);
    if (response.code !== 0) continue;
    const amounts = new Map<string, bigint>();
    const executed = new Map<string, bigint>();
    let hasFundingEvent = false;
    for (const value of response.events) {
      if (object(value)?.type === 'credit_funded') hasFundingEvent = true;
      const funding = fundingEvent(value, historyTenant);
      if (!funding) continue;
      const key = JSON.stringify([funding.sender, funding.denom]);
      executed.set(key, (executed.get(key) ?? 0n) + funding.amount);
      if (funding.denom === config.pwrDenom) {
        amounts.set(funding.sender, (amounts.get(funding.sender) ?? 0n) + funding.amount);
      }
    }
    if (!hasFundingEvent) throw new Error('Indexed funding transaction has no funding events');
    // Direct messages provide an additional consistency check. Wrapped executions are
    // accounted for by their emitted events, even when their bodies live in group state.
    const direct = new Map<string, bigint>();
    let mayExecuteNested = false;
    for (const value of messages) {
      const funding = object(value)!;
      if (funding['@type'] !== FUND_CREDIT_TYPE) { mayExecuteNested = true; continue; }
      if (!addressIsValid(funding.tenant)) throw new Error('Invalid indexed funding tenant');
      if (funding.tenant.toLowerCase() !== historyTenant) continue;
      const amount = object(funding.amount);
      if (!addressIsValid(funding.sender) || typeof amount?.denom !== 'string' || typeof amount.amount !== 'string'
        || !INTEGER.test(amount.amount) || BigInt(amount.amount) <= 0n) throw new Error('Invalid indexed funding message');
      const coin = fundingCoin(`${amount.amount}${amount.denom}`);
      const key = JSON.stringify([funding.sender.toLowerCase(), coin.denom]);
      direct.set(key, (direct.get(key) ?? 0n) + coin.amount);
    }
    for (const [key, amount] of direct) {
      if ((executed.get(key) ?? 0n) < amount) throw new Error('Funding event disagrees with transaction body');
    }
    if (!mayExecuteNested && (direct.size !== executed.size
      || [...executed].some(([key, amount]) => direct.get(key) !== amount))) {
      throw new Error('Funding event disagrees with transaction body');
    }
    for (const [sender, amount] of [...amounts].sort(([a], [b]) => a.localeCompare(b))) {
      entries.push({ transactionHash: hash, height: response.height, timestamp: response.timestamp, sender, amount: amount.toString() });
      if (sender === historyTenant) tenantAmount += amount;
      else otherAmount += amount;
    }
  }
  if (seen.size > indexedTransactions) throw new Error('Inconsistent history total');
  entries.sort((a, b) => BigInt(a.height) === BigInt(b.height)
    ? a.transactionHash.localeCompare(b.transactionHash) || a.sender.localeCompare(b.sender)
    : BigInt(a.height) > BigInt(b.height) ? -1 : 1);
  return {
    entries, indexedTransactions, scannedTransactions: seen.size,
    complete: seen.size === indexedTransactions,
    totals: { amount: (tenantAmount + otherAmount).toString(), tenantAmount: tenantAmount.toString(), otherAmount: otherAmount.toString() },
  };
}

function creditCoins(value: unknown): HostingCredit['available'] {
  // Protobuf JSON may omit repeated fields at their empty default. Explicit
  // null and other malformed values remain invalid at this transport boundary.
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid credit coins');
  const denoms = new Set<string>();
  return value.map((value) => {
    const coin = object(value);
    if (typeof coin?.denom !== 'string' || !/^[a-zA-Z][a-zA-Z0-9/:._-]{2,255}$/.test(coin.denom)
      || typeof coin.amount !== 'string' || !INTEGER.test(coin.amount) || denoms.has(coin.denom)) {
      throw new Error('Invalid credit coin');
    }
    denoms.add(coin.denom);
    return { denom: coin.denom, amount: coin.amount };
  });
}

function hostingCredit(value: unknown, tenant: string): HostingCredit {
  const response = object(value);
  const account = object(response?.credit_account);
  const activeLeases = account?.active_lease_count === undefined ? '0' : account.active_lease_count;
  if (!account || !addressIsValid(account.tenant) || account.tenant.toLowerCase() !== tenant.toLowerCase()
    || !addressIsValid(account.credit_address)
    || typeof activeLeases !== 'string' || !INTEGER.test(activeLeases)
    || BigInt(activeLeases) > UINT64_MAX) throw new Error('Invalid credit account');
  return {
    available: creditCoins(response?.available_balances),
    reserved: creditCoins(account.reserved_amounts),
    activeLeases,
  };
}

async function settleBodyCancellation(cancellation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The native fetch controller must already be aborted. A broken body cancel
    // hook cannot keep the service's concurrency slot or reader lock forever.
    await Promise.race([cancellation.catch(() => {}), new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BODY_CLEANUP_GRACE_MS);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal, abortTransport: (reason: unknown) => void,
  limit: number): Promise<Record<string, any>> {
  if (!response.body) throw new Error('Empty chain response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cancellation: Promise<void> | undefined;
  // Cancel the reader as well as the native transport, including custom response
  // bodies whose cancel hooks are independent of fetch's signal.
  const cancel = () => cancellation ??= reader.cancel(signal.reason).catch(() => {});
  const abort = () => { void cancel(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Chain response exceeds limit');
      chunks.push(value);
    }
  } catch (error) {
    abortTransport(error);
    await settleBodyCancellation(cancel());
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid chain response');
  return parsed as Record<string, any>;
}

/** Read-only native fetch keeps the service deadline attached to sockets and bodies. */
class ManifestChainGateway implements ChainGateway {
  private disposed = false;

  constructor(private readonly config: SupportConfig) {}

  private async query(url: string, signal: AbortSignal, limit = MAX_TX_BYTES * 2,
    errorStatuses: readonly number[] = []): Promise<{ response: Response; body: Record<string, any> }> {
    if (this.disposed) throw new Error('Support service closed');
    signal.throwIfAborted();
    const transport = new AbortController();
    const requestSignal = AbortSignal.any([signal, transport.signal]);
    try {
      const response = await fetch(url, { signal: requestSignal, redirect: 'error' });
      if (!response.ok && !errorStatuses.includes(response.status)) {
        const error = new Error('Chain query unavailable');
        transport.abort(error);
        if (response.body) await settleBodyCancellation(response.body.cancel());
        throw error;
      }
      const body = await readBoundedJson(response, requestSignal, (reason) => transport.abort(reason), limit);
      return { response, body };
    } finally {
      // On read/size/status failure this has already aborted the socket before
      // cleanup. It also covers fetch failures and a service deadline racing it.
      transport.abort();
    }
  }

  private async rpc(path: string, signal: AbortSignal): Promise<Record<string, any>> {
    const { response, body } = await this.query(`${this.config.rpcUrl.replace(/\/$/, '')}/${path}`, signal, MAX_TX_BYTES * 2, [400, 500]);
    // CometBFT uses HTTP 500 for JSON-RPC errors, including an absent transaction.
    if (!response.ok && !([400, 500].includes(response.status) && body.error)) throw new Error('Chain query unavailable');
    return body;
  }

  async getChainId(signal: AbortSignal): Promise<string> {
    // Check both configured endpoints before using their data.
    const status = await this.rpc('status', signal);
    const chainId: unknown = status.result?.node_info?.network;
    if (typeof chainId !== 'string') throw new Error('Chain identity unavailable');
    if (this.config.restUrl) {
      const { body: info } = await this.query(`${this.config.restUrl.replace(/\/$/, '')}/cosmos/base/tendermint/v1beta1/node_info`, signal);
      if (info.default_node_info?.network !== chainId) throw new Error('REST and RPC chains differ');
    }
    return chainId;
  }

  async getTransaction(hash: string, signal: AbortSignal): Promise<ChainTransaction | null> {
    const response = await this.rpc(`tx?hash=0x${hash}&prove=false`, signal);
    if (response.error) {
      // Absence from the index is not evidence of success, or even of mempool inclusion.
      const data: unknown = response.error.data;
      if (response.error.code === -32603 && typeof data === 'string' && data.toUpperCase() === `TX (${hash}) NOT FOUND`) return null;
      throw new Error('Transaction query unavailable');
    }
    const result = response.result;
    if (!result || typeof result.hash !== 'string' || typeof result.height !== 'string'
      || typeof result.tx !== 'string' || typeof result.tx_result?.code !== 'number'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.tx)) {
      throw new Error('Invalid transaction response');
    }
    return { hash: result.hash, height: result.height, code: result.tx_result.code, bytes: Buffer.from(result.tx, 'base64') };
  }

  async getCredit(tenant: string, signal: AbortSignal): Promise<HostingCredit | null> {
    if (!this.config.restUrl) throw new Error('REST endpoint is not configured');
    const { response, body } = await this.query(`${this.config.restUrl.replace(/\/$/, '')}/liftedinit/billing/v1/credit/${encodeURIComponent(tenant)}`, signal, MAX_CREDIT_RESPONSE_BYTES, [404]);
    // Only the chain's structured gRPC NotFound means no credit account. A proxy
    // 404, malformed/partial data or another query failure must stay unavailable.
    if (response.status === 404 && body.code === 5 && typeof body.message === 'string') return null;
    if (!response.ok) throw new Error('Credit query unavailable');
    return hostingCredit(body, tenant);
  }

  async getFundingHistory(tenant: string, signal: AbortSignal): Promise<FundingHistoryPage> {
    if (!this.config.restUrl) throw new Error('REST endpoint is not configured');
    // Manifest's GetTxsEvent uses page/limit and returns CometBFT's count in
    // top-level total. Deprecated pagination.count_total is not consulted.
    // Keep total distinct from this page's length; see docs/API-CONTRACTS.md.
    const query = new URLSearchParams({
      query: `credit_funded.tenant='${tenant}'`, order_by: 'ORDER_BY_DESC', limit: String(HISTORY_LIMIT), page: '1',
    });
    const { body: page } = await this.query(`${this.config.restUrl.replace(/\/$/, '')}/cosmos/tx/v1beta1/txs?${query}`, signal);
    if (typeof page.total !== 'string' || !Array.isArray(page.tx_responses)) throw new Error('Invalid contribution index response');
    return { total: page.total, txResponses: page.tx_responses };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** No keys, signing, balances for visitors, or spendable rewards are held here. */
export class SupportService {
  private readonly gateway: ChainGateway;
  private readonly config: Readonly<SupportConfig>;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly circuitMs: number;
  private readonly now: () => number;
  private failuresUntil = 0;
  private active = 0;
  private infoCache?: { expires: number; info: SupportInfo };
  private infoPending?: Promise<SupportInfo>;
  private historyCache?: { expires: number; history: ContributionHistory };
  private historyPending?: Promise<ContributionHistory>;

  constructor(config: SupportConfig, gateway?: ChainGateway, options: {
    timeoutMs?: number; cacheMs?: number; circuitMs?: number; now?: () => number;
  } = {}) {
    this.config = Object.freeze({ ...config });
    this.gateway = gateway ?? new ManifestChainGateway(this.config);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.cacheMs = options.cacheMs ?? 60_000;
    this.circuitMs = options.circuitMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  private get configured(): boolean {
    return addressIsValid(this.config.tenant) && !!this.config.pwrDenom && !!this.config.chainId;
  }

  private async read<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.now() < this.failuresUntil || this.active >= 4) throw new Error('Chain temporarily unavailable');
    this.active++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(async () => {
      const chainId = await this.gateway.getChainId(controller.signal);
      if (chainId !== this.config.chainId) throw new Error('Wrong network');
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }).finally(() => { this.active--; });
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Chain query timed out'));
        }, this.timeoutMs);
      })]);
    } catch (error) {
      this.failuresUntil = this.now() + this.circuitMs;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getInfo(): Promise<SupportInfo> {
    if (this.infoCache && this.now() < this.infoCache.expires) return structuredClone(this.infoCache.info);
    if (this.infoPending) return structuredClone(await this.infoPending);
    const pending = this.loadInfo();
    this.infoPending = pending;
    try {
      const info = await pending;
      this.infoCache = { expires: this.now() + (info.status === 'available' ? this.cacheMs : this.circuitMs), info };
      return structuredClone(info);
    } finally {
      if (this.infoPending === pending) this.infoPending = undefined;
    }
  }

  private async loadInfo(): Promise<SupportInfo> {
    const info: SupportInfo = {
      status: 'unconfigured', network: this.config.network, chainId: this.config.chainId,
      tenant: this.config.tenant, denom: this.config.pwrDenom, optional: true,
      testTokensOnly: this.config.network === 'testnet',
      message: SUPPORT_MESSAGES.unconfigured,
      instructions: null, hostingCredit: null, checkedAt: null,
    };
    if (!this.configured) return info;
    try {
      info.hostingCredit = await this.read((signal) => this.gateway.getCredit(this.config.tenant, signal));
      info.status = 'available';
      info.checkedAt = new Date(this.now()).toISOString();
      info.message = SUPPORT_MESSAGES.available(this.config.network);
      info.instructions = {
        typeUrl: FUND_CREDIT_TYPE,
        value: { sender: FUNDING_PLACEHOLDERS.sender, tenant: this.config.tenant,
          amount: { denom: this.config.pwrDenom, amount: FUNDING_PLACEHOLDERS.amount } },
        notice: SUPPORT_MESSAGES.fundingNotice,
      };
    } catch {
      info.status = 'unavailable';
      info.message = SUPPORT_MESSAGES.unavailable;
    }
    return info;
  }

  async getHistory(): Promise<ContributionHistory> {
    if (this.historyCache && this.now() < this.historyCache.expires) return structuredClone(this.historyCache.history);
    if (this.historyPending) return structuredClone(await this.historyPending);
    const pending = this.loadHistory();
    this.historyPending = pending;
    try {
      const history = await pending;
      this.historyCache = { expires: this.now() + (history.status === 'available' ? this.cacheMs : this.circuitMs), history };
      return structuredClone(history);
    } finally {
      if (this.historyPending === pending) this.historyPending = undefined;
    }
  }

  private async loadHistory(): Promise<ContributionHistory> {
    const history: ContributionHistory = {
      status: 'unconfigured', network: this.config.network, chainId: this.config.chainId,
      tenant: this.config.tenant, denom: this.config.pwrDenom, checkedAt: null,
      entries: [], totals: null, indexedTransactions: null, scannedTransactions: 0, complete: false,
      message: SUPPORT_MESSAGES.historyUnconfigured,
    };
    if (!this.configured || !this.config.restUrl) return history;
    try {
      const summary = await this.read(async (signal) => {
        if (!this.gateway.getFundingHistory) throw new Error('History query is unavailable');
        return summarizeHistory(await this.gateway.getFundingHistory(this.config.tenant, signal), this.config);
      });
      Object.assign(history, summary);
      history.status = 'available';
      history.checkedAt = new Date(this.now()).toISOString();
      history.message = summary.complete
        ? SUPPORT_MESSAGES.historyComplete
        : SUPPORT_MESSAGES.historyPartial(summary.scannedTransactions, summary.indexedTransactions);
    } catch {
      history.status = 'unavailable';
      history.message = SUPPORT_MESSAGES.historyUnavailable;
    }
    return history;
  }

  async verify(input: { transactionHash: string; expectedSender?: string }): Promise<VerificationResult> {
    if (!input || typeof input.transactionHash !== 'string' || !HASH.test(input.transactionHash)
      || (input.expectedSender !== undefined && !addressIsValid(input.expectedSender))) {
      return { status: 'invalid_request', message: SUPPORT_MESSAGES.invalidHash };
    }
    if (!this.configured) return { status: 'unconfigured', message: SUPPORT_MESSAGES.verificationUnconfigured };
    const hash = input.transactionHash.toUpperCase();
    let tx: ChainTransaction | null;
    try {
      tx = await this.read((signal) => this.gateway.getTransaction(hash, signal));
    } catch {
      return { status: 'unavailable', message: SUPPORT_MESSAGES.verificationUnavailable };
    }
    if (!tx) return { status: 'pending', message: SUPPORT_MESSAGES.pending };
    if (!HASH.test(tx.hash) || tx.hash.toUpperCase() !== hash || !INTEGER.test(tx.height)
      || BigInt(tx.height) <= 0n || !Number.isSafeInteger(tx.code) || tx.code < 0
      || !(tx.bytes instanceof Uint8Array) || tx.bytes.length === 0 || tx.bytes.length > MAX_TX_BYTES
      || createHash('sha256').update(tx.bytes).digest('hex').toUpperCase() !== hash) {
      return { status: 'unavailable', message: SUPPORT_MESSAGES.inconsistentTransaction };
    }
    if (tx.code !== 0) return { status: 'failed', message: SUPPORT_MESSAGES.failed };
    const amounts = new Map<string, bigint>();
    try {
      const raw = TxRaw.decode(tx.bytes);
      if (!raw.signatures.length || raw.signatures.some((signature) => signature.length === 0)) throw new Error('Unsigned transaction');
      for (const message of TxBody.decode(raw.bodyBytes).messages) {
        if (message.typeUrl !== FUND_CREDIT_TYPE) continue;
        const funding = liftedinit.billing.v1.MsgFundCredit.decode(message.value);
        if (funding.tenant !== this.config.tenant || funding.amount?.denom !== this.config.pwrDenom) continue;
        if (!addressIsValid(funding.sender) || !INTEGER.test(funding.amount.amount)
          || BigInt(funding.amount.amount) <= 0n) throw new Error('Invalid funding message');
        amounts.set(funding.sender, (amounts.get(funding.sender) ?? 0n) + BigInt(funding.amount.amount));
      }
    } catch {
      return { status: 'not_a_contribution', message: SUPPORT_MESSAGES.undecodable };
    }
    if (amounts.size === 0 || (input.expectedSender !== undefined && !amounts.has(input.expectedSender))) {
      return { status: 'not_a_contribution', message: SUPPORT_MESSAGES.notAContribution };
    }
    const contributions = [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([sender, amount]) => ({ sender, amount: amount.toString() }));
    const total = [...amounts.values()].reduce((sum, amount) => sum + amount, 0n);
    // No time or random ID: replaying a hash reproduces this public souvenir, never a reward.
    return { status: 'confirmed', receipt: {
      id: `merovingian:${this.config.network}:${this.config.chainId}:${hash.toLowerCase()}`,
      network: this.config.network, chainId: this.config.chainId, transactionHash: hash,
      height: tx.height, tenant: this.config.tenant,
      amount: { denom: this.config.pwrDenom, amount: total.toString() }, contributions,
      message: SUPPORT_MESSAGES.receipt,
      transferable: false, provesOwnership: false,
    } };
  }

  dispose(): void { this.gateway.dispose?.(); }
}
