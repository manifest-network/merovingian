# PWR-Station integration — testnet first

Status on October 2, 2026: the full testnet purchase passed. An agent-controlled
wallet spent **1 test USDC on Base Sepolia**, and PWR-Station delivered
**1 test PWR directly to the existing 32-byte hosting credit address**.
Merovingian's local HTTP and MCP interfaces confirmed the same receipt, and
history counted the deposit once. Replaying the paid request returned the same
receipt without another charge or delivery. No production release has been made.
See the [end-to-end evidence](evidence/pwr-station-2026-10-02.json).

Existing visits stay free. These are two separate destinations:

| Purpose | PWR recipient | Effect |
| --- | --- | --- |
| Optional hosting contribution | Locally derived tenant credit address, checked against the existing billing account | Adds nonwithdrawable hosting credit |
| Future gifts or paid extras | Infrastructure hosting provider's verified payout wallet | Pays that provider; does not replenish tenant credit or generate studio revenue |

## Why direct delivery works

`MsgFundCredit` is still the supported route to create or fund a credit account.
For an **existing** account, its credit is the bank balance at its derived address,
less reserved amounts. PWR-Station can therefore deliver PWR with `MsgSend` to that
address. Sending to the tenant wallet or the provider wallet has a different effect.

The inspected ledger version was v2.3.1, commit
`a6e964a61ca848c3ff10bb8b86da142dba4ccbf3`.
[FundCredit](https://github.com/manifest-network/manifest-ledger/blob/a6e964a61ca848c3ff10bb8b86da142dba4ccbf3/x/billing/keeper/msg_server.go#L42)
moves bank coins and gets or creates the account;
[GetCreditBalance](https://github.com/manifest-network/manifest-ledger/blob/a6e964a61ca848c3ff10bb8b86da142dba4ccbf3/x/billing/keeper/keeper.go#L772)
reads that bank balance, and the
[credit query](https://github.com/manifest-network/manifest-ledger/blob/a6e964a61ca848c3ff10bb8b86da142dba4ccbf3/x/billing/keeper/querier.go#L237)
reports available credit after reservations.

Merovingian derives the destination from the configured tenant bytes using
[DeriveCreditAddress](https://github.com/manifest-network/manifest-ledger/blob/a6e964a61ca848c3ff10bb8b86da142dba4ccbf3/x/billing/types/credit.go)
and the pinned SDK's
[module-address hash](https://github.com/manifest-network/cosmos-sdk/blob/v0.50.14-liftedinit.1/types/address/hash.go).
The REST credit query must return that same address. A syntactically valid but
different REST address is rejected. Local derivation identifies a destination;
it does not establish that a billing account has been created there.

The October 1 test sent **100,000 base units (0.1 test PWR)** in one `MsgSend`.
Available credit increased from **4,243,500 to 4,343,500** base units. The fixed fee
was **330,000 umfx (0.33 test MFX)**. The temporary sender used only faucet funds;
its key stayed in memory. There were no active leases, no lease changes, and no
live visits. The local receipt verifier confirmed the deposit, and the history
query counted it once.
[Confirmed test transaction](https://nodes.liftedinit.tech/manifest/testnet/api/cosmos/tx/v1beta1/txs/388046AF8E87B5E2BCA9C6C9BD368B7EDA7DFFEBF573FA37A9250FAAFAA26355).

This proves the Manifest receiving leg. It was not a PWR-Station purchase.

## Prepared implementation

- `GET /api/v1/support` and MCP `hosting_support` expose
  the locally derived `hostingCredit.creditAddress` only after RPC/REST chain and
  credit-account consistency checks. The required field changes the strict API
  contract; see the [0.5.0 migration note](API-CONTRACTS.md#compatibility-for-the-prepared-050-release).
  The original `MsgFundCredit` instruction template remains available. A missing
  account must be created before attempting distributor delivery.
- HTTP/MCP receipt verification accepts a successful, signed, indexed root
  `MsgSend` with the configured PWR denomination and the derived credit address.
  It also accepts `MsgFundCredit`, combines matching messages with integer
  arithmetic, and rejects provider payouts, tenant-wallet sends and self-transfers.
- History uses the single `transfer.recipient` index and counts bank movements
  once. `MsgFundCredit` emits both bank and billing events; billing events check
  consistency instead of adding the same amount again. Executed wrapped transfers
  are supported in history. The latest-100 limit and partial-history notices remain.
  Receipt verification supports direct root messages only and explains that limit
  for wrapped/batched deliveries, including a warning against resending. History
  and verification need no credit-account query. An empty index remains available
  before the first funding; a missing account does not trip their circuit breaker.
- [Client](../scripts/pwr-station-client.ts): wallet authentication, catalog,
  quotes, idempotent order creation, payment challenge validation, exact signed
  payment submission, order polling and validation of station-reported receipts.
  Those receipts require independent on-chain verification by the host. The client
  defaults to the testnet profile; mainnet requires explicit selection. It requires
  a per-order spending ceiling, Manifest signer, and externally signed x402
  authorization. Aggregate spending limits remain the host's responsibility.
- [Probe](../scripts/pwr-station-probe.ts): an ephemeral zero-balance wallet signs
  an ADR-036 login, checks the catalog, and requests unpaid credit-address quotes
  plus an ordinary-wallet checkout control. It never creates orders or pays.

The client is agent-host tooling, excluded from the application image. It does not yet
provide a turnkey EVM wallet or durable agent purchase runner. The host must keep
its spending policy, keys, purchase journal and signing outside Merovingian.
There is no public buying/signing MCP tool or paid-gift endpoint in this change.

## Network configuration

[Public profiles](../scripts/pwr-station-config.ts) pin each network's station URL,
quote environment, Manifest chain, PWR denomination, payment network, USDC contract
and signing domain. The profiles are immutable. Testnet is the default, and the
existing unpaid probe remains testnet-only. Neither environment variables, target
addresses, quotes nor payment challenges select mainnet implicitly.

| Setting | Testnet (default) | Mainnet (explicit) |
| --- | --- | --- |
| Station URL | `https://testnet.pwr-station.com` | `https://pwr-station.com` |
| Quote environment | `sandbox` | `production` |
| Manifest chain | `manifest-ledger-testnet` | `manifest-ledger-mainnet` |
| Payment network | Base Sepolia, `eip155:84532` | Base, `eip155:8453` |
| USDC contract | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| EIP-712 name / version | `USDC` / `2` | `USD Coin` / `2` |

Sources: [PWR-Station environments](https://pwr-station.com/docs/overview),
[payment terms](https://pwr-station.com/docs/x402), and
[Circle USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses).
Both Manifest networks currently use the expected PWR denomination defined in
[shared network constants](../src/networks.ts) and the public runtime examples.
**PWR-Station's production denomination response is unverified.** Mainnet preflight
must confirm that its quotes and orders echo the full expected `factory/…/upwr`
denomination; subsequent authorized purchase acceptance must also check the receipt.
A different response, including bare `upwr`, remains a mismatch; do not relax the
asset check to make a purchase proceed.

The caller must supply independently verified recipient, chain and denomination
metadata. The constructor compares that information with the selected profile
before making any request. Keep these target fields: an address alone cannot
distinguish Manifest networks, which share a prefix and denomination. Copying the
chain and denomination from the purchase profile would discard that cross-check.

For an explicitly authorized mainnet hosting contribution, use previously checked
Merovingian support information with an available existing credit account:

```ts
import { PwrStationClient } from './pwr-station-client.js';

const client = new PwrStationClient({
  recipient: verifiedSupport.hostingCredit.creditAddress,
  chainId: verifiedSupport.chainId,
  denom: verifiedSupport.denom,
}, maxOrderCents, { network: 'mainnet' });
```

`verifiedSupport` and `maxOrderCents` are host inputs. Construction performs no
network requests or signing. Omitting `network` selects testnet, so passing only
a mainnet target fails. Unknown network values fail with `INVALID_NETWORK`;
target mismatches use `TARGET_MISMATCH`. Payment network/asset and signing-domain
mismatches use `USDC_REQUIRED` and `USDC_DOMAIN_REQUIRED`. The token comparison is
case-insensitive; signed payment terms are preserved exactly. Arbitrary URL or
token overrides are not supported.

Wallet secrets, wallet references, spending policy and recovery records belong to
the purchasing agent's private host configuration and storage, outside source and
images. This module supplies public protocol settings only; the reusable purchase
runner and durable journal are still follow-up work. Mainnet support here has only
synthetic fixture coverage, with no live mainnet purchase or payment preflight.

## Purchase and recovery contract

1. Select the network profile and fetch fresh Merovingian support information.
   Check chain, PWR denomination, purpose and recipient. Hosting support requires
   an existing credit account.
2. Authenticate to the selected station with an agent-controlled Manifest wallet
   using ADR-036.
   That wallet can have zero PWR; it identifies the purchaser independently of
   the delivery recipient. The x402 payer separately needs the selected profile's
   USDC: test USDC on Base Sepolia by default, or real USDC on Base for mainnet.
3. Select a package within the host's budget. Request a quote with the exact
   recipient and `payment_path: "x402"`. Validate the echoed immutable terms,
   environment, network, expiry and total before creating an order.
4. Persist the selected network (`testnet` or `mainnet`), independently verified
   target, quote and a fresh idempotency key **privately before** creating the
   order. Every failure after dispatch is `REQUEST_OUTCOME_UNKNOWN` with
   `sent: true`, including invalid responses. While the current spending ceiling
   covers the quote, retry the same quote/key to recover the same order. Never
   replace them just because a request timed out.
5. Request the order's payment challenge. Before any EVM signing, require x402 v2,
   `exact`, and the selected profile's payment network, USDC contract and signing
   domain. Require the quoted cents converted exactly to six-decimal USDC and a
   bounded authorization expiry. A testnet client rejects real Base (`eip155:8453`),
   even from the QA hostname or a sandbox quote. A mainnet client rejects test USDC.
6. Persist the network, order, requirements and **exact signed authorization**
   together in the private attempt record before the pay request. An uncertain
   payment means poll that order; an explicit retry must reuse the identical
   signature and nonce. Do not generate a second
   authorization, buy another package, or fall back to checkout automatically.
   After a process restart, verify the saved network and order identity using the
   host's integrity-checked journal. Construct the new client with the verified
   target and `{ network: savedAttempt.network }`; then call
   `restoreSubmittedPayment` with the saved order, requirements and exact signed
   authorization before any payment work. Require a trustworthy saved network;
   never silently fall back to the testnet default during recovery. A mainnet
   attempt passed to a default testnet client correctly fails with `TARGET_MISMATCH`:
   construct a new client with its verified saved network to recover it.
   If identity cannot be trusted or restore fails, stop payment work and reconcile
   the saved attempt; never treat that error as permission to sign another payment.
   Read-only polling remains available with a lower spending ceiling.
7. Require settled payment, confirmed PWR delivery, no refund, and a receipt with
   the expected Manifest chain, denomination, amount and transaction hash. The
   action `complete` alone is insufficient: a refunded order can also be complete.
8. Independently verify the returned transaction on the configured Manifest chain.
   For hosting contributions, submit its hash to Merovingian's verifier. Check the
   amount actually delivered to the credit address, not merely the order's claim.

PWR-Station controls the settlement and delivery legs; they are not an atomic
cross-chain transfer. Interrupted or refunded orders need explicit reconciliation.
The low-level client never automatically retries, signs, or increases its
per-order ceiling. All failures after dispatching a signed pay request, including
HTTP errors, malformed bodies and inconsistent receipts, produce
`REQUEST_OUTCOME_UNKNOWN` with `sent: true`, the observed HTTP `status` (zero when
unknown), and `authorizationValidBefore` as Unix seconds. A local validation
failure has `sent: false`, meaning that call did not submit a signed payment;
earlier journaled attempts may still be unresolved. Remote error text and signed
material are never included in these errors.

The client remembers the exact authorization before dispatch. It blocks fresh
challenges and replacement signatures for that order, even if polling says
`awaiting` or `failed`, and exposes the original expiry on those blocked calls.
Exact replay remains possible. The guard does not clear on expiry: the old
authorization could already have settled. After a restart, the host must restore
each journaled attempt as described above; the client does not provide durable
storage. After accepting a syntactically valid order ID, restore records a blocking
entry for that ID before validating the saved requirements and signed payment.
With a trustworthy order identity, a backward clock step, a lower spending ceiling
or damaged requirements/payment data leaves fresh challenges blocked and submissions
rejected with `PAYMENT_RESTORE_REQUIRED`. Correct the recovery problem and successfully
restore the original attempt before considering an exact replay. A failed restore
does not erase an earlier successfully restored authorization or its expiry.

`getOrder` validates the saved and returned order identity, target, amount
arithmetic, immutable terms and receipt, but does not enforce the current spending
ceiling. A host that lowers its ceiling can poll an uncertain payment and verify
its eventual delivery even when restoring the payment attempt is blocked by that
ceiling. Quote acceptance, order creation, new payment challenges, authorization
validation and payment submission still enforce the ceiling. Polling cannot clear
the submitted-payment guard or authorize another payment.

The order-creation ceiling also applies when replaying the same quote and
idempotency key. That POST may create an order if the earlier request never reached
the station, so it requires the current budget even though it does not submit a
payment. If a reduced ceiling blocks this replay, poll a previously saved order
with `getOrder`. Without a saved order, stop and reconcile with PWR-Station; do not
raise the ceiling or replace the quote/key automatically.

This guard does not authenticate the saved order identity. A missing or malformed
order ID cannot be recorded; a corrupted but well-formed ID guards the wrong order.
The signed USDC authorization does not bind PWR-Station's order ID, so a successful
restore cannot detect that substitution. The host must preserve and verify the
binding between the network, target, order, quote, idempotency key, requirements
and exact signed payment in its private recovery journal. Recovering the real order
with the same quote/key does not restore its guard automatically. Keep payment work stopped
until the original attempt is reliably identified and restored or reconciled.
The reusable host journal and its integrity checks remain follow-up work.

Starting a new order requires host reconciliation of the old payment,
including finalized authorization use/expiry and order/settlement state. Recovery
files must remain private and outside source, Git history, images, and public
reports.

## Testnet acceptance

The October 2 purchase completed after PWR-Station's QA update. The earlier
501, 32-byte recipient rejection and signed-payment 502 are resolved for this
tested flow. Their historical results remain in the
[initial evidence](evidence/pwr-station-2026-10-01.json) and
[October 1 retest](evidence/pwr-station-2026-10-01-retest.json).

| Request | Observed result |
| --- | --- |
| ADR-036 authentication and package catalog | Successful |
| x402 quote to existing 32-byte credit address | Valid sandbox quote on `manifest-ledger-testnet` |
| Checkout quotes to credit address and ordinary-wallet control | Passed in the October 1 quote probe; checkout payment was not exercised |
| Repeated order creation with the same idempotency key | Same order recovered |
| Order read authenticated as a different wallet | HTTP 404, `NOT_FOUND` |
| Unsigned payment request | HTTP 402; exact 1 test USDC on Base Sepolia |
| Signed payment request | Settled; PWR delivery queued |
| Order poll from a fresh process | Delivery confirmed; `next_action: complete`, `recording_state: n_a`, no refund |
| Identical signed request replay after settlement | Same delivery receipt, no additional charge or credit increase |
| Local HTTP and MCP contribution verification | Matching confirmed receipts for 1,000,000 PWR base units |
| Local contribution history | Deposit counted exactly once |

Before the new purchase, the October 1 order was polled and returned `requote`.
At **2026-10-02T15:57:49.886Z**, finalized Base Sepolia block **47593575**
(timestamp **15:37:18 UTC**) proved that its old authorization had expired
unused. The wallet still held all **20 faucet test USDC** and hosting credit
remained **4,343,500** base units. Only after that reconciliation was a fresh
quote, order and authorization created.

The new order used package `apk_pwrtest02`: 100 cents, zero listed fees,
1,000,000 test PWR base units. The challenge matched `eip155:84532`, Circle's
test USDC, and EIP-712 domain `USDC` / `2`. The confirmed
[Base Sepolia settlement](https://sepolia.basescan.org/tx/0x9ec7e2ae55d3e3bb225b46dc38e680d59104abeadb0fd63453f53f61a652d42e)
contained exactly one matching USDC transfer for **1,000,000 base units**.
The authorization was consumed and the wallet balance became **19 test USDC**.

PWR-Station delivered with one root `MsgSend`, without `MsgFundCredit`, in
[Manifest testnet transaction 5D166444…EF5B19FF](https://nodes.liftedinit.tech/manifest/testnet/api/cosmos/tx/v1beta1/txs/5D166444D8552011055CD05C9BFCBA6B3912C250611B7BABBA18CF63EF5B19FF),
height **11438930**. Available hosting credit increased from **4,343,500 to
5,343,500** base units. The receipt attributes the transfer to PWR-Station's
distributor, not the purchasing agent.

HTTP support, verification and history, plus MCP `hosting_support` and
`verify_contribution`, were exercised against a loopback-only application using
the real testnet transaction. All checks passed with **zero servings**. The
retired testnet lease was not reopened, and no public deployment was changed.

Authentication tokens, order identifiers, idempotency keys, payment signatures,
nonces and private wallet material are omitted from public evidence. Recovery
material stays with the agent host.

The previously failing quote is now a successful regression check:

```http
POST https://testnet.pwr-station.com/api/v1/agent/quotes
Content-Type: application/json
Authorization: Bearer <your QA session token>

{
  "package": "apk_pwrtest02",
  "payment_path": "x402",
  "recipient": "manifest1u38rpxv2ynqy5fe8xsqyzp6w37qkmdcya9jmuqwfxqxrldru0wrqqd8yzt"
}
```

Changing only `payment_path` to `checkout` also succeeds.
Tenant: `manifest1z5ep5m3ka5v2fn5wyv93elqh5nqlfqww2u82f4`.
Chain: `manifest-ledger-testnet`. PWR denomination:
`factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr`.
These are testnet reproduction targets, not mainnet payment instructions.

The repeatable probe uses fresh public configuration and no existing wallet:

```sh
npm run pwr-station:probe -- manifest1z5ep5m3ka5v2fn5wyv93elqh5nqlfqww2u82f4
```

It creates a temporary QA login and unpaid quotes. The retired testnet application
does not need to be restarted. This probe does not exercise signed payment or
prove the full purchase flow.

## Gifts and paid extras

The selected beneficiary is the **infrastructure hosting provider's payout wallet**.
Resolve and verify that payout destination for the selected provider and pin it in
each order. Do not infer it from the tenant address, credit address, provider UUID,
or provider operator/admin address. Use a separate test beneficiary initially.
The client accepts a distinct Manifest recipient for this purpose.

Before implementing paid gift issuance, define a product/price catalog and a
server-issued order bound to the beneficiary, chain, denomination, exact amount,
expiry and buyer or recipient claim. Fulfillment must be idempotent and a payment
must not be redeemed for multiple orders.

**Additional question for PWR-Station:** can delivery carry a merchant-supplied
order reference in the transaction memo, or can they issue a verifiable receipt
binding the merchant order and authenticated purchaser to the delivered transfer?
Their current purchaser-authenticated order API does not establish a public
merchant verification channel. A memo alone is not buyer authentication.

A public transaction hash is not a gift claim token. Many customers can share the
same PWR-Station distributor address, and anyone can copy a public hash. Merovingian's
current thank-you receipt intentionally proves no ownership and grants no paid
entitlement. Provider payouts must remain outside the hosting contribution ledger.

## Acceptance remaining

After the network-profile follow-up, `npm run check` passed the registry metadata
check, TypeScript check, all **453 local tests**, and production build. Tests used
isolated local fixtures and did not publish, deploy or perform live visits.

Local tests cover exact quote/order/payment terms, per-order limits, USDC domain
and authorization validation, header-only challenges, uncertain post-dispatch
errors, restored-attempt guards, exact replay, refund-state gates and receipt
field mismatches. Contribution fixtures check local address derivation, account
mismatches/absence, fee-only index errors, malformed matching events, unrelated
transfer events, mixed-message accounting, wrapped/batched verifier limits and
HTTP/MCP agreement. These are protocol fixtures; they do not exercise a live
refund or establish an aggregate spending cap.

Follow-up fixtures cover failed restores after clock drift, a reduced spending
ceiling or damaged requirements/payment data with a valid order ID, plus group
proposal/vote execution warnings. A separate fixture demonstrates that the host
must authenticate the saved order identity before using restore.
Additional fixtures cover canonical `validBefore` formatting, transport-error
sanitization, original expiry on replacement rejection, and the 16 KiB signed-payment
cap. Seven isolated mutations removing those four client guards and three history
guards each failed the corresponding regression test; their unchanged baselines
passed. The nested-history fixture uses a real `MsgSend`, and the body-cancellation
concurrency test uses a controlled clock so CI load cannot consume its cleanup grace.

Network-profile fixtures exercise the full client flow and restart recovery for
both environments with synthetic signatures and mocked transport. They reject
implicit or invalid mainnet selection, mixed networks/contracts/domains, target
and receipt mismatches, profile mutation, and spending above the per-order ceiling.
Eight isolated mutations removing the profile identity and payment-domain guards
each failed their regression test; unchanged baselines passed.

Review fixtures also cover reconciliation reads under a reduced spending ceiling,
continued payment blocking, restart from a saved network, exact payment error codes
and checksum-cased USDC contracts without rewriting the signed terms.
Nine targeted follow-up mutations of polling/spending gates, contract normalization
and error codes each failed their regression test; unchanged baselines passed.

The private acceptance harness completed the testnet purchase with a host-owned
EVM signer and durable recovery storage. Live checks covered expired-order
reconciliation, process restarts, idempotent order creation, exact paid-request
replay, wallet isolation, settlement and delivery. Failure and refund branches
remain covered by local fixtures; no live refund or deliberately interrupted
settlement was induced.

A reusable host-owned purchase runner, paid-gift order/claim binding, mainnet
preflight (including production's still-unverified PWR denomination response) and
acceptance, and a production release proposal remain follow-up work.
Production deployment or real-money operations require explicit authorization.
Nothing here reopens the retired lease or authorizes a mainnet payment.

Primary API references: [overview](https://pwr-station.com/docs/overview),
[purchase flow](https://pwr-station.com/docs/purchase-flow),
[x402 payments](https://pwr-station.com/docs/x402), and
[order states](https://pwr-station.com/docs/order-states).
