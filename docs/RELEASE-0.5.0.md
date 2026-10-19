# Release 0.5.0 — prepared, unreleased

This version prepares direct PWR deposits into Merovingian's hosting credit and
testnet PWR-Station purchase tooling. Visits remain free. No image, registry
publication or production deployment is included in this preparation.

## Contract migration

`hostingCredit.creditAddress` is required whenever `hostingCredit` is non-null.
Because response schemas reject extra properties, strict 0.4.7 validators reject
the new response, and 0.5.0 validators reject the old credit-object shape. The
application, OpenAPI and prepared registry metadata advance to 0.5.0. HTTP routes
remain under `/api/v1`.

Regenerate clients and validators before upgrading. Clients that support both
versions must select the matching schema or explicitly handle both shapes. See
the [API contracts](API-CONTRACTS.md#compatibility-for-the-prepared-050-release).

## Changes and verification

The hosting-credit destination is derived locally from the configured tenant and
checked against the REST billing account. Direct `MsgSend` deposits are included
in receipt verification and contribution history. History counts executed wrapped
and batched transfers; receipt verification explains its direct-message limit.
History and verification no longer depend on a credit-account lookup.

The testnet purchase client validates per-order spending, payment terms and
station-reported receipts. It marks every failed signed submission as uncertain
and permits only the same authorization for that order. Hosts must restore
journaled attempts after restart, enforce aggregate spending and independently
verify delivery on chain. See the [purchase and recovery contract](PWR-STATION.md#purchase-and-recovery-contract)
and its local and historical testnet validation.

The MCP SDK advances to 1.31.0, including Manifest's transitive copies, to clear
the advisory found by the October 16 image scan. The scoped `undici` security
override remains. See [dependency details](DEPENDENCIES.md#dependency-overrides).

Run `npm run check` for registry metadata, TypeScript, local fixture tests and the
build. Image publication, deployment and any real-money validation require a
separate reviewed release procedure and explicit authorization.
