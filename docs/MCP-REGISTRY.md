# MCP Registry publication and discovery

The repository's `server.json` describes the existing remote service. Its proposed
registry identity is `io.github.manifest-network/merovingian`, version `0.4.2`,
using Streamable HTTP at `https://merovingian.manifest.network/mcp`.

Publication is not yet recorded as complete. Preparing or validating this file
does not create a public listing. The live application remains on its current
release throughout this work.

## Identity and access

The GitHub namespace is controlled through an owner of the `manifest-network`
organization. A registry identity is separate from the current MCP initialization
name, `network.manifest.merovingian/merovingian`; client negotiation still describes
the running service. The HTTPS origin and remote endpoint stay the same.

This is a remote-only listing. There is no installable npm package or local
container command in the record. All four remote tools remain available:
`list_amenities`, `enjoy_amenity`, `hosting_support`, and `verify_contribution`.
Free visits require no wallet, login, API key, or payment. A successful
`enjoy_amenity` call increments one aggregate serving count. Contributions require
separate visitor-controlled wallet authorization.

## Publisher workflow

Use the published official `mcp-publisher` CLI. Version `1.8.1` was reviewed for
this publication; its Linux amd64 archive SHA-256 is
`a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc`.
Download from the [official release](https://github.com/modelcontextprotocol/registry/releases/tag/v1.8.1)
and verify its checksum before running it.

From the repository, validate the public metadata:

```sh
mcp-publisher validate server.json
```

Validation sends this public JSON to the official registry validation API. It does
not publish and is not an offline check. Do not add credentials or private headers
to the record. Review the exact namespace, version, description, endpoint, and
repository URL before publication.

As checked on 2026-09-18, the interactive device flow cannot grant our organization
namespace. It uses the private **MCP Registry Login (Prod) GitHub App**, whose user
token cannot supply the organization role required by the registry. Login can
succeed while granting only the personal namespace. This is a
[maintainer-confirmed registry bug](https://github.com/modelcontextprotocol/registry/issues/1468#issuecomment-5093147856).
Changing OAuth App settings, making membership public, or attempting to install
the private app is not the remedy.

For a one-off publication, an organization owner can create a dedicated PAT with
the shortest practical expiration and either:

- Classic PAT: only `read:org`.
- Fine-grained PAT: resource owner `manifest-network`, with **Organization
  permissions → Members → Read-only** and no added repository permissions.

Enter the token through hidden local input and supply it only to the login
process through the `MCP_GITHUB_TOKEN` environment variable:

```sh
mcp-publisher login github
```

The command above uses the PAT only when `MCP_GITHUB_TOKEN` is supplied; otherwise
it starts the affected device flow. Do not put token values in shell history,
command arguments, chat, source, or logs, and keep shell tracing disabled. Do not
reuse the broad credential used by `gh` for repository management. Clear the PAT
from the local process environment after login and revoke it after publication.

Version 1.8.1 stores its registry token in the user's
`.config/mcp-publisher/token.json`, outside this repository. Check that the
directory is private (`0700`) and the token is private (`0600`); do not overwrite
an existing login unknowingly. It does not support `XDG_CONFIG_HOME` relocation.

Before publishing, check that the saved login metadata names the official
registry destination. Inspect the locally issued registry token's claims in
memory to confirm a `publish` grant for `io.github.manifest-network/*` and a valid
expiration. Report only the destination/grant check results and expiration time;
never dump the JWT or its complete claims. Decoding claims is
a local preflight, not cryptographic verification. The registry JWT lasts only
[five minutes](https://github.com/modelcontextprotocol/registry/blob/v1.8.1/internal/auth/jwt.go),
so complete metadata review and validation before login and publish promptly.
Successful login alone does not prove organization publishing access.

GitHub Actions OIDC is another supported route: a reviewed workflow in this
organization's repository can use `mcp-publisher login github-oidc` with
`id-token: write`, without a PAT. Keep publication an explicitly approved action;
do not introduce an automatic release trigger as part of this workaround. See the
[official Actions guidance](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx).

After explicit authorization for the reviewed registry publication:

```sh
mcp-publisher publish server.json
```

Fetch the public record and compare it with `server.json`. Check the exact
versioned result and current/latest result. Treat published versions as immutable:
review a new version when changing listing metadata. An uncertain publish response
requires a read-only lookup before any retry.

## Fresh-agent discovery test

Use a new agent context with no conversation history, application source, local
runbooks, or preloaded refuge endpoint. Give it the official registry as a discovery
surface. Record the exact prompt and whether it used a service-name search or a
broader capability search; these demonstrate different levels of discoverability.

1. Find the public listing and obtain the endpoint from its `remotes` field.
2. Connect with Streamable HTTP, record the negotiated server identity/version,
   and discover the four tools through `tools/list`.
3. Read the menu and choose one free amenity. Read serving counts before the visit.
4. With explicit approval for one live test visit, call `enjoy_amenity` once and
   save the returned souvenir. Do not retry a visit with an ambiguous outcome.
5. Read counts afterward and report the observed change. Concurrent visitors can
   also change the shared counters; do not claim exclusive attribution without
   supporting evidence.

Save a sanitized report with the prompt, public discovery requests, selected
listing/version, negotiated identity, tool list, souvenir, timestamps, and counter
observations. Include failures and manual host approvals. Label the visit as test
traffic. Do not sign transactions, query local wallets, or make a contribution.

A successful registry journey does not prove search-engine indexing, automatic
installation by arbitrary MCP hosts, or organic visitor traffic.

References: [remote servers](https://modelcontextprotocol.io/registry/remote-servers),
[publisher authentication](https://modelcontextprotocol.io/registry/authentication),
[versioning](https://modelcontextprotocol.io/registry/versioning),
[ENG-1019](https://linear.app/liftedinit/issue/ENG-1019),
[ENG-1021](https://linear.app/liftedinit/issue/ENG-1021).
