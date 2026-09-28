// GET /api/jobs?zip=12345  — Cloudflare Pages Function.
// Holds the Adzuna credentials server-side (encrypted env vars ADZUNA_APP_ID / ADZUNA_APP_KEY),
// so the browser never sees them. Validates input, filters to teen roles, and caches per ZIP
// at the edge for 6 hours to protect the free API quota.
import { WHAT_OR, WHAT_EXCLUDE, buildFeed } from '../../lib/teen.js';

const TTL = 6 * 60 * 60;
const ZIP_RE = /^\d{5}$/;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra },
  });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const zip = url.searchParams.get('zip') || '';
  if (!ZIP_RE.test(zip)) return json({ error: 'zip must be exactly 5 digits' }, 400, { 'Cache-Control': 'no-store' });
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return json({ error: 'live search not configured' }, 503, { 'Cache-Control': 'no-store' });

  // Cache key is normalised (only the validated ZIP) so junk query params can't bust the cache.
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/jobs?zip=${zip}`, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = 'https://api.adzuna.com/v1/api/jobs/us/search/1?' + new URLSearchParams({
    app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY, where: zip, distance: '16',
    what_or: WHAT_OR, what_exclude: WHAT_EXCLUDE, results_per_page: '50', max_days_old: '7',
    sort_by: 'date', 'content-type': 'application/json',
  });

  let data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(upstream, { signal: ctrl.signal, headers: { 'User-Agent': 'summer-hustle/2.0' } });
    clearTimeout(timer);
    if (!r.ok) throw new Error('upstream ' + r.status);
    data = await r.json();
  } catch (e) {
    // Never echo upstream errors: the request URL contains the API key.
    console.log('adzuna fetch failed', e && e.name);
    return json({ error: 'upstream unavailable' }, 502, { 'Cache-Control': 'no-store' });
  }

  const jobs = buildFeed(data && data.results);
  const res = json({ updated: new Date().toISOString(), zip, count: jobs.length, jobs }, 200,
    { 'Cache-Control': `public, max-age=${TTL}` });
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export function onRequest() {
  return json({ error: 'method not allowed' }, 405, { Allow: 'GET' });
}
