# Published dependencies

JavaScript dependencies come from npm and are pinned by `package-lock.json`. The application does not import, link, or build any local Manifest checkout. SDK version: `@manifest-network/manifest-sdk@0.22.0`; generated messages: `@manifest-network/manifestjs@3.0.0`. The operator-only native helper uses pinned published Go modules as described below.

The published SDK differs from the development checkout. Runtime contribution verification explicitly checks RPC and REST chain identities. Deployment tooling checks chain identity before creating a signing client. Compatibility is verified against the installed npm packages.

## Dependency overrides

The lockfile applies two published dependency overrides:

- `axios@1.20.0` replaces an older 1.x version pinned by the LCD dependency and addresses published HTTP-client advisories.
- `protobufjs@7.6.6` replaces the vulnerable 6.x dependency under ICS23. No patched 6.x release is available. ICS23 uses generated `protobufjs/minimal` codecs; test and live deployment coverage exercise compatibility. This is a dependency override, not a change to the Manifest package source.

The remaining low-severity audit finding is inherited through `elliptic` in the SDK's Cosmos signing dependency. A fresh audit on 2026-09-17 reports zero moderate/high/critical findings and 11 low dependency paths to the same advisory. SDK 0.22.0 remains the latest published SDK at this check. The public service has no signing keys; the existing testnet operator script uses dedicated, faucet-funded testnet keys only.

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

A final binary scan with `govulncheck@v1.7.0`, using the hardened helper built with `go1.27.1-X:nodwarf5`, confirmed the JOSE finding was removed. Nine findings associated with linked code remain, plus three additional imported-package findings and 35 additional module-only findings. One of the nine, GO-2026-4361, uses a broad CometBFT module match rather than a precise vulnerable-symbol definition.

| Linked dependency family | Advisory behavior and reviewed helper path | Published fix target, not yet integrated |
| --- | --- | --- |
| gRPC | [GO-2026-6443](https://pkg.go.dev/vuln/GO-2026-6443), [6348](https://pkg.go.dev/vuln/GO-2026-6348), [6061](https://pkg.go.dev/vuln/GO-2026-6061), and [4762](https://pkg.go.dev/vuln/GO-2026-4762) concern HTTP/2 transport, xDS routing/authorization, or server handling. The helper creates no gRPC client or server. | v1.83.2 covers all four |
| `golang.org/x/text/unicode/norm` | [GO-2026-5970](https://pkg.go.dev/vuln/GO-2026-5970) concerns a loop on invalid UTF-8. The retained `Form.Properties` path enters through IDNA/HTTP and Sentry case conversion; neither is called by the helper's key lookup/signing flow. Its JSON input also rejects invalid UTF-8. | v0.39.0 |
| OpenPGP | [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932) covers the unmaintained OpenPGP package. Armor methods are retained through SDK key import/export functionality, which the helper does not expose or call. Legacy key-record decoding uses Amino rather than PGP armor. | No fixed version in this package |
| CometBFT | [GO-2026-4361](https://pkg.go.dev/vuln/GO-2026-4361), [GO-2025-4025](https://pkg.go.dev/vuln/GO-2025-4025), and [3443](https://pkg.go.dev/vuln/GO-2025-3443) concern commit time, consensus bit arrays, and block parts. The helper does not construct or verify those objects; transaction message `Any` payloads remain opaque. | v0.38.21 covers all three |

The manually traced entry point is bounded JSON input, local keyring lookup, protobuf/Amino record decoding, local secp256k1 signing, and response verification. `keyring.Sign` extracts the cached local key and uses SHA-256 plus Decred's compact ECDSA signing; it does not invoke the behaviors above. No concrete path from the three exposed operations to the remaining advisory mechanisms was identified.

This is not a clean dependency scan or a formal proof of unreachability. Vulnerable code remains linked, and binary presence does not establish a call path. Source-mode reachability analysis was attempted but failed because this scanner's source-processing dependencies support Go 1.25 while the installed Go 1.27.1 sources use newer features. The fix targets above still require compatibility testing. Keep the helper local and limited to its current operations, and repeat the review before adding network services, import/export, or other input paths that could activate retained functionality.

The reviewed hardened helper's SHA-256 is `721fc4cdde962d12d998739a8f466730398048c0504e86ff671129de023189ee`. Rebuilding with a different toolchain or dependencies requires a fresh scan and fixture verification.

Before keyring access, the helper requires Linux `RLIMIT_CORE=0` and `PR_SET_DUMPABLE=0`, and fails closed if either setting fails. An isolated subprocess test verified both settings. Both are needed because piped core collectors can ignore the resource limit. See the primary Linux documentation for [core dumps](https://man7.org/linux/man-pages/man5/core.5.html) and [process dumpability](https://man7.org/linux/man-pages/man2/pr_set_dumpable.2const.html). This prevents ordinary crash-dump capture of the helper's key-bearing memory; it is not a hardware-wallet isolation or memory-zeroization guarantee.

Operator commands and verification status are documented in [KEYRING.md](KEYRING.md).
