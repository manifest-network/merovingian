# Merovingian security audit — 2026-09-18

The application has useful security controls, but **the current deployment should not yet be described as fully hardened**. This review found a reproducible MCP operation-limit bypass, fixable image dependencies, writable application files under ordinary writable-root execution, and missing evidence for provider-enforced isolation. No critical or high-severity application exploit was identified within this bounded review; the image scanner did report critical/high package records requiring separate triage.

Audit tracker: [ENG-1036](https://linear.app/liftedinit/issue/ENG-1036). Remediation and provider verification remain open. No production configuration, image, DNS, monitoring or wallet changes were made.

## Audit plan and acceptance status

This pass completes the audit package and local verification. The existing remediation tickets remain separate work. The original scan and public HTTP/TLS observations were already present when this review began; they retain their original timestamps. Fresh local results are recorded separately so they do not imply a new live audit or vulnerability scan.

| Step | Result | Remaining work |
| --- | --- | --- |
| Bind the review to source, release and exact image | Source `11d9e7c`, release `0.4.3`, recorded manifest/configuration digests; local image bytes rechecked | Current provider running-image attestation in ENG-1038 |
| Review public identity, TLS and headers | Original bounded six-request/five-handshake evidence retained and checked for consistency | Point-in-time observations only; no new live requests in this pass |
| Review image contents and advisories | Original dated findings and severity totals verified; image ownership and execution defaults rechecked | Image remediation in ENG-1037; full SBOM and final-image CI in ENG-1041 |
| Review HTTP/MCP and signing boundaries | Source review, full local checks, batch/credit reproductions and Host/Origin matrix | Operation/client limits in ENG-1039; credit transport bounds in ENG-1040 |
| Test local container compatibility | Exact cached image, isolated network, disposable storage, effective process controls and write-boundary checks | Local success does not establish provider enforcement |
| Obtain provider evidence | Required evidence and acceptance criteria specified below | **Open: ENG-1038. Deployment hardening is not attested.** |

## Scope and provenance

- Repository reviewed at `11d9e7cb6554f982e12778819a3a52dbb3f18193`; application version `0.4.3`.
- Recorded deployed image: `ghcr.io/manifest-network/merovingian@sha256:e4014881bfb19e8804785923646a52ee0f515917b6a99b5242dc1106b2d8a6de`.
- Configuration digest: `sha256:c7579b288032d121996496cab6293549ebdf1d054be6c2b640a44f6558160e15`. The local export's manifest and configuration hashes were verified; Trivy analyzed that configuration.
- Live public health reported mainnet `0.4.3` at approximately **18:22 UTC**. This matches the release record, but a public version string does not freshly attest the provider's actual running image digest. See [release provenance](ACCEPTANCE.md).
- Source review covered application inputs, HTTP/MCP handling, outbound chain reads, signing separation, Docker build and deployment constraints. The original application/support/config/WebMCP subset passed **57/57**. Fresh `npm run check` passed registry consistency, typechecking, **148/148 tests** and build on local Node **24.15.0**. Application reproductions used loopback, in-memory SQLite and mocked upstream requests; the image check used the image's own Node runtime.
- Original live scope was six read-only HTTP requests and five TLS handshakes. This completion pass made no additional live requests. No live serving call, payment, stress test, broad port scan or provider mutation occurred.
- The provider host, daemon/kernel, actual container runtime settings and private operator keyring were not inspected. The native signer is outside the hosted image; its separately documented dependency follow-up in [DEPENDENCIES.md](DEPENDENCIES.md) was not rescanned here.

## Findings and required work

Severity below reflects this application's observed exposure. Scanner severity is recorded separately and is not an application exploitability assessment.

| Finding | Assessment | Evidence and action | Tracking |
| --- | --- | --- | --- |
| MCP operation amplification | **Medium; locally reproduced** | One 5,841-byte JSON-RPC batch produced 50 successful `enjoy_amenity` results and 50 real in-memory SQLite increments while consuming one HTTP limiter allowance. Reject batches before execution or charge each operation and bound concurrent work. | [ENG-1039](https://linear.app/liftedinit/issue/ENG-1039) |
| Proxy clients may share the rate-limit bucket | **Medium; topology-dependent** | With `TRUST_PROXY_HOPS=0`, clients represented by different forwarded addresses but the same socket address share the 120-request bucket. The local reproduction got 429 for the second client. Production ingress socket identity was not inspected. Establish trusted ingress handling without accepting spoofable forwarded headers. | [ENG-1039](https://linear.app/liftedinit/issue/ENG-1039), [ENG-1038](https://linear.app/liftedinit/issue/ENG-1038) |
| Fixable image packages and unnecessary tools | **Remediation priority: high; package reachability varies** | The Debian image has fixable PCRE2 and liblzma findings. Nine additional advisories concern globally bundled npm dependencies. npm, Yarn, apt and 11 SUID/SGID utilities remain. Patch/minimize the final runtime and explicitly triage residual findings. | [ENG-1037](https://linear.app/liftedinit/issue/ENG-1037) |
| Application files owned by runtime user | **Medium; defense in depth** | `Dockerfile` copies `dist`, `node_modules` and `package.json` as `node:node`. Their permissions allow the application identity to modify them if the root filesystem is writable. This can aid persistence after an independent compromise. Make application files root-owned and non-writable; retain necessary write access to `/data`. | [ENG-1037](https://linear.app/liftedinit/issue/ENG-1037) |
| Production isolation not attested | **Assurance gap; high priority** | The accepted manifest specifies image/port/environment/user, without read-only root, capabilities, no-new-privileges, seccomp, PID or resource ceilings. This does not prove those controls are absent: the provider may enforce them independently. Obtain sanitized runtime evidence before making a hardening claim. | [ENG-1038](https://linear.app/liftedinit/issue/ENG-1038) |
| Credit reads outlive application deadline | **Low; locally reproduced transport behavior** | `getCredit()` calls SDK `getBalance()`, which starts three LCD requests. At a 100 ms test deadline all three continued, with no AbortSignal, a separate 10-second timeout and unlimited `maxContentLength`. A slow/faulty/malicious configured upstream is required; callers cannot select URLs. Use bounded, cancellable transport for only the required credit data. | [ENG-1040](https://linear.app/liftedinit/issue/ENG-1040) |
| Container controls lack CI enforcement | **Low; regression risk** | CI runs Node checks but does not scan or exercise the final image. Add an exact-image SBOM/scan and isolated ownership, contents, privilege, startup and persistence checks. | [ENG-1041](https://linear.app/liftedinit/issue/ENG-1041) |

Source locations: [`src/app.ts`](../src/app.ts) (`limiter`, `/mcp`), [`src/support.ts`](../src/support.ts) (`getCredit`, `read`), [`Dockerfile`](../Dockerfile), [`scripts/mainnet-update.ts`](../scripts/mainnet-update.ts) (`manifestSchema`), [CI](../.github/workflows/ci.yml).

The batch reproduction used MCP protocol header `2025-03-26`, accepted by the installed transport. It is not a claim about batching support in every MCP protocol version. The cancellation test mocked the installed transport; it establishes the options/cancellation gap, not a production outage or memory-exhaustion demonstration.

## Image dependency results

Trivy **0.74.0**, downloaded from its official release and checked against the published archive checksum, scanned the exported final image. Database timestamp: **2026-09-18T07:09:02Z**; scan completed approximately **18:24:29 UTC**. The image contains Debian **12.15**, Node **24.21.0**, OpenSSL **3.5.8**, built-in Undici **7.29.1**, and SQLite **3.53.4**.

| Scan scope | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Debian package/advisory rows | 4 | 55 | 95 | 72 | 2 |
| Image language package/advisory rows | 0 | 4 | 5 | 1 | 0 |
| Repository `npm audit --omit=dev` dependency paths | 0 | 0 | 0 | 11 | 0 |

These rows use different units. The Debian rows represent **106 unique advisory identifiers**, repeated across binary packages from shared source packages. The language scan contains **10 unique advisories**: nine in `usr/local/lib/node_modules/npm/node_modules`, plus one in `app/node_modules/elliptic`. The npm audit's 11 low paths all lead to the same elliptic advisory. Counts alone should not drive severity or exception decisions.

Concrete updates/removals to evaluate:

- `libpcre2-8-0` **10.42-1 → 10.42-1+deb12u1**, covering three high and three medium records. Debian confirms the security update; this audit did not identify an application path that feeds attacker-controlled expressions to PCRE2. [Debian PCRE2 advisory](https://security-tracker.debian.org/tracker/CVE-2026-86145)
- `liblzma5` **5.4.1-1+deb12u1 → 5.4.1-1+deb12u2**, or remove it if unnecessary. The scan has two advisory identifiers for this update, not necessarily two independent bugs. The upstream issue concerns decoder reinitialization after allocation failure. [Debian status](https://security-tracker.debian.org/tracker/TEMP-1147318-639065), [upstream advisory](https://github.com/tukaani-project/xz/security/advisories/GHSA-5qpq-xqfv-j9pg)
- Remove globally bundled runtime npm/Yarn if unused. The npm tree contains vulnerable `brace-expansion`, `ip-address`, `tar` and `undici`; application dependency overrides do not patch that tree. The npm Undici **6.27.0** findings are distinct from Node's built-in Undici **7.29.1**. [Node release components](https://nodejs.org/en/blog/release/v24.21.0), [brace-expansion advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-rgw5-rvv9-x895)
- The app retains `elliptic@6.6.1`. The hosted application has no signing interface, and operator signing is separately implemented. This narrows exposure without making the dependency scan clean. [Elliptic advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84)

Initial triage of the four scanner-critical OS records:

| Record | Exposure assessment |
| --- | --- |
| `CVE-2023-45853`, `zlib1g` | Debian explicitly states that the affected MiniZip code is not built into the affected Bookworm binary packages. Preserve that vendor disposition rather than call this a demonstrated critical runtime vulnerability. [Debian notes](https://security-tracker.debian.org/tracker/CVE-2023-45853) |
| `CVE-2026-8376`, `perl-base` | The described overflow requires a 32-bit Perl build; the inspected image and Perl package are amd64. No application invocation of Perl was found. [Debian description](https://security-tracker.debian.org/tracker/CVE-2026-8376) |
| `CVE-2026-42496`, `perl-base` | Concerns Archive::Tar extraction. No `Archive/Tar` implementation was found in the inspected standard image directories, and the application does not invoke Perl/archive extraction. Treat as a component-presence/reachability triage item; do not infer remote exploitation from the source-package match. [Debian description](https://security-tracker.debian.org/tracker/CVE-2026-42496) |
| `CVE-2026-13221`, `perl-base` | Concerns Perl regular-expression decisions. No application path invokes Perl. Debian's affected-version table and its introduction-version note also warrant reconciliation before recording a formal exception. [Debian record](https://security-tracker.debian.org/tracker/CVE-2026-13221) |

No blanket critical/high suppression was applied. Other OS records remain in the evidence for package-level triage. A vulnerability scanner does not prove absence of unknown vulnerabilities or complete coverage of statically embedded Node components or the provider kernel.

## Verified controls

The Docker build uses a digest-pinned multi-stage base, locked installation with lifecycle scripts disabled, pruned development dependencies, and an allowlist build context. Final `/app` contains `dist`, `node_modules`, and `package.json`; operator scripts, native signer, local journals and environment files are excluded by the build. The image defaults to the `node` user (UID/GID 1000), port 8080, private `/data` permissions, an exec-form Node command, inherited `docker-entrypoint.sh` entrypoint and shell-form healthcheck.

The application has 8 KB request-body limits, strict tool/input validation, bounded form parameters, escaped HTML, restrictive CSP, scoped Origin rejection, sanitized errors and HTTP request/header/keep-alive timeouts. These server timeouts are not a general handler execution deadline. Public handlers do not accept arbitrary fetch destinations, shell commands or filesystem paths. Runtime code provides no signing/broadcast operation.

Origin checks cover `/api`, `/mcp`, `/visit` and `/operator`: a present Origin must match the configured public origin, while absent Origin is deliberately accepted for non-browser agents. The app does not enforce a Host allowlist, and its MCP transport does not enable the SDK's optional DNS-rebinding protection. A fresh six-case loopback `tools/list` matrix accepted configured and arbitrary Host values with absent/allowed Origin (200) and rejected hostile Origin (403); counters remained zero and no upstream call occurred. Public links use the configured origin. This establishes the application boundary, not a production ingress bypass or sensitive-data exposure; provider host routing and trusted forwarding remain evidence requirements in ENG-1038.

Chain reads compare configured endpoints' reported network identities. Contribution verification checks transaction bytes/hash, reported execution result and the intended tenant/token/amount, but requests `prove=false` and does not independently verify consensus inclusion or finality. Configured HTTPS RPC/LCD services remain trusted for chain state and execution results. The local review found no verification bypass against an honest configured upstream.

The original local image check is retained separately from the fresh, scripted revalidation of the **exact recorded release image**. Revalidation recomputed the exported manifest/configuration hashes and passed with no external network, read-only root, all capabilities dropped, no-new-privileges, configured PID limit 64, 512 MiB memory and 0.5 CPU. `/data` used disposable tmpfs with effective `noexec,nosuid,nodev`. Health/menu/stats returned 200; counts remained zero; writing a new file under `/app/dist` failed with `EROFS`, `/data` writes succeeded, and graceful termination exited zero. Process inspection confirmed UID/GID 1000, all capability sets zero, `NoNewPrivs=1` and seccomp filter mode 2. Resource settings were inspected, not stress-tested; tmpfs does not test persistence across replacement. These are local compatibility results, not provider-enforcement evidence. [Docker runtime controls](https://docs.docker.com/engine/containers/run/)

Live TLS checks accepted TLS 1.2/1.3 with certificate validation and received protocol-version alerts for TLS 1.0/1.1. The certificate expires **2026-12-16T18:58:18Z**. Plain HTTP redirected to HTTPS with 308. HTTPS responses included HSTS, CSP, anti-framing and `nosniff`; an untrusted Origin received 403. The ingress appears to override the application's `Referrer-Policy: no-referrer` with `strict-origin-when-cross-origin`; this is a policy difference to document, not a demonstrated data leak. Advertising the HSTS `preload` token does not establish actual browser preload-list membership.

## AppArmor follow-up

**AppArmor enforcement was not verified in this audit**, either on the provider or in the earlier local container check. A seccomp result does not establish AppArmor confinement. The provider must support and attach the policy at the host/container-runtime boundary; adding a profile to the Docker image alone does not activate it. Docker normally uses `docker-default` when AppArmor is available, but this must be checked for the actual running container. [Docker AppArmor documentation](https://docs.docker.com/engine/security/apparmor/)

The least disruptive first step in [ENG-1038](https://linear.app/liftedinit/issue/ENG-1038) is to obtain sanitized evidence of host support, the container's attached profile and the application's effective **enforce** mode. A loaded profile or a configuration value alone is insufficient; complain mode is not acceptable as the production enforcement result. If the provider uses another Linux security module, record its actual confinement and the AppArmor availability gap rather than assuming AppArmor exists.

After confirming support, prepare a named Merovingian-specific profile in this repository, attached only to this service. Its proposed scope is:

- Permit required Node/loader/library/configuration reads, Node/V8 runtime memory behavior, DNS resolver and TLS CA access, inbound HTTP, healthchecks and container-runtime termination signals. SQLite currently uses DELETE journaling: permit database and `visits.sqlite-journal` creation, locking, writes and deletion; WAL/SHM permissions are conditional on a future journal-mode change.
- Restrict application-data writes to `/data`, with narrowly justified device/runtime exceptions; prevent code/dependency modification and unnecessary executable launches, mount operations, ptrace and raw sockets where supported.
- Account for the inherited `docker-entrypoint.sh` and **shell-form healthcheck**. Denying shell execution immediately would break startup and healthchecks; first prepare an explicit Node entrypoint and exec-form healthcheck, or justify narrow execution permissions.
- Retain nonroot execution, read-only root, dropped capabilities, no-new-privileges and seccomp. AppArmor is an additional restriction, not a fix for MCP rate limits or vulnerable packages. Do not claim it provides a hostname-based outbound allowlist.

[ENG-1041](https://linear.app/liftedinit/issue/ENG-1041) will require an AppArmor-capable isolated runner for positive application tests and negative confinement tests. Attribute expected denials to the named AppArmor profile using sanitized audit evidence; a failure caused only by file ownership, a read-only mount or seccomp does not prove AppArmor worked. Verify profile attachment and enforce mode across restart/recreation. An unsupported runner must report that verification is unavailable, not pass it silently. Production policy loading or attachment remains a separately authorized provider action; no host policy was loaded or changed during this follow-up.

## Completion path

The audit package and local verification are ready for review. The provider-evidence acceptance item remains open; public health responses and the repository's provider status/release API do not expose effective runtime controls. No provider host access or sanitized runtime attestation was available in this review, and no request was sent to the provider.

For **ENG-1038**, the provider operator should supply the following allowlisted evidence, timestamped and bound to the existing Merovingian lease and current immutable image digest. Report each control as observed/enforced, unsupported, or unknown; unknown must not be recorded as passing.

| Evidence | Acceptance requirement |
| --- | --- |
| Release binding | Observation time, lease identifier, running manifest/configuration digest and release version; reconcile with the recorded release above |
| Process identity and privilege | Effective application UID/GID, all capability sets, `NoNewPrivs`, seccomp mode/profile, `privileged=false`; distinguish runtime configuration from effective process state |
| LSM confinement | Host support, attached AppArmor profile and application enforce mode, or named effective alternative and the AppArmor gap; a loaded profile alone is insufficient |
| Filesystems | Read-only root status, mount destination/type/read-write flags and purpose, bounded writable `/data`; omit host source paths, environment values and volume identifiers |
| Isolation | No Docker/runtime socket mounts, unexpected devices or host PID/IPC/network namespaces; attest checks without publishing raw host inspection |
| Limits and lifecycle | Effective memory/CPU/PID cgroup limits plus health/restart configuration and observed status; SKU sizes alone are insufficient |
| Networking | Published port/protocol scope, ingress routing/Host handling, authenticated proxy topology and forwarded-header policy, network isolation and outbound restrictions or explicit gaps |

After evidence collection, the remediation order is:

1. Patch/minimize the runtime image and protect code ownership (ENG-1037); close operation/client limiting gaps (ENG-1039).
2. Bound and cancel credit transport (ENG-1040); add final-image scanning and isolation checks (ENG-1041).
3. Review residual advisory dispositions and provider-supported runtime controls (ENG-1038). Prepare any service-specific confinement policy and test it locally before proposing production attachment.
4. Publish/deploy a reviewed candidate or change provider settings only with separate explicit authorization for that concrete action under [AGENTS.md](../AGENTS.md).

Existing monitoring/TLS and counter-backup tickets remain separate; no duplicate tickets were created for them. Counter backups remain deferred as recorded in the project plan. This report is a dated audit with outstanding remediation, not a certification that the service is secure.

## Evidence and reproduction

[Evidence index](evidence/security-audit-2026-09-18/README.md) distinguishes original observations from fresh local revalidation. It includes reported package/advisory findings, npm results, live HTTP/TLS observations, local container/application results, reproducible fixtures and checksums. The vulnerability findings are not a complete installed-package inventory or SBOM; raw original scan/export artifacts are not archived here. Checksums establish file consistency, not independent authentication of observations. Public results exclude credentials, personal filesystem paths and operation journals.

The [local reproducer](evidence/security-audit-2026-09-18/reproduce-local.mjs.txt) is archived as inert text. To rerun, copy it to a temporary `.mjs` file and execute it with `node --import tsx` from the repository root. It starts a loopback-only server, uses in-memory counts and mocks upstream HTTP; it never targets production. The archived original result is [local-application-checks.json](evidence/security-audit-2026-09-18/local-application-checks.json).

To repeat the image scan, export the exact digest above and run `trivy image --input IMAGE_ARCHIVE --scanners vuln --format json`, recording the scanner version and database timestamp. New databases can produce different counts; compare package identities and advisory dispositions rather than assuming this snapshot remains current.
