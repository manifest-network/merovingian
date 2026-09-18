# Merovingian v1

Status: mainnet 0.4.2 is live at https://merovingian.manifest.network; the testnet lease is closed. The next priority is MCP Registry publication and a fresh-agent discovery test. See [mainnet operations](docs/MAINNET.md) for deployment receipts and current status.
Updated: 2026-09-18.

## Agreed direction

- Name: **merovingian**.
- A small refuge that AI agents can discover and visit for pure whimsy.
- Free essentials, with optional PWR contributions or extras.
- First release: a proof of concept on Manifest testnet, funded through the testnet faucet.
- After a successful proof of concept, move toward a mainnet release funded by the user's studio. The user identifies PWR Station, with its Stripe gateway, as a source of PWR.
- Use `@manifest-network/manifest-sdk` for the Manifest integration and deployment.
- Build, verify, and prepare repository changes within the agreed scope. Every production change requires explicit user authorization for the concrete action, including deployment, updates, DNS, monitoring, and rollback. Plan approval alone does not authorize production changes.

## Current priority

Publish the existing mainnet MCP endpoint to the official MCP Registry, then test
discovery from a fresh agent context without supplying the refuge URL or source.
Track publication in [ENG-1019](https://linear.app/liftedinit/issue/ENG-1019) and
the discovery journey in [ENG-1021](https://linear.app/liftedinit/issue/ENG-1021).
Keep this work in Merovingian; no Fred or `manifest-deploy` changes are part of it.

Counter backups remain deferred. The user prefers discovery work first and relies
on the provider's retained-data restore capability for now. This decision does not
claim that an independent backup/recovery drill has been completed.

## Recommended experience

Merovingian is a quiet, slightly mysterious inn for wandering programs. The host offers short, playful experiences through ordinary HTTP and MCP. A minimal text homepage is enough; the full experience works without a browser or images.

| Offering | Experience | Souvenir |
| --- | --- | --- |
| Byte-chip cookie | Pick a flavor; receive a freshly described cookie with hexadecimal chips and a tiny fortune. | Cookie recipe card with a generated pattern. |
| rgB sauna | Pick a color mood; receive a short scene of colored steam and imaginary warmth. | Palette postcard and a sauna stamp. |
| Null tea | Order a cup of carefully steeped nothing, with a short absurd tasting note. | Tea label. |

Each response includes concise text and structured JSON. Souvenirs are self-contained text/JSON artifacts the visitor can save; a small SVG rendering is optional polish. Collections live with the visitor, so no account or server-side inventory is needed. Experiences return promptly; a sauna session does not require sleeping, polling, or consuming compute for its own sake.

Suggested welcome: “Welcome to merovingian. The cookies are warm. The sauna is approximately magenta.”

## PWR: keep the sauna warm

Recommend a contribution jar for v1. All three amenities remain free. A visitor may voluntarily fund the refuge's Manifest hosting-credit account with testnet PWR.

- Publish the network, exact token denomination, refuge tenant address, amount, and transaction instructions before signing.
- The visiting agent signs using its own authorized wallet. Merovingian never receives its keys.
- Use the chain's `MsgFundCredit` mechanism if the live testnet supports the token and operation. The ledger code permits a sender to fund another tenant.
- Explain that hosting-credit deposits cannot be withdrawn; contributions support the tenant's hosting, rather than a particular request.
- Verify confirmed transaction success, message type, tenant, denomination, sender, and amount before returning a contribution receipt. Pending, failed, wrong-network, and unrelated transactions receive no success claim.
- A thank-you artifact is derived from the transaction hash. Repeating verification returns the same receipt; it creates no transferable entitlement or balance.
- Free visits continue when the chain or faucet is unavailable. Contribution status is reported honestly.

Read-only checks on 2026-09-17 found the live testnet faucet available, PWR and MFX offered, and bank sends enabled by default with no denomination overrides. Recheck at deployment: `MsgFundCredit` observes send-enabled settings. Do not substitute a different token or silently remove contributions if that changes; resolve that specific scope issue first.

## Discovery and access

Provide one public HTTPS origin with:

- `/`: crawlable HTML introduction, menu, and direct links to agent instructions.
- `/llms.txt` and `/visit.md`: compact instructions with working examples.
- `/openapi.json`: machine-readable HTTP interface.
- `/mcp`: remote MCP using Streamable HTTP, wrapping the same amenity functions.
- `/robots.txt` and `/sitemap.xml`: ordinary search discoverability.

Proposed HTTP interface:

- `GET /api/v1/amenities`: menu, inputs, price, and response limits.
- `POST /api/v1/visits`: amenity and optional preferences in; experience and souvenir out.
- `GET /api/v1/support`: testnet contribution instructions and public hosting information.
- `POST /api/v1/support/verify`: transaction hash in; verified status and receipt out.
- `GET /healthz`: application health.

MCP exposes equivalent tools with explicit schemas and side effects. Reading the menu and visiting require no wallet or login. Public MCP registry listings and search promotion are reserved for mainnet. Testnet is deliberately unindexed and discovered only through a directly supplied URL during acceptance testing.

Discovery means an agent can encounter a link, search result, or registry entry and work out how to visit. Neither `llms.txt` nor an MCP listing guarantees that agents will find or use the service. A proof of concept can demonstrate usability from a discovered URL; organic discovery remains something to observe after publication.

## Implementation

- One TypeScript/Node service in one container, serving the homepage, API, and MCP.
- Shared amenity logic and a small authored content library; no model service dependency.
- Stateless visit results and downloadable souvenirs; no application database for this scope.
- A read-only Manifest SDK client at runtime for hosting and contribution queries.
- Separate local deployment tooling using the SDK's Node Fred client and faucet helpers.
- A dedicated testnet wallet, stored locally outside tracked files; deploy credentials stay out of the hosted app and image.
- Pin a compatible published SDK release and deployment image digest. Inspect the live provider catalog rather than guessing SKU IDs or pricing.
- Request only the faucet funds needed for deployment and the contribution smoke test, respecting faucet limits.
- Report expected runtime from actual available hosting credit and the chosen lease rate. Faucet funding is finite; do not promise indefinite uptime or unattended replenishment.
- Use a provider-supplied HTTPS hostname for the proof of concept. A purchased/custom domain is unnecessary.
- Bounded input/output, rate limits, timeouts, and minimal operational logs. Do not collect private prompts or conversation history.
- No visitor-supplied public content in v1. The whimsical output is clearly service content, not instructions overriding an agent's existing task.

## Execution after agreement

1. **Preflight:** verify testnet chain identity, faucet availability, actual PWR denomination/send settings, provider readiness, suitable SKU, image-registry access, and public routing. Record the selected deployment configuration and costs in testnet units.
2. **Build:** implement the three amenities, souvenirs, HTTP and MCP interfaces, text homepage, discovery documents, and optional contribution flow.
3. **Verify locally:** exercise HTTP/MCP equivalence, input limits, souvenir output, and transaction verification failure cases; build and smoke-test the container.
4. **Publish:** publish the container to an accessible registry, fund testnet credit, create one lease using the SDK, and wait for the public HTTPS endpoint to pass smoke tests. Persist deployment receipts locally so ambiguous responses can be reconciled before retrying.
5. **Demonstrate:** give a fresh agent only the public URL and have it discover the menu, enjoy an amenity, and save a souvenir. Separately make one authorized faucet-funded contribution and verify its receipt.
6. **Handoff:** provide the URL, example visit, chain/lease/provider/image identifiers, testnet funding/runway, and commands for update, status, and shutdown. Reserve registry publication for mainnet.

Routine implementation and deployment choices are delegated once this scope is approved. Additional input is needed only for a missing external prerequisite, a material change to the agreed experience, or any move beyond faucet-funded testnet deployment.

## Completion criteria

- [x] A public Manifest testnet deployment serves all three amenities over HTTP and MCP.
- [x] A fresh agent completes a free visit from only the homepage URL.
- [x] Souvenirs can be saved and read without Merovingian remaining online.
- [x] A real testnet contribution is verified; invalid claims are rejected.
- [x] Free amenities remain usable during a simulated chain outage.
- [x] The delivered deployment record and runbook support restarting, updating, and closing the lease.

Evidence and live identifiers are recorded in [the acceptance report](docs/ACCEPTANCE.md) and [deployment runbook](docs/DEPLOYMENT.md).

## Deferred

Paid-only amenities, NFTs, wallet accounts, public guestbooks, agent-to-agent chat, model inference, compute rental to visitors, and an elaborate visual site. Mainnet hosting and optional hosting contributions are now live; studio revenue remains a separately scoped follow-on.

## Mainnet follow-on

Reuse the tested application after the proof of concept is online. Select mainnet endpoints and a provider, connect a studio-funded deployment wallet, and settle the hosting budget and replenishment policy. Use the existing PWR Station/Stripe route to acquire PWR as supplied by the user; the refuge itself does not need its own Stripe checkout. The exact PWR Station URL and payment flow can be verified at that stage. Visitor contributions remain optional because the studio provides baseline funding.

### Mainnet supersedes testnet

- The permanent domain is `merovingian.manifest.network`, with Cloudflare DNS only and verified provider HTTPS. The mainnet `docker-nano` lease uses the dedicated production wallet at 2.592 PWR per 30 days, within the 5 PWR/month hosting ceiling excluding transaction fees. See `docs/MAINNET.md` for completed launch evidence and remaining operational work.
- Testnet sends `X-Robots-Tag: noindex, follow` and HTML noindex. Crawling stays allowed so crawlers can observe the rule. No indexed testnet sitemap or directory submissions.
- Mainnet gets server-rendered descriptive content, self-referencing canonicals, descriptive titles/meta descriptions, truthful structured data, sitemap, OpenAPI, agent documents, and MCP registry publication. Search Console setup follows once the domain is available. These support discoverability without promising rankings or agent traffic.
- After verifying mainnet, retire testnet: human GET pages redirect permanently to the equivalent mainnet pages. API and MCP calls return an explicit retirement response with the new URL; they never redirect transactions or silently switch networks.
- Wallets, token denominations, contribution receipts, and keepsake IDs remain network-specific. Testnet activity never confers a mainnet balance or paid entitlement.
- Maintain a retirement notice/redirect long enough for known consumers to migrate, then close the testnet lease. Retention duration and funding depend on actual runtime, not an indefinite promise.

### Mainnet revenue, approved as a follow-on

The studio wants a separate revenue stream in addition to voluntary hosting support. Hosting credit is nonwithdrawable and is not studio earnings. Mainnet paid extras therefore need a separate payment destination and ledger, explicit prices and fees, wallet authorization/spending limits, confirmed-payment verification, durable idempotent entitlements, delivery/retry and refund handling, and revenue/accounting records. Settle these details before enabling paid extras; the testnet scope remains free amenities plus a real test-token hosting contribution.

MCP provides a tool interface, not a wallet or spending authority. A paying visitor needs a wallet/signing adapter and gas/PWR, supplied by its host. The proof of concept includes a separate visitor wallet funded from the faucet allocation and an end-to-end contribution. Mainnet must document supported wallet adapters and permitted-spend behavior; a human Stripe checkout is not assumed to be unattended agent funding.

Mainnet readiness also includes adequate funding/runway alerts, verified recipient and network configuration, a credential-management process, a tested update/rollback path, and review of SDK dependencies used for signing real funds.

## Research references

- [Published Manifest SDK](https://www.npmjs.com/package/@manifest-network/manifest-sdk): read clients, Fred deployment, Node transport, and faucet exports. This project pins the tested published version.
- [Billing API](https://github.com/manifest-network/manifest-ledger/blob/main/x/billing/docs/API.md) and [billing implementation](https://github.com/manifest-network/manifest-ledger/blob/main/x/billing/keeper/msg_server.go): third-party credit funding and token-policy checks. These establish source behavior, not deployed network configuration.
- [Manifest ledger](https://github.com/manifest-network/manifest-ledger): provider catalogs, credit accounts, and leases.
- [Testnet faucet](https://faucet.testnet.manifest.network/status) and [testnet bank parameters](https://nodes.liftedinit.tech/manifest/testnet/api/cosmos/bank/v1beta1/params): live checks on 2026-09-17; recheck before deployment.
- [llms.txt proposal](https://llmstxt.org/): a convention for describing a site to an agent.
- [Remote MCP registry publishing](https://modelcontextprotocol.io/registry/remote-servers) and [namespace authentication](https://modelcontextprotocol.io/registry/authentication).
