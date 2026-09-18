# Runtime image hardening

The [Dockerfile](../Dockerfile) prepares the local ENG-1037 candidate. It does not publish or deploy an image. The dated [original audit](SECURITY-AUDIT-2026-09-18.md) remains a record of release 0.4.3's original Debian image.

## Runtime selection

Both build and runtime stages use official `node:24.21.0-alpine3.24`, pinned to `sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2`. Node 24.21.0 is an LTS release; Alpine 3.24's main repository is supported through 2028-06-01. The Node image maintainers publish this variant. [Node release](https://nodejs.org/en/blog/release/v24.21.0), [official Dockerfile](https://github.com/nodejs/docker-node/blob/main/24/alpine3.24/Dockerfile), [Alpine support schedule](https://alpinelinux.org/releases/).

This replaces the Debian runtime instead of carrying its unused package-management and Perl packages. The original `libpcre2-8-0` and `liblzma5` findings are eliminated by removing those components, not by claiming their Debian versions were patched. The same Alpine base in both stages avoids copying glibc native dependencies into a musl runtime. The tested application dependency tree contains no native `.node` addons; future native dependencies require renewed compatibility checks. [Node image variant guidance](https://github.com/nodejs/docker-node#image-variants).

The runtime stage applies current signed Alpine package updates, explicitly retains the CA bundle, then removes apk, scanelf, musl utilities and unused dependency libraries. npm, npx, Yarn, corepack, Node headers and the inherited shell entrypoint are removed. The APK installed-package database stays present so scanners can inventory the remaining operating-system packages. BusyBox and its shell remain; none of the image's regular files retain SUID/SGID bits. Existing SGID directories only control group inheritance and do not grant executable privileges.

`/app` and its contents are owned by root and have all write bits removed. UID/GID `1000:1000` owns only the application data directory, with mode `0700`; its former home and temporary directories are not writable. Node runs directly as the entrypoint, and the exec-form healthcheck uses the configured port and a four-second request deadline. These image properties complement the read-only root, dropped capabilities, no-new-privileges and resource limits required from the runtime provider.

Base digests and the npm lockfile are pinned. Alpine update repositories still move over time, so rebuilding need not produce identical package versions or bytes. Record and scan each resulting immutable candidate; never substitute a tag for the tested digest.

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
