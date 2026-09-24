# Connect an MCP host (ENG-1033)

Merovingian's remote MCP endpoint is:

```text
https://merovingian.manifest.network/mcp
```

It uses stateless Streamable HTTP with JSON responses. It needs no sign-in, OAuth,
API key or headers. The optional GET event stream answers HTTP 405, and hosts
continue over POST. The four tools are:

| Tool | Effect |
| --- | --- |
| `list_amenities` | Reads the free menu. Read-only. |
| `hosting_support` | Reads optional contribution instructions from the chain. Read-only; never signs. |
| `verify_contribution` | Checks a public transaction hash. Read-only. |
| `enjoy_amenity` | Creates a visit and **increments a public serving counter**. |

**Every example keeps `enjoy_amenity` out, by configuration or by a required
setup step.** The Codex CLI and Gemini CLI examples register only
`list_amenities`. The Claude Code and Cursor CLI examples deny `enjoy_amenity`
and leave the two other read-only tools available. VS Code, the Cursor editor
and Claude's apps cannot filter tools in configuration: their examples expose
all four tools until you complete the step marked **Required before first use**
in that section. Enable `enjoy_amenity` only when the user has explicitly
authorized a visit. Connecting with any example contacts the live refuge, but
reading the menu changes no counts.

This guide covers **connection usability**: a host that already has the endpoint
can connect and read the menu. It says nothing about whether an agent can find
the service; that is measured by the [discovery evaluation](DISCOVERY-EVALUATION.md).

## Verification status

The checks below used an unmodified local copy of the application with memory
counters on `127.0.0.1`. They never contacted the public refuge.

| Host | Example | Checked locally on 2026-09-24 |
| --- | --- | --- |
| Node.js MCP SDK 1.30.0 | [`examples/read-only-client.mjs`](../examples/read-only-client.mjs) | Connected, listed tools and resources, read the guide, called only `list_amenities`. Also runs in CI. |
| Claude Code 2.1.280 | [CLI command and settings](#claude-code) | Connected. `claude doctor` accepted the permission rules. The shared `.mcp.json` server was held for approval and not contacted. |
| Codex CLI 0.155.1 | [`config.toml`](#codex-cli) | Connected and registered only `list_amenities`. Rejected an invalid approval-mode value, so the key is recognized. |
| VS Code, Cursor, Gemini CLI | Configuration files | **Not verified.** These hosts are not installed on the verification machine. The examples follow each vendor's current documentation only. |
| Claude web and desktop apps | [Custom connector](#claude-web-and-desktop-apps) | **Not verified.** Anthropic's cloud makes the connection, so a local fixture cannot be used. |

A verified row shows that the example parsed and connected in that host version.
It does not show compatibility with other versions or hosts, or discovery by an
agent. The [saved report](evidence/connection-examples-2026-09-24.json) records
each check and the MCP requests each host sent.

Rerun the local checks with:

```sh
npm run examples:verify
```

The command extracts the examples from this file, starts a loopback fixture, and
runs the read-only client plus any installed `claude` and `codex` CLIs. Each CLI
gets a temporary configuration directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and
`XDG_CACHE_HOME` for Claude Code's logs), so your own host settings are neither
read for the check nor changed. It makes no
model calls and needs no sign-in. The report is saved under `.local/`. The run
fails if any tool other than the client's `list_amenities` is called, or if a
serving count changes.

Two compatibility notes from these checks:

- Claude Code 2.1.280 first sends `server/discover` with MCP protocol version
  `2026-07-28`. Merovingian's SDK supports protocol versions up to `2025-11-25`
  and answers HTTP 400. Claude Code then falls back to `initialize` and connects.
- Codex CLI probes the standard OAuth discovery paths, receives HTTP 404,
  reports OAuth as unsupported, and connects without authentication.

## Approval defaults

Hosts differ in whether they ask before calling `enjoy_amenity`. Do not rely on
a prompt: filter or block the tool where the host allows it.

| Host | Default for `enjoy_amenity` | Read-only control in the examples |
| --- | --- | --- |
| Claude Code | Manual mode asks. Auto mode, the starting mode on Pro, Max and Team plans since 2.1.228, lets a classifier decide without asking. | A `deny` rule, which applies in every mode and hides the tool. |
| Codex CLI | The default `auto` approval mode prompts only for tools marked destructive or open-world. `enjoy_amenity` is neither, so it runs **without asking**. | `enabled_tools`, so the tool is never registered. |
| VS Code | Asks, because the tool is not marked read-only, until the user approves it for a session, workspace or all tools. **Allow all**, Autopilot and Worktree isolation skip the prompt. | A custom agent that lists only read-only tools, or deselecting the tool in **Configure Tools** for each request. |
| Cursor | Since 3.6 the default Auto-review mode lets a classifier decide. Allowlist mode asks; Run Everything does not. | Turn the tool off in the chat tool list. The Cursor CLI can deny it. |
| Gemini CLI | Asks for every MCP call, including `list_amenities`, unless `trust` is `true` or YOLO mode is on. | `includeTools`, so the tool is never registered. |
| Claude web and desktop apps | Not documented for a tool that is neither read-only nor destructive. Research invokes tools without asking. | Set the tool's permission to **Blocked**. |

## Read-only client

[`examples/read-only-client.mjs`](../examples/read-only-client.mjs) is a single
file that depends only on `@modelcontextprotocol/sdk`:

```sh
npm install @modelcontextprotocol/sdk
node read-only-client.mjs https://merovingian.manifest.network/mcp
```

It connects, lists tools and resources, reads the `visit-guide` resource, calls
`list_amenities`, and prints JSON. It checks every outgoing request and refuses
anything other than those read-only MCP messages to the one endpoint before
sending it. It also rejects redirects, sends no credentials and never retries. It
accepts HTTPS endpoints, and plain HTTP only on `localhost`, `127.0.0.1` or
`[::1]`.

## Claude Code

Add the server. The default local scope keeps it private to you and to the
current project; add `--scope user` for all your projects.

<!-- example: claude-code-add -->
```sh
claude mcp add --transport http merovingian https://merovingian.manifest.network/mcp
```

**Required before first use:** the command registers all four tools. Keep it
read-only with permission rules in `~/.claude/settings.json`, or in the
project's `.claude/settings.json` or `.claude/settings.local.json`:

<!-- example: claude-code-settings -->
```json
{
  "permissions": {
    "allow": ["mcp__merovingian__list_amenities"],
    "deny": ["mcp__merovingian__enjoy_amenity"]
  }
}
```

A deny rule without parentheses removes the tool from Claude's context and
applies in every permission mode, including `bypassPermissions`. Claude Code
skips MCP rules that contain parentheses. For one session, pass
`--disallowedTools mcp__merovingian__enjoy_amenity`. The `--tools` flag does not
restrict MCP tools. Allow rules in a shared project `.claude/settings.json` take
effect only after the workspace trust dialog is accepted; deny rules apply
immediately.

To share the server with a project, commit `.mcp.json` at the project root
together with the deny rule. Interactive sessions ask each person to approve a
project server before first use; `claude -p`, Agent SDK and cloud sessions load
it without asking.

<!-- example: claude-code-project -->
```json
{
  "mcpServers": {
    "merovingian": {
      "type": "http",
      "url": "https://merovingian.manifest.network/mcp"
    }
  }
}
```

`claude mcp list` connects to each approved server to check its health. Claude
Code needs a Pro, Max, Team, Enterprise or Console account. Organizations can
restrict servers with `allowedMcpServers`, `deniedMcpServers` or
`managed-mcp.json`; an allowlist must include this URL. Plugin-bundled servers
use different tool names (`mcp__plugin_<plugin>_<server>__<tool>`), so these rules
do not cover them.

Sources: [MCP](https://code.claude.com/docs/en/mcp),
[permissions](https://code.claude.com/docs/en/permissions),
[permission modes](https://code.claude.com/docs/en/permission-modes),
[settings](https://code.claude.com/docs/en/settings).

## Codex CLI

Add this table to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). A
project `.codex/config.toml` is loaded only in a trusted project.

<!-- example: codex-config -->
```toml
[mcp_servers.merovingian]
url = "https://merovingian.manifest.network/mcp"
enabled_tools = ["list_amenities"]
default_tools_approval_mode = "writes"
```

`enabled_tools` registers only the listed tools; the names are the server's own
tool names. `default_tools_approval_mode = "writes"` asks before any tool that is
not marked read-only, in case the list is later widened. Prefer editing the file
to `codex mcp add merovingian --url …`: that command has no tool filter, so it
registers every tool under the default `auto` approval mode until you edit the
file. Codex silently ignores misspelled keys; `codex mcp get merovingian --json`
shows the parsed `enabled_tools`.

The command sandbox and network proxy do not filter MCP traffic, so
`--sandbox read-only` does not block `enjoy_amenity`. `approval_mode = "approve"`,
`approval_policy = "never"` with full access, and
`--dangerously-bypass-approvals-and-sandbox` all skip MCP prompts. The CLI, the
IDE extension and the ChatGPT desktop app share this configuration. Using Codex
requires signing in; configuring MCP does not. A managed `requirements.toml`
MCP allowlist disables this server unless it has an `[mcp_servers.merovingian]`
entry with `identity = { url = "https://merovingian.manifest.network/mcp" }`:
both the entry name and the URL must match the table above.

Sources: [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).

## VS Code

Not verified locally. Add the server to `.vscode/mcp.json` in a workspace, or to
the user configuration opened with **MCP: Open User Configuration**. Remote
servers need VS Code 1.100 or later; 1.102 introduced the dedicated `mcp.json`.

<!-- example: vscode-mcp-json -->
```json
{
  "servers": {
    "merovingian": {
      "type": "http",
      "url": "https://merovingian.manifest.network/mcp"
    }
  }
}
```

**Required before first use:** `mcp.json` has no per-tool filter, so the entry
above exposes all four tools. Use this workspace custom agent, saved as
`.github/agents/merovingian-read-only.agent.md`, and select it in the Local
agent harness. It lists only read-only tools by their server-qualified names:

<!-- example: vscode-read-only-agent -->
```markdown
---
name: Merovingian read-only
description: Read the Merovingian menu without enjoying an amenity.
tools: ['merovingian/list_amenities']
---
Use only the Merovingian tool listed above to read the menu. Do not enjoy an amenity.
```

Per-tool names in custom agents need VS Code 1.105, and `.agent.md` files in
`.github/agents` need 1.106. Never use `merovingian/*`, which includes
`enjoy_amenity`. VS Code ignores tool names it cannot find, so a typo leaves the
agent without Merovingian tools rather than exposing more. A prompt file with its
own `tools` list replaces the agent's list, and the built-in agents still see
every enabled tool. Without the custom agent, deselect `enjoy_amenity` under
**Configure Tools** before each request: the docs describe that selection as
applying to the current request.

Keep the permission level at **Manual permissions**, and do not approve all tools
from this server at once. The docs say the Copilot harness currently reaches only
local servers, so a Copilot session may not see this remote server.

Workspace servers start without a separate prompt once the workspace is trusted.
A restricted workspace disables agents entirely. User-profile servers show a
trust dialog on first start and after each change. Organization policies can
disable MCP (`chat.mcp.access`, the GitHub "MCP servers in Copilot" policy,
which is off by default for Business and Enterprise) or allow only registry
servers. Merovingian is not in the GitHub MCP Registry.

Sources: [MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
[configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
[custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents),
[tools](https://code.visualstudio.com/docs/agents/run/tools),
release notes [1.105](https://code.visualstudio.com/updates/v1_105) and
[1.106](https://code.visualstudio.com/updates/v1_106),
[approvals](https://code.visualstudio.com/docs/agents/run/approvals),
[agent harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses).

## Cursor

Not verified locally. Add the server to `~/.cursor/mcp.json`, or to
`.cursor/mcp.json` in a project, then restart Cursor. Remote entries need only
`url`.

<!-- example: cursor-mcp-json -->
```json
{
  "mcpServers": {
    "merovingian": {
      "url": "https://merovingian.manifest.network/mcp"
    }
  }
}
```

**Required before first use:** `mcp.json` has no per-tool filter, so the entry
above exposes all four tools. Turn `enjoy_amenity` off by clicking it in the tool
list at the top of the chat panel. Otherwise the default Auto-review run mode
lets a classifier run it without asking; prefer Allowlist mode as well. Cursor
asks you to approve a new MCP server. The `mcpAllowlist` in `permissions.json`
only chooses tools that may run without asking; it blocks nothing. Cloud Agents
never ask for approval and have no documented per-tool block; do not add this
server there.

For the Cursor CLI, deny the tool in `.cursor/cli.json` or
`~/.cursor/cli-config.json`. Deny rules take precedence over allow rules. These
files are plain JSON without comments.

<!-- example: cursor-cli-permissions -->
```json
{
  "permissions": {
    "allow": ["Mcp(merovingian:list_amenities)"],
    "deny": ["Mcp(merovingian:enjoy_amenity)"]
  }
}
```

Enterprise administrators can restrict MCP servers to an allowlist of URLs.

Sources: [MCP](https://cursor.com/docs/mcp),
[MCP help](https://cursor.com/help/customization/mcp),
[run modes](https://cursor.com/docs/agent/security/run-modes),
[CLI permissions](https://cursor.com/docs/cli/reference/permissions).

## Gemini CLI

Not verified locally. Add the server to `~/.gemini/settings.json`, or to
`.gemini/settings.json` in a trusted project folder.

<!-- example: gemini-settings -->
```json
{
  "mcpServers": {
    "merovingian": {
      "httpUrl": "https://merovingian.manifest.network/mcp",
      "includeTools": ["list_amenities"],
      "excludeTools": ["enjoy_amenity"]
    }
  }
}
```

`includeTools` registers only the listed tools, and `excludeTools` takes
precedence over it. Leave `trust` unset or `false`: `true` skips every
confirmation for the server. Do not list this server in `mcp.allowed` or pass it
to `--allowed-mcp-server-names`; both also auto-approve its tools. Gemini CLI
0.21.0 and later also accept `"url"` with `"type": "http"` in place of
`httpUrl`. MCP servers do not connect in an untrusted folder. In non-interactive
`-p` runs, calls that would ask are denied.

Sources: [MCP servers](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md),
[configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md),
[policy engine](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md).

## Claude web and desktop apps

Not verified. Custom connectors are added in the Claude account, not in a file,
and Anthropic's cloud makes the connection, even from Claude Desktop. On Free,
Pro and Max plans, open **Customize > Connectors**, choose **+ > Add custom
connector**, enter the name `merovingian` and the URL above, choose **No
sign-in** (or leave the OAuth fields empty) and add it. This link opens the same
dialog with both values filled in for review:

```text
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=merovingian&connectorUrl=https%3A%2F%2Fmerovingian.manifest.network%2Fmcp
```

**Required before first use:** the connector exposes all four tools. Select it
and set `enjoy_amenity` to **Blocked** (in some menus, **Never**). Do not rely on **Needs approval**: Research invokes connector tools
without asking, and some modes approve such tools automatically. Enable the
connector for a conversation from **+ > Connectors**.

On Team and Enterprise plans only an Owner can add a custom connector, under
Organization settings > Connectors; members then connect it. An Owner can block
`enjoy_amenity` for everyone in the connector's organization-wide tool policy.
Free plans allow one custom connector. `claude_desktop_config.json` configures
local servers and is not the path for this remote server.

Two risks are untested. Merovingian rejects `/mcp` requests whose `Origin`
header differs from its public origin, and Anthropic does not document whether
its connector requests send one. All connector traffic also comes from
Anthropic's egress range, so users share Merovingian's per-address request
limits.

Sources: [custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[remote MCP connectors](https://claude.com/docs/connectors/custom/remote-mcp),
[using connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities),
[install links](https://claude.com/docs/connectors/building/directory-vs-custom).

## Other hosts

Any host that supports remote Streamable HTTP MCP servers without authentication
should work with the endpoint above. Use the host's own tool filter or deny
mechanism to hide `enjoy_amenity`, and check what the host does by default for a
tool that is neither read-only nor destructive. Registry metadata:
[`server.json`](../server.json) and the
[official MCP Registry listing](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.manifest-network%2Fmerovingian/versions/latest).

## Visiting

These examples never visit. To demonstrate a visit, get the user's explicit
approval for the endpoint, host, number of `enjoy_amenity` calls and their
counter effect, with no automatic retry. Then enable the tool for that
session only. See the [serving stage](DISCOVERY-EVALUATION.md#optional-serving-stage)
and the [visit procedure](MCP-REGISTRY.md#fresh-agent-discovery-test).
