#!/usr/bin/env node
/**
 * Seeds / refreshes data/kraken-hourly.json with Kraken hourly (interval=60)
 * OHLC closes for ETH/USD and BTC/USD.
 *
 *   node dev/fetch-prices.mjs            # full seed back to START
 *   node dev/fetch-prices.mjs --update   # extend from last stored hour
 *                                        # (minus a 48h overlap), live wins
 *
 * Output: { updated: <ISO>, ETH: { "2026-01-01T00:00": 1234.5, ... },
 *           BTC: { ... } } — pretty-printed for clean git diffs.
 *
 * Run behind the VM's egress proxy: NODE_USE_ENV_PROXY=1.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'kraken-hourly.json');
const START = '2026-01-01T00:00'; // hourly pricing since pool inception window
// Kraken's public OHLC only serves the newest ~720 hourly candles, so deep
// history comes from Coinbase Exchange (300 candles/request, pageable by
// time range). The engine refreshes the trailing 30h from Kraken live, so
// the file's recent tail is Kraken and the seam self-heals on every update.
const KRAKEN_PAIRS = { ETH: 'XETHZUSD', BTC: 'XXBTZUSD' };
const CB_PRODUCTS = { ETH: 'ETH-USD', BTC: 'BTC-USD' };
const KRAKEN_WINDOW_H = 700; // stay inside Kraken's 720-candle serve window

const hourMs = (hk) =>
  Date.UTC(+hk.slice(0, 4), +hk.slice(5, 7) - 1, +hk.slice(8, 10), +hk.slice(11, 13));
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13) + ':00';
const nowHour = () => hourKey(Date.now() - 3600000); // last closed hour

async function fetchKrakenRecent(pair, fromHour, toHour) {
  // Newest ~720 hourly candles in one shot (Kraken only serves the recent
  // window; fromHour must be within KRAKEN_WINDOW_H of toHour).
  const url =
    `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=60` +
    `&since=${Math.floor(hourMs(fromHour) / 1000)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Kraken ${r.status} for ${pair}`);
  const j = await r.json();
  if (j.error && j.error.length) throw new Error(`Kraken: ${j.error[0]}`);
  const out = {};
  const key = Object.keys(j.result).find((k) => k !== 'last');
  for (const c of j.result[key] || []) {
    const hk = hourKey(c[0] * 1000);
    if (hk >= fromHour && hk <= toHour && !(hk in out)) out[hk] = parseFloat(c[4]);
  }
  return out;
}

async function fetchCoinbaseHistory(product, fromHour, toHour) {
  // Coinbase serves up to 300 hourly candles per request and pages by
  // explicit start/end, so it covers the deep history Kraken won't serve.
  // Response: [time, low, high, open, close, volume], newest-first.
  const out = {};
  let endMs = hourMs(toHour) + 3600000;
  const fromMs = hourMs(fromHour);
  while (endMs > fromMs) {
    const startMs = Math.max(fromMs, endMs - 300 * 3600000);
    const url =
      `https://api.exchange.coinbase.com/products/${product}/candles` +
      `?granularity=3600&start=${new Date(startMs).toISOString()}` +
      `&end=${new Date(endMs).toISOString()}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'ryze-lp-checker' } });
    if (!r.ok) throw new Error(`Coinbase ${r.status} for ${product}`);
    const candles = await r.json();
    for (const c of candles || []) {
      const hk = hourKey(c[0] * 1000);
      if (hk >= fromHour && hk <= toHour && !(hk in out)) out[hk] = parseFloat(c[4]);
    }
    if (!candles || !candles.length) break;
    endMs = startMs;
    await new Promise((r2) => setTimeout(r2, 350));
  }
  return out;
}

async function fetchRange(asset, fromHour, toHour) {
  // Split at the Kraken serve window: deep history from Coinbase, the
  // recent tail from Kraken (the engine's live source). Kraken wins any
  // overlap so the seam matches what the engine would fetch itself.
  const splitMs = hourMs(toHour) - KRAKEN_WINDOW_H * 3600000;
  const splitHour = hourKey(Math.max(splitMs, hourMs(fromHour)));
  const out = {};
  if (hourMs(fromHour) < hourMs(splitHour)) {
    Object.assign(out, await fetchCoinbaseHistory(CB_PRODUCTS[asset], fromHour, splitHour));
  }
  Object.assign(
    out,
    await withRetry(() => fetchKrakenRecent(KRAKEN_PAIRS[asset], splitHour, toHour), asset)
  );
  return out;
}

async function withRetry(fn, label) {
  let retries = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!/rate limit|too many requests|429|5\d\d/i.test(e.message) || ++retries > 8) throw e;
      const wait = Math.min(15000 * retries, 120000);
      console.log(`  ${label}: rate-limited, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((r2) => setTimeout(r2, wait));
    }
  }
}

const update = process.argv.includes('--update');
let data = { updated: null, ETH: {}, BTC: {} };
if (existsSync(OUT)) data = JSON.parse(readFileSync(OUT, 'utf8'));

const toHour = nowHour();
for (const asset of Object.keys(KRAKEN_PAIRS)) {
  const have = Object.keys(data[asset] || {});
  const fromHour = update && have.length
    ? hourKey(Math.max(hourMs(have.sort().pop()) - 48 * 3600000, hourMs(START)))
    : START;
  console.log(`${asset}: fetching ${fromHour} -> ${toHour}`);
  const fresh = await fetchRange(asset, fromHour, toHour);
  data[asset] = { ...(data[asset] || {}), ...fresh };
}

data.updated = new Date().toISOString();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
for (const asset of Object.keys(KRAKEN_PAIRS)) {
  const ks = Object.keys(data[asset]).sort();
  console.log(`${asset}: ${ks.length} hours, ${ks[0]} .. ${ks[ks.length - 1]}`);
}
console.log('wrote', OUT);
