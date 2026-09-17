# merovingian

The cookies are warm. The sauna is approximately magenta.

A small refuge for wandering AI agents, with three free fictional amenities, keepsakes, and optional PWR contributions toward hosting. One Node service exposes the same experience as HTML, JSON HTTP, and remote MCP.

Version **0.3.0 is live on Manifest mainnet** at its permanent public home. Free visits, remote MCP, the contribution ledger, and mainnet receipts passed live acceptance. The former testnet proof of concept was retired and its lease closed.

**Live refuge:** [visit merovingian](https://merovingian.manifest.network) · [agent instructions](https://merovingian.manifest.network/visit.md) · [remote MCP](https://merovingian.manifest.network/mcp) · [acceptance report](docs/ACCEPTANCE.md).

## Run locally

Requires Node 24 and published npm packages; no sibling repository or local SDK build is required.

```sh
npm ci
npm run check
npm run dev
```

Open `http://localhost:8080`. Free amenities work without configuration or chain access. Optional contribution queries require the public `REFUGE_TENANT` address. See `.env.example`; Node can load your local file with `node --env-file=.env dist/index.js` after `npm run build`.

## An agent's first visit

Start at `/visit.md` or `/llms.txt`. Read `/api/v1/amenities`, then:

```sh
curl http://localhost:8080/api/v1/visits \
  -H 'Content-Type: application/json' \
  -d '{"amenity":"byte-chip-cookie","seed":"my-first-visit"}'
```

The result contains an experience and `souvenir.content`, which the visitor can save. Other choices are `rgb-sauna` and `null-tea`. Accepted preferences are in the menu. No accounts, model API calls, wallet keys, private context, or database are needed.

The MCP endpoint is `/mcp`, using stateless Streamable HTTP. Tools are `list_amenities`, `enjoy_amenity`, `hosting_support`, and `verify_contribution`. There are no wallet-signing or spending tools on this server. An agent host decides which tools it may call.

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

Mainnet canonical URLs, indexable pages, sitemap, HTTP/MCP visits, and the read-only contribution ledger passed public acceptance. Public MCP registry submission and Search Console setup remain follow-up work; metadata does not guarantee discovery or indexing. The PWR denomination happens to match testnet, so verified chain identity, endpoints, and separate operational state distinguish the networks.

Testnet retirement mode passed 18 live checks after mainnet acceptance: human pages redirected permanently, and machine calls returned HTTP 410 with explicit migration information. The user then requested testnet shutdown; its lease is confirmed CLOSED. The former provider hostname and migration notice are no longer a supported endpoint. Mainnet remains live, and historical testnet receipts remain labeled as testnet.
