# Release 0.4.4 — historical preparation

This document records the original `0.4.4` preparation, before the publication
and acceptance documented in [PR #5](https://github.com/manifest-network/merovingian/pull/5).
Its immutable image has the original Node healthcheck and does **not** contain
ENG-1044. The healthcheck fix is a separate [0.4.5 candidate](RELEASE-0.4.5.md);
use that record and its exact evidence for any proposed healthcheck update.
Preparation does not authorize publication or deployment.

This release packages the security remediation merged in
[PR #3](https://github.com/manifest-network/merovingian/pull/3), merge commit
`b77ca46d82006c3d577961874cd11aa1a805cdf9`. Release preparation changes the
application version and generated registry metadata to `0.4.4`, with no further
dependency upgrades. The registry identity
`io.github.manifest-network/merovingian` and `/mcp` endpoint are unchanged.

## Changes and compatibility

- **MCP batches are rejected before execution.** Clients must send one JSON-RPC
  message per request, including clients using protocol `2025-03-26`. Rejected
  batches execute no tools and record no servings. Normal single-message calls
  remain supported.
- **Request work is bounded.** Per-client and aggregate request budgets,
  concurrency ceilings, and body limits cover parsing, handling, and response
  lifetime. Independent chain-tool accounting retains capacity until actual
  work settles after a disconnect. See [request limits](REQUEST-LIMITS.md).
- **Forwarded client identity is untrusted by default.** An empty
  `TRUSTED_PROXY_CIDRS` uses the socket peer. Explicit addresses or narrow CIDRs
  can be configured only after the ingress sources and forwarded-header handling
  are verified. Clients behind a shared untrusted ingress share its allowance.
  Legacy `TRUST_PROXY_HOPS=0` remains accepted; nonzero hop counts fail startup.
  Testnet/mainnet manifest generation and the existing-lease update workflow
  support the validated setting. An omitted update flag preserves current
  trust; an explicitly empty flag clears it. See
  [existing-lease updates](MAINNET.md#existing-lease-update-workflow).
- **Hosting-credit reads have bounded transport.** Required credit data uses a
  direct REST query with identity checks, response-size limits, deadlines, and
  cancellation. Failed or malformed responses do not produce contribution
  instructions. The application exposes no signing interface. See
  [credit transport](CREDIT-TRANSPORT.md).
- **The runtime image is hardened.** The pinned Node 24 Alpine base replaces the
  earlier Debian runtime. Package managers and unnecessary executable privilege
  bits are removed; root owns nonwritable application artifacts, UID/GID
  `1000:1000` owns `/data`, and Node runs directly with an exec-form healthcheck.
  A read-only runtime needs bounded writable temporary storage at `/tmp`. See
  [runtime requirements](RUNTIME-IMAGE.md).
- **CI verifies the exact local candidate.** Runtime checks cover ownership,
  process controls, HTTP/MCP behavior, temporary files, and SQLite persistence.
  The image scan requires fresh inventory and advisory evidence, rejects all
  fixable findings and all high/critical findings without an exact reviewed
  exception, and checks for embedded credentials. See
  [image verification](IMAGE-SECURITY.md).

## Persistent data and deployment scope

The durable data contract remains aggregate amenity totals and their start date
in SQLite at `VISIT_COUNTS_PATH=/data/visits.sqlite`, owned by UID/GID
`1000:1000`. An existing-lease update must retain that data volume and path.
Local replacement fixtures verify persistence using disposable local servings;
they do not establish that a production `0.4.4` update has occurred or that live
counts have survived it. Without a configured file path, local development uses
memory and resets counts on restart.

Provider ingress topology and effective confinement remain open in ENG-1038.
The named AppArmor profile, its enforce mode and denial attribution, and an
isolated capable verification runner remain open in ENG-1041. A passing local
image check does not close these acceptance items or establish provider
enforcement. Proxy trust stays empty until the required ingress evidence exists.

## Preparation evidence

The local `registry:generate` command prepared `server.json`; `registry:check`
passes for version `0.4.4` and verifies both historical registry snapshot hashes.
Typechecking passes. A structural lockfile comparison confirms that only its two
root version fields changed; the dependency graph is unchanged.

The [preparation evidence](evidence/release-0.4.4-preparation.json) records the
following checks on September 21:

- `npm run check` passed metadata consistency, typechecking, all **193 tests**,
  and build. The official MCP Registry validator accepted the prepared metadata.
- The candidate passed ownership and writable-root code-protection checks,
  isolated runtime controls, HTTP/MCP behavior, SQLite persistence, temporary
  files, and graceful shutdown. Its package metadata and all 22 compiled files
  match the source build exactly. Local TLS/DNS fixtures passed.
- An isolated **0.4.3 → 0.4.4** replacement preserved all fixture counters and
  their start date, passed SQLite integrity checks, and durably counted a new
  local serving. Both containers and their disposable volume were removed.
- Trivy `0.74.0`, using the September 21 database, inventoried 10 OS and 168
  language packages. It found no OS vulnerabilities, secrets, or blocking
  advisories. The unfixed LOW `elliptic@6.6.1` advisory `CVE-2025-14505` remains
  visible; no exception or suppression was applied.

The historical `0.4.4` candidate was:

```text
ghcr.io/manifest-network/merovingian@sha256:4af4d3da11a31914d796da3f29a55e679c5c3ec366311b4601e4e38426e97621
```

Its separately verified configuration digest is
`sha256:24423d7d74c3a91fddb530a659e7c555154a21f0385dfbc0e36542ea6f47127d`.
The local OCI manifest, configuration, and all ten layer blobs were independently
hashed. These hashes bind only the historical `0.4.4` image. They must not be
reused as the candidate for ENG-1044; a rebuilt image requires its own version,
verification and publication authorization.

Authenticated provider reads prepared an image-only update for the existing
lease `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`. Its exact manifest SHA-256 is
`7c9773072774c5f02736cda525d2a77892ba449a56258512f0f84fd85043985d`.
The runtime environment, counter path, UID/GID, and empty proxy trust are
preserved. No new lease or chain transaction is required. This preparation did
not send an update POST. Publication, deployment, and later registry publication
still require authorization of the concrete actions; production acceptance must
use read-only checks unless a separate live-serving test scope is authorized.

This preparation record does not contain the subsequent publication evidence. The dated
[original audit](SECURITY-AUDIT-2026-09-18.md),
[remediation evidence](evidence/security-remediation-2026-09-18/README.md), and
[registry snapshots](evidence/mcp-registry-snapshots.json) remain unchanged
historical records; their results are not substituted for release-specific
validation.
