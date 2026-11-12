/* FichajeBull · Panell d'administració (RRHH, Operacions, CECOA) */
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let token = sessionStorage.getItem('atoken');
  let user = JSON.parse(sessionStorage.getItem('auser') || 'null');
  let settings = { timezone: 'Europe/Madrid' };
  let es = null;
  const can = p => user && user.permissions.includes(p);
  const TZ = () => settings.timezone;
  const fDT = iso => iso ? new Date(iso).toLocaleString('ca-ES', { timeZone: TZ(), day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const fT = iso => iso ? new Date(iso).toLocaleTimeString('ca-ES', { timeZone: TZ(), hour: '2-digit', minute: '2-digit' }) : '';
  const thisMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ() }).slice(0, 7);
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ() });
  const TYPE = { IN: 'Entrada', OUT: 'Sortida', BREAK_START: 'Inici pausa', BREAK_END: 'Fi pausa' };
  const STATUS = { EN_SERVEI: 'En servei', EN_SERVEI_AMB_RETARD: 'En servei (retard)', PAUSA: 'Pausa', PROLONGACIO: 'Prolongació', RETARD: 'Retard', ABSENT: 'Absent', PENDENT: 'Pendent', FINALITZAT: 'Finalitzat' };
  const LATE = { ESPERA_RELLEU: 'Espera de relleu', INCIDENCIA_SERVEI: 'Incidència servei', ORDRE_SUPERIOR: 'Ordre superior', ALTRES: 'Altres' };

  async function api(path, opts = {}) {
    const isText = typeof opts.body === 'string';
    const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'Content-Type': isText ? 'text/plain' : 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body == null ? undefined : isText ? opts.body : JSON.stringify(opts.body) });
    if (r.status === 401 && path !== '/login') { logout(); throw new Error('Sessió caducada'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
    return d;
  }
  async function download(path, fallbackName) {
    const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Error'); }
    const cd = r.headers.get('content-disposition') || ''; const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function toast(m, ms = 4000) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 6000); } };

  /** Modal amb formulari. Retorna objecte amb els camps o null. */
  function modal(title, inner, okText = 'Desar') {
    return new Promise(res => {
      const d = $('#dlg');
      $('#dlgBody').innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${inner}<div class="dlg-actions"><button class="btn" value="x" formnovalidate>Cancel·lar</button><button class="btn primary" value="ok">${esc(okText)}</button></div></form>`;
      const f = d.querySelector('form');
      d.onclose = () => { if (d.returnValue !== 'ok') return res(null); const o = {}; for (const [k, v] of new FormData(f)) o[k] = v; for (const c of f.querySelectorAll('input[type=checkbox]')) o[c.name] = c.checked; res(o); };
      d.returnValue = ''; d.showModal();
    });
  }
  const table = (cols, rows, rowCls = () => '') => `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>
    ${rows.length ? rows.map(r => `<tr class="${rowCls(r)}">${cols.map(c => `<td class="${c.num ? 'num' : ''} ${c.wrap ? 'wrap' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="muted">Sense dades</td></tr>`}</tbody></table></div>`;
  const opts = (list, val, fmt, empty) => (empty ? `<option value="">${empty}</option>` : '') + list.map(x => `<option value="${x.id}" ${String(x.id) === String(val) ? 'selected' : ''}>${esc(fmt(x))}</option>`).join('');

  /* ---------- Login ---------- */
  function logout() { token = null; user = null; sessionStorage.clear(); if (es) es.close(); $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }
  $('#logout').onclick = logout;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try {
      const r = await api('/login', { method: 'POST', body: { tip: f.get('tip'), password: f.get('password') } });
      if (!r.user.permissions.includes('dashboard')) throw new Error('Aquest usuari no té accés al panell. Utilitza l\'app de vigilant (/app/).');
      token = r.token; user = r.user; sessionStorage.setItem('atoken', token); sessionStorage.setItem('auser', JSON.stringify(user)); start();
    } catch (err) { $('#loginErr').textContent = err.message; }
  };

  /* ---------- Navegació ---------- */
  const VIEWS = [
    ['dashboard', 'Temps real', 'dashboard', viewDashboard],
    ['quadrants', 'Quadrants', 'dashboard', viewShifts],
    ['registres', 'Registres i correccions', 'dashboard', viewEvents],
    ['hores', 'Còmput mensual', 'hours', viewHours],
    ['parts', 'Parts de servei', 'reports.read', viewReports],
    ['inspeccio', 'Inspecció de Treball', 'export', viewExport],
    ['usuaris', 'Personal', 'dashboard', viewUsers],
    ['installacions', 'Clients i instal·lacions', 'dashboard', viewSites],
    ['auditoria', 'Auditoria i integritat', 'audit', viewAudit],
    ['config', 'Configuració', 'dashboard', viewSettings],
  ];
  function route() {
    const id = location.hash.slice(1) || 'dashboard';
    const v = VIEWS.find(x => x[0] === id && can(x[2])) || VIEWS[0];
    for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.id === v[0]);
    if (es && v[0] !== 'dashboard') { es.close(); es = null; }
    $('#view').innerHTML = '<p class="muted">Carregant…</p>';
    guard(v[3])();
  }
  async function start() {
    $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
    $('#who').textContent = `${user.name} · ${user.role}`;
    $('#nav').innerHTML = VIEWS.filter(v => can(v[2])).map(v => `<a href="#${v[0]}" data-id="${v[0]}">${v[1]}</a>`).join('');
    try { settings = (await api('/admin/settings')).settings; } catch {}
    route();
  }
  window.addEventListener('hashchange', route);

  /* ---------- Dashboard ---------- */
  async function viewDashboard() {
    const date = $('#dDate')?.value || today();
    const d = await api('/admin/dashboard?date=' + date); const s = d.summary;
    $('#view').innerHTML = `<h1><span class="live"></span>Estat dels serveis</h1>
      <div class="toolbar"><label>Data<input type="date" id="dDate" value="${d.date}"></label><button class="btn" id="dRef">Actualitzar</button>
      <span class="muted">Actualitzat ${fT(d.generated_at)} · s'actualitza automàticament</span></div>
      <div class="kpis">
        <div class="kpi"><b>${s.total}</b><span>Torns del dia</span></div>
        <div class="kpi ok"><b>${s.covered}</b><span>Coberts ara</span></div>
        <div class="kpi warn"><b>${s.late}</b><span>Retards</span></div>
        <div class="kpi bad"><b>${s.absent}</b><span>Absències sense fitxar</span></div>
        <div class="kpi bad"><b>${s.critical_uncovered}</b><span>Llocs crítics descoberts</span></div>
        <div class="kpi"><b>${s.prolonging}</b><span>En prolongació</span></div>
      </div>
      ${table([
        { h: 'Estat', f: r => `<span class="pill s-${r.status}">${STATUS[r.status]}</span>` },
        { h: 'Vigilant', f: r => `${esc(r.user_name)} <span class="muted">${esc(r.tip)}</span>` },
        { h: 'Servei', f: r => `${r.critical ? '⚠️ ' : ''}${esc(r.client_name)} · ${esc(r.site_name)}` },
        { h: 'Previst', f: r => `${fT(r.planned_start)}–${fT(r.planned_end)}` },
        { h: 'Entrada', f: r => fT(r.in_at) + (r.late_minutes > 0 ? ` <span class="flag">+${r.late_minutes}′</span>` : '') },
        { h: 'Sortida', f: r => fT(r.out_at) },
        { h: 'Alertes', f: r => [r.outside_geofence ? 'Fora de radi' : '', r.needs_review ? 'Revisió' : ''].filter(Boolean).map(x => `<span class="flag">${x}</span>`).join(' ') },
      ], d.shifts, r => '')}
      <h2>Activitat en directe</h2><div class="card feed" id="feed"><div class="muted">Esperant fitxatges…</div></div>`;
    $('#dRef').onclick = guard(viewDashboard); $('#dDate').onchange = guard(viewDashboard);
    if (!es) {
      es = new EventSource('/api/admin/stream?access_token=' + encodeURIComponent(token));
      const push = txt => { const f = $('#feed'); if (!f) return; if (f.querySelector('.muted')) f.innerHTML = ''; f.insertAdjacentHTML('afterbegin', `<div>${fT(new Date().toISOString())} · ${txt}</div>`); };
      es.addEventListener('event', e => { const x = JSON.parse(e.data); push(`<b>${esc(x.user_name)}</b> ${TYPE[x.type]} ${x.needs_review ? '<span class="flag">revisió</span>' : ''}`); clearTimeout(viewDashboard.t); viewDashboard.t = setTimeout(guard(refreshDash), 800); });
      es.addEventListener('report', e => { const x = JSON.parse(e.data); push(`<b>${esc(x.user_name)}</b> ha enviat un part de ${esc(x.site_name)} (${x.incidents} incidències)`); });
    }
    clearInterval(viewDashboard.iv); viewDashboard.iv = setInterval(() => { if (location.hash.slice(1) === 'dashboard' || !location.hash) guard(refreshDash)(); else clearInterval(viewDashboard.iv); }, 60000);
  }
  async function refreshDash() { const feed = $('#feed')?.innerHTML; await viewDashboard(); if (feed && $('#feed')) $('#feed').innerHTML = feed; }

  /* ---------- Quadrants ---------- */
  async function viewShifts() {
    const month = $('#sMonth')?.value || thisMonth();
    const [sh, us, st, cmp] = await Promise.all([api('/admin/shifts?month=' + month), api('/admin/users'), api('/admin/sites'), api('/admin/shifts/compare?month=' + month)]);
    const w = can('shifts.write');
    $('#view').innerHTML = `<h1>Quadrants</h1>
      <div class="toolbar"><label>Mes<input type="month" id="sMonth" value="${month}"></label>
      ${w ? '<button class="btn primary" id="sNew">+ Nou torn</button><button class="btn" id="sImp">Importar quadrant (CSV)</button>' : ''}</div>
      <h2>Quadrant teòric vs. hores reals</h2>
      ${table([
        { h: 'Treballador', f: r => `${esc(r.user.name)} <span class="muted">${esc(r.user.tip)}</span>` },
        { h: 'Quadrant', num: 1, f: r => r.totals.planned_h }, { h: 'Real', num: 1, f: r => r.totals.worked_h },
        { h: 'Diferència', num: 1, f: r => `<span class="${Math.abs(r.totals.diff_vs_planned_h) > 1 ? 'flag' : ''}">${r.totals.diff_vs_planned_h > 0 ? '+' : ''}${r.totals.diff_vs_planned_h}</span>` },
        { h: 'Jornada', num: 1, f: r => r.totals.contract_h }, { h: 'Anomalies', num: 1, f: r => r.anomalies ? `<span class="flag">${r.anomalies}</span>` : '0' },
      ], cmp.rows)}
      <h2>Torns planificats (${sh.shifts.length})</h2>
      ${table([
        { h: 'Inici', f: r => fDT(r.planned_start) }, { h: 'Fi', f: r => fDT(r.planned_end) },
        { h: 'Vigilant', f: r => `${esc(r.user_name)} <span class="muted">${esc(r.tip)}</span>` }, { h: 'Servei', f: r => `${esc(r.client_name)} · ${esc(r.site_name)}` },
        { h: 'Estat', f: r => r.status === 'cancelled' ? '<span class="muted">Cancel·lat</span>' : 'Planificat' },
        { h: '', f: r => w && r.status === 'planned' ? `<button class="btn small danger" data-cancel="${r.id}">Cancel·lar</button>` : '' },
      ], sh.shifts)}`;
    $('#sMonth').onchange = guard(viewShifts);
    if (!w) return;
    for (const b of document.querySelectorAll('[data-cancel]')) b.onclick = guard(async () => {
      const f = await modal('Cancel·lar torn', '<label>Motiu<input name="reason" required></label>', 'Cancel·lar torn'); if (!f) return;
      await api(`/admin/shifts/${b.dataset.cancel}/cancel`, { method: 'POST', body: f }); toast('Torn cancel·lat'); viewShifts();
    });
    $('#sNew').onclick = guard(async () => {
      const f = await modal('Nou torn', `<label>Vigilant<select name="user_id" required>${opts(us.users.filter(u => u.active), '', u => `${u.name} (${u.tip})`)}</select></label>
        <label>Instal·lació<select name="site_id" required>${opts(st.sites.filter(s => s.active), '', s => `${s.client_name} · ${s.name}`)}</select></label>
        <div class="grid2"><label>Inici<input type="datetime-local" name="s" required></label><label>Fi<input type="datetime-local" name="e" required></label></div>
        <label>Notes<input name="notes"></label>`);
      if (!f) return;
      await api('/admin/shifts', { method: 'POST', body: { user_id: f.user_id, site_id: f.site_id, planned_start: new Date(f.s).toISOString(), planned_end: new Date(f.e).toISOString(), notes: f.notes } });
      toast('Torn creat'); viewShifts();
    });
    $('#sImp').onclick = guard(async () => {
      const f = await modal('Importar quadrant', `<p class="muted">Una línia per torn: <code>TIP;Instal·lació (id o nom);AAAA-MM-DD;HH:MM;HH:MM;notes</code>. Si l'hora de fi és anterior a la d'inici, el torn acaba l'endemà.</p>
        <label>Fitxer CSV<input type="file" id="csvFile" accept=".csv,.txt"></label><label>o enganxa el contingut<textarea name="csv" rows="8" placeholder="123456;Accés principal;2026-11-01;07:00;19:00"></textarea></label>`, 'Importar');
      if (!f) return;
      const file = document.getElementById('csvFile')?.files?.[0];
      const text = file ? await file.text() : f.csv;
      const r = await api('/admin/shifts/import', { method: 'POST', body: String(text || '') });
      toast(`${r.created} torns importats${r.errors.length ? ` · ${r.errors.length} errors: ` + r.errors.slice(0, 3).map(e => `línia ${e.line}: ${e.error}`).join('; ') : ''}`, 9000); viewShifts();
    });
  }

  /* ---------- Registres ---------- */
  async function viewEvents() {
    const month = $('#eMonth')?.value || thisMonth(); const uid = $('#eUser')?.value || ''; const rev = $('#eRev')?.checked;
    const [ev, us] = await Promise.all([api(`/admin/events?month=${month}${uid ? '&user_id=' + uid : ''}${rev ? '&review=1' : ''}`), api('/admin/users')]);
    const c = can('records.correct');
    $('#view').innerHTML = `<h1>Registres de jornada</h1>
      <div class="card muted">Els registres són <b>immutables</b>: ningú, ni l'administrador, pot esborrar-los ni modificar-los. Qualsevol correcció queda com a anotació auditada (autor, data i motiu) i l'original es conserva.</div>
      <div class="toolbar"><label>Mes<input type="month" id="eMonth" value="${month}"></label>
      <label>Treballador<select id="eUser">${opts(us.users, uid, u => `${u.name} (${u.tip})`, 'Tots')}</select></label>
      <label class="check"><input type="checkbox" id="eRev" ${rev ? 'checked' : ''}> Només pendents de revisió</label>
      ${c ? '<button class="btn primary" id="eAdd">+ Afegir fitxatge oblidat</button>' : ''}</div>
      ${table([
        { h: 'Data i hora', f: r => fDT(r.occurred_at) }, { h: 'Tipus', f: r => TYPE[r.type] },
        { h: 'Treballador', f: r => `${esc(r.user_name)} <span class="muted">${esc(r.tip)}</span>` }, { h: 'Instal·lació', f: r => esc(r.site_name || '') },
        { h: 'Origen', f: r => r.origin }, { h: 'GPS', f: r => r.within_geofence === 0 ? `<span class="flag">${r.distance_m} m</span>` : r.within_geofence === 1 ? `✓ ${r.distance_m} m` : `<span class="muted">${r.location_status}</span>` },
        { h: 'Detall', wrap: 1, f: r => [r.justification && `Just.: ${esc(r.justification)}`, r.late_minutes && `Prolongació ${r.late_minutes}′ (${LATE[r.late_reason] || 'sense motiu'})`, r.type === 'BREAK_START' && (r.break_paid ? 'Pausa computable' : 'Pausa descomptada'),
          r.review_reasons && `<span class="flag">${JSON.parse(r.review_reasons).map(esc).join('; ')}</span>`, ...r.corrections.map(x => `<i>Correcció (${x.action}) ${fDT(x.created_at)}: ${esc(x.reason)}</i>`)].filter(Boolean).join('<br>') },
        { h: '', f: r => c && !r.annulled ? `<button class="btn small" data-mod="${r.id}">Corregir</button> <button class="btn small danger" data-ann="${r.id}">Anul·lar</button>` : r.annulled ? 'ANUL·LAT' : '' },
      ], ev.events.slice().reverse(), r => r.annulled ? 'annulled' : '')}`;
    $('#eMonth').onchange = $('#eUser').onchange = $('#eRev').onchange = guard(viewEvents);
    if (!c) return;
    const reason = '<label>Motiu justificat (obligatori, mín. 10 caràcters)<textarea name="reason" required minlength="10" rows="3"></textarea></label>';
    for (const b of document.querySelectorAll('[data-mod]')) b.onclick = guard(async () => {
      const e = ev.events.find(x => x.id === Number(b.dataset.mod));
      const local = new Date(new Date(e.occurred_at).getTime() - new Date(e.occurred_at).getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
      const f = await modal('Corregir registre', `<p class="muted">Original: ${TYPE[e.type]} · ${fDT(e.occurred_at)}</p>
        <label>Nova hora<input type="datetime-local" name="t" value="${local}"></label>
        <label>Tipus<select name="type">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${k === e.type ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        ${e.type === 'BREAK_START' ? `<label class="check"><input type="checkbox" name="bp" ${e.break_paid ? 'checked' : ''}> Pausa computable com a treball efectiu</label>` : ''}${reason}`);
      if (!f) return;
      const changes = {};
      if (Math.abs(new Date(f.t) - new Date(e.occurred_at)) >= 60e3) changes.occurred_at = new Date(f.t).toISOString();
      if (f.type !== e.type) changes.type = f.type;
      if (e.type === 'BREAK_START' && !!f.bp !== !!e.break_paid) changes.break_paid = f.bp ? 1 : 0;
      if (!Object.keys(changes).length) return toast('No has modificat cap valor');
      await api('/admin/corrections', { method: 'POST', body: { action: 'modify', event_id: e.id, changes, reason: f.reason } }); toast('Correcció registrada'); viewEvents();
    });
    for (const b of document.querySelectorAll('[data-ann]')) b.onclick = guard(async () => {
      const f = await modal('Anul·lar registre', `<p class="muted">El registre es conservarà però deixarà de computar.</p>${reason}`, 'Anul·lar'); if (!f) return;
      await api('/admin/corrections', { method: 'POST', body: { action: 'annul', event_id: Number(b.dataset.ann), reason: f.reason } }); toast('Registre anul·lat'); viewEvents();
    });
    $('#eAdd').onclick = guard(async () => {
      const st = await api('/admin/sites');
      const f = await modal('Afegir fitxatge oblidat', `<label>Treballador<select name="user_id" required>${opts(us.users, uid, u => `${u.name} (${u.tip})`)}</select></label>
        <label>Tipus<select name="type">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Instal·lació<select name="site_id">${opts(st.sites, '', s => `${s.client_name} · ${s.name}`, '—')}</select></label>
        <label>Data i hora<input type="datetime-local" name="t" required></label>${reason}`);
      if (!f) return;
      await api('/admin/corrections', { method: 'POST', body: { action: 'add', reason: f.reason, new_event: { user_id: f.user_id, type: f.type, site_id: f.site_id || null, occurred_at: new Date(f.t).toISOString() } } });
      toast('Fitxatge afegit amb anotació d\'auditoria'); viewEvents();
    });
  }

  /* ---------- Còmput mensual ---------- */
  async function viewHours() {
    const month = $('#hMonth')?.value || thisMonth();
    const d = await api('/admin/hours?month=' + month);
    $('#view').innerHTML = `<h1>Còmput mensual d'hores</h1>
      <div class="card muted">Còmput per mes segons el conveni: els torns llargs (p. ex. 12 h) no generen hores extra diàries; l'excés es calcula al tancament de mes respecte a la jornada de cada treballador. Nocturnitat: ${esc(settings.night_start)}–${esc(settings.night_end)}.</div>
      <div class="toolbar"><label>Mes<input type="month" id="hMonth" value="${month}"></label></div>
      ${table([
        { h: 'Treballador', f: r => `<a href="#" data-u="${r.user.id}">${esc(r.user.name)}</a> <span class="muted">${esc(r.user.tip)}</span>` },
        { h: 'Treballades', num: 1, f: r => r.totals.worked_h }, { h: 'Quadrant', num: 1, f: r => r.totals.planned_h }, { h: 'Jornada', num: 1, f: r => r.totals.contract_h },
        { h: 'Extra', num: 1, f: r => r.totals.overtime_h ? `<b>${r.totals.overtime_h}</b>` : 0 }, { h: 'Dèficit', num: 1, f: r => r.totals.deficit_h },
        { h: 'Nocturnes', num: 1, f: r => r.totals.night_h }, { h: 'Cap setm.', num: 1, f: r => r.totals.weekend_h }, { h: 'Festius', num: 1, f: r => r.totals.holiday_h },
        { h: 'Prolong.', num: 1, f: r => r.totals.prolongation_h }, { h: 'Pausa comp.', num: 1, f: r => r.totals.paid_break_h },
        { h: 'Anomalies', f: r => r.anomalies.length ? `<span class="flag">${r.anomalies.length}</span>` : '' },
      ], d.rows)}<div id="hDetail"></div>`;
    $('#hMonth').onchange = guard(viewHours);
    for (const a of document.querySelectorAll('[data-u]')) a.onclick = guard(async ev => {
      ev.preventDefault();
      const m = await api(`/admin/hours?month=${month}&user_id=${a.dataset.u}`);
      $('#hDetail').innerHTML = `<h2>Detall · ${esc(m.user.name)} · ${m.month}</h2>
        ${m.anomalies.length ? `<div class="card"><b class="flag">Anomalies</b><br>${m.anomalies.map(x => `${fDT(x.at)} · ${esc(x.message)}`).join('<br>')}</div>` : ''}
        ${table([{ h: 'Dia', f: r => r.date }, { h: 'Real', num: 1, f: r => r.worked_h }, { h: 'Quadrant', num: 1, f: r => r.planned_h }, { h: 'Nocturnes', num: 1, f: r => r.night_h },
          { h: 'Cap setm.', num: 1, f: r => r.weekend_h }, { h: 'Festiu', num: 1, f: r => r.holiday_h }, { h: 'Pausa comp.', num: 1, f: r => r.paid_break_h }, { h: 'Pausa desc.', num: 1, f: r => r.unpaid_break_h }], m.days)}`;
      $('#hDetail').scrollIntoView({ behavior: 'smooth' });
    });
  }

  /* ---------- Parts de servei ---------- */
  async function viewReports() {
    const q = { from: $('#rFrom')?.value || '', to: $('#rTo')?.value || '', client_id: $('#rClient')?.value || '', type: $('#rType')?.value || '' };
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    const [d, cl] = await Promise.all([api('/admin/reports?' + qs), api('/admin/clients')]);
    $('#view').innerHTML = `<h1>Repositori de parts de servei</h1>
      <div class="toolbar"><label>Des de<input type="date" id="rFrom" value="${q.from}"></label><label>Fins a<input type="date" id="rTo" value="${q.to}"></label>
      <label>Client<select id="rClient">${opts(cl.clients, q.client_id, c => c.name, 'Tots')}</select></label>
      <label>Tipus d'incidència<select id="rType"><option value="">Tots</option>${Object.entries(d.types).map(([k, v]) => `<option value="${k}" ${k === q.type ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <button class="btn" id="rGo">Filtrar</button></div>
      ${table([
        { h: 'Segell', f: r => fDT(r.signed_at) }, { h: 'Vigilant', f: r => `${esc(r.user_name)} <span class="muted">${esc(r.tip)}</span>` },
        { h: 'Servei', f: r => `${esc(r.client_name)} · ${esc(r.site_name)}` },
        { h: 'Incidències', wrap: 1, f: r => r.incident_types ? [...new Set(r.incident_types.split(','))].map(t => `<span class="pill">${esc(d.types[t])}</span>`).join(' ') : (r.no_incidents ? '<span class="muted">Sense novetats</span>' : '') },
        { h: 'Origen', f: r => r.origin },
        { h: '', f: r => `<button class="btn small" data-v="${r.id}">Veure</button> <button class="btn small" data-pdf="${r.id}">PDF</button>${can('reports.send') ? ` <button class="btn small" data-send="${r.id}">Enviar al client</button>` : ''}` },
      ], d.reports)}`;
    $('#rGo').onclick = guard(viewReports);
    for (const b of document.querySelectorAll('[data-pdf]')) b.onclick = guard(() => download(`/admin/reports/${b.dataset.pdf}/pdf`, 'part.pdf'));
    for (const b of document.querySelectorAll('[data-send]')) b.onclick = guard(async () => { const r = await api(`/admin/reports/${b.dataset.send}/send`, { method: 'POST', body: {} }); toast('Part enviat a ' + r.to); });
    for (const b of document.querySelectorAll('[data-v]')) b.onclick = guard(async () => {
      const { report: r } = await api('/admin/reports/' + b.dataset.v);
      await modal(`Part #${r.id} · ${r.site_name}`, `<p><b>${esc(r.user_name)}</b> (TIP ${esc(r.tip)}) · Segell ${fDT(r.signed_at)}${r.shift ? ` · Torn ${fDT(r.shift.planned_start)}–${fT(r.shift.planned_end)}` : ''}</p>
        ${r.incidents.map(i => `<p><span class="pill">${esc(d.types[i.type])}</span> ${fT(i.occurred_at)} ${esc(i.description)}</p>`).join('') || (r.no_incidents ? '<p>Sense novetats.</p>' : '')}
        ${r.summary ? `<p><i>${esc(r.summary)}</i></p>` : ''}
        ${r.prolongations.map(p => `<p class="flag">Prolongació: +${p.late_minutes} min · ${LATE[p.late_reason] || 'sense motiu'} ${esc(p.late_reason_text || '')}</p>`).join('')}
        <p class="muted">Signatura:</p><img src="${r.signature_png}" alt="Signatura" style="max-width:100%;background:#fff;border-radius:8px">
        <p class="muted" style="font-size:.75rem;word-break:break-all">Hash: ${r.hash}</p>`, 'Tancar');
    });
  }

  /* ---------- Exportació ---------- */
  async function viewExport() {
    const us = await api('/admin/users'); const m = thisMonth();
    $('#view').innerHTML = `<h1>Exportació per a la Inspecció de Treball</h1>
      <div class="card">Genera el registre diari de jornada per treballador (inici, fi, pauses, prolongacions, correccions auditades i resum mensual). Totes les exportacions queden registrades a l'auditoria.</div>
      <div class="card"><div class="grid2"><label>Des del mes<input type="month" id="xFrom" value="${m}"></label><label>Fins al mes<input type="month" id="xTo" value="${m}"></label></div>
      <label>Treballadors (cap seleccionat = tots)<select id="xUsers" multiple size="8">${opts(us.users, '', u => `${u.name} (${u.tip})`)}</select></label>
      <div class="toolbar"><button class="btn primary" id="xX">Descarregar Excel</button><button class="btn primary" id="xP">Descarregar PDF</button></div></div>`;
    const go = fmt => guard(async () => {
      const users = [...$('#xUsers').selectedOptions].map(o => o.value).join(',');
      await download(`/admin/export?format=${fmt}&from=${$('#xFrom').value}&to=${$('#xTo').value}${users ? '&users=' + users : ''}`, 'registre.' + fmt); toast('Exportació generada');
    });
    $('#xX').onclick = go('xlsx'); $('#xP').onclick = go('pdf');
  }

  /* ---------- Personal ---------- */
  async function viewUsers() {
    const d = await api('/admin/users'); const w = can('users.write');
    const roles = ['vigilant', 'cecoa', 'operacions', 'rrhh', ...(user.role === 'admin' ? ['admin'] : [])];
    const roleOpts = v => roles.map(r => `<option ${r === v ? 'selected' : ''}>${r}</option>`).join('');
    $('#view').innerHTML = `<h1>Personal</h1>${w ? '<div class="toolbar"><button class="btn primary" id="uNew">+ Nou usuari</button></div>' : ''}
      ${table([{ h: 'TIP', f: r => esc(r.tip) }, { h: 'Nom', f: r => esc(r.name) }, { h: 'Rol', f: r => r.role }, { h: 'Jornada mensual', num: 1, f: r => r.monthly_hours ?? `<span class="muted">${esc(settings.monthly_hours)}</span>` },
        { h: 'Estat', f: r => r.active ? 'Actiu' : '<span class="muted">Baixa</span>' }, { h: '', f: r => w ? `<button class="btn small" data-e="${r.id}">Editar</button>` : '' }], d.users)}`;
    if (!w) return;
    const form = (u = {}) => `<div class="grid2"><label>TIP<input name="tip" value="${esc(u.tip || '')}" ${u.id ? 'disabled' : 'required'}></label><label>Nom<input name="name" value="${esc(u.name || '')}" required></label>
      <label>DNI<input name="dni" value="${esc(u.dni || '')}"></label><label>Correu<input name="email" type="email" value="${esc(u.email || '')}"></label>
      <label>Rol<select name="role">${roleOpts(u.role || 'vigilant')}</select></label><label>Jornada mensual (h, buit = conveni)<input name="monthly_hours" type="number" step="0.5" value="${u.monthly_hours ?? ''}"></label></div>
      <label>${u.id ? 'Nova contrasenya (deixa en blanc per mantenir)' : 'Contrasenya inicial (mín. 8)'}<input name="password" type="password" minlength="8" ${u.id ? '' : 'required'}></label>
      ${u.id ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Actiu</label>` : ''}`;
    $('#uNew').onclick = guard(async () => { const f = await modal('Nou usuari', form()); if (!f) return; await api('/admin/users', { method: 'POST', body: f }); toast('Usuari creat'); viewUsers(); });
    for (const b of document.querySelectorAll('[data-e]')) b.onclick = guard(async () => {
      const u = d.users.find(x => x.id === Number(b.dataset.e)); const f = await modal('Editar usuari', form(u)); if (!f) return;
      if (!f.password) delete f.password; f.active = f.active ? 1 : 0; delete f.tip;
      await api('/admin/users/' + u.id, { method: 'PATCH', body: f }); toast('Usuari actualitzat'); viewUsers();
    });
  }

  /* ---------- Instal·lacions ---------- */
  async function viewSites() {
    const [cl, st] = await Promise.all([api('/admin/clients'), api('/admin/sites')]); const w = can('sites.write');
    $('#view').innerHTML = `<h1>Clients i instal·lacions</h1>${w ? '<div class="toolbar"><button class="btn" id="cNew">+ Nou client</button><button class="btn primary" id="iNew">+ Nova instal·lació</button></div>' : ''}
      <h2>Instal·lacions</h2>${table([{ h: 'Client', f: r => esc(r.client_name) }, { h: 'Instal·lació', f: r => esc(r.name) }, { h: 'Coordenades', f: r => r.lat != null ? `${r.lat}, ${r.lng}` : '<span class="flag">sense</span>' },
        { h: 'Radi', num: 1, f: r => r.radius_m + ' m' }, { h: 'Lloc unipersonal', f: r => r.solo_post ? 'Sí (pausa computable)' : 'No' }, { h: 'Crític', f: r => r.critical ? '⚠️ Sí' : 'No' },
        { h: '', f: r => w ? `<button class="btn small" data-s="${r.id}">Editar</button>` : '' }], st.sites)}
      <h2>Clients</h2>${table([{ h: 'Nom', f: r => esc(r.name) }, { h: 'CIF', f: r => esc(r.cif || '') }, { h: 'Correu per a parts', f: r => esc(r.report_email || '') }], cl.clients)}`;
    if (!w) return;
    const form = (s = {}) => `${s.id ? '' : `<label>Client<select name="client_id" required>${opts(cl.clients, '', c => c.name)}</select></label>`}
      <label>Nom<input name="name" value="${esc(s.name || '')}" required></label><label>Adreça<input name="address" value="${esc(s.address || '')}"></label>
      <div class="grid2"><label>Latitud<input name="lat" type="number" step="any" value="${s.lat ?? ''}"></label><label>Longitud<input name="lng" type="number" step="any" value="${s.lng ?? ''}"></label></div>
      <label>Radi permès (m)<input name="radius_m" type="number" min="20" value="${s.radius_m || 150}"></label>
      <label class="check"><input type="checkbox" name="solo_post" ${s.solo_post ? 'checked' : ''}> Lloc unipersonal (el vigilant no pot abandonar-lo: pauses computables)</label>
      <label class="check"><input type="checkbox" name="critical" ${s.critical ? 'checked' : ''}> Lloc crític</label>`;
    $('#cNew').onclick = guard(async () => { const f = await modal('Nou client', '<label>Nom<input name="name" required></label><label>CIF<input name="cif"></label><label>Correu de recepció de parts<input name="report_email" type="email"></label>'); if (!f) return; await api('/admin/clients', { method: 'POST', body: f }); viewSites(); });
    $('#iNew').onclick = guard(async () => { const f = await modal('Nova instal·lació', form()); if (!f) return; await api('/admin/sites', { method: 'POST', body: f }); toast('Instal·lació creada'); viewSites(); });
    for (const b of document.querySelectorAll('[data-s]')) b.onclick = guard(async () => {
      const s = st.sites.find(x => x.id === Number(b.dataset.s)); const f = await modal('Editar instal·lació', form(s)); if (!f) return;
      f.lat = f.lat === '' ? null : Number(f.lat); f.lng = f.lng === '' ? null : Number(f.lng); f.radius_m = Number(f.radius_m);
      await api('/admin/sites/' + s.id, { method: 'PATCH', body: f }); toast('Instal·lació actualitzada'); viewSites();
    });
  }

  /* ---------- Auditoria ---------- */
  async function viewAudit() {
    const [a, c] = await Promise.all([api('/admin/audit'), api('/admin/corrections')]);
    $('#view').innerHTML = `<h1>Auditoria i integritat</h1>
      <div class="toolbar"><button class="btn primary" id="aVer">Verificar integritat (cadena de hash)</button><span id="aRes"></span></div>
      <h2>Correccions de registres horaris</h2>${table([{ h: 'Data', f: r => fDT(r.created_at) }, { h: 'Autor', f: r => esc(r.author_name) }, { h: 'Treballador', f: r => esc(r.worker_name) },
        { h: 'Acció', f: r => r.action }, { h: 'Registre', num: 1, f: r => '#' + r.event_id }, { h: 'Abans → després', wrap: 1, f: r => `${esc(r.old_values || '')} → ${esc(r.new_values && r.action === 'modify' ? r.new_values : '')}` }, { h: 'Motiu', wrap: 1, f: r => esc(r.reason) }], c.corrections)}
      <h2>Registre d'activitat</h2>${table([{ h: 'Data', f: r => fDT(r.at) }, { h: 'Usuari', f: r => esc(r.actor_name || '—') }, { h: 'Acció', f: r => esc(r.action) },
        { h: 'Entitat', f: r => esc((r.entity || '') + (r.entity_id ? ' #' + r.entity_id : '')) }, { h: 'Detalls', wrap: 1, f: r => `<span class="muted">${esc(r.details || '')}</span>` }, { h: 'IP', f: r => esc(r.ip || '') }], a.log)}`;
    $('#aVer').onclick = guard(async () => {
      const r = await api('/admin/integrity');
      $('#aRes').innerHTML = r.ok ? `<b style="color:var(--ok)">✓ Integritat correcta</b> <span class="muted">(${r.results.map(x => `${x.table}: ${x.count}`).join(' · ')})</span>`
        : `<b class="flag">✗ Integritat compromesa: ${r.results.filter(x => !x.ok).map(x => `${x.table} #${x.brokenAt} (${x.reason})`).join('; ')}</b>`;
    });
  }

  /* ---------- Configuració ---------- */
  async function viewSettings() {
    const d = await api('/admin/settings'); const s = d.settings; settings = s; const w = can('settings');
    const f = (k, l, t = 'text') => `<label>${l}<input name="${k}" type="${t}" value="${esc(s[k])}" ${w ? '' : 'disabled'}></label>`;
    $('#view').innerHTML = `<h1>Configuració</h1><form id="cfg" class="card"><div class="grid2">
      ${f('company_name', 'Empresa')}${f('company_cif', 'CIF')}${f('monthly_hours', 'Jornada mensual per defecte (h)', 'number')}${f('timezone', 'Zona horària')}
      ${f('night_start', 'Inici nocturnitat', 'time')}${f('night_end', 'Fi nocturnitat', 'time')}${f('late_tolerance_min', 'Tolerància retard / prolongació (min)', 'number')}${f('absence_after_min', 'Absència després de (min)', 'number')}
      <label>Fitxatge fora de radi<select name="geofence_policy" ${w ? '' : 'disabled'}><option value="justify" ${s.geofence_policy === 'justify' ? 'selected' : ''}>Requerir justificació</option><option value="warn" ${s.geofence_policy === 'warn' ? 'selected' : ''}>Només avisar</option></select></label>
      ${f('retention_years', 'Conservació (anys, mínim legal 4)', 'number')}</div>${w ? '<button class="btn primary">Desar</button>' : ''}</form>
      <h2>Festius</h2>${can('shifts.write') ? '<div class="toolbar"><button class="btn" id="hNew">+ Afegir festiu</button></div>' : ''}
      ${table([{ h: 'Data', f: r => r.date }, { h: 'Nom', f: r => esc(r.name) }, { h: 'Àmbit', f: r => esc(r.scope) }, { h: '', f: r => can('shifts.write') ? `<button class="btn small danger" data-h="${r.date}">Eliminar</button>` : '' }], d.holidays)}`;
    if (w) $('#cfg').onsubmit = guard(async e => { e.preventDefault(); const o = Object.fromEntries(new FormData(e.target)); if (Number(o.retention_years) < 4) throw new Error('La conservació mínima legal és de 4 anys'); settings = (await api('/admin/settings', { method: 'PUT', body: o })).settings; toast('Configuració desada'); });
    if ($('#hNew')) $('#hNew').onclick = guard(async () => { const x = await modal('Nou festiu', '<label>Data<input type="date" name="date" required></label><label>Nom<input name="name" required></label><label>Àmbit<input name="scope" value="nacional"></label>'); if (!x) return; await api('/admin/holidays', { method: 'POST', body: x }); viewSettings(); });
    for (const b of document.querySelectorAll('[data-h]')) b.onclick = guard(async () => { if (!confirm('Eliminar festiu?')) return; await api('/admin/holidays/' + b.dataset.h, { method: 'DELETE' }); viewSettings(); });
  }

  if (token && user) start(); else $('#login').classList.remove('hidden');
})();
