# Local security remediation evidence — 2026-09-18

This is the combined local candidate for ENG-1037, ENG-1039, ENG-1040 and the
ordinary final-image CI portion of ENG-1041. The earlier
[audit evidence](../security-audit-2026-09-18/README.md) remains unchanged and
describes the original deployed image. No production image, settings or serving
totals were changed by this work.

The candidate manifest/local image ID is
`sha256:a2d5c179ac9e35a06310fa085c53c79bc524a4ae738607228fced39beb6f7525`;
configuration digest is
`sha256:9d0f14ee5db1b4fe6e8fc923010c68040bc9dc0068cbaa2b20c3a4d5c94c2663`.
The export's manifest and configuration bytes were hashed and their binding
checked. The scan identifies the configuration, while this Docker image store's
local ID identifies the manifest. A local tag is not a published image.

| Evidence | Result |
| --- | --- |
| [summary.json](summary.json) | Source-file hashes, base revision, 169 passing tests plus metadata/type/build checks; no production operations |
| [runtime.json](runtime.json) | 9,136 application entries checked; code writes denied on writable root; isolated nonroot/capability/seccomp controls; HTTP/MCP and two intentional local servings; SQLite DELETE journaling and totals/start-date persistence across recreation; clean shutdown |
| [policy.json](policy.json) | Passed with no exceptions: no OS findings, one unfixed low elliptic advisory; no high/critical findings |
| [scanner.json](scanner.json) | Trivy 0.74.0 with database updated September 18, 07:09 UTC |
| [scan-provenance.json](scan-provenance.json) | Tested image/configuration binding, scanner archive checksum, full sanitized scan/SBOM artifact hashes |
| [tls-dns.json](tls-dns.json) | Same immutable candidate: local TLS 1.3 trust/hostname verification and rejection of untrusted certificate; CA roots, libc localhost lookup and loopback DNS query |

The full sanitized vulnerability inventory and CycloneDX SBOM are retained in
the local validation output, with hashes in the provenance file for a separate
remediation attachment in Linear.
The scanner inventories 10 OS packages and 168 language packages. Secret scanning
reported no matches. Scanner OS/EOL metadata limitations and the residual
elliptic assessment are explained in [runtime-image notes](../../RUNTIME-IMAGE.md).
These results do not prove absence of unknown vulnerabilities.

Reproduce the checks using [IMAGE-SECURITY.md](../../IMAGE-SECURITY.md). The runtime
and scan fixtures are repository scripts; the controlled TLS/DNS result is a
sanitized one-off observation using an ephemeral localhost certificate, not a
claim that TLS/DNS fixtures already run in CI. No fixture private key or raw host
inspection is included. `summary.json` identifies the source bytes before
commit; subsequent documentation-only commits do not change that candidate.

Provider running-image/runtime evidence, verified production ingress topology,
and named AppArmor enforcement/attributed denial tests remain open. The CI job
explicitly reports AppArmor verification unavailable. Local code or scan success
does not satisfy those remaining acceptance items or authorize deployment.

Verify these local evidence files with:

```sh
cd docs/evidence/security-remediation-2026-09-18
sha256sum -c sha256sums.txt
```
