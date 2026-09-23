#!/usr/bin/env bash
set -euo pipefail

# CI integration check for the operator keyring helper: build it with the locked
# module graph, create the PUBLIC disposable fixture, then sign and check stable
# failure codes through the Node adapter and published SDK. No production
# keyring, network request, broadcast or provider authentication is involved.
#
# The build and the check write under <repository>/.local/mainnet, where an
# operator checkout keeps its reviewed helper binary and evidence. Run this only
# in a fresh checkout; it refuses to touch existing operator state.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [ -e .local/mainnet ] || [ -L .local/mainnet ]; then
  echo 'Refusing to run: .local/mainnet exists. Use a fresh checkout so the reviewed helper and operator evidence are never overwritten.' >&2
  exit 1
fi
export GOFLAGS=-mod=readonly GOTOOLCHAIN=local
npm run --silent keyring:build
KEYRING_SIGNER_TEST_FIXTURE_DIR="$PWD/.local/mainnet/keyring-signer-fixture" \
  go -C tools/keyring-signer test -p 2 -count=1 -run '^TestWritePublicFixture$' .
node --import tsx scripts/test-keyring-native.ts
