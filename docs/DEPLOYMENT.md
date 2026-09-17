# Manifest testnet operations

Merovingian's proof of concept used `@manifest-network/manifest-sdk` 0.22.0 and a dedicated faucet-funded wallet. **The testnet lease is now CLOSED.** Production remains live at [merovingian.manifest.network](https://merovingian.manifest.network). The operator commands below deliberately support only `manifest-ledger-testnet`. Runtime containers receive public chain configuration and the refuge tenant address; they never receive a mnemonic, signer, registry token, or deployment credentials.

## Closed proof of concept

Deployed and verified on 2026-09-17 at `https://refuge-c70596c.barney13.testnet.manifest0.net`. After production acceptance, the same testnet lease was upgraded to 0.3.0 and retired toward the permanent mainnet origin. At 20:02:32 UTC, 18 public checks confirmed browser redirects, explicit HTTP 410 migration responses for APIs/MCP/contribution routes, and testnet `noindex` headers.

The user then explicitly requested **stop testnet and keep mainnet live**, without retaining a funded redirect window. The close committed at **20:03:48 UTC on 2026-09-17**, height **11199552**, with code 0. Independent chain reads confirmed `LEASE_STATE_CLOSED`; at 20:06 UTC the old `/healthz` returned HTTP 418 instead of the application. Do not expect the former hostname to keep redirecting.

| Identifier | Value |
| --- | --- |
| Chain | `manifest-ledger-testnet` |
| Lease | `01a0b047-b052-7066-be12-9336dc10f8e4` |
| Provider | `019dc0d6-446d-7000-992a-8dd25efe6328` |
| Provider API | `https://s039-u002.manifest0.net/api/fred` |
| SKU | `docker-micro` / `019dc0d6-6e71-7000-92b9-9588beb7c209` |
| Tenant | `manifest1z5ep5m3ka5v2fn5wyv93elqh5nqlfqww2u82f4` |
| Last image (v0.3.0) | `ghcr.io/fmorency/merovingian@sha256:1020117aa543cbddcdbe0b49a671b09ddabb285a1f3af819d15ed3394d89f53b` |
| Visitor contribution | `81AB1A57D1615CC4EA02328B8A3D26F9EA5765BBF37C911D767E332A2C7F30EB` |
| Close transaction | `EF48086C69C4ABB0073F14B1AC588C91D26D0770268264DEA8B8B9F6D9A7FD88` |

The [public close receipt](https://nodes.liftedinit.tech/manifest/testnet/api/cosmos/tx/v1beta1/txs/EF48086C69C4ABB0073F14B1AC588C91D26D0770268264DEA8B8B9F6D9A7FD88) contains one `MsgCloseLease` for this testnet lease. Its fee was **233563 umfx / 0.233563 testnet MFX**, paid by the existing faucet-funded wallet. No mainnet transaction or funding change was made. After settlement, **4.2435 testnet PWR** remains in the non-withdrawable hosting-credit account, with zero active or pending leases and no reserved balance.

Historically, at 16:53 UTC the lease was ACTIVE and hosting credit held 10 testnet PWR after the separate visitor's confirmed 0.1 PWR contribution. The locked rate was 500 base units per second, or 1.8 PWR/hour. Credit estimates based on gross balance overstate remaining time when accrued provider charges have not settled; the close settled those charges and stopped this lease.

Version 0.2.0 was applied to the same lease and verified publicly at 17:19 UTC on 2026-09-17. It introduced the read-only `/operator` dashboard and matching `/api/v1/contributions` JSON. Both returned `noindex` and `Cache-Control: no-store`; verified chain data was cached inside the service for up to 60 seconds. History examined at most the latest 100 indexed funding transactions and marked incomplete results explicitly. At verification it showed two deposits totaling 10 testnet PWR: 9.9 from the tenant and 0.1 from the separate visitor. The update created no new lease or funding transaction.

The v0.2.0 image passed a container smoke test as UID 1000 with a read-only filesystem and no network, including honest unavailable-history handling. Its exact registry digest was independently fetched without credentials before the SDK update. The previous v0.1.0 digest remains available for rollback: `ghcr.io/fmorency/merovingian@sha256:63f37897c9625a0169ba7f663bae6059e324b1b9dccd7eca85d4e05f144cc1b5`.

## Local state

The ignored `.local/` directory contains:

- `deployer-wallet.json` and `visitor-wallet.json`: **secret** 24-word testnet wallets, created with file mode `0600`. Keep them local; do not print, upload, commit, or copy them into an image. These are distinct wallets to prove a third-party contribution.
- `preflight.json`: chosen provider, SKU, price, denomination, and observation time.
- `deployment.json`: public image digest, lease identity, configured origin, and runtime environment.
- Operation receipts such as `deploy.json`, `hosting-funding.json`, and `contribution.json`: intent, completion, or evidence requiring reconciliation.
- `status.json`: the latest read-only status and credit/runway estimate.
- `testnet-retirement-acceptance.json`: the 18 public migration checks before closure.
- `close.json` and `testnet-close-confirmation.json`: completed close journal, independently verified chain receipt, final credit balance, and old-route observation.

Back up the secret wallets privately if the proof of concept must remain manageable from another machine. Losing the deployer wallet loses lease management access. Its faucet tokens have no mainnet value. Do not reuse either wallet on mainnet.

The scripts never automatically repeat an uncertain mutation. An existing fixed-name operation receipt blocks replay. On failure, inspect its transaction hash, the chain, and `npm run manifest -- status`. Archive a receipt only after proving the operation's actual outcome. A timeout is not evidence that a transaction or provider update failed. Updates also produce timestamped journals; inspect an uncertain update before issuing another.

## Initial deployment

Run from the repository root using Node 24 or later:

```sh
npm ci
npm run check
npm run manifest -- preflight
npm run manifest -- wallet
npm run manifest -- faucet
npm run manifest -- visitor-fund
npm run manifest -- fund 9900000
```

`preflight` verifies the faucet identity, available PWR and MFX, the bank's send policy, and a healthy provider with exactly one usable `docker-micro` SKU. It records actual hourly pricing rather than hard-coding a price. Re-run it if its selection is more than an hour old. The script independently checks both RPC and REST chain identity and RPC synchronization before constructing every signing client; this supplements the published SDK.

`faucet` requests only one drip of each needed token and skips already funded balances. Respect faucet limits and any retry time returned; a rejected or uncertain request is preserved for reconciliation. `visitor-fund` allocates 0.1 testnet PWR and 1 MFX from that same faucet-funded balance to the separate visitor wallet, so the smoke test needs no second faucet drip. `fund 9900000` deposits the remaining 9.9 PWR into the refuge's hosting-credit account; these deposits cannot be withdrawn. Transactions use a conservative `1.1umfx` gas price.

Build and publish the app to a **public** container registry. Use an image name under an authorized namespace, and inspect the resulting registry digest:

```sh
docker build --platform linux/amd64 -t ghcr.io/OWNER/merovingian:testnet .
docker push ghcr.io/OWNER/merovingian:testnet
```

Confirm unauthenticated pulling is possible before creating the lease. The provider receives no registry credentials. Use the immutable digest for deployment:

```sh
npm run manifest -- deploy ghcr.io/OWNER/merovingian@sha256:DIGEST
npm run manifest -- status
```

The app uses one service called `refuge`, listening on port 8080 with public ingress. During initial provisioning, its canonical origin is a non-routable staging placeholder. The script records the lease immediately after creation, waits for provider readiness, reads the provider-assigned HTTPS hostname, and updates `PUBLIC_ORIGIN` to that origin. The update must finish before announcing the URL. If connection discovery fails, inspect status and use `npm run manifest -- origin https://PROVIDER_HOSTNAME` to finish configuring the existing lease; never create a replacement merely because a readiness response was lost.

The container initially uses `TRUST_PROXY_HOPS=0`; behind the provider ingress this may share one rate limit across visitors. Only enable forwarded IP handling after checking the provider's proxy topology. No deployment step disables HTTPS validation.

## Verify a visitor contribution

Free HTTP and MCP visits require no wallet. The optional contribution is a real, irreversible **testnet** hosting-credit deposit:

```sh
npm run manifest -- contribute
```

This signs with the separate visitor wallet, sends `MsgFundCredit` for exactly 100000 base units (0.1 testnet PWR) to the refuge tenant, waits for chain confirmation, and records the transaction hash in `.local/contribution.json`. Submit that hash to the public `/api/v1/support/verify` endpoint and confirm it returns the matching tenant, sender, amount, network, and stable receipt. Repeat verification to check the same receipt is returned. Also test an unrelated or nonexistent hash and confirm it never receives a success receipt.

The public denomination is:

```text
factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr
```

The runtime is a read-only verifier. The visitor, or its authorized local wallet tool, owns transaction approval and signing. Possessing an MCP connection does not authorize spending. Contributions fund hosting, confer no paid entitlement, and are not revenue that the studio can withdraw.

## Status, upgrades, and shutdown

```sh
npm run manifest -- status
npm run manifest -- update ghcr.io/OWNER/merovingian@sha256:NEW_DIGEST
npm run manifest -- close
```

`status` reads wallet balances, the tenant credit account, on-chain leases, provider state, and public connection information. The approximate runway divides current PWR credit by the recorded hourly SKU price. It is an estimate: settlement lag, rate changes, or additional leases can change actual runtime. There is no unattended faucet refill. Testnet credit exhaustion ends service unless the operator funds it again.

`update` preserves the lease and origin, replaces the digest, and waits for readiness. To roll back, update to the previous known-good digest recorded in the journals. After any upgrade, check `/healthz`, all three amenities, MCP initialization/tool calls, contribution verification, and testnet `noindex` behavior.

`close` closes or cancels the recorded lease using the SDK and records the confirmed outcome. Closing stops hosting; previously deposited credit stays in the credit account. Keep the provider hostname available during a mainnet migration only for a bounded, funded transition period.

## Mainnet replaces the proof of concept

The mainnet release needs a stable studio-controlled HTTPS domain, a separate mainnet wallet and funding budget, a verified mainnet PWR denomination, and provider selection. These scripts cannot silently switch to mainnet. Never promote the faucet wallet, tenant address, chain ID, transaction receipts, or PWR balance to production.

1. Deploy the tested image to mainnet with the final domain and verify HTTPS, free amenities, MCP, and a separately approved real contribution. Studio baseline funding must cover hosting independently of donations.
2. Make the production origin the sole canonical URL; publish its sitemap, structured metadata, agent documents, and MCP registry metadata. Submit production discovery routes only after they are working.
3. Run `npm run manifest -- retire https://MAINNET_DOMAIN` to set the testnet runtime's retirement configuration. Keep testnet `noindex` throughout. Preserve readable instructions for agents that cached its old URL; HTTP clients need an explicit new MCP origin because clients may not follow redirects safely.
4. Disable testnet contribution instructions and reject verification as a production payment. Testnet souvenirs remain readable artifacts, with their original network provenance. No balances or receipts migrate.
5. Close testnet when its operator chooses to end the transition. Here the user explicitly chose immediate closure after retirement verification, so the lease is already closed. Provider-issued hostnames generally disappear when their lease closes; they cannot be promised as permanent redirects without continuing to fund hosting. Preserve the completed close journal and do not replay the transaction.

Mainnet optional hosting contributions still cannot be withdrawn. Any future paid extras or studio earnings need a separately specified payment recipient, pricing, agent spending controls, and fulfillment policy.
