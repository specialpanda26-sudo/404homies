/* 404 Error Pool Party — customer site.
 * Flow: pick tickets → create order → M-Pesa prompt → poll status → real QR ticket.
 * A ticket is only shown once the SERVER says the order is PAID (webhook-confirmed).
 * Date, venue, prices and stock all come from the database (edit them in /admin). */
(function () {
  'use strict';

  /* Branding that lives on the ticket artwork (everything else comes from the database). */
  const BRAND = { host: '404homies', script: 'Pool Party', perk: 'Free drinks' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => 'KES ' + Number(n).toLocaleString('en-US');
  const show = (el, on) => { if (typeof el === 'string') el = $(el); if (el) el.hidden = !on; };
  const setErr = (id, msg) => { const el = $(id); el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET', headers: Object.assign({}, opts.headers) };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    let r;
    try { r = await fetch(path, init); } catch (e) {
      const err = new Error("Can't reach the server. Check your connection and try again."); err.network = true; throw err;
    }
    let d = {};
    try { d = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok) { const err = new Error(d.error || 'Something went wrong. Please try again.'); err.status = r.status; err.data = d; throw err; }
    return d;
  }

  const S = {
    pass: null, verifying: false, cfg: {}, events: [], ev: null, tierId: null, qty: 1, promo: null,
    ready: false, findMode: false, showFind: false, order: null, sig: '', tickets: [],
    poll: null, pollStart: 0, cdLeft: 0, cdTimer: null, clock: null, tiersSig: '',
  };
  const tier = () => (S.ev ? S.ev.ticketTypes.find((t) => String(t.id) === String(S.tierId)) : null);
  const names = () => Array.from(document.querySelectorAll('.attIn')).map((i) => i.value.trim());

  /* ───────── formatting ───────── */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function parts(date) { const p = String(date).split('-'); return { y: +p[0], m: +p[1], d: +p[2], dow: new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)).getUTCDay() }; }
  function fmtTime(time) { const t = String(time).split(':'); let h = +t[0]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + (t[1] && t[1] !== '00' ? ':' + t[1] : '') + ' ' + ap; }
  function fmtWhen(date, time, late) { const p = parts(date); return DAY[p.dow] + ' ' + p.d + ' ' + MON[p.m - 1] + ' \u00b7 ' + fmtTime(time) + (late ? ' \u2013 late' : ''); }
  const pad2 = (n) => String(n).padStart(2, '0');
  const dotDate = (date) => { const p = parts(date); return pad2(p.d) + '.' + pad2(p.m) + '.' + p.y; };
  const startMs = (date, time) => new Date(date + 'T' + time + ':00+03:00').getTime(); // Kenya is UTC+3, no daylight saving
  const phoneOk = (v) => { const d = String(v).replace(/\D/g, ''); return (d.length === 9 && /^[71]/.test(d)) || (d.length === 10 && /^0[71]/.test(d)) || (d.length === 12 && /^254[71]/.test(d)); };
  const phone9 = (v) => { const d = String(v).replace(/\D/g, ''); return d.length === 12 ? d.slice(3) : d.length === 10 ? d.slice(1) : d; };

  function toast(msg) {
    const old = document.querySelector('.toast'); if (old) old.remove();
    const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3800);
  }

  /* ───────── navigation (steps stay locked until the earlier step is done) ───────── */
  function unlocked(n) { return n === 1 || (n === 2 && S.ready) || (n === 3 && (S.tickets.length > 0 || S.findMode)); }
  function updateTabs() {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-disabled', String(!unlocked(+t.dataset.s))));
  }
  function go(n) {
    if (!unlocked(n)) {
      toast(n === 2 ? 'Choose your ticket and enter your name first.' : 'Your ticket appears here once payment is confirmed.');
      return;
    }
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'p' + n));
    document.querySelectorAll('.tab').forEach((t) => { const on = +t.dataset.s === n; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); });
    if (n === 1) loadEvents().catch(() => {});
    window.scrollTo({ top: 0 });
    updateSticky();
  }
  function invalidate() {
    S.promo = null; if ($('promoOk')) $('promoOk').textContent = '';
    if (S.order && S.order.resumed) { S.order = null; S.sig = ''; store.del('pp_order'); } // form changed → a restored order no longer matches it
    if (S.ready) { S.ready = false; updateTabs(); }
  }

  /* ───────── event, countdown, venue ───────── */
  async function loadEvents() {
    S.events = await api('/api/events');
    // Show the next event that hasn't ended. An old event still marked ACTIVE can no longer hide a newer one.
    const endsAt = (e) => startMs(e.event_date, e.event_time) + 8 * 3600 * 1000;
    S.ev = S.events.find((e) => endsAt(e) > Date.now()) || S.events[S.events.length - 1] || null;
    renderHero(); renderTiers(); renderVenue(); if (S.content) renderExtras();
  }

  function renderHero() {
    const h = $('hero');
    if (!S.ev) { h.innerHTML = '<h1>No event on sale</h1><p>Check back soon.</p>'; clearInterval(S.clock); return; }
    const e = S.ev;
    h.innerHTML = '<h1>' + esc(e.name) + '</h1>' + (e.description ? '<p>' + esc(e.description) + '</p>' : '') +
      '<div class="meta"><span>' + esc(fmtWhen(e.event_date, e.event_time, true)) + '</span><span>' + esc(e.venue) + '</span><span>18+</span></div>' +
      '<div id="cd"></div>';
    document.title = e.name + ' \u2014 Tickets';
    tickCountdown(); clearInterval(S.clock); S.clock = setInterval(tickCountdown, 1000);
  }

  function tickCountdown() {
    const el = $('cd'); if (!el || !S.ev) return;
    const start = startMs(S.ev.event_date, S.ev.event_time), diff = start - Date.now();
    if (diff <= 0) {
      el.className = 'cdmsg';
      el.textContent = Date.now() - start < 8 * 3600 * 1000 ? "It's happening now \ud83c\udf89" : 'This event has ended';
      return;
    }
    const s = Math.floor(diff / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const box = (v, l) => '<div><b>' + v + '</b><small>' + l + '</small></div>';
    el.className = 'cd';
    el.setAttribute('role', 'timer');
    el.innerHTML = box(d, d === 1 ? 'Day' : 'Days') + box(pad2(h), 'Hrs') + box(pad2(m), 'Min') + box(pad2(sec), 'Sec');
  }

  function renderVenue() {
    if (!S.ev) return;
    const q = encodeURIComponent(S.ev.venue);
    const f = $('mapFrame');
    if (f.getAttribute('data-q') !== S.ev.venue) { f.setAttribute('data-q', S.ev.venue); f.src = 'https://maps.google.com/maps?q=' + q + '&z=15&output=embed'; }
    $('placeLink').href = 'https://www.google.com/maps/search/?api=1&query=' + q;
    $('placeName').textContent = S.ev.venue;
  }

  /* ───────── step 1 ───────── */
  function renderTiers() {
    const box = $('tiers');
    if (!S.ev || !S.ev.ticketTypes.length) { box.innerHTML = '<div class="empty">No tickets on sale right now.</div>'; box.setAttribute('aria-busy', 'false'); S.tiersSig = ''; recalc(); updateSticky(); return; }
    const types = S.ev.ticketTypes;
    if (!types.some((t) => String(t.id) === String(S.tierId) && !t.soldOut)) { const f = types.find((t) => !t.soldOut); S.tierId = f ? String(f.id) : null; }
    const sig = JSON.stringify([S.tierId, types.map((t) => [t.id, t.name, t.description, t.price, t.remaining, t.soldOut, t.lowStock, t.requiresPool])]);
    if (sig !== S.tiersSig) { S.tiersSig = sig; box.innerHTML = types.map((t) => {
      const on = String(t.id) === String(S.tierId);
      const badge = t.soldOut ? '<span class="badge out">Sold out</span>' : t.lowStock ? '<span class="badge low">' + t.remaining + ' left</span>' : '';
      const lock = t.requiresPool ? '<span class="badge req">Pool party ticket holders only</span> ' : '';
      return '<div class="tier' + (on ? ' on' : '') + (t.soldOut ? ' disabled' : '') + '" role="radio" aria-checked="' + on + '" tabindex="' + (t.soldOut ? -1 : 0) + '" data-act="' + (t.soldOut ? 'noop' : 'tier:' + t.id) + '">' +
        '<div><b>' + esc(t.name) + '</b>' + (t.description ? '<span>' + esc(t.description) + '</span>' : '') + lock + badge + '</div>' +
        '<div class="p">' + money(t.price) + '</div></div>';
    }).join(''); }
    box.setAttribute('aria-busy', 'false');
    clampQty(); recalc(); updateSticky();
  }

  function maxQty() { const t = tier(); return Math.max(1, Math.min(S.cfg.maxTickets || 4, t ? t.remaining : 1)); }
  function clampQty() {
    S.qty = Math.min(S.qty, maxQty()); $('q').textContent = S.qty;
    const t = tier(), cap = S.cfg.maxTickets || 4;
    $('qHint').textContent = t && t.remaining < cap ? 'only ' + t.remaining + ' left' : 'tickets, max ' + cap;
    renderAttendees();
  }
  function renderAttendees() {
    show('att', S.qty > 1);
    if ($('attInputs').children.length === S.qty) return;
    const old = names();
    $('attInputs').innerHTML = Array.from({ length: S.qty }, (_, i) =>
      '<input class="attIn" maxlength="60" aria-label="Name on ticket ' + (i + 1) + '" placeholder="' + (i === 0 ? 'Ticket 1 \u2014 you (blank = your name)' : 'Ticket ' + (i + 1) + ' \u2014 name') + '" value="' + esc(old[i] || '') + '">').join('');
  }
  function total() { const t = tier(); return t ? (S.promo ? S.promo.total : t.price * S.qty) : 0; }
  function recalc() { $('tot').textContent = money(total()); $('payAmt').textContent = money(total()); }
  function pickTier(id) { S.tierId = String(id); invalidate(); renderTiers(); }
  function bump(d) { S.qty = Math.min(maxQty(), Math.max(1, S.qty + +d)); $('q').textContent = S.qty; invalidate(); clampQty(); recalc(); }

  /* ───────── tap-to-verify box ───────── */
  const passOk = () => !!(S.pass && S.pass.exp > Date.now() + 15000);
  const needHuman = () => S.cfg.humanCheck !== false;
  function humanUI(state, main, sub) {
    const h = $('human'); h.hidden = !needHuman();
    h.className = 'human' + (state ? ' ' + state : '');
    const b = $('hBtn'); b.setAttribute('aria-checked', String(state === 'ok'));
    $('hTxt').textContent = main || "Tap to verify you're human"; $('hSub').textContent = sub || 'Takes about 5 seconds';
    if (state === 'busy') {
      const bar = $('hBar'); bar.style.transition = 'none'; bar.style.width = '0'; void bar.offsetWidth;
      bar.style.transition = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'width 5s linear'; bar.style.width = '100%'; h.classList.add('busy');
    }
  }
  function syncHuman() { if (passOk()) humanUI('ok', 'Verified', 'You can continue'); else if (!S.verifying) humanUI(''); }
  async function human() {
    if (S.verifying || passOk()) return;
    S.verifying = true; setErr('e1', '');
    let left = 5; humanUI('busy', 'Verifying\u2026', left + 's');
    const tm = setInterval(() => { left = Math.max(0, left - 1); $('hSub').textContent = left + 's'; }, 1000);
    try {
      const c = await api('/api/verify/challenge');
      await new Promise((r) => setTimeout(r, Math.max(5000, (c.minMs || 4000) + 1000)));
      const r = await api('/api/verify/pass', { method: 'POST', body: { challenge: c.challenge } });
      S.pass = { token: r.pass, exp: Date.now() + (r.expiresInMs || 1200000) }; store.set('pp_pass', S.pass);
      S.verifying = false; syncHuman();
    } catch (e) {
      S.verifying = false; humanUI('bad', "Couldn't verify", 'Tap to try again');
    } finally { clearInterval(tm); }
  }

  function toPay() {
    if (needHuman() && !passOk()) { setErr('e1', S.verifying ? 'Hold on, verifying\u2026' : 'Please tap the box to verify you\'re human.'); if (!S.verifying) { humanUI('bad', "Tap to verify you're human", 'Takes about 5 seconds'); $('hBtn').scrollIntoView({ block: 'center', behavior: 'smooth' }); } return; }
    const name = $('nm').value.trim(); let err = '';
    if (!tier()) err = 'Choose a ticket first.';
    else if (name.length < 2) err = 'Error 404: name not found. Please add your name.';
    else if (!$('agree').checked) err = "Please confirm you're 18+ and agree to the terms.";
    setErr('e1', err); if (err) return;
    renderSum();
    recalc(); S.ready = true; updateTabs(); go(2);
    if ($('promo').value.trim() && !S.promo) applyPromo(true);
  }
  function renderSum() {
    const t = tier(); if (!t) return;
    $('sum').innerHTML = '<b>' + esc(t.name) + ' \u00d7 ' + S.qty + '</b> \u2014 total <b>' + money(total()) + '</b> \u00b7 ' + esc($('nm').value.trim());
  }
  async function applyPromo(silent) {
    const code = $('promo').value.trim();
    setErr('promoErr', ''); $('promoOk').textContent = '';
    if (!code) { S.promo = null; recalc(); renderSum(); return; }
    if (!tier()) return;
    const b = $('promoBtn'); b.disabled = true;
    try {
      const d = await api('/api/promo/check', { method: 'POST', body: { ticketTypeId: S.tierId, quantity: S.qty, code } });
      S.promo = { code: d.code, discount: d.discount, total: d.total };
      $('promoOk').textContent = 'Code ' + d.code + ' applied. You save ' + money(d.discount) + '.';
    } catch (e) { S.promo = null; if (!silent) setErr('promoErr', e.message); }
    b.disabled = false; recalc(); renderSum();
  }

  /* ───────── step 2: payment ───────── */
  const orderSig = () => [S.tierId, S.qty, $('nm').value.trim(), phone9($('mp').value), names().join('|'), $('promo').value.trim().toUpperCase()].join('~');

  function term(text, cls) {
    const t = $('mpStat'); t.classList.add('on');
    const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text; t.appendChild(d);
  }
  function view(mode) { // idle | waiting | result
    show('payBtn', mode !== 'waiting'); show('waitBtns', mode === 'waiting'); show('orderRef', mode === 'waiting' && !!S.order);
    if (mode !== 'result') show('payRes', false);
    if (mode === 'idle') { $('mpStat').classList.remove('on'); $('mpStat').innerHTML = ''; }
    if (S.cfg.mock) show('mockNote', true);
  }
  function payBtnLabel(label, act) {
    const b = $('payBtn'); b.setAttribute('data-act', act || 'pay'); b.disabled = false;
    b.innerHTML = label || 'Send M-Pesa prompt for <span id="payAmt">' + esc(money(total())) + '</span>';
  }

  async function pay() {
    const raw = $('mp').value;
    const resumed = !!(S.order && S.order.resumed); // order restored after a page reload: the form fields are empty, the order is not
    if (!resumed && !phoneOk(raw)) { setErr('e2', 'Error 404: valid phone number not found. Try 0712 345 678.'); return; }
    setErr('e2', ''); show('payRes', false);
    const btn = $('payBtn'); btn.disabled = true; btn.textContent = 'Creating order\u2026';
    const sig = orderSig(); let reused = false; $('mpStat').innerHTML = '';
    try {
      if (!(S.order && (resumed || S.sig === sig))) {
        const o = await api('/api/orders', { method: 'POST', headers: { 'X-Verify': S.pass ? S.pass.token : '' }, body: {
          name: $('nm').value.trim(), phone: raw, ticketTypeId: S.tierId, quantity: S.qty, attendees: names(), agreed: $('agree').checked, promoCode: $('promo').value.trim() } });
        S.order = o; S.sig = sig;
      } else reused = true;
      btn.textContent = 'Sending prompt\u2026';
      let stk;
      try {
        stk = await api('/api/payments/tinypesa/initiate', { method: 'POST', body: { orderNumber: S.order.orderNumber, accessKey: S.order.accessKey } });
      } catch (e) {
        if (reused && e.status === 429) stk = { phone: S.order.phone, totalAmount: S.order.totalAmount, cooldownSeconds: 20 }; // prompt already went out a moment ago
        else throw e;
      }
      showWaiting(stk.phone, stk.totalAmount, stk.cooldownSeconds);
      startPolling();
    } catch (e) {
      if (e.status === 409 || e.status === 410 || e.status === 404) { S.order = null; S.sig = ''; store.del('pp_order'); }
      if (e.status === 403) { S.pass = null; store.del('pp_pass'); syncHuman(); payBtnLabel(); go(1); setErr('e1', 'Please verify you\'re human again, then continue.'); return; }
      payBtnLabel(); setErr('e2', e.message);
    }
  }

  function showWaiting(phone, amount, cooldown) {
    view('waiting');
    $('mpStat').innerHTML = '';
    term('> Sending M-Pesa prompt to ' + (phone || 'your phone') + ' \u2026');
    term('> Waiting for your PIN. Amount: ' + money(amount || S.order.totalAmount));
    term("> Don't refresh this page. If you do, use 'Find my ticket' once you've paid.");
    $('orderRef').textContent = 'Order ' + S.order.orderNumber + ' \u2014 keep this if you need help.';
    setCooldown(cooldown || S.cfg.stkCooldownSeconds || 45);
    go(2);
  }

  function setCooldown(secs) {
    clearInterval(S.cdTimer); S.cdLeft = secs;
    const b = $('resendBtn');
    const paint = () => { b.disabled = S.cdLeft > 0; b.textContent = S.cdLeft > 0 ? 'Resend in ' + S.cdLeft + 's' : 'Resend prompt'; };
    paint();
    if (secs <= 0) return;
    S.cdTimer = setInterval(() => { S.cdLeft--; paint(); if (S.cdLeft <= 0) clearInterval(S.cdTimer); }, 1000);
  }

  function startPolling() { stopPolling(); S.pollStart = Date.now(); tick(); }
  function stopPolling() { clearTimeout(S.poll); S.poll = null; }
  function schedule() { S.poll = setTimeout(tick, Date.now() - S.pollStart > 60000 ? 5000 : 3000); }

  async function tick() {
    clearTimeout(S.poll);
    if (!S.order) return;
    try {
      onStatus(await api('/api/orders/' + encodeURIComponent(S.order.orderNumber) + '/status', { headers: { 'X-Access-Key': S.order.accessKey } }));
    } catch (e) {
      if (e.status === 404) { stopPolling(); S.order = null; store.del('pp_order'); showResult('expired'); } else schedule();
    }
  }

  let slow = false;
  function onStatus(d) {
    if (d.status === 'PAID') { stopPolling(); finish(d.tickets || []); return; }
    if (d.status === 'FAILED') { stopPolling(); showResult('failed', d); return; }
    if (d.status === 'EXPIRED') { stopPolling(); showResult('expired', d); return; }
    if (d.status === 'REFUND_REQUIRED') { stopPolling(); showResult('refund', d); return; }
    if (d.canResendIn > 0 && S.cdLeft === 0) setCooldown(d.canResendIn);
    if (!slow && Date.now() - S.pollStart > 75000) { slow = true; term("> Still waiting. If you've already paid, your ticket will appear shortly \u2014 don't pay twice."); }
    schedule();
  }

  function failText(code, desc) {
    const c = Number(code);
    if (c === 1032) return "You cancelled the M-Pesa prompt. Tap Try again when you're ready.";
    if (c === 1) return 'Your M-Pesa balance is too low. Top up, then try again.';
    if (c === 2001) return 'The M-Pesa PIN was wrong. Try again and enter it carefully.';
    if (c === 1037) return 'The prompt timed out before a PIN was entered. Tap Try again and keep an eye on your phone.';
    return "The payment didn't go through" + (desc ? ' (' + desc + ')' : '') + '. If you got an M-Pesa confirmation SMS, wait a minute \u2014 your ticket may still arrive. You can also use \u201cFind my ticket\u201d.';
  }

  function showResult(kind, d) {
    clearInterval(S.cdTimer); slow = false; view('result');
    const r = $('payRes'); r.className = 'res bad'; r.hidden = false;
    const ref = S.order ? S.order.orderNumber : '';
    let title, text;
    if (kind === 'failed') {
      title = 'Payment failed, try again'; text = failText(d && d.failureCode, d && d.failureReason);
      payBtnLabel('Try again', 'retry');
    } else if (kind === 'refund') {
      title = 'Payment received, but tickets sold out';
      text = 'We received your payment but this ticket type sold out while you were paying. You will be refunded \u2014 please contact support with order ' + ref + '.';
      payBtnLabel('Back to tickets', 'restart');
    } else {
      title = 'Prompt timed out';
      text = 'This order expired and the tickets were released. If money left your M-Pesa, do NOT pay again \u2014 use \u201cFind my ticket\u201d' + (ref ? ' (order ' + ref + ')' : '') + ' or contact support.';
      payBtnLabel('Start again', 'restart');
    }
    r.innerHTML = '<b>' + esc(title) + '</b><span class="sub">' + esc(text) + '</span>';
    show('orderRef', false);
  }

  function retry() { view('idle'); payBtnLabel(); pay(); }
  function restart() { S.order = null; S.sig = ''; store.del('pp_order'); view('idle'); payBtnLabel(); go(1); }
  function changeNumber() {
    stopPolling(); clearInterval(S.cdTimer); S.order = null; S.sig = ''; store.del('pp_order');
    view('idle'); payBtnLabel();
    if (!$('nm').value.trim()) { S.ready = false; updateTabs(); go(1); toast('Enter your details again, then pay with the new number.'); return; }
    $('mp').focus(); toast('Enter the new number and send a new prompt.');
  }
  async function resend() {
    if (!S.order) return;
    const b = $('resendBtn'); b.disabled = true;
    try {
      const r = await api('/api/payments/tinypesa/initiate', { method: 'POST', body: { orderNumber: S.order.orderNumber, accessKey: S.order.accessKey } });
      setCooldown(r.cooldownSeconds || 45); toast('New M-Pesa prompt sent.'); S.pollStart = Date.now(); slow = false; term('> New prompt sent. Enter your PIN.'); tick();
    } catch (e) { toast(e.message); b.disabled = false; if (e.status === 410 || e.status === 409) tick(); }
  }

  /* Keep every ticket this phone has ever fetched. A newer copy of the same ticket (fresh QR after a
   * reissue, or a USED/CANCELLED status) replaces the old one; a second purchase no longer wipes the first. */
  function mergeTickets(list) {
    const map = new Map(S.tickets.map((t) => [t.ticketNumber, t]));
    (list || []).forEach((t) => map.set(t.ticketNumber, t));
    S.tickets = Array.from(map.values()); // kept in memory only: a refresh starts clean, "Find my ticket" brings them back
  }

  /* One-tap link from the organiser's WhatsApp message: /?t=<token> opens the ticket straight away. */
  async function openFromLink() {
    let tok = null;
    try { tok = new URLSearchParams(location.search).get('t'); } catch (e) { /* old browser */ }
    if (!tok) return false;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    try {
      const d = await api('/api/tickets/link/' + encodeURIComponent(tok));
      mergeTickets(d.tickets); renderTickets(); updateTabs(); go(3);
      return true;
    } catch (e) { toast(e.message); return false; }
  }

  function finish(tickets) {
    stopPolling(); clearInterval(S.cdTimer); slow = false;
    mergeTickets(tickets);
    S.order = null; S.sig = ''; view('idle'); payBtnLabel();
    renderTickets(); updateTabs(); go(3);
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    confetti();
  }

  /* ───────── step 3: tickets (real QR) ───────── */
  function drawQR(cv, text) {
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (typeof qrcode !== 'function') {
      ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.font = 'bold ' + Math.round(cv.width / 12) + 'px sans-serif';
      ctx.fillText('QR unavailable', cv.width / 2, cv.height / 2 - 6); ctx.font = Math.round(cv.width / 16) + 'px sans-serif';
      ctx.fillText('show ticket code', cv.width / 2, cv.height / 2 + cv.width / 10);
      return false;
    }
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), cell = Math.max(1, Math.floor(cv.width / (n + 8))), off = Math.floor((cv.width - cell * n) / 2);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
    return true;
  }

  function ticketHTML(t) {
    const p = parts(t.event.date), voided = t.status !== 'VALID';
    const label = t.status === 'USED' ? 'Already used' : t.status === 'CANCELLED' ? 'Cancelled' : '';
    return '<div class="tk' + (voided ? ' void' : '') + '">' +
      '<div class="tix"><div class="stub"><div class="stubword">TICKET</div><div class="stubnum"><span>' + esc(dotDate(t.event.date)) + '</span><span>' + esc(t.ticketNumber) + '</span></div></div>' +
      '<div class="tbody"><div class="d1"></div><div class="d2"></div>' +
      '<div class="tl"><small>Hosted by</small><b>' + esc(BRAND.host) + '</b></div>' +
      '<div class="tc"><span class="orn">&#9670;</span><div class="dt"><b>' + p.d + '</b><i>' + MON[p.m - 1] + '</i></div><span class="orn">&#9670;</span></div>' +
      '<div class="tr"><small>Ticket holder</small><b>' + esc(t.holderName) + '</b><em>' + esc(t.type) + '</em></div>' +
      '<img class="tlogo" src="/assets/logo.jpg" alt="">' +
      '<div class="pp">' + esc(BRAND.script) + '</div>' +
      '<div class="bot"><span>' + esc(BRAND.perk) + '</span><span>' + esc(t.event.venue.split(',')[0]) + '</span></div></div></div>' +
      (voided ? '<div class="stamp">' + esc(label) + '</div>' : '') +
      '<div class="qrcard"><canvas width="400" height="400" role="img" aria-label="QR code for ticket ' + esc(t.ticketNumber) + '"></canvas>' +
      '<div><b>Scan at the door</b><span class="txn">' + esc(t.ticketNumber) + '</span><p>' + esc(t.typeDesc || t.type) + '</p><p>Order ' + esc(t.orderNumber) + '</p></div></div></div>';
  }

  function renderTickets() {
    const has = S.tickets.length > 0;
    show('noT', !has || S.showFind); show('noTmsg', !has); show('tkWrap', has);
    if (!has) return;
    $('tkList').innerHTML = S.tickets.map(ticketHTML).join('');
    document.querySelectorAll('#tkList .tk canvas').forEach((cv, i) => drawQR(cv, S.tickets[i].qr));
    $('dlPl').textContent = S.tickets.length > 1 ? 's (' + S.tickets.length + ')' : '';
    if (S.cfg.groupLink) { $('grpLink').href = S.cfg.groupLink; show('grpCard', true); }
  }

  function rrect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  function ticketPng(t) {
    const W = 1560, TH = 600, H = 1400, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d');
    const p = parts(t.event.date);
    const G = (x0, y0, x1, y1) => { const g = c.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, '#f7e39a'); g.addColorStop(.5, '#d4af37'); g.addColorStop(1, '#a87b1d'); return g; };
    c.save(); rrect(c, 0, 0, W, H, 30); c.clip();
    c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#fff'; c.fillRect(0, 0, 300, TH);
    const bg = c.createRadialGradient(930, 290, 40, 930, 290, 800); bg.addColorStop(0, '#2c2c2c'); bg.addColorStop(1, '#0b0b0b'); c.fillStyle = bg; c.fillRect(300, 0, W - 300, TH);
    c.save(); c.beginPath(); c.rect(300, 0, W - 300, TH); c.clip(); c.translate(930, 300); c.rotate(Math.PI / 4);
    [[250, 26], [330, 16]].forEach((f) => { const r = f[0], w = f[1]; c.strokeStyle = '#181818'; c.lineWidth = w; c.strokeRect(-r, -r, r * 2, r * 2); c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 2; c.strokeRect(-r - w / 2, -r - w / 2, r * 2 + w, r * 2 + w); });
    c.restore();
    c.setLineDash([10, 10]); c.strokeStyle = '#c4c4c4'; c.lineWidth = 3; c.beginPath(); c.moveTo(300, 20); c.lineTo(300, TH - 20); c.stroke(); c.setLineDash([]);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.save(); c.translate(90, 300); c.rotate(-Math.PI / 2); c.font = '700 110px "Noto Serif",Georgia,serif'; c.fillStyle = G(-260, 0, 260, 0); c.fillText('TICKET', 0, 0); c.restore();
    c.fillStyle = '#222'; c.font = '500 28px ui-monospace,Menlo,monospace';
    [[190, dotDate(t.event.date)], [240, t.ticketNumber]].forEach((x) => { c.save(); c.translate(x[0], 300); c.rotate(-Math.PI / 2); c.fillText(x[1], 0, 0); c.restore(); });
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left'; c.fillStyle = '#a9a9a9'; c.font = '400 22px Roboto,sans-serif'; c.fillText('Hosted by', 350, 88);
    c.fillStyle = '#fff'; c.font = '700 34px Roboto,sans-serif'; c.fillText(BRAND.host, 350, 130);
    c.textAlign = 'right'; c.fillStyle = '#a9a9a9'; c.font = '400 22px Roboto,sans-serif'; c.fillText('Ticket holder', 1510, 88);
    c.fillStyle = '#fff'; c.font = '700 32px Roboto,sans-serif'; c.fillText(t.holderName.toUpperCase(), 1510, 128, 560);
    c.fillStyle = G(1200, 0, 1510, 0); c.font = '500 26px Roboto,sans-serif'; c.fillText(t.type, 1510, 166);
    c.textAlign = 'center'; c.fillStyle = G(0, 60, 0, 130); c.font = '700 88px "Noto Serif",serif'; c.fillText(String(p.d), 930, 124);
    c.fillStyle = G(880, 150, 980, 190); c.font = '58px "Great Vibes",cursive'; c.fillText(MON[p.m - 1], 930, 180);
    c.strokeStyle = '#d4af37'; c.fillStyle = '#d4af37'; c.lineWidth = 2;
    [-1, 1].forEach((d) => { const x = 930 + d * 80; c.beginPath(); c.moveTo(x, 100); c.lineTo(x + d * 8, 108); c.lineTo(x, 116); c.lineTo(x - d * 8, 108); c.closePath(); c.fill(); c.beginPath(); c.moveTo(x + d * 16, 108); c.lineTo(x + d * 110, 108); c.stroke(); });
    const im = $('logoImg');
    if (im && im.naturalWidth) { const lw = 400, lh = lw * im.naturalHeight / im.naturalWidth; c.globalCompositeOperation = 'lighten'; c.drawImage(im, 930 - lw / 2, 205, lw, lh); c.globalCompositeOperation = 'source-over'; }
    c.fillStyle = G(780, 500, 1080, 560); c.font = '66px "Great Vibes",cursive'; c.fillText(BRAND.script, 930, 548);
    c.fillStyle = '#bdbdbd'; c.font = '500 20px Roboto,sans-serif';
    c.textAlign = 'left'; c.fillText(BRAND.perk.toUpperCase(), 350, 574); c.textAlign = 'right'; c.fillText(t.event.venue.split(',')[0].toUpperCase(), 1510, 574);
    // QR section
    c.textAlign = 'center'; c.fillStyle = G(600, 0, 960, 0); c.font = '700 40px Roboto,sans-serif'; c.fillText('SCAN AT THE DOOR', W / 2, TH + 80);
    c.fillStyle = '#fff'; rrect(c, W / 2 - 280, TH + 110, 560, 560, 26); c.fill();
    const q = document.createElement('canvas'); q.width = q.height = 520; drawQR(q, t.qr); c.drawImage(q, W / 2 - 260, TH + 130, 520, 520);
    c.fillStyle = '#d9d2bd'; c.font = '500 30px ui-monospace,Menlo,monospace'; c.fillText(t.ticketNumber, W / 2, TH + 730);
    c.fillStyle = '#8f8873'; c.font = '400 22px Roboto,sans-serif'; c.fillText(fmtWhen(t.event.date, t.event.time) + ' \u00b7 ' + t.event.venue, W / 2, TH + 772, W - 120);
    c.restore();
    return cv;
  }

  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function dlAll() {
    const fs = ['700 40px "Noto Serif"', '60px "Great Vibes"', '700 30px Roboto', '400 22px Roboto'];
    Promise.all(fs.map((f) => document.fonts.load(f))).catch(() => {}).then(() => {
      S.tickets.forEach((t, i) => setTimeout(() => ticketPng(t).toBlob((b) => b && download(b, 'ticket-' + t.ticketNumber + '.png')), i * 600));
    });
  }

  function ics() {
    const t = S.tickets[0]; if (!t) return; const e = t.event;
    const start = new Date(startMs(e.date, e.time)), end = new Date(start.getTime() + 6 * 3600 * 1000);
    const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const q = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//404homies//Tickets//EN', 'BEGIN:VEVENT', 'UID:' + t.orderNumber + '@404homies', 'DTSTAMP:' + f(new Date()), 'DTSTART:' + f(start), 'DTEND:' + f(end),
      'SUMMARY:' + q(e.name), 'LOCATION:' + q(e.venue), 'DESCRIPTION:' + q('Ticket ' + t.ticketNumber + '. Show your QR code at the door. 18+'), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    download(new Blob([body], { type: 'text/calendar' }), 'event.ics');
  }
  function share() {
    const t = S.tickets[0], e = t ? t.event : null;
    const name = e ? e.name : S.ev ? S.ev.name : 'the party', when = e ? fmtWhen(e.date, e.time) : S.ev ? fmtWhen(S.ev.event_date, S.ev.event_time) : '', venue = e ? e.venue : S.ev ? S.ev.venue : '';
    const text = "I'm going to " + name + ' \u2014 ' + when + ', ' + venue + '. Get your ticket:';
    if (navigator.share) { navigator.share({ title: name, text, url: location.origin }).catch(() => {}); return; }
    window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + location.origin), '_blank', 'noopener');
  }

  async function find() {
    setErr('fErr', ''); const b = $('fBtn'); b.disabled = true;
    const phone = $('fPhone').value, code = $('fCode').value.trim();
    if (!phoneOk(phone)) { setErr('fErr', 'Enter the M-Pesa number you paid from, e.g. 0712 345 678.'); b.disabled = false; return; }
    if (code.length < 6) { setErr('fErr', 'Enter the M-Pesa code from your SMS (e.g. SGH7K2L9QX) or your order number.'); b.disabled = false; return; }
    try {
      const d = await api('/api/tickets/lookup', { method: 'POST', body: { phone, code } });
      mergeTickets(d.tickets); S.showFind = false; $('fCode').value = ''; renderTickets(); updateTabs(); toast('Ticket found.');
    } catch (e) { setErr('fErr', e.message); } finally { b.disabled = false; }
  }
  function findOpen() { S.findMode = true; S.showFind = true; renderTickets(); updateTabs(); go(3); const f = $('fPhone'); if (f) f.focus(); }

  /* ───────── support button ───────── */
  function initSupport() {
    const b = $('supBtn'), card = $('supCard'), box = $('supLinks');
    const msg = encodeURIComponent('Hi, I need help with my 404 Error Pool Party ticket.'); let n = 0;
    const add = (href, t) => { const a = document.createElement('a'); a.href = href; a.textContent = t; if (href.indexOf('http') === 0) { a.target = '_blank'; a.rel = 'noopener'; } box.appendChild(a); n++; };
    if (S.cfg.supportWhatsapp) add('https://wa.me/' + S.cfg.supportWhatsapp + '?text=' + msg, 'Chat on WhatsApp');
    if (S.cfg.supportPhone) add('tel:' + S.cfg.supportPhone.replace(/\s/g, ''), 'Call ' + S.cfg.supportPhone);
    if (!n) { const p = document.createElement('p'); p.style.marginTop = '10px'; p.textContent = 'Support contact coming soon.'; box.appendChild(p); }
    const set = (o) => { card.classList.toggle('on', o); b.setAttribute('aria-expanded', o); };
    b.addEventListener('click', () => set(!card.classList.contains('on')));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
    document.addEventListener('click', (e) => { if (!card.contains(e.target) && !b.contains(e.target)) set(false); });
  }

  /* ───────── v2.4: stock bar, sticky bar, confetti, extra sections ───────── */
  let btnVisible = true;
  function updateSticky() {
    const bar = $('sticky'), types = S.ev ? S.ev.ticketTypes.filter((t) => !t.soldOut) : [];
    const on = !!types.length && $('p1').classList.contains('on') && !btnVisible && 'IntersectionObserver' in window;
    if (types.length) $('stkP').textContent = money(Math.min.apply(null, types.map((t) => t.price)));
    $('stkL').textContent = types.length > 1 ? 'From' : 'Price';
    bar.hidden = !on; document.body.classList.toggle('hasbar', on);
  }
  function initSticky() {
    if (!('IntersectionObserver' in window)) return;
    const target = document.querySelector('#p1 [data-act="toPay"]');
    new IntersectionObserver((en) => { btnVisible = en[0].isIntersecting; updateSticky(); }).observe(target);
  }

  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cv = document.createElement('canvas'), W = cv.width = innerWidth, H = cv.height = innerHeight, c = cv.getContext('2d');
    cv.style.cssText = 'position:fixed;inset:0;z-index:50;pointer-events:none'; cv.setAttribute('aria-hidden', 'true'); document.body.appendChild(cv);
    const cols = ['#e8c56a', '#f0d47e', '#c99a2e', '#fff4cf', '#a87b1d'];
    const p = Array.from({ length: 40 }, () => ({ x: W / 2, y: H * 0.35, vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 11 - 3, s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[(Math.random() * cols.length) | 0] }));
    let f = 0;
    (function step() {
      c.clearRect(0, 0, W, H);
      p.forEach((q) => { q.vy += 0.35; q.x += q.vx; q.y += q.vy; q.r += q.vr; c.save(); c.translate(q.x, q.y); c.rotate(q.r); c.fillStyle = q.c; c.globalAlpha = Math.max(0, 1 - f / 110); c.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2); c.restore(); });
      if (++f < 110) requestAnimationFrame(step); else cv.remove();
    })();
  }

  async function initExtras() {
    try { const r = await fetch('/content.json', { cache: 'no-store' }); if (r.ok) S.content = await r.json(); } catch (e) { /* sections stay hidden */ }
    S.content = S.content || {};
    // Photos uploaded in the admin panel come first; any listed in content.json follow.
    try { const up = await api('/api/gallery'); if (up.length) S.content.gallery = up.concat(Array.isArray(S.content.gallery) ? S.content.gallery : []); } catch (e) { /* ignore */ }
    renderExtras();
  }
  function renderExtras() {
    const C = S.content || {};
    const arr = (v) => (Array.isArray(v) ? v : []);
    const safeImg = (s) => /^\/(assets\/[\w\-./]+|api\/gallery\/\d+\/img)$/.test(String(s || ''));
    const gal = arr(C.gallery).filter((g) => g && safeImg(g.src)), incl = arr(C.included), line = arr(C.lineup);
    $('gal').innerHTML = gal.map((g) => '<img loading="lazy" src="' + esc(g.src) + '" alt="' + esc(g.alt || '') + '">').join(''); $('gal').hidden = !gal.length;
    $('incl').innerHTML = incl.map((t) => '<span>' + esc(t) + '</span>').join(''); $('incl').hidden = !incl.length;
    $('line').innerHTML = line.map((d) => '<span>' + esc(d.name || d) + (d.role ? '<small>' + esc(d.role) + '</small>' : '') + '</span>').join(''); $('lineWrap').hidden = !line.length;
    $('night').hidden = !(incl.length || line.length);
    initGalleryAuto();
    const sch = arr(C.schedule).filter((s) => s && s.title);
    $('sched').innerHTML = sch.map((s) => '<li>' + (s.time ? '<b>' + esc(s.time === '@start' ? (S.ev ? fmtTime(S.ev.event_time) : '') : s.time) + '</b>' : '') + '<span>' + esc(s.title) + '</span>' + (s.note ? '<small>' + esc(s.note) + '</small>' : '') + '</li>').join(''); $('schedWrap').hidden = !sch.length;
    const faq = arr(C.faq).filter((f) => f && f.q && f.a);
    $('faq').innerHTML = faq.map((f) => '<details><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>').join(''); $('faqWrap').hidden = !faq.length;
    const so = C.socials || {}, links = [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['whatsapp', 'WhatsApp Channel']].filter((x) => /^https:\/\//.test(so[x[0]] || ''));
    $('soc').innerHTML = links.map((x) => '<a href="' + esc(so[x[0]]) + '" target="_blank" rel="noopener">' + x[1] + '</a>').join(''); $('soc').hidden = !links.length;
  }

  /* Gallery auto-slide: every 2.4 s it glides to the next photo (left to right through the set), loops back to the first,
   * pauses while someone is touching/dragging it, while it is off-screen or the tab is hidden, and never runs for reduced-motion. */
  function initGalleryAuto() {
    const g = $('gal'); if (!g || g.dataset.auto) return; g.dataset.auto = '1';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let hold = false, seen = true, resume = null;
    const pause = () => { hold = true; clearTimeout(resume); };
    const later = () => { clearTimeout(resume); resume = setTimeout(() => { hold = false; }, 4000); };
    // Touch only: mouse hover is handled separately so a phone's emulated "mouseenter" can't freeze the slider for good.
    g.addEventListener('pointerdown', pause, { passive: true });
    ['pointerup', 'pointercancel'].forEach((ev) => g.addEventListener(ev, later, { passive: true }));
    g.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') pause(); }, { passive: true });
    g.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') later(); }, { passive: true });
    if ('IntersectionObserver' in window) new IntersectionObserver((en) => { seen = en[0].isIntersecting; }).observe(g);
    let idx = 0;
    const pad = parseFloat(getComputedStyle(g).paddingLeft) || 0;
    setInterval(() => {
      const k = g.children; if (hold || !seen || document.hidden || g.hidden || k.length < 2) return;
      const gl = g.getBoundingClientRect().left;
      let cur = 0, best = 1e9; // re-sync with wherever the visitor swiped to
      for (let i = 0; i < k.length; i++) { const d = Math.abs(k[i].getBoundingClientRect().left - gl); if (d < best) { best = d; cur = i; } }
      idx = (cur + 1) % k.length;
      const nx = k[idx];
      g.scrollTo({ left: idx === 0 ? 0 : g.scrollLeft + nx.getBoundingClientRect().left - gl - pad, behavior: 'smooth' });
    }, 2400);
  }

  function initAnalytics() {
    if (!S.cfg.analyticsToken || navigator.doNotTrack === '1') return;
    const s = document.createElement('script'); s.defer = true; s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: S.cfg.analyticsToken })); document.head.appendChild(s);
  }

  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn, .qty button, .tab, .tier, .linkbtn, .soc a, .supcard a');
    if (!b || b.disabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 1.6, s = document.createElement('span');
    s.className = 'rip'; s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
    if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
    b.appendChild(s); setTimeout(() => s.remove(), 600);
  });

  /* ───────── events wiring ───────── */
  const actions = {
    noop() {}, go: (n) => go(+n), applyPromo: () => applyPromo(false), bump, tier: pickTier, toPay, pay, retry, restart, resend, changeNumber, checkNow: () => tick(),
    dlAll, ics, share, find, findOpen, findMore: () => { S.showFind = !S.showFind; renderTickets(); if (S.showFind) $('fPhone').focus(); }, again: () => { S.order = null; S.sig = ''; S.promo = null; $('promo').value = ''; $('promoOk').textContent = ''; setErr('promoErr', ''); S.ready = false; updateTabs(); go(1); },
    human,
    stk: () => { $('p1').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    terms: () => { $('terms').scrollIntoView({ behavior: 'smooth', block: 'center' }); },
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
    const a = el.getAttribute('data-act'), i = a.indexOf(':'), fn = actions[i < 0 ? a : a.slice(0, i)];
    if (fn) { if (el.tagName === 'A') e.preventDefault(); fn(i < 0 ? '' : a.slice(i + 1), el); }
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t.matches && t.matches('.tier[data-act]')) { e.preventDefault(); t.click(); return; }
    if (e.key === 'Enter' && (t.id === 'fPhone' || t.id === 'fCode')) { e.preventDefault(); find(); }
    if (e.key === 'Enter' && t.id === 'mp' && !$('payBtn').hidden) { e.preventDefault(); $('payBtn').click(); }
  });
  $('nm').addEventListener('input', invalidate);
  $('agree').addEventListener('change', invalidate);
  $('fCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.order && S.poll) tick(); }); // back from the M-Pesa app → check now
  window.addEventListener('online', () => $('offline').classList.remove('on'));
  window.addEventListener('offline', () => $('offline').classList.add('on'));

  /* ───────── boot ───────── */
  async function boot() {
    $('offline').classList.toggle('on', !navigator.onLine);
    try { S.cfg = await api('/api/config'); } catch (e) { /* defaults apply */ }
    syncHuman();
    const sp = store.get('pp_pass'); if (sp && sp.token && sp.exp > Date.now()) S.pass = sp;
    syncHuman(); initSupport(); initSticky(); initAnalytics(); initExtras();
    // Older versions saved orders and tickets on the phone. Clear them so nothing stale (a failed payment, a cancelled ticket) comes back.
    ['pp_order', 'pp_tickets', 'pp_keys', 'pp_links'].forEach((k) => store.del(k));
    updateTabs(); view('idle');
    try { await loadEvents(); } catch (e) { $('hero').innerHTML = '<h1>Tickets</h1><p>' + esc(e.message) + '</p>'; $('tiers').innerHTML = '<div class="empty">Couldn\'t load tickets. Pull to refresh.</div>'; }
    await openFromLink();
    setInterval(() => { if (!document.hidden && $('p1').classList.contains('on')) loadEvents().catch(() => {}); }, 60000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  boot();
})();
