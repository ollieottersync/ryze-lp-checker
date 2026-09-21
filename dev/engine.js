/* ============================================================================
 * Ryze LP performance engine — browser port of analyze_apr.py
 *
 * Pure logic, no DOM. Works in any modern browser (fetch) and in Node 18+.
 * All computation runs client-side against public APIs:
 *   - Blockscout v2 (Base): token transfer history + per-tx token transfers
 *   - Kraken public OHLC: daily closes for ETH and BTC (USDC = $1)
 *   - Public Base RPC (eth_call): claimable-rewards view per pool
 *
 * Method (mirrors the Python reference):
 *   1. Claims  = pool -> wallet USDC transfers (>= $0.05).
 *   2. Deposits = txs where the wallet sends USDC/WETH/cbBTC and the same tx
 *      deposits an LP token into a Ryze gauge pool. Helper dust returned to
 *      the wallet in the same tx is netted off. Plain swaps (no LP deposit
 *      in the tx) are excluded.
 *   3. Withdrawals = txs where a pool LP token is burned (to 0x0) and
 *      underlying (USDC/WETH/cbBTC) is returned to the wallet in the same
 *      tx. The burn separates withdrawals from plain reward payouts.
 *   3b. Migrations = a withdrawal matched against same-pool deposits in
 *      the following 2 days (e.g. a pool migration: withdraw from the old pool,
 *      re-deposit into the new one). The pair nets to its capital delta so the
 *      re-deposit is not counted as brand-new principal.
 *   4. Principal series per pool = cumulative cost basis: each deposit /
 *      withdrawal is valued in USD at the close on ITS OWN day (what the LP
 *      actually put in / took out), summed per pool per day and floored at
 *      zero. Price moves after a flow NEVER change principal — marking the
 *      position to market would let appreciation leak into the APR
 *      denominator and corrupt the yield figure.
 *   5. TWAP, realized APR = rewards/TWAP * 365/days,
 *      APY = (1+APR/52)^52 - 1.
 *   6. Unclaimed rewards read live from each pool's claimable-rewards view.
 *   7. Current value is read LIVE from each staking gauge via
 *      getStake(address) — the wallet's true on-chain LP-token balance,
 *      priced as pool TVL / LP supply. If the read fails, the engine falls
 *      back to valuing the remaining FIFO lots at current closes and flags
 *      the figure as an estimate (liveValue: false).
 *
 * Deposits and withdrawals are auto-detected from on-chain transfers for
 * every wallet — no wallet-specific history is hardcoded anywhere.
 * ========================================================================== */

const RyzeEngine = (() => {
  'use strict';

  // ------------------------------------------------------------- config ---
  const WETH_VAULT = '0x82665512097280502Be785C5070090f628dE002F';
  const CBBTC_VAULT = '0x5C6fBb8551E632dFA07DF3FcD98d1f3AA4F11252';
  const PRE_WETH_VAULT = '0xe44bEdeFBe981729B6Bbbc7C8CE96bb93d27A253';
  const PRE_CBBTC_VAULT = '0x8fBFFe829825B55C70190e7f8fEA55995ED0515d';
  const HELPER = '0xCA8A097f627ef41Be12EbF7433F5B6b8A114D77b';
  const OLD_HELPER = '0x1406Fd746969A6ef440BE24547433C1c28Dee803';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const ZERO = '0x0000000000000000000000000000000000000000';

  const CLAIMABLE_SEL = '7a27db57'; // claimableRewards(address user, address token)
  const GETSTAKE_SEL = '7a766460'; // getStake(address) -> (uint256 stakedLP, uint256 since)
  const RYZE_TVL_API = 'https://mainnet.api.ryze.pro/api/analytics/tvl';
  // LP-token contracts (the pools themselves) — used to price LP tokens when
  // the analytics API is down: totalSupply() on the pool, balanceOf(pool) on
  // each underlying token. Same shape as the API path, computed on-chain.
  const RYZE_POOLS = {
    W: '0x22f902cEfcF8b0bEc6489Cb8ac11FdDa9B2aF125', // Ryze WETH-USDC Pool
    B: '0x40F3DAaE59BfE03f9Fb019Bb089Bb0C381DE27Cf', // Ryze cbBTC-USDC Pool
  };
  const WETH = '0x4200000000000000000000000000000000000006';
  const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
  const UNDERLYING_DECIMALS = { USDC: 6, WETH: 18, CBBTC: 8 };

  const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
  const KRAKEN = 'https://api.kraken.com/0/public/OHLC';
  const RPCS = [
    'https://rpc-base.ottersync.io/', // team's own Ottersync node — first priority
    'https://base.drpc.org',
    'https://1rpc.io/base',
    'https://mainnet.base.org',
  ];

  const TOKENS = ['USDC', 'WETH', 'CBBTC'];
  const POOL_NAMES = { W: 'WETH-USDC', B: 'cbBTC-USDC' };

  const CLAIM_VAULTS = {
    [WETH_VAULT.slice(0, 10).toLowerCase()]: 'W',
    [CBBTC_VAULT.slice(0, 10).toLowerCase()]: 'B',
    [PRE_WETH_VAULT.slice(0, 10).toLowerCase()]: 'W',
    [PRE_CBBTC_VAULT.slice(0, 10).toLowerCase()]: 'B',
  };
  const VAULT_SET = new Set(
    [WETH_VAULT, CBBTC_VAULT, PRE_WETH_VAULT, PRE_CBBTC_VAULT].map((a) =>
      a.toLowerCase()
    )
  );

  function poolOf(addrLower) {
    if (!addrLower) return null;
    if (VAULT_SET.has(addrLower)) {
      return (
        CLAIM_VAULTS[addrLower.slice(0, 10)] ||
        (addrLower.startsWith(WETH_VAULT.slice(0, 10).toLowerCase()) ||
        addrLower.startsWith(PRE_WETH_VAULT.slice(0, 10).toLowerCase())
          ? 'W'
          : 'B')
      );
    }
    return CLAIM_VAULTS[addrLower.slice(0, 10)] || null;
  }

  // ------------------------------------------------------------- helpers --
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Optional hook so the UI can tell the visitor what's happening during
  // retries (e.g. "Blockscout rate-limited us — backing off…"). Set via
  // RyzeEngine.setRetryHook(fn); cleared by passing null.
  let _retryHook = null;
  function setRetryHook(fn) {
    _retryHook = typeof fn === 'function' ? fn : null;
  }
  function noteRetry(msg) {
    try {
      if (_retryHook) _retryHook(msg);
    } catch {
      /* hook must never break the fetch path */
    }
  }

  // ------------------------------------------------------- persistent cache --
  // Blockscout throttles aggressively per IP, and mobile-carrier IPs are
  // shared by thousands of users, so a phone on cellular data can get
  // hard-throttled mid-analysis. Two mitigations, both in localStorage:
  //   1. Per-tx token transfers are IMMUTABLE — cache them forever. A retry
  //      after a rate-limit resumes where the previous attempt died instead
  //      of re-fetching hundreds of transactions from scratch.
  //   2. The wallet's transfer list changes with new activity — cache it for
  //      10 minutes so an immediate retry skips Blockscout entirely.
  // Caching is best-effort: private mode / quota errors just mean no cache.
  const _store = (() => {
    try {
      if (typeof localStorage === 'undefined') return null;
      localStorage.setItem('__ryze_probe', '1');
      localStorage.removeItem('__ryze_probe');
      return localStorage;
    } catch {
      return null;
    }
  })();
  const TX_CACHE_PREFIX = 'ryze.v1.tx.';
  const ADDR_CACHE_PREFIX = 'ryze.v1.addr.';
  const ADDR_CACHE_TTL_MS = 10 * 60 * 1000;

  function cacheGet(key) {
    if (!_store) return null;
    try {
      const raw = _store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function cacheSet(key, val) {
    if (!_store) return;
    try {
      _store.setItem(key, JSON.stringify(val));
    } catch {
      /* quota or private mode — caching is best-effort */
    }
  }
  // Compact transfer tuple: [txHash, logIndex, symbol, value, decimals, from, to, timestamp]
  // Only the fields the extractors read (sym/amt/addrOf/dayOf/txHash/logIndex).
  function packTransfer(x) {
    return [
      x.transaction_hash || '',
      x.log_index == null ? '' : String(x.log_index),
      sym(x),
      (x.total && x.total.value != null ? String(x.total.value) : '0'),
      (x.token && x.token.decimals != null ? String(x.token.decimals) : '18'),
      addrOf(x.from),
      addrOf(x.to),
      x.timestamp || '',
    ];
  }
  function unpackTransfer(t) {
    return {
      transaction_hash: t[0],
      log_index: t[1],
      token: { symbol: t[2], decimals: t[4] },
      total: { value: t[3] },
      from: { hash: t[5] },
      to: { hash: t[6] },
      timestamp: t[7],
    };
  }

  // Blockscout's public API rate-limits burst traffic (HTTP 429). Serialize
  // Blockscout requests behind a small pacing gate (~1 request per 300ms)
  // so the page stays comfortably under the limit instead of tripping it.
  // Other hosts (Kraken, Coinbase, RPCs) are unaffected.
  let _bsGate = Promise.resolve();
  function paceBlockscout(url) {
    if (!url.startsWith(BLOCKSCOUT)) return Promise.resolve();
    const wait = _bsGate.then(() => sleep(300));
    _bsGate = wait.catch(() => {});
    return wait;
  }

  async function fetchJSON(url, { postData = null, timeout = 30000, tries = 5 } = {}) {
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      await paceBlockscout(url);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: postData ? 'POST' : 'GET',
          headers: postData ? { 'Content-Type': 'application/json' } : {},
          body: postData ? JSON.stringify(postData) : undefined,
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (res.status === 429 || res.status === 503) {
          // Rate-limited (or temporarily unavailable): honor the server's
          // Retry-After when present, otherwise back off exponentially
          // with jitter. These are transient — keep trying quietly.
          const ra = parseFloat(res.headers.get('Retry-After'));
          const waitMs = Number.isFinite(ra) && ra >= 0
            ? ra * 1000 + Math.random() * 500
            : Math.min(30000, 2000 * 2 ** i) + Math.random() * 1000;
          lastErr = new Error(`HTTP ${res.status} for ${url.slice(0, 80)}`);
          noteRetry(
            `Rate-limited by the data API — backing off ${Math.round(waitMs / 1000)}s before retrying…`
          );
          await sleep(waitMs);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 80)}`);
        return await res.json();
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
        await sleep(800 * (i + 1));
      }
    }
    throw lastErr;
  }

  async function getPaginated(url, onProgress) {
    const items = [];
    const seen = new Set();
    let pp = '';
    let page = 0;
    for (;;) {
      const d = await fetchJSON(url + pp, { tries: 4 });
      const batch = d.items || [];
      if (!batch.length) break;
      for (const x of batch) {
        const key = x.transaction_hash + '|' + x.log_index;
        if (!seen.has(key)) {
          seen.add(key);
          items.push(x);
        }
      }
      page++;
      if (onProgress) onProgress(page, items.length);
      const npp = d.next_page_params;
      if (!npp) break;
      pp =
        '?' +
        Object.entries(npp)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&');
      await sleep(150);
    }
    return items;
  }

  function amt(x) {
    try {
      return (
        Number(x.total.value) / 10 ** Number(x.token.decimals)
      );
    } catch {
      return 0;
    }
  }
  function sym(x) {
    return (x.token && x.token.symbol) || '?';
  }
  function addrOf(part) {
    return ((part && part.hash) || '').toLowerCase();
  }
  function dayOf(x) {
    return (x.timestamp || '').slice(0, 10);
  }

  const _txCache = new Map();
  async function txTransfers(txHash) {
    const h = txHash.toLowerCase();
    if (!_txCache.has(h)) {
      // Immutable per-tx data: serve from the persistent cache when present.
      const hit = cacheGet(TX_CACHE_PREFIX + h);
      if (hit && Array.isArray(hit)) {
        _txCache.set(h, hit.map(unpackTransfer));
      } else {
        const d = await fetchJSON(
          `${BLOCKSCOUT}/transactions/${txHash}/token-transfers`,
          { tries: 4 }
        );
        const items = d.items || [];
        _txCache.set(h, items);
        cacheSet(TX_CACHE_PREFIX + h, items.map(packTransfer));
        await sleep(120);
      }
    }
    return _txCache.get(h);
  }

  async function mapLimit(arr, limit, fn, onProgress) {
    const out = new Array(arr.length);
    let i = 0;
    let done = 0;
    async function worker() {
      while (i < arr.length) {
        const idx = i++;
        out[idx] = await fn(arr[idx], idx);
        done++;
        if (onProgress) onProgress(done, arr.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
    return out;
  }

  // ------------------------------------------------------------- fetch ----
  // Returns { items, cached }. The wallet transfer list is cached for 10
  // minutes so a retry right after a rate-limit makes zero Blockscout calls
  // for this step.
  function fetchWalletTransfers(wallet, onProgress) {
    const ck = ADDR_CACHE_PREFIX + wallet.toLowerCase();
    const hit = cacheGet(ck);
    if (
      hit && hit.ts && Date.now() - hit.ts < ADDR_CACHE_TTL_MS &&
      Array.isArray(hit.items)
    ) {
      return Promise.resolve({ items: hit.items.map(unpackTransfer), cached: true });
    }
    return getPaginated(
      `${BLOCKSCOUT}/addresses/${wallet}/token-transfers`,
      onProgress
    ).then((items) => {
      cacheSet(ck, { ts: Date.now(), items: items.map(packTransfer) });
      return { items, cached: false };
    });
  }

  // Kraken daily closes, primary price source (matches reference engine).
  async function fetchKrakenDaily(pair, start, end) {
    const out = {};
    const startMs = Date.UTC(
      +start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10)
    );
    const endMs = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
    for (let dt = startMs; dt <= endMs; dt += 60 * 86400 * 1000) {
      const since = Math.floor(dt / 1000);
      const d = await fetchJSON(
        `${KRAKEN}?pair=${pair}&interval=1440&since=${since}`,
        { tries: 4 }
      );
      if (d.error && d.error.length) throw new Error('Kraken: ' + d.error.join('; '));
      const key = Object.keys(d.result || {})[0];
      for (const c of d.result[key] || []) {
        const day = new Date(c[0] * 1000).toISOString().slice(0, 10);
        if (day >= start && day <= end && !(day in out)) out[day] = parseFloat(c[4]);
      }
      await sleep(400);
    }
    return out;
  }

  // Coinbase Exchange daily candles — fallback if Kraken is unreachable.
  // Returns {day: close}; close is index 4 just like Kraken.
  async function fetchCoinbaseDaily(product, start, end) {
    const out = {};
    const iso = (ms) => new Date(ms).toISOString();
    const startMs = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
    const endMs = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10)) + 86400000;
    // 300-candle limit per request; walk in 300-day chunks
    for (let s = startMs; s < endMs; s += 300 * 86400000) {
      const e = Math.min(s + 300 * 86400000, endMs);
      const d = await fetchJSON(
        `https://api.exchange.coinbase.com/products/${product}/candles` +
          `?start=${encodeURIComponent(iso(s))}&end=${encodeURIComponent(iso(e))}&granularity=86400`,
        { tries: 4 }
      );
      for (const c of d || []) {
        const day = new Date(c[0] * 1000).toISOString().slice(0, 10);
        if (day >= start && day <= end && !(day in out)) out[day] = parseFloat(c[4]);
      }
      await sleep(400);
    }
    return out;
  }

  async function fetchPrices(pair, coinbaseProduct, start, end, onProgress) {
    try {
      if (onProgress) onProgress(`prices:${pair}`, 'kraken');
      return { src: 'Kraken', map: await fetchKrakenDaily(pair, start, end) };
    } catch (e) {
      if (onProgress) onProgress(`prices:${pair}`, 'coinbase-fallback');
      return { src: 'Coinbase Exchange', map: await fetchCoinbaseDaily(coinbaseProduct, start, end) };
    }
  }

  // eth_call with RPC fallback. Shared by every on-chain view read
  // (unclaimed rewards, gauge stakes, LP pricing). Throws 'rpc-unavailable'
  // when every RPC fails.
  async function rpcEthCall(to, data) {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    };
    let lastErr = null;
    for (const rpc of RPCS) {
      try {
        const r = await fetchJSON(rpc, { postData: body, tries: 2, timeout: 20000 });
        if (r && typeof r.result === 'string' && r.result.startsWith('0x')) {
          return r.result;
        }
        throw new Error('bad rpc result');
      } catch (e) {
        lastErr = e;
      }
    }
    const err = new Error('rpc-unavailable');
    err.cause = lastErr;
    throw err;
  }

  async function readUnclaimed(pool, wallet) {
    const data =
      '0x' +
      CLAIMABLE_SEL +
      wallet.slice(2).toLowerCase().padStart(64, '0') +
      USDC.slice(2).toLowerCase().padStart(64, '0');
    try {
      return Number(BigInt(await rpcEthCall(pool, data))) / 1e6;
    } catch (e) {
      const err = new Error('unclaimed-unavailable');
      err.cause = e;
      throw err;
    }
  }

  // ------------------------------------------------- live position read ---
  // Current value, exact: getStake(address) on each staking gauge returns a
  // 2-word struct (uint256 stakedLP, uint256 since) — the wallet's true
  // on-chain LP-token balance. Priced per LP token as pool TVL / LP supply.
  // The analytics API supplies both TVL inputs; if it's down, the same
  // numbers are read on-chain instead (totalSupply on the pool contract,
  // balanceOf on each underlying token). Any failure here is non-fatal:
  // analyze() keeps the FIFO-lot estimate and marks the figure (est.).
  function decodeStakeLp(result) {
    // First 32-byte word of the getStake return. Tolerates short or empty
    // hex — some RPCs trim leading zero words.
    if (!result || typeof result !== 'string') return 0n;
    const hex = result.startsWith('0x') ? result.slice(2) : result;
    if (!hex) return 0n;
    return BigInt('0x' + hex.slice(0, 64));
  }

  // Nearest-earlier value in a {day: close} map (insurance against a gap).
  function pxAt(map, date) {
    if (map[date] != null) return map[date];
    let v = 0;
    for (const k of Object.keys(map).sort()) {
      if (k <= date) v = map[k];
      else break;
    }
    return v;
  }

  async function lpUsdPerLpFromApi(ethPx, btcPx) {
    const d = await fetchJSON(RYZE_TVL_API, { tries: 2, timeout: 20000 });
    const out = { W: 0, B: 0 };
    for (const p of (d && d.pools) || []) {
      const addrs = (p.assets || []).map((a) => (a.tokenAddress || '').toLowerCase());
      const key = addrs.includes(WETH) ? 'W' : addrs.includes(CBBTC) ? 'B' : null;
      if (!key) continue;
      let tvl = 0;
      for (const a of p.assets || []) {
        const ta = (a.tokenAddress || '').toLowerCase();
        const amt = Number(BigInt(a.balance)) / 10 ** a.decimals;
        if (ta === USDC.toLowerCase()) tvl += amt;
        else if (ta === WETH) tvl += amt * ethPx;
        else if (ta === CBBTC) tvl += amt * btcPx;
      }
      const supply = Number(BigInt(p.totalSupplyLP)) / 1e18;
      if (supply > 0 && tvl > 0) out[key] = tvl / supply;
    }
    if (!out.W || !out.B) throw new Error('lp-price-unavailable');
    return out;
  }

  async function lpUsdPerLpOnChain(ethPx, btcPx) {
    const SEL_BAL = '70a08231'; // balanceOf(address)
    const SEL_TSUP = '18160ddd'; // totalSupply()
    const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
    const out = {};
    for (const q of ['W', 'B']) {
      const pool = RYZE_POOLS[q];
      const [tsRes, usdcRes, wethRes, cbbtcRes] = await Promise.all([
        rpcEthCall(pool, '0x' + SEL_TSUP),
        rpcEthCall(USDC, '0x' + SEL_BAL + pad(pool)),
        rpcEthCall(WETH, '0x' + SEL_BAL + pad(pool)),
        rpcEthCall(CBBTC, '0x' + SEL_BAL + pad(pool)),
      ]);
      const supply = Number(decodeStakeLp(tsRes)) / 1e18;
      const tvl =
        Number(decodeStakeLp(usdcRes)) / 10 ** UNDERLYING_DECIMALS.USDC +
        (Number(decodeStakeLp(wethRes)) / 10 ** UNDERLYING_DECIMALS.WETH) * ethPx +
        (Number(decodeStakeLp(cbbtcRes)) / 10 ** UNDERLYING_DECIMALS.CBBTC) * btcPx;
      if (!(supply > 0 && tvl > 0)) throw new Error('lp-price-unavailable');
      out[q] = tvl / supply;
    }
    return out;
  }

  // Returns { W: {usd, ok}, B: {usd, ok} }. Never throws — a failure on any
  // pool just marks that pool not-ok and the caller keeps the FIFO estimate.
  async function readLivePositions(wallet, prices, end) {
    const out = { W: { usd: 0, ok: false }, B: { usd: 0, ok: false } };
    try {
      const ethPx = pxAt(prices.ETH.map, end);
      const btcPx = pxAt(prices.BTC.map, end);
      if (!(ethPx > 0 && btcPx > 0)) return out;
      let perLp;
      try {
        perLp = await lpUsdPerLpFromApi(ethPx, btcPx);
      } catch {
        perLp = await lpUsdPerLpOnChain(ethPx, btcPx);
      }
      const addrWord = wallet.slice(2).toLowerCase().padStart(64, '0');
      for (const q of ['W', 'B']) {
        const gauge = q === 'W' ? WETH_VAULT : CBBTC_VAULT;
        const res = await rpcEthCall(gauge, '0x' + GETSTAKE_SEL + addrWord);
        const lp = decodeStakeLp(res);
        out[q] = { usd: (Number(lp) / 1e18) * perLp[q], ok: true };
      }
    } catch {
      /* non-fatal: caller falls back to the FIFO estimate */
    }
    return out;
  }

  // ------------------------------------------------------------- analysis -
  function extractClaims(transfers, wallet) {
    const w = wallet.toLowerCase();
    const claims = [];
    for (const x of transfers) {
      if (addrOf(x.to) !== w || sym(x) !== 'USDC') continue;
      const a = amt(x);
      if (a < 0.05) continue;
      const pool = poolOf(addrOf(x.from));
      if (pool) claims.push({ date: dayOf(x), pool, amount: Math.round(a * 1e4) / 1e4 });
    }
    claims.sort((p, q) =>
      p.date < q.date ? -1 : p.date > q.date ? 1 : p.pool < q.pool ? -1 : 1
    );
    return claims;
  }

  // Find deposit txs: the wallet sends USDC/WETH/cbBTC in a tx that deposits an
  // LP token into a Ryze gauge pool. Any recipient counts, so deposits made
  // through any router or direct deposits are detected.
  async function extractDeposits(transfers, wallet, { onProgress }) {
    const w = wallet.toLowerCase();
    const byTx = new Map();
    for (const x of transfers) {
      const fr = addrOf(x.from);
      const to = addrOf(x.to);
      if (fr !== w || to === w || to === ZERO) continue;
      const s = sym(x);
      if (!TOKENS.includes(s) || amt(x) < 0.005) continue;
      const h = x.transaction_hash;
      if (!byTx.has(h)) byTx.set(h, []);
      byTx.get(h).push(x);
    }
    const txs = [...byTx.keys()].sort((a, b) => {
      const da = Math.min(...byTx.get(a).map((t) => dayOf(t) || '9'));
      const db = Math.min(...byTx.get(b).map((t) => dayOf(t) || '9'));
      return da < db ? -1 : 1;
    });
    const deposits = [];
    await mapLimit(
      txs,
      4,
      async (h) => {
        const items = await txTransfers(h);
        let pool = null;
        const inputs = { USDC: 0, WETH: 0, CBBTC: 0 };
        const dust = { USDC: 0, WETH: 0, CBBTC: 0 };
        for (const y of items) {
          const s = sym(y);
          const a = amt(y);
          const to = addrOf(y.to);
          const fr = addrOf(y.from);
          // LP token deposited into a pool? (plain USDC/WETH/cbBTC excluded)
          if (!TOKENS.includes(s)) {
            const p = poolOf(to);
            if (p) pool = p;
          }
          if (fr === w && TOKENS.includes(s)) inputs[s] += a;
          // funds returned to the wallet in the same tx are netted off;
          // pool -> wallet USDC is a *claim* (counted separately), not dust
          if (to === w && fr !== w && !VAULT_SET.has(fr) && TOKENS.includes(s)) {
            dust[s] += a;
          }
        }
        if (pool) {
          const ts = byTx.get(h).map((t) => dayOf(t)).sort()[0];
          const net = {};
          for (const k of TOKENS) {
            const v = Math.round((inputs[k] - dust[k]) * 1e4) / 1e4;
            if (v > 0) net[k] = v;
          }
          deposits.push({ date: ts, pool, net, tx: h });
        }
      },
      onProgress
    );
    deposits.sort((p, q) => (p.date < q.date ? -1 : 1));
    return deposits;
  }

  // Find withdrawal txs: a pool LP token is burned (sent to 0x0) and
  // underlying (USDC/WETH/cbBTC) is returned to the wallet in the same tx.
  // The LP burn is what separates a withdrawal from a plain reward payout
  // (which has no burn), so the underlying may come back via the helper,
  // the pool, or a migration contract — the sender is not allowlisted.
  // The burner is not required to be a pool either: migration withdrawals
  // (e.g. the April 2026 pool migration) first release the LP token to the
  // wallet, which then burns it itself.
  async function extractWithdrawals(transfers, wallet, { onProgress }) {
    const w = wallet.toLowerCase();
    const byTx = new Map();
    for (const x of transfers) {
      const fr = addrOf(x.from);
      const to = addrOf(x.to);
      if (to !== w || fr === w) continue;
      const s = sym(x);
      if (!TOKENS.includes(s) || amt(x) < 0.01) continue;
      const h = x.transaction_hash;
      if (!byTx.has(h)) byTx.set(h, []);
      byTx.get(h).push(x);
    }
    // A withdrawal also burns LP from the wallet itself (migration-style),
    // which leaves no underlying receipt from a known sender — catch those
    // txs too via the wallet's own burn transfers.
    for (const x of transfers) {
      const fr = addrOf(x.from);
      const to = addrOf(x.to);
      if (fr !== w || to !== ZERO) continue;
      const s = sym(x);
      if (TOKENS.includes(s) || !s) continue;
      const h = x.transaction_hash;
      if (!byTx.has(h)) byTx.set(h, []);
      byTx.get(h).push(x);
    }
    const txs = [...byTx.keys()].sort((a, b) => {
      const da = Math.min(...byTx.get(a).map((t) => dayOf(t) || '9'));
      const db = Math.min(...byTx.get(b).map((t) => dayOf(t) || '9'));
      return da < db ? -1 : 1;
    });
    const withdrawals = [];
    await mapLimit(
      txs,
      4,
      async (h) => {
        const items = await txTransfers(h);
        let burnPool = null;
        let sawBurn = false;
        for (const y of items) {
          const fr = addrOf(y.from);
          if (addrOf(y.to) === ZERO && !TOKENS.includes(sym(y))) {
            sawBurn = true;
            if (!burnPool) burnPool = poolOf(fr);
          }
        }
        if (!sawBurn) return; // payout without an LP burn: not a withdrawal
        const out = { USDC: 0, WETH: 0, CBBTC: 0 };
        for (const y of items) {
          const s = sym(y);
          const a = amt(y);
          if (addrOf(y.to) !== w || !TOKENS.includes(s)) continue;
          const fr = addrOf(y.from);
          if (fr === w) continue;
          if (VAULT_SET.has(fr) && s === 'USDC') continue;
          // pool -> wallet USDC in an withdrawal tx is the reward claim
          // (counted by extractClaims), not principal — excluded here.
          out[s] += a;
        }
        if (!Object.values(out).some((v) => v > 0)) return;
        // Pool: prefer the burner's pool; otherwise infer from the
        // underlying returned (cbBTC => cbBTC-USDC pool, WETH => WETH-USDC).
        let pool = burnPool;
        if (!pool) pool = out.CBBTC > 0 ? 'B' : out.WETH > 0 ? 'W' : null;
        if (!pool) return;
        const ts = byTx.get(h).map((t) => dayOf(t)).sort()[0];
        const net = {};
        for (const k of TOKENS) {
          const v = Math.round(out[k] * 1e4) / 1e4;
          if (v > 0) net[k] = v;
        }
        withdrawals.push({ date: ts, pool, net, tx: h });
      },
      onProgress
    );
    withdrawals.sort((p, q) => (p.date < q.date ? -1 : 1));
    return withdrawals;
  }

  // Pool-migration handling (generic — no wallet-specific history).
  // When a pool is migrated, the wallet withdraws from the old pool and
  // re-deposits into the new one days apart. Naively that reads as a full
  // withdrawal followed by brand-new deposits, roughly doubling the
  // time-weighted principal and halving the APR. Instead, match each
  // withdrawal against same-pool deposits in the following
  // MIGRATION_WINDOW_DAYS days and net them: the deposit keeps only the
  // net-new capital (it may go slightly negative = a net outflow), and a
  // fully-absorbed withdrawal is dropped. Coincidental withdraw+deposit
  // pairs are harmless here — netting only re-times the net flow by at
  // most the window length, which barely moves a time-weighted average.
  const MIGRATION_WINDOW_DAYS = 2;
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  function dayDiff(a, b) {
    const msA = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
    const msB = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return (msB - msA) / 86400000;
  }
  function netMigrations(deposits, withdrawals) {
    const dps = deposits.map((d) => ({
      date: d.date,
      pool: d.pool,
      tx: d.tx,
      net: { USDC: d.net.USDC || 0, WETH: d.net.WETH || 0, CBBTC: d.net.CBBTC || 0 },
      migration: false,
    }));
    const wds = withdrawals.map((w) => ({
      date: w.date,
      pool: w.pool,
      tx: w.tx,
      remaining: { USDC: w.net.USDC || 0, WETH: w.net.WETH || 0, CBBTC: w.net.CBBTC || 0 },
      absorbed: false,
    }));
    dps.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
    wds.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
    let migrations = 0;
    for (const wd of wds) {
      for (const d of dps) {
        if (d.pool !== wd.pool) continue;
        const diff = dayDiff(wd.date, d.date);
        if (diff < 0 || diff > MIGRATION_WINDOW_DAYS) continue;
        let touched = false;
        for (const t of TOKENS) {
          const take = Math.min(d.net[t], wd.remaining[t]);
          if (take > 0) {
            d.net[t] = r4(d.net[t] - take);
            wd.remaining[t] = r4(wd.remaining[t] - take);
            touched = true;
          }
        }
        if (touched) {
          d.migration = true;
          if (!wd.absorbed) {
            wd.absorbed = true;
            migrations++;
          }
        }
      }
    }
    const keptDeposits = dps.map((d) => {
      const net = {};
      for (const t of TOKENS) if (d.net[t] !== 0) net[t] = d.net[t];
      return { date: d.date, pool: d.pool, tx: d.tx, net, migration: d.migration };
    });
    // An absorbed withdrawal keeps any unabsorbed remainder (a partial
    // re-deposit is still a net outflow); only fully-absorbed ones drop out.
    const keptWithdrawals = wds
      .filter((wd) => Object.values(wd.remaining).some((v) => v > 0))
      .map((wd) => {
        const net = {};
        for (const t of TOKENS) if (wd.remaining[t] > 0) net[t] = wd.remaining[t];
        return { date: wd.date, pool: wd.pool, tx: wd.tx, net };
      });
    return { deposits: keptDeposits, withdrawals: keptWithdrawals, migrations };
  }

  function buildSeries(events, flows, prices, start, end) {
    // events: [[date, pool, du, dw, db]] ; flows: [{date, pool, net, sign}]
    const ev = {};
    const add = (date, pool, du, de, db) => {
      if (!ev[date]) ev[date] = [];
      ev[date].push([pool, du, de, db]);
    };
    for (const [date, pool, du, de, db] of events) add(date, pool, du, de, db);
    for (const f of flows) {
      add(f.date, f.pool, f.net.USDC || 0, f.net.WETH || 0, f.net.CBBTC || 0);
    }
    const ETH = prices.ETH.map, BTC = prices.BTC.map;
    // Nearest-earlier close for a date (crypto trades 24/7 so every day
    // should be present; this is just insurance against a gap in the feed).
    const sortedKeys = (map) => Object.keys(map).sort();
    const ethKeys = sortedKeys(ETH), btcKeys = sortedKeys(BTC);
    const closeAt = (map, keys, date) => {
      if (map[date] != null) return map[date];
      let lo = 0, hi = keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (keys[mid] <= date) lo = mid + 1;
        else hi = mid;
      }
      return lo > 0 ? map[keys[lo - 1]] : 0;
    };
    // Gross committed per pool + per-deposit detail for the "how is this
    // calculated" breakdown. Each positive flow is valued at the close on
    // its own day — the actual amount the wallet committed, BEFORE the
    // protocol converts it into the pool position (zap swaps, fees, and
    // dust happen after this point). A deposit's TWAP contribution is
    // cost × (days it was in the pool) / total days — exact when the pool
    // has no withdrawals; with withdrawals the TWAP reflects FIFO lot
    // consumption instead.
    const gross = { W: 0, B: 0 };
    const depositDetail = [];
    for (const f of flows) {
      const costs = {};
      let total = 0;
      for (const t of TOKENS) {
        const a = f.net[t] || 0;
        if (a > 0) {
          const px =
            t === 'USDC'
              ? 1
              : closeAt(
                  t === 'WETH' ? ETH : BTC,
                  t === 'WETH' ? ethKeys : btcKeys,
                  f.date
                );
          const c = r4(a * px);
          costs[t] = { amt: r4(a), cost: c };
          total = r4(total + c);
        }
      }
      if (total > 0) {
        gross[f.pool] = r4(gross[f.pool] + total);
        depositDetail.push({
          date: f.date,
          pool: f.pool,
          costs,
          total,
          daysActive: dayDiff(f.date, end) + 1,
        });
      }
    }
    // Cost-basis principal per pool (USD), FIFO lots: each deposit pushes a
    // lot valued at the close on its own day (what the LP actually put in);
    // each withdrawal consumes the oldest lots first at their cost. The
    // series therefore only moves when capital actually moves — market
    // moves after a flow never change principal, so price appreciation
    // can't leak into the APR denominator.
    const lots = { W: { USDC: [], WETH: [], CBBTC: [] }, B: { USDC: [], WETH: [], CBBTC: [] } };
    const PX = { USDC: 1, WETH: null, CBBTC: null }; // per-day prices
    const principalOf = (pool) =>
      r4(
        TOKENS.reduce(
          (s, t) => s + lots[pool][t].reduce((a, l) => a + l.cost, 0),
          0
        )
      );
    const tw = { W: 0, B: 0 };
    let n = 0;
    let dms = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
    const endMs = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
    for (; dms <= endMs; dms += 86400000) {
      const s = new Date(dms).toISOString().slice(0, 10);
      PX.WETH = closeAt(ETH, ethKeys, s);
      PX.CBBTC = closeAt(BTC, btcKeys, s);
      for (const [pool, du, de, db] of ev[s] || []) {
        const amts = { USDC: du, WETH: de, CBBTC: db };
        for (const t of TOKENS) {
          const a = amts[t];
          if (a > 0) {
            // Deposit: push a cost-basis lot.
            lots[pool][t].push({ amt: a, cost: r4(a * PX[t]) });
          } else if (a < 0) {
            // Withdrawal: consume oldest lots first at their cost.
            // Principal can never go negative: a withdrawal can only return
            // principal the model actually tracked (e.g. deposits funded
            // directly by a third party are invisible in the wallet's own
            // transfers).
            let need = -a;
            const q = lots[pool][t];
            while (need > 1e-9 && q.length) {
              const lot = q[0];
              const take = Math.min(lot.amt, need);
              const frac = take / lot.amt; // pro-rata share of this lot
              lot.amt = r4(lot.amt - take);
              lot.cost = r4(lot.cost * (1 - frac));
              need = r4(need - take);
              if (lot.amt <= 1e-9) q.shift();
            }
          }
        }
      }
      tw.W += principalOf('W');
      tw.B += principalOf('B');
      n++;
    }
    // Per-deposit TWAP contributions, now that the window day-count is known.
    for (const d of depositDetail) {
      d.contrib = r4((d.total * d.daysActive) / n);
    }
    // Current market value of what's still in the pool: remaining lot
    // amounts valued at the end-day close (PX holds the end date's prices
    // after the loop). Shown next to cost basis so the gap between the
    // two reads as market gain/loss at a glance.
    const curVal = (pool) =>
      r4(
        TOKENS.reduce(
          (s, t) => s + lots[pool][t].reduce((a, l) => a + l.amt, 0) * PX[t],
          0
        )
      );
    return {
      twap: { W: tw.W / n, B: tw.B / n },
      days: n,
      endBal: { W: principalOf('W'), B: principalOf('B') },
      curVal: { W: curVal('W'), B: curVal('B') },
      gross,
      depositDetail,
    };
  }

  function pacificToday() {
    return new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Los_Angeles',
    });
  }

  async function analyze(walletInput, { today = null, onProgress = null } = {}) {
    _txCache.clear();
    const prog = onProgress || (() => {});
    const wallet = walletInput.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      throw new Error('invalid-address');
    }
    const end = today || pacificToday();

    prog('transfers', 0, 0, 'Fetching transfer history from Blockscout…');
    const { items: transfers, cached: transfersCached } = await fetchWalletTransfers(wallet, (page, count) =>
      prog('transfers', page, 0, `Fetching transfer history… (${count} transfers so far)`)
    );
    prog('transfers', 1, 1,
      transfersCached
        ? `${transfers.length} transfers loaded from cache. Detecting claims…`
        : `${transfers.length} transfers found. Detecting claims…`);
    const claims = extractClaims(transfers, wallet);

    prog('deposits', 0, 1, 'Detecting deposits…');
    const deposits = await extractDeposits(transfers, wallet, {
      onProgress: (done, total) =>
        prog('deposits', done, total, `Analyzing deposit transactions… (${done}/${total})`),
    });
    prog('withdrawals', 0, 1, 'Detecting withdrawals…');
    const rawWithdrawals = await extractWithdrawals(transfers, wallet, {
      onProgress: (done, total) =>
        prog('withdrawals', done, total, `Analyzing withdrawal transactions… (${done}/${total})`),
    });
    // Pool migrations (withdrawal + re-deposit) net to their capital delta —
    // otherwise the re-deposit reads as brand-new principal.
    const mig = netMigrations(deposits, rawWithdrawals);
    const netDeposits = mig.deposits;
    const withdrawals = mig.withdrawals;

    const genesis = [];
    const cands = [
      ...claims.map((c) => c.date),
      ...genesis.map((e) => e[0]),
      ...netDeposits.map((d) => d.date),
      ...withdrawals.map((d) => d.date),
    ].filter(Boolean);
    const firstDay = cands.length ? cands.sort()[0] : null;

    // Read unclaimed rewards regardless — needed for the empty-state check too.
    prog('unclaimed', 0, 2, 'Reading unclaimed rewards on-chain…');
    let unclaimed = { W: 0, B: 0 };
    let unclaimedOk = true;
    try {
      unclaimed.W = await readUnclaimed(WETH_VAULT, wallet);
      prog('unclaimed', 1, 2, 'Reading unclaimed rewards on-chain…');
      unclaimed.B = await readUnclaimed(CBBTC_VAULT, wallet);
    } catch (e) {
      unclaimedOk = false;
    }
    prog('unclaimed', 2, 2, 'Unclaimed rewards read.');

    if (!firstDay) {
      const totalUnclaimed = unclaimed.W + unclaimed.B;
      if (unclaimedOk && totalUnclaimed > 0.005) {
        return {
          wallet, end, firstDay: null, days: 0,
          transfers: transfers.length,
          partial: true,
          pools: {
            W: { rewards: unclaimed.W, unclaimed: unclaimed.W, claimed: 0, nClaims: 0 },
            B: { rewards: unclaimed.B, unclaimed: unclaimed.B, claimed: 0, nClaims: 0 },
          },
          unclaimedOk,
        };
      }
      return { wallet, end, firstDay: null, days: 0, transfers: transfers.length, empty: true, unclaimedOk };
    }

    prog('prices', 0, 2, 'Fetching daily ETH prices…');
    const ETH = await fetchPrices('ETHUSD', 'ETH-USD', firstDay, end, (k, v) =>
      prog('prices', 0, 2, v === 'kraken' ? 'Fetching daily ETH prices (Kraken)…' : 'Kraken unreachable — using Coinbase prices…')
    );
    prog('prices', 1, 2, 'Fetching daily BTC prices…');
    const BTC = await fetchPrices('XBTUSD', 'BTC-USD', firstDay, end, (k, v) =>
      prog('prices', 1, 2, v === 'kraken' ? 'Fetching daily BTC prices (Kraken)…' : 'Kraken unreachable — using Coinbase prices…')
    );
    const prices = { ETH, BTC };
    const priceSource = ETH.src === BTC.src ? ETH.src : `${ETH.src} / ${BTC.src}`;

    prog('compute', 0, 2, 'Computing cost basis…');
    const flows = [
      ...netDeposits.map((d) => ({ date: d.date, pool: d.pool, net: d.net })),
      ...withdrawals.map((d) => ({
        date: d.date,
        pool: d.pool,
        net: {
          USDC: -(d.net.USDC || 0),
          WETH: -(d.net.WETH || 0),
          CBBTC: -(d.net.CBBTC || 0),
        },
      })),
    ];
    const { twap, days, endBal, curVal, gross, depositDetail } = buildSeries(
      genesis,
      flows,
      prices,
      firstDay,
      end
    );

    // Live position read: the gauge's getStake is the exact current value.
    // On any failure each pool keeps the FIFO-lot estimate, flagged (est.).
    prog('compute', 1, 2, 'Reading live pool positions…');
    const live = await readLivePositions(wallet, prices, end);

    const wdByPool = { W: 0, B: 0 };
    for (const wd of withdrawals) {
      if (wdByPool[wd.pool] != null) wdByPool[wd.pool]++;
    }

    const pools = {};
    for (const q of ['W', 'B']) {
      const claimed = claims.filter((c) => c.pool === q).reduce((s, c) => s + c.amount, 0);
      const nClaims = claims.filter((c) => c.pool === q).length;
      const rewards = claimed + (unclaimedOk ? unclaimed[q] : 0);
      const t = twap[q];
      const apr = t > 0 ? (rewards / t) * (365 / days) : 0;
      const estCurVal = curVal[q];
      const lv = (live && live[q]) || { usd: 0, ok: false };
      pools[q] = {
        name: POOL_NAMES[q],
        rewards,
        twap: t,
        gross: gross[q],
        calc: depositDetail.filter((d) => d.pool === q),
        calcExact: wdByPool[q] === 0,
        curVal: lv.ok ? r4(lv.usd) : estCurVal,
        liveValue: lv.ok,
        estCurVal,
        apr,
        apy: (1 + apr / 52) ** 52 - 1,
        claimed,
        nClaims,
        unclaimed: unclaimedOk ? unclaimed[q] : 0,
        principalKnown: t > 0,
      };
    }
    const bTwap = pools.W.twap + pools.B.twap;
    const bRew = pools.W.rewards + pools.B.rewards;
    const bApr = bTwap > 0 ? (bRew / bTwap) * (365 / days) : 0;
    const blended = {
      rewards: bRew,
      twap: bTwap,
      gross: gross.W + gross.B,
      curVal: pools.W.curVal + pools.B.curVal,
      liveValue: pools.W.liveValue && pools.B.liveValue,
      apr: bApr,
      apy: (1 + bApr / 52) ** 52 - 1,
      principalKnown: bTwap > 0,
    };
    prog('compute', 2, 2, 'Done.');

    return {
      wallet, end, firstDay, days,
      pools, blended,
      claims: claims.length,
      deposits: netDeposits.length,
      withdrawals: withdrawals.length,
      migrations: mig.migrations,
      transfers: transfers.length,
      unclaimedOk,
      priceSource,
      endBal,
    };
  }

  return { analyze, POOL_NAMES, setRetryHook, decodeStakeLp };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RyzeEngine;
}
