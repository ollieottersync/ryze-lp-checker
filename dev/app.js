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
  const recentEl = document.getElementById('recent');

  // Recent wallet addresses, remembered in this browser only (localStorage —
  // nothing leaves the page). Valid-format addresses get added on each check.
  const RECENT_KEY = 'ryzeCheckerRecentWallets';
  const RECENT_MAX = 8;

  function loadRecent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(v)
        ? v.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        : [];
    } catch {
      return [];
    }
  }

  function saveRecent(wallet) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return;
    try {
      const wl = wallet.toLowerCase();
      const next = [wallet, ...loadRecent().filter((a) => a.toLowerCase() !== wl)]
        .slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable (private mode) — ignore */
    }
  }

  const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-4);

  function renderRecent() {
    const q = addrInput.value.trim().toLowerCase();
    const items = loadRecent().filter((a) => !q || a.toLowerCase().includes(q));
    recentEl.innerHTML = '';
    if (!items.length) {
      recentEl.classList.remove('on');
      return;
    }
    const h = document.createElement('div');
    h.className = 'recent-h';
    h.textContent = 'Recent wallets';
    recentEl.appendChild(h);
    for (const a of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'recent-item';
      b.title = a;
      b.textContent = shortAddr(a);
      // mousedown (not click) so the fill wins before the input loses focus.
      b.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        addrInput.value = a;
        recentEl.classList.remove('on');
      });
      recentEl.appendChild(b);
    }
    const f = document.createElement('div');
    f.className = 'recent-f';
    const note = document.createElement('span');
    note.textContent = 'Saved in this browser only';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'recent-clear';
    clear.textContent = 'Clear history';
    clear.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
      addrInput.focus();
      renderRecent();
    });
    f.appendChild(note);
    f.appendChild(clear);
    recentEl.appendChild(f);
    recentEl.classList.add('on');
  }

  addrInput.addEventListener('focus', renderRecent);
  addrInput.addEventListener('input', renderRecent);
  addrInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') recentEl.classList.remove('on');
  });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.addrwrap')) recentEl.classList.remove('on');
  });

  const money = (n) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const pct = (x) => (x * 100).toFixed(2) + '%';
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  const prettyDate = (d) => {
    try {
      return new Date(d + 'T12:00:00').toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return d;
    }
  };

  // "See how this is calculated" expander: per-pool deposit math.
  function calcDetails(r) {
    const secs = ['W', 'B']
      .map((q) => {
        const p = r.pools[q];
        const hasCalc = p.calc && p.calc.length;
        const hasWd = p.wdCalc && p.wdCalc.length;
        if (!hasCalc && !hasWd) return '';
        const lines = hasCalc
          ? p.calc
              .map((d) => {
                // A genuine pool migration netted part of this deposit away:
                // show the gross amount the wallet actually deposited plus a
                // note, instead of the silently netted figure.
                const mig = d.migrationNetted;
                const shown = mig && d.grossTotal ? d.grossTotal : d.total;
                const note = mig
                  ? ` &mdash; migration netting applied (&minus;${money(mig.total)} ` +
                    `matched against the ${prettyDate(mig.fromDate)} withdrawal), ` +
                    `net ${money(d.total)}`
                  : '';
                return (
                  `<li>${money(shown)} deposited ${prettyDate(d.date)}${note} &times; ` +
                  `${d.daysActive}/${r.days} days = <b>${money(d.contrib)}</b></li>`
                );
              })
              .join('')
          : '';
        // Withdrawals the wallet actually made, alongside the deposits —
        // previously the breakdown showed deposits only.
        const wlines = hasWd
          ? p.wdCalc
              .map(
                (w) =>
                  `<li>${money(w.total)} withdrawn ${prettyDate(w.date)}` +
                  (w.absorbed
                    ? ` &mdash; pool migration, re-deposited (netted against the deposit above)`
                    : '') +
                  `</li>`
              )
              .join('')
          : '';
        const note = p.calcExact
          ? `Adds up to the ${money(p.twap)} capital at work. The APR divides ` +
            `rewards by capital at work, not by total cost basis &mdash; money only ` +
            `counts for the days it was actually in the pool.`
          : `This pool has withdrawals, so its capital-at-work figure reflects FIFO lot ` +
            `accounting rather than the simple sum above &mdash; the deposits ` +
            `and withdrawals below show what went in and out and when.`;
        return `<h4 style="margin:10px 0 4px;font-size:0.85rem">${esc(p.name)}</h4>` +
          `<p style="margin:0 0 4px">Total cost basis <b>${money(p.gross)}</b> ` +
          `&rarr; capital at work <b>${money(p.twap)}</b></p>` +
          `<ul style="margin:4px 0;padding-left:20px">${lines}${wlines}</ul>` +
          `<p class="fine" style="margin:4px 0 0">${note}</p>`;
      })
      .filter(Boolean)
      .join('');
    if (!secs) return '';
    return `
      <details class="deet">
        <summary>See how this is calculated</summary>
        <div style="padding:2px 14px 12px;font-size:0.82rem">
          ${secs}
          <p class="fine" style="margin:10px 0 0">Total cost basis is the actual amount ` +
      `that went in, before the protocol converted it into the pool position &mdash; ` +
      `the purest comparable figure, since Ryze pools aren't 50/50 and the converted ` +
      `split differs with every deposit. Capital at work is the time-weighted capital ` +
      `the APR is figured on: a deposit made later in the window counts for fewer days, ` +
      `which is why it can read lower than total cost basis. (Converting the deposit ` +
      `into the pool position also costs a small amount in swap fees &mdash; typically ` +
      `a few dollars per deposit.) Market moves never change either number, so the APR ` +
      `is pure yield, not price appreciation. Current value is read live from each ` +
      `pool's staking gauge (getStake) and priced from the pool's reserves &mdash; ` +
      `it's the exact position right now. If the live read fails, it falls back to ` +
      `valuing your remaining deposits at today's closes, marked (est.). The gap ` +
      `between current value and capital at work is market gain or loss.</p>
        </div>
      </details>`;
  }

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
      : `<div class="hint">Capital at work couldn't be measured for this pool, so APR/APY can't be computed.</div>`;
    return `
      <div class="pool">
        <h3>${esc(p.name)}</h3>
        ${aprHtml}
        <table>
          <tr><td>APY (weekly-comp)</td><td>${p.principalKnown ? pct(p.apy) : '<span class="na">n/a</span>'}</td></tr>
          <tr><td>Total rewards</td><td>${money(p.rewards)}</td></tr>
          <tr><td>Total cost basis</td><td>${money(p.gross)}</td></tr>
          <tr><td>Current value${p.liveValue ? '' : ' (est.)'}</td><td>${money(p.curVal)}</td></tr>
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
          <div class="stat"><div class="k">Total cost basis</div><div class="v">${money(b.gross)}</div></div>
          <div class="stat"><div class="k">Current value${b.liveValue ? '' : ' (est.)'}</div><div class="v">${money(b.curVal)}</div></div>
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
        ${calcDetails(r)}
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
    saveRecent(wallet);
    recentEl.classList.remove('on');
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
      // Digest hook (stable contract for the weekly-digest automation):
      // the full analyze() result is exposed at window.__ryzeDigestResult and
      // documentElement[data-digest-ready] flips to "1" (or "error" below).
      // Empty/partial results are valid digest payloads too.
      window.__ryzeDigestResult = r;
      document.documentElement.dataset.digestReady = '1';
    } catch (err) {
      console.error(err);
      window.__ryzeDigestError = (err && err.message) || 'network error';
      document.documentElement.dataset.digestReady = 'error';
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

  // ?wallet=0x… autoplay: fills the address and runs the analysis on load.
  // Used by the weekly-digest automation (headless browser); also handy for
  // shared links. Only fires for a syntactically valid address.
  try {
    const q = (new URLSearchParams(location.search).get('wallet') || '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      addrInput.value = q;
      setTimeout(() => form.requestSubmit(), 300);
    }
  } catch {
    /* malformed URL — ignore */
  }
})();
