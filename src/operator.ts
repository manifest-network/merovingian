import type { Config } from './config.js';
import { escapeHtml as html, page, servedCounts } from './documents.js';
import type { ContributionHistory, SupportInfo } from './support.js';
import type { VisitCounts } from './counts.js';

const styles = `main{max-width:1000px}.dashboard-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}.dashboard-heading h1{font-size:clamp(40px,8vw,64px);margin:16px 0}.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:32px 0}.metric{padding:22px;border:1px solid var(--line);background:#1d251d;min-width:0}.metric h2{font:13px/1.5 ui-monospace,monospace;color:var(--muted);margin:0 0 12px}.amount{font-size:32px;line-height:1.3;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.unit{font:12px ui-monospace,monospace;color:var(--muted)}.metric p{margin:12px 0 0}.table-scroll{overflow-x:auto;border-top:1px solid var(--line)}table{width:100%;border-collapse:collapse;font:13px/1.6 ui-monospace,monospace}caption{text-align:left;padding:16px 0;color:var(--muted)}th,td{text-align:left;padding:18px 14px 18px 0;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:400}td.money{white-space:nowrap;font-variant-numeric:tabular-nums}td time{white-space:nowrap}details{max-width:28ch}summary{cursor:pointer;color:var(--leaf)}details code,.address{overflow-wrap:anywhere}.ledger-tools{display:flex;gap:20px;flex-wrap:wrap}.empty{padding:24px;border:1px solid var(--line)}@media(max-width:600px){.metrics{grid-template-columns:1fr}.metric{padding:18px}.dashboard-heading{align-items:flex-start}}`;

/** PWR has six base-unit decimals; keep financial values out of floating point. */
export function formatPwr(amount: string): string {
  if (!/^(0|[1-9][0-9]{0,99})$/.test(amount)) return 'Unknown';
  const value = BigInt(amount);
  const whole = (value / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return whole + (fraction ? `.${fraction}` : '');
}

function creditAmount(info: SupportInfo, kind: 'available' | 'reserved'): string | null {
  if (info.status !== 'available' || !info.hostingCredit || !Array.isArray(info.hostingCredit[kind])) return null;
  let amount = 0n;
  for (const coin of info.hostingCredit[kind]) {
    if (coin.denom !== info.denom) continue;
    if (!/^(0|[1-9][0-9]{0,77})$/.test(coin.amount)) return null;
    amount += BigInt(coin.amount);
  }
  return amount.toString();
}

function time(value: string | null): string {
  if (!value) return 'Not checked';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return html(value);
  return `<time datetime="${html(date.toISOString())}">${html(date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'))}</time>`;
}

function metric(label: string, amount: string | null, unit: string, note: string): string {
  return `<section class="metric"><h2>${html(label)}</h2><div class="amount">${amount === null ? 'Unknown' : formatPwr(amount)} <span class="unit">${html(unit)}</span></div><p class="small">${note}</p></section>`;
}

function transactionLink(config: Config, hash: string): string {
  if (!/^[A-Fa-f0-9]{64}$/.test(hash)) return html(hash);
  const url = config.restUrl
    ? `${config.restUrl.replace(/\/$/, '')}/cosmos/tx/v1beta1/txs/${hash}`
    : `${config.rpcUrl.replace(/\/$/, '')}/tx?hash=0x${hash}&prove=false`;
  return `<a href="${html(url)}" title="${html(hash)}" aria-label="View transaction ${html(hash)}">${html(hash.slice(0, 8))}…${html(hash.slice(-6))}</a>`;
}

export function operatorPage(config: Config, history: ContributionHistory, info: SupportInfo, counts?: VisitCounts): string {
  const unit = config.network === 'testnet' ? 'test PWR' : 'PWR';
  const ready = history.status === 'available';
  const totals = ready ? history.totals : null;
  const fundingLabel = history.complete ? 'Total funding' : 'Funding in recent history';
  const totalNote = totals ? `${formatPwr(totals.tenantAmount)} ${unit} from the tenant wallet.` : 'Funding history is unavailable.';
  const historyUrl = config.restUrl && config.tenant ? new URL(`${config.restUrl.replace(/\/$/, '')}/cosmos/tx/v1beta1/txs`) : null;
  if (historyUrl) historyUrl.search = new URLSearchParams({ query: `credit_funded.tenant='${config.tenant}'`, order_by: 'ORDER_BY_DESC', limit: '100', page: '1' }).toString();
  const rows = ready ? history.entries.map(entry => `<tr><td>${time(entry.timestamp)}</td><td class="money">${formatPwr(entry.amount)}<br><span class="muted">${html(unit)}</span></td><td><details><summary>${entry.sender === config.tenant ? 'Tenant wallet' : 'Other wallet'}</summary><code>${html(entry.sender)}</code></details></td><td>${transactionLink(config, entry.transactionHash)}<br><span class="muted">Block ${html(entry.height)}</span></td></tr>`).join('') : '';
  const historyNotice = !ready
    ? `<aside class="notice" role="status">${html(history.message)} Refresh to try again. An unavailable query does not mean zero contributions.</aside>`
    : !history.complete
      ? `<aside class="notice">Recent history only. Totals cover the contributions shown, not lifetime funding. ${html(history.message)}</aside>`
      : '';
  const creditNotice = info.status !== 'available' || !info.hostingCredit
    ? '<aside class="notice" role="status">Hosting credit is unavailable. Funding history and free visits remain independent of this balance query.</aside>'
    : '';
  return page(config, 'Operator dashboard — merovingian', '/operator', `
<p class="eyebrow">Operator dashboard</p>
<div class="dashboard-heading"><h1>The hosting ledger.</h1><form action="/operator" method="get"><button type="submit">Refresh</button></form></div>
<p>Every contribution keeps the sauna a little warmer. This read-only view shows the refuge’s served counts and public hosting records.</p>
${servedCounts(config, counts)}
<p class="small">Funding and credit readings are cached for up to 60 seconds. Dates are in UTC.</p>
${historyNotice}${creditNotice}
<div class="metrics">
${metric(fundingLabel, totals?.amount ?? null, unit, totalNote)}
${metric('From other wallets', totals?.otherAmount ?? null, unit, 'Wallet addresses do not identify individual visitors. Includes any test contributions.')}
${metric('Available hosting credit', creditAmount(info, 'available'), unit, 'Credit available for hosting. Accrued charges may appear only after settlement.')}
${metric('Reserved hosting credit', creditAmount(info, 'reserved'), unit, 'Credit held for active leases; already part of the funded account.')}
</div>
<p class="small">History checked: ${time(history.checkedAt)}<br>Credit checked: ${time(info.checkedAt)}</p>
<h2>Contribution history</h2>
<p class="small">Successful PWR hosting deposits, newest first. Multiple deposits from one wallet in the same transaction are combined. Expand a wallet to see its address; transaction links open the chain’s JSON record.</p>
${rows ? `<div class="table-scroll" role="region" aria-label="Contribution history" tabindex="0"><table><caption>${history.entries.length} funding ${history.entries.length === 1 ? 'entry' : 'entries'} · ${history.scannedTransactions} of ${history.indexedTransactions ?? 'unknown'} indexed transactions checked</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Amount</th><th scope="col">Source</th><th scope="col">Transaction</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="empty">${ready ? 'No matching contributions found in the checked transactions.' : 'Contribution history is temporarily unavailable.'}</p>`}
<p class="small ledger-tools"><a href="/api/v1/contributions">History as JSON</a>${historyUrl ? `<a href="${html(historyUrl.toString())}">Chain history query</a>` : ''}</p>
<h2>Where the funds go</h2>
<p>Funding totals measure deposits. Available and reserved credit show the account’s current balance, which changes as hosting is settled. Hosting deposits cannot be withdrawn. Studio revenue will be tracked separately when paid extras launch.</p>
<p class="small">Tenant<br><code class="address">${html(config.tenant || 'Not configured')}</code></p>
<p class="small">Token denomination<br><code class="address">${html(config.pwrDenom)}</code></p>
<p class="small">Public aggregate counts and chain data only. No wallet connection or sign-in is needed. This page cannot spend funds or change the deployment.</p>`, false, styles);
}
