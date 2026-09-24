# Release 0.4.7 — prepared for review

`0.4.7` packages the merged Manifest SDK `0.23.0` and manifestjs `4.0.0`
dependency upgrade ([PR #21](https://github.com/manifest-network/merovingian/pull/21))
for an update to the existing mainnet lease. Application behavior, network
identity and the remote MCP endpoint are unchanged. Package, lockfile and
generated registry metadata use the same version.

Nothing has been published or deployed. Each of the following needs its own
explicit authorization: image publication, the existing-lease update, read-only
live acceptance and registry publication. The live release and the published
registry record remain `0.4.6` until then.

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
(`update_requires_ready_active_release`). Decide before authorizing the update
whether to accept this gap or to add reconciliation first.

## Publication and deployment plan

Each step needs its own authorization:

1. After this PR merges, dispatch the [Release image workflow](IMAGE-RELEASE.md)
   from `main` in `publish` mode, with version `0.4.7` and the release merge commit
   as `source_revision`. Build and Check produce and check the candidate. Review
   their job summaries against these notes, then approve the `image-release`
   deployment. Publish pushes exactly that candidate as `0.4.7`, verifies it
   anonymously and attests its provenance.
2. Take a read-only baseline of live `0.4.6` with the `0.4.6` release commit's own
   smoke suite: a separate checkout of `6cbce45` with `npm ci`, then
   `npm run smoke -- https://merovingian.manifest.network --mainnet`. The suite
   requires the live version to match its checkout, so `main`'s `0.4.7` suite would
   refuse. Keep its counter snapshot (`servings.before`).
3. Run the [existing-lease update workflow](MAINNET.md#existing-lease-update-workflow)'s
   `prepare` with the published digest, review the exact manifest, then `run`
   lease `01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`. Only the image may change.
4. Run the read-only smoke suite from `main` against `0.4.7` and confirm the
   counts match the baseline, with zero servings.
5. Dispatch the MCP Registry workflow for `0.4.7` in `preflight` mode, then in
   `publish` mode through the `mcp-registry-publish` environment approval.

## Candidate

The candidate does not exist yet. The Release image workflow builds it from the
release merge commit. The Build job records its image ID, configuration digest
and archive SHA-256; the published digest is recorded after publication. Builds
are not reproducible, so a local build, including the one used to prepare these
notes, is not the release candidate.

## Validation

The [sanitized preparation evidence](evidence/release-0.4.7-preparation.json)
records the checks made while preparing the release:

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

No live requests were made during preparation. The live baseline is deferred to
the authorized update so its counter snapshot is current.

Provider ingress/confinement evidence and named AppArmor verification remain
separate work in ENG-1038 and ENG-1041. This release does not alter provider policy.
