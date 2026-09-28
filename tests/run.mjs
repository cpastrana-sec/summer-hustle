// Unit + security tests: node tests/run.mjs   (no dependencies)
import assert from 'node:assert/strict';
import { teenOk, safeJobUrl, toCard, buildFeed, hourly } from '../lib/teen.js';
import { onRequestGet, onRequest } from '../functions/api/jobs.js';

let pass = 0; const t = async (name, fn) => { await fn(); pass++; console.log('ok -', name); };

await t('teen filter blocks adult roles', () => {
  assert.equal(teenOk('Store Manager', 15), false);
  assert.equal(teenOk('Registered Nurse', null), false);
  assert.equal(teenOk('Crew Member', 14), true);
  assert.equal(teenOk('Cashier', 30), false);
});
await t('annual salary converted to hourly', () => { assert.equal(hourly(31200), 15); assert.equal(hourly('16'), 16); assert.equal(hourly(null), null); });
await t('only https adzuna links survive', () => {
  assert.equal(safeJobUrl('javascript:alert(1)'), '');
  assert.equal(safeJobUrl('http://www.adzuna.com/x'), '');
  assert.equal(safeJobUrl('https://evil.example/adzuna.com'), '');
  assert.equal(safeJobUrl('https://adzuna.com.evil.example/x'), '');
  assert.ok(safeJobUrl('https://www.adzuna.com/details/1?utm=a').startsWith('https://www.adzuna.com/'));
});
await t('card fields are clipped plain strings', () => {
  const c = toCard({ id: 1, title: '<img src=x onerror=alert(1)>'.repeat(20), redirect_url: 'https://www.adzuna.com/d/1', description: 'x'.repeat(999) });
  assert.ok(c.title.length <= 120 && c.blurb.length <= 161 && typeof c.id === 'string');
});
await t('feed drops bad links, adult roles and duplicates', () => {
  const r = [
    { title: 'Cashier', company: { display_name: 'A' }, redirect_url: 'https://www.adzuna.com/1' },
    { title: 'Cashier', company: { display_name: 'A' }, redirect_url: 'https://www.adzuna.com/2' },
    { title: 'Shift Manager', company: { display_name: 'B' }, redirect_url: 'https://www.adzuna.com/3' },
    { title: 'Bagger', company: { display_name: 'C' }, redirect_url: 'javascript:alert(1)' },
  ];
  const f = buildFeed(r); assert.equal(f.length, 1); assert.equal(f[0].title, 'Cashier');
});

const store = new Map(); let upstreamCalls = 0, lastUpstream = '';
globalThis.caches = { default: { match: async k => store.get(k.url)?.clone(), put: async (k, v) => { store.set(k.url, v); } } };
globalThis.fetch = async (u) => { upstreamCalls++; lastUpstream = String(u);
  return new Response(JSON.stringify({ results: [{ id: 9, title: 'Barista', company: { display_name: 'Cafe' }, redirect_url: 'https://www.adzuna.com/9', salary_min: 29120 }] }), { status: 200 }); };
const env = { ADZUNA_APP_ID: 'TESTID', ADZUNA_APP_KEY: 'TESTSECRETKEY' };
const call = (q, e = env) => { const p = []; return onRequestGet({ request: new Request('https://site.test/api/jobs' + q), env: e, waitUntil: x => p.push(x) }).then(async r => { await Promise.all(p); return r; }); };

await t('rejects invalid ZIPs (injection attempts)', async () => {
  for (const q of ['', '?zip=abc', '?zip=1234', '?zip=123456', '?zip=32792%27%20OR%201=1', '?zip=<script>']) {
    const r = await call(q); assert.equal(r.status, 400);
  }
  assert.equal(upstreamCalls, 0);
});
await t('503 when secrets are missing', async () => { const r = await call('?zip=32792', {}); assert.equal(r.status, 503); });
await t('returns filtered jobs and never leaks the key', async () => {
  const r = await call('?zip=32792'); const body = await r.text();
  assert.equal(r.status, 200); assert.ok(!body.includes('TESTSECRETKEY') && !body.includes('TESTID'));
  assert.equal(JSON.parse(body).jobs[0].payLow, 14);
  assert.ok(lastUpstream.includes('where=32792'));
});
await t('second request for same ZIP served from cache', async () => { const before = upstreamCalls; await call('?zip=32792&junk=1'); assert.equal(upstreamCalls, before); });
await t('upstream failure returns generic 502 without the key', async () => {
  globalThis.fetch = async () => { throw new Error('boom app_key=TESTSECRETKEY'); };
  const r = await call('?zip=10001'); const b = await r.text(); assert.equal(r.status, 502); assert.ok(!b.includes('TESTSECRETKEY'));
});
await t('non-GET methods get 405', async () => { const r = onRequest(); assert.equal(r.status, 405); });
console.log(`\n${pass} tests passed`);
