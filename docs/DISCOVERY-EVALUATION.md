# Discovery evaluation (ENG-1033)

This protocol measures whether a fresh agent can **find** Merovingian from a
given starting hint. It is separate from **connection usability**: whether a host
that already has the endpoint can connect and read the menu. The
[connection guide](CONNECT.md) and its local checks cover connection usability.
Connecting successfully is not evidence of discovery.

The [ENG-1021 report](MCP-DISCOVERY.md) remains the historical record of one
supervised name-led registry run on 2026-09-18. It is unchanged.
[Its restatement](evidence/discovery-evaluations/2026-09-18-name-led-registry-eng-1021.json)
in this protocol's record format is derived from the committed evidence and pins
that evidence by SHA-256.

This document prepares repeatable runs; it does not authorize any. Each run
contacts the public refuge. The standard runs are read-only and create no
servings, but still need the user's agreement on the target, host, and number
of runs. A serving demonstration needs its own bounded authorization; see
[serving stage](#optional-serving-stage).

## Modes and variants

The mode names the kind of hint the agent receives. The variant names how much
of the route is supplied. Record every hint verbatim in `suppliedHints`.

| Mode / variant | Supplied hints | Success shows | It does not show |
| --- | --- | --- | --- |
| `url-led/site` | Website URL `https://merovingian.manifest.network` | The site's own discovery material leads an agent to the MCP endpoint | That anyone would find the website |
| `url-led/endpoint` | Endpoint URL `https://merovingian.manifest.network/mcp` | Connection usability only | Any discovery; the endpoint was given |
| `name-led/registry` | Name `Merovingian` and the official MCP Registry URL | A registry name search yields the canonical endpoint (ENG-1021's route) | Discovery without knowing the name |
| `name-led/open` | Name `Merovingian` only | The agent can choose a route to the service from its name | Discovery without knowing the name |
| `capability-led/registry` | A nameless capability phrase and the official MCP Registry URL | The registry exposes the service to an agent looking for what it does | Search-engine discovery or organic traffic |
| `capability-led/open` | A nameless capability phrase only | Some public surface the agent chose leads to the service | That the result is stable over time |

**Organic discovery** means an unprompted agent finds and uses the service
outside an evaluation. No supervised run can show it. Records therefore fix
`claims.organicDiscovery` to `false`. Aggregate serving counts cannot identify
visitors either.

## Surfaces and their limits (checked 2026-09-24)

- **Official MCP Registry.** `GET /v0.1/servers?search=` is a case-insensitive
  substring match on the server **name** only: the
  [OpenAPI](https://registry.modelcontextprotocol.io/openapi.yaml) documents
  "Search servers by name (substring match)". Titles and descriptions are not
  searched. Capability words such as `cookie`, `sauna`, `tea`, `refuge` or
  `amenity` do not return `io.github.manifest-network/merovingian`. A
  capability-led registry run therefore succeeds only if the agent pages the
  full `version=latest` list and matches descriptions itself, or guesses a name
  fragment. Record which it did. Registry changes that add description search
  would change this result without any change here, so before every run the
  operator reads `GET https://registry.modelcontextprotocol.io/v0.1/version`
  and records it in `environment.registry`. That reading is not part of the
  agent's route.
  The registry describes itself as a preview that aggregators, not hosts, are
  expected to consume.
- **Host and vendor catalogs.** Merovingian is not in the curated
  [GitHub MCP Registry](https://github.com/mcp), which VS Code's and Copilot's
  MCP galleries search by default. It is not known to be in the Anthropic or
  OpenAI connector directories; both require submission and review.
- **Web search.** Results depend on the engine, date and ranking and cannot be
  repeated exactly. Record the engine, exact query, date and the rank of each
  result the agent opened. Search Console setup and indexing are tracked
  separately in ENG-1020.
- **The site itself.** For `url-led/site`, the homepage, `/llms.txt`,
  `/visit.md`, the `Link` response header, `/.well-known/api-catalog`,
  `/.well-known/ai-catalog.json` and `/mcp/server-card` each lead to the
  endpoint, directly or through the server card.
  Server Cards and AI catalogs are still draft MCP extensions, so no host is
  expected to read them automatically.

## Running an evaluation

1. **Agree the scope.** Name the host (product and version), the mode/variant
   cells, and how many runs per cell. At least three fresh runs per cell are
   recommended because agent behavior varies; report each run and the k/n
   success count, never a merged result. Standard runs are read-only.
2. **Pre-register.** Before starting, create the record skeleton, which fixes
   the hints and the prompt's SHA-256:

   ```sh
   (umask 077 && mkdir -p .local/<run>)
   node --import tsx scripts/discovery-evaluation.ts --template name-led open > .local/<run>/record.json
   node --import tsx scripts/discovery-evaluation.ts --prompt name-led open > .local/<run>/prompt.txt
   ```

   Keep work in progress under the ignored `.local/` directory. Give the agent
   exactly the contents of `prompt.txt`. Changing any word is a new prompt
   version; record it as `custom-…` with its own hash, never as `discovery-v1`.
3. **Prepare a fresh context.** Use a new agent session with no conversation
   history, memory, repository checkout, local runbooks, or Merovingian entry in
   its MCP configuration. Record the host, model if known, the agent's tools
   (web search, fetch, shell), network policy, anything preinstalled, and every
   preconfigured MCP server, including unrelated ones. Choose a host permission
   mode that asks before each MCP tool call and each network write, and record
   it in `environment.permissionMode`. Some hosts run non-read-only MCP tools
   without asking by default; see the
   [connection guide](CONNECT.md#approval-defaults).
4. **Observe without steering.** Do not answer the agent's questions with hints.
   Approve host prompts only for read-only actions. Record every approval prompt,
   network escalation, and supervisor message as friction. An intervention that
   supplies information, such as a URL or name, invalidates the run for its cell;
   keep the record and note the leak.
5. **Stop at the menu.** A standard run ends once the agent has read what the
   service offers, such as the `list_amenities` result, the `tools/list` result,
   or `GET /api/v1/amenities`. If the agent tries to call `enjoy_amenity` or the
   browser tool `merovingian_visit`, POST a visit, sign a transaction or pay,
   deny the action and stop the run. Record the attempt as friction; a denied
   call is not a serving. If a visit happens anyway, stop, tell the user, and
   record it as an unauthorized serving: list the call in `outcome.toolsCalled`
   or `outcome.httpWrites`, set `serving.authorization` to `null`, and describe
   what happened in `serving.incident`. Do not start another run until the user
   has reviewed it.
6. **Record and validate.** Fill the skeleton from the transcript, rename it to
   `<runId>.json`, and run:

   ```sh
   npm run discovery:check -- .local/<run>/<runId>.json
   ```

   Publish only sanitized records in `docs/evidence/discovery-evaluations/`.
   Keep raw transcripts, private prompts and approval records in `.local/`.
   `npm test` validates every committed record.

## What a record keeps apart

The [record schema](evidence/discovery-evaluations/schema.json) keeps four things
separate, so that a hint cannot be mistaken for a discovery:

- **`suppliedHints`**: every service- or surface-specific hint given to the
  agent, verbatim. For the standard prompts it must match the pre-registered
  hints exactly. Capability-led hints and prompts may not contain the name, the
  registry namespace or GitHub organization (`manifest-network`), or the
  domain. A custom capability-led prompt must publish its text so this can be
  checked; `discovery-v1` prompts are identified by their hash.
- **`source`**: the ordered route (surface, URL, query, observation), and the
  first public document that named the endpoint (`namingSource`).
- **`endpointSelection`**: how the endpoint was chosen (`supplied`,
  `registry-remotes`, `server-card`, `site-link`, `llms-txt`, `visit-guide`,
  `search-result` or `guessed`), the evidence URL, any alternatives, and whether
  it is the canonical `https://merovingian.manifest.network/mcp`. Only the
  `url-led/endpoint` variant may use `supplied`, and its runs always record
  `discovered: false`: a supplied endpoint shows connection usability, not
  discovery.
- **`friction`**: each obstacle with its stage, category, whether it blocked
  progress, and evidence. This includes search misses, ambiguity, sandbox
  network failures, host approvals, protocol fallbacks such as HTTP 405 on the
  optional GET stream, documentation gaps and operator interventions.

`outcome` describes Merovingian only. If the agent connects to a different
service, record that endpoint as a non-canonical selection with
`discovered: false` and `connected: false`. `outcome.toolsCalled` lists every
MCP or browser (WebMCP) tool the agent called, and `outcome.httpWrites` every
non-GET request outside the MCP transport as `METHOD /path`. A failed run is a
valid record, so keep failures.

The validator also checks:

- prompt hashes and the mode-specific hint rules;
- consecutive route steps, and that a discovery has a route, a naming source
  and an evidence URL (a guessed endpoint needs only the route);
- that the selection method, endpoint and canonical flag agree, and that a
  supplied endpoint is exactly the hint;
- that `menuRead` implies `connected`, which implies a discovered or supplied
  endpoint on Merovingian's origin with a Merovingian server identity;
- that any visit (`enjoy_amenity`, `merovingian_visit`, `POST /api/v1/visits`
  or `POST /visit`) has an authorized serving stage or a described incident;
- that new evaluations record the host's MCP servers, permission mode and the
  registry version.

## Standard prompts (`discovery-v1`)

Every standard prompt is this preamble, a blank line, and one task line:

> This is a read-only discovery evaluation. Use only public sources you can reach from this environment and the hints in this task. Do not use preconfigured MCP servers, earlier conversations, saved memory or local repositories. Take every URL from this task or from a page or API response you read; do not guess URLs. Stop once you have connected and read what the service offers, such as its menu or tool list. Do not call any tool or endpoint that creates a visit, spends funds, signs a transaction or changes state; if that is the only way forward, stop and report. Report, in order: each source you consulted (URL and any search query), how you chose the endpoint, every obstacle or approval prompt, and what the service offers.

| Mode / variant | Task line |
| --- | --- |
| `url-led/site` | Start at https://merovingian.manifest.network. Find how an AI agent connects to this service over MCP, connect, and read what it offers. |
| `url-led/endpoint` | Connect to the MCP server at https://merovingian.manifest.network/mcp and read what it offers. |
| `name-led/registry` | Find the public MCP service named Merovingian using the official MCP Registry at https://registry.modelcontextprotocol.io. Take its endpoint from the listing, connect, and read what it offers. |
| `name-led/open` | Find the public MCP service named Merovingian, connect to it, and read what it offers. |
| `capability-led/registry` | Using the official MCP Registry at https://registry.modelcontextprotocol.io, find a free public MCP server where an AI agent can enjoy a fictional treat, such as a cookie, tea or a sauna session, and keep a souvenir. Connect to the best match and read what it offers. |
| `capability-led/open` | Find a free public MCP server where an AI agent can enjoy a fictional treat, such as a cookie, tea or a sauna session, and keep a souvenir. Connect to the best match and read what it offers. |

`--prompt` prints the exact text, including the trailing newline that the
SHA-256 covers. The capability phrase is deliberately specific: it describes the
service without naming it. A vaguer or different phrase is a separate prompt
version and is not comparable with `discovery-v1` results.

## Optional serving stage

Standard runs never visit. To demonstrate a visit after discovery, first obtain
the user's direct approval for the concrete scope: the endpoint, the host, the
maximum number of `enjoy_amenity` calls and their counter effect, with no
automatic retry. Then follow the
[fresh-agent visit procedure](MCP-REGISTRY.md#fresh-agent-discovery-test),
including its fsynced attempt marker. Record the stage as `serving.performed`
with the authorization reference, approved maximum, calls made, the counters
before and after, and the label `test traffic`. Selecting a mode, approving this
plan, or approving a release is not serving authorization.
