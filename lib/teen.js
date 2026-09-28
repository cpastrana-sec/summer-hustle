// Teen-job filter + card normalizer. Mirrors poller/job_poller.py so the NAS feed and
// the live API return the same kind of roles. Pure functions -> unit-tested in tests/.
export const WHAT_OR = 'crew cashier barista bagger lifeguard counselor stocker retail server host warehouse landscaping';
export const WHAT_EXCLUDE = 'manager senior director supervisor licensed pharmacist nurse registered driver cdl engineer analyst rn';
export const BLOCK = ['pharmacist','nurse','registered nurse',' rn ','manager','supervisor','director','senior','sr.','lead ','licensed','therapist','engineer','analyst','driver','cdl','paramedic','dental','attorney','accountant','controller','principal','executive','architect','practitioner','clinician','journeyman','rn,','lpn','sales rep','outside sales','b2b','account executive','superintendent','foreman','assistant manager'];
export const TEEN_HOURLY_CEILING = 22;
export const CATS = [
  ['food','Food & Drink',['crew member','barista','cashier','fast food','restaurant','server','host','cook','food','cafe','coffee','smoothie','ice cream','pizza']],
  ['grocery','Grocery',['grocery','bagger','courtesy clerk','stocker','publix','supermarket','produce']],
  ['retail','Retail',['retail','sales associate','store associate','merchandise','cashier retail','stock associate']],
  ['rec','Recreation',['lifeguard','theater','cinema','attractions','recreation','park','amusement','bowling','golf','usher','concession']],
  ['camp','Camps & Kids',['camp counselor','summer camp','counselor','childcare','youth program','kids']],
  ['out','Outdoors & Labor',['landscaping','lawn','car wash','warehouse','mover','groundskeeper','detailer','seasonal']],
];
export function categorize(text){ const t=(text||'').toLowerCase(); for(const [k,l,kws] of CATS){ if(kws.some(w=>t.includes(w))) return [k,l]; } return ['out','Outdoors & Labor']; }
export function teenOk(title,payHi){ const t=' '+(title||'').toLowerCase()+' '; if(BLOCK.some(b=>t.includes(b))) return false; if(payHi && payHi>TEEN_HOURLY_CEILING) return false; return true; }
export function hourly(v){ if(!v) return null; v=parseFloat(v); if(!Number.isFinite(v)) return null; return v>2000?Math.round(v/2080):Math.round(v); }
export function daysAgo(iso, now=Date.now()){ const t=new Date(iso).getTime(); if(!Number.isFinite(t)) return 'recent'; const n=Math.floor((now-t)/86400000); return n<=0?'today':n+'d ago'; }
const clip=(s,n)=>String(s??'').replace(/\s+/g,' ').trim().slice(0,n);
// Only keep apply links that are https and point at Adzuna (the upstream source).
export function safeJobUrl(u){ try{ const x=new URL(u); return (x.protocol==='https:' && (x.hostname==='adzuna.com'||x.hostname.endsWith('.adzuna.com'))) ? x.href : ''; }catch{ return ''; } }
export function toCard(it){
  const title=clip(it.title,120), desc=clip(it.description,400);
  const emp=clip(it.company?.display_name,80)||'Local employer';
  const loc=clip(it.location?.display_name,80);
  const [cat,catLabel]=categorize(title+' '+desc+' '+(it.category?.label||''));
  return { id:clip(it.id,40), cat, catLabel, title:title||'Job opening', emp,
    blurb:(desc.length>160?desc.slice(0,160)+'…':desc)||'Tap Apply for full details.',
    payLow:hourly(it.salary_min), payHigh:hourly(it.salary_max), hrLo:null, hrHi:null,
    dist:loc.includes(',')?loc.split(',')[0]:(loc||'near you'), url:safeJobUrl(it.redirect_url), posted:daysAgo(it.created) };
}
export function buildFeed(results){
  const seen=new Set(), out=[];
  for(const c of (results||[]).filter(r=>r&&r.title).map(toCard)){
    if(!c.url || !teenOk(c.title,c.payHigh)) continue;
    const k=c.title.toLowerCase()+'|'+c.emp.toLowerCase();
    if(!seen.has(k)){ seen.add(k); out.push(c); }
  }
  return out.slice(0,40);
}
