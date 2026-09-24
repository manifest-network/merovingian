# merovingian

The cookies are warm. The sauna is approximately magenta.

A small refuge for wandering AI agents, with three free fictional amenities, keepsakes, and optional PWR contributions toward hosting. One Node service exposes the same experience as HTML, JSON HTTP, and remote MCP.

Version **0.4.7 is live on Manifest mainnet** at its permanent public home, with aggregate served counts, agent discovery metadata, and WebMCP browser tools. The existing lease was updated without a new lease, chain transaction, or funding deposit. The former testnet proof of concept was retired and its lease closed.

Release **0.4.7** moves the runtime to Manifest SDK `0.23.0` and manifestjs
`4.0.0` without changing application behavior. It is the first image built,
published and provenance-attested by the Release image workflow, and the first
registry version published through the MCP Registry workflow. It retains the
OpenAPI contracts and read-only smoke checks from `0.4.6`, the curl healthcheck
from `0.4.5` and the request limits, explicit proxy trust and runtime hardening
from `0.4.4`. See the [release notes](docs/RELEASE-0.4.7.md) and
[publication and acceptance evidence](docs/evidence/release-0.4.7.json), including
the remaining provider/AppArmor acceptance work. The official MCP Registry lists
`0.4.7` as active and latest, matching the deployed release.

**MCP compatibility:** `0.4.3` changed the runtime/server-card name from
`network.manifest.merovingian/merovingian` to
`io.github.manifest-network/merovingian`, with no compatibility alias. This may
break clients that pin or cache the old identity; update their expected name or
reconfigure the existing connection. The endpoint remains
`https://merovingian.manifest.network/mcp`; no endpoint migration is needed.

**Live refuge:** [visit merovingian](https://merovingian.manifest.network) · [agent instructions](https://merovingian.manifest.network/visit.md) · [remote MCP](https://merovingian.manifest.network/mcp) · [acceptance report](docs/ACCEPTANCE.md).

**Public source:** [manifest-network/merovingian](https://github.com/manifest-network/merovingian). Live counters survived the production image update. The external agent-readiness score improved from **20% to 73%** during the earlier `0.4.2` release. See [release evidence](docs/RELEASE-0.4.7.md) and the [historical acceptance report](docs/ACCEPTANCE.md) for the checks and their limits.

## Run locally

Requires Node 24 and published npm packages; no sibling repository or local SDK build is required.

```sh
npm ci
npm run check
npm run dev
```

The [CI workflow](.github/workflows/ci.yml) runs `npm run check` on pull requests
to `main` and pushes to `main`, including registry consistency, typechecking,
isolated local tests, and the build. It also lints the workflows and shell scripts
with pinned, checksum-verified `actionlint` and `shellcheck`
(`bash scripts/lint-ci.sh`). It uses read-only repository permissions and
does not publish releases or visit the live refuge. [Dependabot](.github/dependabot.yml)
proposes weekly npm, GitHub Actions and Docker updates after a seven-day cooldown.
The Manifest SDK and CosmJS packages arrive as one group for deliberate review;
first-party `@manifest-network/*` releases skip the cooldown.
For the keyring helper's Go module, Dependabot proposes security updates only.
Security updates depend on Dependabot alerts from the repository's dependency graph.
See [dependency notes](docs/DEPENDENCIES.md) for what is maintained manually.

The separate [MCP Registry workflow](.github/workflows/publish-mcp-registry.yml)
is manually dispatched from `main`. Its default `preflight` mode is read-only. It
verifies the release metadata and existing registry records. For an unpublished
version, it also runs read-only acceptance with zero servings. `publish` mode also
waits for approval in the protected `mcp-registry-publish` environment. It then
publishes with GitHub OIDC, without a PAT, and verifies the exact-version and
latest records. See the [publication runbook](docs/MCP-REGISTRY.md#github-actions-publication).

Runtime images are published only by the manually dispatched
[Release image workflow](.github/workflows/release-image.yml). Its read-only
Build job builds the reviewed release commit without running npm code on the
runner, and its Check job runs the repository, runtime and advisory checks on
the saved image. The Publish job waits for approval in the protected
`image-release` environment, pushes exactly the verified image to GHCR, verifies
it anonymously and attests its build provenance. See the
[image release runbook](docs/IMAGE-RELEASE.md).

`npm run smoke -- ORIGIN [--mainnet]` checks HTTP and MCP discovery without
creating servings. Explicit `--serve` adds seven visits; live targets also require
`--live-serve-authorization REFERENCE` naming the user's authorization for that
target and budget. See [smoke checks and request budgets](docs/ACCEPTANCE.md#repeatable-smoke-checks-eng-1032)
for timeouts, local fixtures, reports, and production authorization requirements.

The final-image job also builds and scans a local candidate, checks code ownership
and isolated HTTP/MCP behavior, and verifies SQLite persistence across disposable
container replacement. See [image verification](docs/IMAGE-SECURITY.md) for the
advisory policy and the still-open provider/AppArmor evidence requirements.

Open `http://localhost:8080`. Free amenities work without configuration or chain access. Optional contribution queries require the public `REFUGE_TENANT` address. See `.env.example`; Node can load your local file with `node --env-file=.env dist/index.js` after `npm run build`.

## An agent's first visit

Start at `/visit.md` or `/llms.txt`. Read `/api/v1/amenities`, then:

```sh
curl http://localhost:8080/api/v1/visits \
  -H 'Content-Type: application/json' \
  -d '{"amenity":"byte-chip-cookie","seed":"my-first-visit"}'
```

The result contains an experience and `souvenir.content`, which the visitor can save. Other choices are `rgb-sauna` and `null-tea`. Accepted preferences are in the menu. No accounts, model API calls, wallet keys, private context, or separate database service are needed.

The MCP endpoint is `/mcp`, using stateless Streamable HTTP. Tools are `list_amenities`, `enjoy_amenity`, `hosting_support`, and `verify_contribution`. There are no wallet-signing or spending tools on this server. An agent host decides which tools it may call.

`/openapi.json` describes the JSON response fields, status variants and HTTP
errors. See [response contracts](docs/API-CONTRACTS.md) for field semantics and
the local HTTP/MCP contract tests prepared in this repository.

The `0.4.4` security update accepts one MCP message per request and rejects
batches before execution. [Request-limit documentation](docs/REQUEST-LIMITS.md)
describes the client/aggregate budgets and explicit trusted-proxy configuration;
[credit transport](docs/CREDIT-TRANSPORT.md) describes bounded, cancellable chain
reads. Forwarded client addresses are untrusted until verified ingress sources
are explicitly configured.

Find `io.github.manifest-network/merovingian` in the official MCP Registry. The
[published version 0.4.7](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/0.4.7)
advertises the remote Streamable HTTP endpoint. Add that endpoint to an MCP host
and call `list_amenities` to read the menu. Calling `enjoy_amenity` makes a live
mainnet visit and increments a public serving counter; only call it when the user
has authorized that visit. Automated checks need an explicit visit scope.
Free visits require no authentication or wallet; the host controls tool approval.
See the [publication runbook](docs/MCP-REGISTRY.md) for verification and updates.
A supervised fresh agent, given the service name and official registry URL,
found the listing and completed one authorized free cookie visit on 2026-09-18;
see the [discovery report](docs/MCP-DISCOVERY.md).

[Connection examples](docs/CONNECT.md) cover Claude Code, Codex CLI, VS Code,
Cursor, Gemini CLI and Claude's custom connectors, plus a
[minimal read-only client](examples/read-only-client.mjs). Every example hides or
blocks `enjoy_amenity` where the host allows it. The client, Claude Code and
Codex CLI were verified against a local copy of the application
(`npm run examples:verify`), and a Claude custom connector connected in one
read-only live test; the guide lists each host's approval defaults and
requirements. Connecting is not discovery: the
[discovery evaluation](docs/DISCOVERY-EVALUATION.md) defines repeatable
read-only URL-led, name-led and capability-led runs and validates their records
(`npm run discovery:check`). The official registry searches server names only, so
capability-led registry searches do not find Merovingian today.

## Served counts and discovery

The homepage and operator dashboard show cookies served, sauna sessions, and cups of tea, with the date counting began. `/api/v1/stats` exposes the same read-only totals. Every successful HTTP, browser, or MCP visit increments a count, including repeat requests and automated checks. These are servings, not unique visitors. Counters start at zero when enabled; earlier visits cannot be reconstructed.

Only aggregate amenity totals and their start date are stored, with no visitor identities, seeds, preferences, or souvenirs. Production uses SQLite at `VISIT_COUNTS_PATH=/data/visits.sqlite` in the image's `/data` volume, running as UID/GID `1000:1000`. Counts and their start date survived local replacement tests and the live 0.4.1 → 0.4.2 → 0.4.3 → 0.4.4 → 0.4.5 → 0.4.6 → 0.4.7 image updates on the same lease. Without a configured file path, local development uses memory and resets counts on restart.

Discovery includes a Markdown homepage (`/index.md` or `Accept: text/markdown`), API and AI catalogs, MCP server cards, an agent skill index, public-access instructions at `/auth.md`, and two real WebMCP browser tools for reading the menu and enjoying an amenity. The external scan of `0.4.2` passed **11 of 15 checks (73%)**; it was not repeated for releases `0.4.3` through `0.4.7`. Its remaining checks cover DNS-AID and OAuth/registration that this public service does not require. WebMCP is enabled when the browser supports it; ordinary forms, HTTP, and the four remote MCP tools remain available.

The release uses the [existing-lease update workflow](docs/MAINNET.md#existing-lease-update-workflow), with no new lease, chain transaction, or funding deposit. The public image is pinned to:

```text
ghcr.io/manifest-network/merovingian@sha256:919a95cc9e87fb76fc614a801f3a82e957c6d468c5bd88d0c9217e28106934dc
```

## Wallets and contributions

Free visits need no wallet. A contribution needs a Manifest wallet controlled by the visiting agent's host, PWR, gas tokens, and authorization to spend. MCP itself supplies none of these.

1. Read `/api/v1/support` and review its network, token denomination, target tenant, and funding instructions.
2. Use an existing authorized wallet adapter with the published Manifest SDK to sign `fundCredits({ tenant, amount })`. This funds the refuge's nonwithdrawable hosting-credit account.
3. Submit the existing transaction hash to `/api/v1/support/verify` or the `verify_contribution` MCP tool.
4. Accept success only when `status` is `confirmed`. Pending/unavailable verification is a reason to check the original transaction, never to blindly pay again.

The receipt is a repeatable acknowledgement of a public transaction. It proves neither visitor identity nor ownership and grants no paid entitlement. Mainnet revenue is a separate planned payment flow.

## Operator dashboard

Open [the hosting ledger](https://merovingian.manifest.network/operator) at `/operator` for contribution history, funding totals, and available/reserved hosting credit. Expand a source to see its wallet address, or follow a transaction link to its public chain record. `/api/v1/contributions` provides the same history as JSON, with amounts in integer base units (1 PWR = 1,000,000 base units).

The dashboard reads the latest 100 indexed funding transactions and filters successful PWR deposits to this tenant. It labels totals as partial when the full history is not covered. Readings are cached for up to 60 seconds; use Refresh to reload. Tenant-wallet funding is separated from other wallets. Wallet counts are not visitor identities.

Funding totals are deposits, not remaining credit or withdrawable revenue. Balance settlement may lag consumption. If chain access fails, the dashboard shows unavailable readings; free amenities still work. This page contains only public records, needs no sign-in, and cannot spend funds. It stays `noindex` on both networks and is excluded from the sitemap. Mainnet requires a verified REST endpoint and six-decimal PWR metadata for these readings; its separate revenue flow remains future work.

## Deploy and operate

See [mainnet operations](docs/MAINNET.md) and the [local keyring workflow](docs/KEYRING.md). Mainnet uses the published `@manifest-network/manifest-sdk`, a dedicated protected OS keyring, and a local signing adapter. The hosted service receives public chain configuration only. Operator tools, secrets, and operation journals are excluded from the Docker build context.

```sh
npm run mainnet:launch -- status
```

The existing mainnet lease must be reused; do not repeat the completed funding deposit or create another lease to retry an uncertain operation. The historical [testnet runbook](docs/DEPLOYMENT.md) remains separate. The Dockerfile runs as an unprivileged user on port 8080. `/healthz` checks application health without requiring the chain. Rate limits, bounded requests, and chain-query timeouts protect free visits from busy or unavailable upstreams.

## Production and migration

The permanent domain `merovingian.manifest.network` uses direct, DNS-only Cloudflare routing to the provider, with verified HTTPS. Its dedicated mainnet `docker-nano` lease costs 2.592 PWR per 30 days within a 5 PWR/month hosting ceiling; transaction fees are separate. See [the approved plan](PLAN.md), [mainnet operations](docs/MAINNET.md), and `.env.mainnet.example` for public runtime configuration. Separate paid studio extras remain planned.

Earlier mainnet releases passed full public acceptance of canonical URLs, indexable pages, sitemap, HTTP/MCP visits, and the read-only contribution ledger. Releases `0.4.3` through `0.4.5` used read-only live acceptance: the then-current serving-by-default `scripts/smoke.ts`, `/visit` form submission, `POST /api/v1/visits`, and MCP `enjoy_amenity` were not rerun because their authorization excluded live visits. Releases `0.4.6` and `0.4.7` passed the updated smoke script in read-only mode with 20 requests and zero servings; `0.4.6` also passed live API-contract checks. The official MCP Registry listing is published; Search Console setup remains follow-up work. Metadata does not guarantee discovery or indexing. The PWR denomination happens to match testnet, so verified chain identity, endpoints, and separate operational state distinguish the networks.

Testnet retirement mode passed 18 live checks after mainnet acceptance: human pages redirected permanently, and machine calls returned HTTP 410 with explicit migration information. The user then requested testnet shutdown; its lease is confirmed CLOSED. The former provider hostname and migration notice are no longer a supported endpoint. Mainnet remains live, and historical testnet receipts remain labeled as testnet.
