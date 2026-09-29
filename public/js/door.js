/* Door scanner — staff only. Needs the STAFF_TOKEN. Not linked from the public site: open /door. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const setErr = (id, m) => { const e = $(id); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; };
  const S = { staff: '', stream: null, timer: null, cv: null, busy: false, lastCode: '', lastAt: 0, local: 0, audio: null, det: null };

  async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET', headers: Object.assign({}, opts.headers) };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    let r; try { r = await fetch(path, init); } catch (e) { const er = new Error("Can't reach the server"); er.network = true; throw er; }
    let d = {}; try { d = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) { const er = new Error(d.error || 'Request failed'); er.status = r.status; throw er; }
    return d;
  }

  const beep = (freq, ms, delay) => {
    try {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return; S.audio = S.audio || new A();
      setTimeout(() => { const o = S.audio.createOscillator(), g = S.audio.createGain(); o.frequency.value = freq; g.gain.value = 0.12; o.connect(g); g.connect(S.audio.destination); o.start(); o.stop(S.audio.currentTime + ms / 1000); }, delay || 0);
    } catch (e) { /* sound is optional */ }
  };
  const hhmm = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function showApp(on) { $('login').classList.toggle('on', !on); $('app').classList.toggle('on', on); }
  function counts(sum) { if (sum) { $('cAdm').textContent = sum.admitted; $('cTot').textContent = sum.total; } $('cLocal').textContent = S.local; }

  async function login(saved) {
    const t = typeof saved === 'string' && saved ? saved : $('tok').value.trim();
    if (!t) { setErr('loginErr', 'Enter the staff code.'); return; }
    try {
      const sum = await api('/api/staff/summary', { headers: { 'X-Staff-Token': t } });
      S.staff = t; try { sessionStorage.setItem('pp_staff', t); } catch (e) { /* ignore */ }
      setErr('loginErr', ''); $('tok').value = ''; showApp(true); counts(sum);
    } catch (e) { setErr('loginErr', e.message); try { sessionStorage.removeItem('pp_staff'); } catch (x) { /* ignore */ } }
  }
  function logout() { S.staff = ''; camOff(); try { sessionStorage.removeItem('pp_staff'); } catch (e) { /* ignore */ } showApp(false); }

  async function camOn() {
    if (S.stream) return; beep(1, 1);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('camHint').textContent = 'Camera unavailable \u2014 type the ticket code below'; return; }
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const v = $('vid'); v.srcObject = S.stream; await v.play();
      $('camHint').textContent = 'Point at the ticket QR code'; $('camBtn').textContent = 'Camera running'; loop();
    } catch (e) { S.stream = null; $('camHint').textContent = 'Camera blocked \u2014 allow it in browser settings, or type the code'; }
  }
  function camOff() {
    clearTimeout(S.timer);
    if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
    const v = $('vid'); if (v) v.srcObject = null;
    $('camHint').textContent = 'Camera off \u2014 tap Start'; $('camBtn').textContent = 'Start camera';
  }
  function loop() {
    if (!S.stream) return;
    const v = $('vid'), next = () => { S.timer = setTimeout(loop, 160); };
    if (v.readyState < 2 || S.busy) { next(); return; }
    let p;
    if ('BarcodeDetector' in window) { S.det = S.det || new window.BarcodeDetector({ formats: ['qr_code'] }); p = S.det.detect(v).then((r) => (r[0] ? r[0].rawValue : null)); }
    else p = Promise.resolve(jsqr(v));
    p.then((code) => { if (code) onCode(code); }).catch(() => {}).then(next);
  }
  function jsqr(v) {
    if (typeof jsQR !== 'function' || !v.videoWidth) return null;
    S.cv = S.cv || document.createElement('canvas'); const sc = Math.min(1, 480 / v.videoWidth);
    S.cv.width = Math.round(v.videoWidth * sc); S.cv.height = Math.round(v.videoHeight * sc);
    const ctx = S.cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(v, 0, 0, S.cv.width, S.cv.height);
    const img = ctx.getImageData(0, 0, S.cv.width, S.cv.height), r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return r ? r.data : null;
  }

  function verdict(cls, big, small) {
    const el = $('verdict'); el.className = 'verdict show ' + cls; el.innerHTML = '<b>' + esc(big) + '</b><span>' + esc(small || '') + '</span>';
    if (cls === 'ok') { beep(880, 130); if (navigator.vibrate) navigator.vibrate(80); }
    else if (cls === 'warn') { beep(520, 120); beep(520, 120, 200); if (navigator.vibrate) navigator.vibrate([90, 60, 90]); }
    else { beep(180, 380); if (navigator.vibrate) navigator.vibrate(300); }
  }
  function logScan(code, good, label) {
    const list = $('logList'); if (list.querySelector('.empty')) list.innerHTML = '';
    const it = document.createElement('div'); it.className = 'item';
    it.innerHTML = '<span class="dot ' + (good ? 'g' : 'b') + '"></span><span class="code">' + esc(String(code).split('.')[0]) + '</span><span class="t">' + hhmm(Date.now()) + ' \u00b7 ' + esc(label) + '</span>';
    list.insertBefore(it, list.firstChild); while (list.children.length > 30) list.lastChild.remove();
  }

  async function onCode(code, force, forceAdmit) {
    code = String(code).trim(); if (!code || S.busy) return;
    if (!force && code === S.lastCode && Date.now() - S.lastAt < 3500) return;
    S.lastCode = code; S.lastAt = Date.now(); S.busy = true;
    try {
      const admit = forceAdmit || $('admitMode').checked;
      const r = await api('/api/staff/' + (admit ? 'admit' : 'check'), { method: 'POST', headers: { 'X-Staff-Token': S.staff }, body: { code } });
      const who = (r.holder ? r.holder + ' \u00b7 ' : '') + (r.type || '') + (r.typeDesc ? ' (' + r.typeDesc.split('\u00b7')[0].trim() + ')' : '');
      if (r.result === 'ADMIT') { verdict('ok', 'ADMIT', who); S.local++; logScan(code, true, 'admitted'); const n = $('cAdm'); n.textContent = +n.textContent + 1; }
      else if (r.result === 'VALID') { verdict('ok', 'VALID', who + ' \u2014 not admitted yet'); logScan(code, true, 'valid'); }
      else if (r.result === 'ALREADY_USED') { verdict('warn', 'ALREADY USED', who + (r.usedAt ? ' \u2014 entered ' + hhmm(r.usedAt) : '')); logScan(code, false, 'already used'); }
      else if (r.result === 'CANCELLED') { verdict('bad', 'CANCELLED', who); logScan(code, false, 'cancelled'); }
      else { verdict('bad', 'INVALID', r.reason || 'Not a valid ticket'); logScan(code, false, 'invalid'); }
      counts();
    } catch (e) {
      if (e.status === 401) { logout(); setErr('loginErr', 'Session ended \u2014 enter the staff code again.'); }
      else verdict('bad', e.network ? 'NO CONNECTION' : 'ERROR', e.message);
    } finally { setTimeout(() => { S.busy = false; }, 900); }
  }
  function manual() { const v = $('man').value.trim().toUpperCase(); if (!v || S.busy) return; onCode(v, true); $('man').value = ''; }

  /* ── search by name / phone (for guests who lost their QR) ── */
  let srchTimer = null, srchSeq = 0;
  function renderResults(rows) {
    const box = $('srchList');
    if (!rows) { box.innerHTML = ''; return; }
    if (!rows.length) { box.innerHTML = '<div class="empty" style="padding:10px">No matching ticket.</div>'; return; }
    box.innerHTML = rows.map((t) => {
      const st = t.status === 'USED' ? 'already used' : t.status === 'CANCELLED' ? 'cancelled' : 'valid';
      const btn = t.status === 'VALID' ? '<button class="btn" type="button" style="margin:0;flex:0 0 84px;padding:8px" data-act="admitTk:' + esc(t.ticketNumber) + '">Admit</button>' : '';
      return '<div class="item"><span class="dot ' + (t.status === 'VALID' ? 'g' : 'b') + '"></span><span style="flex:1;min-width:0"><b>' + esc(t.holder) + '</b><br><span class="t">' + esc(t.type) + ' \u00b7 ' + esc(t.ticketNumber) + ' \u00b7 ends ' + esc(t.phoneTail) + ' \u00b7 ' + st + '</span></span>' + btn + '</div>';
    }).join('');
  }
  function doSearch() {
    const q = $('srch').value.trim();
    if (q.length < 3 || !S.staff) { renderResults(null); return; }
    const my = ++srchSeq;
    api('/api/staff/search?q=' + encodeURIComponent(q), { headers: { 'X-Staff-Token': S.staff } })
      .then((rows) => { if (my === srchSeq) renderResults(rows); })
      .catch((e) => { if (e.status === 401) { logout(); setErr('loginErr', 'Session ended \u2014 enter the staff code again.'); } });
  }
  $('srch').addEventListener('input', () => { clearTimeout(srchTimer); srchTimer = setTimeout(doSearch, 300); });

  const actions = { login: () => login(), logout, camOn, camOff, manual };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const a = el.getAttribute('data-act');
    if (a.indexOf('admitTk:') === 0) { onCode(a.slice(8), true, true).then(() => { $('srch').value = ''; renderResults(null); }); return; }
    if (actions[a]) actions[a]();
  });
  document.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; if (e.target.id === 'tok') login(); if (e.target.id === 'man') manual(); });
  window.addEventListener('pagehide', camOff);

  let saved = null; try { saved = sessionStorage.getItem('pp_staff'); } catch (e) { /* ignore */ }
  if (saved) login(saved);
  setInterval(() => { if (S.staff && !document.hidden) api('/api/staff/summary', { headers: { 'X-Staff-Token': S.staff } }).then(counts).catch(() => {}); }, 20000);
})();
