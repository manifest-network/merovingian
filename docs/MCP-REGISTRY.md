# MCP Registry publication and discovery

Version `0.4.5` is deployed on mainnet and published as the latest version in the
official MCP Registry. The generated `server.json` uses the registry identity
`io.github.manifest-network/merovingian` and Streamable HTTP at
`https://merovingian.manifest.network/mcp`.

Version `0.4.5` was published at **2026-09-21T18:03:55.231121Z** after the user
requested release and deployment, then completed registry login and confirmed
readiness to publish. Official `mcp-publisher` 1.8.1 published the validated
metadata after live acceptance. The
[exact-version record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/0.4.5)
and [latest record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/latest)
returned `active`, `isLatest: true`, and metadata matching the committed
`server.json`, verified by **2026-09-21T18:03:57.501945Z**. Its exact file SHA-256 is
`cbd907571d98a42e142f875544fccb1f39ea13527b46a4176f108102e84fc054`.
The temporary registry login was removed after verification. See the
[release record](RELEASE-0.4.5.md), [publication evidence](evidence/release-0.4.5.json)
and [saved registry response](evidence/mcp-registry-0.4.5.json).

Version `0.4.4` was published after successful live acceptance and explicit
approval at **2026-09-21T13:13:54.140771Z** using official `mcp-publisher` 1.8.1.
The [exact-version record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/0.4.4)
and [then-latest record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/latest)
returned `active`, `isLatest: true`, and metadata exactly matching the approved
`server.json`, checked at **2026-09-21T13:13:54.816064Z**. Its exact file SHA-256 is
`c2c33a0105b9f0af82cb6ae0ab5d774b5c9e4b5c480c10aecb5358dbe77c2f69`.
The temporary registry login was removed after verification. See the
[release notes](RELEASE-0.4.4.md) and
[publication evidence](evidence/release-0.4.4.json).

The dated metadata matches and saved responses below describe their original
release files. They remain historical records after the `0.4.5` publication.

Version `0.4.3` was published after explicit approval at
**2026-09-18T15:13:34.27966Z** using official `mcp-publisher` 1.8.1. The
[exact-version record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/0.4.3)
and [then-latest record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/latest)
both returned `active`, `isLatest: true`, and metadata exactly matching
the then-current `server.json` at **2026-09-18T15:13:44.812579Z**. The
[saved `0.4.3` response](evidence/mcp-registry-0.4.3.json) preserves that public
result. The temporary local registry login was removed after verification.

The earlier version `0.4.2` was published on 2026-09-18 at 13:41:49 UTC. Its
[exact-version record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/0.4.2)
and the then-latest record
both returned the approved metadata with status `active` and `isLatest: true` at
the publication check.
Publication used the official `mcp-publisher` 1.8.1 release after explicit user
approval. Those publication checks describe the historical `0.4.2` release;
the live application has since advanced through `0.4.3` and `0.4.4` to `0.4.5`.
The [saved `0.4.2` registry response](evidence/mcp-registry-0.4.2.json) preserves
the exact published metadata; do not regenerate or overwrite that historical record.

Use the [snapshot index](evidence/mcp-registry-snapshots.json) when reading these
saved responses. It records file hashes and dated observations or capture bounds.
`npm run registry:check` (also part of `npm run check` and CI) re-hashes every
snapshot named by the index and rejects missing, unsafe, or changed artifacts.
It also requires every `mcp-registry-*.json` file in the evidence directory,
except the index itself, to have an index entry.
It never rewrites the snapshots or repairs hashes automatically.
Earlier responses retain `isLatest: true` because each described a different moment;
these saved values are not claims about the current registry state. The original standalone
`0.4.2` capture time was not recorded, but its complete parsed object matches the
independent discovery response observed between **13:44:54.588Z and 13:44:56.009Z**
on 2026-09-18. The `0.4.3` capture completed by **15:13:44.812579Z**; its individual
fetch time was not recorded. Query the latest record above for current status.

In the [release evidence](evidence/release-0.4.3.json),
`serverJsonFileSha256` hashes the exact committed `server.json` bytes, including
its trailing newline. `exactMetadataMatch` means parsed JSON-object equality
between that file and each registry response's `server` object, not equality of
their serialized bytes. Reproduce the file hash with:

```sh
git show 300ac773f28dd61bd804d376cbddcd6ffbd5e82a:server.json | sha256sum
```

## Identity and access

The GitHub namespace is controlled through an owner of the `manifest-network`
organization. Release `0.4.3` aligned the registry, server card, and MCP initialization
names to `io.github.manifest-network/merovingian`; read-only acceptance verified
the change on 2026-09-18. Releases `0.4.4` and `0.4.5` preserve that identity, verified again
on 2026-09-21. The earlier `0.4.2` card and runtime returned
`network.manifest.merovingian/merovingian`, as preserved in the historical
[discovery report](MCP-DISCOVERY.md). The HTTPS origin and remote endpoint stay
the same.

This is a remote-only listing. There is no installable npm package or local
container command in the record. All four remote tools remain available:
`list_amenities`, `enjoy_amenity`, `hosting_support`, and `verify_contribution`.
Free visits require no wallet, login, API key, or payment. A successful
`enjoy_amenity` call increments one aggregate serving count. Contributions require
separate visitor-controlled wallet authorization.

## Publisher workflow

Use the published official `mcp-publisher` CLI. For **Linux x86-64**, the exact
v1.8.1 asset is `mcp-publisher_linux_amd64.tar.gz`. Its SHA-256 is
`a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc`,
verified against both the
[official release asset metadata](https://api.github.com/repos/modelcontextprotocol/registry/releases/tags/v1.8.1)
and the upstream
[`registry_1.8.1_checksums.txt`](https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/registry_1.8.1_checksums.txt)
on 2026-09-18. Download the pinned archive and check that exact digest before
extracting or running it. From the repository root, in Bash:

```bash
(
  set -euo pipefail
  umask 077
  test "$(uname -s)" = Linux
  test "$(uname -m)" = x86_64
  mkdir -p .local/tools/mcp-publisher-v1.8.1
  cd .local/tools/mcp-publisher-v1.8.1
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output mcp-publisher_linux_amd64.tar.gz \
    https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/mcp-publisher_linux_amd64.tar.gz
  printf '%s  %s\n' \
    a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc \
    mcp-publisher_linux_amd64.tar.gz | sha256sum --check --strict -
  tar -xzf mcp-publisher_linux_amd64.tar.gz mcp-publisher
)
```

For another platform, select its exact release asset and verify its own upstream
digest; the hash above applies only to the named archive.

Generate and check the local metadata, then validate it against the registry:

```sh
npm run registry:generate
npm run registry:check
.local/tools/mcp-publisher-v1.8.1/mcp-publisher validate server.json
```

Validation sends this public JSON to the official registry validation API. It does
not publish and is not an offline check. Do not add credentials or private headers
to the record. Review the exact namespace, version, description, endpoint, and
repository URL before publication. The `0.4.3` and `0.4.4` releases completed this workflow
after their deployments passed verification. Future publications require review
and explicit authorization for their own version and metadata.

As checked on 2026-09-18, the interactive device flow cannot grant our organization
namespace. It uses the private **MCP Registry Login (Prod) GitHub App**, whose user
token cannot supply the organization role required by the registry. Login can
succeed while granting only the personal namespace. This is a
[maintainer-confirmed registry bug](https://github.com/modelcontextprotocol/registry/issues/1468#issuecomment-5093147856).
Changing OAuth App settings, making membership public, or attempting to install
the private app is not the remedy.

For a one-off publication, an organization owner can create a dedicated PAT with
the shortest practical expiration and either:

- Classic PAT: only `read:org`.
- Fine-grained PAT: resource owner `manifest-network`, with **Organization
  permissions → Members → Read-only** and no added repository permissions.

The following executable Python helper reads the PAT from the controlling
terminal without echo, fails closed if that is unavailable, and passes it only
to the login child's environment. It does not export a token in the shell and
does not publish. Run it in a local terminal from the repository root after
completing the review and receiving authorization for the intended publication:

```sh
python3 - <<'PY'
import getpass
import os
from pathlib import Path
import resource
import subprocess
import termios
import warnings

os.umask(0o077)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
publisher = Path('.local/tools/mcp-publisher-v1.8.1/mcp-publisher').resolve(strict=True)
token_file = Path.home() / '.config/mcp-publisher/token.json'
for directory in (token_file.parent.parent, token_file.parent):
    if directory.is_symlink() or (directory.exists() and (
        not directory.is_dir() or directory.stat().st_uid != os.getuid()
    )):
        raise SystemExit('Registry config needs operator review; refusing unsafe directory.')
if token_file.parent.exists() and token_file.parent.stat().st_mode & 0o777 != 0o700:
    raise SystemExit('Existing registry config directory must have mode 0700.')
if token_file.exists() or token_file.is_symlink():
    raise SystemExit('An existing registry login needs operator review before replacement.')
warnings.simplefilter('error', getpass.GetPassWarning)
try:
    with open('/dev/tty', 'w') as terminal:
        if not terminal.isatty():
            raise OSError('No terminal')
        termios.tcgetattr(terminal.fileno())
        token = getpass.getpass('Dedicated registry PAT (hidden): ', stream=terminal)
except (OSError, termios.error, getpass.GetPassWarning):
    raise SystemExit('A terminal with hidden input is required; no login attempted.')
if not token or token != token.strip():
    raise SystemExit('A nonempty PAT without surrounding whitespace is required.')
allowed = {'HOME', 'PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'}
login_env = {key: value for key, value in os.environ.items() if key in allowed}
login_env['MCP_GITHUB_TOKEN'] = token
try:
    result = subprocess.run(
        [str(publisher), 'login', 'github', '--registry=https://registry.modelcontextprotocol.io'],
        env=login_env, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=60,
    )
finally:
    login_env.pop('MCP_GITHUB_TOKEN', None)
    token = ''
if result.returncode:
    raise SystemExit('Registry login failed; no publication attempted.')
print('Registry login saved. Verify its namespace grant and expiry before publication.')
PY
```

The helper removes its PAT environment entry in `finally`, then exits; Python
does not guarantee erasure of string copies from memory. Environment injection
limits inheritance to the login process, but is not isolation from another
process running under the same operating-system user. Use a trusted local
session. Do not put token values in shell history, command arguments, chat,
source, or logs. Do not reuse the broad credential used by `gh` for repository
management. Revoke the dedicated PAT after publication.

Version 1.8.1 stores its registry token in the user's
`.config/mcp-publisher/token.json`, outside this repository. Check that the
directory is private (`0700`) and the token is private (`0600`); do not overwrite
an existing login unknowingly. It does not support `XDG_CONFIG_HOME` relocation.

Before publishing, check that the saved login metadata names the official
registry destination. Inspect the locally issued registry token's claims in
memory to confirm a `publish` grant for `io.github.manifest-network/*` and a valid
expiration. Report only the destination/grant check results and expiration time;
never dump the JWT or its complete claims. Decoding claims is
a local preflight, not cryptographic verification. The registry JWT lasts only
[five minutes](https://github.com/modelcontextprotocol/registry/blob/v1.8.1/internal/auth/jwt.go),
so complete metadata review and validation before login and publish promptly.
Successful login alone does not prove organization publishing access.

GitHub Actions OIDC is another supported route: a reviewed workflow in this
organization's repository can use `mcp-publisher login github-oidc` with
`id-token: write`, without a PAT. Keep publication an explicitly approved action;
do not introduce an automatic release trigger as part of this workaround. See the
[official Actions guidance for v1.8.1](https://github.com/modelcontextprotocol/registry/blob/v1.8.1/docs/modelcontextprotocol-io/github-actions.mdx).

After explicit authorization for the reviewed registry publication:

```sh
.local/tools/mcp-publisher-v1.8.1/mcp-publisher publish server.json
```

Fetch the public record and compare it with `server.json`. Check the exact
versioned result and current/latest result. Treat published versions as immutable:
review a new version when changing listing metadata. An uncertain publish response
requires a read-only lookup before any retry.

## Fresh-agent discovery test

The [2026-09-18 acceptance report](MCP-DISCOVERY.md) records a successful
name-led discovery and exactly one authorized free visit: cookies served changed
from 5 to 6, with sauna and tea unchanged. The following procedure is for future
explicitly authorized tests; it is not an instruction to repeat that visit.

Use a new agent context with no conversation history, application source, local
runbooks, or preloaded refuge endpoint. Give it the official registry as a discovery
surface. Record the exact prompt and whether it used a service-name search or a
broader capability search; these demonstrate different levels of discoverability.

Before delegating a live test, the supervising operator must obtain and preserve
the user's direct, explicit approval of the concrete scope: the production
endpoint, one free `enjoy_amenity` call, its counter increment, and no automatic
retry. Save that first-party approval and its date/context privately under
`.local/`, then pass the bounded authorization to the fresh agent. A supervising
agent's assertion or a sandbox network approval does not replace the user's
authorization. Without that record, stop at read-only discovery.

1. Find the public listing and obtain the endpoint from its `remotes` field.
2. Connect with Streamable HTTP, record the negotiated server identity/version,
   and discover the four tools through `tools/list`.
3. Read the menu and choose one free amenity. Read serving counts before the visit.
4. Within the recorded approval, prepare an exclusive attempt marker under the
   ignored test-run directory. Flush and `fsync` the marker and its parent
   directory before dispatching the single `enjoy_amenity` request; abort if the
   marker exists or durability cannot be confirmed. Save the returned souvenir.
   Do not retry a visit with an ambiguous outcome or create a new run to bypass
   its marker. This is the future procedure, not a claim that the original test
   demonstrated crash durability.
5. Read counts afterward and report the observed change. Concurrent visitors can
   also change the shared counters; do not claim exclusive attribution without
   supporting evidence.

Keep the exact test prompt at `.local/<test-run>/prompt.txt` and the approval
record alongside it; both stay private and ignored. `.gitignore` also excludes
`prompt.txt` wherever saved. Publish only a sanitized description of the prompt,
supplied hints, and approved scope, plus public discovery requests, selected
listing/version, negotiated identity, tool list, souvenir, timestamps, and counter
observations. Include failures and manual host approvals. Label the visit as test
traffic. Do not sign transactions, query local wallets, or make a contribution.

A successful registry journey does not prove search-engine indexing, automatic
installation by arbitrary MCP hosts, or organic visitor traffic.

References: [remote servers](https://modelcontextprotocol.io/registry/remote-servers),
[publisher authentication](https://modelcontextprotocol.io/registry/authentication),
[versioning](https://modelcontextprotocol.io/registry/versioning),
[ENG-1019](https://linear.app/liftedinit/issue/ENG-1019),
[ENG-1021](https://linear.app/liftedinit/issue/ENG-1021).
