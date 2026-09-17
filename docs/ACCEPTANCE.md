# Acceptance — 2026-09-17

## Release 0.4.1 publication and verification

Release **0.4.1 is live on the original mainnet lease**. One provider update POST completed without a new lease, chain transaction, or funding deposit. Provider release **3** was ready at **2026-09-17T20:29:23.087Z**, with manifest hash `0456290ccff8ff4674175b95a7dd535529c021cdc2bd094a244b7000a4a04b56`. The final public HTTP/MCP smoke passed at **20:29:47.577 UTC** using normal DNS and TLS verification.

- Public source: [manifest-network/merovingian](https://github.com/manifest-network/merovingian), release commit [`38b92b1`](https://github.com/manifest-network/merovingian/commit/38b92b1).
- Running image: `ghcr.io/manifest-network/merovingian@sha256:3375855154c860d04d45e548cb089b826231724f832f2329ff4b1ba7e26ba97e`; exact digest, configuration, and all ten layers verified anonymously.
- Validation: **132 tests**, typecheck, and production build passed, plus **four focused metadata tests**. The final privacy fix then passed **22 focused tests**, typecheck, and build. The 0.4.1 image passed the isolated replacement test described below, including its exact public stats fields.
- Publication review: Gitleaks **8.30.1** reported **zero findings** across the three-commit publication history; no actual operator home-directory paths were published. Local secrets, keyrings, journals, and host history were excluded.

The release adds persistent aggregate serving counts, homepage/operator count cards, `/api/v1/stats`, Markdown content negotiation and `/index.md`, public discovery catalogs and links, MCP server-card metadata, an agent skill index, `/auth.md`, and declarative WebMCP form annotations. The actual HTTP visit handler and four remote MCP tools remain the source of behavior; metadata does not invent authentication, payment processing, or browser support.

Live counters began at **2026-09-17T20:29:18.301Z**. The public smoke observed zero counts, then **2 cookies, 2 sauna sessions, and 3 teas** after its seven successful test visits. HTTP and MCP results remained equivalent, the operator ledger and known 15 PWR receipt passed, and indexing controls remained correct. These are test servings, not organic visitor counts. Earlier visits cannot be backfilled, and repeated or automated visits count again. The counter stores no visitor identities, seeds, preferences, or souvenir content. Evidence is `.local/mainnet/live-acceptance.json`.

SQLite uses `/data/visits.sqlite`, configured through `VISIT_COUNTS_PATH`, with a `/data` image volume and UID/GID `1000:1000`. The final isolated test replaced a 0.4.0 container with 0.4.1 on the same named volume and preserved all three counts and their start date. It verified exactly seven public stats fields, no stored visitor marker or signer artifacts, eleven discovery paths, three declarative forms, Markdown negotiation, and a real MCP handshake. The test ran with no external network, a read-only root filesystem, all capabilities dropped, no new privileges, and nano CPU/memory caps; peak memory for the replacement was **175,271,936 bytes**. Evidence is `.local/mainnet/counter-container-acceptance.json`. Fred's reviewed update contract preserves the canonical lease volume, but its live mount inventory and a subsequent production restart were not independently verified.

The external readiness rescan at **2026-09-17T20:29:58.748Z** improved from **20% (3/15)** to **67% (10/15)**, labeled **Level 4 / Agent-Integrated** by that scanner. New passes cover discovery links, Markdown negotiation, content signals, API catalog, MCP server card, agent skills, and ARD. Remaining checks cover DNS-AID, two OAuth endpoints, registration in `auth.md`, and imperative WebMCP detection. The service is public without OAuth or registration, and the scanner does not recognize its three valid declarative forms. This score is a particular scanner's result, not a guarantee of compatibility with every agent. Evidence is `.local/mainnet/agent-readiness-after.json` and `agent-readiness-comparison.json`.

The original lease remains `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`, and its launch evidence was preserved. A prior 0.4.0 image/journal was prepared but never deployed after a local check found unnecessary public configuration fields in the stats response. Version 0.4.1 fixed the response before production rollout. Retain that unattempted journal for recovery history; use [the existing-lease update runbook](MAINNET.md#release-041-and-existing-lease-update) for the running release.

## Historical mainnet launch, release 0.3.0

The initial mainnet launch passed full public acceptance at **2026-09-17T20:00:07.935Z** using release 0.3.0 and published SDK dependencies. The same lease and public domain now run 0.4.1 as verified above.

- Homepage: [merovingian.manifest.network](https://merovingian.manifest.network)
- Agent instructions: [visit.md](https://merovingian.manifest.network/visit.md)
- MCP Streamable HTTP: [mcp](https://merovingian.manifest.network/mcp)
- Operator dashboard: [hosting ledger](https://merovingian.manifest.network/operator)
- Chain: `manifest-ledger-mainnet`
- Tenant: `manifest1hkmrmsc6zjr7gm2wgtrtce7vgxeq9e402x5rf5`
- Lease: `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`, ACTIVE / provider ready
- Provider: `019e6a0d-e141-7000-9e79-e94ac1bd333e`
- Image: `ghcr.io/fmorency/merovingian@sha256:1020117aa543cbddcdbe0b49a671b09ddabb285a1f3af819d15ed3394d89f53b`

### DNS, HTTPS, and live application checks

Cloudflare serves a **DNS-only CNAME** from `merovingian.manifest.network` to the authenticated provider's native hostname, `refuge-928a176.barney0.manifest0.net`. Public resolvers `1.1.1.1` and `8.8.8.8` independently returned that CNAME and the same provider address, `64.29.115.30`. Normal TLS certificate verification succeeded for the native hostname and custom domain. A temporary public-DNS lookup bypassed a local negative DNS cache; certificate verification was never disabled. Certificate renewal has not yet been observed over a renewal cycle.

The mainnet smoke verified:

- Healthy release 0.3.0, correct mainnet chain identity, and `retired: false`.
- All three amenities over HTTP and a real MCP SDK client, with identical seeded results and mainnet-labeled souvenirs.
- Browser visits, downloadable souvenir markup, and agent instructions pointing to the permanent MCP origin.
- Indexable homepage metadata, the correct canonical URL, and a sitemap containing only public pages.
- An available, read-only operator ledger with `noindex`, plus matching mainnet contribution-history JSON.
- A nonexistent transaction returning pending without an invented receipt.
- The existing **15 PWR hosting deposit** returning matching confirmed HTTP and MCP receipts; no new acceptance payment was sent.

The acceptance evidence is `.local/mainnet/live-acceptance.json` and `.local/mainnet/dns-acceptance.json`. `indexingVerified` in the smoke report means the application's canonical/indexing controls passed; it does not claim that a search engine has indexed the site or that a public MCP registry submission has been made.

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
