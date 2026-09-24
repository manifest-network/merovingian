# Image release

Runtime images are built, verified and published by the manually dispatched
[Release image workflow](../.github/workflows/release-image.yml). Nothing is
built or pushed from a workstation. Releases up to `0.4.6` were built locally and
pushed with personal registry credentials; their records stay as written. `0.4.7`
was the first release through the workflow
([run 36001827755](https://github.com/manifest-network/merovingian/actions/runs/36001827755)).

Publishing an image is a production action. Dispatch `publish` mode only after
the user has authorized publication of that exact version. The existing-lease
update and the [MCP Registry publication](MCP-REGISTRY.md#github-actions-publication)
remain separate operations with their own authorization.

## What the workflow does

The **Build** job has only `contents: read` and `actions: read`. Only `main`'s
dependency-free [`scripts/image-release.mjs`](../scripts/image-release.mjs), the
runner's `docker` and SHA-pinned first-party actions run on its runner; no npm
code does. It:

1. Accepts only a `workflow_dispatch` of this workflow on `main` in this repository.
2. Checks the source revision. It must be a full commit on the live `main`,
   fetched into a ref that `actions/checkout` cannot rewrite. It must be contained
   in the dispatched commit, declare the requested version in `package.json` and
   carry the same `server.json` as `main`, so only the current release can be built.
3. Requires `ghcr.io/manifest-network/merovingian:VERSION` to be absent, proven by
   a typed `MANIFEST_UNKNOWN` 404 from an anonymous read. Published tags are never
   replaced.
4. In `publish` mode, requires the `image-release` environment to be protected (see
   below). A missing environment would otherwise be created without protection.
5. Builds the source revision's Dockerfile for `linux/amd64` with Buildx, with no
   Buildx attestations. The Dockerfile's `RUN` steps stay inside BuildKit
   containers. The image carries `org.opencontainers.image.revision` and
   `org.opencontainers.image.version` labels.
6. Saves the image with `docker image save`. It reads the configuration from the
   saved bytes, checks that it is the labelled `linux/amd64` image for this source,
   and records the image ID, configuration digest and archive SHA-256. It uploads
   the archive as a run artifact kept for 7 days.

The **Check** job has only `contents: read`. It downloads the archive, checks its
SHA-256, loads it and confirms the image ID Build recorded. It then runs the source
revision's `npm ci --ignore-scripts` and `npm run check`, plus the same isolated
runtime checks and pinned advisory scan as the CI
[Final image job](IMAGE-SECURITY.md). Finally it checks that the reports describe
that exact image. Its success gates Publish, but none of its values do.

The Build and Check job summaries show what the approver reviews: version, source
revision and whether it is the release commit, tag state, environment protection,
image ID, configuration digest, archive SHA-256, runtime checks and advisory
policy.

The **Publish** job runs only after both jobs succeed and the deployment is
approved in the `image-release` environment. It has `contents: read`,
`packages: write`, `id-token: write` and `attestations: write`. It:

1. Rechecks the dispatch and tag. An absent tag is pushed, and only while the
   source revision is still the current release on the live `main`. A tag that
   already names the same verified configuration is an idempotent re-run: it needs
   neither the archive nor a login, and still works after the next release lands
   on `main`. Any other tag state refuses.
2. For a push, verifies the downloaded archive against Build's SHA-256, loads it
   and checks the image ID, platform and labels.
3. Logs in to GHCR with the job token, passed on stdin, in a private Docker
   configuration directory. It pushes once, then always logs out and deletes that
   directory.
4. Reconciles a failed push only from anonymous reads. It never retries the push.
5. Verifies the result anonymously: the tag resolves to the pushed digest, the
   digest reference serves the same manifest, the configuration digest equals
   Build's, the configuration bytes match that digest and the platform is
   `linux/amd64`. It downloads every layer and checks its bytes against the
   manifest digest and size, and its uncompressed content against the
   configuration's `diff_ids`. The registry must serve exactly the verified image.
   Manifests must be canonical, so that Docker and containerd, which decode with
   Go's case-insensitive, merging JSON reader, resolve the same content: no
   duplicate or case-variant keys, only the supported fields (no descriptor `urls`
   or inline `data`), the configuration type paired with the manifest type, a
   configuration size equal to its descriptor, and no data after a layer's gzip
   stream.
6. Attests SLSA build provenance for the digest with
   [`actions/attest`](https://github.com/actions/attest). The attestation is signed
   through Sigstore and stored in GitHub's attestation store, not pushed to the
   registry. The job then checks it with `gh attestation verify`.

Sanitized evidence is kept for 90 days in the run's `image-release-build-*`,
`image-release-check-*` and `image-release-publication-*` artifacts. They hold the
preflight, candidate, check, runtime, scan, SBOM, policy and publication records.

## One-time setup

1. **Environment.** Create `image-release` with required reviewers. Disallow
   administrator bypass, and limit deployment branches to the selected branch
   `main`. These are the same settings as `mcp-registry-publish`. The Build job
   refuses `publish` mode until the environment passes this check.
2. **Package access.** In the `merovingian` container package settings, open
   *Manage Actions access*, add `manifest-network/merovingian` and give it the
   **Write** role. The package was first created by a personal push, so the
   workflow's `GITHUB_TOKEN` cannot write to it until then.
3. **Visibility.** Keep the package public. The provider pulls anonymously, and
   the workflow verifies anonymous access.

## Dispatch

Dispatch only after the release PR is merged to `main` and its CI passed, and
after the user has authorized publication of that exact version. Always dispatch
from `main`. Inputs:

- `version`: the reviewed `MAJOR.MINOR.PATCH`, equal to `package.json`.
- `source_revision`: the full 40-character release commit on `main`, normally the
  release merge commit.
- `mode`: `verify` (the default) builds and checks a candidate without publishing
  it. `publish` also requests approval, then pushes and attests that candidate.

Use `publish` for a release. Builds are not reproducible, because the Dockerfile
upgrades Alpine packages at build time. A `verify` run is therefore only a dry
run: a later `publish` run builds and checks its own candidate.

## Approval

Before approving, compare the Build and Check job summaries with the release
notes. The version and release commit must match, the tag must be absent, the
environment protected, and the runtime and advisory checks passed with zero
blocked findings. Approval authorizes pushing exactly the image ID and archive
that Build recorded. Approve within 7 days, while the archive exists.

Rejecting the deployment publishes nothing. Reject a stale approval instead of
letting it wait: a pending run holds the `image-release` concurrency group, so
every later dispatch waits behind it until it is rejected, cancelled or expires
after 30 days.

## After publication

The Publish job summary and evidence record the published digest. Use
`ghcr.io/manifest-network/merovingian@sha256:DIGEST` in the
[existing-lease update workflow](MAINNET.md#existing-lease-update-workflow).
Anyone can check the provenance independently:

```sh
gh attestation verify oci://ghcr.io/manifest-network/merovingian@sha256:DIGEST \
  --repo manifest-network/merovingian \
  --signer-workflow manifest-network/merovingian/.github/workflows/release-image.yml
```

The provenance names the workflow run and the dispatched `main` commit. The source
revision is recorded in the image's `org.opencontainers.image.revision` label and
in the run's evidence.

## Outcomes and recovery

- **`tag-exists` or `tag-conflict`:** the version is already published. Tags are
  immutable, so release a new version.
- **`environment`:** protect `image-release` as described above and dispatch again.
- **`source`:** dispatch the current release from `main`.
- **Push failed and the tag is absent:** re-run the failed Publish job. It reuses
  the same verified archive while it exists (7 days). After that, dispatch again
  for a new candidate.
- **Push outcome unknown:** read the tag anonymously before any re-run.
- **Verification or attestation failed after a push:** re-run the failed Publish
  job. Re-runs ask for approval again, and GitHub allows them for 30 days after the
  run started. The recheck recognizes the same verified image as already
  published, verifies it and attests again without the archive, even after the
  next release has landed on `main`. After 30 days the tag stays without an
  attestation; release a new version if provenance is required.

## Trust boundary

- Build fixes what can be published: the image ID, configuration digest and
  archive SHA-256. No npm code runs on its runner. The source revision's
  Dockerfile runs inside BuildKit containers, and its locked runtime dependencies
  and compiler shape the image, as in any build. The checks cannot detect a
  malicious dependency; they only reject known advisories and broken behavior.
- Check runs the source revision's npm dependencies, including development-only
  tools. It has no write permissions on the repository or package, but its code
  can reach the run's artifact storage. A compromised development dependency
  could make Check pass falsely, or delete or replace this run's artifacts. That
  can block a release or forge artifact evidence, but cannot change what Publish
  pushes: Publish takes identity only from Build's job outputs and hashes the
  archive against them. Build's job summary, with the SHA-256 of its evidence
  files, is the authoritative record.
- The Publish job runs only `main`'s dependency-free script, the runner's `docker`
  and `gh`, and SHA-pinned first-party actions. It uses no npm packages, caches or
  source-revision code. Its token can write this repository's packages and reaches
  `docker` only on stdin.
- The Publish job can mint GitHub OIDC tokens. The MCP Registry trusts such tokens
  from any workflow in the organization (see
  [MCP Registry trust boundary](MCP-REGISTRY.md#trust-boundary)). Adding a step to
  this job widens that boundary.
- The package grant gives Write to every workflow in this repository that
  requests `packages: write`, on any branch, not only this approval-gated job.
  Anyone who can push such a workflow can push to the package. This workflow
  never replaces an existing tag, and it verifies content before adopting a tag
  that already names its configuration, so such a push can block a release but
  not be attested as it. Keep repository write access limited accordingly.
- Builds are not reproducible, so only the archive Build recorded is ever pushed;
  nothing is rebuilt after approval.
