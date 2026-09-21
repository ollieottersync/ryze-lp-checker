// Synthetic test: gross-deposited + per-deposit TWAP breakdown.
// Stubs global.fetch to serve fixture data mimicking two USDC zap deposits
// into the WETH-USDC pool (mirrors Zac's 8/23 + 8/24 deposits, incl. dust).
// Verifies: gross = actual committed ($10,128.70), TWAP unchanged
// ($9,959.88), per-deposit contribs sum to the TWAP, APR math untouched,
// and the digest email renders the new fields.
// Usage: node dev/test-gross.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const RyzeEngine = require('./engine.js');
import { buildDigestEmail } from '../.github/digest/digest-email.mjs';

const W = '0x40a374e7ab2b16e65f701d5871707b8060a605a9';
const WETH_VAULT = '0x82665512097280502Be785C5070090f628dE002F';
const CBBTC_VAULT = '0x5C6fBb8551E632dFA07DF3FcD98d1f3AA4F11252';
const HELPER = '0xCA8A097f627ef41Be12EbF7433F5B6b8A114D77b';
const TX1 = '0x' + 'ab'.repeat(32);
const TX2 = '0x' + 'cd'.repeat(32);
const DEP = '5064348019'; // 5064.348019 USDC, 6 decimals

const t = (tx, log, symbol, decimals, value, from, to, ts) => ({
  transaction_hash: tx,
  log_index: String(log),
  token: { symbol, decimals: String(decimals) },
  total: { value: String(value) },
  from: { hash: from },
  to: { hash: to },
  timestamp: ts,
});

const addrTransfers = [
  t(TX1, 12, 'USDC', 6, DEP, W, HELPER, '2026-08-23T10:00:00.000Z'),
  t(TX2, 12, 'USDC', 6, DEP, W, HELPER, '2026-08-24T10:00:00.000Z'),
];
const txItems = {
  [TX1.toLowerCase()]: [
    t(TX1, 12, 'USDC', 6, DEP, W, HELPER, '2026-08-23T10:00:00.000Z'),
    t(TX1, 45, 'RyzeLP', 18, '1000000000000000000', HELPER, WETH_VAULT, '2026-08-23T10:00:01.000Z'),
    t(TX1, 90, 'WETH', 18, '4970', HELPER, W, '2026-08-23T10:00:02.000Z'), // dust
  ],
  [TX2.toLowerCase()]: [
    t(TX2, 12, 'USDC', 6, DEP, W, HELPER, '2026-08-24T10:00:00.000Z'),
    t(TX2, 45, 'RyzeLP', 18, '1000000000000000000', HELPER, WETH_VAULT, '2026-08-24T10:00:01.000Z'),
    t(TX2, 90, 'WETH', 18, '4970', HELPER, W, '2026-08-24T10:00:02.000Z'), // dust
  ],
};

function krakenCandles(start, end, close) {
  const out = [];
  let ms = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  const endMs = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
  for (; ms <= endMs; ms += 86400000) {
    out.push([ms / 1000, String(close), String(close), String(close), String(close), '1', '1']);
  }
  return out;
}

const resp = (data) => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  json: async () => data,
});

// Ryze analytics TVL fixture: per-pool LP supply + asset balances.
// WETH pool: 22.71086 LP, 49,081.75 USDC + 25.0726 WETH (ETH close 2806).
// cbBTC pool: 2.06717 LP, 183,347.28 USDC + 2.72723 cbBTC (BTC close 115000).
const USDC_A = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_A = '0x4200000000000000000000000000000000000006';
const CBBTC_A = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const TVL_FIXTURE = [
  {
    poolAddress: '0x22f902cEfcF8b0bEc6489Cb8ac11FdDa9B2aF125',
    totalSupplyLP: '22710860000000000000',
    assets: [
      { tokenAddress: USDC_A, balance: '49081750000', decimals: 6 },
      { tokenAddress: WETH_A, balance: '25072600000000000000', decimals: 18 },
    ],
  },
  {
    poolAddress: '0x40F3DAaE59BfE03f9Fb019Bb089Bb0C381DE27Cf',
    totalSupplyLP: '2067170000000000000',
    assets: [
      { tokenAddress: USDC_A, balance: '183347280000000', decimals: 6 },
      { tokenAddress: CBBTC_A, balance: '272723000', decimals: 8 },
    ],
  },
];
const GETSTAKE_SEL = '0x7a766460';
const CLAIMABLE_SEL = '0x7a27db57';
let failLive = false; // when true: TVL API + all non-claimable RPC calls fail

global.fetch = async (url, opts = {}) => {
  if (url.includes('/addresses/') && url.includes('/token-transfers')) {
    return resp({ items: addrTransfers });
  }
  const mTx = url.match(/\/transactions\/(0x[0-9a-f]+)\/token-transfers/i);
  if (mTx) return resp({ items: txItems[mTx[1].toLowerCase()] || [] });
  if (url.includes('mainnet.api.ryze.pro/api/analytics/tvl')) {
    if (failLive) throw new Error('tvl api down');
    return resp({ pools: TVL_FIXTURE });
  }
  if (url.includes('kraken.com')) {
    const pair = url.includes('XBTUSD') ? 'XXBTZUSD' : 'XETHZUSD';
    const close = url.includes('XBTUSD') ? 115000 : 2806;
    return resp({ error: [], result: { [pair]: krakenCandles('2026-08-23', '2026-09-21', close) } });
  }
  if (opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    const data = (body.params[0].data || '').toLowerCase();
    if (data.startsWith(GETSTAKE_SEL)) {
      if (failLive) throw new Error('rpc down');
      // Wallet holds 5.0 LP on the WETH gauge, nothing on cbBTC.
      const to = (body.params[0].to || '').toLowerCase();
      const lp = to === WETH_VAULT.toLowerCase() ? 5000000000000000000n : 0n;
      // 2-word struct: (stakedLP, since)
      return resp({ result: '0x' + lp.toString(16).padStart(64, '0') + '68f0a3d2'.padStart(64, '0') });
    }
    if (failLive && !data.startsWith(CLAIMABLE_SEL)) throw new Error('rpc down');
    const to = (body.params[0].to || '').toLowerCase();
    const val = to === WETH_VAULT.toLowerCase() ? 9040000 : 0; // $9.04 unclaimed W
    return resp({ result: '0x' + BigInt(val).toString(16) });
  }
  throw new Error('unexpected fetch: ' + url);
};

const r4 = (n) => Math.round(n * 1e4) / 1e4;
let failures = 0;
function check(label, actual, expected, tol = 0.02) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`);
}
function checkEq(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, expected ${expected}`);
}

// getStake 2-word struct decode — known vector: his wallet's WETH-gauge
// stake as read 2026-09-21 14:41 PDT (raw value from stakes-live.json).
const VEC_RAW = '4957805439358160758';
const vecReturn =
  '0x' +
  BigInt(VEC_RAW).toString(16).padStart(64, '0') +
  BigInt('1758498102').toString(16).padStart(64, '0');
checkEq('decodeStakeLp known vector (word1)', RyzeEngine.decodeStakeLp(vecReturn).toString(), VEC_RAW);
checkEq('decodeStakeLp empty hex -> 0', RyzeEngine.decodeStakeLp('0x').toString(), '0');
checkEq('decodeStakeLp short hex', RyzeEngine.decodeStakeLp('0x2a').toString(), '42');
const vecUsd = (Number(BigInt(VEC_RAW)) / 1e18) * 5224.589377573452; // recorded $/LP that day
check('known vector prices to $25,902.50', vecUsd, 25902.5, 0.01);

const r = await RyzeEngine.analyze(W, { today: '2026-09-21' });
const pW = r.pools.W;
console.log('days:', r.days, '| deposits:', r.deposits, '| withdrawals:', r.withdrawals);

const expGross = r4(2 * 5064.348019); // 10128.696
const expTwap = r4((5064.348 * 30 + 5064.348 * 29) / 30); // 9959.8844
check('W gross (actual committed)', pW.gross, expGross);
check('W twap (APR basis, unchanged)', pW.twap, expTwap);
check('blended gross', r.blended.gross, expGross);
check('calc entries', pW.calc.length, 2, 0);
check('calcExact (no withdrawals)', pW.calcExact ? 1 : 0, 1, 0);
check('deposit 1 daysActive', pW.calc[0].daysActive, 30, 0);
check('deposit 2 daysActive', pW.calc[1].daysActive, 29, 0);
const contribSum = r4(pW.calc.reduce((s, d) => s + d.contrib, 0));
check('contribs sum to twap', contribSum, pW.twap, 0.05);
const expApr = (9.04 / expTwap) * (365 / 30);
check('W apr unchanged', pW.apr, expApr, 1e-6);
check('W rewards = unclaimed only', pW.rewards, 9.04, 1e-9);
check('B gross zero', r.pools.B.gross, 0, 0);

// Live current value: 5.0 LP staked on the WETH gauge, priced from the
// fixture TVL (49,081.75 + 25.0726*2806) / 22.71086 per LP.
const wTvl = 49081.75 + 25.0726 * 2806;
check('W liveValue true', pW.liveValue ? 1 : 0, 1, 0);
check('W curVal = live gauge stake', pW.curVal, (5 * wTvl) / 22.71086, 0.05);
check('W estCurVal kept (FIFO)', pW.estCurVal, 10128.696, 0.01);
check('B liveValue true (zero stake)', r.pools.B.liveValue ? 1 : 0, 1, 0);
check('B curVal zero live', r.pools.B.curVal, 0, 0);
check('blended liveValue true', r.blended.liveValue ? 1 : 0, 1, 0);
check('blended curVal = live sum', r.blended.curVal, (5 * wTvl) / 22.71086, 0.05);

// Fallback: TVL API + RPC down -> FIFO estimate kept, flagged (est.).
failLive = true;
const r2 = await RyzeEngine.analyze(W, { today: '2026-09-21' });
failLive = false;
check('fallback: W liveValue false', r2.pools.W.liveValue ? 1 : 0, 0, 0);
check('fallback: W curVal = FIFO estimate', r2.pools.W.curVal, 10128.696, 0.01);
check('fallback: blended liveValue false', r2.blended.liveValue ? 1 : 0, 0, 0);
check('fallback: rewards still read', r2.pools.W.rewards, 9.04, 1e-9);

// Digest email renders the new fields.
const { subject, text, html } = buildDigestEmail(r, { email: 't@t.co', unsubUrl: 'https://x/unsub' });
const htmlOk = html.includes('Total cost basis') && html.includes('$10,128.70') && html.includes('How this is calculated');
const textOk = text.includes('Total cost basis: $10,128.70') && text.includes('How calculated');
if (!htmlOk) failures++;
if (!textOk) failures++;
console.log(`${htmlOk ? 'PASS' : 'FAIL'}  digest html has deposited + calc block`);
console.log(`${textOk ? 'PASS' : 'FAIL'}  digest text has deposited + calc lines`);
console.log('subject:', subject);

console.log(failures === 0 ? '\nGROSS TEST PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
