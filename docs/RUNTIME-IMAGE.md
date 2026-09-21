# Runtime image hardening

The [Dockerfile](../Dockerfile) builds the runtime image. Building it does not publish or deploy an image. The dated [original audit](SECURITY-AUDIT-2026-09-18.md) remains a record of release 0.4.3's original Debian image.

## Runtime selection

Both build and runtime stages use official `node:24.21.0-alpine3.24`, pinned to `sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2`. Node 24.21.0 is an LTS release; Alpine 3.24's main repository is supported through 2028-06-01. The Node image maintainers publish this variant. [Node release](https://nodejs.org/en/blog/release/v24.21.0), [official Dockerfile](https://github.com/nodejs/docker-node/blob/main/24/alpine3.24/Dockerfile), [Alpine support schedule](https://alpinelinux.org/releases/).

This replaces the Debian runtime instead of carrying its unused package-management and Perl packages. The original `libpcre2-8-0` and `liblzma5` findings are eliminated by removing those components, not by claiming their Debian versions were patched. The same Alpine base in both stages avoids copying glibc native dependencies into a musl runtime. The tested application dependency tree contains no native `.node` addons; future native dependencies require renewed compatibility checks. [Node image variant guidance](https://github.com/nodejs/docker-node#image-variants).

The runtime stage applies current signed Alpine package updates, explicitly retains the CA bundle, then removes apk, scanelf, musl utilities and unused dependency libraries. npm, npx, Yarn, corepack, Node headers and the inherited shell entrypoint are removed. The APK installed-package database stays present so scanners can inventory the remaining operating-system packages. BusyBox and its shell remain; none of the image's regular files retain SUID/SGID bits. Existing SGID directories only control group inheritance and do not grant executable privileges.

`/app` and its contents are owned by root and have all write bits removed. Application artifact modes are set in the build stage and preserved by `COPY`; the final stage strips SUID/SGID bits after all application copies, including dependency files. This avoids a recursive final-stage chmod that would duplicate application file payloads in another image layer. UID/GID `1000:1000` owns the persistent application data directory, with mode `0700`; its former home is not writable. Node runs directly as the entrypoint.

The exec-form healthcheck uses BusyBox `wget`, avoiding a fresh Node VM inside the tenant's CPU quota every 30 seconds (ENG-1044). Its shell expands `PORT`, defaulting to 8080 when unset or empty, then replaces itself with `wget`. The loopback `/healthz` request bypasses HTTP proxies, discards the response body, and fails on HTTP or connection errors. The network timeout is four seconds; Docker retains its five-second outer timeout, 15-second startup period and three-failure threshold. Local image checks exercise these behaviors with an isolated HTTP fixture and the application on both default and custom ports.

The image retains conventional sticky mode `1777` on `/tmp` and `/var/tmp`, allowing temporary-file APIs during ordinary writable-root execution. A read-only runtime must provide a bounded writable `/tmp` tmpfs with `noexec,nosuid,nodev` and mode `1777`; the local fixture allocates 16 MiB and tests Node temporary-directory creation, writing and cleanup. `/var/tmp` need not be separately writable in that configuration. Temporary files are disposable, while durable SQLite data belongs under `/data`. These image properties complement the read-only root, dropped capabilities, no-new-privileges and resource limits required from the runtime provider.

Base digests and the npm lockfile are pinned. Alpine update repositories still move over time, so rebuilding need not produce identical package versions or bytes. Record and scan each resulting immutable candidate; never substitute a tag for the tested digest.

## ENG-1044 local validation — 2026-09-21

The [healthcheck fix](https://linear.app/liftedinit/issue/ENG-1044) follows three steps: replace the per-probe Node startup while retaining readiness behavior, exercise the actual image command against successful and failing HTTP fixtures, and compare scheduled probes under CPU limits. All three local steps are complete. The [sanitized evidence](evidence/healthcheck-2026-09-21.json) identifies the exact candidate and records the checks and CPU counters.

`npm run check` passed all 193 tests, metadata consistency, typechecking and build. The final-image runtime check passed, including default/custom application ports, healthcheck failure handling and SQLite persistence. The image scan passed the existing advisory policy with the previously reported low, unfixed `elliptic` advisory still visible and no exceptions.

Each CPU comparison used two disposable containers of the same candidate, restoring the previous Node health command in one container. Both used the unchanged 30-second probe interval, 512 MiB memory, read-only root, no external network, dropped capabilities and no-new-privileges. After healthy startup and ten seconds of settling, host reads of the container cgroup counters bracketed a 65-second idle window. No measuring processes ran inside those cgroups. Each window contained two successful scheduled probes and no visits.

| CPU limit | Probe | Window CPU time | Added throttled periods | Added throttled time |
| --- | --- | ---: | ---: | ---: |
| 0.1 | Node baseline | 514.0 ms | 49 | 5,309.3 ms |
| 0.1 | BusyBox wget | 134.6 ms | 11 | 717.4 ms |
| 0.5 | Node baseline | 387.0 ms | 6 | 429.8 ms |
| 0.5 | BusyBox wget | 53.4 ms | 0 | 0 ms |

At the lease's stated 0.5-CPU quota, the local candidate used 86% less CPU over the window and its throttling counter stayed flat. The stricter 0.1-CPU run improved CPU time by 74% and throttled time by 87%, but did **not** meet the issue's expectation of a flat throttling counter at that limit. These are short observations of the whole container, including application work and Docker execution overhead; they do not establish a two-millisecond per-process cost or predict provider alert clearance.

Publication and an existing-lease update remain separate actions requiring explicit authorization under [AGENTS.md](../AGENTS.md). After an authorized update, verify read-only health and provider CPU/throttling metrics, then check the alert over its evaluation window. The related monitoring-rule change in ENG-1043 is outside this repository change.

## Local validation snapshot — 2026-09-18

The initial runtime candidate was built as `merovingian:eng-1037-local` while application remediation was still underway. It identifies the runtime validation snapshot below; the final combined application candidate must be rebuilt and checked separately using [the image verification workflow](IMAGE-SECURITY.md).

- Image manifest: `sha256:aa88ccc7331a24c79fb43c45b091b319a9422e6d05798a0bc8bfbe5d2eda3765`.
- Image configuration: `sha256:e26e1132c21a07242659497cafadd7b65b82b15695bb1b4c71cdd841300bf467`.
- Runtime: Node `24.21.0`, built-in OpenSSL `3.5.8`, Undici `7.29.1`, SQLite `3.53.4`; effective Alpine release `3.24.2` on amd64.
- Trivy `0.74.0`, verified official Linux archive SHA-256 `2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a`; database updated `2026-09-18T07:09:02Z`, downloaded `2026-09-18T18:54:08Z`, scan completed approximately `18:54:55Z` (database age under 12 hours). The exported image's configuration hash matches the scanned configuration. [Scanner release](https://github.com/aquasecurity/trivy/releases/tag/v0.74.0).
- Full package inventory, vulnerability JSON and CycloneDX SBOM were produced locally. The scan inventoried 10 Alpine packages and 168 language packages: **zero OS vulnerability rows, zero high/critical language rows, one low language row**. No vulnerability suppression was applied.

The ten OS packages are `alpine-baselayout`, `alpine-baselayout-data`, `alpine-keys`, `alpine-release`, `busybox`, `busybox-binsh`, `ca-certificates-bundle`, `libgcc`, `libstdc++` and `musl`. The scanner labels the OS `3.24.1` from the base, whereas direct reads of the final `/etc/os-release`, `/etc/alpine-release` and installed-package metadata show `3.24.2`; both select the same Alpine `3.24` advisory branch. Trivy also warns that this branch is missing from its embedded EOL list. The official Alpine support schedule above establishes current support; the warning is retained as a scanner metadata limitation.

The remaining finding is `CVE-2025-14505` / `GHSA-848j-6mx2-7j84`, `elliptic@6.6.1`, at `app/node_modules/elliptic/package.json`, with no fixed version reported. It comes through the application's Manifest/CosmJS dependency tree. The hosted application has no signing interface and receives no private key, which narrows exposure without establishing a general exception for the library. The low unfixed finding remains visible under the image gate's policy; it is not suppressed. Operator signing is separate and was not exercised. [Advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84), [dependency scope](DEPENDENCIES.md).

A separate local container compatibility check at `18:58 UTC` passed actual TLS 1.3 HTTPS against an ephemeral trusted localhost certificate and rejected that certificate when using the default trust store. The runtime retained 121 built-in CA roots and the system CA bundle. libc localhost lookup and one DNS A query through a loopback UDP fixture passed. The container had network `none`, read-only root, no capabilities and no-new-privileges; the fixture contacted no external endpoint. Its private key existed only in temporary storage and process memory and was removed afterward. This validates local DNS/TLS operation, not production routing, public certificate validity or provider confinement.

The image verification workflow separately checks ordinary-rootfs code-write denial, effective process controls, health, MCP behavior, SQLite DELETE journaling and persistence across disposable container replacement, and graceful shutdown. Provider runtime/AppArmor enforcement and production deployment remain separate acceptance items requiring their own evidence and authorization.
