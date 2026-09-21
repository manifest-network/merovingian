# HTTP response contracts (ENG-1031)

`GET /openapi.json` describes the existing JSON handlers, their nested fields,
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

## Status and field semantics

| Operation | Normal HTTP status and body | Fields to interpret |
| --- | --- | --- |
| `GET /api/v1/amenities` | 200, `AmenityMenu` | Full amenity records, accepted preferences, each amenity's request schema, byte limits and `walletRequired: false`. |
| `POST /api/v1/visits` | 200, `VisitResult` | Amenity, selected preference, experience and self-contained souvenir. `experience.fortune` is required for cookies and absent for sauna/tea; it is never null. Each success increments a serving count. |
| `GET /api/v1/stats` | 200 available; 503 unavailable, both `VisitStats` | The existing schema is preserved. Counts and total are decimal strings. Unavailable readings have null `since`, `counts` and `total`. |
| `GET /api/v1/support` | 200, `SupportInfo` | `available` includes instructions and `checkedAt`; `hostingCredit` may still be null when credit readings are not configured. `unavailable` and `unconfigured` require all three readings to be null. |
| `GET /api/v1/contributions` | 200, `ContributionHistory` | `available` includes entries, totals, a check time and scan counts. `complete: false` means totals cover only returned entries. `unavailable`/`unconfigured` have empty entries, null totals/time/indexed count, zero scanned count and `complete: false`. |
| `POST /api/v1/support/verify` | 200, `VerificationResult` | `confirmed` includes a receipt. `pending`, `failed`, `not_a_contribution`, `unavailable` and `unconfigured` include a message and omit the receipt. |
| `GET /healthz` | 200, `Health` | `status: ok`, network, chain, version and retirement flag. This route remains healthy during chain/storage outages and retirement. |

All listed fields are required within their variant. Omission and null are
distinct: null readings mean unknown data, not zero. Monetary amounts and chain
heights use decimal strings to preserve precision. Funding instructions are an
unsigned template whose sender and amount fields contain literal placeholders.
They are not ready to broadcast.

History can contain several entries for a transaction, grouped by sender.
`scannedTransactions` counts distinct transactions inspected, including those
excluded from deposit totals. The service inspects at most 100 indexed
transactions per page. Deposit totals are neither remaining credit nor revenue.
Receipt verification acknowledges a public transaction, proves no ownership and
grants no entitlement. A pending or unavailable result is a reason to check the
original transaction, never to blindly pay again.

## HTTP errors

The six `/api/v1` operations publish shared responses for 400 (body parsing or
input validation), 403 (rejected browser origin), 410 (retired testnet), 413 (body
or form-parameter limit), 429 (request/concurrency limits), and 500 (unexpected
handler failure). The parsers also apply to API GET requests with bodies.

Both POST operations additionally document 415 for a non-JSON content type.
Visits document a 503 error when serving storage fails. The 429 and visit 503
responses include a required `Retry-After` header in seconds. Stats 503 returns
the stats body without that header. Health GET runs before these middleware
checks and only advertises its 200 response.

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
fixtures, and SQLite memory counters. They cover both network identities, every
amenity preference, all verification statuses, available/null credit, complete,
partial and empty history, unavailable/unconfigured readings, malformed chain
data, input errors, middleware errors, retired service, closed storage and
unexpected handler failures. Negative cases reject missing fields, contradictory
variants, extra properties, numeric amounts and invalid dates/hashes.

For the four corresponding MCP tools, both structured and JSON text content are
compared with HTTP bodies. Invalid visits and failed storage use MCP `isError`
and text matching the HTTP error message; transport envelopes differ. History,
stats and health have no corresponding MCP tool.

All fixture servers use loopback ports. Documentation examples use synthetic
addresses/transactions; generating example souvenirs calls the pure fiction
function and records no servings. These checks perform no live visits, chain
queries, payments or production changes. Production publication remains a
separately authorized action.
