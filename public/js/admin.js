(function(){
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => 'KES ' + Number(n||0).toLocaleString('en-KE');
const dt = s => s ? new Date(s).toLocaleString('en-KE',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
const badge = s => '<span class="badge '+esc(s)+'">'+esc(s)+'</span>';
const err = (id, msg, okId) => { const e=$(id); e.textContent=msg||''; e.style.display=msg?'block':'none'; if(okId) $(okId).hidden=true; };
const ok = (id, msg, errId) => { const e=$(id); e.textContent=msg; e.hidden=false; if(errId) err(errId,''); };
const show = (id, on) => { const el=$(id); if(el) el.hidden=!on; };
let TOKEN = '';
let SESSION = '';
const authH = () => SESSION ? {'X-Session':SESSION} : {'X-Admin-Token':TOKEN};
const authed = () => !!(TOKEN || SESSION);
let refreshTimer;

async function api(path, opts){
  opts=opts||{}; const init={method:opts.method||'GET',headers:authH()};
  if(opts.body!==undefined){init.headers['Content-Type']='application/json';init.body=JSON.stringify(opts.body);}
  const r = await fetch(path, init);
  let d={}; try{d=await r.json();}catch(e){}
  if(!r.ok) throw new Error(d.error||'Request failed ('+r.status+')');
  return d;
}

// ── login ──
async function login(){
  const t = $('tok').value.trim(); if(!t){ err('loginErr','Enter the admin token.'); return; }
  $('loginBtn').disabled=true;
  TOKEN=t; SESSION=''; // must be set BEFORE the check request, api() reads it for the header
  try{ await api('/api/admin/stats'); err('loginErr',''); $('loginWrap').hidden=true; show('appWrap',true); loadAll(); }
  catch(e){ TOKEN=''; err('loginErr', e.message); }
  finally{ $('loginBtn').disabled=false; }
}
// Fingerprint / Face ID: the phone shows its own prompt (face unlock opens the front camera by itself).
async function bioLogin(auto){
  const b=$('bioBtn'); b.disabled=true; err('loginErr',''); show('bioWait',true);
  try{
    const r = await Bio.login('admin');
    SESSION=r.token; TOKEN='';
    try{ localStorage.setItem('bio_admin','1'); }catch(e){}
    await api('/api/admin/stats'); $('loginWrap').hidden=true; show('appWrap',true); loadAll();
  }catch(e){ SESSION=''; if(!auto) err('loginErr', e.message); }
  show('bioWait',false); b.disabled=false;
}
function logout(){ TOKEN=''; SESSION=''; show('appWrap',false); $('loginWrap').hidden=false; $('tok').value=''; $('loginBtn').disabled=false; clearInterval(refreshTimer); }

// ── tabs ──
document.querySelectorAll('.navbtn').forEach(btn => btn.addEventListener('click',()=>{
  document.querySelectorAll('.navbtn').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
  document.querySelectorAll('.tabpanel').forEach(p=>p.hidden=true); $(btn.dataset.tab).hidden=false;
  if(btn.dataset.tab==='tickets') searchTickets().catch(e=>console.error('tickets:',e.message));
  if(btn.dataset.tab==='orders') searchOrders().catch(e=>console.error('orders:',e.message));
  if(btn.dataset.tab==='review') loadReview();
  if(btn.dataset.tab==='promos') loadPromos();
  if(btn.dataset.tab==='events') loadEvents();
  if(btn.dataset.tab==='photos') loadPhotos();
  if(btn.dataset.tab==='referrals') loadReferrals();
  if(btn.dataset.tab==='security') loadBio();
}));

// ── stats ──
async function loadStats(){
  try{
    const d = await api('/api/admin/stats');
    const {orders:o,tickets:t,review:rv,tiers} = d;
    $('stats').innerHTML = [
      {lbl:'Paid orders',val:o.paid,cls:'good'}, {lbl:'Revenue',val:fmt(o.revenue),cls:'good'},
      {lbl:'Tickets issued',val:t.total,cls:''}, {lbl:'At the door (used)',val:t.used,cls:''},
      {lbl:'Pending / processing',val:o.pending,cls:o.pending?'warn':''}, {lbl:'Failed payments',val:o.failed,cls:o.failed?'warn':''},
      {lbl:'Expired',val:o.expired,cls:''}, {lbl:'Discounts given',val:fmt(o.discounts),cls:''},
      rv.stuck?{lbl:'Review: stuck orders',val:rv.stuck,cls:'bad'}:null,
      rv.refunds?{lbl:'Review: refunds due',val:rv.refunds,cls:'bad'}:null,
    ].filter(Boolean).map(s=>'<div class="stat'+' '+s.cls+'"><div class="lbl">'+s.lbl+'</div><div class="val">'+s.val+'</div></div>').join('');

    // tier breakdown
    $('tierCards').innerHTML = tiers.map(t=>'<div class="tier-row">'
      +'<div><b>'+esc(t.event)+' — '+esc(t.name)+'</b><div class="meta">'+esc(t.status)+'</div></div>'
      +'<div style="text-align:right"><div style="font-size:18px;font-weight:700;color:var(--gold2)">'+t.quantity_sold+' / '+t.quantity_total+'</div>'
      +'<div class="meta">'+fmt(t.revenue)+' revenue &middot; KES '+Number(t.price).toLocaleString()+' each</div></div>'
      +'</div>').join('');
  }catch(e){console.error('stats:',e.message);}
}

async function loadAudit(){
  try{
    const rows = await api('/api/admin/audit?limit=50');
    $('auditTbl').querySelector('tbody').innerHTML = rows.map(r=>'<tr><td>'+dt(r.created_at)+'</td><td class="mono">'+esc(r.action)+'</td><td>'+esc(r.resource_type||'')+'</td><td class="mono">'+esc(r.resource_id||'')+'</td></tr>').join('') || '<tr><td colspan="4" class="empty">No actions yet.</td></tr>';
  }catch(e){}
}


// ── live dashboard (refreshes every 10 s while the page is open) ──
const ago = s => { if(!s) return '—'; const m=Math.max(0,Math.round((Date.now()-new Date(s).getTime())/60000)); return m<1?'just now':m<60?m+' min ago':m<1440?Math.floor(m/60)+' h ago':Math.floor(m/1440)+' d ago'; };
async function loadLive(){
  try{
    const d = await api('/api/admin/live');
    const s=d.sales, door=d.door;
    const tile=(l,v,sub,cls)=>'<div class="stat '+(cls||'')+'"><div class="lbl">'+l+'</div><div class="val">'+v+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>';
    const tiers = d.tiers.map(t=>{ const pct=t.quantity_total?Math.min(100,Math.round(t.quantity_sold/t.quantity_total*100)):0;
      return '<div class="lrow"><div class="t"><b>'+esc(t.name)+(t.requires_pool?' <span class="tag review">pool holders only</span>':'')+'</b><span>'+t.quantity_sold+' / '+t.quantity_total+'</span></div>'
        +'<div class="bar2"><i style="width:'+pct+'%"></i></div><div class="m">'+fmt(t.revenue)+' · '+Math.max(0,t.quantity_total-t.quantity_sold)+' left'+(t.status!=='ACTIVE'?' · '+esc(t.status):'')+'</div></div>'; }).join('') || '<div class="empty">No tickets yet.</div>';
    const promos = d.promos.map(p=>{ const exp=p.expires_at&&new Date(p.expires_at)<new Date(); const state=!p.active?'disabled':exp?'expired':'active';
      return '<div class="lrow"><div class="t"><b>'+esc(p.code)+'</b><span>'+(p.kind==='PERCENT'?p.value+'% off':'KES '+p.value+' off')+'</span></div>'
        +'<div class="m">'+p.paid_orders+(p.max_uses?' / '+p.max_uses:'')+' orders · '+p.tickets+' tickets · saved customers '+fmt(p.discount_given)+' · brought in '+fmt(p.revenue)+' · '+state+'</div></div>'; }).join('') || '<div class="empty">No promo codes yet.</div>';
    const recent = d.recent.map(r=>'<div class="lrow"><div class="t"><b>'+esc(r.holder_name)+'</b><span>'+fmt(r.total_amount)+'</span></div>'
        +'<div class="m">'+esc(r.type_name)+' × '+r.quantity+(r.promo_code?' · code '+esc(r.promo_code):'')+' · '+ago(r.paid_at)+'</div></div>').join('') || '<div class="empty">No sales yet.</div>';
    $('liveBody').innerHTML =
      '<div class="lgrid">'
      +tile('Last hour',s.tickets_1h+' tickets',fmt(s.revenue_1h),s.tickets_1h?'good':'')
      +tile('Today',s.tickets_today+' tickets',fmt(s.revenue_today),s.tickets_today?'good':'')
      +tile('All time',fmt(s.revenue_all),s.tickets_all+' tickets sold','good')
      +tile('Paying right now',s.pending_now,s.pending_now?fmt(s.pending_amount)+' waiting':'nobody',s.pending_now?'warn':'')
      +tile('Checked in',door.used+' / '+door.total,'at the door')
      +'</div>'
      +'<div class="lcols"><div><h4>Tickets</h4>'+tiers+'</div><div><h4>Promo codes</h4>'+promos+'</div><div><h4>Latest sales</h4>'+recent+'</div></div>';
    $('liveAt').textContent = 'updated '+new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }catch(e){ $('liveAt').textContent='offline: '+e.message; }
}

// ── orders ──
// Free "send ticket" helper: opens YOUR WhatsApp with a ready message (wa.me link, no API, no cost).
// The buyer opens the site and uses "Find my ticket" with their phone number + order number.
function waLink(r){
  if(r.status!=='PAID') return '';
  const tap = r.link ? location.origin+'/?t='+encodeURIComponent(r.link) : location.origin;
  const msg = 'Hi '+r.holder_name+', your ticket is ready \u{1F39F}\n\nTap to open it: '+tap+'\n\nThen download your QR ticket and show it at the door. If the link does not open, go to '+location.origin+' \u2192 "Already paid? Find my ticket" and use your M-Pesa number ('+r.holder_phone+') with order number '+r.order_number+'.';
  return '<a class="btn sm ghost" target="_blank" rel="noopener" href="https://wa.me/'+encodeURIComponent(r.holder_phone)+'?text='+encodeURIComponent(msg)+'">WhatsApp</a>';
}
async function searchOrders(){
  const q=$('oQ').value.trim(), s=$('oStatus').value;
  const rows = await api('/api/admin/orders?'+(q?'q='+encodeURIComponent(q):'')+(s?'&status='+encodeURIComponent(s):''));
  $('orderTbl').querySelector('tbody').innerHTML = rows.map(r=>'<tr>'
    +'<td class="mono">'+esc(r.order_number)+'</td><td>'+esc(r.holder_name)+'<br><span style="color:var(--mut);font-size:11px">'+esc(r.holder_email)+'</span></td>'
    +'<td class="mono">'+esc(r.holder_phone)+'</td><td>'+esc(r.type_name)+'</td><td>'+esc(r.quantity)+'</td>'
    +'<td>'+fmt(r.total_amount)+(r.discount_amount>0?'<br><span style="color:var(--good);font-size:10px">−'+fmt(r.discount_amount)+'</span>':'')+'</td>'
    +'<td>'+badge(r.status)+'</td><td>'+dt(r.paid_at)+'</td><td class="mono">'+esc(r.mpesa_receipt||'—')+'</td>'
    +'<td>'+waLink(r)+'</td></tr>'
  ).join('') || '<tr><td colspan="10" class="empty">No orders.</td></tr>';
}

async function dlCsv(path, name){
  try{
    const r = await fetch(path,{headers:authH()});
    if(!r.ok){ let d={}; try{d=await r.json();}catch(e){} throw new Error(d.error||'Export failed ('+r.status+')'); }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },1500);
  }catch(e){ alert(e.message); }
}
function dlOrders(){ return dlCsv('/api/admin/export/orders.csv','orders.csv'); }
function dlAttendees(){ return dlCsv('/api/admin/export/attendees.csv','attendees.csv'); }

// ── tickets ──
async function searchTickets(){
  const q=$('tkQ').value.trim();
  const rows = await api('/api/admin/tickets?'+(q?'q='+encodeURIComponent(q):''));
  $('ticketTbl').querySelector('tbody').innerHTML = rows.map(r=>'<tr>'
    +'<td class="mono">'+esc(r.ticket_number)+'</td><td>'+esc(r.holder_name)+'<br><span style="color:var(--mut);font-size:11px">'+esc(r.holder_phone)+'</span></td>'
    +'<td>'+esc(r.type_name)+'</td><td>'+badge(r.status)+'</td><td>'+dt(r.issued_at)+'</td><td>'+dt(r.used_at)+'</td>'
    +'<td class="mono">'+esc(r.order_number)+'</td>'
    +'<td><div class="actions">'
      +(r.status!=='VALID'?'<button class="btn sm ghost" data-act="unvoid:'+esc(r.ticket_number)+'">Restore</button>':'')
      +(r.status!=='CANCELLED'?'<button class="btn sm danger" data-act="cancel:'+esc(r.ticket_number)+'">Cancel</button>':'')
      +'<button class="btn sm ghost" data-act="ri:'+esc(r.ticket_number)+'">Reissue QR</button>'
      +'</div></td></tr>'
  ).join('') || '<tr><td colspan="8" class="empty">No tickets.</td></tr>';
}

async function setTicketStatus(tn, status){
  try{ await api('/api/admin/tickets/'+encodeURIComponent(tn)+'/status',{method:'POST',body:{status}}); searchTickets(); }
  catch(e){ alert(e.message); }
}
async function reissueQR(tn){ try{ const r=await api('/api/admin/tickets/'+encodeURIComponent(tn)+'/reissue',{method:'POST'}); alert('Reissued. New QR is for ticket '+tn+'. Customer can retrieve it via "Find my ticket".'); }catch(e){alert(e.message);} }

// ── review ──
async function loadReview(){
  try{
    const d = await api('/api/admin/review');
    const tbl = (id,rows,cols) => { $(id).querySelector('tbody').innerHTML = rows.length ? rows.map(r=>'<tr>'+cols.map(c=>'<td class="'+((c.cls||'')+' '+(c.mono?'mono':'')).trim()+'">'+(c.fmt?c.fmt(r[c.key]):esc(r[c.key]??'—'))+'</td>').join('')+'</tr>').join('') : '<tr><td colspan="'+cols.length+'" class="empty">None — all clear.</td></tr>'; };
    tbl('stuckTbl',d.stuck,[{key:'order_number',mono:true},{key:'holder_name'},{key:'holder_phone',mono:true},{key:'total_amount',fmt:fmt},{key:'payment_started_at',fmt:dt},{key:'created_at',fmt:dt}]);
    tbl('refundTbl',d.refunds,[{key:'order_number',mono:true},{key:'holder_name'},{key:'holder_phone',mono:true},{key:'total_amount',fmt:fmt},{key:'mpesa_receipt',mono:true},{key:'paid_at',fmt:dt}]);
    tbl('dupTbl',d.duplicates,[{key:'order_number',mono:true},{key:'holder_name'},{key:'holder_phone',mono:true},{key:'amount',fmt:fmt},{key:'tinypesa_transaction_id',mono:true},{key:'created_at',fmt:dt}]);
    tbl('hookTbl',d.webhookProblems,[{key:'external_ref',mono:true},{key:'tiny_pesa_id',mono:true},{key:'amount',fmt:fmt},{key:'outcome',fmt:v=>'<span class="tag review">'+esc(v||'')+'</span>'},{key:'error'},{key:'received_at',fmt:dt}]);
  }catch(e){console.error('review:',e.message);}
}

// ── promos ──
async function createPromo(){
  err('promoErr','');
  const code=$('pcCode').value.trim().toUpperCase(), kind=$('pcKind').value, val=$('pcVal').value, maxU=$('pcMax').value, exp=$('pcExp').value, evId=$('pcEvent').value;
  try{
    await api('/api/admin/promos',{method:'POST',body:{code,kind,value:+val,maxUses:maxU||undefined,expiresAt:exp?(exp.length===16?exp+':00':exp)+'+03:00':undefined,eventId:evId||undefined}});
    $('pcCode').value=''; $('pcVal').value=''; $('pcMax').value=''; loadPromos();
  }catch(e){ err('promoErr',e.message); }
}
async function loadPromos(){
  try{
    const rows = await api('/api/admin/promos');
    $('promoList').innerHTML = rows.length ? rows.map(r=>'<div class="tier-row">'
      +'<div><b>'+esc(r.code)+'</b> <span style="font-size:11px;color:var(--mut)">'+(r.kind==='PERCENT'?r.value+'% off':'KES '+r.value+' off')+'</span>'
      +(r.expires_at?'<div class="meta">Expires '+dt(r.expires_at)+'</div>':'')+'</div>'
      +'<div style="text-align:right"><div style="font-size:12px;color:var(--mut)">'+r.used_count+(r.max_uses?' / '+r.max_uses:'')+ ' uses</div>'
      +'<button class="btn sm '+(r.active?'danger':'ghost')+'" data-act="togglePromo:'+r.id+'">'+(r.active?'Disable':'Enable')+'</button></div>'
      +'</div>').join('') : '<div class="empty">No promo codes yet.</div>';
  }catch(e){}
}
async function togglePromo(id){ try{ await api('/api/admin/promos/'+id+'/toggle',{method:'POST'}); loadPromos(); }catch(e){alert(e.message);} }

// ── events ──
async function createEvent(){
  err('evErr','');
  const name=$('evName').value.trim(),venue=$('evVenue').value.trim(),date=$('evDate').value,time=$('evTime').value,desc=$('evDesc').value.trim();
  try{ await api('/api/admin/events',{method:'POST',body:{name,venue,date,time,description:desc}}); $('evName').value=''; $('evDesc').value=''; loadEvents(); }
  catch(e){ err('evErr',e.message); }
}
async function createType(){
  err('ttErr','');
  try{ await api('/api/admin/ticket-types',{method:'POST',body:{eventId:+$('ttEvent').value,name:$('ttName').value.trim(),description:$('ttDesc').value.trim(),price:+$('ttPrice').value,quantity:+$('ttQty').value}}); $('ttName').value='';$('ttDesc').value='';$('ttPrice').value='';$('ttQty').value=''; loadEvents(); }
  catch(e){ err('ttErr',e.message); }
}
async function loadEvents(){
  try{
    const evs = await api('/api/admin/events');
    const f=(id,label,val,extra)=>'<div><label for="'+id+'">'+label+'</label><input id="'+id+'" '+(extra||'')+' value="'+esc(val)+'"></div>';
    $('eventList').innerHTML = evs.map(e=>'<div class="section" style="margin-bottom:12px">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">'
      +'<div><b>'+esc(e.name)+'</b> <span style="font-size:11px;color:var(--mut)">ID '+esc(e.id)+' · '+esc(e.status)+'</span></div>'
      +'<button class="btn sm '+(e.status==='ACTIVE'?'danger':'ghost')+'" data-act="toggleEvent:'+e.id+':'+(e.status==='ACTIVE'?'HIDDEN':'ACTIVE')+'">'+(e.status==='ACTIVE'?'Hide event':'Unhide event')+'</button></div>'
      +'<h3 style="margin:14px 0 0;font-size:12px">Event details <small>changes show on the site within a minute</small></h3>'
      +'<div class="row">'+f('en'+e.id,'Name',e.name,'maxlength="120"')+f('ed'+e.id,'Tagline',e.description||'','maxlength="300"')+'</div>'
      +'<div class="row">'+f('ev'+e.id,'Venue',e.venue,'maxlength="160"')+f('edt'+e.id,'Date',e.event_date,'type="date"')+f('etm'+e.id,'Start time',e.event_time,'type="time"')+'</div>'
      +'<div class="err" id="eErr'+e.id+'"></div><div class="ok" id="eOk'+e.id+'" hidden></div>'
      +'<button class="btn sm" style="margin-top:10px" data-act="saveEvent:'+e.id+'">Save event details</button>'
      +'<h3 style="margin:18px 0 6px;font-size:12px">Ticket order <small>drag &#10303; to rearrange (top shows first). Long-press a ticket to delete it</small></h3>'
      +'<div class="ord" data-event="'+e.id+'">'+e.ticketTypes.map(t=>'<div class="ord-i" data-tid="'+t.id+'"><span class="grip" aria-label="Drag to reorder">&#10303;</span><span class="nm">'+esc(t.name)+'</span><span class="pr">KES '+Number(t.price).toLocaleString()+(t.status!=='ACTIVE'?' · hidden':'')+'</span></div>').join('')+'</div>'
      +'<div class="ok" id="oOk'+e.id+'" hidden></div><div class="err" id="oErr'+e.id+'"></div>'
      +'<h3 style="margin:18px 0 6px;font-size:12px">Tickets &amp; prices <small>new price applies to new orders; unpaid orders keep the price they started with</small></h3>'
      +(e.ticketTypes.length?e.ticketTypes.map(t=>'<div class="tier-row" style="display:block;margin-bottom:8px">'
        +'<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><b>'+esc(t.name)+'</b><span class="meta">'+t.quantity_sold+' sold · '+esc(t.status)+' · ID '+t.id+'</span></div>'
        +'<div class="row">'+f('tn'+t.id,'Name',t.name,'maxlength="80"')+f('td'+t.id,'Description',t.description||'','maxlength="160"')+'</div>'
        +'<div class="row">'+f('tp'+t.id,'Price (KES)',t.price,'type="number" min="1"')+f('tq'+t.id,'Total tickets',t.quantity_total,'type="number" min="'+t.quantity_sold+'"')+'</div>'
        +'<label class="toggle"><input type="checkbox" id="tr'+t.id+'"'+(t.requires_pool?' checked':'')+'> Only people who bought a pool party ticket can buy this (after party)</label>'
        +'<div class="err" id="tErr'+t.id+'"></div><div class="ok" id="tOk'+t.id+'" hidden></div>'
        +'<div class="actions" style="margin-top:10px"><button class="btn sm" data-act="saveType:'+t.id+'">Save ticket</button>'
        +'<button class="btn sm ghost" data-act="toggleType:'+t.id+':'+(t.status==='ACTIVE'?'HIDDEN':'ACTIVE')+'">'+(t.status==='ACTIVE'?'Hide':'Show')+'</button></div></div>').join(''):'<div class="empty">No ticket types yet.</div>')
      +'</div>').join('') || '<div class="empty">No events.</div>';
    document.querySelectorAll('.ord[data-event]').forEach(box=>initSort(box, async ids=>{
      const id=box.dataset.event; err('oErr'+id,''); $('oOk'+id).hidden=true;
      try{ await api('/api/admin/ticket-types/reorder',{method:'POST',body:{ids}}); ok('oOk'+id,'Order saved. The site shows it on the next refresh.'); }
      catch(e){ err('oErr'+id,e.message); loadEvents(); }
    }));
    document.querySelectorAll('.ord[data-event]').forEach(initLongPress);
  }catch(e){}
}

// Long-press (about 0.6 s) on a ticket row to delete it. Moving the finger, dragging the handle or letting go early cancels.
function initLongPress(box){
  let tm=null,x0=0,y0=0,el=null;
  const stop=()=>{ clearTimeout(tm); tm=null; if(el){ el.classList.remove('lp'); el=null; } };
  box.addEventListener('pointerdown',e=>{
    if(e.target.closest('.grip')) return;
    const it=e.target.closest('.ord-i'); if(!it) return;
    el=it; x0=e.clientX; y0=e.clientY; it.classList.add('lp');
    tm=setTimeout(()=>{ const t=it; stop(); if(navigator.vibrate) navigator.vibrate(40); delTicketType(t.dataset.tid,t.querySelector('.nm').textContent); },650);
  });
  box.addEventListener('pointermove',e=>{ if(tm && Math.hypot(e.clientX-x0,e.clientY-y0)>10) stop(); });
  ['pointerup','pointercancel','pointerleave'].forEach(ev=>box.addEventListener(ev,stop));
  box.addEventListener('contextmenu',e=>e.preventDefault());
}
async function delTicketType(id,name){
  if(!confirm('Delete "'+name+'"?\n\nIf nobody has bought it yet, it is removed completely. If it has sales, it is taken off the site and out of this list, but the orders and money records are kept.')) return;
  try{ await api('/api/admin/ticket-types/'+id+'/delete',{method:'POST'}); loadEvents(); loadLive(); }
  catch(e){ alert(e.message); }
}

// Drag-to-reorder that works with a finger or a mouse. The dragged row follows the pointer; the gold line shows where it will land.
function initSort(box, save){
  let d=null;
  const clear=()=>box.querySelectorAll('.ord-i').forEach(x=>x.classList.remove('before','after'));
  box.addEventListener('pointerdown',e=>{
    const g=e.target.closest('.grip'); if(!g) return; e.preventDefault();
    d={item:g.closest('.ord-i'),y0:e.pageY,target:null,moved:false};
    d.item.classList.add('drag');
    try{ g.setPointerCapture(e.pointerId); }catch(_){}
  });
  box.addEventListener('pointermove',e=>{
    if(!d) return; d.moved=true;
    d.item.style.transform='translateY('+(e.pageY-d.y0)+'px)';
    if(e.clientY<90) window.scrollBy(0,-10); else if(e.clientY>window.innerHeight-90) window.scrollBy(0,10);
    clear(); d.target=null;
    const others=[...box.querySelectorAll('.ord-i')].filter(x=>x!==d.item);
    for(const it of others){ const r=it.getBoundingClientRect(); if(e.clientY<r.top+r.height/2){ d.target=it; it.classList.add('before'); return; } }
    if(others.length) others[others.length-1].classList.add('after');
  });
  const end=async()=>{
    if(!d) return; const {item,target,moved}=d; d=null;
    item.classList.remove('drag'); item.style.transform=''; clear();
    if(!moved) return;
    if(target) box.insertBefore(item,target); else box.appendChild(item);
    await save([...box.querySelectorAll('.ord-i')].map(x=>+x.dataset.tid));
  };
  box.addEventListener('pointerup',end); box.addEventListener('pointercancel',end);
}
async function saveEvent(id){
  err('eErr'+id,''); $('eOk'+id).hidden=true;
  try{
    await api('/api/admin/events/'+id+'/update',{method:'POST',body:{name:$('en'+id).value,description:$('ed'+id).value,venue:$('ev'+id).value,date:$('edt'+id).value,time:$('etm'+id).value}});
    ok('eOk'+id,'Saved. The site shows the new date and countdown within a minute.');
  }catch(e){ err('eErr'+id,e.message); }
}
async function saveType(id){
  err('tErr'+id,''); $('tOk'+id).hidden=true;
  try{
    await api('/api/admin/ticket-types/'+id+'/update',{method:'POST',body:{name:$('tn'+id).value,description:$('td'+id).value,price:+$('tp'+id).value,quantityTotal:+$('tq'+id).value,requiresPool:$('tr'+id).checked}});
    ok('tOk'+id,'Saved. New price applies to new orders.');
  }catch(e){ err('tErr'+id,e.message); }
}
async function toggleEvent(id, status){ try{ await api('/api/admin/events/'+id+'/status',{method:'POST',body:{status}}); loadEvents(); }catch(e){alert(e.message);} }
async function toggleType(id, status){ try{ await api('/api/admin/ticket-types/'+id+'/update',{method:'POST',body:{status}}); loadEvents(); }catch(e){alert(e.message);} }

// ── gallery photos ──
let phSorter=false;
async function loadPhotos(){
  try{
    const rows = await api('/api/admin/gallery');
    const box=$('phList');
    box.innerHTML = rows.map(p=>'<div class="ord-i ph-i" data-tid="'+p.id+'"><span class="grip" aria-label="Drag to reorder">&#10303;</span>'
      +'<img src="/api/gallery/'+p.id+'/img" alt="" loading="lazy"><span class="nm" style="font-size:12px;font-weight:400;color:var(--mut)">'+Math.round(p.bytes/1024)+' KB</span>'
      +'<button class="btn sm danger" data-act="delPhoto:'+p.id+'">Delete</button></div>').join('') || '<div class="empty">No photos yet. Tap "Add photos".</div>';
    if(!phSorter){ phSorter=true; initSort(box, async ids=>{ err('phErr',''); try{ await api('/api/admin/gallery/reorder',{method:'POST',body:{ids}}); ok('phOk','Order saved.'); }catch(e){ err('phErr',e.message); loadPhotos(); } }); }
  }catch(e){ err('phErr',e.message); }
}
// Shrink to max 1000px wide/tall and re-encode as JPEG, so a 5 MB phone photo becomes ~150 KB.
function shrink(file){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file), img=new Image();
    img.onload=()=>{
      const sc=Math.min(1,1000/Math.max(img.width,img.height)), w=Math.round(img.width*sc), h=Math.round(img.height*sc);
      const c=document.createElement('canvas'); c.width=w; c.height=h;
      const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,w,h); x.drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url);
      c.toBlob(b=>b?resolve(b):reject(new Error('Could not process '+file.name)),'image/jpeg',0.8);
    };
    img.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error(file.name+' is not a photo this browser can open.')); };
    img.src=url;
  });
}
async function uploadPhotos(files){
  err('phErr',''); $('phOk').hidden=true;
  const btn=$('phBtn'); btn.disabled=true; let done=0;
  try{
    for(const f of files){
      btn.textContent='Uploading '+(done+1)+' of '+files.length+'…';
      const blob=await shrink(f);
      const r=await fetch('/api/admin/gallery',{method:'POST',headers:Object.assign({'Content-Type':'image/jpeg'},authH()),body:blob});
      let d={}; try{d=await r.json();}catch(e){}
      if(!r.ok) throw new Error(d.error||'Upload failed ('+r.status+')');
      done++;
    }
    ok('phOk',done+' photo'+(done===1?'':'s')+' added. They show on the site right away.');
  }catch(e){ err('phErr',(done?done+' added, then: ':'')+e.message); }
  btn.disabled=false; btn.textContent='+ Add photos'; $('phFile').value=''; loadPhotos();
}
$('phFile').addEventListener('change',e=>{ const f=[...e.target.files]; if(f.length) uploadPhotos(f); });
async function delPhoto(id){ if(!confirm('Delete this photo from the site?')) return; try{ await api('/api/admin/gallery/'+id+'/delete',{method:'POST'}); loadPhotos(); }catch(e){ err('phErr',e.message); } }

// ── manual ──
async function manualConfirm(){
  err('mErr',''); $('mOk').hidden=true;
  try{
    const r=await api('/api/admin/orders/'+encodeURIComponent($('mOrder').value.trim().toUpperCase())+'/confirm',{method:'POST',body:{receipt:$('mReceipt').value.trim().toUpperCase(),note:$('mNote').value.trim()}});
    ok('mOk','Outcome: '+r.outcome+(r.tickets?' — '+r.tickets.length+' ticket(s) issued: '+r.tickets.join(', '):''),'mErr');
    $('mOrder').value=''; $('mReceipt').value=''; loadStats();
  }catch(e){ err('mErr',e.message,'mOk'); }
}
async function reissue(){
  err('riErr',''); $('riOk').hidden=true;
  try{
    const r=await api('/api/admin/tickets/'+encodeURIComponent($('riTicket').value.trim().toUpperCase())+'/reissue',{method:'POST'});
    ok('riOk','Reissued. '+r.note,'riErr'); $('riTicket').value='';
  }catch(e){ err('riErr',e.message,'riOk'); }
}

// ── referrals ──
const refLine = r => {
  const t=r.target;
  return r.singles+' / '+t.singles+' singles · '+r.couples+' / '+t.couples+' couple'+(t.couples===1?'':'s');
};
async function loadReferrals(){
  err('rfErr','');
  try{
    const q=$('rfQ').value.trim();
    const d = await api('/api/admin/referrals'+(q?'?q='+encodeURIComponent(q):''));
    const sm=d.summary;
    $('rfRules').textContent = d.tiers.map(t=>t.singles+' singles + '+t.couples+' couple'+(t.couples===1?'':'s')+' = '+t.free+' free').join(' · ');
    const tile=(l,v,sub,cls)=>'<div class="stat '+(cls||'')+'"><div class="lbl">'+l+'</div><div class="val">'+v+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>';
    $('rfStats').innerHTML = tile('Referrers',sm.referrers,sm.active+' with sales')+tile('Tickets brought in',sm.tickets,'via referral codes','good')
      +tile('Free tickets earned',sm.earned,sm.issued+' given out')+tile('Waiting to give',sm.waiting,sm.waiting?'tap Give free ticket':'all clear',sm.waiting?'warn':'');
    $('rfList').innerHTML = d.rows.map(r=>{
      const nxt = r.next ? 'Next reward: '+r.next.free+' free ticket'+(r.next.free===1?'':'s')+' at '+r.next.singles+' singles + '+r.next.couples+' couple'+(r.next.couples===1?'':'s') : 'Every reward reached';
      return '<div class="tier-row" style="display:block;margin-bottom:9px">'
        +'<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div><b>'+esc(r.name)+'</b> <span class="mono">'+esc(r.code)+'</span><div class="meta">'+esc(r.phone)+'</div></div>'
        +'<div style="text-align:right"><b style="font-size:18px">'+r.people+'</b> <span class="meta">friend'+(r.people===1?'':'s')+' used it</span><div class="meta">'+refLine(r)+'</div></div></div>'
        +'<div class="bar2" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+r.pct+'"><i style="width:'+r.pct+'%"></i></div>'
        +'<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;margin-top:7px">'
        +'<span class="meta">'+nxt+' · '+r.pct+'% · earned '+r.earned+' · given '+r.issued+'</span>'
        +(r.available>0?'<button class="btn sm" data-act="giveReward:'+esc(r.code)+'">Give free ticket ('+r.available+' waiting)</button>':'')
        +'</div></div>';
    }).join('') || '<div class="empty">No referral codes yet. They appear once customers have a paid order.</div>';
  }catch(e){ err('rfErr',e.message); }
}
async function giveReward(code){
  if(!confirm('Give 1 free ticket for referral code '+code+'?\n\nIt is taken from your ticket stock.')) return;
  err('rfErr',''); $('rfOk').hidden=true;
  try{
    const r = await api('/api/admin/referrals/'+encodeURIComponent(code)+'/reward',{method:'POST'});
    const tap = location.origin+'/?t='+encodeURIComponent(r.link);
    const msg = 'Hi '+r.name+', thank you for bringing your friends! \u{1F381} Your free ticket is ready: '+tap;
    const o=$('rfOk'); o.hidden=false;
    o.innerHTML = 'Free '+esc(r.type)+' ticket '+esc(r.ticketNumber)+' created for '+esc(r.name)+'. It already shows on their ticket screen. '
      +'<a target="_blank" rel="noopener" href="https://wa.me/'+encodeURIComponent(r.phone)+'?text='+encodeURIComponent(msg)+'">Tell them on WhatsApp</a>';
    loadReferrals(); loadStats();
  }catch(e){ err('rfErr',e.message); }
}

// ── fingerprint / Face ID ──
async function loadBio(){
  const can = window.Bio ? await Bio.supported() : false;
  $('bioSupport').textContent = can ? '\u2705 This phone supports fingerprint / Face ID.' : '\u26A0 This browser can\'t use fingerprint / Face ID here. It needs a phone or laptop with a fingerprint, Face ID or screen lock set up, and the https address of the site.';
  $('bioEnrollBtn').disabled = !can;
  try{
    const rows = await api('/api/admin/biometric');
    $('bioList').innerHTML = rows.map(r=>'<div class="tier-row"><div><b>'+esc(r.label)+'</b><div class="meta">'+(r.scope==='admin'?'Admin panel + door scanner':'Door scanner only')+' · added '+dt(r.created_at)+' · last used '+(r.last_used_at?ago(r.last_used_at):'never')+'</div></div>'
      +'<button class="btn sm danger" data-act="bioRevoke:'+r.id+'">Remove</button></div>').join('') || '<div class="empty">Nobody enrolled yet.</div>';
  }catch(e){ $('bioList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'; }
}
async function bioEnroll(){
  err('bioErr','',  'bioOk'); const label=$('bioLabel').value.trim(); const scope=$('bioScope').value;
  const b=$('bioEnrollBtn'); b.disabled=true;
  try{
    await Bio.enrollAdmin(label, scope, authH());
    try{ localStorage.setItem('bio_admin','1'); localStorage.setItem('bio_door','1'); }catch(e){}
    ok('bioOk','Done. Next time, open this page and use your fingerprint / Face ID.','bioErr'); $('bioLabel').value=''; loadBio();
  }catch(e){ err('bioErr',e.message,'bioOk'); }
  b.disabled=false;
}
async function bioInvite(){
  err('invErr',''); $('invOut').hidden=true;
  try{
    const r = await api('/api/admin/biometric/invite',{method:'POST',body:{label:$('invLabel').value.trim(),scope:$('invScope').value}});
    $('invOut').hidden=false; $('invLink').value=r.link;
    $('invWa').href='https://wa.me/?text='+encodeURIComponent('Hi '+r.label+', open this on YOUR phone to set up fingerprint / Face ID for the door scanner (valid '+r.minutes+' min): '+r.link);
    const cv=$('invQr'), c=cv.getContext('2d'); c.fillStyle='#fff'; c.fillRect(0,0,cv.width,cv.height);
    if(typeof qrcode==='function'){ const q=qrcode(0,'M'); q.addData(r.link); q.make(); const n=q.getModuleCount(), cell=Math.floor(cv.width/(n+4)), off=Math.floor((cv.width-cell*n)/2); c.fillStyle='#000'; for(let y=0;y<n;y++)for(let x=0;x<n;x++) if(q.isDark(y,x)) c.fillRect(off+x*cell,off+y*cell,cell,cell); }
  }catch(e){ err('invErr',e.message); }
}
async function bioRevoke(id){
  if(!confirm('Remove this phone? It will no longer unlock the panel or the scanner.')) return;
  try{ await api('/api/admin/biometric/'+id+'/revoke',{method:'POST'}); loadBio(); }catch(e){ alert(e.message); }
}
function invCopy(){ const i=$('invLink'); i.select(); try{ navigator.clipboard.writeText(i.value); }catch(e){ document.execCommand('copy'); } }

// ── global click ──
const acts={
  login, logout, bioLogin:()=>bioLogin(false), loadReferrals, bioEnroll, bioInvite, invCopy, pickPhotos:()=>$('phFile').click(), searchOrders, dlOrders, dlAttendees, searchTickets,
  createPromo, createEvent, createType, manualConfirm, reissue, loadReview,
};
document.addEventListener('click', e=>{
  const el=e.target.closest('[data-act]'); if(!el||el.disabled) return;
  if(el.tagName==='A') e.preventDefault();
  const [fn,...args]=el.getAttribute('data-act').split(':');
  if(fn==='togglePromo') togglePromo(args[0]);
  else if(fn==='toggleEvent') toggleEvent(args[0],args[1]);
  else if(fn==='toggleType') toggleType(args[0],args[1]);
  else if(fn==='saveEvent') saveEvent(args[0]);
  else if(fn==='saveType') saveType(args[0]);
  else if(fn==='delPhoto') delPhoto(args[0]);
  else if(fn==='giveReward') giveReward(args[0]);
  else if(fn==='bioRevoke') bioRevoke(args[0]);
  else if(fn==='cancel') setTicketStatus(args[0],'CANCELLED');
  else if(fn==='unvoid') setTicketStatus(args[0],'VALID');
  else if(fn==='ri') reissueQR(args[0]);
  else if(acts[fn]) acts[fn]();
});
[$('oQ'),$('tkQ')].forEach(inp=>inp&&inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.target.id==='oQ'?searchOrders():searchTickets();}}));
$('tok').addEventListener('keydown', e=>{ if(e.key==='Enter') login(); });
$('rfQ').addEventListener('keydown', e=>{ if(e.key==='Enter') loadReferrals(); });

// Show the fingerprint / Face ID button when the phone can do it; if this phone was enrolled before, ask straight away.
(async()=>{
  if(!window.Bio || !(await Bio.supported())) return;
  $('bioBox').hidden=false;
  let was=false; try{ was=localStorage.getItem('bio_admin')==='1'; }catch(e){}
  if(was) bioLogin(true);
})();

async function loadAll(){
  loadLive();
  await loadStats();
  await loadAudit();
  searchOrders();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(()=>{ if(!document.hidden) loadLive(); }, 10000);
  setInterval(()=>{ if(!document.hidden && authed()){ loadStats(); loadAudit(); } }, 30000);
}

})();
