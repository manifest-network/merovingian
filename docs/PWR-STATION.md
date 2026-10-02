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
| Optional hosting contribution | Existing tenant credit address returned by the verified chain | Adds nonwithdrawable hosting credit |
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
  `hostingCredit.creditAddress` only after RPC/REST chain and credit-account checks.
  The original `MsgFundCredit` instruction template remains available. A missing
  account must be created before attempting distributor delivery.
- HTTP/MCP receipt verification accepts a successful, signed, indexed root
  `MsgSend` with the configured PWR denomination and the existing credit address.
  It also accepts `MsgFundCredit`, combines matching messages with integer
  arithmetic, and rejects provider payouts, tenant-wallet sends and self-transfers.
- History uses the single `transfer.recipient` index and counts bank movements
  once. `MsgFundCredit` emits both bank and billing events; billing events check
  consistency instead of adding the same amount again. Executed wrapped transfers
  are supported in history. The latest-100 limit and partial-history notices remain.
  Receipt verification still supports direct root messages only.
- [Client](../scripts/pwr-station-client.ts): QA wallet authentication, catalog,
  quotes, idempotent order creation, payment challenge validation, exact signed
  payment submission, order polling and delivery receipt validation. It requires a
  caller-supplied budget, Manifest signer, and externally signed x402 authorization.
- [Probe](../scripts/pwr-station-probe.ts): an ephemeral zero-balance wallet signs
  an ADR-036 login, checks the catalog, and requests unpaid credit-address quotes
  plus an ordinary-wallet checkout control. It never creates orders or pays.

The client is test tooling, excluded from the application image. It does not yet
provide a turnkey EVM wallet or durable agent purchase runner. The host must keep
its spending policy, keys, purchase journal and signing outside Merovingian.
There is no public buying/signing MCP tool or paid-gift endpoint in this change.

## Purchase and recovery contract

1. Fetch fresh Merovingian support information. Check chain, PWR denomination,
   purpose and recipient. Hosting support requires an existing credit account.
2. Authenticate to QA with an agent-controlled Manifest wallet using ADR-036.
   That wallet can have zero PWR; it identifies the purchaser independently of
   the delivery recipient. The x402 payer separately needs test USDC on Base Sepolia.
3. Select a package within the host's budget. Request a quote with the exact
   recipient and `payment_path: "x402"`. Validate the echoed immutable terms,
   environment, network, expiry and total before creating an order.
4. Persist the quote and a fresh idempotency key **privately before** creating the
   order. On an uncertain response, retry the same quote/key to recover the same
   order. Never replace them just because a request timed out.
5. Request the order's payment challenge. Before any EVM signing, require x402 v2,
   `exact`, `eip155:84532`, and Circle's Base Sepolia test USDC contract
   `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Require the quoted cents converted
   exactly to six-decimal USDC and a bounded authorization expiry. The client
   rejects real Base (`eip155:8453`), even from the QA hostname or a sandbox quote.
   [Circle's official test-token addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
6. Persist the order, requirements and **exact signed authorization** privately
   before the pay request. An uncertain payment means poll that order; an explicit
   retry must reuse the identical signature and nonce. Do not generate a second
   authorization, buy another package, or fall back to checkout automatically.
7. Require settled payment, confirmed PWR delivery, no refund, and a receipt with
   the expected Manifest chain, denomination, amount and transaction hash. The
   action `complete` alone is insufficient: a refunded order can also be complete.
8. Independently verify the returned transaction on the configured Manifest chain.
   For hosting contributions, submit its hash to Merovingian's verifier. Check the
   amount actually delivered to the credit address, not merely the order's claim.

PWR-Station controls the settlement and delivery legs; they are not an atomic
cross-chain transfer. Interrupted or refunded orders need explicit reconciliation.
The low-level client never automatically retries, signs, or increases the budget.
The host must persist recovery state across process restarts. Those files must
remain private and outside source, Git history, images, and public reports.

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

`npm run check` passed the registry metadata check, TypeScript check, all **405
local tests**, and production build. Tests used isolated local fixtures and did
not publish, deploy or perform live visits.

Local tests cover success, wrong chain/recipient/token, budgets, idempotent order
recovery, exact payment replay after unknown outcomes and gateway 502s, refunds,
receipt mismatches, direct credit verification, mixed-message accounting and
HTTP/MCP agreement.

The private acceptance harness completed the testnet purchase with a host-owned
EVM signer and durable recovery storage. Live checks covered expired-order
reconciliation, process restarts, idempotent order creation, exact paid-request
replay, wallet isolation, settlement and delivery. Failure and refund branches
remain covered by local fixtures; no live refund or deliberately interrupted
settlement was induced.

A reusable host-owned purchase runner, paid-gift order/claim binding, and a
separate mainnet configuration and release proposal remain follow-up work.
Production deployment or real-money operations require explicit authorization.
Nothing here reopens the retired lease or authorizes a mainnet payment.

Primary API references: [overview](https://pwr-station.com/docs/overview),
[purchase flow](https://pwr-station.com/docs/purchase-flow),
[x402 payments](https://pwr-station.com/docs/x402), and
[order states](https://pwr-station.com/docs/order-states).
