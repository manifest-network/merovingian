# Security audit evidence — 2026-09-18

This directory supports the bounded [ENG-1036 audit](../../SECURITY-AUDIT-2026-09-18.md). The six artifacts listed below and their checksum file already existed at the start of this review. They are inherited audit evidence, not newly performed image scans, container executions or live checks. The original source snapshot is `11d9e7cb6554f982e12778819a3a52dbb3f18193`, application version `0.4.3`.

| Artifact | Classification and limits |
| --- | --- |
| [image-vulnerabilities.json](image-vulnerabilities.json) | Sanitized scan summary, dated 2026-09-18. Records the image/configuration digests, Trivy 0.74.0, database timestamp and all reported package/advisory rows. It is not a complete installed-package inventory or SBOM. |
| [npm-runtime-audit.json](npm-runtime-audit.json) | Archived production dependency audit of the repository lockfile, dated 2026-09-18. Its scope excludes base OS packages and globally bundled npm dependencies. |
| [live-read-only.json](live-read-only.json) | Archived public HTTP/TLS observations at approximately 18:22 UTC on 2026-09-18. Records six HTTP requests and five TLS handshakes; no serving operation. Public version/headers do not attest provider runtime settings or the running image digest. |
| [local-container-check.json](local-container-check.json) | Transcribed observations from the earlier disposable local image check, dated 2026-09-18. Supports local compatibility under the recorded restrictions. No raw Docker transcript or AppArmor enforcement evidence is included. It does not establish provider enforcement. |
| [local-application-checks.json](local-application-checks.json) | Archived application reproduction results and 57-test summary, dated 2026-09-18. Uses in-memory SQLite and mocked upstream transport. The test summary is not a full test-run transcript. |
| [reproduce-local.mjs.txt](reproduce-local.mjs.txt) | Inert copy of the application reproducer. It binds only to loopback, stores counts in memory and mocks the credit-query transport. Assertions describe the vulnerable source snapshot; remediation can intentionally invalidate them. |

All six original hashes in [sha256sums.txt](sha256sums.txt) were verified during this review. The stored severity totals also recompute from the archived findings: 228 Debian package/advisory rows covering 106 unique identifiers, and 10 language rows covering 10 identifiers. Nine language rows belong to globally bundled npm; one belongs to the application's elliptic dependency.

The checksum manifest establishes consistency of these local files. It is not a signature or independent authentication of the original observations. The archive does not contain the raw registry manifest/configuration blobs, exported image, complete Trivy output, scanner archive or complete SBOM. The scanner release checksum verification remains an observation from the original audit. The fresh container fixture independently recomputed image manifest/configuration hashes from a temporary local export; rerunning that verification requires the exact cached image. A newer scanner database can change vulnerability results.

## Fresh local revalidation

The following additions record this completion pass, separately from the original six artifacts. No new live requests or vulnerability scan were performed. The application source and lockfile remain unchanged at the original revision.

| Artifact | Result and limits |
| --- | --- |
| [local-revalidation.json](local-revalidation.json) | Sanitized execution summary: `npm run check` passed metadata, typechecking, 148 tests and build on local Node 24.15.0; all four archived application proofs reproduced. Includes source checksums. It is a summary, not a raw test transcript. |
| [local-container-revalidation.json](local-container-revalidation.json) | Fresh exact-image manifest/config hash verification and isolated execution: nonroot, read-only code filesystem, writable disposable `/data`, zero capabilities, no-new-privileges, seccomp, configured resource limits, zero servings and graceful stop. No provider enforcement, AppArmor, persistence-across-replacement or stress-test claim. |
| [reproduce-container.py.txt](reproduce-container.py.txt) | Inert Python fixture for the preceding result. Uses the local Docker socket and exact cached image with `--pull never`, network `none`, no published ports or host binds, and disposable tmpfs. Exports image bytes temporarily and removes its container/archive on normal completion or failure. Requires an OCI-layout Docker image export. |
| [local-http-boundaries.json](local-http-boundaries.json) | Six loopback `tools/list` requests using `node:http`, with each Host value asserted as received by the server: configured/arbitrary Host with absent/allowed Origin accepted; hostile Origin rejected. No upstream calls or serving increments. Does not test provider routing. |
| [reproduce-http-boundaries.mjs.txt](reproduce-http-boundaries.mjs.txt) | Inert source-snapshot fixture asserting the Host/Origin matrix. Remediation can intentionally change these observations. |

[revalidation-sha256sums.txt](revalidation-sha256sums.txt) covers this index and the five additions above. The original checksum file and six original artifacts are unchanged.

## Local reproduction

From the repository root, verify the original artifacts without contacting any service:

```sh
(cd docs/evidence/security-audit-2026-09-18 && sha256sum -c sha256sums.txt)
(cd docs/evidence/security-audit-2026-09-18 && sha256sum -c revalidation-sha256sums.txt)
```

With Node 24 or newer and the repository's locked dependencies already installed, run the archived application reproducer from the repository root. The subshell removes its temporary executable copy on exit:

```sh
(
  set -eu
  audit_reproducer=$(mktemp "${TMPDIR:-/tmp}/merovingian-audit.XXXXXX.mjs")
  trap 'rm -f "$audit_reproducer"' EXIT
  cp docs/evidence/security-audit-2026-09-18/reproduce-local.mjs.txt "$audit_reproducer"
  node --import tsx "$audit_reproducer"
)
```

Expected output contains four proof records: 50 successful MCP operations and 50 in-memory increments from one request, a shared proxy bucket returning 429, three mocked credit queries still outstanding after the application deadline, and those queries subsequently settling. No production counter or upstream service is involved. Preserve any fresh output separately with its source revision and execution date; do not overwrite the archived result or treat it as a current-production measurement.

Run `npm run check` for the complete local checks. They need loopback socket and temporary helper-process permissions; a sandbox permission failure is not a successful check. To reproduce the Host/Origin matrix, use the same temporary-copy command above with `reproduce-http-boundaries.mjs.txt` as its input.

To repeat the exact-image check with Python 3 and access to the local Docker daemon:

```sh
python3 docs/evidence/security-audit-2026-09-18/reproduce-container.py.txt
```

The fixture fails if the recorded image is absent; it never pulls or rebuilds an image. It needs temporary space for an image export. Requests stay inside the isolated container and only read health, menu and stats. SQLite initialization and a file-write probe use disposable tmpfs. Node's API reports this as `storage: persistent` because it is file-backed; the temporary mount is not retained after the fixture. Unsupported image archive layout or missing runtime controls fail rather than silently passing.

## Acceptance boundaries

| Audit area | Evidence available | Outstanding acceptance evidence |
| --- | --- | --- |
| Application exposure | Source review, reproduced local proofs, fresh 148-test check and Host/Origin observations | Remediation and regression coverage for operation limits/proxy handling (ENG-1039) and credit transport bounds/cancellation (ENG-1040). |
| Dependency and image contents | Dated vulnerability rows, critical-record triage and recorded ownership/package-manager observations | Patched/minimized candidate image, full package inventory/SBOM and explicit residual-advisory dispositions (ENG-1037). |
| Container isolation | Original observations plus fresh exact-image hash verification and scripted local compatibility checks | Sanitized provider evidence tied to the actual running digest, including effective controls and AppArmor or other LSM enforcement (ENG-1038). Local results do not satisfy this requirement. |
| Continued enforcement | Current CI source review | Final-image CI checks and positive/negative AppArmor tests on a capable isolated runner, with unsupported verification reported explicitly (ENG-1041). |
| Public endpoint behavior | Dated HTTP/TLS observations | These observations are a point-in-time snapshot; they establish neither ongoing monitoring nor complete provider security. |

The report can record the completed bounded audit while these remediation and provider-assurance items remain open. Production changes require separate explicit authorization under [AGENTS.md](../../../AGENTS.md). Credentials, wallet material, operation journals and personal filesystem paths must remain outside public evidence.
