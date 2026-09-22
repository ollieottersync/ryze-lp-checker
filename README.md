# Ryze LP Performance Checker

A single self-contained static page: a visitor pastes any Base wallet address
and gets an instant realized-APR/APY report for its Ryze Protocol liquidity
positions (WETH/USDC and cbBTC/USDC gauge pools).

- **File to deploy:** `index.html` (inline CSS + JS, zero external assets)
- **No backend, no build step, no cookies, no analytics, no trackers.**
- All computation runs in the visitor's browser against public APIs:
  Blockscout (Base transfer history), Kraken hourly closes (bundled history
  in `data/kraken-hourly.json`, refreshed daily by CI; Coinbase Exchange
  fallback), and a public Base RPC (`eth_call` for unclaimed rewards).
- Logic is a direct port of the verified Python engine
  (`~/workspace/ryze-rewards-monitor/analyze_apr.py`); verified to reproduce
  its output exactly on the reference wallet.

## Deploy to GoDaddy (cPanel shared hosting)

1. Log in to your GoDaddy account → **My Products** → Web Hosting → **Manage**
   (opens cPanel).
2. Open **File Manager**.
3. Navigate to `public_html` (the web root for your primary domain).
   - For an addon domain or subdomain, use its document root instead
     (e.g. `public_html/checker` — the page works from any path).
4. Click **Upload**, select `index.html` from this folder, and wait for the
   upload to finish.
5. Overwrite the existing `index.html` if one is there (that's GoDaddy's
   default placeholder page).
6. Visit your domain — the checker loads immediately. No DNS, database, or
   server-side configuration needed.

That's it — it's a static file; there is nothing to install or keep running.

## Rebuilding

`index.html` is generated from `dev/` — don't edit it by hand:

- `dev/engine.js` — the analysis engine (also unit-tested in Node)
- `dev/app.js` — UI wiring
- `dev/page.html` — page template
- `dev/build.mjs` — inlines everything into `../index.html`

Rebuild with: `node dev/build.mjs` (run from this folder).

Acceptance tests: `node dev/test.mjs` (reference-wallet parity),
`node dev/test-general.mjs` (third-party wallet + empty-address behavior).
