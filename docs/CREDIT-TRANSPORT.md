# Hosting-credit transport

[ENG-1040](https://linear.app/liftedinit/issue/ENG-1040) replaces the runtime
`getBalance()` call with one read of the configured REST endpoint's
`/liftedinit/billing/v1/credit/{tenant}` route. The route and snake-case response
fields follow the published `@manifest-network/manifestjs@4.0.0` billing LCD
client and generated `QueryCreditAccountResponseSDKType` / `CreditAccountSDKType`.
Bank balances and credit estimates are no longer requested separately.

The service checks RPC `/status` and REST
`/cosmos/base/tendermint/v1beta1/node_info` against the configured chain before
using credit data. Each native `fetch` has an owned transport controller linked to
the service deadline and rejects redirects. On deadline, read failure, or a
response above **65,536 bytes**, the socket transport is aborted before response
body cleanup. The reader waits at most **100 ms** for cancellation to settle,
then releases its lock and abort listener. This prevents a stuck cancellation
hook from permanently consuming one of the four concurrency slots after the
native network operation has been aborted. A custom `ChainGateway` that ignores
cancellation remains counted until its operation actually settles; arbitrary
continuing gateway work is never detached just to free capacity.

Unsuccessful REST identity and history responses are aborted and canceled
without reading their error bodies. RPC HTTP 400/500 error JSON and credit HTTP
404 responses still pass through the bounded reader because those bodies carry
the structured transaction/account absence information.

The credit account must identify the configured tenant and a valid credit
address. Available and reserved coins require unique valid denominations and
canonical nonnegative integer amount strings, preserving amounts above JavaScript's
safe-integer range. Active lease counts must be canonical unsigned 64-bit integer
strings. Protobuf JSON may omit empty available/reserved arrays and a zero active
lease count; only omitted fields receive the defaults `[]` and `'0'`, matching the
generated message defaults. Explicit `null`, malformed values, and missing
account identity remain invalid. Only an HTTP 404 with a structured gRPC `code: 5`
and message is treated as an absent credit account. Malformed, oversized, and
other unsuccessful responses report unavailable without contribution instructions.

The existing success cache, in-flight coalescing, independent returned snapshots,
and shared circuit breaker remain in place. Hosting-credit reads require a
configured REST URL, which both normal application network configurations supply;
RPC transaction verification still works without REST. The application still
uses the published SDK for address validation and generated transaction decoding,
but does not construct an SDK read client or its uncancellable query transport.

Run `node --import tsx --test tests/support.test.ts`. Regression tests cover the
single-query request contract, both identities, malformed and absent-account
responses, arbitrary-size integers, body failures, the streaming limit with a
false content length, bounded cleanup/recovery with cancellation hooks that never
settle, and concurrency retention for uncooperative custom gateways. An isolated
HTTP server also verifies real upstream socket closure and successful subsequent
requests after stalled headers, stalled bodies, and oversized bodies. These tests
need loopback access and contact no live service or wallet.

The September 18 audit remains historical evidence; these changes are local
remediation and do not attest to a deployed runtime.
