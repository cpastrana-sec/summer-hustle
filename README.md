# Summer Hustle — teen summer job board

Live: https://summer-hustle-teens.pages.dev · Source: https://github.com/cpastrana-sec/summer-hustle · Security headers: A+ (securityheaders.com)

A public job board that helps teens 16+ find summer work near their ZIP code. Built and operated
on a home lab (Synology NAS) plus Cloudflare Pages, with a security review and hardening pass
documented in [SECURITY.md](SECURITY.md).

## Architecture

```
                    every 30 min (DSM Task Scheduler)
  Adzuna Jobs API  <───────────────  poller/job_poller.py  (Synology NAS, Python stdlib)
        ▲                               │  teen filter · dedupe · https-only links
        │                               ├─> /volume1/web/jobsite/jobs.json   (NAS Web Station copy)
        │                               └─> email/SMS alerts on new jobs (escaped HTML)
        │
        │  server-side, key held as encrypted secret
        │
  functions/api/jobs.js  (Cloudflare Pages Function)  GET /api/jobs?zip=12345
        │  5-digit ZIP validation · 10 s timeout · teen filter · 6 h edge cache · generic errors
        ▼
  public/ (static)  index.html · app.js · styles.css · _headers (CSP + security headers)
        browser: renders with textContent only, https-only links, validated ZIP
```

| Path | What it is |
|---|---|
| `public/` | Static site. No inline script or style, so a strict CSP applies. |
| `public/_headers` | CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, HSTS. |
| `functions/api/jobs.js` | Cloudflare Pages Function — the only code that holds the Adzuna key. |
| `lib/teen.js` | Shared teen-job filter, normaliser and URL allow-list (pure, unit-tested). |
| `poller/job_poller.py` | NAS poller (Python 3.8, stdlib only). Credentials in `config.json`, chmod 600, outside the web root. |
| `tests/run.mjs` | 11 unit/security tests (`npm test`, no dependencies). |

## How the page gets data
1. `GET /api/jobs?zip=…` (Cloudflare Function) — any ZIP.
2. If there is no `/api` (the NAS Web Station copy), the home ZIP reads the poller's `jobs.json`.
3. Otherwise the built-in starter list plus pre-filtered links to Indeed, SimplyHired, Glassdoor and Snagajob.

## Run / deploy
- Tests: `node tests/run.mjs`
- Local preview with the function: `npx wrangler pages dev public` (put keys in `.dev.vars`, see `.dev.vars.example`).
- Deploy: push to GitHub → Cloudflare Pages builds automatically (build command: none, output dir: `public`).
- Secrets: Cloudflare Pages → Settings → Variables and Secrets → `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` (type **Secret**).
- Poller: copy `poller/job_poller.py` to the NAS; `config.json` from `config.example.json`; `chmod 600 config.json`.
