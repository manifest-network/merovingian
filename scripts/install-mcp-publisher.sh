#!/usr/bin/env bash
set -euo pipefail

# Install the pinned official MCP Registry publisher for Linux x86-64. Only the
# reviewed release archive is downloaded; its archive and extracted binary
# digests must match before the binary is used. This never logs in or publishes.
destination=${1:?Usage: install-mcp-publisher.sh DESTINATION_DIRECTORY}
version=1.8.1
commit=f52dc8525a441a3abf5fedc9912152d95af5aab1
asset=mcp-publisher_linux_amd64.tar.gz
archive_sha256=a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc
binary_sha256=5e39fe8b6fc3c8b01bed6f1de364b88e9dd10ccbef6d3d3b1a0caa46115bf869

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'The pinned mcp-publisher digest applies only to Linux x86-64.' >&2
  exit 1
fi
umask 077
mkdir -p "$destination"
cd "$destination"
rm -f "$asset" mcp-publisher
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-time 120 --retry 2 --output "$asset" \
  "https://github.com/modelcontextprotocol/registry/releases/download/v${version}/${asset}"
if ! printf '%s  %s\n' "$archive_sha256" "$asset" | sha256sum --check --strict --status; then
  rm -f "$asset"
  echo "Downloaded ${asset} does not match the pinned SHA-256; nothing was extracted." >&2
  exit 1
fi
tar -xzf "$asset" --no-same-owner mcp-publisher
if ! printf '%s  %s\n' "$binary_sha256" mcp-publisher | sha256sum --check --strict --status; then
  rm -f mcp-publisher
  echo 'Extracted mcp-publisher does not match the pinned binary SHA-256.' >&2
  exit 1
fi
# The version banner goes to stderr with a timestamp prefix. The probe gets no
# inherited tokens or OIDC request variables.
if ! env -i PATH="$PATH" HOME="$PWD" ./mcp-publisher --version 2>&1 | grep --quiet --fixed-strings "mcp-publisher ${version} (commit: ${commit},"; then
  echo "Installed mcp-publisher does not report ${version} (${commit})." >&2
  exit 1
fi
echo "Installed verified mcp-publisher ${version} (${archive_sha256})."
