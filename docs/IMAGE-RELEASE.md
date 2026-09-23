# Image release

Runtime images are built, verified and published by the manually dispatched
[Release image workflow](../.github/workflows/release-image.yml). Nothing is
built or pushed from a workstation. Releases up to `0.4.6` were built locally and
pushed with personal registry credentials; their records stay as written.

Publishing an image is a production action. Dispatch `publish` mode only after
the user has authorized publication of that exact version. The existing-lease
update and the [MCP Registry publication](MCP-REGISTRY.md#github-actions-publication)
remain separate operations with their own authorization.

## What the workflow does

The **Verify** job has only `contents: read` and `actions: read`. It:

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
5. Checks out the source revision and runs `npm ci --ignore-scripts` and
   `npm run check` there. It then builds a `linux/amd64` image with Buildx, with
   no Buildx attestations. The image carries `org.opencontainers.image.revision`
   and `org.opencontainers.image.version` labels.
6. Runs the same isolated runtime checks and pinned advisory scan as the CI
   [Final image job](IMAGE-SECURITY.md).
7. Binds the runtime, scan and policy reports to that one image ID. It then saves
   the image with `docker image save` and records the archive's SHA-256. In
   `publish` mode it uploads the archive as a one-day artifact of the run.

The job summary shows what the approver reviews: version, source revision and
whether it is the release commit, tag state, environment protection, runtime
checks, advisory policy, image ID (configuration digest) and archive SHA-256.

The **Publish** job runs only after approval in the `image-release` environment.
It has `contents: read`, `packages: write`, `id-token: write` and
`attestations: write`. It:

1. Rechecks the dispatch, source revision and tag. An absent tag is pushed. A tag
   that already names the same verified configuration is an idempotent re-run.
   Any other tag state refuses.
2. Verifies the downloaded archive's SHA-256, loads it and checks the image ID,
   platform and labels.
3. Logs in to GHCR with the job token, passed on stdin, in a private Docker
   configuration directory. It pushes once, then always logs out and deletes that
   directory.
4. Reconciles a failed push only from anonymous reads. It never retries the push.
5. Verifies the result anonymously: the tag resolves to the pushed digest, the
   digest reference serves the same manifest, the configuration digest equals the
   verified one, the platform is `linux/amd64` and every layer is readable.
6. Attests SLSA build provenance for the digest with
   [`actions/attest`](https://github.com/actions/attest). The attestation is signed
   through Sigstore and stored in GitHub's attestation store, not pushed to the
   registry. The job then checks it with `gh attestation verify`.

Sanitized evidence is kept for 90 days in the run's `image-release-verify-*` and
`image-release-publication-*` artifacts: preflight, candidate, runtime report,
scan, SBOM, policy and publication records. The candidate archive expires after
one day.

## One-time setup

1. **Environment.** Create `image-release` with required reviewers. Disallow
   administrator bypass, and limit deployment branches to the selected branch
   `main`. These are the same settings as `mcp-registry-publish`. The Verify job
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
- `mode`: `verify` (the default) builds and checks a candidate and discards it.
  `publish` also requests approval, then pushes and attests that candidate.

Use `publish` for a release. Builds are not reproducible, because the Dockerfile
upgrades Alpine packages at build time. A `verify` run is therefore only a dry
run: a later `publish` run builds and checks its own candidate.

## Approval

Before approving, compare the Verify job summary with the release notes. The
version and release commit must match, the tag must be absent, the environment
protected, and the runtime and advisory checks passed with zero blocked findings.
Approval authorizes pushing exactly the image ID and archive shown there.
Rejecting the deployment, or letting it expire, publishes nothing.

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
  the same verified archive while the artifact exists (one day). After that,
  dispatch again for a new candidate.
- **Push outcome unknown:** read the tag anonymously before any re-run.
- **Verification or attestation failed after a push:** re-run the failed Publish
  job. The recheck recognizes the same verified image as already published,
  verifies it and attests again.

## Trust boundary

- The Verify job runs the source revision's own npm dependencies, checks and
  Dockerfile, with read permissions only. A compromised dependency could produce
  a bad candidate but cannot push it. The checks and the approver are the gate.
- The Publish job runs only `main`'s dependency-free
  [`scripts/image-release.mjs`](../scripts/image-release.mjs), the runner's
  `docker` and `gh`, and SHA-pinned first-party actions. It uses no npm packages,
  caches or source-revision code. Its token can write this repository's packages
  and reaches `docker` only on stdin.
- The Publish job can mint GitHub OIDC tokens. The MCP Registry trusts such tokens
  from any workflow in the organization (see
  [MCP Registry trust boundary](MCP-REGISTRY.md#trust-boundary)). Adding a step to
  this job widens that boundary.
- Only the verified archive is ever pushed; nothing is rebuilt after approval.
