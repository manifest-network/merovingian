# Local keyring operator workflow

Merovingian uses a temporary adapter to connect a protected `manifestd` OS keyring to the published `@manifest-network/manifest-sdk@0.22.0`. No browser wallet connection is needed. The production key's protected OS copy passed the local compatibility proof after the user imported it locally. The intended upstream replacement is [ENG-1012 — SDK: reuse existing manifestd keyrings for transaction and provider signing](https://linear.app/liftedinit/issue/ENG-1012/sdk-reuse-existing-manifestd-keyrings-for-transaction-and-provider).

The adapter consists of the Linux [native helper](../tools/keyring-signer/README.md) and [`scripts/keyring-wallet.ts`](../scripts/keyring-wallet.ts). The helper uses the published `github.com/manifest-network/cosmos-sdk@v0.50.14-liftedinit.1` fork matching the installed CLI. It reads the existing named key through Cosmos keyring APIs and supports public-key lookup, direct transaction signatures, and ADR-036 arbitrary-message signatures. It does not export keys, broadcast transactions, or serve a network API.

## Security boundaries

Production operator commands accept only the `os` backend and require an explicit key name and existing keyring root. They bind the returned public key to the configured `manifest1…` tenant. Direct signatures require the configured chain ID, currently `manifest-ledger-mainnet`. The Node adapter independently verifies every returned signature with Node/OpenSSL.

A software OS keyring supplies key material to the native helper's memory for signing; this is not a hardware wallet. No private key or mnemonic is exported, copied into the project, returned to Node, or passed to the JavaScript SDK. The helper takes no passphrase through its protocol. If the OS store is locked, unlock it through the local operating-system tools and retry. Do not paste credentials into chat or put them in arguments, public configuration, or application environment variables. The helper's insecure `test` backend is solely for disposable test fixtures and is rejected by the production commands.

The subprocess uses argument arrays without a shell, an environment allowlist, bounded input/output, and a timeout. Native diagnostics are suppressed; operator errors are sanitized. Before key access, the Linux helper requires both a zero core-dump resource limit and disabled process dumpability, failing closed if either cannot be set. The check, preview, and launch retain no provider tokens or signatures.

The [build-context allowlist](../.dockerignore) excludes `scripts/`, `.local/`, environment files and `tools/keyring-signer/`. Its only exception under `tools/` is `tools/healthcheck.sh`, the curl wrapper copied into the runtime image. The rules reopen `tools/`, exclude its descendants with `tools/**`, then allow that one file; their ordering preserves the signer exclusion. The public service contains no keyring adapter or wallet credentials. See [DEPENDENCIES.md](DEPENDENCIES.md) for published-module pins, the JOSE dependency fix, and vulnerability-scan limitations.

ADR-036 uses the SDK-compatible fixed envelope with an empty chain ID, zero account/sequence and fees, and one `sign/MsgSignData` message. The published provider token format itself does not bind the chain or HTTP operation. The launch tool binds requests to the verified mainnet provider and intended lease, keeps tokens in memory, and lets the SDK construct its payloads. Its transport permits only the pinned provider origin and required routes, rejects redirects, and uses the SDK's DNS/IP guard. The helper is a signing interface; the operator must still approve the exact transaction messages, fees, and spending scope.

## Build and verify locally

The initial production-key check stopped before signing: the default CLI lookup found `merovingian` in the configured `test` backend, while an explicit `os` lookup failed. The test backend uses a publicly known password and does not provide suitable protection for real funds. After the user imported the same key into a protected OS store locally, the hardened helper verified that copy and its address. The user confirmed a secure recovery backup and explicitly authorized deletion of only the old named `merovingian` test-backend key; removal was verified, and the OS proof passed again at **2026-09-17 19:28:29 UTC**. The CLI default remains `test`, so production commands continue to select `os` explicitly and never fall back. Unlock the protected store locally when needed. Do not export or copy private key material into the repository or send it through chat.

Run from the repository root using the project's Node.js dependencies and Go 1.26 or later. The reviewed helper used go1.27.1, and the build sets `GOTOOLCHAIN=local` so an older Go fails instead of downloading a toolchain:

```sh
npm run keyring:build
```

The build uses pinned published modules and `go.sum`, sets bounded build concurrency, keeps caches and temporary files under `.local/`, and writes `.local/mainnet/bin/keyring-signer` with owner-only executable permissions. It does not open a wallet. Source tests use a widely published test mnemonic and disposable fixtures; they must never hold real assets.

Set the public keyring location to the same root used by `manifestd`: its `--keyring-dir` when configured, otherwise its `--home`. Replace the example path with that existing directory; do not create a new keyring or copy key files here.

```sh
MEROVINGIAN_KEYRING_HOME="/absolute/existing/keyring/root"
npm run keyring:check -- \
  --helper "$PWD/.local/mainnet/bin/keyring-signer" \
  --home "$MEROVINGIAN_KEYRING_HOME" \
  --keyring-backend os \
  --key-name merovingian
```

The check reads the configured public tenant from `.local/mainnet/config.json`, verifies its public key, and signs a fresh random local challenge outside the provider's authentication formats. It makes no network request, creates no provider token, and signs no transaction. The challenge and signature are neither printed nor saved. A successful run writes `.local/mainnet/keyring-check.json` with the public address, helper/public-key hashes, and verification status. That evidence proves local compatibility only; it does not establish acceptance by a live provider or authorize deployment.

## Prepare an unsigned deployment preview

Refresh the public network quote immediately before previewing. The public-account path needs no local keyring or signer:

```sh
npm run mainnet -- preflight
npm run mainnet -- plan
npm run mainnet:preview -- --public-account
```

This path reads the configured account from the official mainnet endpoints, verifies RPC/REST chain identity, and checks that its on-curve secp256k1 public key derives the expected address. It never imports the keyring adapter or opens a local wallet. It requires an on-chain public key, which is available after an account has signed a committed transaction.

After the protected OS key is available, the same preview can instead obtain public account data from it:

```sh
npm run mainnet:preview -- \
  --helper "$PWD/.local/mainnet/bin/keyring-signer" \
  --home "$MEROVINGIAN_KEYRING_HOME" \
  --keyring-backend os \
  --key-name merovingian
```

The preflight and plan commands read no wallet secrets. Both preview paths give the published SDK an isolated wallet whose signing methods always throw. The SDK sends unsigned simulation queries to the verified mainnet RPC; it does not broadcast or authenticate with the provider.

The preview rebuilds the manifest from allowlisted public configuration and the immutable image digest. It saves `.local/mainnet/deployment-preview.json`, containing the exact manifest/hash, unsigned lease message, estimated lease-creation fee, and a custom-domain template. The preview checks the fresh quote, selected nano SKU, funded credit, wallet fee balance, and a gas ceiling. Simulation does not authorize spending.

Before lease creation commits, the custom-domain template uses an explicit placeholder. Its actual fee must be freshly simulated after the real lease UUID exists. For the completed launch, the committed fees are recorded below. The already completed 15 PWR credit deposit must not be repeated. Cloudflare must remain DNS only for `merovingian.manifest.network`.

## Launch and resume with the protected key

Before the first launch, the CLI prepares its own fresh quote and unsigned simulation without a local wallet. The existing deployment should now be inspected with `status`; `prepare` refuses an existing launch state:

```sh
npm run mainnet:launch -- prepare
npm run mainnet:launch -- status
```

The proposal is `.local/mainnet/launch/proposal.json`, containing the exact tenant, chain, provider, nano SKU, immutable image, manifest hash, hosting rate, and estimated creation fee. `status` performs public read-only network reconciliation and may save recovered transaction receipts in the local journals; it never loads the keyring, signs, broadcasts, or creates a provider token. The same `run` command recovers a missing lease UUID into launch state when needed. The user approved the **0.5 PWR total transaction-fee cap**, and the completed launch consumed **0.158206 PWR**. Mainnet lease `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd` is ACTIVE / ready and passed public custom-domain acceptance.

To resume that existing launch, keep the same approved cap, verified helper, and protected keyring:

```sh
npm run mainnet:launch -- run \
  --helper "$PWD/.local/mainnet/bin/keyring-signer" \
  --home "$HOME/.manifest" \
  --key-name merovingian \
  --max-total-fee-pwr 0.5
```

Use the actual existing keyring root if different; the helper path must be absolute. The command requires a matching successful `keyring-check.json` and helper digest, and hardwires `os` with no fallback. Unlock the store locally if required. No password or private-key argument is accepted. Changing the helper requires rebuilding and repeating the harmless compatibility check before execution.

The cap is an aggregate ceiling for creation and domain-claim transaction fees, not an amount to deposit or necessarily spend. Fresh simulations determine each fee; failed and uncertain transactions conservatively reserve their recorded fees against the total. The CLI refuses more than 1 PWR, and an existing launch cannot silently change its cap. Hosting remains separately bounded by the configured 5 PWR monthly plan. **Do not repeat the completed 15 PWR credit deposit.**

Execution creates `.local/mainnet/launch/state.json` and `launch/transactions/` records. It writes and syncs an intent before signing, independently verifies the signed envelope, then writes and syncs the transaction hash before one broadcast. Journals contain public intent fingerprints, account sequence, fees, hashes, and receipts. Private keys, signatures, signed transaction bytes, arbitrary provider responses, and bearer tokens are not saved. Runtime environment values are rebuilt from the public configuration allowlist; the helper environment and local filesystem are never copied into the provider payload.

Resume using the **same `run` command and cap**. A recorded transaction is reconciled by its existing hash and never automatically signed or broadcast again. If a crash occurs after lease commitment but before the lease UUID is saved in launch state, the receipt and verified on-chain lease recover that identity. Once an upload was started or became uncertain, resume checks provider status for the matching received payload; it does not repeat the POST blindly. An unconfirmed transaction, intent without a hash, or inconclusive upload stops for local review. A readiness timeout does not authorize another lease, an automatic close, an update, or a restore.

A crash may leave `launch/run.lock` or a transaction `.lock`. Review the recorded PID and actual process identity locally, then inspect the journals and chain state. Remove only a lock confirmed to belong to a dead operator process, and retain every journal and launch-state file. Never clear a live lock or delete state to make a transaction run again. The same command resumes after a reviewed stale lock is removed; uncertain state still fails closed.

The completed launch followed the published SDK order: create lease, claim the custom domain for `refuge`, upload the exact hashed manifest, and poll readiness. Fred keeps the native instance FQDN separately from the custom domain. The authenticated connection response supplied **`refuge-928a176.barney0.manifest0.net`** for Cloudflare's verified **DNS-only / gray-cloud CNAME**. Launch state remains `awaiting-dns`, the CLI's last provider-upload phase; the CLI neither modifies DNS nor records later acceptance. Public DNS, normal TLS, HTTP/MCP, indexing, and the existing funding receipt passed in `.local/mainnet/dns-acceptance.json` and `.local/mainnet/live-acceptance.json`. See [MAINNET.md](MAINNET.md#cloudflare-and-launch-sequence). Testnet retirement behavior subsequently passed 18 checks, then its lease was confirmed CLOSED at **20:03:48 UTC** following the user's separate shutdown instruction. Mainnet remains live.

Later updates use the SDK's `updateApp` on the same ACTIVE lease; rollback reapplies the previous pinned manifest. `restoreApp` instead uses a closed lease's retained data to create a new lease, incurs new fees/reserve, and does not restore custom domains. Neither operation is part of this launch command or automatically authorized by its fee cap.

## Verification status

The Go tests and the public-fixture integration through the Node adapter also run
in CI on every pull request and push to `main` (the **Keyring helper** job). They
use disposable public fixtures only, access no production keyring, make no
network requests and upload no artifacts. A CI build is not the reviewed
operator helper; see the [helper README](../tools/keyring-signer/README.md).

The helper build, Go fixture checks, and native Node/helper integration through the published SDK passed using only the public disposable fixture. Integration evidence is `.local/mainnet/keyring-fixture-check.json`. The initial production OS-keyring check refused to fall back to the insecure test backend. After the user's local protected import, the hardened helper's production proof passed at **2026-09-17 19:25:17 UTC**, and again at **19:28:29 UTC** after the authorized old-copy cleanup. `.local/mainnet/keyring-check.json` records the expected tenant match, independently verified ADR-036 signature, and helper digest `721fc4cdde962d12d998739a8f466730398048c0504e86ff671129de023189ee`. That proof signed no transaction, made no network request, created no provider token, and retained neither challenge nor signature. Live provider authentication was subsequently verified by the successful authorized mainnet upload and status/connection requests.

The live mainnet `--public-account` preview passed on **2026-09-17** without local key access, signing, or broadcasting. `.local/mainnet/deployment-preview.json` records the historical **0.07894 PWR** lease-creation estimate and rejected domain placeholder; its **19:33:49 UTC** quote has expired. A fresh launch proposal and explicit approval preceded the actual transactions. Creation committed at height **8560840** for **0.078940 PWR**; the domain claim committed at **8560841** for **0.079266 PWR**, totaling **0.158206 PWR** within the approved 0.5 PWR cap. Both public receipts and hashes are under `.local/mainnet/launch/transactions/` and listed in [MAINNET.md](MAINNET.md#completed-mainnet-launch). Provider status was ACTIVE / ready at **19:51:12 UTC**. Custom-domain acceptance passed at **20:00:07 UTC**, using the original 15 PWR funding transaction for contribution verification; no additional deposit or payment was made. Standard certificate checks passed; a temporary public-DNS lookup bypassed only a local negative DNS cache. The expanded suite passed 114 tests before launch, followed by 10 focused provider tests and typecheck after the routing-target suffix adjustment.
