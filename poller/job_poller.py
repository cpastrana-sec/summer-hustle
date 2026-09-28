#!/usr/bin/env python3
"""
SUMMER HUSTLE job poller — runs on the Synology NAS (Python 3.8, stdlib only).
Polls Adzuna for teen-friendly jobs near Winter Park FL 32792, writes the live
feed the website reads (jobs.json), and on NEW matches sends email + SMS alerts.

Config (creds) live in config.json next to this file (chmod 600, NON-web path).
Output jobs.json is written into the Web Station folder (public — listings only).
Scheduled via DSM Task Scheduler (every ~30 min). No external libs needed.
"""
import json, os, sys, time, ssl, smtplib, urllib.parse, urllib.request
from datetime import datetime, timezone
from html import escape as html_escape
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(HERE, "config.json")
SEEN_PATH = os.path.join(HERE, "seen.json")
LOG_PATH = os.path.join(HERE, "poller.log")

# Teen-friendly category keyword map (title/description match → card category).
CATS = [
    ("food",    "Food & Drink",      ["crew member","barista","cashier","fast food","restaurant","server","host","cook","food","cafe","coffee","smoothie","ice cream","pizza"]),
    ("grocery", "Grocery",           ["grocery","bagger","courtesy clerk","stocker","publix","supermarket","produce"]),
    ("retail",  "Retail",            ["retail","sales associate","store associate","merchandise","cashier retail","stock associate"]),
    ("rec",     "Recreation",        ["lifeguard","theater","cinema","attractions","recreation","park","amusement","bowling","golf","usher","concession"]),
    ("camp",    "Camps & Kids",      ["camp counselor","summer camp","counselor","childcare","youth program","kids"]),
    ("out",     "Outdoors & Labor",  ["landscaping","lawn","car wash","warehouse","mover","groundskeeper","detailer","seasonal"]),
]
# Broad single-query term set (1 API call/poll → stays well under Adzuna free limits).
WHAT_OR = "crew cashier barista bagger lifeguard counselor stocker retail server host warehouse landscaping"
# Adzuna-side exclusions (career/adult roles a 17yo can't take).
WHAT_EXCLUDE = "manager senior director supervisor licensed pharmacist nurse registered driver cdl engineer analyst rn"
# Post-filter blocklist (title contains → drop) + adult pay ceiling.
BLOCK = ["pharmacist","nurse","registered nurse"," rn ","manager","supervisor","director","senior","sr.",
         "lead ","licensed","therapist","engineer","analyst","driver","cdl","paramedic","dental","attorney",
         "accountant","controller","principal","executive","architect","practitioner","clinician","journeyman",
         "rn,","lpn","sales rep","outside sales","b2b","account executive","superintendent","foreman","assistant manager"]
TEEN_HOURLY_CEILING = 22  # roles computing above this are almost certainly adult/career


def teen_ok(title, hourly_hi):
    t = " " + (title or "").lower() + " "
    if any(b in t for b in BLOCK):
        return False
    if hourly_hi and hourly_hi > TEEN_HOURLY_CEILING:
        return False
    return True


def log(msg):
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line)
    try:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def categorize(text):
    t = (text or "").lower()
    for key, label, kws in CATS:
        if any(k in t for k in kws):
            return key, label
    return "out", "Outdoors & Labor"


def hourly_pay(smin, smax):
    """Adzuna US salaries are usually annual; convert to a rough hourly band. Returns (lo,hi) or (None,None)."""
    def conv(v):
        if not v:
            return None
        v = float(v)
        return round(v / 2080) if v > 2000 else round(v)  # annual→hourly, else assume already hourly
    return conv(smin), conv(smax)


def days_ago(created_iso):
    try:
        d = datetime.fromisoformat(created_iso.replace("Z", "+00:00"))
        n = (datetime.now(timezone.utc) - d).days
        return "today" if n <= 0 else (f"{n}d ago")
    except Exception:
        return "recent"


def fetch_adzuna(cfg):
    base = f"https://api.adzuna.com/v1/api/jobs/{cfg.get('adzuna_country','us')}/search/1"
    params = {
        "app_id": cfg["adzuna_app_id"],
        "app_key": cfg["adzuna_app_key"],
        "where": cfg.get("where", "Winter Park, FL"),
        "distance": cfg.get("distance_km", 16),
        "what_or": WHAT_OR,
        "what_exclude": WHAT_EXCLUDE,
        "results_per_page": cfg.get("results_per_page", 50),
        "max_days_old": cfg.get("max_days_old", 7),
        "sort_by": "date",
        "content-type": "application/json",
    }
    url = base + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "summer-hustle-poller/1.0"})
    last = None
    for attempt in range(3):  # Adzuna 503/timeouts are usually transient — retry w/ backoff
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last = e
            log(f"Adzuna attempt {attempt+1}/3 failed: {e}")
            time.sleep(4 * (attempt + 1))
    raise last


def safe_url(u):
    """Keep only https links on adzuna.com — blocks javascript:/data: URLs from reaching the site or emails."""
    try:
        p = urllib.parse.urlparse(u or "")
        host = (p.hostname or "").lower()
        if p.scheme == "https" and (host == "adzuna.com" or host.endswith(".adzuna.com")):
            return u
    except Exception:
        pass
    return ""


def to_card(item):
    title = item.get("title", "").strip()
    company = (item.get("company") or {}).get("display_name", "Local employer")
    loc = (item.get("location") or {}).get("display_name", "near 32792")
    desc = (item.get("description") or "").strip()
    blurb = (desc[:160] + "…") if len(desc) > 160 else desc
    cat, label = categorize(f"{title} {desc} {item.get('category',{}).get('label','')}")
    lo, hi = hourly_pay(item.get("salary_min"), item.get("salary_max"))
    return {
        "id": str(item.get("id", "")),
        "cat": cat, "catLabel": label,
        "title": title or "Job opening",
        "emp": company,
        "blurb": blurb or "Tap Apply for full details.",
        "payLow": lo, "payHigh": hi,
        "hrLo": None, "hrHi": None,
        "dist": loc.split(",")[0] if "," in loc else "near 32792",
        "url": safe_url(item.get("redirect_url", "")),
        "posted": days_ago(item.get("created", "")),
    }


def send_notifications(cfg, new_cards):
    """Email (HTML) + SMS (plain via carrier gateway) on new jobs."""
    n = len(new_cards)
    site = cfg.get("site_url", "the job board")
    subj = f"☀️ {n} new summer job{'s' if n!=1 else ''} near Winter Park (32792)"
    # email body
    def payband(c):
        lo, hi = c.get('payLow'), c.get('payHigh')
        if lo and hi and lo != hi: return f" · ~${lo}-${hi}/hr"
        v = lo or hi
        return f" · ~${v}/hr" if v else ""
    esc = lambda v: html_escape(str(v or ""), quote=True)   # job text is untrusted → escape for HTML email
    rows = "".join(
        f"<li style='margin:8px 0'><b>{esc(c['title'])}</b> — {esc(c['emp'])}{esc(payband(c))}"
        + (f"<br><a href='{esc(c['url'])}'>Apply →</a>" if c.get('url') else "") + "</li>"
        for c in new_cards[:15]
    )
    html = (f"<h2>{n} new opening{'s' if n!=1 else ''} near 32792</h2><ul>{rows}</ul>"
            f"<p>Full board: <a href='{html_escape(site, quote=True)}'>{html_escape(site)}</a></p>"
            f"<p style='color:#888;font-size:12px'>SUMMER HUSTLE auto-poller · Adzuna · always confirm details with the employer.</p>")
    sms_lines = [f"{n} new summer job{'s' if n!=1 else ''} near 32792:"]
    for c in new_cards[:4]:
        sms_lines.append(f"• {c['title']} @ {c['emp']}")
    sms_lines.append(f"Full list: {site}")
    sms = "\n".join(sms_lines)

    host = cfg.get("smtp_host", "smtp.gmail.com")
    port = int(cfg.get("smtp_port", 587))
    user = cfg.get("smtp_user", "")
    pw = cfg.get("smtp_pass", "")
    if not (user and pw):
        log("SMTP creds missing — skipping notifications (jobs.json still written)")
        return
    recips = [r for r in [cfg.get("recipient_email"), cfg.get("sms_gateway")] if r]
    ctx = ssl.create_default_context()
    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls(context=ctx)
            s.login(user, pw)
            # rich email to the inbox
            if cfg.get("recipient_email"):
                m = MIMEMultipart("alternative")
                m["Subject"] = subj; m["From"] = user; m["To"] = cfg["recipient_email"]
                m.attach(MIMEText(sms, "plain")); m.attach(MIMEText(html, "html"))
                s.sendmail(user, cfg["recipient_email"], m.as_string())
            # plain SMS to the carrier gateway (no subject noise)
            if cfg.get("sms_gateway"):
                sm = MIMEText(sms, "plain"); sm["From"] = user; sm["To"] = cfg["sms_gateway"]
                s.sendmail(user, cfg["sms_gateway"], sm.as_string())
        log(f"notified {recips} of {n} new jobs")
    except Exception as e:
        log(f"notify FAILED: {e}")


def atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def main():
    cfg = load_json(CFG_PATH, None)
    if not cfg:
        log("no config.json — abort"); sys.exit(1)
    if not (cfg.get("adzuna_app_id") and cfg.get("adzuna_app_key")):
        log("Adzuna keys not set in config.json — abort (register at developer.adzuna.com)"); sys.exit(1)
    try:
        raw = fetch_adzuna(cfg)
    except Exception as e:
        # Transient Adzuna outage — log + exit 0 (NOT 1) so DSM doesn't email an error.
        # jobs.json is never overwritten on failure, so the site keeps the last good feed.
        log(f"Adzuna unavailable after retries ({e}) — skipping this poll, last feed kept")
        return
    items = raw.get("results", [])
    cards = [to_card(i) for i in items if i.get("title")]
    cards = [c for c in cards if c["url"] and teen_ok(c["title"], c.get("payHigh"))]   # teen-appropriate, safe link only
    # dedupe by (title+employer) to collapse repostings of the same role
    uniq = {}
    for c in cards:
        key = (c["title"].lower().strip(), c["emp"].lower().strip())
        if key not in uniq:
            uniq[key] = c
    cards = list(uniq.values())

    seen = set(load_json(SEEN_PATH, []))
    new_cards = [c for c in cards if c["id"] not in seen]

    # write the public feed (full current list, capped)
    out = cfg.get("web_out", "/volume1/web/jobsite/jobs.json")
    feed = {"updated": datetime.now(timezone.utc).isoformat(), "count": len(cards), "jobs": cards[:60]}
    try:
        atomic_write(out, feed)
        log(f"wrote {len(cards)} jobs -> {out} ({len(new_cards)} new)")
    except Exception as e:
        log(f"write feed FAILED: {e}")

    if new_cards:
        send_notifications(cfg, new_cards)
        seen.update(c["id"] for c in cards)
        # keep seen bounded
        atomic_write(SEEN_PATH, list(seen)[-2000:])
    else:
        log("no new jobs this poll")


if __name__ == "__main__":
    main()
