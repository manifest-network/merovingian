# Published dependencies

JavaScript dependencies come from npm and are pinned by `package-lock.json`. The application does not import, link, or build any local Manifest checkout. SDK version: `@manifest-network/manifest-sdk@0.23.0`; generated messages: `@manifest-network/manifestjs@4.0.0`. The operator-only native helper uses pinned published Go modules as described below.

The published SDK differs from the development checkout. Runtime contribution verification explicitly checks RPC and REST chain identities. SDK 0.23.0 itself refuses a REST endpoint whose `node_info` reports another chain before exposing queries, and a signing RPC connection whose chain ID differs; the deployment tooling keeps its own chain-identity checks before creating a signing client as defense in depth and maps an SDK identity refusal to stable preview error codes. Compatibility is verified against the installed npm packages.

## Dependency overrides

The lockfile applies no dependency overrides. The `axios` and `protobufjs` overrides used with SDK 0.22.0 were removed with the 0.23.0 upgrade: manifestjs 4.0.0 depends on Manifest's published forks, which declare the patched lines directly.

- `@cosmology/lcd` resolves to `@manifest-network/lcd@0.14.7`, which declares `axios@^1.19.0`; the lockfile resolves a single `axios@1.20.0`.
- `@confio/ics23` resolves to `@manifest-network/ics23@0.6.10` (through `@manifest-network/stargate@0.32.4-ll.5`), which declares `protobufjs@^7.6.5` instead of the vulnerable 6.x line; the lockfile resolves a single `protobufjs@7.6.6`.

The remaining low-severity audit finding is inherited through `elliptic` in the SDK's Cosmos signing dependency. A fresh audit on 2026-09-23, after adopting SDK 0.23.0 and manifestjs 4.0.0 (both published on 2026-09-22), reports zero moderate/high/critical findings and 11 low dependency paths to the same advisory; no fixed `elliptic` release exists.

[Dependabot](../.github/dependabot.yml) proposes npm, GitHub Actions and Docker updates. It does not cover:

- the npm-aliased operator-signing packages `cosmjs-amino-modern` and `cosmjs-proto-signing-modern`;
- minor and major updates of `@cosmjs/proto-signing` and `cosmjs-types`, which must match the versions the Manifest SDK pins and move only in an SDK migration;
- the move of the Docker base image to a new Alpine line (it follows only the pinned `-alpine3.24` tags).

Review those by hand, together with the keyring helper's Go module, when updating operator tooling or the runtime base. The public service has no signing keys; the existing testnet operator script uses dedicated, faucet-funded testnet keys only.

The [2026-09-18 security audit](SECURITY-AUDIT-2026-09-18.md) reproduced that result for the repository's production npm dependencies, but found additional OS and globally bundled npm advisories in the final container image. The application-only npm result is not a clean bill of health for the image. The audit records package paths, fix targets, exposure limitations and tracked remediation.

The [prepared runtime-image remediation](RUNTIME-IMAGE.md) replaces that Debian
image with a minimized, digest-pinned Alpine candidate and removes bundled
package managers. Its exact-image scan reports no OS findings and retains the
one unfixed low elliptic finding. [Final-image CI](IMAGE-SECURITY.md) records the
full inventory and scans each candidate; this is separate from the unchanged
deployed release.

Mainnet preparation includes an optional SDK `WalletProvider` adapter in `scripts/mainnet-wallet.ts`. It uses published `@cosmjs/proto-signing@0.34.0` and `@cosmjs/amino@0.34.0`, installed under explicit aliases as development dependencies for operator tooling. Those versions use noble-backed signing. No SDK dependency override is required, and the aliases are pruned from the hosted image. The read-only mainnet preparation CLI never imports this signer or reads wallet files.

Tests use a public test mnemonic and verify direct transaction signatures plus ADR-036 provider authentication independently through Node/OpenSSL. They also disable legacy elliptic's signing method and prove both modern signing paths and actual SDK authentication-token construction still work. This is a tested adapter for a future explicitly authorized signer integration, not possession of the user's production wallet. A public address supplies no signing authority.

The transitive elliptic package remains in the SDK and therefore remains in npm audit results. Review of its fixed SHA-256/secp256k1 signing path suggests the advisory's digest/curve-length truncation condition is not reached here, but that is a source-level inference, not a formal security exemption. The optional modern adapter avoids using that implementation for signing. Do not use the legacy SDK mnemonic signer for the planned production execution, and do not reuse the testnet wallet.

Primary references: [Axios 1.20.0](https://github.com/axios/axios/releases/tag/v1.20.0), [protobufjs 7.6.6](https://github.com/protobufjs/protobuf.js/releases/tag/protobufjs-v7.6.6), [protobufjs advisory](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-xq3m-2v4x-88gg), [elliptic nonce issue](https://github.com/indutny/elliptic/issues/321).

Signer review: [elliptic advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84), [CosmJS applicability discussion](https://github.com/cosmos/cosmjs/issues/1708), [CosmJS releases](https://github.com/cosmos/cosmjs/releases).

## Native keyring adapter

The selected operator signing path is now the local Linux helper in `tools/keyring-signer/`, connected to the published JavaScript SDK by `scripts/keyring-wallet.ts`. Its Go module requires `github.com/cosmos/cosmos-sdk@v0.50.14` and resolves that dependency to the published Manifest fork `github.com/manifest-network/cosmos-sdk@v0.50.14-liftedinit.1`, matching the installed CLI. `go.mod` and `go.sum` pin the published dependency graph; the build uses `-mod=readonly`. It does not depend on a local Manifest SDK checkout. The helper and Go dependencies are excluded from the hosted Docker image.

The adapter uses the native keyring implementation for signing, while the Node layer uses published CosmJS serializers and independently verifies signatures with Node/OpenSSL. The earlier mnemonic adapter remains available for public disposable test fixtures; the operational keyring workflow does not import a mnemonic into Node or use the SDK's legacy mnemonic signer.

Review found a concrete keyring dependency path through `99designs/keyring`'s encrypted-file decoding to `jose2go.Decode`. `github.com/dvsekhvalnov/jose2go` is therefore explicitly pinned to **v1.7.0**, replacing inherited v1.6.0 and addressing [GO-2025-4123](https://pkg.go.dev/vuln/GO-2025-4123). Production operator commands still require the protected OS backend and never fall back to the insecure test backend.

The currently reviewed operator helper (SHA-256 `721fc4cdde962d12d998739a8f466730398048c0504e86ff671129de023189ee`) was built on 2026-09-17 with `go1.27.1-X:nodwarf5`, from the earlier dependency set. Its binary scan with `govulncheck@v1.7.0` confirmed the JOSE finding was removed. It left nine findings associated with linked code, three imported-package findings and 35 module-only findings. That helper stays in use until it is rebuilt and re-verified, as described below.

On 2026-09-23 the helper's module graph was updated to fix all 32 Dependabot alerts on `tools/keyring-signer/go.mod`. The cosmos-sdk fork (`v0.50.14-liftedinit.1`) did not change, and neither did any keyring-format module (`99designs/keyring` v1.2.1, `jose2go` v1.7.0, `go-bip39`, `gogoproto`, `btcutil`, `godbus`, `go-libsecret`).

| Module | Before | After | Notes |
| --- | --- | --- | --- |
| `google.golang.org/grpc` | v1.67.1 | v1.83.2 | Must be exactly v1.83.2. [GO-2026-6443](https://pkg.go.dev/vuln/GO-2026-6443) (GHSA-2v4p-qf9q-27wj) also affects v1.83.0–v1.83.1 and v1.84.x. Dependabot alert #33 showed only the range matching v1.67.1 (first patched 1.82.2). |
| `github.com/cometbft/cometbft` | v0.38.12 | v0.38.21 | The same version the installed `manifestd` links. |
| `golang.org/x/crypto` | v0.27.0 | v0.56.0 | v0.56.0 also clears the unlinked `x/crypto/ssh` advisories GO-2026-6354 and GO-2026-6355. |
| `golang.org/x/net` | v0.29.0 | v0.58.0 | Required by grpc v1.83.2. |
| `golang.org/x/text` | v0.18.0 | v0.41.0 | Also clears [GO-2026-5970](https://pkg.go.dev/vuln/GO-2026-5970). |
| `github.com/golang/glog` | v1.2.2 | v1.2.5 | Not in the build graph; it is reached only through the `badgerdb` build tag. |
| `filippo.io/edwards25519` | v1.0.0 | v1.1.1 | The same version `manifestd` links. |
| `github.com/decred/dcrd/dcrec/secp256k1/v4` (direct) | v4.2.0 | v4.4.0 | Forced by the graph; the same version `manifestd` links. |
| `golang.org/x/sys` (direct) | v0.25.0 | v0.47.0 | Forced by the graph. |

The `go` directive rises from 1.23.0 to 1.26.0. grpc v1.83.2 and its dependencies need Go 1.25; choosing `x/crypto` v0.56.0 raises that to 1.26. Build with Go 1.26 or later. `npm run keyring:build` sets `GOTOOLCHAIN=local`, so an older local Go fails instead of downloading a toolchain nobody reviewed.

Compatibility was checked on the public disposable fixture:

- Keyring records written with either dependency set decode to the same bytes.
- The pre-update and post-update helpers return byte-identical public keys, direct and ADR-036 signatures, and failure codes.
- 2,000 synthetic secp256k1 vectors and 20 BIP-32 derivations match across the old and new secp256k1, `x/crypto` and CometBFT versions.

The production `os` backend (Secret Service) was not exercised; its modules are unchanged. The `Keyring helper` CI job runs the Go tests and the public-fixture Node integration on every change.

`govulncheck@v1.8.0` source mode now works with Go 1.27.1. The earlier source-mode failure no longer reproduces. On the updated graph it reports:

- [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932), the unmaintained `x/crypto/openpgp`, with no fixed version. It is reached only through package initialization of the SDK's key import/export code, which the helper never calls. The fork's `liftedinit.3` replaces it with `ProtonMail/go-crypto`. The helper stays on `liftedinit.1` to match the installed CLI.
- GO-2025-3442, module-only. This comes from a second advisory range for CometBFT v1's `internal/blocksync`. v0.38.21 is outside the affected v0.38 range.

No imported-package findings remain. Before the update, source mode classified two advisories as called: GO-2026-5932 (the same init-only OpenPGP path, still present) and GO-2026-4361. GO-2026-4361 counted as called only because that advisory has no symbol-level data; the functions its fix changed are not reachable from the helper.

The manually traced entry point is bounded JSON input, local keyring lookup, protobuf/Amino record decoding, local secp256k1 signing, and response verification. `keyring.Sign` extracts the cached local key and uses SHA-256 plus Decred's compact ECDSA signing; it does not invoke the behaviors above. No concrete path from the three exposed operations to the remaining advisory mechanisms was identified.

This is not a formal proof of unreachability. Keep the helper local and limited to its current operations. Repeat the review before adding network services, import/export, or other input paths that could activate retained functionality.

The reviewed helper digest is still `721fc4cd…` from the earlier dependency set. A rebuilt helper has a different digest; the digest also embeds the checkout's VCS state. The launch and update commands refuse a helper whose digest does not match `keyring-check.json`. Before using a rebuilt helper, follow [Rebuilding the reviewed helper](KEYRING.md#rebuilding-the-reviewed-helper). In outline:

1. Back up the current evidence.
2. Build and fixture-check the candidate in a clean clone.
3. Scan that exact binary.
4. Install it.
5. Pass `npm run keyring:check` against the protected OS keyring.

These are operator actions.

Before keyring access, the helper requires Linux `RLIMIT_CORE=0` and `PR_SET_DUMPABLE=0`, and fails closed if either setting fails. An isolated subprocess test verified both settings. Both are needed because piped core collectors can ignore the resource limit. See the primary Linux documentation for [core dumps](https://man7.org/linux/man-pages/man5/core.5.html) and [process dumpability](https://man7.org/linux/man-pages/man2/pr_set_dumpable.2const.html). This prevents ordinary crash-dump capture of the helper's key-bearing memory; it is not a hardware-wallet isolation or memory-zeroization guarantee.

Operator commands and verification status are documented in [KEYRING.md](KEYRING.md).
