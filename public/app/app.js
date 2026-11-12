/* FichajeBull · Web App del vigilant (mobile-first, PWA amb mode offline) */
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16)));
  const TYPE = { IN: 'Entrada', OUT: 'Sortida', BREAK_START: 'Inici pausa', BREAK_END: 'Fi pausa' };
  let token = localStorage.getItem('token');
  let me = JSON.parse(localStorage.getItem('me') || 'null');
  let busy = false;

  const tzName = () => (me && me.settings && me.settings.timezone) || 'Europe/Madrid';
  const fmtTime = iso => new Date(iso).toLocaleTimeString('ca-ES', { timeZone: tzName(), hour: '2-digit', minute: '2-digit' });
  const fmtDT = iso => new Date(iso).toLocaleString('ca-ES', { timeZone: tzName(), day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  /* ---------- IndexedDB: cua offline ---------- */
  const idb = new Promise((res, rej) => {
    const r = indexedDB.open('fichaje', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'uuid' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const store = async mode => (await idb).transaction('queue', mode).objectStore('queue');
  const qAll = async () => new Promise(async res => { const r = (await store('readonly')).getAll(); r.onsuccess = () => res(r.result || []); });
  const qPut = async item => new Promise(async res => { const r = (await store('readwrite')).put(item); r.onsuccess = res; });
  const qDel = async id => new Promise(async res => { const r = (await store('readwrite')).delete(id); r.onsuccess = res; });

  /* ---------- API ---------- */
  class NetError extends Error {}
  async function api(path, opts = {}) {
    let r;
    try {
      r = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    } catch { throw new NetError('Sense connexió'); }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/login') { logout(); throw new Error('Sessió caducada'); }
    if (!r.ok) { const e = new Error(data.error || 'Error'); Object.assign(e, data, { status: r.status }); throw e; }
    return data;
  }

  function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }

  /** Diàleg modal genèric. Retorna FormData o null si es cancel·la. */
  function ask({ title, msg = '', body = '', ok = 'Confirmar' }) {
    return new Promise(resolve => {
      const d = $('#dlg'); $('#dlgTitle').textContent = title; $('#dlgMsg').textContent = msg; $('#dlgBody').innerHTML = body; $('#dlgOk').textContent = ok;
      const form = $('#dlgForm');
      const onClose = () => { d.removeEventListener('close', onClose); resolve(d.returnValue === 'ok' ? new FormData(form) : null); };
      d.returnValue = ''; d.addEventListener('close', onClose); d.showModal();
    });
  }

  /* ---------- Sessió ---------- */
  function show(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id); }
  function logout() { token = null; me = null; localStorage.removeItem('token'); localStorage.removeItem('me'); show('login'); }
  $('#logout').onclick = async () => {
    const pending = (await qAll()).length;
    if (pending && !confirm(`Tens ${pending} registres pendents de sincronitzar. Si surts es mantindran al dispositiu. Continuar?`)) return;
    logout();
  };
  $('#loginForm').onsubmit = async e => {
    e.preventDefault(); $('#loginErr').textContent = '';
    const f = new FormData(e.target);
    try {
      const r = await api('/login', { method: 'POST', body: { tip: f.get('tip'), password: f.get('password') } });
      token = r.token; localStorage.setItem('token', token);
      await refresh(); show('main'); e.target.reset();
    } catch (err) { $('#loginErr').textContent = err instanceof NetError ? 'Cal connexió per iniciar sessió' : err.message; }
  };

  async function refresh() {
    try { me = await api('/worker/me'); localStorage.setItem('me', JSON.stringify(me)); } catch (e) { if (!(e instanceof NetError)) throw e; }
    render();
  }

  /* ---------- Render principal ---------- */
  function siteById(id) { return me && me.sites.find(s => s.id === id); }
  function guessShift() {
    if (!me) return null; const now = Date.now();
    return me.upcoming_shifts.find(s => Date.parse(s.planned_start) - 4 * 3600e3 <= now && Date.parse(s.planned_end) >= now) || null;
  }

  function render() {
    if (!me) return;
    $('#uName').textContent = me.user.name; $('#uTip').textContent = 'TIP ' + me.user.tip;
    const st = me.state;
    const card = $('#stateCard'); card.className = 'card state ' + st;
    const label = { off: 'Fora de servei', working: 'En servei', break: 'En pausa' }[st];
    const since = st === 'break' && me.open_break ? me.open_break.occurred_at : me.open_in && me.open_in.occurred_at;
    card.innerHTML = `<div class="big">${label}</div><div class="clock" id="clock"></div>${since ? `<div>des de les ${fmtTime(since)} · <span id="elapsed"></span></div>` : ''}`;
    tick();

    const sh = me.current_shift || guessShift();
    const site = sh ? siteById(sh.site_id) : me.open_in && siteById(me.open_in.site_id);
    $('#shiftCard').innerHTML = sh
      ? `<div class="kv"><span>Servei</span><b>${esc(sh.client_name || (site && site.client_name) || '')}</b><span>Instal·lació</span><b>${esc(sh.site_name || (site && site.name) || '')}</b>
         <span>Horari previst</span><b>${fmtDT(sh.planned_start)} – ${fmtTime(sh.planned_end)}</b></div>`
      : '<div class="fine">No tens cap torn assignat ara mateix al quadrant.</div>';

    const a = $('#actions'); a.innerHTML = '';
    const btn = (cls, type, text, sub) => { const b = document.createElement('button'); b.className = 'act ' + cls; b.innerHTML = `${text}<small>${sub}</small>`; b.onclick = () => punch(type); a.appendChild(b); };
    if (st === 'off') btn('in', 'IN', 'Iniciar jornada', 'Es registrarà la ubicació només en aquest moment');
    if (st === 'working') { btn('brk', 'BREAK_START', 'Iniciar pausa', "Temps d'entrepà"); btn('out', 'OUT', 'Finalitzar jornada', 'Fitxatge de sortida'); }
    if (st === 'break') { btn('brk-end', 'BREAK_END', 'Finalitzar pausa', 'Tornar al servei'); btn('out', 'OUT', 'Finalitzar jornada', 'Fitxatge de sortida'); }

    $('#lastEvents').innerHTML = (me.last_events || []).map(e => `<li><span>${TYPE[e.type]}</span><span>${fmtDT(e.occurred_at)}
      ${e.origin === 'offline' ? '<span class="tag off">offline</span>' : ''}${e.pending ? '<span class="tag off">pendent</span>' : ''}${e.needs_review ? '<span class="tag rev">revisió</span>' : ''}</span></li>`).join('') || '<li>Sense registres recents</li>';
    renderQueue();
  }

  function tick() {
    const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('ca-ES', { timeZone: tzName() });
    const el = $('#elapsed');
    if (el && me) {
      const since = me.state === 'break' && me.open_break ? me.open_break.occurred_at : me.open_in && me.open_in.occurred_at;
      if (since) { const m = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60e3)); el.textContent = `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; }
    }
  }
  setInterval(tick, 1000);

  async function renderQueue() {
    const q = await qAll(); const box = $('#queueInfo');
    box.classList.toggle('hidden', !q.length);
    box.innerHTML = q.length ? `⚠️ ${q.length} registre(s) desat(s) al mòbil pendents d'enviar. Es sincronitzaran automàticament en recuperar la cobertura, mantenint l'hora real.
      <button class="btn small" id="syncNow">Sincronitzar ara</button>` : '';
    const b = $('#syncNow'); if (b) b.onclick = () => flush(true);
  }

  /* ---------- Geolocalització puntual ---------- */
  function locate() {
    return new Promise(res => {
      if (!navigator.geolocation) return res({ location_status: 'unavailable' });
      navigator.geolocation.getCurrentPosition(
        p => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), location_status: 'ok' }),
        err => res({ location_status: err.code === 1 ? 'denied' : 'unavailable' }),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    });
  }
  function haversine(a, b, c, d) {
    const R = 6371000, r = x => x * Math.PI / 180, dl = r(c - a), dg = r(d - b);
    const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dg / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async function askJustification(msg) {
    const f = await ask({ title: 'Justificació necessària', msg, body: '<label>Motiu<textarea name="j" required minlength="5" rows="3" placeholder="Ex.: accés per la porta de mercaderies, sense senyal GPS al soterrani..."></textarea></label>' });
    return f ? String(f.get('j')).trim() : null;
  }
  async function askLateReason(min) {
    const opts = Object.entries(me.catalog.late_reasons).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    const f = await ask({ title: 'Prolongació de jornada', msg: `Surts ${min} min més tard de l'hora prevista. Indica el motiu; quedarà vinculat al part de servei.`,
      body: `<label>Motiu<select name="r" required>${opts}</select></label><label>Detall (obligatori si "Altres")<input name="t" maxlength="300"></label>` });
    if (!f) return null;
    if (f.get('r') === 'ALTRES' && !String(f.get('t')).trim()) { toast('Cal especificar el motiu'); return askLateReason(min); }
    return { late_reason: f.get('r'), late_reason_text: String(f.get('t') || '').trim() };
  }
  async function askSite() {
    const opts = me.sites.map(s => `<option value="${s.id}">${esc(s.client_name)} · ${esc(s.name)}</option>`).join('');
    const f = await ask({ title: 'Instal·lació', msg: 'No tens torn assignat. Selecciona on estàs prestant servei.', body: `<label>Instal·lació<select name="s">${opts}</select></label>` });
    return f ? Number(f.get('s')) : null;
  }

  /* ---------- Fitxatge ---------- */
  async function punch(type) {
    if (busy) return; busy = true;
    try {
      const data = { type };
      const sh = me.current_shift || guessShift();
      const siteId = type === 'IN' ? (sh && sh.site_id) : (me.open_in && me.open_in.site_id);
      const site = siteById(siteId);

      if (type === 'BREAK_START') {
        if (site && site.solo_post) data.cannot_leave_post = true;
        else {
          const f = await ask({ title: 'Inici de pausa', body: '<label class="check"><input type="checkbox" name="c"> No puc abandonar el lloc de servei durant la pausa (computa com a treball efectiu)</label>', ok: 'Iniciar pausa' });
          if (!f) return; data.cannot_leave_post = !!f.get('c');
        }
      }
      if (type === 'OUT' && sh && sh.planned_end) {
        const late = Math.floor((Date.now() - Date.parse(sh.planned_end)) / 60e3);
        if (late > me.settings.late_tolerance_min) { const r = await askLateReason(late); if (!r) return; Object.assign(data, r); }
      }
      if (type === 'IN' && !site) { const s = await askSite(); if (!s) return; data.site_id = s; }

      toast('Obtenint ubicació…', 2000);
      Object.assign(data, await locate());
      const target = site || siteById(data.site_id);
      if (target && target.lat != null) {
        if (data.location_status === 'ok') {
          const dist = haversine(data.lat, data.lng, target.lat, target.lng) - Math.min(data.accuracy || 0, 100);
          if (dist > target.radius_m && me.settings.geofence_policy === 'justify') {
            const j = await askJustification(`Ets a uns ${Math.round(dist)} m de la instal·lació (radi ${target.radius_m} m).`); if (!j) return; data.justification = j;
          }
        } else {
          const j = await askJustification("No s'ha pogut obtenir la ubicació."); if (!j) return; data.justification = j;
        }
      }
      await send(data);
    } finally { busy = false; }
  }

  async function send(data, item = { uuid: uuid(), kind: 'event', device_time: new Date().toISOString() }) {
    item.data = data;
    try {
      if (!navigator.onLine) throw new NetError();
      const r = await api('/worker/events', { method: 'POST', body: { ...data, uuid: item.uuid, device_time: item.device_time } });
      me = { ...me, ...r.state }; localStorage.setItem('me', JSON.stringify(me));
      toast(`${TYPE[data.type]} registrada a les ${fmtTime(r.event.occurred_at)}${r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''}`, 5000);
      render();
    } catch (e) {
      if (e instanceof NetError) return queueLocal(item);
      if (e.code === 'GEOFENCE_JUSTIFICATION_REQUIRED' || e.code === 'LOCATION_JUSTIFICATION_REQUIRED') {
        const j = await askJustification(e.error); if (j) return send({ ...data, justification: j }, item);
      } else if (e.code === 'LATE_REASON_REQUIRED') {
        const r = await askLateReason(e.late_minutes); if (r) return send({ ...data, ...r }, item);
      } else if (e.code === 'SITE_REQUIRED') {
        const s = await askSite(); if (s) return send({ ...data, site_id: s }, item);
      } else toast(e.message, 5000);
    }
  }

  /** Desa el fitxatge al dispositiu i actualitza l'estat local de forma optimista. */
  async function queueLocal(item) {
    await qPut(item);
    const d = item.data; const at = item.device_time;
    if (d.type === 'IN') { const sh = guessShift(); me.state = 'working'; me.open_in = { occurred_at: at, site_id: sh ? sh.site_id : d.site_id, shift_id: sh ? sh.id : null }; me.current_shift = sh; }
    if (d.type === 'BREAK_START') { me.state = 'break'; me.open_break = { occurred_at: at, paid: !!d.cannot_leave_post }; }
    if (d.type === 'BREAK_END') { me.state = 'working'; me.open_break = null; }
    if (d.type === 'OUT') { me.state = 'off'; me.open_in = null; me.open_break = null; me.current_shift = null; }
    me.last_events = [{ type: d.type, occurred_at: at, pending: true }, ...(me.last_events || [])].slice(0, 8);
    localStorage.setItem('me', JSON.stringify(me));
    toast(`Sense cobertura: ${TYPE[d.type] || 'registre'} desat al mòbil (${fmtTime(at)}). S'enviarà automàticament.`, 5000);
    render();
  }

  let flushing = false;
  async function flush(manual = false) {
    if (flushing || !token) return; flushing = true;
    try {
      const items = (await qAll()).sort((a, b) => a.device_time.localeCompare(b.device_time));
      if (!items.length) return;
      const r = await api('/worker/sync', { method: 'POST', body: { sent_at: new Date().toISOString(), items } });
      const errs = [];
      for (const res of r.results) {
        if (res.ok || res.permanent) await qDel(res.uuid);
        if (!res.ok) errs.push(res.error);
      }
      me = { ...me, ...r.state }; localStorage.setItem('me', JSON.stringify(me));
      render();
      toast(errs.length ? `Sincronitzat amb incidències: ${errs.join('; ')}` : `${r.results.length} registre(s) sincronitzat(s)`, 6000);
    } catch (e) { if (manual) toast(e instanceof NetError ? 'Encara sense connexió' : e.message); }
    finally { flushing = false; }
  }

  function netStatus() {
    const n = $('#net'); n.classList.toggle('hidden', navigator.onLine);
    n.textContent = 'Sense connexió · els fitxatges es desaran al mòbil';
    if (navigator.onLine && token) { flush(); refresh(); }
  }
  window.addEventListener('online', netStatus); window.addEventListener('offline', netStatus);
  setInterval(() => { if (navigator.onLine) flush(); }, 30000);

  /* ---------- Pestanyes ---------- */
  for (const b of document.querySelectorAll('nav.bottom button')) {
    b.onclick = () => {
      for (const x of document.querySelectorAll('nav.bottom button')) x.classList.toggle('active', x === b);
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('hidden', t.id !== 'tab-' + b.dataset.tab);
      if (b.dataset.tab === 'part') sizeCanvas();
      if (b.dataset.tab === 'hist') loadHist();
    };
  }

  /* ---------- Part de servei ---------- */
  function addIncident() {
    const div = document.createElement('div'); div.className = 'incident';
    const opts = Object.entries(me.catalog.incident_types).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    const d0 = new Date(); const now = `${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`;
    div.innerHTML = `<button type="button" class="btn ghost small rm">✕</button><div class="row"><select name="type">${opts}</select><input type="time" name="time" value="${now}"></div>
      <textarea name="desc" rows="2" placeholder="Descripció de la incidència" required maxlength="4000"></textarea>`;
    div.querySelector('.rm').onclick = () => div.remove();
    $('#incidents').appendChild(div);
  }
  $('#addIncident').onclick = addIncident;

  const canvas = $('#sig'); const ctx = canvas.getContext('2d'); let drawing = false; let signed = false;
  function sizeCanvas() { const w = canvas.clientWidth; if (w && canvas.width !== w) { canvas.width = w; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#0b1a2e'; signed = false; } }
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => { drawing = true; canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  canvas.addEventListener('pointermove', e => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); signed = true; });
  canvas.addEventListener('pointerup', () => { drawing = false; });
  $('#sigClear').onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); signed = false; };

  /** Converteix una hora HH:MM (local) a ISO, assumint el dia del servei (o l'anterior si és futura). */
  function timeToIso(hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0);
    if (d.getTime() > Date.now() + 5 * 60e3) d.setDate(d.getDate() - 1);
    return d.toISOString();
  }

  $('#reportForm').onsubmit = async e => {
    e.preventDefault();
    if (!signed) return toast('Cal signar el part');
    const f = new FormData(e.target);
    const incidents = [...document.querySelectorAll('#incidents .incident')].map(d => ({
      type: d.querySelector('[name=type]').value, occurred_at: timeToIso(d.querySelector('[name=time]').value), description: d.querySelector('[name=desc]').value.trim(),
    })).filter(i => i.description);
    const data = { incidents, no_incidents: !!f.get('no_incidents'), summary: f.get('summary'), signature_png: canvas.toDataURL('image/png') };
    if (!incidents.length && !data.no_incidents && !String(data.summary).trim()) return toast('Afegeix incidències o marca "Sense novetats"');
    const item = { uuid: uuid(), kind: 'report', device_time: new Date().toISOString(), data };
    const reset = () => { e.target.reset(); $('#incidents').innerHTML = ''; ctx.clearRect(0, 0, canvas.width, canvas.height); signed = false; };
    try {
      if (!navigator.onLine) throw new NetError();
      const r = await api('/worker/reports', { method: 'POST', body: { ...data, uuid: item.uuid, device_time: item.device_time } });
      toast(`Part enviat i segellat a les ${fmtTime(r.report.signed_at)}`); reset();
    } catch (err) {
      if (err instanceof NetError) { await qPut(item); toast("Sense cobertura: part desat al mòbil. S'enviarà automàticament."); reset(); renderQueue(); }
      else toast(err.message, 5000);
    }
  };

  /* ---------- Historial ---------- */
  async function loadHist() {
    const m = $('#histMonth'); if (!m.value) m.value = new Date().toISOString().slice(0, 7);
    try {
      const h = await api('/worker/hours?month=' + m.value); const t = h.totals;
      $('#hours').innerHTML = `<div class="kv"><span>Hores treballades</span><b>${t.worked_h} h</b><span>Hores del quadrant</span><b>${t.planned_h} h</b>
        <span>Jornada mensual</span><b>${t.contract_h} h</b><span>Nocturnes (22–06 h)</span><b>${t.night_h} h</b><span>Cap de setmana</span><b>${t.weekend_h} h</b>
        <span>Festius</span><b>${t.holiday_h} h</b><span>Prolongacions</span><b>${t.prolongation_h} h</b><span>Pauses computades</span><b>${t.paid_break_h} h</b>
        <span>${h.closed ? 'Hores extra (mes tancat)' : 'Excés provisional'}</span><b>${t.overtime_h} h</b></div>
        ${h.anomalies.length ? `<p class="err">${h.anomalies.length} anomalia(es) pendents de revisar per RRHH</p>` : ''}`;
      const r = await api('/worker/reports');
      $('#myReports').innerHTML = r.reports.map(x => `<li><span>${esc(x.site_name)}</span><span>${fmtDT(x.signed_at)}</span></li>`).join('') || '<li>Cap part enviat</li>';
    } catch (e) { $('#hours').textContent = e instanceof NetError ? 'Cal connexió per consultar les hores.' : e.message; }
  }
  $('#histMonth').onchange = loadHist;

  /* ---------- Arrencada ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  if (token) { show('main'); render(); refresh().then(() => flush()).catch(() => {}); } else show('login');
  netStatus();
})();
