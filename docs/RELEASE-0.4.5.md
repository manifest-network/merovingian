# Release 0.4.5 — live

This dated record describes the `0.4.5` publication. The current release is
[0.4.6](RELEASE-0.4.6.md); the observations and digests below are historical.

`0.4.5` delivers the ENG-1044 healthcheck fix on the existing mainnet lease.
The user requested release and deployment on 2026-09-21, then completed registry
login and confirmed readiness to publish. Its package/lockfile versions and
generated `server.json` agree; npm dependency versions and prior registry
snapshots are unchanged. The verified image is published and deployed, and
`0.4.5` is active and latest in the official MCP Registry. The separate `0.4.4`
release and its image digest remain historical records.

The image uses Alpine's curl package through a small shell wrapper instead of
starting Node for each probe. Curl handles HTTP parsing, response reads and the
four-second transfer timeout. The wrapper accepts only 2xx responses, discards
the body with a 64 KiB limit, ignores curl configuration and proxy settings, and
requests only `http://127.0.0.1:PORT/healthz` without following redirects.
Docker retains its five-second timeout, 30-second interval, 15-second startup
period and three-failure threshold. No custom C client or compiler stage remains.

The application and wrapper now both require `PORT` to contain only ASCII decimal
digits in the range 1–65535; unset or empty selects 8080. Values with whitespace,
signs, hexadecimal, exponents or decimal points are rejected at startup. This
tightens the application's previous JavaScript numeric coercion so a valid app
configuration cannot disagree with its probe. Serving, persistence and public
API contracts are unchanged.

The exact tested image was published with tag `0.4.5`:

```text
ghcr.io/manifest-network/merovingian@sha256:8e32caa5326f67863fe1fb70153cfc8998fd2cee43119f14d29876e256933d24
```

Its configuration digest is `sha256:cd1f002fa8b473c63d6df6fd4b1fc5231c949a0cf78631dfedb4dbe247e46b26`.
Successful checks and CPU comparisons are recorded in
[candidate evidence](evidence/healthcheck-2026-09-21.json).
The [runtime report](RUNTIME-IMAGE.md#eng-1044-local-validation--2026-09-21) explains
the measurement scope and limitations. Rebuilding produces a new candidate that
requires its own verification; the earlier wget and custom C candidates are superseded.

Anonymous GHCR downloads verified the manifest, configuration and all eleven
layers against the retained candidate. The image's compiled application files,
package metadata and healthcheck also match the checked workspace build. The
merged source is [PR #6](https://github.com/manifest-network/merovingian/pull/6),
commit `0f571a3a1b5191ff587a0caf3109298e1babd931`; its
[main CI](https://github.com/manifest-network/merovingian/actions/runs/35632247019)
passed both Check and Final image.

Provider release **7** reached ready on lease
`01a0b0eb-a2d6-7831-85d6-820bfdb9cfcd`, with manifest hash
`c4cc3855835d3740b983644c1c4bfed740fe7f41bc2ed3bb19f0fba5466cf344`.
The image was the only manifest change: `/data/visits.sqlite`, UID/GID 1000,
public configuration and empty proxy trust were preserved.

Read-only live acceptance passed at **2026-09-21T17:43:16.792Z**. Health,
OpenAPI, both server cards and MCP initialization report `0.4.5`; all four MCP
tools remain discoverable. Counts stayed at **8 cookies, 5 sauna sessions and
6 teas**, totaling 19, with the original start date
`2026-09-17T20:29:18.301Z`. No live visit, payment, additional funding, new lease,
chain transaction or DNS change was performed.

MCP Registry publication completed at **2026-09-21T18:03:55.231121Z** using
official `mcp-publisher` 1.8.1. Exact-version and latest records returned active
`0.4.5` metadata matching the committed `server.json`, verified by
**2026-09-21T18:03:57.501945Z**. The temporary registry login was removed after
verification. The [release evidence](evidence/release-0.4.5.json) and
[saved registry response](evidence/mcp-registry-0.4.5.json) record these results.

Provider CPU/alert behavior and AppArmor enforcement remain unverified by these
checks. Future production actions still require authorization under
[AGENTS.md](../AGENTS.md).
