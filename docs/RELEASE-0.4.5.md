# Release 0.4.5 — local candidate

`0.4.5` prepares the ENG-1044 healthcheck fix. Its package/lockfile versions and
generated `server.json` agree; dependency versions and historical registry
snapshots are unchanged. This candidate has not been published, deployed, or
registered. The separate `0.4.4` release and its image digest remain historical
records and must not be relabeled as this fix.

The image runs a small native HTTP probe directly, with no shell, Node startup,
child processes, DNS or proxy use. It reads decimal `PORT`, defaults to 8080 when
unset or empty, and requires a bounded HTTP/1.0 or HTTP/1.1 2xx status line and
complete headers from `127.0.0.1` at `/healthz`. Redirects fail. One four-second
alarm bounds port parsing, connection, request writes and response reads together; Docker retains
its five-second timeout, 30-second interval, 15-second startup period and three
failure threshold. Serving, persistence and public API contracts are unchanged.

The exact **unpublished candidate** is intended for:

```text
ghcr.io/manifest-network/merovingian@sha256:b14340149f00542417f7ebeac69591326d04dc717f9ee9d4940326d928e497c2
```

Its configuration digest is `sha256:77c23d7bd7c94d548f30a30a2ee3a0bebd7e35c0d962bc4fd3005382a4a4ad73`.
Successful checks and CPU comparisons are recorded in
[candidate evidence](evidence/healthcheck-2026-09-21.json).
The [runtime report](RUNTIME-IMAGE.md#eng-1044-local-validation--2026-09-21) explains
the measurement scope and limitations. Rebuilding produces a new candidate that
requires its own verification; the earlier shell/wget candidate is superseded.

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
