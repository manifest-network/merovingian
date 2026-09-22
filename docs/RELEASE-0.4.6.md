# Release 0.4.6 — prepared

`0.4.6` packages the merged ENG-1031 response contracts and ENG-1032 read-only
smoke checks for an update to the existing mainnet lease. Package, lockfile and
generated registry metadata use the same version. Dependency versions, network
identity and the remote MCP endpoint are unchanged.

The live deployment and official MCP Registry currently remain at `0.4.5`.
Publication, the provider update and registry publication require authorization
for the reviewed candidate under [AGENTS.md](../AGENTS.md).

## Changes

- Complete OpenAPI 3.1 response schemas cover the menu, visits, serving totals,
  hosting support, contribution history, verification and health. Examples use
  the configured denomination and clearly invalid address placeholders.
- OpenAPI is cached with an ETag, public CORS and a consistent media type, and
  remains available during testnet retirement.
- Malformed compressed request bodies return 400, unsupported encodings or
  charsets return 415, and oversized generated visit results fail before counting
  a serving. Stats distinguish available 200 responses from unavailable 503
  responses while preserving the shared stats schema.
- Smoke checks default to read-only HTTP/MCP discovery and report request and
  serving budgets. Serving checks require explicit opt-in and a live-target
  authorization reference.

See [API contracts](API-CONTRACTS.md), [request limits](REQUEST-LIMITS.md), and
[smoke acceptance](ACCEPTANCE.md#repeatable-smoke-checks-eng-1032) for details.

## Intended update

Use the [existing-lease update workflow](MAINNET.md#existing-lease-update-workflow)
for lease `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd` at
`https://merovingian.manifest.network`. Replace only the image, preserving
`/data/visits.sqlite`, UID/GID `1000:1000`, public configuration and empty proxy
trust. The existing lease's hosting rate remains 2.592 PWR per 30 days within its
5 PWR monthly ceiling. No new lease, funding deposit, chain transaction or DNS
change is needed.

The verified, unpublished candidate is:

```text
ghcr.io/manifest-network/merovingian@sha256:5de7cb4be48c89b059e515d414d0a247721e5a72e017a0992b4138ac2c08edeb
```

Its configuration digest is
`sha256:5ce3aa1d565f6dfc5a2888af6580f829a1faa80d6a74919a8295de311ee0b9ed`.
Authenticated provider reads prepared an image-only manifest with hash
`65e5310485168fc90150a36a6ff6a6621c7a092db262261d1a24d7557c9756d2`.
The current `0.4.5` image and provider manifest were checked before preparing it;
the update has not been submitted. Rebuilding creates a different candidate and
requires fresh verification.

After approval, publish the exact tested image, reconcile its anonymous registry
digest, and submit one provider update through the journaled workflow. Validate
the live version, HTTP/MCP discovery, API contracts and persistent counters with
read-only checks. Publish the matching `server.json` after successful acceptance.
The previous `0.4.5` digest remains the rollback candidate; rollback requires its
own authorization.

## Validation

The [sanitized preparation evidence](evidence/release-0.4.6-preparation.json)
records the candidate digests and checks:

- `npm run check`: all 300 tests, registry consistency, typechecking and build
  passed. Dependency versions and historical registry snapshots are unchanged.
- Official MCP Registry validation accepted the prepared `server.json`.
- The image's 30 application, package and healthcheck files match the checked
  workspace build byte for byte.
- Isolated image checks passed ownership and permissions, packaged curl
  healthchecks, HTTP/MCP behavior, SQLite persistence across replacement,
  temporary files, custom-port health and graceful shutdown.
- The pinned scanner and current database passed the image advisory policy with
  zero blockers and zero exceptions. The existing low, unfixed
  `elliptic@6.6.1` advisory remains reported.
- The live `0.4.5` baseline passed 20 read-only requests with zero serving
  requests and unchanged counters. These are baseline observations, not live
  acceptance of `0.4.6`.

Provider ingress/confinement evidence and named AppArmor verification remain
separate work in ENG-1038 and ENG-1041. This patch does not alter provider policy.
