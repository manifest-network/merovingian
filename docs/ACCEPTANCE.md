# Acceptance — 2026-09-22

## Repeatable smoke checks (ENG-1032)

`npm run smoke -- ORIGIN [CONTRIBUTION_HASH] [--mainnet] [--serve] [--timeout-ms N]`
defaults to **read-only** checks. `--mainnet` selects the expected network; it
does not enable serving. Use an HTTPS origin without a trailing slash, path,
credentials, query, or fragment. HTTP is accepted only for loopback fixtures
(`localhost`, `127.0.0.1`, or `[::1]`). The target must match the repository's
application version.

`ORIGIN` must exactly match the deployment's `PUBLIC_ORIGIN`, including hostname
and port. For example, `localhost` and `127.0.0.1` are different origins even
when they reach the same server. The server card checks this before the remaining
discovery and serving checks. `.env.example` uses `http://localhost:8080`.

```sh
# Read-only public acceptance: no visit endpoints or enjoy_amenity calls.
npm run smoke -- https://merovingian.manifest.network --mainnet

# Serving checks against a configured, disposable local fixture only.
npm run smoke -- http://localhost:8080 --serve

# Self-contained fixtures: no running service, chain access, or wallet needed.
node --import tsx --test tests/smoke.test.ts
```

For a non-loopback target, `--serve` also requires
`--live-serve-authorization REFERENCE`, where `REFERENCE` names the authorization
for that target and serving budget (1–80 letters, digits, dots, underscores, or
hyphens). This reference is recorded in the report; it is an operator attestation,
not a substitute for the user's explicit authorization. Do not put credentials
or private context in it. A public `--serve` invocation without the reference
fails before any request. Local serving fixtures need only `--serve`.

Default checks read health, both MCP server cards, OpenAPI, homepage indexing
controls, operator HTML, contribution history, sitemap, amenities, the visit
guide, hosting support, and two serving-count snapshots. MCP initializes,
lists tools and resources, calls only `list_amenities`, and reads the visit-guide
resource. The HTTP and MCP menus and guides must agree. Support and history must
be available; a chain outage or unconfigured ledger fails the check before any
serving request. Isolated tests supply a local support fixture.

| Mode | Normal maximum HTTP requests, including MCP transport | Hard request cap, including one MCP cancellation | Serving requests | Expected count increase from this run |
| --- | ---: | ---: | ---: | --- |
| Default read-only | 20 | 21 | 0 | 0 |
| Explicit `--serve` | 27 | 28 | 7 | 2 cookies, 2 sauna sessions, 3 teas |
| Either mode with an existing contribution hash | Add 3 | Add 3 | No additional servings | No additional servings |

The default budget is 13 HTTP GETs, six MCP POSTs, and at most one SDK GET stream
probe, which must return HTTP 405 for this stateless service. Probe errors and
SDK background errors fail acceptance before serving. Discovery is one page;
unexpected pagination fails without following it.
`--serve` adds one browser-form tea visit, then one HTTP and one MCP visit for
each of the three fixed amenities. The script enforces both request and serving
caps at the transport boundary using a closed allowlist of methods, paths, and
MCP operations. Noncanonical path aliases, unknown tools, and unexpected verbs
are rejected. Both URL/init and `Request` inputs use their effective fetch
method and body. Supplying an existing contribution hash also checks its history entry,
checks that an unknown hash is pending, and compares its confirmed HTTP and MCP
receipts. These verification calls are read-only and never send a payment.

Every HTTP request, including MCP initialization, notifications, and response
bodies, has a fresh deadline: **15 seconds** by default; `--timeout-ms N` accepts
integers from 1 through 60,000. MCP requests also have a total response deadline
that progress notifications cannot extend. Redirects and MCP reconnects are
disabled. There are no automatic retries, including after HTTP 429 or 503. The
first failure stops the run and closes the owned MCP transport, including when
initialization fails. A timed-out or failed serving response may already have
incremented a counter; the failure summary records attempts, not confirmed
servings, including attempts that a rate limiter may have rejected. Reconcile an
uncertain result before seeking authorization for another run. Rerunning
`--serve` starts another seven-serving budget. Network diagnostics name the
method/path and distinguish blocked redirects and transport error codes without
copying arbitrary nested diagnostics into reports.

Each CLI run first reserves a unique `.local/smoke-MODE-RUN_ID.json` report
(under `.local/mainnet/` with `--mainnet`). Storage preflight must succeed before
any HTTP or MCP request. A pending record is written and synced, then replaced
atomically with that run's final result. Each new report has mode `0600`; previous
reports, including legacy fixed filenames, are never overwritten. Reports record
the mode, budget, authorization reference, attempted requests, counters, and
available souvenirs and receipt. A check failure retains the evidence collected
so far, including attempts that may have counted despite an uncertain response.

The CLI exits **0** when checks pass and evidence is saved, **1** for a preflight
or check failure, and **2** if checks passed but final report storage failed. In
the last case stdout still reports `passed: true`, `reportWritten: false`, and
the complete `recoveryReport`, including before/after counters, souvenirs, and
any receipt. Save that JSON; do not repeat serving requests to recover a report.
A `running` report without a final result indicates an interrupted run requiring
reconciliation. Failed checks also print their available evidence to stderr if
it cannot be saved. Use the emitted report path/run ID to identify each run.

Read-only reports mark serving checks `not-run` and serving HTTP/MCP equivalence
`null`. Both modes verify counter identity and continuity. Concurrent public
visitors can increase totals during a read-only check: `countsUnchanged: false`
reports that observation without attributing those visits to the check. The
default therefore checks monotonic counters and enforces the outbound read-only
allowlist, rather than claiming to prove the absence of other visitors. For a
quiet acceptance window, add **`--expect-unchanged-counts`**: any counter increase
then fails read-only acceptance, whether caused by the check or another visitor.
This option cannot be combined with `--serve`. Isolated tests assert unchanged
read-only counters, exactly seven additional servings in serving mode, and direct
rejection of unauthorized or over-budget calls at the transport boundary.

**Production authorization:** preparing or testing these changes, approving a
plan, selecting `--mainnet`, and supplying `--serve` do not grant production
authorization. Every deployment, update, DNS change, monitoring installation,
and rollback requires explicit authorization for that concrete action. Live
serving checks require a separately authorized target and seven-serving scope,
including the request budget above; release approval alone does not authorize
visits. Paid operations need their own authorization and are outside this
script. Keep reports and operational state in ignored local storage. ENG-1032
validation uses isolated local fixtures only; the release records below remain
historical evidence, not new production checks.

## Release 0.4.6 publication and verification

Release **0.4.6 is live on the original mainnet lease** following explicit
authorization for the reviewed image, existing-lease update, read-only acceptance
and matching MCP Registry publication. [PR #10](https://github.com/manifest-network/merovingian/pull/10)
merged as `6cbce452e89fbff410c40d245c7da63d77c1e238`; its source tree matches
the prepared release. Both [main CI jobs](https://github.com/manifest-network/merovingian/actions/runs/35736937171)
passed, following 300 passing tests and exact-candidate runtime/security checks.

The retained candidate was published without rebuilding. Anonymous GHCR requests
verified the `0.4.6` tag and digest manifest, configuration digest and access to all
eleven layers. Provider release **8** was observed ready at
**2026-09-22T14:04:55.056Z**, with manifest hash
`65e5310485168fc90150a36a6ff6a6621c7a092db262261d1a24d7557c9756d2`.
Only the image changed; SQLite storage, UID/GID `1000:1000`, public configuration,
empty proxy trust and the existing hosting rate were preserved.

The smoke suite passed at **2026-09-22T14:05:22.590Z** in read-only mode with
20 requests and zero serving requests. Health, OpenAPI, both server cards and
MCP initialization report `0.4.6`; HTTP/MCP menus and guides agree. Persistent
counts matched the pre-update snapshot: **8 cookies, 5 sauna sessions, 6 teas**
(19 total), with the original start date **2026-09-17T20:29:18.301Z**.

At **2026-09-22T14:09:27.112Z**, additional read-only checks validated all 24
published schemas, 79 response examples and five live GET responses. OpenAPI
media type, CORS, cache headers, HEAD and conditional 304 behavior passed.
The evidence accounts for 33 application read requests in total, including
the pre-update snapshot and a corrected conditional-request probe. No live
servings, payments, new lease, chain transaction, funding deposit or DNS change
were performed.

Official `mcp-publisher` 1.8.1 published the reviewed metadata at
**2026-09-22T14:12:57.663135Z**. Exact-version and latest records were verified at
**2026-09-22T14:15:35.158984Z**, both active and matching `server.json`. The
temporary registry login was removed. A public lookup timeout was reconciled
with read-only requests without repeating publication.

Provider ingress/confinement and named AppArmor evidence remain separate work in
ENG-1038/ENG-1041. See the [release notes](RELEASE-0.4.6.md),
[sanitized evidence](evidence/release-0.4.6.json) and
[registry snapshot](evidence/mcp-registry-0.4.6.json). Earlier dated records below
retain their historical observations.

## Release 0.4.5 publication and verification

Release **0.4.5 went live on the original mainnet lease** following the user's
release and deployment request. Provider release **7** was observed ready at
**2026-09-21T17:42:47.974Z**, with manifest hash
`c4cc3855835d3740b983644c1c4bfed740fe7f41bc2ed3bb19f0fba5466cf344` and image
`ghcr.io/manifest-network/merovingian@sha256:8e32caa5326f67863fe1fb70153cfc8998fd2cee43119f14d29876e256933d24`.
The `0.4.5` tag, manifest, configuration and all eleven layers were verified by
anonymous downloads against the exact tested image. [PR #6](https://github.com/manifest-network/merovingian/pull/6)
merged as `0f571a3a1b5191ff587a0caf3109298e1babd931`; its
[main CI](https://github.com/manifest-network/merovingian/actions/runs/35632247019)
passed Check and Final image. Local candidate evidence records **204 tests** and
**32 healthcheck scenarios**.

Read-only public acceptance passed at **2026-09-21T17:43:16.792Z**. Health,
OpenAPI, both server cards and MCP initialization report `0.4.5`, and all four
MCP tools are discoverable. Counts remained **8 cookies, 5 sauna sessions and
6 teas** (19 total), with the exact original start date
**2026-09-17T20:29:18.301Z**. The image was the only manifest change; the runtime
environment, `/data/visits.sqlite`, UID/GID and empty proxy trust were preserved.
No live visits, payments, new lease, funding, chain transaction or DNS change
were involved.

MCP Registry publication completed at **2026-09-21T18:03:55.231121Z**. Exact-version
and latest records were verified by **2026-09-21T18:03:57.501945Z**: both identify
active `0.4.5` with metadata matching the committed `server.json`. The temporary
registry login was removed after verification. Provider CPU and alert behavior
for ENG-1044, ingress/confinement evidence for ENG-1038 and AppArmor enforcement
for ENG-1041 remain outside this acceptance. See the
[release record](RELEASE-0.4.5.md) and [sanitized evidence](evidence/release-0.4.5.json).

## Release 0.4.4 publication and verification

Release **0.4.4 went live on the original mainnet lease** after explicit approval
to publish the verified image and update that lease. Provider release **6** is
ready with manifest hash
`7c9773072774c5f02736cda525d2a77892ba449a56258512f0f84fd85043985d`.
The published image is
`ghcr.io/manifest-network/merovingian@sha256:4af4d3da11a31914d796da3f29a55e679c5c3ec366311b4601e4e38426e97621`.
Anonymous GHCR reads verified that its manifest, configuration, and all ten layer
blobs match the checked local candidate. [PR #4](https://github.com/manifest-network/merovingian/pull/4)
merged as `feacd4ec129fbbaa8b8d661eaef279ded623d55b`; its
[main CI](https://github.com/manifest-network/merovingian/actions/runs/35602896692)
passed both Check and Final image.

Public **read-only** acceptance passed at **2026-09-21T13:13:36.048Z**. Health,
OpenAPI, both server cards, and MCP initialization report `0.4.4` under
`io.github.manifest-network/merovingian`; MCP tool listing retains all four tools.
Persistent counts remained **8 cookies, 5 sauna sessions, and 6 teas** (19 total)
against the fresh pre-update snapshot, with the exact original start date
**2026-09-17T20:29:18.301Z**. Separately authorized MCP Registry publication
completed at **2026-09-21T13:13:54.140771Z**; exact-version and latest records
returned active `0.4.4` metadata matching `server.json`.

No live visit, payment, additional funding, new lease, chain transaction, or DNS
change was performed for this release. These checks establish health, identity,
discovery, and counter continuity; they do not establish fresh live serving-path
acceptance. The runtime environment, `/data/visits.sqlite`, UID/GID `1000:1000`,
and empty proxy trust were preserved. Provider ingress and confinement evidence
remain open in **ENG-1038**, and named AppArmor enforcement and denial attribution
remain open in **ENG-1041**. See the [sanitized release evidence](evidence/release-0.4.4.json)
and [release preparation](RELEASE-0.4.4.md). The dated earlier release records
below remain historical evidence.

## Release 0.4.3 publication and verification

The historical **0.4.3 release went live on the original mainnet lease** on September 18 after explicit approval to publish its image and update the deployment. Provider release **5** reached ready, with manifest hash `a68e232d7726ad108b1307c3bb512a1d31c37459527f639872654682000a1174`. The update used the existing lease, with no chain transaction or additional funding. Public **read-only** acceptance passed at **2026-09-18T15:09:52.871Z**.

- Source: [PR #1](https://github.com/manifest-network/merovingian/pull/1), merged as [`300ac773f28dd61bd804d376cbddcd6ffbd5e82a`](https://github.com/manifest-network/merovingian/commit/300ac773f28dd61bd804d376cbddcd6ffbd5e82a). The image was built from pre-merge commit `ef53a3feb62e91c0930d8f97a8aeff4e4c7bf17e`; both commits have the identical Git tree `5783b3031882f6afd263d44b156eb0c219aeb90b`. [Main CI](https://github.com/manifest-network/merovingian/actions/runs/35360101100) passed registry consistency, typecheck, **142 tests**, and build.
- Image at acceptance: `ghcr.io/manifest-network/merovingian@sha256:e4014881bfb19e8804785923646a52ee0f515917b6a99b5242dc1106b2d8a6de`. Manifest/configuration digests and anonymous access to all ten layers were verified.
- Health, OpenAPI, both server cards, and MCP initialization reported `0.4.3`. The runtime and server cards used `io.github.manifest-network/merovingian`, matching the registry namespace. Read-only MCP discovery found all four tools and the three free amenities.
- Serving counts stayed at **6 cookies, 4 sauna sessions, and 6 teas** (16 total), with the original start date **2026-09-17T20:29:18.301Z**. No live visit or payment was performed for this release check.
- The candidate preserved a `0.4.2` SQLite fixture in an isolated local container with no external network, a read-only root, UID 1000, 128 MiB memory, and a 0.1 CPU limit. These local test limits do not describe the provider's advertised SKU resources.

The evidence ties that local fixture check to the exact published image digest.
The deployment journal recorded readiness at **2026-09-18T15:09:30.178Z**;
this records the observation, not the provider's exact transition time. The
pre-update counts were recorded at **15:08:54.461959Z**, and the final counts
were read before the acceptance report completed at **15:09:52.871Z**, on
2026-09-18. The original check did not record the final stats request's exact
time, so the evidence labels the latter timestamp as `afterObservedByAt`.

The separately dated `imageIdentifierVerification` records a read-only recheck
of the local image and GHCR. Docker 29.6.2 on this host uses the containerd image
store and returned the manifest digest in both `Id` and `Descriptor.digest`.
This agrees with the [Moby containerd inspection implementation](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go),
which returns the image target's digest. The original fixture's recorded value
is retained as `dockerInspectId`; the distinct `configurationDigest` is recorded
separately. Both the manifest and configuration were independently hashed from
the local OCI export and matched the corresponding anonymous GHCR blob bytes.
This recheck did not rebuild the image or repeat the fixture or deployment.

Service-returned `since` and registry `publishedAt` strings are preserved exactly,
as is the journal's readiness timestamp. Other observation timestamps use UTC
`Z`; compare mixed fractional precision as parsed instants.

**Acceptance scope:** the full `scripts/smoke.ts`, `/visit` form submission,
`POST /api/v1/visits`, and MCP `enjoy_amenity` were not rerun against live `0.4.3` because the release
authorization excluded live visits. The full smoke results below describe older
releases. The `0.4.3` checks establish identity, discovery, health, and counter
continuity; they do not establish fresh end-to-end serving acceptance.

**MCP compatibility:** the runtime/server-card name changed from
`network.manifest.merovingian/merovingian` to
`io.github.manifest-network/merovingian`. Clients pinning the old name may need to
update their expected identity. The endpoint remains
`https://merovingian.manifest.network/mcp`.

The [sanitized release evidence](evidence/release-0.4.3.json) records these observations. Registry version `0.4.3` was published at **2026-09-18T15:13:34.27966Z** after explicit approval. Both the exact-version and latest records returned active, latest metadata matching `server.json`; the [saved registry response](evidence/mcp-registry-0.4.3.json) preserves the result. The earlier fresh-agent visit remains a separate [historical discovery record](MCP-DISCOVERY.md).

## Release 0.4.2 publication and verification

The historical **0.4.2** update completed on the original mainnet lease without a new lease, chain transaction, or funding deposit. Provider release **4** reached ready, with manifest hash `b632797e7a79ee0cda6f7126d28f89576f8529e7df73e97c705f5d6feea357cb`. Final public HTTP/MCP acceptance passed at **2026-09-17T20:50:40.854Z** using normal DNS and TLS verification. The following observations describe that historical release; current `0.4.6` acceptance is recorded above.

- Public source: [manifest-network/merovingian](https://github.com/manifest-network/merovingian), runtime source commit [`b5ea795`](https://github.com/manifest-network/merovingian/commit/b5ea795).
- Image at acceptance: `ghcr.io/manifest-network/merovingian@sha256:d82e4891c3f871c33d0e115706878193e1154559d11f43111a8e376b337c44be`; exact digest, configuration, and all ten layers verified anonymously.
- Validation: the expanded suite passed **132 tests**, typecheck, and build. Subsequent privacy changes passed **22 focused tests**; the final browser integration passed **25 focused tests**, typecheck, and build. Full live acceptance verified all three amenities over HTTP and MCP, the dashboard, indexing controls, and the existing 15 PWR contribution receipt. No new acceptance payment was sent.
- Publication review: Gitleaks **8.30.1** found no secrets in the source or publication history. Every historical blob was checked for machine-specific paths. Local secrets, keyrings, journals, and host history were excluded.

The release provides persistent aggregate serving counts, homepage/operator count cards, `/api/v1/stats`, Markdown negotiation and `/index.md`, discovery catalogs and links, MCP server cards, an agent skill index, and public-access instructions at `/auth.md`. Two feature-detected WebMCP browser tools perform real menu and visit operations; the four remote MCP tools remain available.

Live counters began at **2026-09-17T20:29:18.301Z**. The production **0.4.1 → 0.4.2** image update preserved **2 cookies, 2 sauna sessions, 3 teas**, and the exact start date on the same lease. Final smoke visits then brought totals to **4 cookies, 4 sauna sessions, and 6 teas**. These totals include automated checks and repeated visits; they are not unique visitor counts. Earlier visits cannot be backfilled. The counter stores no visitor identities, seeds, preferences, or souvenir content. Evidence is `.local/mainnet/live-persistence-0.4.2.json` and `.local/mainnet/live-acceptance.json`.

SQLite uses `/data/visits.sqlite`, configured through `VISIT_COUNTS_PATH`, with a `/data` image volume and UID/GID `1000:1000`. An isolated container replacement test also preserved counts and their start date, verified the seven public stats fields, and found no stored visitor marker or signer artifacts. It ran with no external network, a read-only root filesystem, dropped capabilities, no new privileges, and nano CPU/memory caps. Evidence is `.local/mainnet/counter-container-acceptance.json`. Live update continuity is verified; backups and disaster recovery remain separate operational work.

The external readiness rescan at **2026-09-17T20:50:23.110Z** improved from **20% (3/15)** to **73% (11/15)**, labeled **Level 4 / Agent-Integrated**. The scanner detects both WebMCP tools. Remaining checks cover DNS-AID, two OAuth endpoints, and registration markers in `auth.md`; this public service requires no OAuth or registration. This is a particular scanner's result, not a guarantee of compatibility with every agent. Evidence is `.local/mainnet/agent-readiness-after.json` and `agent-readiness-comparison.json`.

The original lease remains `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`, and its launch evidence is preserved. The earlier 0.4.0 candidate was prepared but never deployed; unnecessary public configuration fields were removed before production rollout. Retain its unattempted journal for recovery history. See [the existing-lease update runbook](MAINNET.md#existing-lease-update-workflow).

## Historical mainnet launch, release 0.3.0

The initial mainnet launch passed full public acceptance at **2026-09-17T20:00:07.935Z** using release 0.3.0 and published SDK dependencies. The same lease and public domain now run 0.4.6 as verified above.

- Homepage: [merovingian.manifest.network](https://merovingian.manifest.network)
- Agent instructions: [visit.md](https://merovingian.manifest.network/visit.md)
- MCP Streamable HTTP: [mcp](https://merovingian.manifest.network/mcp)
- Operator dashboard: [hosting ledger](https://merovingian.manifest.network/operator)
- Chain: `manifest-ledger-mainnet`
- Tenant: `manifest1hkmrmsc6zjr7gm2wgtrtce7vgxeq9e402x5rf5`
- Lease: `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`, ACTIVE / provider ready
- Provider: `019e6a0d-e141-7000-9e79-e94ac1bd333e`
- Historical 0.3.0 image (nine layers): `ghcr.io/fmorency/merovingian@sha256:1020117aa543cbddcdbe0b49a671b09ddabb285a1f3af819d15ed3394d89f53b`. The current 0.4.6 organization image has eleven layers and is recorded above.

### DNS, HTTPS, and live application checks

Cloudflare serves a **DNS-only CNAME** from `merovingian.manifest.network` to the authenticated provider's native hostname, `refuge-928a176.barney0.manifest0.net`. Public resolvers `1.1.1.1` and `8.8.8.8` independently returned that CNAME and the same provider address, `64.29.115.30`. Normal TLS certificate verification succeeded for the native hostname and custom domain. A temporary public-DNS lookup bypassed a local negative DNS cache; certificate verification was never disabled. Certificate renewal has not yet been observed over a renewal cycle.

The historical 0.3.0 mainnet smoke verified:

- Healthy release 0.3.0, correct mainnet chain identity, and `retired: false`.
- All three amenities over HTTP and a real MCP SDK client, with identical seeded results and mainnet-labeled souvenirs.
- Browser visits, downloadable souvenir markup, and agent instructions pointing to the permanent MCP origin.
- Indexable homepage metadata, the correct canonical URL, and a sitemap containing only public pages.
- An available, read-only operator ledger with `noindex`, plus matching mainnet contribution-history JSON.
- A nonexistent transaction returning pending without an invented receipt.
- The existing **15 PWR hosting deposit** returning matching confirmed HTTP and MCP receipts; no new acceptance payment was sent.

The acceptance evidence is `.local/mainnet/live-acceptance.json` and `.local/mainnet/dns-acceptance.json`. `indexingVerified` in the smoke report means the application's canonical/indexing controls passed; it does not claim that a search engine has indexed the site or that a public MCP registry submission has been made.

This historical command used the former serving-by-default script. With the
current script it runs read-only; fresh serving acceptance requires separately
authorized use of `--serve` as described above.

```sh
node --import tsx scripts/smoke.ts \
  https://merovingian.manifest.network \
  135A80852DF825EE2B3FA0C00FF8BB32A586FBDCE7AE7FA167B898779030DC2F \
  --mainnet
```

### Launch and funding evidence

The user authorized a 0.5 PWR total launch transaction-fee cap. Lease creation and domain claim each committed once, costing **0.078940 PWR** and **0.079266 PWR**, respectively: **0.158206 PWR total**. Their public hashes and heights are in [MAINNET.md](MAINNET.md#completed-mainnet-launch) and `.local/mainnet/launch/transactions/`. Provider authentication, exact manifest upload, and readiness were verified live. No additional hosting deposit was made after the initial authorized 15 PWR.

The lease locks **2.592 PWR per 30 days**, excluding gas, within the **5 PWR/month** hosting ceiling. At **19:55:42 UTC**, the wallet held **34.786741 PWR** and available hosting credit was **14.996400 PWR**; hosting consumption continues. Hosting credit is nonwithdrawable and distinct from future studio revenue. Paid extras remain unimplemented.

The application release passed 72 tests, typecheck, and a production build. The expanded operator suite passed 114 tests before launch; the later native-routing suffix fix passed 10 focused provider tests and typecheck. The image was anonymously pullable and previously passed the bounded local nano-resource smoke. Local signer compatibility, crash recovery, and dependency limitations are documented in [KEYRING.md](KEYRING.md) and [DEPENDENCIES.md](DEPENDENCIES.md). No signing credentials enter the hosted application.

### Testnet migration acceptance

After mainnet acceptance, the **existing** testnet lease was updated to the same 0.3.0 digest and configured with `MAINNET_ORIGIN=https://merovingian.manifest.network`. At **2026-09-17T20:02:32.518Z**, all **18** migration checks passed: GET/HEAD `/` and `/about` returned permanent 301 redirects; API, MCP, support, operator, and machine-document routes returned 410; health reported retirement; every checked route retained `noindex` and testnet identity. No request or payment is silently forwarded across networks.

Evidence is `.local/testnet-retirement-acceptance.json`. No new lease, funding, or chain transaction was needed to enable migration behavior. The user subsequently requested testnet shutdown, and its lease is independently confirmed **CLOSED**. Transaction `EF48086C69C4ABB0073F14B1AC588C91D26D0770268264DEA8B8B9F6D9A7FD88` committed with code 0 at height **11199552**, **2026-09-17T20:03:48Z**, costing **0.233563 testnet MFX**. It contained only the close instruction for testnet lease `01a0b047-b052-7066-be12-9336dc10f8e4`. Mainnet remains live. Evidence is `.local/testnet-close-confirmation.json`; the old hostname is no longer a supported endpoint, and provider resource teardown may follow chain closure asynchronously.

## Historical testnet proof of concept

The following records describe the earlier 0.1/0.2 proof of concept. At that stage, no mainnet transactions or real-value purchases had been made. The former origin served the verified migration behavior above before its lease was closed; these historical amenity checks are not its current behavior.

### Historical public service

- Homepage: https://refuge-c70596c.barney13.testnet.manifest0.net
- Agent instructions: https://refuge-c70596c.barney13.testnet.manifest0.net/visit.md
- MCP Streamable HTTP: https://refuge-c70596c.barney13.testnet.manifest0.net/mcp
- Operator dashboard: https://refuge-c70596c.barney13.testnet.manifest0.net/operator
- Chain: `manifest-ledger-testnet`
- Lease: `01a0b047-b052-7066-be12-9336dc10f8e4`
- Provider: `019dc0d6-446d-7000-992a-8dd25efe6328`
- Image: `ghcr.io/fmorency/merovingian@sha256:8714a9140b0516101b6e70f1102e7d134461322e9642d2beaef4ff420fc4fcdd`

The container registry allows anonymous access to this exact digest. The runtime contains compiled app code, published dependencies, and package metadata; local wallets, environment files, and registry credentials are excluded.

### Verification

`npm run check` passed all 49 tests, TypeScript checks, and the production build for version 0.2.0. Coverage includes amenity validation, HTTP/MCP equivalence, chain outages, transaction validation, rate limits, testnet indexing controls, mainnet retirement behavior, and contribution history. The finished image also passed a container smoke test as a non-root user with a read-only filesystem and no external network.

Initial proof-of-concept checks at `2026-09-17T16:53:50.599Z` passed for:

- Public HTTPS health and configured origin links.
- All three amenities over both HTTP and a real MCP SDK client, with identical seeded results.
- The browser visit form and downloadable souvenir markup.
- Testnet `noindex` headers and an empty sitemap.
- Available hosting-support instructions from the actual testnet.
- A nonexistent transaction returning an uncertain/pending result without a receipt.
- A confirmed visitor contribution, with matching HTTP and MCP receipts on repeated verification.

### Operator dashboard update

Version 0.2.0 was published and updated on the existing lease on 2026-09-17. The expanded public HTTP/MCP smoke passed at `2026-09-17T17:20:10.192Z`, including dashboard HTML, history JSON, all three amenities, and the existing contribution receipt. Anonymous access to the new image digest returned HTTP 200 before the update. No new lease, faucet request, or contribution was needed.

The dashboard at `/operator` displays funding totals, tenant-wallet versus other-wallet deposits, available and reserved hosting credit, UTC timestamps, expandable sender addresses, and transaction links. `/api/v1/contributions` exposes the same history as JSON. It reads up to 100 indexed transactions, marks incomplete coverage, and caches successful readings for 60 seconds. Unavailable readings display as unknown rather than zero. Amounts use integer arithmetic throughout.

The dashboard is read-only and uses public chain data without wallet credentials or a database. Both routes stay `noindex` on mainnet as well as testnet and remain outside the sitemap. Retiring testnet returns 410 for these views, preserving the network boundary. Desktop and phone layouts were inspected in Chromium; previews are stored in `.local/`.

History aggregation reads successful transactions’ executed `credit_funded` events, covering direct, delegated-wallet, and group deposits. Tests verify that legitimate repeated deposits count, duplicate transaction records do not inflate totals, malformed records fail without invented zero balances, and incomplete history never claims lifetime totals. The live SDK check found the two existing deposits: 9.9 test PWR from the tenant and 0.1 test PWR from the scripted visitor.

The historical smoke command used published npm dependencies. It is preserved for the record; the retired testnet no longer passes an active-refuge smoke:

```sh
node --import tsx scripts/smoke.ts \
  https://refuge-c70596c.barney13.testnet.manifest0.net \
  81AB1A57D1615CC4EA02328B8A3D26F9EA5765BBF37C911D767E332A2C7F30EB
```

### Independent agent visit

A fresh agent received only the homepage URL and an instruction to complete a free visit. It did not inspect application source or local documentation. It discovered the public visit guide and menu, selected the magenta rgB sauna, and received HTTP 200.

Souvenir ID: `merovingian-testnet-68f9bb49522e0620512ffd7e`. The exact returned text was saved and checked locally at `.local/fresh-agent-souvenir.txt` (629 bytes). Its web tool rejected the hostname and sandbox DNS was unavailable; an approved HTTP request succeeded. This demonstrates usability from an encountered URL, not organic search discovery or universal host compatibility. No wallet was used by that fresh visitor.

### Separate-wallet contribution

A different, locally controlled visitor wallet received funds from the original faucet allocation and signed one hosting-credit contribution through the published Manifest SDK. Merovingian's public service never received the signing key.

- Visitor: `manifest16fvct2udnm4nx5da9vka6tayrfwgw64tn05qjn`
- Refuge tenant: `manifest1z5ep5m3ka5v2fn5wyv93elqh5nqlfqww2u82f4`
- Amount: `100000` base units, equal to **0.1 test PWR**.
- Transaction: `81AB1A57D1615CC4EA02328B8A3D26F9EA5765BBF37C911D767E332A2C7F30EB`
- Inclusion height: `11197414`; transaction result code: `0`.

Both HTTP and MCP independently returned `status: confirmed` and the same network-scoped public receipt. The receipt is a keepsake acknowledging an on-chain contribution; it does not prove ownership or grant a paid entitlement.

### Historical funding and mainnet limits

The initial faucet allocation supplied 10 test PWR: 9.9 funded the refuge directly and 0.1 arrived through the visitor test. The selected lease costs 1.8 test PWR/hour. At the final status observation, about 5.5 hours remained, with estimated credit exhaustion around **22:25 UTC / 18:25 America/Toronto on 2026-09-17**. This is an estimate affected by settlement timing; there is no automatic refill.

Testnet stayed unindexed and had no public MCP directory listing. Mainnet domain, funding, and protected signing subsequently completed as recorded above; separate revenue settlement remains follow-up work in [MAINNET.md](MAINNET.md). See [DEPENDENCIES.md](DEPENDENCIES.md) for current dependency pins and advisory limitations.

Local operational receipts are in `.local/`. Use the [deployment runbook](DEPLOYMENT.md) for status, updates, retirement, and shutdown.
