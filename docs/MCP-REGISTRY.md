# MCP Registry publication and discovery

Version `0.4.6` is deployed on mainnet and published as the latest version in the
official MCP Registry. The generated `server.json` uses the registry identity
`io.github.manifest-network/merovingian` and Streamable HTTP at
`https://merovingian.manifest.network/mcp`.

Version `0.4.6` was published at **2026-09-22T14:12:57.663135Z** using official
`mcp-publisher` 1.8.1, after explicit production authorization, successful
read-only live acceptance and a fresh local login. The
[exact-version record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/0.4.6)
and [latest record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/latest)
returned `active`, `isLatest: true`, and metadata matching the committed
`server.json`, verified at **2026-09-22T14:15:35.158984Z**. Its exact file SHA-256
is `eae1bf05864b13c6f5a88a674d2f7dd2306dac52f2ea18c4aaac6fe64d9dcf63`.
A timed-out public lookup was reconciled with read-only requests, without
repeating publication. The temporary registry login was removed after verification.
See the [release record](RELEASE-0.4.6.md),
[publication evidence](evidence/release-0.4.6.json) and
[saved registry response](evidence/mcp-registry-0.4.6.json).

The records below retain their historical metadata and publication evidence.

Version `0.4.5` was published at **2026-09-21T18:03:55.231121Z** after the user
requested release and deployment, then completed registry login and confirmed
readiness to publish. Official `mcp-publisher` 1.8.1 published the validated
metadata after live acceptance. The
[exact-version record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/0.4.5)
and [then-latest record](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/latest)
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
release files. They remain historical records after the `0.4.6` publication.

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
the live application has since advanced through `0.4.3`, `0.4.4` and `0.4.5` to `0.4.6`.
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
the change on 2026-09-18. Releases `0.4.4` through `0.4.6` preserve that identity, verified again
on 2026-09-21 and 2026-09-22. The earlier `0.4.2` card and runtime returned
`network.manifest.merovingian/merovingian`, as preserved in the historical
[discovery report](MCP-DISCOVERY.md). The HTTPS origin and remote endpoint stay
the same.

This is a remote-only listing. There is no installable npm package or local
container command in the record. All four remote tools remain available:
`list_amenities`, `enjoy_amenity`, `hosting_support`, and `verify_contribution`.
Free visits require no wallet, login, API key, or payment. A successful
`enjoy_amenity` call increments one aggregate serving count. Contributions require
separate visitor-controlled wallet authorization.

## GitHub Actions publication

The manually dispatched
[`publish-mcp-registry.yml`](../.github/workflows/publish-mcp-registry.yml)
workflow publishes the registry record for a release that is **already deployed
and accepted**. It uses official `mcp-publisher` 1.8.1 with
`login github-oidc`, so no GitHub PAT, local registry login or production wallet
is involved. It never builds or publishes images, updates the lease, changes DNS,
visits the refuge or pays. Those remain separate, separately authorized steps.
There is no push, pull request, tag or schedule trigger.

The decision, reconciliation and classification paths below were validated with
local fixtures (`tests/registry-publication.test.ts`), including a stand-in
publisher and registry, and with `actionlint`. The fixtures do not cover job
cancellation or a real OIDC exchange. On 2026-09-22, a
[local dry run](#local-dry-run) of the current script in a fresh public clone
returned `already-published` for `0.4.6`. Its saved snapshot was byte-identical
to the committed [`mcp-registry-0.4.6.json`](evidence/mcp-registry-0.4.6.json).
On 2026-09-23, two dispatches from `main` at `35078d5`, for `0.4.6` with
`source_revision` `6cbce45`, ran in GitHub Actions:
[`mode=preflight`](https://github.com/manifest-network/merovingian/actions/runs/35861755064)
and [`mode=publish`](https://github.com/manifest-network/merovingian/actions/runs/35861847194).
Both Preflight jobs passed the approval-environment check, fetched the live
`main`, and returned a verified `already-published` no-op. Their snapshots were
byte-identical to the committed record. Both Publish jobs were skipped, so the
approval, OIDC login and publish path has not yet run. The next release's
publication will be its first real use and needs its own explicit authorization.
The manual PAT fallback remains available if that login fails.

### Approval environment

The `mcp-registry-publish` environment (**Settings → Environments**) was
configured on 2026-09-23 with one required reviewer, administrator bypass
disabled, and a single `main` branch rule. It must keep this configuration:

- **Required reviewers:** at least one maintainer. Enable *Prevent self-review*
  only if at least two reviewers can approve each other's dispatches.
- **Deployment branches and tags:** *Selected branches and tags*, with one
  **branch** rule named `main` and no tag rules. Do not choose *Protected branches
  only*. `main` is covered by a ruleset rather than classic branch protection, and
  when no protection rules exist GitHub lets every branch deploy.
- **Disable** *Allow administrators to bypass configured protection rules*.
- No environment secrets. OIDC needs none.

Changing the environment is an administrative change that needs its own
authorization. A job that names a missing environment makes GitHub create it
**without protection**. The unprivileged Preflight job therefore reads the
environment through the REST API first. In `publish` mode it stops unless
the environment has required reviewers, no administrator bypass and exactly the
`main` branch rule. Check the configuration read-only with:

```sh
gh api repos/manifest-network/merovingian/environments/mcp-registry-publish \
  --jq '{reviewers: [.protection_rules[] | select(.type == "required_reviewers") | .reviewers | length],
         can_admins_bypass, deployment_branch_policy}'
gh api repos/manifest-network/merovingian/environments/mcp-registry-publish/deployment-branch-policies \
  --jq '[.branch_policies[] | {name, type}]'
```

### Dispatch

Dispatch only after these steps are complete:

1. The release PR is merged to `main`.
2. The image is published and the existing lease is updated.
3. Read-only acceptance has passed.
4. The user has explicitly authorized publication of that exact version.

Always dispatch from `main`. Inputs:

- `version`: the reviewed `MAJOR.MINOR.PATCH`. It must equal `server.json` and
  `package.json`.
- `source_revision`: the full 40-character commit on `main` that contains the
  reviewed release metadata, normally the release merge commit. Its `server.json`
  must be byte-identical to the dispatched commit and to `main` as fetched from
  GitHub at check time. `actions/checkout` rewrites `origin/main` to the dispatched
  commit, so both jobs fetch the live tip into `refs/merovingian/main`. To publish,
  dispatch the current release before the next version is prepared.
  The revision is operator-asserted. Evidence records `releaseCommit: true` only
  when that commit introduced the version, so it can be matched against the
  release record.
- `mode`: `preflight` (the default) runs only read-only checks. `publish` also
  requests environment approval and then publishes.

```sh
gh workflow run publish-mcp-registry.yml --ref main \
  -f version=X.Y.Z -f source_revision=<full commit SHA> -f mode=preflight
```

Run `preflight` first, review its summary, then dispatch again with
`mode=publish`. The **Preflight** job has `contents: read` and `actions: read`
permissions and cannot request OIDC tokens. It checks:

1. **Trusted source:** this repository's `main` workflow, a `workflow_dispatch`
   event, and a source revision contained in the dispatched commit, which must
   still be contained in the live `main`, with identical `server.json` at all three.
2. **Metadata:** `npm run registry:check` and the exact reviewed `server.json`
   shape (identity, version, website, remote endpoint, repository, printable ASCII).
   The file's exact-byte SHA-256 is recorded.
3. **Approval gate:** the environment rules above. Failure is reported in
   `preflight` mode and stops `publish` mode.
4. **Existing registry records:** read-only lookups of the exact version
   (`include_deleted=true`), `latest`, and every recorded version
   (`include_deleted=true`). The registry server version is also recorded, for
   information only.
   - An identical, active exact record is a **verified no-op** (`already-published`).
     Nothing else runs.
   - Different metadata, or a deprecated or deleted record, is refused. Published
     versions are immutable and deleted versions still block reuse, so prepare a new
     version.
   - The requested version must be greater than every recorded version, including
     deleted ones. The registry would let a new version pass a deleted higher one,
     but a restored deleted version would take `latest` back.
   - Only the registry's typed `404 Server not found` proves absence. Any other
     status, a routing or gateway 404, or history that disagrees with `latest`
     stops the run.
5. **New versions only:** pinned `mcp-publisher validate`, which calls the
   unauthenticated validation API and writes nothing. Then the repository's
   read-only acceptance suite runs against `https://merovingian.manifest.network`
   (`node --import tsx scripts/smoke.ts https://merovingian.manifest.network --mainnet`,
   the `npm run smoke` command without npm): at most 21 requests and **zero
   servings**, enforced by the smoke transport allowlist.
   The summary must report a passing read-only mainnet run with no serving attempts.

A passing preflight reports one of three outcomes:

- `already-published`: the identical record already exists.
- `ready-to-publish`: `preflight` mode passed.
- `awaiting-approval`: `publish` mode passed and the **Publish** job is waiting.

### Approval

Before approving the **Publish** job, the reviewer reads the Preflight job
summary. Approve only when all of these match the authorized release:

- the version and source revision;
- the `server.json` SHA-256;
- an absent exact record and an older `latest`;
- a protected environment and passing validation;
- read-only acceptance with zero servings.

Until approval, no Publish step runs and no OIDC token can be requested. Runs are
named `MCP Registry <mode> <version>`. Reject stale or unexpected runs instead of
leaving them pending. A waiting run holds
the single `mcp-registry-publication` concurrency group. A newer dispatch
replaces any queued run, and unapproved jobs fail after 30 days. Prefer a fresh
dispatch over re-running an old job. A re-run reuses the original commit and
inputs.

### Publication and verification

The **Publish** job has only `contents: read` and `id-token: write`. Every step
and action in it can request an OIDC token, so it installs no npm packages and
uses no caches. Only these run there:

- the SHA-pinned first-party `checkout`, `setup-node` and `upload-artifact` actions;
- runner tools (`bash`, `curl`, `tar`, `sha256sum`, `git`);
- the digest-verified publisher;
- the dependency-free
  [`registry-publication.mjs`](../scripts/registry-publication.mjs).

Adding a step or action widens that boundary. Review any change to this job's
action pins, including grouped Dependabot `ci(deps)` updates, as a change to the
publication trust boundary. Git and the installer's version
probe run without the OIDC request variables. The script:

1. Rechecks the source, confirms that `server.json` matches the preflight digest,
   and re-reads registry state. If an identical record appeared in the meantime,
   the result is a no-op without login.
2. Rechecks the deployment with two bounded GETs: `/healthz` and
   `/mcp/server-card` must report the requested version and identity. Nothing is
   visited or served.
3. Runs `login github-oidc --registry=https://registry.modelcontextprotocol.io`
   in a private temporary `HOME`. That child receives only `PATH`, locale and CA
   settings, and the Actions OIDC request variables. `GODEBUG` and other variables
   are never passed. The registry login lasts five minutes.
4. Runs exactly one `publish server.json` without the OIDC variables, then always
   runs `logout` and removes the temporary `HOME`. A separate `always()` step
   removes it again.
5. Enforces hard deadlines on every publisher command: 60 s login, 120 s publish,
   30 s logout. The publisher itself has no HTTP timeout. There is no automatic
   retry. The job itself times out after 20 minutes.
6. Makes up to six read attempts, five seconds apart. The exact version and
   `latest` must both be active and latest, and parsed-equal to `server.json`.
   Success comes only from these reads, never from the publisher's exit code.
   When the reads cannot verify the record, the failure is classified with the
   publisher's result (see below).

Each job uploads sanitized evidence:
`mcp-registry-preflight-<run>-<attempt>` or
`mcp-registry-publication-<run>-<attempt>`.

- **`preflight.json` or `publication.json`** records:
  - source, dispatched and `main` revisions, the version, and the `server.json`
    SHA-256 and size;
  - the run URL, the publisher pin, registry URLs and the registry server version;
  - the decisive and final exact, latest and history observations, each with its
    response time;
  - the environment and deployment checks and the acceptance summary;
  - command exit codes and time-outs, with redacted one-line messages;
  - the verification result and outcome.
- **`mcp-registry-<version>.json`** is the exact-version response, formatted like
  the committed snapshots.

Neither contains tokens, request headers, environment dumps, local paths or the
smoke run's `.local` report. On this public repository, run logs, summaries and
artifacts are readable by any signed-in GitHub user, and artifacts expire after
90 days. In the release record PR:

- Copy `publication.json` (or, for a no-op, `preflight.json`) to
  `docs/evidence/registry-publication-X.Y.Z.json`.
- Copy the snapshot unchanged to `docs/evidence/mcp-registry-X.Y.Z.json`.
- Index the snapshot in
  [`mcp-registry-snapshots.json`](evidence/mcp-registry-snapshots.json):
  - `snapshotFileSha256` from `snapshot.snapshotFileSha256`;
  - `capturedAt` from `snapshot.capturedAt`;
  - `sourceArtifact` = `registry-publication-X.Y.Z.json`;
  - `sourcePointer` = `/snapshot/capturedAt`.

### Outcomes and recovery

| Outcome | Meaning | Next step |
| --- | --- | --- |
| `already-published` | An identical active record exists. In the Publish job this includes a duplicate-version rejection whose read-back matches | Nothing to publish; record the evidence |
| `ready-to-publish` / `awaiting-approval` | Preflight passed | Obtain authorization, then dispatch `publish` or approve |
| `published` | Exact and latest records verified | Record the evidence. `reconciled: true` means the publish command reported a failure but read-back proved the record |
| `failed` (Preflight) | A check stopped the run; nothing was published | Fix the named cause and dispatch again. `registry-conflict` and `registry-not-latest` need a new version instead |
| `not-published` | `publish` was never attempted, or the registry rejected it with HTTP 4xx (including a 1.8.1 validation rejection) and holds no record | Fix the cause, then dispatch again; Preflight rechecks the registry first. A `registry-conflict` or `registry-not-latest` precheck needs a new version; `registry-uncertain` needs a read-only preflight |
| `uncertain` | Timeout, gateway or 5xx response, unverified read-back, or an unexpected error after the publish attempt | **Do not publish again.** Wait, then dispatch `mode=preflight` to reconcile: an identical record means `already-published`; an absent one needs a fresh `publish` dispatch and approval; anything else needs review |
| `conflict` | The registry holds different metadata for this version | Never overwrite. Prepare and release a new version |
| No `publication.json` | The Publish job was cancelled, timed out or lost its runner | Treat as `uncertain` |

Success is established only by read-back. For failures, the publisher's exit
code, timeout and HTTP status separate `not-published` from `uncertain`.
`published` with error `cleanup` means verified, but the temporary login was not
confirmed removed. The runner is discarded after the job, and a separate step
removes the directory again.

Specific cases:

- **Environment check fails:** configure the environment as described above. Do
  not remove the check.
- **`registry-not-latest`:** a higher version is recorded, possibly as deleted.
- **Deployment recheck fails** (for example, after a rollback during the approval
  wait): reconcile the deployment before dispatching again.
- **Login fails:** nothing was published. An `invalid audience` error means the
  pinned publisher no longer matches the registry. Upgrading it is a reviewed
  change to the pinned archive and binary digests.

### Trust boundary

Registry `v1.8.1` exchanges any GitHub Actions OIDC token whose
`repository_owner` is `manifest-network` for publish permission on
`io.github.manifest-network/*`. It does not check the repository, workflow, ref
or environment. That permission also allows changing a version's status (for
example, deprecating or deleting it). The environment approval, main-only
dispatch and preflight checks therefore protect **this workflow**, not the
namespace.

A writer who can run an `id-token: write` workflow in any organization repository
could publish outside this workflow. Direct pushes to `main` are also allowed
when the required `Check`, `Final image` and `Keyring helper` statuses pass,
without review. The pre-publication
registry lookup detects out-of-band records but cannot prevent them. Hardening
organization or branch settings is outside this repository change and needs
owner authorization.

### Local dry run

The same checks can be run locally in `preflight` mode only. Publication is
refused outside the approved Actions workflow.

```sh
node scripts/registry-publication.mjs preflight --version X.Y.Z \
  --source-revision <full commit SHA> --mode preflight \
  --publisher .local/tools/mcp-publisher-v1.8.1/mcp-publisher \
  --output-dir .local/registry-dry-run
```

It fetches the live `main` into `refs/merovingian/main`. It also reads the
approval environment from the GitHub API, sending the shell's `GITHUB_TOKEN`
only if one is set, and reads registry state. For an already published version,
that is all. For an unpublished version, it also calls the registry validation
API and runs the read-only production acceptance suite: at most 21 requests and
zero servings.

## Manual publisher fallback

Use the [GitHub Actions workflow](#github-actions-publication) for normal
publications. The local flow below needs a dedicated PAT. It remains for cases
where Actions is unavailable.

Use the published official `mcp-publisher` CLI. For **Linux x86-64**, the exact
v1.8.1 asset is `mcp-publisher_linux_amd64.tar.gz`. Its SHA-256 is
`a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc`. That digest
was verified against both the
[official release asset metadata](https://api.github.com/repos/modelcontextprotocol/registry/releases/tags/v1.8.1)
and the upstream
[`registry_1.8.1_checksums.txt`](https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/registry_1.8.1_checksums.txt)
on 2026-09-18, and again on 2026-09-22. The extracted binary's SHA-256,
`5e39fe8b6fc3c8b01bed6f1de364b88e9dd10ccbef6d3d3b1a0caa46115bf869`, was computed
from that verified archive on 2026-09-22.

The installer used by the workflow:

1. Downloads only the pinned archive.
2. Checks the archive digest before extracting.
3. Extracts only the binary and checks its digest.
4. Confirms the `1.8.1` version banner.

From the repository root:

```sh
bash scripts/install-mcp-publisher.sh .local/tools/mcp-publisher-v1.8.1
```

For another platform, select its exact release asset and verify its own upstream
digest; the hashes above apply only to the named Linux x86-64 archive.

Generate and check the local metadata, then validate it against the registry:

```sh
npm run registry:generate
npm run registry:check
.local/tools/mcp-publisher-v1.8.1/mcp-publisher validate server.json
```

Validation sends this public JSON to the official registry validation API. It does
not publish and is not an offline check. Do not add credentials or private headers
to the record. Review the exact namespace, version, description, endpoint, and
repository URL before publication. Releases `0.4.3` through `0.4.6` used this manual flow
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

The [GitHub Actions workflow](#github-actions-publication) replaces this PAT
handoff with `login github-oidc`. See the
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
