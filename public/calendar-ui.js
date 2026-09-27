// CCA OS — Frontend additions: oncology calendar (Journey | Calendar | Timeline),
// view-source modal, modality filters, department operational view, patient
// calendar upgrade. Kept in a separate file to avoid destabilising app.js.
'use strict';

// ---- helpers ------------------------------------------------------------------
function calFmtDate(d) { return d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
function calBadge(state) { return el('span', { class: 'badge ' + state }, state); }

function calEventRow(e, onOpen) {
  const tr = el('tr', { class: 'clickable' });
  tr.append(
    el('td', {}, calFmtDate(e.date)),
    el('td', {}, e.title || ''),
    el('td', {}, e.patient ? e.patient.mrn + ' · ' + e.patient.name : ''),
    el('td', {}, e.owner || ''),
    el('td', {}, calBadge(e.state))
  );
  tr.addEventListener('click', () => onOpen(e));
  return tr;
}

// VIEW SOURCE modal: opens the authoritative record behind the event
function calShowSource(ev) {
  // single-instance modal: remove any stale modal first (never stack overlays)
  document.querySelectorAll('body > .card[style*="position"]').forEach(m => m.remove());
  const modal = el('div', { class: 'card', style: 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:680px;max-width:92vw;z-index:60;box-shadow:0 8px 30px rgba(0,0,0,.3);max-height:80vh;overflow:auto' });
  modal.append(el('h2', {}, 'Source record — ' + (ev.title || '')));
  if (!ev.source) {
    modal.append(el('div', { class: 'muted' }, 'Projected event derived from the calendar engine (future appointment); no signed source record exists yet.'));
  } else {
    const s = ev.source;
    const kv = el('div', { class: 'kv' });
    kv.append(el('div', { class: 'k' }, 'Record'), el('div', {}, s.title || '—'));
    kv.append(el('div', { class: 'k' }, 'Status'), el('div', {}, s.status || '—'));
    kv.append(el('div', { class: 'k' }, 'Author'), el('div', {}, s.byName || '—'));
    kv.append(el('div', { class: 'k' }, 'Date'), el('div', {}, s.at ? new Date(s.at).toLocaleString('en-GB') : '—'));
    if (s.summary) kv.append(el('div', { class: 'k' }, 'Summary'), el('div', {}, String(s.summary)));
    if (s.signature) kv.append(el('div', { class: 'k' }, 'Signature'), el('div', {}, s.signature));
    modal.append(kv);
    modal.append(el('div', { class: 'prov' }, 'Provenance: ' + s.refType + ' · ' + s.refUuid));
  }
  modal.append(el('div', { class: 'prov' }, 'Event state: ' + ev.state + (ev.isPast && (ev.state === 'PROJECTED' || ev.state === 'SCHEDULED') ? ' · ⚠ planned but NOT delivered care' : '') + (ev.isFuture && ev.state === 'PROJECTED' ? ' · projected therapy — never delivered care' : '')));
  modal.append(el('div', {},
    el('button', { class: 'btn secondary', onclick: () => modal.remove() }, 'Close')));
  document.body.append(modal);
}

// "What happened / happening now / scheduled next / who owns it / why delayed" strip
function calAnswerStrip(events) {
  const today = new Date().toISOString().slice(0, 10);
  const happened = events.filter(e => e.date && e.date < today && ['ACTUAL', 'COMPLETED'].includes(e.state));
  const nowEvents = events.filter(e => (e.date === today && !['PROJECTED'].includes(e.state)) || e.state === 'READY');
  const upcoming = events.filter(e => e.date && e.date > today && ['SCHEDULED', 'PROJECTED', 'READY'].includes(e.state));
  const delayed = events.filter(e => ['DELAYED', 'HELD', 'CANCELLED'].includes(e.state));

  const strip = el('div', { class: 'grid2' });
  const mkCard = (title, items, showOwner) => {
    const c = el('div', { class: 'card', style: 'margin-bottom:0' });
    c.append(el('h3', {}, title));
    if (!items.length) c.append(el('div', { class: 'muted' }, '—'));
    for (const e of items.slice(0, 4)) {
      c.append(el('div', { class: 'prov' },
        el('b', {}, calFmtDate(e.date) + ' · ' + (e.title || '')),
        el('div', {}, (e.owner ? 'Owner: ' + e.owner + ' · ' : '') + (e.state || '') + (e.detail ? ' · ' + e.detail : ''))));
    }
    return c;
  };
  strip.append(mkCard('What happened (authoritative, signed)', happened, true));
  strip.append(mkCard('What is happening now', nowEvents, true));
  strip.append(mkCard('What is scheduled next', upcoming.sort((a, b) => (a.date || '').localeCompare(b.date || '')), true));
  strip.append(mkCard('Why delayed / held / cancelled', delayed, true));
  return strip;
}

// ---- global calendar view (three sub-views) ------------------------------------
async function viewCalendarV2(main) {
  main.append(el('h1', {}, 'Oncology Calendar'));
  main.append(el('div', { class: 'sub2' }, 'Derived as a projection over authoritative clinical records — projected therapy is dashed/grey and can never appear as delivered care. Every event supports VIEW SOURCE.'));

  const sub = el('div', { class: 'wtabs' });
  const views = ['Journey', 'Calendar', 'Timeline', 'Department view'];
  if (!state.calView) state.calView = 'Journey';
  for (const v of views) {
    sub.append(el('button', { class: 'wtab' + (state.calView === v ? ' active' : ''), onclick: () => { state.calView = v; render(); } }, v));
  }
  main.append(sub);

  const params = new URLSearchParams();
  if (state.calModality) params.set('modality', state.calModality);
  if (state.calState) params.set('state', state.calState);
  const qs = params.toString() ? '&' + params.toString() : '';

  // filter bar (modality + status)
  const filterBar = el('div', { class: 'card', style: 'padding:10px 16px' });
  const modSel = el('select', { style: 'width:auto;display:inline-block;margin-right:12px' },
    el('option', { value: '' }, 'All modalities'),
    ...['JOURNEY', 'MEDICAL_ONCOLOGY', 'RADIATION_ONCOLOGY', 'SURGICAL_ONCOLOGY', 'DIAGNOSTICS'].map(m => el('option', { value: m, selected: state.calModality === m }, m.replace(/_/g, ' '))));
  const stSel = el('select', { style: 'width:auto;display:inline-block' },
    el('option', { value: '' }, 'All statuses'),
    ...['ACTUAL', 'SCHEDULED', 'PROJECTED', 'READY', 'HELD', 'DELAYED', 'CANCELLED', 'COMPLETED'].map(s => el('option', { value: s, selected: state.calState === s }, s)));
  modSel.addEventListener('change', () => { state.calModality = modSel.value; render(); });
  stSel.addEventListener('change', () => { state.calState = stSel.value; render(); });
  filterBar.append(el('span', { class: 'muted', style: 'font-size:12px;margin-right:8px' }, 'Modality'), modSel, el('span', { class: 'muted', style: 'font-size:12px;margin-right:8px' }, 'Status'), stSel);
  main.append(filterBar);

  if (state.calView === 'Department view') { await calDepartmentView(main); return; }

  const events = await api('/calendar/enriched?mine=1' + qs);
  const openSource = (e) => calShowSource(e);

  if (state.calView === 'Journey') {
    // journey-style: grouped by patient, chronological
    const byPatient = {};
    for (const e of events) {
      const k = e.patient ? e.patient.uuid : '—';
      (byPatient[k] = byPatient[k] || { patient: e.patient, items: [] }).items.push(e);
    }
    for (const k of Object.keys(byPatient)) {
      const g = byPatient[k];
      const card = el('div', { class: 'card' });
      card.append(el('h2', {}, g.patient ? g.patient.name + ' (' + g.patient.mrn + ')' : 'Unassigned'));
      const strip = calAnswerStrip(g.items);
      card.append(strip);
      const tb = el('tbody');
      for (const e of g.items.slice(0, 40)) tb.append(calEventRow(e, openSource));
      card.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Event'), el('th', {}, 'Patient'), el('th', {}, 'Owner'), el('th', {}, 'State'))), tb));
      main.append(card);
    }
    if (!events.length) main.append(el('div', { class: 'card muted' }, 'No events yet. Register a patient and run the workflow to populate the journey.'));
  }

  if (state.calView === 'Calendar') {
    // month grid (existing style) over derived events
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const first = new Date(y, m, 1);
    const startDow = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const card = el('div', { class: 'card' });
    card.append(el('h2', {}, now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })));
    const grid = el('div', { class: 'calendar' });
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) grid.append(el('div', { class: 'cal-head' }, d));
    for (let i = 0; i < startDow; i++) grid.append(el('div', { class: 'cal-day', style: 'background:transparent;border:none' }));
    const todayStr = new Date().toISOString().slice(0, 10);
    for (let day = 1; day <= daysInMonth; day++) {
      const ds = new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
      const cell = el('div', { class: 'cal-day' + (ds === todayStr ? ' today' : '') }, el('div', { class: 'dnum' }, String(day)));
      for (const e of events.filter(ev => ev.date === ds)) {
        cell.append(el('div', { class: 'cal-ev ' + e.state, title: e.title + ' — ' + e.state + (e.patient ? ' · ' + e.patient.name : '') }, (e.patient ? e.patient.mrn.slice(-4) + ' ' : '') + (e.title || '')));
      }
      grid.append(cell);
    }
    card.append(grid);
    main.append(card);
    const tb = el('tbody');
    for (const e of events.filter(e => (e.date || '') >= todayStr).slice(0, 40)) tb.append(calEventRow(e, openSource));
    main.append(el('div', { class: 'card' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Event'), el('th', {}, 'Patient'), el('th', {}, 'Owner'), el('th', {}, 'State'))), tb)));
  }

  if (state.calView === 'Timeline') {
    const card = el('div', { class: 'card' });
    card.append(el('h2', {}, 'Longitudinal timeline (all patients)'));
    const tl = el('div', { class: 'timeline' });
    const sorted = [...events].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!sorted.length) tl.append(el('div', { class: 'muted' }, 'Timeline empty.'));
    for (const e of sorted.slice(-60)) {
      tl.append(el('div', { class: 'tl-item ' + e.state },
        el('div', { class: 'tl-date' }, calFmtDate(e.date) + ' · ' + e.state + (e.patient ? ' · ' + e.patient.mrn : '')),
        el('div', {}, (e.title || '') + (e.owner ? ' — owner: ' + e.owner : ''))));
    }
    card.append(tl);
    main.append(card);
  }
}

// ---- department operational view ------------------------------------------------
async function calDepartmentView(main) {
  const card = el('div', { class: 'card' });
  card.append(el('h2', {}, 'Department operational view'));
  card.append(el('div', { class: 'muted', style: 'font-size:12px' }, 'Filterable by hospital, department, clinician, resource, treatment type (modality), status, and date.'));

  const hospitals = state.hospitals.length ? state.hospitals : await api('/hospitals');
  const f = state.calDept = state.calDept || {};
  const bar = el('div', { class: 'grid3', style: 'margin-top:8px' });
  const hospSel = el('select', {}, el('option', { value: '' }, 'All hospitals'), ...hospitals.map(h => el('option', { value: h.uuid, selected: f.hospital === h.uuid }, h.name)));
  const deptIn = el('input', { value: f.department || '', placeholder: 'Department (e.g. Day Care)' });
  const clinIn = el('input', { value: f.clinician || '', placeholder: 'Clinician / owner' });
  const resIn = el('input', { value: f.resource || '', placeholder: 'Resource (e.g. LINAC, chair)' });
  const typeSel = el('select', {}, el('option', { value: '' }, 'All treatment types'), ...['JOURNEY', 'MEDICAL_ONCOLOGY', 'RADIATION_ONCOLOGY', 'SURGICAL_ONCOLOGY', 'DIAGNOSTICS'].map(m => el('option', { value: m, selected: f.modality === m }, m.replace(/_/g, ' '))));
  const stSel2 = el('select', {}, el('option', { value: '' }, 'All statuses'), ...['ACTUAL', 'SCHEDULED', 'PROJECTED', 'READY', 'HELD', 'DELAYED', 'CANCELLED', 'COMPLETED'].map(s => el('option', { value: s, selected: f.state === s }, s)));
  const dateIn = el('input', { type: 'date', value: f.date || '' });
  const go = el('button', { class: 'btn' }, 'Apply filters');
  bar.append(wrap('Hospital', hospSel), wrap('Department', deptIn), wrap('Clinician', clinIn), wrap('Resource', resIn), wrap('Treatment type', typeSel), wrap('Status', stSel2), wrap('Date', dateIn));
  card.append(bar, go);

  const out = el('div', {});
  card.append(out);

  async function run() {
    const p = new URLSearchParams();
    if (f.hospital) p.set('hospital', f.hospital);
    if (f.department) p.set('department', f.department);
    if (f.clinician) p.set('clinician', f.clinician);
    if (f.resource) p.set('resource', f.resource);
    if (f.modality) p.set('modality', f.modality);
    if (f.state) p.set('state', f.state);
    if (f.date) p.set('date', f.date);
    const rows = await api('/calendar/department' + (p.toString() ? '?' + p.toString() : ''));
    out.innerHTML = '';
    const tb = el('tbody');
    for (const e of rows) {
      tb.append(calEventRow(e, calShowSource));
    }
    out.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Event'), el('th', {}, 'Patient'), el('th', {}, 'Owner'), el('th', {}, 'State'))), tb));
    if (!rows.length) out.append(el('div', { class: 'muted mt8' }, 'No events match the filters.'));
  }
  go.addEventListener('click', () => {
    f.hospital = hospSel.value; f.department = deptIn.value; f.clinician = clinIn.value;
    f.resource = resIn.value; f.modality = typeSel.value; f.state = stSel2.value; f.date = dateIn.value;
    run();
  });
  main.append(card);
  await run();
}

// ---- patient-level calendar tab (Journey | Calendar | Timeline) ------------------
async function tabPatientCalendarV2(body, chart) {
  const events = await api('/calendar/enriched?patientUuid=' + chart.patient.uuid);
  const strip = calAnswerStrip(events);
  strip.style.marginBottom = '14px';
  body.append(strip);

  const sub = el('div', { class: 'wtabs' });
  const views = ['Journey', 'Calendar', 'Timeline'];
  if (!state.pcalView) state.pcalView = 'Journey';
  for (const v of views) {
    sub.append(el('button', { class: 'wtab' + (state.pcalView === v ? ' active' : ''), onclick: () => { state.pcalView = v; render(); } }, v));
  }
  body.append(sub);

  const openSource = (e) => calShowSource(e);

  if (state.pcalView === 'Journey') {
    const card = el('div', { class: 'card' });
    card.append(el('h2', {}, 'Oncology journey (derived from signed records)'));
    const tb = el('tbody');
    for (const e of events) tb.append(calEventRow(e, openSource));
    if (!events.length) card.append(el('div', { class: 'muted' }, 'No events yet.'));
    else card.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Event'), el('th', {}, 'Owner'), el('th', {}, 'State'))), tb));
    body.append(card);
  }

  if (state.pcalView === 'Calendar') {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const first = new Date(y, m, 1);
    const startDow = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const card = el('div', { class: 'card' });
    card.append(el('h2', {}, now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })));
    const grid = el('div', { class: 'calendar' });
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) grid.append(el('div', { class: 'cal-head' }, d));
    for (let i = 0; i < startDow; i++) grid.append(el('div', { class: 'cal-day', style: 'background:transparent;border:none' }));
    const todayStr = new Date().toISOString().slice(0, 10);
    for (let day = 1; day <= daysInMonth; day++) {
      const ds = new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
      const cell = el('div', { class: 'cal-day' + (ds === todayStr ? ' today' : '') }, el('div', { class: 'dnum' }, String(day)));
      for (const e of events.filter(ev => ev.date === ds)) {
        cell.append(el('div', { class: 'cal-ev ' + e.state, title: e.title + ' — ' + e.state }, e.title || ''));
      }
      grid.append(cell);
    }
    card.append(grid);
    const tb = el('tbody');
    for (const e of events.filter(e => (e.date || '') >= todayStr).slice(0, 40)) tb.append(calEventRow(e, openSource));
    card.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Event'), el('th', {}, 'Owner'), el('th', {}, 'State'))), tb));
    body.append(card);
  }

  if (state.pcalView === 'Timeline') {
    const card = el('div', { class: 'card' });
    card.append(el('h2', {}, 'Longitudinal timeline'));
    const tl = el('div', { class: 'timeline' });
    const sorted = [...events].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!sorted.length) tl.append(el('div', { class: 'muted' }, 'Timeline empty.'));
    for (const e of sorted) {
      tl.append(el('div', { class: 'tl-item ' + e.state },
        el('div', { class: 'tl-date' }, calFmtDate(e.date) + ' · ' + e.state),
        el('div', {}, (e.title || '') + (e.owner ? ' — owner: ' + e.owner : ''))));
    }
    card.append(tl);
    body.append(card);
  }
}

// expose globally for app.js
window.viewCalendarV2 = viewCalendarV2;
window.tabPatientCalendarV2 = tabPatientCalendarV2;
window.calShowSource = calShowSource;
window.calEventRow = calEventRow;
window.calBadge = calBadge;
