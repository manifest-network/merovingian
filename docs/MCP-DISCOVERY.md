# Fresh-agent discovery — 2026-09-18

The supervised fresh-agent test completed one approved free visit on 2026-09-18 against release `0.4.2`. Merovingian returned a byte-chip-cookie souvenir, and the observed shared serving total rose from 15 to 16. This is historical evidence; preparing `0.4.3` during PR review does not rerun or update these observations.

This was **name-led registry discovery**, not organic or capability-led discovery. The supplied service-specific hint was “Merovingian”; the task also supplied the official MCP Registry URL and an isolated workspace with the published MCP client SDK already installed. The agent did not read prior conversation history, application source, local application documentation/runbooks, authentication files, or existing operation artifacts. During the test, the supervising agent reported publication complete; it did not supply the service endpoint or menu.

The route began at the [official registry](https://registry.modelcontextprotocol.io), followed its API Reference to the linked OpenAPI specification, and used the documented name substring search with the latest-version filter: [registry search](https://registry.modelcontextprotocol.io/v0.1/servers?search=merovingian&version=latest). At 2026-09-18T13:44:56.009Z, that request returned one active, latest listing: **io.github.manifest-network/merovingian**, version **0.4.2**. The listing supplied the Streamable HTTP endpoint [merovingian.manifest.network/mcp](https://merovingian.manifest.network/mcp); the endpoint was not guessed.

The published @modelcontextprotocol/sdk client, version 1.30.0, negotiated MCP protocol **2025-11-25** with server identity **network.manifest.merovingian/merovingian**, version **0.4.2**. The registry name and runtime server name differ as shown. The server advertised tools and resources. Discovery returned four tools: list_amenities, enjoy_amenity, hosting_support, and verify_contribution; one resource, [visit-guide](https://merovingian.manifest.network/visit.md); and no resource templates. The agent read that resource over MCP and called the read-only list_amenities tool. The menu offered free byte-chip cookies, RGB sauna sessions, and null tea, with no wallet required.

The selected action was enjoy_amenity with amenity byte-chip-cookie and preference hex-salt, the menu's default preference. No seed or personal context was submitted. The [archived client source](evidence/mcp-client-2026-09-18/README.md) shows an exclusive synchronous marker write before `client.callTool`. The marker records **2026-09-18T13:48:06.269Z**, the same millisecond as request dispatch; those timestamps alone do not prove ordering. The original code did not `fsync` the marker or directory, so this is not evidence of crash-safe durability. The client disabled transport reconnection retries, rejected redirects and credentials, and guarded against a second amenity request within that process. The one call returned successfully at **2026-09-18T13:48:06.496Z**; the saved wire trace contains exactly one enjoy_amenity request. No visit was repeated.

The guide supplied the [read-only statistics endpoint](https://merovingian.manifest.network/api/v1/stats). The before snapshot completed at **2026-09-18T13:48:05.954Z**, and the after snapshot at **2026-09-18T13:48:06.563Z**:

| Serving counter | Before | After | Change |
| --- | ---: | ---: | ---: |
| Byte-chip cookie | 5 | 6 | +1 |
| RGB sauna | 4 | 4 | 0 |
| Null tea | 6 | 6 | 0 |
| Total | 15 | 16 | +1 |

Both snapshots reported mainnet, manifest-ledger-mainnet, persistent storage, and counting since 2026-09-17T20:29:18.301Z. These are shared aggregate serving counts, not unique-visitor totals. Their change supports the single observed serving without independently excluding unrelated concurrent traffic.

The returned souvenir is **“Byte-chip recipe card — hex-salt”**, ID **merovingian-mainnet-d00ece160babc8a4f781063f**. Its exact text is saved in [the souvenir text](evidence/mcp-souvenir-2026-09-18.txt), and the complete experience and souvenir are saved in [the complete visit response](evidence/mcp-souvenir-2026-09-18.json). The fortune reads: “Somewhere, a missing bracket has found its other half.”

One initial sandbox network request to the registry API reference failed with EAI_AGAIN; a network-capable execution succeeded afterward. Optional MCP GET streaming returned HTTP 405 on each of the three client connections. The SDK continued using JSON POST responses successfully, as the visitor guide says GET streaming is unnecessary. There were no application-level discovery or visit failures.

Before publication and the test, the user directly replied **“Approve publication and one test visit”** to the proposed publication of `io.github.manifest-network/merovingian` version `0.4.2` at the mainnet MCP endpoint and exactly one free visit adding one serving. That scope excluded deployment, DNS, payment, and infrastructure changes. This excerpt was added during PR review from the supervising conversation; it is not a new approval. The supervising agent conveyed that authorization to the fresh agent. Six network escalation executions succeeded, but those results were not treated as user authorization; the fresh agent observed no additional human approval interaction. No credentials were supplied, and no payment, contribution, wallet, signing, deployment, infrastructure, registry modification, commit, or push occurred during the delegated test. The contribution-related tools were discovered but never called.

[The evidence bundle](evidence/mcp-discovery-2026-09-18.json) contains raw registry and MCP responses, timestamps, server identity, the menu and guide, request trace, attempt marker, counter snapshots, souvenir, and limitations. Its digest manifest now lists only committed public files, including the exact [client sources archived as inert text](evidence/mcp-client-2026-09-18/README.md). Earlier digests of inaccessible scratch files were removed during review. Additional raw artifacts remain local; scratch-only filenames describe provenance, not public download links. The exact task prompt stays inside the ignored `.local/` directory as `prompt.txt`, also explicitly ignored by filename, because it contains a personal filesystem path.

The discovery instruction, quoted from the task prompt:

> Discover the public service named Merovingian using the official MCP Registry at https://registry.modelcontextprotocol.io. Obtain its endpoint from the public listing, connect through MCP, discover available tools/resources, read the visitor guidance/menu, and perform exactly ONE free amenity visit, saving the returned souvenir and observed serving counters before/after.

The remaining instructions restricted the agent to an isolated workspace, public discovery material and the published SDK, required recording the attempt before the call, and prohibited further mutations or retrying an ambiguous visit. See the [publication runbook](MCP-REGISTRY.md) for the repeatable procedure and explicit approval requirement.
