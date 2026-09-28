/* SUMMER HUSTLE — front-end (served as a static file; no inline script so a strict CSP applies).
 *
 * Security model:
 *  - All job data (API, jobs.json, localStorage cache) is treated as UNTRUSTED.
 *    It passes through normalizeCard() and is rendered ONLY with textContent /
 *    createElement — never innerHTML — so markup in a job title can't execute (XSS).
 *  - Links are allowed only if they parse as https: URLs (blocks javascript:/data: links).
 *  - ZIP input is validated to exactly 5 digits before it is stored or sent anywhere.
 *  - No API keys live here: live search goes through /api/jobs (a Cloudflare Pages
 *    Function that holds the Adzuna key as an encrypted secret).
 */
'use strict';

const SEED_JOBS = [
  { cat:"food", catLabel:"Food & Drink", title:"Crew Member", emp:"Chick-fil-A / fast-casual", blurb:"Front counter, drive-thru, or kitchen. Famously teen-friendly, flexible shifts, fast hiring all summer.", payLow:14, payHigh:16, hrLo:15, hrHi:38, dist:"3–7 mi", url:"https://www.chick-fil-a.com/careers" },
  { cat:"food", catLabel:"Food & Drink", title:"Team Member", emp:"Chipotle", blurb:"Build burritos on the line, restock, and run register. 16+, hires year-round, free meals on shift.", payLow:14, payHigh:16, hrLo:20, hrHi:40, dist:"4–9 mi", url:"https://jobs.chipotle.com/search-jobs/Winter%20Park%2C%20FL" },
  { cat:"grocery", catLabel:"Grocery", title:"Front Service / Bagger", emp:"Publix", blurb:"Bag groceries, gather carts, and help customers. A classic Florida first job — 16+, good for steady summer hours.", payLow:14, payHigh:16, hrLo:15, hrHi:35, dist:"1–6 mi", url:"https://jobs.publix.com/" },
  { cat:"retail", catLabel:"Retail", title:"Sales / Stock Associate", emp:"Target", blurb:"Run register, restock, fulfill online orders. 16+, structured training, predictable scheduling.", payLow:15, payHigh:17, hrLo:20, hrHi:40, dist:"4–9 mi", url:"https://jobs.target.com/search-jobs/Winter%20Park%2C%20FL" },
  { cat:"rec", catLabel:"Recreation", title:"Lifeguard", emp:"City pools / aquatic centers", blurb:"Watch the water, enforce safety, keep things clean. 16+ with certification (often paid training). Prime summer pay.", payLow:15, payHigh:18, hrLo:20, hrHi:40, dist:"near you", urlTpl:"https://www.indeed.com/jobs?q=lifeguard&l={zip}&radius=10" },
  { cat:"camp", catLabel:"Camps & Kids", title:"Junior Camp Counselor", emp:"YMCA Central Florida", blurb:"Lead games, watch kids, run activities. Great for energetic teens; some roles take 16–17 as junior staff.", payLow:13, payHigh:16, hrLo:25, hrHi:40, dist:"3–10 mi", url:"https://www.ymcacf.org/careers" },
  { cat:"out", catLabel:"Outdoors & Labor", title:"Lawn Care / Landscaping Helper", emp:"Local landscaping crews", blurb:"Mowing, edging, hauling, planting. Hard but well-paid summer work; early starts beat the heat.", payLow:14, payHigh:18, hrLo:20, hrHi:40, dist:"near you", urlTpl:"https://www.indeed.com/jobs?q=landscaping+helper&l={zip}&radius=10" },
];
const ZIP_DEFAULT = '32792';
const ZIP_RE = /^\d{5}$/;
const CACHE_TTL = 6 * 60 * 60 * 1000;          // 6h browser cache per ZIP
const CAT_CLASS = { food:'food', grocery:'grocery', retail:'retail', rec:'rec', camp:'camp', out:'out' };

let JOBS = SEED_JOBS.slice();
let CURRENT_ZIP = ZIP_DEFAULT;
const state = { cat:'all', onlyFit:false, sort:'default' };

const $ = id => document.getElementById(id);
const cardsEl = $('cards'), countEl = $('count'), liveStatusEl = $('liveStatus');
const zipInput = $('zipInput'), zipHint = $('zipHint'), liveNote = $('liveNote');

/* ---------- safety helpers ---------- */
function safeUrl(u){
  try{ const url = new URL(String(u)); return url.protocol === 'https:' ? url.href : null; }
  catch(e){ return null; }
}
function str(v, max){ return (v == null ? '' : String(v)).slice(0, max); }
function num(v){ const n = Number(v); return Number.isFinite(n) && n > 0 && n < 1000 ? Math.round(n) : null; }
function normalizeCard(j){
  if(!j || typeof j !== 'object') return null;
  const cat = CAT_CLASS[j.cat] ? j.cat : 'out';
  return {
    id: str(j.id, 40), cat, catLabel: str(j.catLabel, 40),
    title: str(j.title, 120) || 'Job opening', emp: str(j.emp, 80) || 'Local employer',
    blurb: str(j.blurb, 200), dist: str(j.dist, 40) || 'near you', posted: str(j.posted, 20),
    payLow: num(j.payLow), payHigh: num(j.payHigh), hrLo: num(j.hrLo), hrHi: num(j.hrHi),
    url: safeUrl(j.url), urlTpl: typeof j.urlTpl === 'string' ? j.urlTpl : null, live: !!j.live,
  };
}
function el(tag, cls, text){
  const e = document.createElement(tag);
  if(cls) e.className = cls;
  if(text != null) e.textContent = text;
  return e;
}
function setText(id, t){ const e = $(id); if(e) e.textContent = t; }
function setStatus(text, live){
  liveStatusEl.replaceChildren();
  if(live) liveStatusEl.append(el('span', 'live-dot'));
  liveStatusEl.append(document.createTextNode(text));
}
function showNote(text){           // note text + a safe in-page link, no innerHTML
  if(!liveNote) return;
  const a = el('a', null, 'search links'); a.href = '#more';
  liveNote.replaceChildren(document.createTextNode(text + ' Use your retargeted '), a, document.createTextNode(' below.'));
  liveNote.style.display = 'block';
}
function hideNote(){ if(liveNote) liveNote.style.display = 'none'; }

/* ---------- rendering ---------- */
function fitsHours(j){ return j.hrHi >= 20 && j.hrLo <= 40; }
function applyUrlFor(j){
  if(j.urlTpl) return safeUrl(j.urlTpl.replace('{zip}', encodeURIComponent(CURRENT_ZIP)));
  return j.url;
}
function buildCard(j, i){
  const card = el('div', 'card reveal');
  card.style.transitionDelay = (i * 40) + 'ms';     // CSSOM, allowed under CSP
  card.append(el('div', 'cat-strip cs-' + (CAT_CLASS[j.cat] || 'out')));
  const body = el('div', 'body');
  body.append(el('div', 'cat-tag', j.catLabel));
  const h3 = el('h3', null, j.title);
  if(j.live) h3.append(el('span', 'live-badge', 'Live'));
  body.append(h3, el('div', 'emp', j.emp), el('p', 'blurb', j.blurb));
  const meta = el('div', 'meta');
  if(j.payLow || j.payHigh) meta.append(el('span', 'pill pay', '$' + (j.payLow || '?') + '–$' + (j.payHigh || '?') + '/hr*'));
  meta.append(el('span', 'pill dist', j.dist));
  if(j.hrLo || j.hrHi) meta.append(el('span', 'pill', (j.hrLo || '?') + '–' + (j.hrHi || '?') + ' hr/wk'));
  body.append(meta);
  const foot = el('div', 'foot');
  foot.append(el('span', 'hours', j.posted || 'Summer-friendly'));
  const href = applyUrlFor(j);
  if(href){
    const a = el('a', 'apply', 'Apply →');
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    foot.append(a);
  }
  card.append(body, foot);
  return card;
}
function render(){
  let list = JOBS.slice();
  if(state.cat !== 'all') list = list.filter(j => j.cat === state.cat);
  if(state.onlyFit) list = list.filter(fitsHours);
  if(state.sort === 'pay') list.sort((a,b) => (b.payHigh||0) - (a.payHigh||0) || (b.payLow||0) - (a.payLow||0));
  else if(state.sort === 'hours') list.sort((a,b) => (b.hrHi||0) - (a.hrHi||0));
  else list.sort((a,b) => (b.live?1:0) - (a.live?1:0));
  cardsEl.replaceChildren();
  if(list.length === 0){
    const nr = el('div', 'no-results');
    nr.append(el('div', 'big', 'No matches'), document.createTextNode('Try clearing a filter or browse the search links below.'));
    cardsEl.append(nr);
  } else {
    const frag = document.createDocumentFragment();
    list.forEach((j,i) => frag.append(buildCard(j,i)));
    cardsEl.append(frag);
  }
  countEl.replaceChildren(el('b', null, String(list.length)), document.createTextNode(' role' + (list.length === 1 ? '' : 's') + ' shown'));
  observeReveals();
}
function setFeed(cards){
  const clean = (cards || []).map(normalizeCard).filter(Boolean).map(c => ({ ...c, live:true }));
  JOBS = clean.concat(SEED_JOBS.map(normalizeCard));
  render();
  return clean.length;
}

/* ---------- data sources ---------- */
function readCache(zip){
  try{
    const o = JSON.parse(localStorage.getItem('hustle_jobs_' + zip) || 'null');
    return (o && Array.isArray(o.cards) && (Date.now() - o.t) < CACHE_TTL) ? o.cards : null;
  }catch(e){ return null; }
}
function writeCache(zip, cards){ try{ localStorage.setItem('hustle_jobs_' + zip, JSON.stringify({ t:Date.now(), cards })); }catch(e){} }

async function getJson(url){
  const r = await fetch(url, { cache:'no-store', headers:{ 'Accept':'application/json' } });
  const ct = r.headers.get('content-type') || '';
  if(!r.ok || !ct.includes('application/json')) throw new Error('bad response ' + r.status);
  return r.json();
}
// 1) /api/jobs (Cloudflare Function) for any ZIP.  2) jobs.json (NAS poller) for the home ZIP
//    when running on the NAS copy, where there is no /api.  3) starter list + search links.
async function loadZip(zip, {useCache = true} = {}){
  if(useCache){
    const cached = readCache(zip);
    if(cached){ const n = setFeed(cached); setStatus(n + ' live near ' + zip + ' · cached', n > 0); hideNote(); return; }
  }
  setStatus('searching ' + zip + '…', false);
  try{
    const d = await getJson('api/jobs?zip=' + encodeURIComponent(zip));
    const n = setFeed(d.jobs); writeCache(zip, d.jobs || []);
    if(n){ setStatus(n + ' live near ' + zip + ' · updated ' + new Date(d.updated).toLocaleString(), true); hideNote(); }
    else { setStatus('no live matches near ' + zip, false); showNote('No live listings for ' + zip + ' right now.'); }
    return;
  }catch(e){ /* fall through */ }
  if(zip === ZIP_DEFAULT){
    try{
      const d = await getJson('jobs.json?t=' + Date.now());
      const n = setFeed(d.jobs);
      setStatus(n + ' live · updated ' + (d.updated ? new Date(d.updated).toLocaleString() : ''), n > 0); hideNote();
      return;
    }catch(e){ /* fall through */ }
  }
  setFeed([]);
  setStatus('live feed offline — showing starter list', false);
  showNote('Live listings are unavailable right now.');
}

/* ---------- ZIP handling ---------- */
function applyZip(zip){
  CURRENT_ZIP = zip;
  const home = zip === ZIP_DEFAULT;
  document.querySelectorAll('[data-tpl]').forEach(a => {
    const u = safeUrl(a.dataset.tpl.replace('{zip}', encodeURIComponent(zip)));
    if(u) a.href = u;
  });
  setText('locKicker', home ? 'Winter Park, FL · ZIP 32792 · 5–10 mi radius' : 'Your area · ZIP ' + zip + ' · ~10 mi radius');
  setText('statZip', zip);
  setText('moreZip', 'ZIP ' + zip);
  setText('footLoc', home ? 'Winter Park, FL · ZIP 32792' : 'ZIP ' + zip);
  zipHint.style.color = 'var(--green)';
  zipHint.textContent = home ? '' : 'Showing jobs near ' + zip;
  loadZip(zip);
}
function submitZip(){
  const z = (zipInput.value || '').replace(/\D/g, '').slice(0, 5);
  if(!ZIP_RE.test(z)){ zipHint.style.color = 'var(--orange-deep)'; zipHint.textContent = 'Enter a 5-digit ZIP'; return; }
  try{ localStorage.setItem('hustle_zip', z); }catch(e){}
  applyZip(z);
}
function savedZip(){
  try{ const z = localStorage.getItem('hustle_zip') || ''; return ZIP_RE.test(z) ? z : ZIP_DEFAULT; }
  catch(e){ return ZIP_DEFAULT; }
}

/* ---------- wiring ---------- */
let io;
function observeReveals(){
  if(io) io.disconnect();
  io = new IntersectionObserver(entries => entries.forEach(e => { if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold:0.12 });
  document.querySelectorAll('.reveal:not(.in)').forEach(x => io.observe(x));
}
$('zipForm').addEventListener('submit', e => { e.preventDefault(); submitZip(); });
$('catSel').addEventListener('change', e => { state.cat = e.target.value; render(); });
$('sortSel').addEventListener('change', e => { state.sort = e.target.value; render(); });
$('hoursToggle').addEventListener('change', e => { state.onlyFit = e.target.checked; render(); });

JOBS = SEED_JOBS.map(normalizeCard);
render();                                // instant paint with the starter list
CURRENT_ZIP = savedZip();
zipInput.value = CURRENT_ZIP;
applyZip(CURRENT_ZIP);
setInterval(() => { if(CURRENT_ZIP === ZIP_DEFAULT) loadZip(ZIP_DEFAULT, {useCache:false}); }, 5 * 60 * 1000);
