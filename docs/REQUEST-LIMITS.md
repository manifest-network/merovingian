# Request limits and trusted ingress

The application accepts one JSON-RPC message per `POST /mcp`. Every array is
rejected with HTTP 400 and JSON-RPC `-32600` before constructing the MCP server,
including empty, single-element, mixed read/write, and malformed batches. A
rejected batch executes no tools and records no servings. This restriction also
applies to the older `2025-03-26` protocol, which otherwise permits batching.

Streamable HTTP single-message calls remain supported for `2025-03-26`,
`2025-06-18`, and `2025-11-25`; `/mcp/server-card` advertises the versions supported
by the installed SDK. The SDK handles initialization and protocol negotiation.
The service has no persistent sessions or GET stream. Clients must send
`Content-Type: application/json`, accept both `application/json` and
`text/event-stream`, and send the negotiated `MCP-Protocol-Version` after
initialization. Notifications still follow SDK behavior. HTTP and form visits
continue to accept one visit per request.

JSON and URL-encoded input is capped at 8,192 bytes after decompression. MCP also
requires the JSON parser's media type; a malformed MIME list cannot select the
transport's fallback body parser. Form input permits at most five parameters.
Malformed JSON or compressed bodies return 400, oversized parsed bodies return
413, and unsupported content encodings or charsets return 415. Parser errors use
fixed public messages without exposing the submitted body or parser diagnostics.

Successful visit JSON results are also capped at 8,192 UTF-8 bytes before a
serving is counted. An oversized result fails for HTTP, form, and MCP visits;
HTML pages and MCP transport envelopes are outside this result-size limit. See
[API response contracts](API-CONTRACTS.md) for response shapes and status codes.

## Request and concurrency budgets

All requests that reach body parsing share these process-local limits, including
unknown paths and unsupported methods on health and discovery paths. Public
GET/HEAD pages, health, discovery and discovery preflights terminate before body
parsing and remain available when a budget is exhausted.

| Budget | Limit |
| --- | ---: |
| Admitted requests per client address per fixed 60-second window | 120 |
| Admitted requests across the process per fixed 60-second window | 1,200 |
| Active requests per client address | 4 |
| Active requests across the process | 32 |
| Retained client buckets | 10,000 |

An admitted request consumes a request allowance even if parsing, schema checks,
or tool execution subsequently fail. A limiter rejection does not consume an
aggregate allowance. Thus an exhausted client cannot drain other clients' request
budgets just by repeating rejected calls. The aggregate limit deliberately
protects the shared process and can reject every client when enough independent
addresses exhaust it; these are abuse controls, not identity or fairness
guarantees against distributed clients. HTTP 429 includes `Retry-After`.

Concurrency covers body parsing, handling and the response lifetime. Async HTTP
handlers and MCP chain tools retain their slot after the requester disconnects
until the work settles. MCP's HTTP response wait ends on disconnect even when
the SDK leaves its JSON response promise unresolved; independent tool accounting
then releases the slot when the actual work finishes. Deferred tool dispatch
cannot start a chain read or record a serving after the response closes.
Finished or abandoned uploads release their slots. A
request-window reset does not reset outstanding work. The chain service also has
its own transport bounds and concurrency budget. These limits do not replace
provider connection, resource, and ingress controls. Process restarts reset the
in-memory budgets; multiple replicas do not coordinate them.

## Trusting forwarded client addresses

`TRUSTED_PROXY_CIDRS` is a comma-separated list of explicit IPv4/IPv6 addresses or
CIDR ranges, limited to 32 entries. Empty or absent means no forwarded address is
trusted: the socket peer identifies the client. Hostnames, Express range aliases
such as `loopback` or `uniquelocal`, hop counts, and ranges wider than IPv4 `/24`
or IPv6 `/64` are rejected. IPv4-mapped CIDRs must use IPv4 notation; bare mapped
IP addresses are accepted. These prefix limits are configuration guardrails,
not proof that every address in an accepted range belongs to trusted ingress.
The legacy `TRUST_PROXY_HOPS=0` setting remains a safe compatibility
value for accepted deployment manifests; every nonzero legacy value fails startup.

For example, an isolated local fixture can trust `127.0.0.2/32` as its sole proxy
source. This is a test example, not a production configuration recommendation.
Express examines the socket peer and forwarded chain from right to left and
stops at the first untrusted address. Client bucket keys normalize IPv6 spelling
and IPv4-mapped addresses. Invalid forwarded client values fall back to the
socket's bucket rather than creating arbitrary buckets.

Before enabling the production allowlist, obtain provider evidence for the
actual ingress source addresses/CIDRs, all possible paths to the application,
and forwarded-header behavior. Each trusted proxy must overwrite the client-sent
`X-Forwarded-For` header or append its actual connecting peer. An arbitrary
header passed unchanged by a trusted proxy remains spoofable. Restrict the list
to the necessary ingress sources; never trust visitor or unrelated workload
address ranges. Direct connections from untrusted sources ignore forwarded
identity. The application does not infer trust from `Host`, `Forwarded`, or
`X-Real-IP`.

Until that topology and header handling are verified, the empty allowlist is
intentional. Clients behind the same ingress socket then share its allowance.
Local tests establish the behavior of a specifically configured proxy, not the
provider's topology. Changing production configuration still requires explicit
authorization under [AGENTS.md](../AGENTS.md).

Hosted MCP clients connect from their operators' egress addresses, not from each
user's address. For example, Anthropic documents a shared egress range for Claude
custom connectors. Once trusted ingress is configured, all users of one hosted
client share the per-address allowances of those egress addresses: 120 requests
per minute and 4 active requests each. Reassess these limits in the release that
configures trusted ingress, for example with a higher limit or a separate budget
for documented connector ranges. See
[connecting agents](CONNECT.md#claude-web-and-desktop-apps) and ENG-1038.

## Local verification

Run `node --import tsx --test tests/app.test.ts tests/config.test.ts` with loopback
networking allowed. Fixtures use in-memory counters and mocked chain support.
They cover batch rejection with zero side effects, normal single calls, malformed
MIME types, a real loopback proxy that appends the peer address, forged forwarded
headers through and around that proxy, equivalent IPv6 spellings, request budget
fairness, body parsing on unknown routes, and concurrency behavior on completion
and disconnect. They make no
production requests or payments.
