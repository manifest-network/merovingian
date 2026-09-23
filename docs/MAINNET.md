# Mainnet readiness

Mainnet supersedes the proof of concept. It is the permanent public refuge and the only environment that will handle real-value contributions or sales. These are follow-on requirements, not claims that the testnet prototype already implements a commercial payment system.

## Current release — 0.4.6 (2026-09-22)

Merovingian **0.4.6 is live at [merovingian.manifest.network](https://merovingian.manifest.network)**
on the original lease `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`. Following explicit
publication and update approval, provider release **8** is ready with manifest
hash `65e5310485168fc90150a36a6ff6a6621c7a092db262261d1a24d7557c9756d2` and the
verified public image:

```text
ghcr.io/manifest-network/merovingian@sha256:5de7cb4be48c89b059e515d414d0a247721e5a72e017a0992b4138ac2c08edeb
```

Public read-only smoke acceptance passed at **2026-09-22T14:05:22.590Z**: health,
OpenAPI, both server cards, and MCP initialization report `0.4.6`. Persistent
counts stayed at **8 cookies, 5 sauna sessions, and 6 teas** (19 total), with the
original start date **2026-09-17T20:29:18.301Z**. The runtime environment, counter
path, UID/GID, and empty proxy trust were preserved. The release adds complete
OpenAPI response contracts and smoke checks that default to read-only operation.
Live schemas, examples, response conformance and cache behavior passed at
**2026-09-22T14:09:27.112Z**. MCP Registry publication completed at
**2026-09-22T14:12:57.663135Z**; exact-version and latest records confirmed active
`0.4.6` metadata matching the committed `server.json`.

No live visits, payments, new lease, additional funding, chain transaction, or
DNS change were part of this update. **ENG-1038** provider ingress/confinement
evidence and **ENG-1041** named AppArmor verification remain open. Production
CPU/alert behavior for **ENG-1044** was not measured by these checks. See
[release acceptance](ACCEPTANCE.md#release-046-publication-and-verification) and
[sanitized evidence](evidence/release-0.4.6.json). The dated records below describe
earlier releases and retain their original observations.

## Live mainnet acceptance — 2026-09-18

At the September 18 acceptance, Merovingian **0.4.3 was live at [merovingian.manifest.network](https://merovingian.manifest.network)**. The user selected the exact `docker-nano` SKU and a **5 PWR per month hosting ceiling**, excluding transaction fees, supplied the dedicated production wallet, and configured Cloudflare DNS. DNS is verified **direct / DNS only, never proxied**. The original mainnet lease was **ACTIVE**, provider provisioning was **ready**, and aggregate counts survived that production image update. Testnet retirement behavior passed verification, and its lease was subsequently closed at the user's request. Mainnet remains live.

The launch CLI's persisted phase remains `awaiting-dns`, its final provider-upload phase. It does not track subsequent public acceptance; `.local/mainnet/dns-acceptance.json` and `.local/mainnet/live-acceptance.json` record those completed checks.

Release **0.4.3** replaced the image on the existing lease with one provider update POST, no new lease, and no chain transaction. Provider release **5** reached ready. The original launch receipts and image/hash below remain historical evidence; the current 0.4.6 image and manifest are recorded above, and the update procedure is documented below.

Published SDK 0.22.0 checks and the completed launch confirmed (historical launch evidence; the repository now uses SDK 0.23.0):

| Item | Observed value |
| --- | --- |
| Chain | `manifest-ledger-mainnet`; synchronized RPC and REST |
| RPC | `https://nodes.manifest.network/manifest/rpc` |
| REST | `https://nodes.manifest.network/manifest/api` |
| SKU | `docker-nano` / `019e6f08-a59a-7001-9f12-3a0963d3f193`, active |
| Provider | `019e6a0d-e141-7000-9e79-e94ac1bd333e`, healthy |
| Provider API | `https://barney.manifest.network/api/fred` |
| Advertised resources | 0.5 CPU core, 2048 MB RAM, 15 GB disk |
| Hourly hosting rate | 3600 base units = 0.0036 PWR |
| 24-hour / 30-day hosting | 0.0864 / 2.592 PWR, excluding transaction fees |
| 31-day hosting | 2.6784 PWR, within the 5 PWR ceiling |
| Minimum lease reserve | 3600 seconds / 0.0036 PWR |
| Mainnet lease | `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`, ACTIVE / ready |
| Domain | Claimed for service `refuge`; DNS-only routing and HTTPS verified |
| Native routing target | `refuge-928a176.barney0.manifest0.net` |
| Production tenant | `manifest1hkmrmsc6zjr7gm2wgtrtce7vgxeq9e402x5rf5` (user supplied) |

The endpoints come from [Manifest's mainnet documentation](https://docs.manifest.network/network-configurations/mainnet). Resource sizes are advertised by [the provider's public configuration](https://barney.manifest.network/config.js); catalog availability and public health checks are not a capacity reservation or a guarantee of enforced resource limits. Refresh the quote before execution.

### Historical launch image — 0.3.0

The initial launch used **0.3.0**. That application release passed **72 tests**, typecheck, and the production build; the expanded operator suite passed **114 tests** before launch. The subsequent routing-target suffix adjustment passed its **10 focused tests** and typecheck. The following personal-namespace image is historical launch evidence; the later organization-owned **0.4.3** image and its ten layers are recorded in the historical [Release 0.4.3](#release-043) section.

```text
ghcr.io/fmorency/merovingian@sha256:1020117aa543cbddcdbe0b49a671b09ddabb285a1f3af819d15ed3394d89f53b
```

At the **0.3.0 launch**, anonymous registry checks verified this exact manifest digest, the Linux/amd64 configuration, and access to its **nine** image layers without local registry credentials. Historical image publication and resource-test evidence are recorded in `.local/mainnet/resource-smoke.json`.

The user approved a **0.5 PWR aggregate launch-fee cap**; the completed creation and domain transactions cost **0.158206 PWR total**. No additional hosting deposit was made after the authorized initial 15 PWR. The status observation at **2026-09-17 19:55:42 UTC** showed **34.786741 PWR in the wallet** and **14.996400 PWR available hosting credit**. Credit continues to accrue hosting charges, so these are timestamped observations. The lease locks **2.592 PWR per 30 days**, within the unchanged 5 PWR monthly ceiling. Paid studio extras remain a separate implementation item below.

### Completed mainnet launch

The dedicated OS-keyring adapter signed the two authorized transactions, each broadcast once and committed successfully. The published SDK provider authentication and exact manifest upload were accepted live; provider status reported ACTIVE / ready at **2026-09-17 19:51:12 UTC**.

| Transaction | Committed height | Fee | Transaction hash |
| --- | --- | --- | --- |
| Create lease | 8560840 | 0.078940 PWR | `07B822E40906BB87F90A6C306246600233B8D8DF7ADA95E568BC2469D29DD952` |
| Claim custom domain | 8560841 | 0.079266 PWR | `53E35ECA505C7F42F0E795218C66EDF1836AAACF857E10B92BB4FBB90EF30723` |

Authorization, public launch state, and committed receipts are saved under `.local/mainnet/launch/` in `authorization.json`, `state.json`, and `transactions/{create-lease,claim-domain}.json`. The immutable manifest hash is `cf50a58b2eecb160b4686c3e3f2dd228ae5f323be1a6c8e0ae36a6273a426818`. Private keys, provider tokens, and signatures were not retained.

The historical **0.3.0** full public smoke passed at **2026-09-17 20:00:07 UTC** on the custom domain: all three amenities matched across HTTP and MCP, souvenirs were mainnet-labeled, canonical/indexing rules and sitemap passed, the operator ledger was available and `noindex`, and the existing **15 PWR** funding transaction returned matching confirmed HTTP/MCP receipts. No new payment was sent for acceptance. DNS resolvers `1.1.1.1` and `8.8.8.8` both returned the exact CNAME and provider address `64.29.115.30`; normal TLS verification passed on both the native hostname and custom domain. The local resolver briefly retained a negative DNS cache, so the check used public DNS resolution without disabling certificate validation. See [ACCEPTANCE.md](ACCEPTANCE.md) and the local DNS/live-acceptance reports.

### Completed initial credit deposit

The user authorized `manifestd` to use the local `merovingian` key for a **15 PWR** deposit to the same tenant. The public key address matched the configured wallet. Simulation estimated 166,106 gas with a 1.3 adjustment; the transaction used a fixed **0.083053 PWR** fee. It was broadcast once and committed successfully at height **8559740**, **2026-09-17 18:09:39 UTC**:

```text
135A80852DF825EE2B3FA0C00FF8BB32A586FBDCE7AE7FA167B898779030DC2F
```

The committed message, `credit_funded` event, credited balance, fee, and remaining wallet balance were checked. Public records are saved as `.local/mainnet/credit-funding-20260917-15pwr.{intent,broadcast,committed}.json`. The 15 PWR is prepaid credit; the 5 PWR monthly hosting ceiling is unchanged. This deposit is complete and must not be repeated as a launch prerequisite. Approval placeholders in the read-only deployment plan do not authorize additional spending.

Both networks currently use the same PWR denomination, verified independently on mainnet with six decimals and enabled sends:

```text
factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr
```

Chain identity, endpoints, wallets, deployment state, and receipts distinguish the networks. The app requires explicit mainnet RPC, REST, origin, denomination, and tenant values. The former SDK-example chain ID `manifest-1` is rejected.

### Read-only preparation commands

```sh
npm run mainnet -- preflight
npm run mainnet -- plan
```

These commands read the network and write public preparation records under `.local/mainnet/`. They contain no signing, funding, faucet, domain-claim, or deployment command and never read a wallet secret. The existing `npm run manifest` tool remains testnet-only and uses its existing state.

`.local/mainnet/config.json` carries the public tenant, immutable image digest, chosen provider, monthly budget, gas price, and optional `trustedProxyCidrs` string. The `MAINNET_TRUSTED_PROXY_CIDRS` environment variable overrides that public proxy setting for `preflight` and `plan`. Omission leaves proxy headers untrusted; an explicit empty string also selects no trust. Only verified ingress IPs or narrowly bounded CIDRs are accepted: IPv4 `/24`–`/32`, IPv6 `/64`–`/128`, with IPv4 notation required for mapped ranges. Generated manifests include `TRUSTED_PROXY_CIDRS` only when nonempty. Historical `TRUST_PROXY_HOPS=0` manifests remain valid; nonzero hop counts are unsupported.

`preflight.json` is a short-lived public quote; `plan.json` contains the resulting deployment specification and outstanding prerequisites. A stale quote, wrong network, ambiguous provider selection, missing image, or inadequate budget prevents a ready plan. A budget in this read-only plan is not an implemented automatic billing cutoff; execution must enforce the approved scope and establish monitoring before launch. Explicit proxy configuration is bound into new launch approval hashes; omitting the new setting preserves historical launch hashes. Changing it requires the existing-lease update workflow rather than resuming a launch with changed intent.

The prepared gas choice is `0.5` PWR **base units** per gas unit, above the node's observed minimum of `0.37`. Mainnet also accepts `umfx`, but the PWR choice permits funding hosting and fees with one token. Transaction fees are separate from the 5 PWR monthly hosting ceiling. Estimate the specific transactions before choosing the initial deposit and gas reserve; do not deposit the wallet's entire balance into nonwithdrawable hosting credit.

The user reports access through Manifest wallet, Keplr, and Manifest CLI. The local `manifestd` key named `merovingian` was verified and successfully used for the specifically authorized credit deposit; no key was exported or copied into the project. The initially generated, unfunded wallet has been archived locally as unused and removed from the preparation configuration. No preparation command reads it.

### Local keyring and SDK workflow

The selected signing path connects the dedicated `manifestd` key through a protected OS keyring and a temporary local adapter. A browser wallet connection is not required. The Linux helper uses the published Manifest Cosmos SDK fork to sign; the Node adapter implements the published JavaScript SDK's `WalletProvider` interface and independently verifies the returned account and signatures. The SDK handles transaction construction and provider authentication. This reusable capability is tracked upstream in [ENG-1012](https://linear.app/liftedinit/issue/ENG-1012/sdk-reuse-existing-manifestd-keyrings-for-transaction-and-provider).

The helper loads a software key into its native process when signing. It does not export or copy the key into the project, and key material does not pass to Node, the JavaScript SDK, or the hosted refuge. The production operator commands require the `os` backend; an already locked store must be unlocked locally. Never send a passphrase, seed phrase, or private key through chat, command arguments, or app environment variables. The helper and operator scripts are excluded from the Docker build context.

Native SDK/helper integration passed using only the public test fixture; evidence is in `.local/mainnet/keyring-fixture-check.json`. The initial production compatibility check stopped before signing because the key was accessible through the configured insecure `test` backend while explicit `os` lookup failed. The user then imported the same key into the protected OS store locally. The hardened adapter's production proof **passed at 2026-09-17 19:25:17 UTC**: the public key matched the expected tenant, and Node/OpenSSL independently verified the local ADR-036 signature. `.local/mainnet/keyring-check.json` records the result and reviewed helper digest. No transaction was signed, no network/provider token was used, and no challenge or signature was retained.

The test backend uses a publicly known password and is unsuitable for a funded wallet. After the user confirmed a secure recovery backup and explicitly authorized cleanup, only the old named `merovingian` key was deleted from that backend; its absence was verified. The protected OS proof passed again at **2026-09-17 19:28:29 UTC**. The CLI default remains `test`; production commands explicitly select `os`. No secret was exported or copied into the project or chat.

See [KEYRING.md](KEYRING.md) for build, local compatibility check, and unsigned deployment-preview commands. The local proof alone did not establish live provider acceptance; the subsequent successful mainnet authentication and upload did. The earlier `npm run mainnet:preview -- --public-account` passed on **2026-09-17** without opening a local wallet or signing/broadcasting, estimating a **0.07894 PWR** creation fee. Its domain placeholder was rejected as expected. `.local/mainnet/deployment-preview.json` is historical evidence with an expired **19:33:49 UTC** quote; the fresh launch proposal and actual transaction receipts supersede it. A fee estimate itself is never spending authorization.

### Launch CLI and recovery

Before the first launch, preparation produced a fresh unsigned proposal. For the existing deployment, use `status`; `prepare` deliberately refuses an existing launch state:

```sh
npm run mainnet:launch -- prepare
npm run mainnet:launch -- status
```

`prepare` reads the live network and simulates the lease transaction using the on-chain public account. It writes `.local/mainnet/launch/proposal.json` with the manifest, immutable image, provider/SKU, hosting rate, and lease-fee estimate. It does not open the keyring, sign, broadcast, or authenticate with the provider. `status` uses public chain reads to reconcile recorded transaction hashes and may save recovered public receipts; it never signs or submits a transaction. Updating launch state with a recovered lease UUID happens when the same `run` command resumes. The real domain transaction is simulated after the lease UUID exists.

The following command resumes the existing authorized launch with its unchanged **0.5 PWR** cap:

```sh
npm run mainnet:launch -- run \
  --helper "$PWD/.local/mainnet/bin/keyring-signer" \
  --home "$HOME/.manifest" \
  --key-name merovingian \
  --max-total-fee-pwr 0.5
```

The helper path must be absolute and match the successful local compatibility proof. Use the existing keyring directory if it differs from `$HOME/.manifest`. Production execution hardwires the `os` backend. The fee cap covers **both** lease creation and domain claim, separately from hosting credit and the 5 PWR monthly ceiling; failed or uncertain transaction fees remain reserved against it. The tool refuses a cap above 1 PWR. The approved cap was a ceiling, not a deposit: actual launch fees were 0.158206 PWR, and unused allowance does not authorize unrelated transactions.

Execution writes `.local/mainnet/launch/state.json` and public transaction journals under `launch/transactions/`. Each intent is persisted before signing and its transaction hash before the single broadcast. No signatures, signed transaction bytes, keys, or provider tokens are retained. The same `run` command resumes the same launch and fee cap. An existing intent is never automatically signed or broadcast again; an uncertain provider upload is reconciled through status, never blindly repeated. Readiness timeouts preserve the lease for inspection. Do not rerun the credit deposit, start a second lease, delete journals, or close/recreate the lease to clear an uncertain result.

A process crash can leave `launch/run.lock` or `launch/transactions/*.lock`. Inspect the recorded local PID, process identity, journal, transaction hash, and chain state first. Remove **only a confirmed stale lock** after that review; never remove a live process's lock or transaction journals. A signed hash that remains unconfirmed, or an intent without a hash, requires explicit local recovery review. See [KEYRING.md](KEYRING.md#launch-and-resume-with-the-protected-key) for the operator workflow.

### Cloudflare and launch sequence

1. Completed: verified the OS-keyring path, refreshed the unsigned proposal, and obtained the 0.5 PWR total transaction-fee authorization. Use `mainnet:launch -- status` to inspect the existing deployment.
2. Completed: funded 15 PWR hosting credit. Do not repeat that deposit; additional deposits require separate authorization. No mainnet faucet is used.
3. Completed in SDK order: created one pinned nano lease, claimed the domain for `refuge`, authenticated and uploaded the exact hashed manifest, then observed provider readiness. Preserve the existing lease identifier; do not create a second lease.
4. Completed and verified: Cloudflare **CNAME** named **`merovingian`** targets **`refuge-928a176.barney0.manifest0.net`**, **DNS only (gray cloud)**. This exact native FQDN came from the authenticated provider connection response; Fred retains it alongside the custom-domain router. Keep proxying disabled. Do not point the record at itself, the Fred API hostname, or the testnet deployment.
5. Completed: direct DNS resolution and valid TLS on the custom domain and native hostname. Cloudflare manages DNS only; the provider serves HTTPS and must renew the origin certificate. See [Cloudflare proxy status](https://developers.cloudflare.com/dns/proxy-status/). Certificate renewal has not yet been observed over a renewal cycle.
6. Completed at the historical **0.3.0 launch**: `scripts/smoke.ts` passed the full mainnet checks and verified the existing authorized 15 PWR funding hash. Testnet's migration redirects and 410 responses subsequently passed 18 live checks, then its lease was closed at the user's request. Registry version `0.4.2` was published on 2026-09-18 and a supervised fresh-agent visit passed; `0.4.3` publication and read-only acceptance followed. See the [registry runbook](MCP-REGISTRY.md) and [discovery evidence](MCP-DISCOVERY.md). Search Console setup and observed organic discovery remain follow-up work.

Public preflight evidence is in `.local/mainnet/public-summary.json`; subsequent `preflight` runs refresh the operational quote. Production acceptance records belong in `.local/mainnet/`, separate from testnet.

### Updates, rollback, and restore

Use the [existing-lease update workflow](#existing-lease-update-workflow), which sends the published SDK's `updateLease` request, to replace the manifest on the existing **ACTIVE** lease. The workflow keeps the active release's runtime configuration and changes the immutable image digest, plus any explicitly reviewed ingress setting. It keeps one journal per target digest, so it moves only to a digest it has not journaled. For a previously deployed digest, such as the `0.4.5` rollback candidate, `prepare` only reprints the old journal and `run` refuses with `another_update_requires_manual_reconciliation`. Rollback therefore needs a separately reviewed and authorized procedure; it has not been exercised. An update does not create another lease or change its on-chain metadata hash. A provider error or timeout can follow an applied update: inspect status and releases before deciding whether to reapply that same intended update. The initial launch command deliberately refuses changed configuration and does not perform updates.

The SDK's `restoreApp` has different semantics: it restores a **closed lease's retained data** into a **new lease**, subject to the provider's retention window. It requires new transaction fees and hosting reserve, and custom domains must be claimed again. It is not an automatic rollback and is not authorized by the initial launch fee cap. Release 0.3.0 had no persisted visit state; the 0.4.1 serving counter introduces aggregate data that should be preserved and backed up. Never close a healthy lease merely to deploy a new image.

### Release 0.4.3

This section records the historical September 18 release; 0.4.6 is current.

The user explicitly approved image publication, the existing-lease update, and MCP Registry publication. [PR #1](https://github.com/manifest-network/merovingian/pull/1) merged as [`300ac773f28dd61bd804d376cbddcd6ffbd5e82a`](https://github.com/manifest-network/merovingian/commit/300ac773f28dd61bd804d376cbddcd6ffbd5e82a); [main CI](https://github.com/manifest-network/merovingian/actions/runs/35360101100) passed registry consistency, typecheck, 142 tests, and build. The image was built from pre-merge commit `ef53a3feb62e91c0930d8f97a8aeff4e4c7bf17e`. That commit and the public squash merge have the identical Git tree `5783b3031882f6afd263d44b156eb0c219aeb90b`, so the built source matches the merged source. The public image is:

```text
ghcr.io/manifest-network/merovingian@sha256:e4014881bfb19e8804785923646a52ee0f515917b6a99b5242dc1106b2d8a6de
```

Manifest/configuration digests and anonymous access to all ten layers were verified. Provider release **5** reached ready with manifest hash `a68e232d7726ad108b1307c3bb512a1d31c37459527f639872654682000a1174`, on the same active lease. No additional deposit, chain transaction, DNS change, or data migration was needed.

**MCP compatibility:** the runtime/server-card name changed from `network.manifest.merovingian/merovingian` to `io.github.manifest-network/merovingian`. Clients that pin the old name may need to update their expected identity. The endpoint remains `https://merovingian.manifest.network/mcp`.

Public read-only acceptance passed at **2026-09-18T15:09:52.871Z**. Health, OpenAPI, both server cards, and MCP initialization reported `0.4.3`. Counts remained **6 cookies, 4 sauna sessions, and 6 teas**, with the exact original start date. The full `scripts/smoke.ts`, `/visit` form submission, `POST /api/v1/visits`, and MCP `enjoy_amenity` were **not rerun** because the release authorization excluded live visits. Earlier full smoke results describe their historical releases, not fresh serving-path acceptance of `0.4.3`. See [release acceptance](ACCEPTANCE.md#release-043-publication-and-verification) and [sanitized evidence](evidence/release-0.4.3.json).

Registry `0.4.3` was published at **2026-09-18T15:13:34.27966Z**. Exact-version and latest records both returned active metadata matching `server.json`. The historical `0.4.2` registry record and fresh-agent visit are preserved separately.

### Historical release 0.4.2

The source is public at [manifest-network/merovingian](https://github.com/manifest-network/merovingian); release 0.4.2 is recorded by [`b5ea795`](https://github.com/manifest-network/merovingian/commit/b5ea795). Publication checks exclude local journals, keyrings, credentials, and host history. Gitleaks 8.30.1 reported no findings in the source or publication history, and every historical blob was checked for machine-specific paths.

At the `0.4.2` acceptance, the organization image was anonymously verified by its exact manifest digest, configuration, and all ten layers:

```text
ghcr.io/manifest-network/merovingian@sha256:d82e4891c3f871c33d0e115706878193e1154559d11f43111a8e376b337c44be
```

The release provides three served-count cards on the homepage and operator dashboard, `/api/v1/stats`, a Markdown homepage, HTTP discovery links, API/AI catalogs, MCP server cards, agent skill discovery, and honest `/auth.md` public-access instructions. Two feature-detected WebMCP browser tools read the menu and perform real visits; the four remote MCP tools remain unchanged. The external readiness rescan at **20:50:23 UTC** improved from **20% (3/15)** to **73% (11/15)**, including WebMCP detection. Remaining checks are DNS-AID, two OAuth checks, and registration in `auth.md`; the public API needs no OAuth or registration. See `.local/mainnet/agent-readiness-comparison.json`.

The serving counter stores only per-amenity aggregates and their start date, bound to the deployment's network. Repeated requests and automated visits count again; seeds still yield deterministic souvenirs. Counters began at **2026-09-17T20:29:18.301Z**, with no historical backfill. The release sets `VISIT_COUNTS_PATH=/data/visits.sqlite`, declares Docker `VOLUME /data`, and runs as UID/GID `1000:1000`. The isolated replacement test verified persistence, exactly seven public stats fields, no visitor marker or signer artifacts, and operation with a read-only root, dropped capabilities, no external network, and nano resource limits. The live **0.4.1 → 0.4.2** image update then preserved **2 cookies, 2 sauna sessions, 3 teas**, and the exact start date. Evidence is `.local/mainnet/counter-container-acceptance.json` and `.local/mainnet/live-persistence-0.4.2.json`. This verifies update continuity; it does not replace backups or a disaster-recovery test.

The historical update journal records **ready**, provider release **4**, and manifest hash `b632797e7a79ee0cda6f7126d28f89576f8529e7df73e97c705f5d6feea357cb`. Public health and counter persistence passed after that update; full HTTP/MCP, dashboard, indexing, and contribution acceptance passed at **2026-09-17 20:50:40 UTC**. The original on-chain metadata hash remained unchanged, and no new payment was made.

For recovery, retain the historical 0.4.0 journal as **prepared, never attempted**. Its unnecessary public configuration fields were removed before production deployment; subsequent releases return only the seven declared stats fields. The expanded suite passed **132 tests**. The final 0.4.2 changes passed **25 focused tests**, typecheck, and build, including WebMCP behavior and homepage integration.

### Existing-lease update workflow

The update tool checks the exact existing active lease, domain, locked rate, current provider release, reviewed public environment, and pinned image. It uses SDK provider authentication and the update endpoint; it creates no lease and sends no chain transaction. Inspect the current `0.4.6` update with:

```sh
node --import tsx scripts/mainnet-update.ts status \
  --image ghcr.io/manifest-network/merovingian@sha256:5de7cb4be48c89b059e515d414d0a247721e5a72e017a0992b4138ac2c08edeb \
  --helper "$PWD/.local/mainnet/bin/keyring-signer" \
  --home "$HOME/.manifest" \
  --key-name merovingian
```

For a separately reviewed new image, use the same argument structure with **`prepare`**, inspect its exact manifest, then **`run`**. **`status`** reconciles an existing journal. All three commands need the verified protected OS keyring for short-lived ADR-036 provider authentication. `status` makes authenticated reads and never sends the update POST or a chain transaction. No provider token or signature is retained.

To accompany that new image with reviewed ingress trust, append `--trusted-proxy-cidrs 'VERIFIED_IP_OR_CIDR_LIST'` to `prepare`. The flag accepts the same comma-separated IP/CIDR syntax as the application. Omit it to preserve the active release's setting, or pass `--trusted-proxy-cidrs ''` to remove trusted proxies explicitly. The selected value is included in the exact manifest bytes and recorded manifest hash. Configuration-only changes using an already active image remain unsupported by this workflow.

On later `run`, `status` or repeated `prepare` calls, omitting the flag uses the already reviewed journal unchanged. An explicitly supplied flag must match that journal's normalized proxy setting; a conflict fails before network or wallet access. Editing a journal is not a way to change approved intent. Review the intended image and ingress setting together, then obtain separate authorization for the concrete production update. Public planning configuration and environment overrides do not silently alter an existing-lease update.

Update records live under `.local/mainnet/updates/`. The attempted phase is synced before a single POST that carries the journal's stable operation identifier as its `Idempotency-Key` header. The current provider (Fred v0.13) does not deduplicate commands, so the header does not make a repeated POST safe. Fred's deduplicating contract accepts one canonical lowercase UUIDv4 per logical command, which the journal already supplies. SDK 0.23's `updateLease` sends no key in its default Fred v0.13 mode, so the update transport sets it; uncertain updates only reconcile the authoritative active release and readiness. Another unresolved update blocks a different image. A timeout is not permission to repeat the POST, create a replacement lease, or erase a journal. Keep `.local/mainnet/launch/state.json` and its original image/hash unchanged as historical launch evidence: the launch resume command is **not** an image-update command. No additional deposit is required.

### Local runtime validation

The mainnet-configured 0.3.0 application passed a local container run with the advertised nano CPU/memory limits: 0.5 CPU and 2,048,000,000 bytes of RAM, read-only filesystem, non-root user, no published host ports, and no swap. All three HTTP/MCP amenities matched; mainnet SEO, operator `noindex`, and live read-only mainnet history/support queries passed. A bounded 60-request run at concurrency four had no errors, with about 81 ms p95 latency. Peak cgroup memory was 271,777,792 bytes (about 259 MiB), including the test client. These are local compatibility measurements, not a production traffic SLA or provider enforcement test. The test used an unfunded read-only tenant fixture, not the user's production wallet.

See `.local/mainnet/resource-smoke.json` for measurements. The optional modern signing adapter and independent signature tests are described in [DEPENDENCIES.md](DEPENDENCIES.md); the public service and preparation commands hold no signing credentials.

## Stable identity and discovery

- Use the selected `merovingian.manifest.network` domain and verify its provider routing, DNS, and TLS.
- Set the explicit HTTPS origin; configure and verify `manifest-ledger-mainnet`, its actual PWR denomination, and the dedicated tenant address. Testnet defaults must not leak into production.
- Verify canonical page URLs, titles/descriptions, structured data, sitemap, robot rules, and link targets on the live origin. Mainnet pages are rendered as HTML and need no JavaScript to index.
- Completed: the permanent MCP endpoint is published as `io.github.manifest-network/merovingian` version `0.4.6`, matching the live runtime/card identity and version. A supervised agent found the earlier `0.4.2` listing by name and completed one authorized free visit; releases `0.4.3` through `0.4.6` used read-only acceptance. Configure Search Console when domain access is available. Keep OpenAPI, `/visit.md`, and `/llms.txt` aligned with the running API.
- Observe real discovery and successful visits with privacy-conscious aggregate monitoring. Publishing metadata cannot guarantee indexing, ranking, MCP client installation, or demand.

## Replace the proof of concept

Testnet sends `noindex` headers and HTML metadata from day one. `robots.txt` allows crawlers to read those headers. No public directory submissions or indexable sitemap entries point to testnet.

Mainnet acceptance has passed. The existing testnet lease was updated to 0.3.0 and its retirement behavior verified at **2026-09-17 20:02:32 UTC**: all 18 checks passed for permanent human-page redirects, 410 machine responses, retirement health, and `noindex`. Evidence is `.local/testnet-retirement-acceptance.json`. The user then explicitly requested testnet shutdown. Lease `01a0b047-b052-7066-be12-9336dc10f8e4` is independently confirmed **CLOSED**: transaction `EF48086C69C4ABB0073F14B1AC588C91D26D0770268264DEA8B8B9F6D9A7FD88` committed successfully at height **11199552**, **20:03:48 UTC**, costing **0.233563 testnet MFX**. No mainnet transaction or additional funding was involved. The old provider hostname is no longer a supported migration endpoint; provider resource teardown may follow chain closure asynchronously. See `.local/testnet-close-confirmation.json` and the [testnet runbook](DEPLOYMENT.md).

1. Deploy mainnet and test free visits, the wallet contribution flow, and correct network labeling.
2. Set testnet `MAINNET_ORIGIN` only after mainnet passes validation. GET `/` and `/about` redirect permanently to their counterparts. APIs, MCP, and machine documents return 410 with the permanent origin and require explicit client reconfiguration.
3. Do not transfer testnet receipts, balances, or entitlements to mainnet. Keep saved testnet souvenirs clearly labeled as keepsakes.
4. Retain a migration notice for a bounded, funded interval; then close the testnet lease. If the old provider hostname expires with the lease, it cannot continue redirecting indefinitely.

## Funding and actual revenue

The studio funds baseline hosting. The user identifies PWR Station and its Stripe gateway as a PWR acquisition route; verify the exact official URL, delivery destination, and supported flow before purchasing. Set a hosting budget, balance alert threshold, replenishment owner, and shutdown/incident policy. Account for transaction gas separately from PWR credit.

The hosting contribution jar credits a nonwithdrawable Manifest billing account. It is not studio revenue. The user also wants a separate mainnet revenue stream. Before implementing paid extras, agree on:

- The paid extras and exact prices while preserving free essentials.
- Settlement to a studio-controlled recipient, supported denomination, transfer policy, and how the studio can actually withdraw or use proceeds. Do not assume PWR hosting credit is redeemable income.
- A quote/order identifier bound to chain, recipient, denomination, amount, item, and expiry.
- A visitor-held wallet or wallet adapter with spending authorization and limits. The refuge never takes custody of visitor keys. Stripe checkout is not assumed to be unattended agent funding.
- Durable payment reconciliation and unique transaction consumption so retries, concurrent requests, or chain-index delays cannot duplicate fulfillment or consume the same payment twice.
- An entitlement bound to an authenticated buyer when an extra requires ownership; the prototype's public souvenir receipt is not an ownership credential.
- Delivery status, recovery after a failed response, refunds and expired orders, revenue/accounting records, and truthful customer-facing terms.

## Operational readiness

- Use a dedicated production signer kept outside the public service, with secure backup and a recovery process.
- Review published SDK and transitive dependency advisories before signing real-value transactions; pin the versions actually tested.
- Verify transaction network and committed success before granting value; validate token base units with integer arithmetic.
- Configure and verify the REST transaction index used by `/operator` and `/api/v1/contributions`. Confirm the production PWR metadata has the six decimal places used by the dashboard. Keep these public, read-only views `noindex` and out of the sitemap; report history coverage and data freshness explicitly. Hosting deposits and future withdrawable revenue need separate accounting.
- Exercise image updates, rollback to a prior digest, health monitoring, low-credit alerts, and provider outage behavior.
- If paid entitlements introduce persistent storage, add backups and test restoration before accepting real payments.

Relevant primary guidance: [Google noindex](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag), [canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [MCP registry](https://modelcontextprotocol.io/registry/remote-servers).
