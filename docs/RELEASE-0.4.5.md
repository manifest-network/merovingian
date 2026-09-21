# Release 0.4.5 — local candidate

`0.4.5` prepares the ENG-1044 healthcheck fix. Its package/lockfile versions and
generated `server.json` agree; npm dependency versions and historical registry
snapshots are unchanged. This candidate has not been published, deployed, or
registered. The separate `0.4.4` release and its image digest remain historical
records and must not be relabeled as this fix.

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

The exact **unpublished candidate** is intended for:

```text
ghcr.io/manifest-network/merovingian@sha256:8e32caa5326f67863fe1fb70153cfc8998fd2cee43119f14d29876e256933d24
```

Its configuration digest is `sha256:cd1f002fa8b473c63d6df6fd4b1fc5231c949a0cf78631dfedb4dbe247e46b26`.
Successful checks and CPU comparisons are recorded in
[candidate evidence](evidence/healthcheck-2026-09-21.json).
The [runtime report](RUNTIME-IMAGE.md#eng-1044-local-validation--2026-09-21) explains
the measurement scope and limitations. Rebuilding produces a new candidate that
requires its own verification; the earlier wget and custom C candidates are superseded.

Publication must name the exact tested candidate digest, preserve its bytes,
and use the `0.4.5` tag. An authorized update must reuse the existing lease and
preserve `/data/visits.sqlite`, UID/GID 1000, public configuration and proxy trust.
Use read-only health, metadata and aggregate-count checks for live acceptance
unless a separate serving scope is authorized. Registry publication is a separate
action after an authorized deployment and acceptance. Provider CPU/alert and
AppArmor acceptance remain unverified locally.

No publication, deployment, registry update or live visit is authorized by this
record. Each production action requires explicit authorization under
[AGENTS.md](../AGENTS.md).
