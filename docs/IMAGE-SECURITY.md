# Candidate image verification

The final-image CI job builds a local candidate without publishing it, checks
runtime isolation and SQLite persistence, then scans the same immutable local
image. It uses a pinned Trivy 0.74.0 binary with its verified release checksum.
Repository permissions are read-only and the job receives no deployment secrets.
Only explicitly listed JSON evidence is uploaded, retained for 14 days; image
archives, scanner caches and full Docker inspections are excluded.

Run the same checks locally on Linux with Node 24, installed locked dependencies,
Python 3 and the local Docker daemon:

```sh
mkdir -p .local/image-security
docker --host unix:///var/run/docker.sock build --tag merovingian:local --iidfile .local/image-security/image-id .
node scripts/check-runtime-image.mjs "$(cat .local/image-security/image-id)" .local/image-security/runtime.json
bash scripts/scan-runtime-image.sh "$(cat .local/image-security/image-id)" .local/image-security
```

The runtime fixture never pulls an image, exposes ports, mounts host directories
or accesses the live refuge. It creates and deletes its own containers and named
volume. Two intentional MCP servings occur only in that isolated fixture to
verify SQLite DELETE-journal behavior and persistence across container
replacement. Ownership is checked recursively; a separate writable-root test
proves code writes fail for UID 1000 independently of the read-only filesystem.
The main application runs with no network, all capabilities dropped,
no-new-privileges, read-only root, and explicit memory/CPU/PID limits. Process
UID/GID, capabilities and seccomp are checked, as are the exec healthcheck,
single MCP operation, batch rejection, serving totals and graceful shutdown.
Docker resource settings are inspected; the fixture is not a stress test.

The scan generates a [CycloneDX SBOM](https://trivy.dev/docs/latest/supply-chain/sbom/),
sanitized vulnerability JSON with package inventory, database timestamp, configuration
digest and artifact checksums. Database evidence must be no more than 48 hours
old, the scanner must include populated OS and Node package inventories, and the image OS must
not be reported end-of-life. The policy fails on every finding with an available
fix and every high/critical finding, including those without a fix. Other
findings remain visible in `policy.json`. Secret scanning also runs on the image;
any detected credential blocks acceptance. Matched secret bytes, Docker image
environment/build history and personal scan-input paths are omitted from public
artifacts; raw scanner output remains in the ignored `private` directory. A
passing gate is not a clean security
certification or proof of exploitability.

`security/image-exceptions.json` is initially empty. Any proposed exception must
identify exactly one advisory/package/version/target/path, provide vendor or
reachability evidence, a rationale, an ENG tracking issue, review timestamp and
expiry no more than 90 days later. Expired, duplicate, unused and malformed
exceptions fail the check. Changes require ordinary code review; never add a
blanket severity suppression to make a build pass.

## Remaining confinement acceptance

This job explicitly reports named AppArmor verification as **unavailable**. It
does not load policy on a shared runner or expose privileged self-hosted runners
to untrusted pull requests. A seccomp pass or a denied write due to ownership
does not prove AppArmor enforcement. ENG-1038 must first establish provider
support and the proposed service-specific profile; ENG-1041 still needs a
separate isolated capable runner to verify that profile's enforce mode,
controlled DNS/TLS/application compatibility, attributed negative denials, and
attachment across recreation. This release acceptance item stays open even when
the ordinary CI image job passes. See [Docker's AppArmor documentation](https://docs.docker.com/engine/security/apparmor/).

All checks are local candidate checks. Actual provider enforcement and any
production publication, deployment or policy attachment require separate
evidence and concrete authorization under [AGENTS.md](../AGENTS.md).
