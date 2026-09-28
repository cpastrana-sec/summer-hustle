# Security review & threat model — Summer Hustle

Scope: public site (Cloudflare Pages), NAS poller, NAS Web Station copy. Reviewed Sept 2026.

## Assets
- Adzuna API credentials (quota and account standing)
- Visitors' browsers (mostly teenagers) — must not run attacker-controlled script
- The home network / NAS — must not be reachable from the public site
- Alert recipients' inboxes

## Findings (before) → fixes (after)

| # | Severity | Finding | Fix | Verified by |
|---|---|---|---|---|
| 1 | High | Adzuna `app_id` / `app_key` hard-coded in public JavaScript — anyone viewing source could copy them and exhaust or abuse the quota. | Moved all API calls to a Cloudflare Pages Function; credentials stored as encrypted Secrets and never sent to the browser. Exposed key **rotated**. Upstream errors are never echoed (the upstream URL contains the key). | `tests/run.mjs`: response bodies and error paths contain no key. |
| 2 | High | DOM XSS — third-party job text inserted with `innerHTML`; apply links not scheme-checked (`javascript:` possible); poisoned results could persist via the localStorage cache. | Rendering rewritten to `createElement`/`textContent` only; every record (API, jobs.json, cache) passes `normalizeCard()` (type coercion, length caps); links must parse as `https:`; server additionally allow-lists `*.adzuna.com`. | Headless-browser test with a hostile feed: old build executed the payload (`window.__xss=1`, `javascript:` link rendered); new build rendered it as inert text, 0 script execution, 0 `javascript:` links. |
| 3 | Medium | No Content-Security-Policy or hardening headers; all JS/CSS inline. | JS/CSS moved to files; `_headers` sets strict CSP (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`), nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, HSTS. | 0 CSP violations in headless Chrome; securityheaders.com scan after deploy. |
| 4 | Medium | HTML injection in poller alert emails — job titles/URLs interpolated unescaped into the HTML body. | `html.escape()` on every field; non-https / non-Adzuna links dropped before they reach the feed or email. | Poller test with a `<script>` title: email contains only `&lt;script&gt;`. |
| 5 | Medium | Unvalidated input — ZIP forwarded to the API; unbounded query params could bust caches. | Strict `^\d{5}$` on client and server; cache key normalised to the validated ZIP; non-GET → 405. | Tests: 6 malformed/injection ZIPs → 400 with zero upstream calls. |
| 6 | Low | Availability — each visitor's ZIP search spent the free API quota; no upstream timeout. | 6 h edge cache per ZIP + 6 h browser cache; 10 s upstream timeout; graceful fallbacks (NAS feed → starter list). | Tests: repeat ZIP served from cache (0 upstream calls). |
| 7 | Privacy | Public page identified a specific minor (first name, age, home ZIP). | Copy made generic ("teens 16+"). | Manual review. |
| 8 | Info | Public site's live feed silently broken (`jobs.json` missing on Cloudflare; SPA fallback returned HTML). | Function serves every ZIP; client checks `Content-Type` before parsing. | Headless test. |

## Controls already in place (kept)
- Poller credentials in `config.json`, chmod 600, **outside** the web root; `jobs.json` holds listings only.
- Atomic write (temp file + `os.replace`) — the site never reads a half-written feed; on API failure the last good feed is kept.
- Retries with backoff; DSM emails the owner only when the script terminates abnormally.
- The NAS is not exposed to the internet for this site: the public site is served by Cloudflare.

## Residual risks / next steps
- Google Fonts is a third-party dependency allowed by the CSP → self-host fonts to tighten `style-src`/`font-src` to `'self'`.
- No per-IP rate limit on `/api/jobs` beyond caching → add a Cloudflare rate-limiting rule.
- Adzuna is trusted for content correctness; listings are informational and link out to the source.
