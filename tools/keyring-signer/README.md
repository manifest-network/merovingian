# Local Manifest keyring adapter

This small Go helper connects the published JavaScript SDK to an existing local
`manifestd` keyring. It uses the published Cosmos SDK fork/version used by the
installed CLI. The helper currently targets Linux. It does not export keys,
broadcast transactions, or run a server. Before keyring access it sets both core
dump limits to zero and uses Linux `PR_SET_DUMPABLE=0`, including protection against
piped core collectors. It fails closed if either protection cannot be set.

Every invocation requires these explicit flags:

```text
--home /absolute/existing/keyring/home
--keyring-backend os
--key merovingian
--expected-address manifest1...
--chain-id manifest-ledger-mainnet
```

The directory is the same root used by manifestd's keyring (its `--keyring-dir`
when configured, otherwise its `--home`). There is no implicit key or directory.
Only `manifest-ledger-mainnet` and `manifest-ledger-testnet` are accepted chains.

One UTF-8 JSON request is read from stdin, up to 64 KiB including whitespace:

```json
{"operation":"public-key"}
{"operation":"sign-direct","signBytes":"BASE64_PROTOBUF_SIGNDOC"}
{"operation":"sign-adr036","data":"provider challenge"}
```

These examples are separate invocations. Extra/duplicate properties, trailing
JSON, wrong-chain direct documents, and mismatched wallet addresses are rejected.
Direct signing requires a canonical protobuf `SignDoc` with nonempty, decodable
body and auth-info bytes. The caller remains responsible for approving and
validating the transaction messages, recipient, fees, and spending limits.

ADR-036 wraps UTF-8 `data` in the fixed canonical Amino `sign/MsgSignData` envelope:
empty chain and memo, account/sequence zero, gas zero and no fee coins. The caller
must authorize the provider challenge and scope it to the intended lease; the
helper does not infer authorization from a syntactically valid request.

Success writes one JSON object to stdout, with `address`, compressed secp256k1
`publicKey` in base64, and (for signing) a base64 64-byte `signature`. Failure exits
1 and writes only `{"error":"STABLE_ERROR_CODE"}` to stderr. Backend diagnostics
are suppressed. The helper independently checks its returned signature and key.

All operations time out after 15 seconds. This interface never accepts or prompts
for a passphrase. An encrypted `file` backend fails with
`NONINTERACTIVE_UNLOCK_UNAVAILABLE`; other backends must already be accessible.
Signing supports local secp256k1 records only, with hardware/offline/multisig
records rejected. The insecure `test` backend is for disposable integration
fixtures only. Do not move a production key there to avoid unlocking a backend.

The inherited `jose2go` dependency is pinned to published 1.7.0 to address
[GO-2025-4123](https://pkg.go.dev/vuln/GO-2025-4123), a crafted JWE decompression
denial of service in the encrypted-file keyring path. This does not change the
Cosmos SDK version or the keyring format.

Build/test from the repository root, keeping caches off the nearly full `/tmp`:

```sh
mkdir -p .local/go-cache .local/go-tmp .local/mainnet/bin
GOMAXPROCS=2 GOCACHE="$PWD/.local/go-cache" GOTMPDIR="$PWD/.local/go-tmp" TMPDIR="$PWD/.local/go-tmp" go -C tools/keyring-signer test -p 2 ./...
GOMAXPROCS=2 GOCACHE="$PWD/.local/go-cache" GOTMPDIR="$PWD/.local/go-tmp" TMPDIR="$PWD/.local/go-tmp" go -C tools/keyring-signer build -p 2 -o ../../.local/mainnet/bin/keyring-signer .
```

Tests use an in-memory keyring and a public BIP-39 test vector. To create a
disposable filesystem fixture for cross-language verification, run only
`TestWritePublicFixture` with `KEYRING_SIGNER_TEST_FIXTURE_DIR` pointing to a new
absolute directory beneath `.local/`. The test refuses an existing directory.
It writes a key named `fixture` and `public.json`; its mnemonic is public and the
fixture must never hold real assets. No test reads the user's production keyring.

CI runs the same checks on every pull request and push to `main` in the
**Keyring helper** job of [`ci.yml`](../../.github/workflows/ci.yml):

1. `go mod verify` and the Go tests with pinned Go 1.27.1, `GOTOOLCHAIN=local`
   and `-mod=readonly`.
2. [`scripts/keyring-ci.sh`](../../scripts/keyring-ci.sh), which builds the
   helper, writes the public fixture and runs `scripts/test-keyring-native.ts`.

The script refuses to run where `.local/mainnet` already exists, so it can never
overwrite an operator's reviewed helper or evidence. The job uploads no
artifacts. A CI build is a regression check only. Its digest differs from the
reviewed operator helper, which is built locally and verified separately.
