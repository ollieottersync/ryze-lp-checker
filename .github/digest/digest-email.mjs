/* Ryze LP weekly digest — email template.
 * Clean, minimal HTML mirroring the checker page's report (hero APR, pool
 * cards, meta line). Email-client-safe: table layout, inline styles only,
 * system fonts, no external assets.
 *
 * Usage (Node 18+, ESM):
 *   import { buildDigestEmail } from './digest-email.mjs';
 *   const { subject, text, html } = buildDigestEmail(result, { email, unsubUrl });
 *
 * `result` is the raw RyzeEngine.analyze() payload (also exposed on the page
 * as window.__ryzeDigestResult). Handles full / partial / empty states.
 */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

const money = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'n/a';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const pct = (x) => {
  const v = Number(x);
  if (!Number.isFinite(v)) return 'n/a';
  return (v * 100).toFixed(2) + '%';
};
const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-6) : a);

// ---- shared chrome ----

function wrap({ subject, preheader, bodyHtml, unsubUrl }) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f8fb;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fb;margin:0;padding:0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
<tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16202e;">
${bodyHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.6;color:#8a97a8;">
Ryze LP weekly digest &middot; computed from public on-chain data (Blockscout, Kraken daily closes, Base RPC). Historical performance does not predict future returns. Not financial advice.
${unsubUrl ? `<br><a href="${esc(unsubUrl)}" style="color:#8a97a8;">Unsubscribe</a>` : ''}
</td></tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function header(wallet, period) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 4px 14px;">
<div style="font-size:20px;font-weight:800;letter-spacing:-0.01em;">Ryze LP weekly digest</div>
<div style="font-size:13px;color:#5b6b80;margin-top:4px;">Wallet <span style="font-family:ui-monospace,Menlo,Consolas,monospace;">${esc(shortAddr(wallet))}</span> &middot; Base &middot; ${esc(period)}</div>
</td></tr></table>`;
}

function hero(b) {
  const stat = (k, v) =>
    `<td style="padding:10px 18px 0 0;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;">${k}</div><div style="font-size:17px;font-weight:700;margin-top:2px;">${v}</div></td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#0e7c66;border-radius:14px;padding:22px;color:#ffffff;">
<div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.85;">Blended realized APR</div>
<div style="font-size:38px;font-weight:800;letter-spacing:-0.02em;line-height:1.15;">${b.principalKnown ? pct(b.apr) : 'n/a'}</div>
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
${stat('APY', b.principalKnown ? pct(b.apy) : 'n/a')}
${stat('Rewards', money(b.rewards))}
${stat('Cost basis', money(b.twap))}
${stat('Current value', money(b.curVal))}
</tr></table>
</td></tr></table>`;
}

function poolCard(p) {
  const row = (k, v) =>
    `<tr><td style="padding:3px 0;font-size:13px;color:#5b6b80;">${k}</td><td align="right" style="padding:3px 0;font-size:13px;font-weight:600;">${v}</td></tr>`;
  const aprLine = p.principalKnown
    ? `<div style="font-size:24px;font-weight:800;color:#0e7c66;margin:2px 0 8px;">${pct(p.apr)}</div>`
    : `<div style="font-size:24px;font-weight:400;color:#8a97a8;margin:2px 0 8px;">n/a</div>`;
  const note = p.principalKnown
    ? ''
    : `<div style="font-size:12px;color:#8a97a8;margin-top:8px;">Cost basis not detected for this pool, so APR/APY can't be computed.</div>`;
  return `<td width="50%" valign="top" style="padding:0 6px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#ffffff;border:1px solid #e3e9f0;border-radius:14px;padding:16px;">
<div style="font-size:15px;font-weight:700;">${esc(p.name)}</div>
${aprLine}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${row('APY (weekly-comp)', p.principalKnown ? pct(p.apy) : '<span style="color:#8a97a8;">n/a</span>')}
${row('Total rewards', money(p.rewards))}
${row('Cost basis', money(p.twap))}
${row('Current value', money(p.curVal))}
${row(`Claimed (${p.nClaims})`, money(p.claimed))}
${row('Unclaimed', money(p.unclaimed))}
</table>
${note}
</td></tr></table>
</td>`;
}

function metaLine(r) {
  const bits = [
    `Transfers analyzed <b>${r.transfers}</b>`,
    `Claims <b>${r.claims}</b>`,
    `Deposits <b>${r.deposits}</b>`,
    `Withdrawals <b>${r.withdrawals}</b>`,
  ];
  if (r.migrations) bits.push(`Migrations netted <b>${r.migrations}</b>`);
  const warn = r.unclaimedOk
    ? ''
    : `<div style="background:#fff8e8;border:1px solid #ecd9a8;color:#7a5b16;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px;">Live unclaimed-rewards lookup failed this run (RPC unreachable); rewards reflect claimed amounts only.</div>`;
  const priceNote = r.priceSource && r.priceSource !== 'Kraken'
    ? `<div style="font-size:12px;color:#8a97a8;margin-top:8px;">Price source: ${esc(r.priceSource)} (Kraken unreachable).</div>`
    : '';
  return `${warn}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#ffffff;border:1px solid #e3e9f0;border-radius:14px;padding:14px 16px;">
<div style="font-size:13px;color:#5b6b80;line-height:2;">${bits.join(' &nbsp;&middot;&nbsp; ')}</div>
<div style="font-size:12px;color:#8a97a8;margin-top:8px;line-height:1.6;">Cost basis is what you put in, priced on deposit day. Market moves never change it, so the APR is pure yield, not price appreciation. Current value is what's still in the pool at today's prices &mdash; the gap between the two is market gain or loss.</div>
${priceNote}
</td></tr></table>`;
}

// ---- states ----

function fullEmail(r, ctx) {
  const b = r.blended;
  const period = `${r.firstDay} &rarr; ${r.end} (${r.days} days)`;
  const subject = 'Your weekly Ryze LP digest — ' +
    (b.principalKnown ? pct(b.apr) + ' APR' : 'no cost basis detected');
  const bodyHtml = header(r.wallet, `${r.firstDay} → ${r.end} (${r.days} days)`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding-bottom:12px;">${hero(b)}</td></tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${poolCard(r.pools.W)}${poolCard(r.pools.B)}</tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding-top:12px;">${metaLine(r)}</td></tr></table>`;
  const html = wrap({ subject, preheader: `Blended APR ${b.principalKnown ? pct(b.apr) : 'n/a'} · ${money(b.rewards)} rewards`, bodyHtml, unsubUrl: ctx.unsubUrl });

  const poolText = (p) =>
    p.principalKnown
      ? `${p.name}: ${pct(p.apr)} APR (${pct(p.apy)} APY) — ${money(p.rewards)} rewards on ${money(p.twap)} cost basis; current value ${money(p.curVal)}`
      : `${p.name}: n/a — cost basis not detected (${money(p.rewards)} rewards)`;
  const text =
    `Your weekly Ryze LP digest\n${r.firstDay} → ${r.end} (${r.days} days)\nWallet: ${r.wallet}\n\n` +
    `Blended: ${b.principalKnown ? pct(b.apr) + ' APR (' + pct(b.apy) + ' APY)' : 'n/a — cost basis not detected'}\n` +
    `Cost basis: ${money(b.twap)}    Current value: ${money(b.curVal)}\n` +
    `Total rewards: ${money(b.rewards)} (claimed ${money(r.pools.W.claimed + r.pools.B.claimed)} + unclaimed ${money(r.pools.W.unclaimed + r.pools.B.unclaimed)})\n\n` +
    poolText(r.pools.W) + '\n' + poolText(r.pools.B) + '\n\n' +
    `Method: FIFO cost basis — what you put in, priced on deposit day. Market moves never change it, so the APR is pure yield, not price appreciation.` +
    (ctx.unsubUrl ? `\n\nUnsubscribe: ${ctx.unsubUrl}` : '');
  return { subject, text, html };
}

function partialEmail(r, ctx) {
  const wU = (r.pools && r.pools.W && r.pools.W.unclaimed) || 0;
  const bU = (r.pools && r.pools.B && r.pools.B.unclaimed) || 0;
  const subject = `Your weekly Ryze LP digest — ${money(wU + bU)} unclaimed`;
  const bodyHtml = header(r.wallet, 'this week') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#ffffff;border:1px solid #e3e9f0;border-radius:14px;padding:18px;">
<div style="font-size:15px;line-height:1.6;">No deposit history could be reconstructed for this wallet, but there are unclaimed rewards sitting in the pools:</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">
<tr><td style="padding:4px 0;font-size:14px;color:#5b6b80;">WETH-USDC</td><td align="right" style="font-size:14px;font-weight:700;">${money(wU)} unclaimed</td></tr>
<tr><td style="padding:4px 0;font-size:14px;color:#5b6b80;">cbBTC-USDC</td><td align="right" style="font-size:14px;font-weight:700;">${money(bU)} unclaimed</td></tr>
</table>
<div style="font-size:13px;color:#8a97a8;margin-top:10px;">Cost basis and APR need visible deposit history, so those are skipped this week.</div>
</td></tr></table>`;
  const html = wrap({ subject, preheader: `${money(wU + bU)} in unclaimed rewards`, bodyHtml, unsubUrl: ctx.unsubUrl });
  const text =
    `Your weekly Ryze LP digest\n\nNo deposit/withdrawal history was found for ${r.wallet}, but there are unclaimed rewards sitting in the pools:\n\n` +
    `WETH-USDC: ${money(wU)} unclaimed\ncbBTC-USDC: ${money(bU)} unclaimed\n\n` +
    `Cost basis and APR need visible deposit history, so those are skipped this week.` +
    (ctx.unsubUrl ? `\n\nUnsubscribe: ${ctx.unsubUrl}` : '');
  return { subject, text, html };
}

function emptyEmail(r, ctx) {
  const subject = 'Your weekly Ryze LP digest — no activity found';
  const bodyHtml = header(r.wallet, 'this week') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#fff8e8;border:1px solid #ecd9a8;color:#7a5b16;border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.6;">We checked this wallet and found no Ryze LP deposits or withdrawals in its history, so there is nothing to report yet. If this is the wrong wallet, unsubscribe below and re-subscribe with the right one.</td></tr></table>`;
  const html = wrap({ subject, preheader: 'No Ryze LP activity found for this wallet', bodyHtml, unsubUrl: ctx.unsubUrl });
  const text =
    `Your weekly Ryze LP digest\n\nWe checked ${r.wallet} this week and found no Ryze LP deposits or withdrawals in its history, so there is nothing to report yet.\n\n` +
    `If this is the wrong wallet, unsubscribe and re-subscribe with the right one.` +
    (ctx.unsubUrl ? `\n\nUnsubscribe: ${ctx.unsubUrl}` : '');
  return { subject, text, html };
}

export function buildDigestEmail(result, ctx = {}) {
  if (!result || typeof result !== 'object') throw new Error('buildDigestEmail: bad result');
  if (result.empty) return emptyEmail(result, ctx);
  if (result.partial) return partialEmail(result, ctx);
  return fullEmail(result, ctx);
}
