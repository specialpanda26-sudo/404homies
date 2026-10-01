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
let refreshTimer;

async function api(path, opts){
  opts=opts||{}; const init={method:opts.method||'GET',headers:{'X-Admin-Token':TOKEN}};
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
  TOKEN=t; // must be set BEFORE the check request, api() reads it for the header
  try{ await api('/api/admin/stats'); err('loginErr',''); $('loginWrap').hidden=true; show('appWrap',true); loadAll(); }
  catch(e){ TOKEN=''; err('loginErr', e.message); }
  finally{ $('loginBtn').disabled=false; }
}
function logout(){ TOKEN=''; show('appWrap',false); $('loginWrap').hidden=false; $('tok').value=''; $('loginBtn').disabled=false; clearInterval(refreshTimer); }

// ── tabs ──
document.querySelectorAll('.navbtn').forEach(btn => btn.addEventListener('click',()=>{
  document.querySelectorAll('.navbtn').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
  document.querySelectorAll('.tabpanel').forEach(p=>p.hidden=true); $(btn.dataset.tab).hidden=false;
  if(btn.dataset.tab==='tickets') searchTickets().catch(e=>console.error('tickets:',e.message));
  if(btn.dataset.tab==='orders') searchOrders().catch(e=>console.error('orders:',e.message));
  if(btn.dataset.tab==='review') loadReview();
  if(btn.dataset.tab==='promos') loadPromos();
  if(btn.dataset.tab==='events') loadEvents();
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
    const r = await fetch(path,{headers:{'X-Admin-Token':TOKEN}});
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
      +'<h3 style="margin:18px 0 6px;font-size:12px">Tickets &amp; prices <small>new price applies to new orders; unpaid orders keep the price they started with</small></h3>'
      +(e.ticketTypes.length?e.ticketTypes.map(t=>'<div class="tier-row" style="display:block;margin-bottom:8px">'
        +'<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><b>'+esc(t.name)+'</b><span class="meta">'+t.quantity_sold+' sold · '+esc(t.status)+' · ID '+t.id+'</span></div>'
        +'<div class="row">'+f('tn'+t.id,'Name',t.name,'maxlength="80"')+f('td'+t.id,'Description',t.description||'','maxlength="160"')+'</div>'
        +'<div class="row">'+f('tp'+t.id,'Price (KES)',t.price,'type="number" min="1"')+f('tq'+t.id,'Total tickets',t.quantity_total,'type="number" min="'+t.quantity_sold+'"')+'</div>'
        +'<div class="err" id="tErr'+t.id+'"></div><div class="ok" id="tOk'+t.id+'" hidden></div>'
        +'<div class="actions" style="margin-top:10px"><button class="btn sm" data-act="saveType:'+t.id+'">Save ticket</button>'
        +'<button class="btn sm ghost" data-act="toggleType:'+t.id+':'+(t.status==='ACTIVE'?'HIDDEN':'ACTIVE')+'">'+(t.status==='ACTIVE'?'Hide':'Show')+'</button></div></div>').join(''):'<div class="empty">No ticket types yet.</div>')
      +'</div>').join('') || '<div class="empty">No events.</div>';
  }catch(e){}
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
    await api('/api/admin/ticket-types/'+id+'/update',{method:'POST',body:{name:$('tn'+id).value,description:$('td'+id).value,price:+$('tp'+id).value,quantityTotal:+$('tq'+id).value}});
    ok('tOk'+id,'Saved. New price applies to new orders.');
  }catch(e){ err('tErr'+id,e.message); }
}
async function toggleEvent(id, status){ try{ await api('/api/admin/events/'+id+'/status',{method:'POST',body:{status}}); loadEvents(); }catch(e){alert(e.message);} }
async function toggleType(id, status){ try{ await api('/api/admin/ticket-types/'+id+'/update',{method:'POST',body:{status}}); loadEvents(); }catch(e){alert(e.message);} }

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

// ── global click ──
const acts={
  login, logout, searchOrders, dlOrders, dlAttendees, searchTickets,
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
  else if(fn==='cancel') setTicketStatus(args[0],'CANCELLED');
  else if(fn==='unvoid') setTicketStatus(args[0],'VALID');
  else if(fn==='ri') reissueQR(args[0]);
  else if(acts[fn]) acts[fn]();
});
[$('oQ'),$('tkQ')].forEach(inp=>inp&&inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.target.id==='oQ'?searchOrders():searchTickets();}}));
$('tok').addEventListener('keydown', e=>{ if(e.key==='Enter') login(); });

async function loadAll(){
  await loadStats();
  await loadAudit();
  searchOrders();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(()=>{ if(!document.hidden){ loadStats(); loadAudit(); } }, 30000);
}

})();
