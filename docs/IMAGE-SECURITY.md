# Candidate image verification

The final-image CI job builds a local candidate without publishing it, checks
runtime isolation and SQLite persistence, then scans the same immutable local
image. It uses a pinned Trivy 0.74.0 binary with its verified release checksum.
Repository permissions are read-only and the job receives no deployment secrets.
Only explicitly listed JSON evidence is uploaded, retained for 14 days; image
archives, scanner caches and full Docker inspections are excluded.

The always-run `job-status.json` records each checkout, tool setup, dependency
installation, build, runtime and scan outcome. It uses runner Python independently
of repository dependencies, so an early install or build failure still produces
an artifact. Ordinary runtime failures also write `runtime.json` with the
completed checks, a fixed failure category and stage, and cleanup results before
the command fails. Probe failures identify the particular check, such as
`distribution-inventory` or `sqlite-journal`. Arbitrary Docker stderr, assertion
values, malformed input, environment values and host paths are not copied into
these diagnostics. Cleanup attempts each tracked container and the disposable
volume even after another cleanup fails; it preserves the original check failure.
Failure to clean up also fails an otherwise successful check. An interrupted
runner or unwritable artifact destination can prevent evidence from being saved.

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
replacement. Expected distribution files are derived from the checked-out
TypeScript sources and build compiler options, including nested modules and
source-map settings. Sources outside `src`, outputs outside `dist`, unexpected
distribution files and distribution symlinks fail verification. The top-level
application directory remains limited to `dist`, `node_modules`, and
`package.json`, keeping repository signing and operation tooling outside the
image. Ownership and absence of all write bits are checked recursively; a separate writable-root test
proves code writes fail for UID 1000 independently of the read-only filesystem.
The main application runs with no network, all capabilities dropped,
no-new-privileges, read-only root, and explicit memory/CPU/PID limits. Process
UID/GID, capabilities and seccomp are checked, as are the exec healthcheck,
single MCP operation, batch rejection, serving totals and graceful shutdown.
A separate loopback HTTP fixture verifies the exact native healthcheck command:
unset, empty and custom `PORT`, fixed request path and Host, quiet output, ignored
HTTP proxy settings, 2xx success, and failures on redirects, HTTP errors,
connection refusal, invalid ports and malformed or oversized status lines.
Hung connections and slowly arriving status lines exercise the single total
deadline. These cases must exit normally with failure after at least three and
less than ten seconds, allowing scheduler delay around the four-second alarm.
A separate 15-second watchdog reports `healthcheck-watchdog` if the test hangs;
it does not race Docker's unchanged five-second healthcheck timeout. Fixture
setup and runtime server errors have their own diagnostic identifiers.

Both SQLite persistence passes use the default port. A third, independent
application container verifies a custom port using only `/healthz`; a custom-port
failure retains the completed persistence evidence. The image metadata pins the
direct native executable and all cadence/timeout/startup/retry settings. Inventory
checks require a root-owned, nonwritable ELF executable, and the writable-root
permission check also verifies that UID 1000 cannot modify it. The C compiler is
confined to a build stage and is absent from the final runtime image.
Docker resource settings are inspected; the fixture is not a stress test.
Ordinary writable-root execution also checks temporary-file creation and sticky
1777 modes on `/tmp` and `/var/tmp`. The read-only fixture mounts only `/tmp` as a
16 MiB tmpfs with `noexec,nosuid,nodev` and mode 1777, verifies the mount settings,
and checks that Node can create, write, read and remove a temporary file there.

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

Policy evaluation failures write a failed `policy.json` with a fixed category
and explanation, including unsupported OS, detected credentials, stale database,
missing coverage, invalid evidence, and expired, duplicate or unused exceptions.
The console reports that same safe category. Schema failures do not print the
untrusted value or raw validation exception. Scanner setup/download failures are
recorded by the job-status artifact even when scan evidence does not yet exist.

`security/image-exceptions.json` is initially empty. Any proposed exception must
identify exactly one advisory/package/version/target/path, provide vendor or
reachability evidence, a rationale, an ENG tracking issue, review timestamp and
expiry no more than 90 days later. Expired, duplicate, unused and malformed
exceptions fail the check. Changes require ordinary code review; never add a
blanket severity suppression to make a build pass.

`tests/runtime-image-check.test.ts` and `tests/image-security-policy.test.ts`
exercise failures without Docker: early Docker errors, probe diagnostics,
cleanup failures, source inventory changes, malformed policy input, and the
workflow's actual status writer under simulated dependency/build failures. These
tests invoke local Node/Python subprocesses and make no network requests.

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
