# Hosting-credit transport

[ENG-1040](https://linear.app/liftedinit/issue/ENG-1040) replaces the runtime
`getBalance()` call with one read of the configured REST endpoint's
`/liftedinit/billing/v1/credit/{tenant}` route. The route and snake-case response
fields follow the published `@manifest-network/manifestjs@3.0.0` billing LCD
client and generated `QueryCreditAccountResponseSDKType` / `CreditAccountSDKType`.
Bank balances and credit estimates are no longer requested separately.

The service checks RPC `/status` and REST
`/cosmos/base/tendermint/v1beta1/node_info` against the configured chain before
using credit data. Native `fetch` sends the same service deadline signal through
identity and credit requests and rejects redirects. The streaming reader cancels
the response body on abort, read failure, or a response above **65,536 bytes**,
before JSON parsing. It waits for cancellation to settle; the service's existing
four-operation concurrency accounting remains attached to that underlying work,
even if the caller already received an unavailable response at the deadline.

The credit account must identify the configured tenant and a valid credit
address. Available and reserved coins require unique valid denominations and
canonical nonnegative integer amount strings, preserving amounts above JavaScript's
safe-integer range. Active lease counts must be canonical unsigned 64-bit integer
strings. Only an HTTP 404 with a structured gRPC `code: 5` and message is treated
as an absent credit account. Partial, malformed, oversized, and other unsuccessful
responses report unavailable without contribution instructions or invented zeros.

The existing success cache, in-flight coalescing, independent returned snapshots,
and shared circuit breaker remain in place. Hosting-credit reads require a
configured REST URL, which both normal application network configurations supply;
RPC transaction verification still works without REST. The application still
uses the published SDK for address validation and generated transaction decoding,
but does not construct an SDK read client or its uncancellable query transport.

Run `node --import tsx --test tests/support.test.ts`. Regression tests cover the
single-query request contract, both identities, malformed and absent-account
responses, arbitrary-size integers, body failures, the streaming limit with a
false content length, and concurrency retention while cancellation is pending.
An isolated HTTP server also verifies real upstream socket closure for stalled
headers, stalled bodies, and oversized bodies. These tests need loopback access
and contact no live service or wallet.

The September 18 audit remains historical evidence; these changes are local
remediation and do not attest to a deployed runtime.
