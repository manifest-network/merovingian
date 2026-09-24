# Release 0.4.6 — live

`0.4.6` packages the merged ENG-1031 response contracts and ENG-1032 read-only
smoke checks for an update to the existing mainnet lease. Package, lockfile and
generated registry metadata use the same version. Dependency versions, network
identity and the remote MCP endpoint are unchanged.

The user explicitly authorized image publication, the existing-lease update,
read-only acceptance and matching registry publication on 2026-09-22. The
verified image is published and deployed, and `0.4.6` is active and latest in the
official MCP Registry. The earlier [preparation evidence](evidence/release-0.4.6-preparation.json)
retains its observations from before authorization and publication.

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

## Publication and deployment

The [existing-lease update workflow](MAINNET.md#existing-lease-update-workflow)
updated lease `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd` at
`https://merovingian.manifest.network`. Only the image changed, preserving
`/data/visits.sqlite`, UID/GID `1000:1000`, public configuration and empty proxy
trust. The existing lease's hosting rate remains 2.592 PWR per 30 days within its
5 PWR monthly ceiling. No new lease, funding deposit, chain transaction or DNS
change was performed.

The exact tested image was published with tag `0.4.6`:

```text
ghcr.io/manifest-network/merovingian@sha256:5de7cb4be48c89b059e515d414d0a247721e5a72e017a0992b4138ac2c08edeb
```

Its configuration digest is
`sha256:5ce3aa1d565f6dfc5a2888af6580f829a1faa80d6a74919a8295de311ee0b9ed`.
Provider release **8** was observed ready with manifest hash
`65e5310485168fc90150a36a6ff6a6621c7a092db262261d1a24d7557c9756d2`
at **2026-09-22T14:04:55.056Z**. One journaled provider update POST applied the
reviewed manifest. Anonymous registry requests verified the exact tag and digest
manifest bytes, configuration digest, and access to all eleven layers. The tested
candidate was retained without rebuilding.

The prepared source and squash merge have identical Git trees. Release
[PR #10](https://github.com/manifest-network/merovingian/pull/10) merged as
`6cbce452e89fbff410c40d245c7da63d77c1e238`; its
[main CI](https://github.com/manifest-network/merovingian/actions/runs/35736937171)
passed Check and Final image. Rebuilding creates a different candidate and
requires fresh verification.

At release time the previous `0.4.5` digest was named the rollback candidate. The
update workflow cannot return to a digest it already applied, so recovery now
[rolls forward](MAINNET.md#updates-recovery-and-restore) to a new version.

## Live acceptance

The read-only smoke suite passed against `0.4.6`, with 20 requests, zero serving
requests and unchanged counters. Health, OpenAPI, both server cards and MCP
initialization report `0.4.6`. HTTP and MCP menus and visit guides agree.
Counts remained **8 cookies, 5 sauna sessions and 6 teas**, totaling 19, with the
original start date `2026-09-17T20:29:18.301Z`, matching the pre-update snapshot.

Additional read-only contract checks passed at **2026-09-22T14:09:27.112Z**:
all 24 published schemas and 79 response examples validate, five live GET
responses conform, and OpenAPI media type, CORS, cache headers, HEAD and
conditional 304 responses are correct. The acceptance evidence records all
33 application read requests, including an initial conditional-request probe
that was corrected to use the fixture's explicit fetch cache mode. There were
no live visits or payments.

See the [release evidence](evidence/release-0.4.6.json) for publication, deployment,
counter continuity and registry status.

## MCP Registry

Official `mcp-publisher` 1.8.1 published the reviewed metadata at
**2026-09-22T14:12:57.663135Z**, after live acceptance and a fresh local login.
Exact-version and latest records returned active `0.4.6` metadata matching
`server.json`, verified at **2026-09-22T14:15:35.158984Z**. A public lookup timeout
was reconciled with read-only requests; publication was not repeated. The
temporary registry login was removed after verification. The
[saved public response](evidence/mcp-registry-0.4.6.json) preserves that record.

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
