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

Authenticate with the interactive GitHub device flow:

```sh
mcp-publisher login github
```

Complete the displayed GitHub authorization in the operator's browser using an
organization owner account. Do not paste access tokens into chat, source, command
arguments, or logs. Version 1.8.1 stores its registry token in the user's
`.config/mcp-publisher/token.json`, outside this repository. Check that the
directory is private (`0700`) and the token is private (`0600`); do not overwrite
an existing login unknowingly. It does not support `XDG_CONFIG_HOME` relocation.
Do not reuse a broad repository-management token merely to skip the device flow.

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
