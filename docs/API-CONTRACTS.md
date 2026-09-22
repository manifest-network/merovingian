# HTTP response contracts (ENG-1031)

`GET /openapi.json` describes the JSON handlers, their nested fields,
status variants, errors and examples. The document is assembled in
[`src/openapi.ts`](../src/openapi.ts), through the existing `openapi` export in
[`src/documents.ts`](../src/documents.ts). Examples live in
[`src/openapi-examples.ts`](../src/openapi-examples.ts).

The implementation follows this plan:

1. Describe the actual handler outputs, retaining the existing stats schema.
2. Publish complete success and error schemas with representative examples.
3. Validate responses from isolated handlers and check HTTP/MCP agreement.

The document uses OpenAPI 3.1 with an explicit JSON Schema 2020-12 dialect, as
supported by the [OpenAPI schema dialect rules](https://spec.openapis.org/oas/v3.1.0.html#specifying-schema-dialects).
Object schemas enumerate required fields and reject extra properties. `oneOf`
selects the response variant; nullable readings explicitly allow `null`.

The application builds and serializes this document once at startup. GET/HEAD
serve those bytes as `application/vnd.oai.openapi+json` with public CORS,
`Cache-Control: public, max-age=300` and a precomputed ETag for conditional
requests. Catalogs and the discovery Link header advertise the same media type.
Discovery reads remain outside the API limiter and do not record servings.

The contract also remains readable during testnet retirement. That deployment's
document advertises only 410 responses for its API operations and a healthy,
retired `/healthz`. Retirement responses link to the contract; other machine
routes still return 410. Mainnet documents omit the testnet-only retirement
response and examples.

## Status and field semantics

| Operation | Normal HTTP status and body | Fields to interpret |
| --- | --- | --- |
| `GET /api/v1/amenities` | 200, `AmenityMenu` | Full amenity records, accepted preferences, each amenity's request schema, byte limits and `walletRequired: false`. |
| `POST /api/v1/visits` | 200, `VisitResult` | Amenity, selected preference, experience and self-contained souvenir. `experience.fortune` is required for cookies and absent for sauna/tea; it is never null. Each success increments a serving count. |
| `GET /api/v1/stats` | 200 `AvailableVisitStats`; 503 `UnavailableVisitStats` | Both constrain the unchanged shared `VisitStats` schema. Available readings are non-null; unavailable readings have null `since`, `counts` and `total`. Counts and total are decimal strings. |
| `GET /api/v1/support` | 200, `SupportInfo` | `available` includes instructions and `checkedAt`; `hostingCredit` is null when the verified chain reports no credit account. Missing REST configuration or failed queries yield `unavailable`. `unavailable` and `unconfigured` require all three readings to be null. |
| `GET /api/v1/contributions` | 200, `ContributionHistory` | `available` includes entries, totals, a check time and scan counts. `complete: false` means totals cover only returned entries. `unavailable`/`unconfigured` have empty entries, null totals/time/indexed count, zero scanned count and `complete: false`. |
| `POST /api/v1/support/verify` | 200, `VerificationResult` | `confirmed` includes a receipt. `pending`, `failed`, `not_a_contribution`, `unavailable` and `unconfigured` include a message and omit the receipt. |
| `GET /healthz` | 200, `Health` | `status: ok`, network, chain, version and retirement flag. This route remains healthy during chain/storage outages and retirement. |

All listed fields are required within their variant. Omission and null are
distinct: null readings mean unknown data, not zero. Monetary amounts and chain
heights use decimal strings to preserve precision. Funding instructions are an
unsigned template whose sender and amount fields contain literal placeholders.
They are not ready to broadcast.

Examples use the configured network, chain, denomination and storage mode. Their
addresses are explicitly labelled, syntactically invalid placeholders. Always
read `/api/v1/support` for the current tenant and denomination before preparing
an authorized contribution; never fund a documentation example. Public messages,
funding notices and protocol limits are shared with the handlers through
[`src/protocol.ts`](../src/protocol.ts), and invalid visit examples use the actual
input validator's messages.

The advertised visit-output limit is enforced on the UTF-8 JSON result before a
serving is counted, across HTTP, HTML and MCP visits. Oversized results fail with
HTTP 500 or an MCP tool error. MCP transport envelopes are outside that byte
limit.

History can contain several entries for a transaction, grouped by sender.
`scannedTransactions` counts distinct transactions inspected, including those
excluded from deposit totals. The service inspects at most 100 indexed
transactions per page. Deposit totals are neither remaining credit nor revenue.
Receipt verification acknowledges a public transaction, proves no ownership and
grants no entitlement. A pending or unavailable result is a reason to check the
original transaction, never to blindly pay again.

## HTTP errors

The six `/api/v1` operations publish shared responses for 400 (body parsing or
input validation), 403 (rejected browser origin), 413 (body or form-parameter
limit), 415 (unsupported body encoding or charset), 429 (request/concurrency
limits), and 500 (unexpected handler failure or oversized generated visit).
Testnet also documents 410 for retirement. The parsers apply to API GET requests
with bodies; corrupt gzip, deflate and Brotli bodies return 400. Parser errors
are normalized at the parser boundary without exposing their messages or bodies.

Both POST operations also use 415 for a non-JSON content type.
Visits document a 503 error when serving storage fails. The 429 and visit 503
responses include a required `Retry-After` header in seconds. Stats 503 returns
the stats body without that header. Health GET runs before these middleware
checks and only advertises its 200 response. The API's default error schema
includes the 404 `NotFound` shape, with `error: not_found` and `visitGuide`, for
unknown paths or unsupported methods. This does not add unsupported methods to
the operations. MCP's 405 is a JSON-RPC transport error, not this HTTP error shape.

Most errors contain only `error`. Verification's 400 response has three variants:

- A malformed body produces `{ "error": "Malformed request body." }`.
- An unexpected body shape or field produces `status: invalid_request` and `error`.
- A missing or invalid hash produces `status: invalid_request` and `message`.

The public HTTP request accepts only `transactionHash`, even though the existing
hash-validation message mentions an optional sender used by an internal service
method. Retirement has its own schema with the testnet identity, destination
origin and migration message. Clients must explicitly reconfigure for mainnet.

## Validation

Run the contract suite with:

```sh
node --import tsx --test tests/openapi.test.ts
npm run check
```

The suite fetches `/openapi.json` from a loopback application and compiles its
published component references using Ajv's 2020-12 validator. Strict compilation
and [format validation](https://ajv.js.org/guide/formats.html) cover every schema
and request/response example. Ajv and ajv-formats are explicit development
dependencies at the versions already locked through the MCP SDK.

HTTP tests exercise real Express handlers, `SupportService` with synthetic chain
fixtures, and memory and temporary persistent SQLite counters. A real gateway
with intercepted transport verifies structured gRPC NotFound versus missing
REST configuration. Tests cover both network identities, every amenity preference,
all verification statuses, available/null credit, complete,
partial and empty history, unavailable/unconfigured readings, malformed chain
data (including inconsistent totals and missing attributes), input and encoding
errors, middleware errors, retired service, closed storage, oversized results and
unexpected handler failures. Negative cases reject missing fields, contradictory
variants, extra properties, numeric amounts and invalid dates/hashes.

For the four corresponding MCP tools, both structured and JSON text content are
compared with HTTP bodies. Invalid visits and failed storage use MCP `isError`
and text matching the HTTP error message; transport envelopes differ. History,
stats and health have no corresponding MCP tool.

All fixture servers use loopback ports. Documentation examples use address
placeholders and synthetic transactions; generating example souvenirs calls the
pure fiction function and records no servings. These checks perform no live visits, chain
queries, payments or production changes. Production publication remains a
separately authorized action.
