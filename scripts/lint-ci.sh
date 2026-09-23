#!/usr/bin/env bash
set -euo pipefail

# Lint GitHub workflows (including their run: scripts) and repository shell
# scripts with pinned, checksum-verified tools. Linux x86-64 only. The tools are
# downloaded into a temporary directory and removed afterwards.
actionlint_version=1.7.12
actionlint_sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
shellcheck_version=0.11.0
shellcheck_sha256=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'The pinned lint tool digests apply only to Linux x86-64.' >&2
  exit 1
fi
tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT

install() {
  local name=$1 url=$2 sha256=$3 archive=$tools/$1.tar.gz
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --max-time 120 --retry 2 --output "$archive" "$url"
  if ! printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --strict --status; then
    echo "Downloaded ${name} does not match the pinned SHA-256." >&2
    exit 1
  fi
}

install actionlint \
  "https://github.com/rhysd/actionlint/releases/download/v${actionlint_version}/actionlint_${actionlint_version}_linux_amd64.tar.gz" \
  "$actionlint_sha256"
tar -xzf "$tools/actionlint.tar.gz" -C "$tools" actionlint
install shellcheck \
  "https://github.com/koalaman/shellcheck/releases/download/v${shellcheck_version}/shellcheck-v${shellcheck_version}.linux.x86_64.tar.gz" \
  "$shellcheck_sha256"
tar -xzf "$tools/shellcheck.tar.gz" -C "$tools" --strip-components=1 "shellcheck-v${shellcheck_version}/shellcheck"

# actionlint runs shellcheck on each run: block when shellcheck is on PATH.
export PATH="$tools:$PATH"
shellcheck scripts/*.sh tools/healthcheck.sh
actionlint .github/workflows/*.yml
echo "actionlint ${actionlint_version} and shellcheck ${shellcheck_version} found no issues."
