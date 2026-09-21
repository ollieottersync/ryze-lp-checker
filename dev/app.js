/* UI wiring for the Ryze LP performance checker. Runs after RyzeEngine. */
(() => {
  'use strict';

  const form = document.getElementById('form');
  const addrInput = document.getElementById('addr');
  const goBtn = document.getElementById('go');
  const progressEl = document.getElementById('progress');
  const barFill = document.getElementById('barfill');
  const pmsg = document.getElementById('pmsg');
  const errEl = document.getElementById('err');
  const resultsEl = document.getElementById('results');

  const money = (n) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const pct = (x) => (x * 100).toFixed(2) + '%';
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-6);

  // stage -> [from%, to%]
  const STAGES = {
    transfers: [0, 38],
    deposits: [38, 58],
    withdrawals: [58, 68],
    unclaimed: [68, 74],
    prices: [74, 90],
    compute: [90, 100],
  };

  function setProgress(stage, done, total, msg) {
    const [a, b] = STAGES[stage] || [0, 0];
    let frac = 0;
    if (total > 0) frac = Math.min(1, done / total);
    else if (done > 0) frac = 1;
    barFill.style.width = (a + (b - a) * frac).toFixed(1) + '%';
    if (msg) pmsg.textContent = msg;
  }

  function showError(text) {
    errEl.textContent = text;
    errEl.classList.add('on');
  }
  function clearError() {
    errEl.classList.remove('on');
    errEl.textContent = '';
  }

  function poolCard(q, p) {
    const aprHtml = p.principalKnown
      ? `<div class="apr">${pct(p.apr)}</div>`
      : `<div class="apr na">n/a</div>`;
    const note = p.principalKnown
      ? ''
      : `<div class="hint">Cost basis not detected for this pool, so APR/APY can't be computed.</div>`;
    return `
      <div class="pool">
        <h3>${esc(p.name)}</h3>
        ${aprHtml}
        <table>
          <tr><td>APY (weekly-comp)</td><td>${p.principalKnown ? pct(p.apy) : '<span class="na">n/a</span>'}</td></tr>
          <tr><td>Total rewards</td><td>${money(p.rewards)}</td></tr>
          <tr><td>Cost basis</td><td>${money(p.twap)}</td></tr>
          <tr><td>Current value</td><td>${money(p.curVal)}</td></tr>
          <tr><td>Claimed (${p.nClaims})</td><td>${money(p.claimed)}</td></tr>
          <tr><td>Unclaimed</td><td>${money(p.unclaimed)}</td></tr>
        </table>
        ${note}
      </div>`;
  }

  function render(r) {
    if (r.empty) {
      resultsEl.innerHTML = `
        <div class="notice">No Ryze LP activity found for
          <code>${esc(shortAddr(r.wallet))}</code>. This address has no detected
          deposits, withdrawals, or reward claims in the Ryze gauge pools.</div>`;
      resultsEl.classList.add('on');
      return;
    }
    if (r.partial) {
      const tot = r.pools.W.rewards + r.pools.B.rewards;
      resultsEl.innerHTML = `
        <p class="walletline">Wallet <code>${esc(r.wallet)}</code></p>
        <div class="notice">This address has <b>${money(tot)}</b> in unclaimed Ryze
          rewards, but no deposit history could be reconstructed from its transfer
          history, so APR can't be computed. (WETH-USDC: ${money(r.pools.W.rewards)} ·
          cbBTC-USDC: ${money(r.pools.B.rewards)})</div>`;
      resultsEl.classList.add('on');
      return;
    }

    const b = r.blended;
    const unclaimedWarn = r.unclaimedOk
      ? ''
      : `<div class="notice">Live unclaimed-rewards lookup failed (RPC unreachable);
         rewards below reflect claimed amounts only.</div>`;
    const priceNote =
      r.priceSource === 'Kraken'
        ? ''
        : `<div class="hint">Price source: ${esc(r.priceSource)} (Kraken unreachable).</div>`;

    resultsEl.innerHTML = `
      <p class="walletline">Wallet <code>${esc(r.wallet)}</code> · Base ·
        ${esc(r.firstDay)} → ${esc(r.end)} (${r.days} days)</p>
      ${unclaimedWarn}
      <div class="blend">
        <div class="k">Blended realized APR</div>
        <div class="big">${b.principalKnown ? pct(b.apr) : 'n/a'}</div>
        <div class="row2">
          <div class="stat"><div class="k">APY</div><div class="v">${b.principalKnown ? pct(b.apy) : 'n/a'}</div></div>
          <div class="stat"><div class="k">Rewards</div><div class="v">${money(b.rewards)}</div></div>
          <div class="stat"><div class="k">Cost basis</div><div class="v">${money(b.twap)}</div></div>
          <div class="stat"><div class="k">Current value</div><div class="v">${money(b.curVal)}</div></div>
        </div>
      </div>
      <div class="pools">
        ${poolCard('W', r.pools.W)}
        ${poolCard('B', r.pools.B)}
      </div>
      <div class="card" style="margin-bottom:0">
        <div class="meta">
          <span>Transfers analyzed <b>${r.transfers}</b></span>
          <span>Claims <b>${r.claims}</b></span>
          <span>Deposits <b>${r.deposits}</b></span>
          <span>Withdrawals <b>${r.withdrawals}</b></span>
          ${r.migrations ? `<span>Pool migrations netted <b>${r.migrations}</b></span>` : ''}
        </div>
        <div class="hint">Cost basis is what you put in, priced on deposit day.
          Market moves never change it, so the APR is pure yield, not price
          appreciation. Current value is what's still in the pool at today's
          prices — the gap between the two is market gain or loss.</div>
        ${priceNote}
      </div>`;
    resultsEl.classList.add('on');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    resultsEl.classList.remove('on');
    const wallet = addrInput.value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      showError('That doesn\'t look like a valid Base address — it should be 0x followed by 40 hex characters.');
      return;
    }
    goBtn.disabled = true;
    progressEl.classList.add('on');
    barFill.style.width = '0%';
    // Surface rate-limit backoff in the progress line instead of stalling silently.
    RyzeEngine.setRetryHook((msg) => { pmsg.textContent = msg; });
    try {
      const r = await RyzeEngine.analyze(wallet, { onProgress: setProgress });
      barFill.style.width = '100%';
      pmsg.textContent = 'Done.';
      render(r);
    } catch (err) {
      console.error(err);
      if (err && err.message === 'invalid-address') {
        showError('Invalid address format.');
      } else if (err && /HTTP 429/.test(err.message || '')) {
        showError(
          'Blockscout is rate-limiting requests right now. Your progress is saved — ' +
          'wait a minute and tap "Check performance" again to pick up where it left off.'
        );
      } else {
        showError(
          'Something went wrong while fetching data (' +
            (err && err.message ? err.message : 'network error') +
            '). Please check your connection and try again.'
        );
      }
    } finally {
      RyzeEngine.setRetryHook(null);
      goBtn.disabled = false;
      setTimeout(() => progressEl.classList.remove('on'), 1200);
    }
  });
})();
