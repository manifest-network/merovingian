# Release 0.4.7 — live

`0.4.7` updates the existing mainnet lease to the merged Manifest SDK `0.23.0` and
manifestjs `4.0.0` dependency upgrade
([PR #21](https://github.com/manifest-network/merovingian/pull/21)). Application
behavior, network identity and the remote MCP endpoint are unchanged. Package,
lockfile and generated registry metadata use the same version.

The user authorized each production step on 2026-09-24 and performed the
privileged ones: the Release image dispatch and its `image-release` approval, the
existing-lease update with the protected OS keyring, and the MCP Registry
dispatches and their `mcp-registry-publish` approval. The read-only baseline and
acceptance were separately authorized. The image is published and attested,
provider release **9** is ready, and `0.4.7` is active and latest in the official
MCP Registry. See the [release evidence](evidence/release-0.4.7.json).

## Changes

- The runtime uses `@manifest-network/manifest-sdk@0.23.0` and
  `@manifest-network/manifestjs@4.0.0`, with Manifest's published LCD, Stargate
  and ICS23 forks. The `axios` and `protobufjs` overrides are removed because the
  forks declare the patched versions themselves. The image still contains single
  copies of `axios@1.20.0` and `protobufjs@7.6.6`.
- Application source is unchanged since `0.4.6`. The compiled `dist/` built with
  TypeScript `6.0.3` is byte-identical to the `0.4.6` build with `5.9.3`
  (28 files).
- Operator tooling outside the image adapts to SDK 0.23, including the chain
  identity checks the SDK now performs itself. The keyring helper's Go
  dependencies were also updated ([PR #20](https://github.com/manifest-network/merovingian/pull/20)).
  See [dependencies](DEPENDENCIES.md).
- This is the first release built and published by the
  [Release image workflow](IMAGE-RELEASE.md), rather than on a workstation with
  personal registry credentials. The workflow attests SLSA build provenance for
  the published digest in GitHub's attestation store, verifiable with
  `gh attestation verify` (see [after publication](IMAGE-RELEASE.md#after-publication)).
- It is also the first release to be published through the
  [MCP Registry workflow](MCP-REGISTRY.md#github-actions-publication) rather than
  the manual publisher.

## Recovery

The update workflow does not return to an image it has already deployed, so
`0.4.6` is not a rollback target. If `0.4.7` becomes ready but misbehaves, recover
by [rolling forward](MAINNET.md#updates-recovery-and-restore): revert on `main`,
release the result as a new version through the Release image workflow and apply
it with its own authorization. `0.4.7` does not change persisted data, so a revert
release reads the existing visit counts unchanged.

**Known gap.** If the `0.4.7` update never becomes ready, Fred marks it failed and,
when it can, rolls back to `0.4.6`. The update tool cannot reconcile that case:
`status` resolves an update only when its target becomes active and ready. The
`0.4.7` journal therefore stays `uncertain` and blocks every further update,
including a retry or a roll-forward, until a separately reviewed reconciliation
procedure exists. If Fred's own rollback also fails, the lease ends `Failed`,
`0.4.6` is not serving, and `prepare` refuses any update
(`update_requires_ready_active_release`). The user accepted this gap before
authorizing the update.

## Publication and deployment

Release [PR #23](https://github.com/manifest-network/merovingian/pull/23) merged as
`e3eee336b8a6d4206c4e686d37d6effc8a4003d9`, with a Git tree identical to the
prepared branch; [main CI](https://github.com/manifest-network/merovingian/actions/runs/36000628520)
passed Check, Final image and Keyring helper.

The [Release image workflow run](https://github.com/manifest-network/merovingian/actions/runs/36001827755)
built that commit, the first release through the workflow:

- **Build** confirmed the release commit on the live `main`, an absent `0.4.7` tag
  and a protected approval environment. It recorded image ID and configuration
  digest `sha256:d3add338de15f7e389dfb8d24e818b5fdf78cd7702747c549655bb3d009dbe16`
  and archive SHA-256
  `9c5c5466b440a82f0a2a165d718b5b556faccf10adf12bf13291a5b56ed337ad`.
- **Check** loaded that archive and passed `npm run check`, all seven isolated
  runtime checks (9,223 application files) and the advisory policy with zero
  blockers and zero exceptions. The low, unfixed `elliptic@6.6.1` advisory remains
  reported.
- After approval, **Publish** pushed the candidate once as `0.4.7`:

```text
ghcr.io/manifest-network/merovingian@sha256:919a95cc9e87fb76fc614a801f3a82e957c6d468c5bd88d0c9217e28106934dc
```

It verified anonymously that the tag and digest reference serve that manifest,
that the configuration is the approved one, and that all eleven layers' bytes and
uncompressed content match. It attested SLSA build provenance, which
`gh attestation verify` accepts for `release-image.yml` on `refs/heads/main` at
`e3eee33`. An independent anonymous verification and a cold pull without
credentials also passed.

A read-only baseline of live `0.4.6`, taken with the `0.4.6` commit's own smoke
suite at **2026-09-24T13:03:58.204Z**, made 20 requests and no servings. Counts were
**13 cookies, 8 sauna sessions and 10 teas** (31 total) since
`2026-09-17T20:29:18.301Z`.

The [existing-lease update workflow](MAINNET.md#existing-lease-update-workflow)
then updated lease `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`. The prepared manifest
differed from the active `0.4.6` manifest only in the image. It preserved
`/data/visits.sqlite`, UID/GID `1000:1000`, the public configuration and empty proxy
trust. One journaled update POST applied it. Provider release **9** was observed
ready with manifest hash
`2bea31fdfc2e270870fd9fc2cae73d3b003116745df13d7fe4bbdd5da214a81d` at
**2026-09-24T13:13:26.105Z**. No new lease, funding deposit, chain transaction or
DNS change was performed.

## Live acceptance

The read-only smoke suite from the release commit passed against `0.4.7` at
**2026-09-24T13:13:56.540Z**, with 20 requests, zero serving requests and counters
unchanged during the run. Health reports `0.4.7`. Discovery, HTTP/MCP menu
agreement, indexing and the dashboard passed. Counts matched the pre-update
baseline exactly: **13 cookies, 8 sauna sessions and 10 teas** (31 total), with the
original start date.

## MCP Registry

The [MCP Registry workflow](MCP-REGISTRY.md#github-actions-publication) published
`0.4.7`, its first real publication. A
[preflight run](https://github.com/manifest-network/merovingian/actions/runs/36004311428)
and the [publication run](https://github.com/manifest-network/merovingian/actions/runs/36004427244)
each passed official validation and read-only acceptance (20 requests, zero
servings). The publication rechecked the deployment with two reads. After approval
it logged in with GitHub OIDC and published once at
**2026-09-24T13:16:15.382776Z**. Exact-version and latest records were verified
active, latest and matching `server.json` (SHA-256
`ae262d0cf32da7df7e775a417f59e1fff9bc1cf19cd9a7de7eaed220ab5f0a6a`) by
**2026-09-24T13:16:16.689Z**. The registry login was removed. The
[saved response](evidence/mcp-registry-0.4.7.json) preserves that record.

## Validation

The [sanitized preparation evidence](evidence/release-0.4.7-preparation.json)
records the checks made while preparing the release, before the workflow built
the candidate:

- `npm run check`: all tests, registry consistency, typechecking and build passed
  on the rebased release branch. Historical registry snapshots are unchanged.
- Official `mcp-publisher` 1.8.1 validation accepted the prepared `server.json`.
- Application source is unchanged since `0.4.6`, and the compiled `dist/` is
  byte-identical to the `0.4.6` build.
- A local trial build of the same inputs passed the isolated runtime checks and
  the advisory policy (zero blockers, the known low `elliptic@6.6.1` advisory
  reported), and its 30 application, package and healthcheck files matched the
  workspace build. It was discarded. The workflow repeats the runtime checks and
  the advisory policy on the actual candidate. Instead of a byte comparison with a
  workspace build, it binds the candidate to its source by building the verified
  release commit and labelling the image with it.

No live requests were made during preparation. The live baseline was deferred to
the authorized update and taken at **2026-09-24T13:03:58.204Z** (see
[Publication and deployment](#publication-and-deployment)).

Provider ingress/confinement evidence and named AppArmor verification remain
separate work in ENG-1038 and ENG-1041. This release does not alter provider policy.

**Later follow-up, 2026-09-25:** the planned Merovingian-specific AppArmor
profile and its ENG-1041 runner tests were dropped. Provider enforcement of
`docker-default` is tracked in ENG-1038 (see
[image verification](IMAGE-SECURITY.md#remaining-confinement-acceptance)).
