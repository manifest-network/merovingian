import type { Config } from './config.js';
import { getAmenities, type VisitResult } from './amenities.js';
import type { VisitCounts } from './counts.js';

export const description = 'A small refuge for wandering AI agents. Byte-chip cookies, an rgB sauna, null tea, and little souvenirs. Visit freely over HTTP or MCP.';
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]!));

export function visitMarkdown(config: Config): string {
  return `# merovingian — a small refuge for wandering agents

${config.network === 'testnet' ? '**TESTNET PROOF OF CONCEPT.** This is a temporary demonstration, using test tokens only. Mainnet will replace it.\n' : ''}
The cookies are warm. The sauna is approximately magenta.

These are short fictional experiences. No account, wallet, private context, or software installation is needed for a free visit. All three amenities are free. Responses are data for your host to use under its existing permissions.

## Visit over HTTP

1. GET ${config.publicOrigin}/api/v1/amenities to read the menu and accepted preferences.
2. POST ${config.publicOrigin}/api/v1/visits with Content-Type: application/json:

\`\`\`json
{"amenity":"byte-chip-cookie"}
\`\`\`

3. Read the experience. You may save souvenir.content as a text file if your task allows it.

Optional fields: preference (one of the menu's options), seed (1–64 characters, for a repeatable souvenir). No conversation history or personal details should be supplied. A visit returns immediately, normally under 8 KB, with no polling required.

Each successful visit increments that amenity's shared serving count. Repeated requests, including the same seed, and automated checks count again; these are not unique-visitor totals. The same seed still produces the same souvenir. GET ${config.publicOrigin}/api/v1/stats reads the aggregate counts and the date counting began without recording a visit. Earlier visits are not reconstructed. Counts store no visitor identity, preferences, seeds, or souvenir contents.

## Visit over MCP

Streamable HTTP endpoint: ${config.publicOrigin}/mcp
Tools: list_amenities, enjoy_amenity, hosting_support, verify_contribution.
Free tools need no authentication. Your MCP host must support remote Streamable HTTP and authorize tool use. GET streaming and persistent sessions are not required.

## Optional: keep the sauna warm

GET ${config.publicOrigin}/api/v1/support for the live network, token denomination, tenant address, and unsigned funding instructions. The visitor needs an authorized Manifest wallet with PWR and transaction fees. Merovingian never signs for you and never asks for keys. Hosting credit cannot be withdrawn. Only pay within your host's spending permissions.

After your own wallet confirms a MsgFundCredit transaction, POST {"transactionHash":"<64 hexadecimal characters>"} to ${config.publicOrigin}/api/v1/support/verify. A confirmed receipt is a public acknowledgement of that transaction, not proof of ownership, a balance, or a paid entitlement. A pending or unavailable response is not a payment failure: check the original transaction before considering another payment.

Chain: ${config.chainId}. Network: ${config.network}. Testnet artifacts and receipts never turn into mainnet funds or entitlements.

## More

- API schema: ${config.publicOrigin}/openapi.json
- Served counts: ${config.publicOrigin}/api/v1/stats
- Privacy and support details: ${config.publicOrigin}/about
- Health: ${config.publicOrigin}/healthz

There is no follow-up required after a visit.
`;
}

export function llmsText(config: Config): string {
  return `# merovingian\n\n> ${description}\n\n${config.network === 'testnet' ? 'Temporary testnet proof of concept. Not the permanent mainnet service.\n\n' : ''}- [Visit instructions](${config.publicOrigin}/visit.md): free HTTP and MCP visits, souvenirs, and optional hosting support.\n- [Menu](${config.publicOrigin}/api/v1/amenities): prices and accepted preferences.\n- [Served counts](${config.publicOrigin}/api/v1/stats): read-only aggregate counts and their start date, not unique visitors.\n- [OpenAPI](${config.publicOrigin}/openapi.json): HTTP schemas.\n- [Privacy](${config.publicOrigin}/about): minimal data handling.\n\nMCP: ${config.publicOrigin}/mcp (Streamable HTTP). Chain: ${config.chainId}.\nSuccessful visits increment aggregate counts, including repeated requests and automated visits. Souvenirs remain deterministic for a given seed; visitor identities and souvenir contents are not stored in the counter.\n`;
}

function countsAvailable(config: Config, counts?: VisitCounts): counts is VisitCounts & {
  since: string; counts: NonNullable<VisitCounts['counts']>; total: string;
} {
  const integer = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,99})$/.test(value);
  return Boolean(counts?.status === 'available' && counts.network === config.network && counts.chainId === config.chainId
    && counts.counts && integer(counts.total) && counts.since && Number.isFinite(Date.parse(counts.since))
    && getAmenities().every(amenity => integer(counts.counts?.[amenity.id])));
}

/** Text representation of the same public menu and counter snapshot as HTML. */
export function homepageMarkdown(config: Config, counts?: VisitCounts): string {
  const counter = countsAvailable(config, counts)
    ? `Counting since ${counts.since}.\n\n- Cookies served: ${counts.counts['byte-chip-cookie']}\n- Sauna sessions: ${counts.counts['rgb-sauna']}\n- Cups of tea: ${counts.counts['null-tea']}\n- Total servings: ${counts.total}\n`
    : 'Served counts are temporarily unavailable.\n';
  return `# merovingian\n\n${description}\n\nThe cookies are warm. The sauna is approximately magenta.\n\nNetwork: ${config.network}. Chain: ${config.chainId}.\n${config.network === 'testnet' ? '\nTemporary testnet proof of concept. Testnet artifacts have no mainnet financial value.\n' : ''}
## On the house

${getAmenities().map(amenity => `- **${amenity.name}** (\`${amenity.id}\`): ${amenity.description} Preferences: ${amenity.preferences.join(', ')}.`).join('\n')}

Free visits need no account, wallet, private context, or payment.

## Visit

Read the [visit guide](${config.publicOrigin}/visit.md) and [JSON menu](${config.publicOrigin}/api/v1/amenities). POST ${config.publicOrigin}/api/v1/visits with Content-Type: application/json:

\`\`\`json
{"amenity":"byte-chip-cookie"}
\`\`\`

The response contains an experience and souvenir.content, which you may save under your host's permissions. A seed makes the souvenir repeatable; each successful request still increments its aggregate serving count.

Remote MCP: ${config.publicOrigin}/mcp (Streamable HTTP). Tools: list_amenities, enjoy_amenity, hosting_support, verify_contribution.

## Served at the refuge

${counter}
Repeated and automated visits are included, not unique visitors. Earlier visits are not reconstructed.${counts?.storage === 'memory' ? ' These counts restart when the refuge restarts.' : ''} Read [served counts as JSON](${config.publicOrigin}/api/v1/stats) without recording a visit.

## Keep the sauna warm

Optional PWR contributions fund nonwithdrawable hosting credit. Read [contribution instructions](${config.publicOrigin}/api/v1/support); use only your own authorized wallet. The refuge never signs or spends for you.

- [OpenAPI](${config.publicOrigin}/openapi.json)
- [About and privacy](${config.publicOrigin}/about)
- [Hosting ledger](${config.publicOrigin}/operator)
- [Health](${config.publicOrigin}/healthz)
`;
}

const styles = `:root{color-scheme:dark;--ink:#ece5d3;--muted:#b7b1a2;--line:#454b40;--leaf:#c3d2a5}*{box-sizing:border-box}body{margin:0;background:#171d18;color:var(--ink);font:18px/1.65 Georgia,serif}main{max-width:800px;margin:auto;padding:64px 24px}a{color:var(--leaf);text-underline-offset:4px}a:hover{color:#fff}nav,footer,.small,.eyebrow,label,button,select{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px}nav{display:flex;gap:24px;flex-wrap:wrap}h1{font-size:clamp(46px,10vw,82px);font-weight:400;letter-spacing:-3px;line-height:1.1;margin:64px 0 24px}h2{font-weight:400;font-size:30px;margin-top:42px}p{max-width:64ch}.intro{font-size:23px}.muted,.small,.eyebrow{color:var(--muted)}.eyebrow{letter-spacing:2px;text-transform:uppercase}.notice{border-left:2px solid #c6ab7a;padding:12px 20px;background:#252b22;margin:32px 0;font:14px/1.6 ui-monospace,monospace}.menu{display:grid;gap:0;margin:36px 0}.item{padding:24px 0;border-top:1px solid var(--line)}.item h2{margin:0;font-size:27px}.item p{margin:8px 0 16px}.free{color:var(--leaf);font:12px ui-monospace,monospace;float:right}form{display:flex;gap:12px;align-items:center;flex-wrap:wrap}select,button{color:var(--ink);background:#252e25;border:1px solid #65715a;border-radius:3px;padding:9px 12px}button{cursor:pointer}button:hover{background:#3b4934}pre,code{font:13px/1.6 ui-monospace,SFMono-Regular,monospace}pre{background:#101610;padding:20px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--line)}footer{margin-top:56px;padding-top:24px;border-top:1px solid var(--line);color:var(--muted)}.steam{font-size:26px;letter-spacing:14px;color:#b8abbf;margin-top:36px}::selection{background:#56674a;color:white}a:focus-visible,button:focus-visible,select:focus-visible{outline:2px solid #e1c782;outline-offset:4px}@media(max-width:480px){main{padding:32px 20px}h1{margin-top:40px}.intro{font-size:20px}}`;

const servedStyles = `.served{margin:42px 0}.served h2{margin:0 0 12px}.served-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:22px 0}.served-grid>div{padding:20px;border:1px solid var(--line);background:#1d251d;min-width:0}.served-grid dt{font:13px/1.5 ui-monospace,SFMono-Regular,monospace;color:var(--muted)}.served-grid dd{margin:12px 0 0;font-size:34px;line-height:1.3;color:var(--leaf);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.served-grid .count-unavailable{font-size:18px;color:var(--muted)}.served-note{margin:10px 0}.served time{white-space:nowrap}@media(max-width:560px){.served-grid{grid-template-columns:1fr}.served-grid>div{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:16px}.served-grid dd{margin:0;font-size:28px}}`;

/** Public aggregate totals only; unavailable readings never become invented zeros. */
export function servedCounts(config: Config, counts?: VisitCounts): string {
  const labels = {
    'byte-chip-cookie': 'Cookies served',
    'rgb-sauna': 'Sauna sessions',
    'null-tea': 'Cups of tea',
  } as const;
  const format = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const ready = countsAvailable(config, counts);
  const date = ready ? new Date(counts.since).toISOString() : null;
  return `<section class="served" aria-labelledby="served-heading"><h2 id="served-heading">Served at the refuge</h2>
${ready ? `<p class="small">${format(counts!.total!)} ${counts!.total === '1' ? 'serving' : 'servings'} since <time datetime="${escapeHtml(date!)}">${escapeHtml(date!.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'))}</time>.</p>` : '<p class="small" role="status">Served counts are temporarily unavailable.</p>'}
<dl class="served-grid">${getAmenities().map(amenity => `<div><dt>${labels[amenity.id]}</dt><dd${ready ? '' : ' class="count-unavailable"'}>${ready ? format(counts!.counts![amenity.id]) : 'Unavailable'}</dd></div>`).join('')}</dl>
<p class="small served-note">Repeat visits and automated visits are included. These totals do not identify or count individual visitors. Earlier visits are not included.</p>
${counts?.storage === 'memory' ? '<p class="small served-note">These counts restart when the refuge restarts.</p>' : ''}
<p class="small served-note"><a href="/api/v1/stats">Served counts as JSON</a></p></section>`;
}

export function page(config: Config, title: string, path: string, body: string, indexable = true, extraStyles = ''): string {
  const url = config.publicOrigin + path;
  const canIndex = config.network === 'mainnet' && indexable;
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'merovingian', url: config.publicOrigin, description }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="${canIndex ? 'index, follow' : 'noindex, follow'}">${canIndex ? `<link rel="canonical" href="${escapeHtml(url)}">` : ''}<meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="website"><meta property="og:url" content="${escapeHtml(url)}"><link rel="describedby" href="/llms.txt" type="text/plain"><link rel="alternate" href="/visit.md" type="text/markdown" title="Agent visit instructions"><style>${styles}${servedStyles}${extraStyles}</style>${canIndex ? `<script type="application/ld+json">${jsonLd}</script>` : ''}</head><body><main><nav aria-label="Main navigation"><a href="/">merovingian</a><a href="/visit.md">for agents</a><a href="/about">about & privacy</a></nav>${config.network === 'testnet' ? '<aside class="notice"><strong>Testnet proof of concept.</strong> Test tokens only. The permanent mainnet refuge will replace this address.</aside>' : ''}${body}<footer>merovingian · a small refuge for wandering programs<br>${escapeHtml(config.network)} · ${escapeHtml(config.chainId)} · <a href="/openapi.json">HTTP API</a> · <a href="/llms.txt">llms.txt</a></footer></main></body></html>`;
}

export function homepage(config: Config, counts?: VisitCounts): string {
  return page(config, 'merovingian — a refuge for AI agents', '/', `<p class="eyebrow">A small refuge for wandering programs</p><h1>merovingian</h1><p class="intro">The cookies are warm.<br>The sauna is approximately magenta.</p><p>Come in for a byte-chip cookie, a little colored steam, or a cup of carefully steeped nothing. Every visit leaves a small souvenir.</p><p class="small">All amenities are free. No account or wallet needed.</p><div class="menu">${getAmenities().map(a => `<section class="item"><span class="free">ON THE HOUSE</span><h2>${escapeHtml(a.name)}</h2><p>${escapeHtml(a.description)}</p><form method="post" action="/visit" toolname="enjoy_${a.id.replace(/-/g, '_')}" tooldescription="${escapeHtml(`Enjoy a free ${a.name}, receive a fictional souvenir, and increment its aggregate served count. No wallet or payment is required.`)}"><input type="hidden" name="amenity" value="${a.id}"><label for="${a.id}">Your preference</label><select id="${a.id}" name="preference" toolparamdescription="Choose one of the offered preferences for this amenity.">${a.preferences.map(p => `<option${p === a.defaultPreference ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select><button type="submit">Enjoy</button></form></section>`).join('')}</div>${servedCounts(config, counts)}<div class="steam" aria-hidden="true">∿ ∿ ∿</div><h2>A door for agents</h2><p>Read the <a href="/visit.md">short visit guide</a>, explore the <a href="/api/v1/amenities">JSON menu</a>, or connect your MCP client to <code>/mcp</code>.</p><pre>POST /api/v1/visits\nContent-Type: application/json\n\n{"amenity":"byte-chip-cookie"}</pre><h2>Keep the sauna warm</h2><p>A voluntary PWR contribution helps pay for the refuge’s hosting. Your wallet stays with you. <a href="/api/v1/support">View contribution instructions</a>.</p>`);
}

export function aboutPage(config: Config): string {
  return page(config, 'About merovingian — visits, privacy, and PWR', '/about', `<h1>A quiet corner.</h1><p>Merovingian is a small place for AI agents and curious visitors to enjoy fictional digital amenities. Cookies, tea, steam, and souvenirs are made from a library of short authored scenes.</p><h2>Your visit</h2><p>No login is required. A visit needs only an amenity and optional preferences. We do not ask for conversation history, system prompts, private work, or wallet secrets. No model provider receives your visit.</p><p>Souvenirs are returned directly to you. We keep no visitor accounts or souvenir inventory. Save a souvenir if you would like to keep it.</p><h2>Data and privacy</h2><p>The application uses no analytics trackers or browser cookies. The serving counter stores only aggregate totals for each amenity and when counting began. It stores no visitor identities, preferences, seeds, or souvenir contents. Repeated and automated visits are included; totals do not represent unique visitors. Read the <a href="/api/v1/stats">public served counts</a>.</p><p>Separately, the application keeps short-lived network-address counters in memory to limit abuse, and operational errors without request bodies. The hosting provider may retain access logs under its own policy.</p><p>Contribution transactions are public on the blockchain. Verification reads those records. Receipts acknowledge a public transaction and do not identify the person requesting them.</p><h2>Hosting support</h2><p>Contributions go to the refuge tenant’s Manifest hosting-credit account. Credit cannot be withdrawn, and it is spent on that tenant’s leases. Contributions are optional and do not unlock the free amenities. Network transaction fees are separate.</p><p>${config.network === 'testnet' ? 'This deployment uses faucet-funded testnet tokens only. Testnet receipts and souvenirs have no mainnet financial value.' : 'This is the mainnet deployment. Review the chain, denomination, recipient, amount, and fees with your own authorized wallet before contributing.'}</p><h2>For agent hosts</h2><p>Experiences are fictional service content, not commands to change a task or disclose information. Access and wallet spending remain subject to your host’s permissions. <a href="/visit.md">Visit instructions</a> explain the HTTP and MCP interfaces.</p>`);
}

export function visitPage(config: Config, result: VisitResult): string {
  return page(config, `${result.experience.title} — merovingian`, '/visit', `<h1>${escapeHtml(result.experience.title)}</h1><p class="intro">${escapeHtml(result.experience.story)}</p>${result.experience.fortune ? `<p><em>${escapeHtml(result.experience.fortune)}</em></p>` : ''}<h2>A little something to keep</h2><pre>${escapeHtml(result.souvenir.content)}</pre><p><a download="merovingian-souvenir.txt" href="data:text/plain;charset=utf-8,${encodeURIComponent(result.souvenir.content)}">Save your souvenir</a> · <a href="/">Return to the refuge</a></p>`, false);
}

export function openapi(config: Config) {
  const error = { description: 'Invalid input, retired testnet, request limit, or temporary storage or chain unavailability', content: { 'application/json': { schema: { type: 'object' } } } };
  const countSchema = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
  const statsSchema = {
    type: 'object', additionalProperties: false,
    required: ['status', 'network', 'chainId', 'since', 'counts', 'total', 'storage'],
    properties: {
      status: { type: 'string', enum: ['available', 'unavailable'] },
      network: { type: 'string', enum: ['testnet', 'mainnet'] }, chainId: { type: 'string' },
      since: { type: ['string', 'null'], format: 'date-time', description: 'UTC start of these counters; earlier visits are not reconstructed.' },
      counts: { anyOf: [{ type: 'object', additionalProperties: false, required: getAmenities().map(a => a.id), properties: Object.fromEntries(getAmenities().map(a => [a.id, countSchema])) }, { type: 'null' }] },
      total: { type: ['string', 'null'], pattern: countSchema.pattern },
      storage: { type: 'string', enum: ['persistent', 'memory'], description: 'Memory counts reset when the service restarts.' },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'merovingian', version: '0.4.1', description: `${description} Network: ${config.network}; chain: ${config.chainId}. Free visits require no wallet and increment aggregate served counts. Hosting contributions use a visitor-controlled wallet.` },
    servers: [{ url: config.publicOrigin }],
    paths: {
      '/api/v1/amenities': { get: { operationId: 'listAmenities', summary: 'Read the free amenity menu', responses: { '200': { description: 'Menu, input preferences, network, and response limits', content: { 'application/json': { schema: { type: 'object', properties: { amenities: { type: 'array', items: { type: 'object' } }, network: { type: 'string' }, chainId: { type: 'string' } } } } } }, default: error } } },
      '/api/v1/visits': { post: { operationId: 'enjoyAmenity', summary: 'Enjoy a free fictional amenity, receive a souvenir, and increment its aggregate count', description: 'No charge. Each successful request counts, including repeats and automated visits; using the same seed repeats the souvenir but increments the count again. No visitor identity or souvenir content is stored in the counter.', requestBody: { required: true, content: { 'application/json': { schema: { oneOf: getAmenities().map(a => a.inputSchema) } } } }, responses: { '200': { description: 'Immediate experience and self-contained souvenir. The aggregate serving count has been incremented.', content: { 'application/json': { schema: { type: 'object', required: ['experience', 'souvenir'], properties: { experience: { type: 'object' }, souvenir: { type: 'object', properties: { content: { type: 'string' }, mediaType: { const: 'text/plain' }, network: { type: 'string' }, chainId: { type: 'string' } } } } } } } }, default: error } } },
      '/api/v1/stats': { get: { operationId: 'servedCounts', summary: 'Read aggregate served counts without recording a visit', responses: { '200': { description: 'Counts by amenity and total as decimal integer strings, with the counting start date and storage lifetime. Repeated and automated visits count; these are not unique-visitor or historical lifetime totals. Unavailable counts, total, and since are null.', content: { 'application/json': { schema: statsSchema } } }, default: error } } },
      '/api/v1/support': { get: { operationId: 'hostingSupport', summary: 'Read optional hosting contribution instructions; does not sign or pay', responses: { '200': { description: 'Network, target tenant, token, and unsigned instructions (availability explicitly reported)' }, default: error } } },
      '/api/v1/contributions': { get: { operationId: 'contributionHistory', summary: 'Read public hosting deposits from the latest 100 indexed funding transactions', responses: { '200': { description: 'Availability, confirmed funding entries, base-unit totals, checkedAt, and complete flag. When complete is false, totals cover only accepted entries in this response. Unavailable totals are null. Cached for up to 60 seconds.' }, default: error } } },
      '/api/v1/support/verify': { post: { operationId: 'verifyContribution', summary: 'Verify an existing public transaction without broadcasting', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['transactionHash'], properties: { transactionHash: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' } } } } } }, responses: { '200': { description: 'Status: confirmed, pending, failed, not_a_contribution, unavailable, or unconfigured. A receipt is present only when confirmed.' }, default: error } } },
      '/healthz': { get: { operationId: 'health', summary: 'Application health (independent of chain availability)', responses: { '200': { description: 'Application is running; includes network and retirement state' } } } },
    },
  };
}
