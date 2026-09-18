# MCP Registry publication and discovery

The repository prepares version `0.4.3` locally; it has not been deployed or
published. Its generated `server.json` uses the registry identity
`io.github.manifest-network/merovingian` and Streamable HTTP at
`https://merovingian.manifest.network/mcp`.

Version `0.4.2` was published on 2026-09-18 at 13:41:49 UTC. The
[exact-version record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/0.4.2)
and [latest record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/latest)
both returned the approved metadata with status `active` and `isLatest: true`.
Publication used the official `mcp-publisher` 1.8.1 release after explicit user
approval. The live application and published listing remain on `0.4.2`; the
recorded publication checks above describe that release, not the local draft.
The [saved `0.4.2` registry response](evidence/mcp-registry-0.4.2.json) preserves
the exact published metadata; do not regenerate or overwrite that historical record.

## Identity and access

The GitHub namespace is controlled through an owner of the `manifest-network`
organization. The local `0.4.3` draft aligns the registry, server card, and MCP
initialization names to `io.github.manifest-network/merovingian`. Live `0.4.2`
still returns `network.manifest.merovingian/merovingian` for its card and runtime
identity. Deploying the alignment and publishing the new listing each require
explicit approval. The HTTPS origin and remote endpoint stay the same.

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
repository URL before publication. For this draft, retain the live `0.4.2`
listing until the approved `0.4.3` deployment is verified; then publish the
reviewed `0.4.3` metadata with separate explicit authorization.

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
