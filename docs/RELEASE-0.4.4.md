# Release 0.4.4 — live

This dated record describes the `0.4.4` publication. Later releases are
[0.4.5](RELEASE-0.4.5.md), [0.4.6](RELEASE-0.4.6.md) and [0.4.7](RELEASE-0.4.7.md), which is current. The
observations and digests below are historical.

Release `0.4.4` is live on Manifest mainnet and published as the latest version
in the official MCP Registry as of 2026-09-21. The user explicitly approved
publication of the exact candidate image, the existing-lease update, and
registry publication after successful live acceptance. The
[publication and acceptance evidence](evidence/release-0.4.4.json) records the
completed actions and their verification limits.

This immutable `0.4.4` image predates ENG-1044 and retains the original Node
healthcheck. The healthcheck fix is the separate [0.4.5 release](RELEASE-0.4.5.md);
the `0.4.4` digest below must not be reused as the candidate for that fix.

This release packages the security remediation merged in
[PR #3](https://github.com/manifest-network/merovingian/pull/3), merge commit
`b77ca46d82006c3d577961874cd11aa1a805cdf9`. Release preparation changed the
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
`1000:1000`. The existing-lease update retained that data volume and path.
Read-only production acceptance at **2026-09-21T13:13:36.048Z** confirmed the
same 8 cookies, 5 sauna sessions, and 6 teas, totaling 19 servings, before and
after the update. The original counting start time
`2026-09-17T20:29:18.301Z` was unchanged. These are dated observations, not a
claim about future live totals. Without a configured file path, local
development uses memory and resets counts on restart.

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

The exact candidate was published and deployed as:

```text
ghcr.io/manifest-network/merovingian@sha256:4af4d3da11a31914d796da3f29a55e679c5c3ec366311b4601e4e38426e97621
```

Its separately verified configuration digest is
`sha256:24423d7d74c3a91fddb530a659e7c555154a21f0385dfbc0e36542ea6f47127d`.
The local OCI manifest, configuration, and all ten layer blobs were independently
hashed. Anonymous GHCR verification after publication confirmed that both the
`0.4.4` tag and digest reference preserved the exact manifest, configuration, and
layer bytes. A rebuild or changed manifest format requires renewed verification
and review.

Authenticated provider reads prepared an image-only update for the existing
lease `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`. Its exact manifest SHA-256 is
`7c9773072774c5f02736cda525d2a77892ba449a56258512f0f84fd85043985d`.
The runtime environment, counter path, UID/GID, and empty proxy trust were
preserved. The preparation evidence records the state before authorization and
did not include an update POST; the subsequent publication and deployment are
recorded separately below.

## Publication and live acceptance

The provider confirmed **release 6** ready on the existing lease, with both the
active image and active manifest hash matching the approved values above. No
new lease was created and no chain transaction was sent. This provider response
binds the update to the image and manifest; a public version string alone cannot
prove the running image digest or effective confinement.

Public acceptance confirmed healthy mainnet `0.4.4`, the current and legacy
server cards, OpenAPI version, MCP initialization and the four-tool inventory,
and persistent serving totals. It made no MCP tool calls, live servings, or
payments. The first acceptance checker expected `application/json` for the
current server card; correcting its expectation to
`application/mcp-server-card+json` allowed acceptance to complete. No production
code change was needed.

The registry published `0.4.4` at **2026-09-21T13:13:54.140771Z**. Exact-version
and latest records were verified as active, latest, and equal to the approved
metadata at **2026-09-21T13:13:54.816064Z**. The exact `server.json` SHA-256 is
`c2c33a0105b9f0af82cb6ae0ab5d774b5c9e4b5c480c10aecb5358dbe77c2f69`.
The temporary registry login was removed after verification. See the
[registry publication record](MCP-REGISTRY.md) and
[sanitized release evidence](evidence/release-0.4.4.json).

The original [preparation evidence](evidence/release-0.4.4-preparation.json) and dated
[original audit](SECURITY-AUDIT-2026-09-18.md),
[remediation evidence](evidence/security-remediation-2026-09-18/README.md), and
[registry snapshots](evidence/mcp-registry-snapshots.json) remain unchanged
historical records; their results are not substituted for release-specific
validation.
