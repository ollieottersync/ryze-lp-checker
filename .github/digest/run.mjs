// Weekly digest driver.
// For each confirmed subscriber: render the checker page in headless Chromium
// (?wallet= autoplay runs the analysis exactly as a visitor's would — no
// 50-subrequest cap out here), grab window.__ryzeDigestResult, build the email
// with digest-email.mjs, and POST the finished email to the worker's
// secret-guarded /internal/digest endpoint, which sends it via Resend.
//
// Env: WORKER_URL (https://ryze-email.<acct>.workers.dev), INTERNAL_SECRET
// (must match the worker's INTERNAL_SECRET secret).
import { chromium } from 'playwright';
import { buildDigestEmail } from './digest-email.mjs';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const SECRET = process.env.INTERNAL_SECRET || '';
const SITE = 'https://ryze.sappen.io';

if (!WORKER_URL || !SECRET) {
  console.error('digest: missing WORKER_URL or INTERNAL_SECRET env');
  process.exit(2);
}
const auth = { Authorization: 'Bearer ' + SECRET };

// ISO week key, e.g. "2026-W39".
function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; // Mon=0
  t.setUTCDate(t.getUTCDate() - day + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function callApi(path, opts = {}) {
  const res = await fetch(WORKER_URL + path, {
    ...opts,
    headers: { ...auth, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 403) throw new Error('worker rejected internal auth (INTERNAL_SECRET mismatch?)');
  if (!res.ok) throw new Error(`worker ${path}: HTTP ${res.status}`);
  return res.json();
}

async function renderWallet(browser, wallet) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`${SITE}/?wallet=${wallet}`, {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await page.waitForFunction(
      () => {
        const s = document.documentElement.dataset.digestReady;
        return s === '1' || s === 'error';
      },
      null,
      { timeout: 20 * 60 * 1000, polling: 2000 }
    );
    const state = await page.evaluate(() => ({
      ready: document.documentElement.dataset.digestReady,
      result: window.__ryzeDigestResult || null,
      error: window.__ryzeDigestError || null,
    }));
    if (state.ready !== '1' || !state.result) {
      throw new Error('page analysis failed: ' + (state.error || 'unknown'));
    }
    return state.result;
  } finally {
    await ctx.close();
  }
}

const week = weekKey();
const { sent } = await callApi(`/internal/digest-sent?week=${week}`);
if (sent) {
  console.log(`digest: week ${week} already sent — skipping (backup run stands down)`);
  process.exit(0);
}

const { subscribers } = await callApi('/internal/subscribers');
console.log(`digest: week ${week}, ${subscribers.length} subscriber(s)`);
if (!subscribers.length) process.exit(0);

const browser = await chromium.launch();
let ok = 0, failed = 0;
for (const sub of subscribers) {
  try {
    const shortW = sub.wallet.slice(0, 10); // logs are public on a public repo: never log emails
    console.log(`digest: rendering ${shortW}…`);
    const result = await renderWallet(browser, sub.wallet);
    const unsubUrl =
      `${WORKER_URL}/unsubscribe?email=${encodeURIComponent(sub.email)}&token=${sub.unsubToken}`;
    const { subject, text, html } = buildDigestEmail(result, { email: sub.email, unsubUrl });
    const r = await callApi('/internal/digest', {
      method: 'POST',
      body: JSON.stringify({ to: sub.email, subject, text, html, week }),
    });
    if (!r.ok) throw new Error('send failed: ' + (r.error || 'unknown'));
    ok++;
    console.log(`digest: sent to ${shortW}… — "${subject}"`);
  } catch (e) {
    failed++;
    console.error(`digest: FAILED for ${shortW}…: ${e && e.message}`);
  }
}
await browser.close();
console.log(`digest: done — ${ok} sent, ${failed} failed`);
if (ok === 0 && failed > 0) process.exit(1);
