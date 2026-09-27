// CCA OS — SPA application
'use strict';

const state = {
  users: [], user: null, hospitals: [], hospitalUuid: null,
  view: { name: 'worklist' }, patientUuid: null, tab: 'overview',
  cache: { patients: [], masters: {}, regimens: [] }
};

const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
};

async function api(path, opts = {}) {
  const res = await fetch('/ws/rest/v1/cca' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-cca-user': state.user ? state.user.uuid : '' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw json;
  return json.data;
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3500);
}

function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
function esc(s) { return String(s ?? ''); }

async function loadMaster(name) {
  if (!state.cache.masters[name]) {
    state.cache.masters[name] = await api('/masters/' + name);
  }
  return state.cache.masters[name];
}

function masterSelect(name, current, attrs = {}) {
  const sel = el('select', { 'data-master': name, ...attrs });
  sel.append(el('option', { value: '' }, '— select —'));
  return loadMaster(name).then(items => {
    for (const i of items.filter(x => x.active)) {
      const o = el('option', { value: i.code }, i.label);
      if (i.code === current) o.selected = true;
      sel.append(o);
    }
    return sel;
  });
}

// ---------------------------------------------------------------------------
// Boot
async function boot() {
  state.users = await api('/users');
  state.hospitals = await api('/hospitals');
  const saved = localStorage.getItem('ccaUser');
  state.user = state.users.find(u => u.uuid === saved) || state.users.find(u => u.role === 'Medical Oncologist');
  state.hospitalUuid = state.hospitals[0].uuid;

  const us = $('#userSel');
  for (const u of state.users) {
    us.append(el('option', { value: u.uuid }, u.role + ' — ' + u.name));
    if (u.uuid === state.user.uuid) us.value = u.uuid;
  }
  us.addEventListener('change', () => { state.user = state.users.find(u => u.uuid === us.value); localStorage.setItem('ccaUser', us.value); state.view = { name: 'worklist' }; render(); });

  const hs = $('#hospitalSel');
  for (const h of state.hospitals) {
    hs.append(el('option', { value: h.uuid }, h.name));
  }
  hs.addEventListener('change', () => { state.hospitalUuid = hs.value; render(); });

  state.cache.regimens = await api('/regimens');

  for (const b of document.querySelectorAll('.navbtn')) {
    b.addEventListener('click', () => {
      document.querySelectorAll('.navbtn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.view = { name: b.dataset.nav };
      state.patientUuid = null;
      render();
    });
  }
  render();
}

function setNav(name) {
  document.querySelectorAll('.navbtn').forEach(x => x.classList.toggle('active', x.dataset.nav === name));
}

function render() { renderView().catch(e => { console.error(e); toast('Error: ' + (e.error || e.message), true); }); }

// ---------------------------------------------------------------------------
// Views
async function renderView() {
  const main = $('#main');
  main.innerHTML = '';
  const v = state.view.name;
  if (v === 'worklist') await viewWorklist(main);
  else if (v === 'patients') await viewPatients(main);
  else if (v === 'register') viewRegister(main);
  else if (v === 'calendar') await viewCalendarV2(main);
  else if (v === 'departments') await viewDepartments(main);
  else if (v === 'audit') await viewAudit(main);
  else if (v === 'patient') await viewPatientChart(main, state.patientUuid);
  else if (v === 'task') await viewTaskAction(main, state.view.task);
}

// ---- worklists ------------------------------------------------------------
async function viewWorklist(main) {
  const bucket = state.view.bucket || 'myTasks';
  main.append(el('h1', {}, 'Role Worklist'));
  main.append(el('div', { class: 'sub2' }, 'Signed in as: ' + state.user.role + ' — ' + state.user.name + '. Tasks arrive automatically from workflow events; no manual task creation.'));

  const tabs = [['myTasks', 'My Tasks'], ['waiting', 'Waiting (other roles)'], ['done', 'Completed by me']];
  const bar = el('div', { class: 'mb8' });
  for (const [b, label] of tabs) {
    bar.append(el('button', {
      class: 'btn small ' + (bucket === b ? '' : 'secondary'),
      style: 'margin-right:6px',
      onclick: () => { state.view.bucket = b; render(); }
    }, label));
  }
  main.append(bar);

  const tasks = await api('/tasks?bucket=' + bucket);
  if (!tasks.length) { main.append(el('div', { class: 'card muted' }, 'No tasks in this bucket.')); return; }
  const card = el('div', { class: 'card' });
  for (const t of tasks) {
    const row = el('div', { class: 'taskrow' + (t.overdue && t.status === 'OPEN' ? ' overdue' : '') },
      el('div', {},
        el('div', { class: 't-title' }, t.title + (t.overdue && t.status === 'OPEN' ? '  ⚠ OVERDUE' : '')),
        el('div', { class: 't-meta' }, (t.patient ? t.patient.mrn + ' · ' + t.patient.name : '') + ' · due ' + fmtDate(t.dueAt))
      ),
      el('div', {},
        el('button', { class: 'btn small', onclick: () => openTask(t) }, 'Open →')
      )
    );
    card.append(row);
  }
  main.append(card);
}

function openTask(t) {
  // navigate to the task's destination with patient + payload context
  state.patientUuid = t.patientUuid;
  state.view = { name: 'task', task: t };
  render();
}

async function viewTaskAction(main, task) {
  main.append(el('a', { class: 'backlink', onclick: () => { state.view = { name: 'worklist' }; render(); } }, '← back to worklist'));
  const chart = await api('/patients/' + task.patientUuid);
  renderPatientHeader(main, chart);
  const card = el('div', { class: 'card' });
  card.append(el('h2', {}, 'Task: ' + task.title));
  const dest = task.destination;

  const completeAndRoute = (outcome) => async () => {
    // tolerate already-completed tasks (some flows complete server-side) and
    // skip completion for routed pseudo-tasks (uuid: null)
    if (task.uuid) { try { await api('/tasks/' + task.uuid + '/complete', { method: 'POST', body: { outcome } }); } catch (e) { /* already completed by backend */ } }
    toast('Task completed. Next role notified automatically.');
    state.view = { name: 'worklist' };
    state.patientUuid = null;
    render();
  };

  const routes = {
    'consult-new': () => formConsultation(card, task, chart, completeAndRoute('consultation recorded')),
    'dept-lab': () => formDeptResult(card, task, chart, 'LAB', completeAndRoute('lab result finalized')),
    'dept-radiology': () => formDeptResult(card, task, chart, 'RADIOLOGY', completeAndRoute('radiology result finalized')),
    'dept-pathology': () => formDeptResult(card, task, chart, 'PATHOLOGY', completeAndRoute('pathology result finalized')),
    'diagnosis': () => formDiagnosis(card, task, chart, completeAndRoute('diagnosis signed')),
    'staging': () => formStaging(card, task, chart, completeAndRoute('staging signed')),
    'mdt': () => formMdt(card, task, chart, completeAndRoute('MDT outcome signed')),
    'care-plan': () => formCarePlan(card, task, chart, completeAndRoute('care plan signed')),
    'finance': () => formFinance(card, task, chart, completeAndRoute('financial counselling signed')),
    'readiness': () => formReadiness(card, task, chart, completeAndRoute('readiness cleared')),
    'treatment-order': () => formTreatmentOrder(card, task, chart, completeAndRoute('treatment order signed')),
    'pharmacy': () => formPharmacy(card, task, chart),
    'daycare': () => formDayCare(card, task, chart, completeAndRoute('administration complete')),
    'toxicity': () => formToxicity(card, task, chart, completeAndRoute('toxicity signed')),
    'response': () => formResponse(card, task, chart, completeAndRoute('response signed')),
    'results-review': () => formResultsReview(card, task, chart, completeAndRoute('results reviewed')),
    'consent': () => formConsent(card, task, chart, completeAndRoute('consent signed')),
    'next-cycle': () => formNextCycle(card, task, chart, completeAndRoute('next-cycle decision signed')),
    'radiation': () => formRadiation(card, task, chart),
    'surgery': () => formSurgery(card, task, chart)
  };
  (routes[dest] || (() => card.append(el('div', { class: 'muted' }, 'No screen bound for destination: ' + dest))))();
  main.append(card);
}

// D1 fix: department result form bound to the task's own order (no dead-ends)
// D1 fix + directive §5: department result form bound to the task's own order.
// New order lifecycle: SIGNED (ordered) → RESULT_AVAILABLE after result entry.
async function formDeptResult(card, task, chart, category, done) {
  const orders = (await api('/investigation-orders')).filter(o => o.patientUuid === task.patientUuid && ['SIGNED', 'SCHEDULED', 'COLLECTED', 'ACQUIRED', 'IN_PROGRESS'].includes(o.status));
  const mine = orders.filter(o => o.category === category);
  if (!mine.length) { card.append(el('div', { class: 'muted' }, 'No pending ' + category + ' orders for this patient.')); return; }
  const sel = el('select', {}, ...mine.map(o => el('option', { value: o.uuid }, o.displayName + ' · ' + (o.priority || 'ROUTINE') + ' (ordered ' + fmtDate(o.orderedAt) + ' by ' + o.orderedByName + ')')));
  card.append(el('div', { class: 'prov' }, 'Clinical indication: ' + (mine[0].clinicalIndication || '—') + ' · performing dept: ' + (mine[0].performingDepartment || category)));
  card.append(wrap('Order *', sel));
  const summary = el('textarea', { placeholder: 'Result summary *' });
  const accession = el('input', { placeholder: 'Accession number (pathology)' });
  const site = el('input', { placeholder: 'Specimen site (pathology)' });
  const findings = el('textarea', { placeholder: 'Structured findings (free text)' });
  card.append(wrap('Summary *', summary));
  if (category === 'PATHOLOGY') card.append(el('div', { class: 'grid2' }, wrap('Accession number', accession), wrap('Specimen site', site)));
  card.append(wrap('Findings', findings));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        await api('/results', { method: 'POST', body: { orderUuid: sel.value, patientUuid: task.patientUuid, summary: summary.value, accessionNumber: accession.value, specimenSite: site.value, findings: findings.value } });
        toast('Result finalized & signed — reviewing oncologist notified');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Finalize & sign'));
}

// ---- patients list -----------------------------------------------------------
async function viewPatients(main) {
  main.append(el('h1', {}, 'My Patients'));
  state.cache.patients = await api('/patients');
  const card = el('div', { class: 'card' });
  const table = el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'MRN'), el('th', {}, 'Name'), el('th', {}, 'Age/Sex'), el('th', {}, 'Diagnosis'), el('th', {}, 'ECOG'), el('th', {}, 'Active treatment'))));
  const tb = el('tbody');
  for (const p of state.cache.patients) {
    const age = p.dob ? Math.floor((Date.now() - new Date(p.dob)) / 3.15576e10) : '—';
    tb.append(el('tr', {
      class: 'clickable',
      onclick: () => { state.patientUuid = p.uuid; state.view = { name: 'patient' }; state.tab = 'overview'; render(); }
    },
      el('td', {}, p.mrn),
      el('td', {}, p.name),
      el('td', {}, age + '/' + p.sex),
      el('td', {}, p.diagnosis ? p.diagnosis.cancerTypeLabel : el('span', { class: 'muted' }, '—')),
      el('td', {}, p.ecog ?? '—'),
      el('td', {}, p.activeOrder ? p.activeOrder.regimenName + ' (C' + currentCycle(p.activeOrder) + ')' : el('span', { class: 'muted' }, '—'))
    ));
  }
  table.append(tb);
  card.append(table);
  main.append(card);
}

function currentCycle(order) {
  const done = order.cycleDays.filter(c => c.status === 'PROJECTED' || c.status === 'DELAYED');
  return Math.max(...order.cycleDays.map(c => c.cycle));
}

// ---- registration -------------------------------------------------------------
function viewRegister(main) {
  main.append(el('h1', {}, 'Registration / Referral'));
  main.append(el('div', { class: 'sub2' }, 'Front Desk registers the patient; the Intake Nurse automatically receives an assessment task.'));
  const card = el('div', { class: 'card' });
  const f = {};
  const mk = (labelText, node) => card.append(el('div', {}, (() => { const w = el('div', {}); w.append(el('label', {}, labelText)); w.append(node); return w; })()));

  const nameIn = el('input', { placeholder: 'Full name' });
  const dobIn = el('input', { type: 'date' });
  const sexSel = el('select', {}, el('option', { value: '' }, '—'), el('option', { value: 'F' }, 'Female'), el('option', { value: 'M' }, 'Male'));
  const phoneIn = el('input', { placeholder: 'Phone' });
  const addrIn = el('input', { placeholder: 'Address' });
  const refSel = el('select', {},
    el('option', { value: 'WALK_IN' }, 'Walk-in'),
    el('option', { value: 'EXTERNAL_REFERRAL' }, 'External referral'),
    el('option', { value: 'INTERNAL_REFERRAL' }, 'Internal referral'),
    el('option', { value: 'SCREENING' }, 'Screening programme'));
  const facilityIn = el('input', { placeholder: 'Referring facility (if any)' });
  const reasonIn = el('textarea', { placeholder: 'Referral reason / presenting problem' });

  card.append(el('div', { class: 'grid2' },
    wrap('Full name *', nameIn), wrap('Date of birth *', dobIn),
    wrap('Sex *', sexSel), wrap('Phone', phoneIn),
    wrap('Address', addrIn), wrap('Referral source', refSel),
    wrap('Referring facility', facilityIn), wrap('Referral reason', reasonIn)
  ));
  card.append(el('button', {
    class: 'btn',
    onclick: async () => {
      try {
        const r = await api('/patients', { method: 'POST', body: { name: nameIn.value, dob: dobIn.value, sex: sexSel.value, phone: phoneIn.value, address: addrIn.value, referralSource: refSel.value, referringFacility: facilityIn.value, reason: reasonIn.value, hospitalUuid: state.hospitalUuid } });
        toast('Registered ' + r.patient.mrn + ' — intake nurse task generated');
        state.patientUuid = r.patient.uuid;
        state.view = { name: 'patient' };
        setNav('patients');
        render();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Register patient'));
  main.append(card);
}

function wrap(labelText, node) { const w = el('div', {}); w.append(el('label', {}, labelText)); w.append(node); return w; }

// ---- departments -----------------------------------------------------------------
async function viewDepartments(main) {
  main.append(el('h1', {}, 'Departments'));
  main.append(el('div', { class: 'sub2' }, 'Orders arrive here automatically when an oncologist signs them; results return to the ordering clinician.'));
  const orders = await api('/investigation-orders');
  const results = await api('/results');
  const byCat = { LAB: [], RADIOLOGY: [], PATHOLOGY: [] };
  for (const o of orders) (byCat[o.category === 'IMAGING' ? 'RADIOLOGY' : o.category] || byCat.OTHER || (byCat.OTHER = [])).push(o);
  for (const o of orders) if (o.status === 'ORDERED') byCat[o.category].push(o);

  const grid = el('div', { class: 'grid3' });
  const dept = (title, cat, role) => {
    const c = el('div', { class: 'card' });
    c.append(el('h2', {}, title));
    if (!byCat[cat].length) c.append(el('div', { class: 'muted' }, 'No pending orders.'));
    for (const o of byCat[cat]) {
      c.append(el('div', { class: 'taskrow' },
        el('div', {}, el('div', { class: 't-title' }, o.test), el('div', { class: 't-meta' }, o.patient.mrn + ' · ' + o.patient.name + ' · ordered ' + fmtDate(o.orderedAt))),
        el('button', { class: 'btn small', onclick: () => showResultForm(o) }, 'Record result')
      ));
    }
    return c;
  };
  grid.append(dept('Laboratory', 'LAB', 'Lab'), dept('Radiology', 'RADIOLOGY', 'Radiologist'), dept('Pathology', 'PATHOLOGY', 'Pathologist'));
  main.append(grid);

  const done = el('div', { class: 'card' });
  done.append(el('h2', {}, 'Finalized results'));
  const tb = el('tbody');
  for (const r of results.slice().reverse().slice(0, 15)) {
    tb.append(el('tr', {},
      el('td', {}, fmtDate(r.finalizedAt)), el('td', {}, r.category), el('td', {}, r.test),
      el('td', {}, r.patient.mrn + ' · ' + r.patient.name), el('td', {}, r.summary.slice(0, 60))));
  }
  done.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Category'), el('th', {}, 'Test'), el('th', {}, 'Patient'), el('th', {}, 'Summary'))), tb));
  main.append(done);
}

async function showResultForm(order) {
  const modal = el('div', { class: 'card', style: 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:640px;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
  modal.append(el('h2', {}, 'Record result — ' + order.test + ' (' + order.patient.name + ')'));
  const summary = el('textarea', { placeholder: 'Result summary *' });
  const accession = el('input', { placeholder: 'Accession number (pathology)' });
  const site = el('input', { placeholder: 'Specimen site (pathology)' });
  const findings = el('textarea', { placeholder: 'Structured findings (JSON-ish free text for radiology e.g. Tumor 3.2cm left upper lobe; nodes: 4R positive)' });
  modal.append(wrap('Summary *', summary));
  if (order.category === 'PATHOLOGY') { modal.append(wrap('Accession number', accession), wrap('Specimen site', site)); }
  if (order.category === 'IMAGING' || order.category === 'RADIOLOGY') modal.append(wrap('Findings', findings));
  modal.append(el('div', {},
    el('button', {
      class: 'btn', onclick: async () => {
        try {
          await api('/results', { method: 'POST', body: { orderUuid: order.uuid, patientUuid: order.patientUuid, summary: summary.value, accessionNumber: accession.value, specimenSite: site.value, findings: findings.value } });
          toast('Result finalized — reviewing oncologist notified');
          modal.remove(); render();
        } catch (e) { toast(e.error, true); }
      }
    }, 'Finalize & sign'),
    el('button', { class: 'btn secondary', style: 'margin-left:8px', onclick: () => modal.remove() }, 'Cancel')
  ));
  document.body.append(modal);
}

// ---- calendar --------------------------------------------------------------------
async function viewCalendar(main) {
  main.append(el('h1', {}, 'Oncology Calendar'));
  main.append(el('div', { class: 'sub2' }, 'Projected therapy is dashed/grey and can never appear as delivered. States: Actual · Scheduled · Projected · Held · Delayed · Cancelled · Completed.'));
  const events = await api('/events');
  const patients = state.cache.patients.length ? state.cache.patients : await api('/patients');
  state.cache.patients = patients;
  const patientByUuid = Object.fromEntries(patients.map(p => [p.uuid, p]));

  // month grid
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday first
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
    for (const e of events.filter(ev => ev.plannedDate === ds)) {
      const who = patientByUuid[e.patientUuid] ? patientByUuid[e.patientUuid].mrn : '';
      cell.append(el('div', { class: 'cal-ev ' + e.state, title: e.title + ' — ' + e.state }, (who ? who.slice(-4) + ' ' : '') + e.title));
    }
    grid.append(cell);
  }
  card.append(grid);
  main.append(card);

  // legend + all upcoming
  const legend = el('div', { class: 'card' });
  legend.append(el('h2', {}, 'All events'));
  const tb = el('tbody');
  for (const e of events.filter(e => e.plannedDate >= todayStr).slice(0, 30)) {
    const who = patientByUuid[e.patientUuid];
    tb.append(el('tr', {}, el('td', {}, fmtDate(e.plannedDate)), el('td', {}, who ? who.mrn + ' · ' + who.name : ''), el('td', {}, e.title), el('td', {}, el('span', { class: 'badge ' + e.state }, e.state))));
  }
  legend.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Patient'), el('th', {}, 'Event'), el('th', {}, 'State'))), tb));
  main.append(legend);
}

// ---- audit ------------------------------------------------------------------------
async function viewAudit(main) {
  main.append(el('h1', {}, 'Audit trail'));
  const entries = await api('/audit');
  const card = el('div', { class: 'card' });
  const tb = el('tbody');
  for (const a of entries.slice(0, 120)) {
    tb.append(el('tr', {},
      el('td', {}, new Date(a.at).toLocaleString('en-GB')),
      el('td', {}, a.actor ? a.actor.role + ' — ' + a.actor.name : 'system'),
      el('td', {}, a.action),
      el('td', {}, a.entityType + (a.detail ? ' · ' + a.detail : ''))));
  }
  card.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Who'), el('th', {}, 'Action'), el('th', {}, 'What'))), tb));
  main.append(card);
}

// ---- patient chart ------------------------------------------------------------------
async function viewPatientChart(main, patientUuid) {
  const chart = await api('/patients/' + patientUuid);
  main.append(el('a', { class: 'backlink', onclick: () => { state.view = { name: 'patients' }; render(); } }, '← back to patients'));
  renderPatientHeader(main, chart);

  const TABS = ['Overview', 'Consultations', 'Investigations', 'Diagnosis', 'Disease Profile', 'Staging', 'MDT', 'Care Plan', 'Financial Counselling', 'Consent', 'Treatment', 'Calendar', 'Pharmacy', 'Administration', 'Toxicity', 'Response', 'Documents', 'Timeline'];
  const tabsBar = el('div', { class: 'wtabs' });
  for (const t of TABS) {
    tabsBar.append(el('button', {
      class: 'wtab' + (state.tab === t ? ' active' : ''),
      onclick: () => { state.tab = t; render(); }
    }, t));
  }
  main.append(tabsBar);

  const body = el('div', {});
  main.append(body);
  const t = state.tab;
  if (t === 'Overview') tabOverview(body, chart);
  else if (t === 'Consultations') tabConsultations(body, chart);
  else if (t === 'Investigations') tabInvestigations(body, chart);
  else if (t === 'Diagnosis') tabDiagnosis(body, chart);
  else if (t === 'Disease Profile') tabDiseaseProfile(body, chart);
  else if (t === 'Staging') tabStaging(body, chart);
  else if (t === 'MDT') tabMdt(body, chart);
  else if (t === 'Care Plan') tabCarePlan(body, chart);
  else if (t === 'Financial Counselling') tabFinance(body, chart);
  else if (t === 'Consent') tabConsent(body, chart);
  else if (t === 'Treatment') tabTreatment(body, chart);
  else if (t === 'Calendar') await tabPatientCalendarV2(body, chart);
  else if (t === 'Pharmacy') tabPharmacy(body, chart);
  else if (t === 'Administration') tabAdministration(body, chart);
  else if (t === 'Toxicity') tabToxicity(body, chart);
  else if (t === 'Response') tabResponse(body, chart);
  else if (t === 'Documents') tabDocuments(body, chart);
  else if (t === 'Timeline') tabTimeline(body, chart);
}

function renderPatientHeader(main, chart) {
  const p = chart.patient;
  const dx = chart.diagnosis;
  const st = chart.staging && chart.staging.current;
  const ord = chart.activeOrder;
  const nextTask = chart.tasks.find(t => t.status === 'OPEN');
  // §35: header labels each stage with its classification (never an ambiguous "Stage").
  // Both clinical AND pathological shown when they exist — pathological never silently
  // replaces clinical. Authority + version accompany the value.
  const stageParts = [];
  const h = (chart.staging && chart.staging.history) || [];
  const signed = h.filter(s => s.status === 'SIGNED');
  const byCls = (cls) => signed.filter(s => s.stagingContext === cls).sort((a, b) => new Date(b.signedAt || 0) - new Date(a.signedAt || 0))[0];
  const fmtCls = (s, label) => s ? label + ' ' + s.stageResult + ' (' + (s.stagingAuthority || '') + ' ' + (s.authorityVersion || '') + ')' : null;
  const cStg = byCls('CLINICAL'); const pStg = byCls('PATHOLOGICAL'); const ypStg = byCls('POSTTHERAPY_PATHOLOGICAL'); const ntStg = byCls('NON_TNM');
  if (cStg) stageParts.push(fmtCls(cStg, 'Clinical:'));
  if (pStg) stageParts.push(fmtCls(pStg, 'Pathological:'));
  if (ypStg) stageParts.push(fmtCls(ypStg, 'Posttherapy:'));
  if (ntStg) stageParts.push(fmtCls(ntStg, 'Classification:'));
  if (!stageParts.length && st) stageParts.push(st.stageResult + ' (' + (st.stagingAuthority || '') + ')');
  const stageCell = stageParts.length ? stageParts.join(' · ') : '—';
  const header = el('div', { class: 'pheader' },
    pcell('Patient', p.name),
    pcell('MRN', p.mrn),
    pcell('Age / Sex', (p.dob ? Math.floor((Date.now() - new Date(p.dob)) / 3.15576e10) : '—') + ' / ' + p.sex),
    pcell('Diagnosis', dx ? dx.cancerTypeLabel : '—'),
    pcell('Stage', stageCell),
    pcell('Intent', ord ? '' : (chart.carePlans.find(c => c.status === 'SIGNED') ? 'planned' : '—')),
    pcell('Active treatment', ord ? ord.regimenName : '—'),
    pcell('Cycle', ord ? 'C' + Math.max(...ord.cycleDays.map(c => c.cycle)) + '/' + ord.plannedCycles : '—'),
    pcell('ECOG', p.ecog ?? '—'),
    pcell('Allergies', (p.allergies && p.allergies.length) ? p.allergies.join(', ') : 'NKDA'),
    pcell('Next action', nextTask ? nextTask.title : '—')
  );
  main.append(header);
}
function pcell(k, v) { return el('div', { class: 'cell' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, String(v))); }

// --- tabs -------------------------------------------------------------------------
function tabOverview(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Journey status'));
  const steps = ['Registered', 'Consulted', 'Diagnosed', 'Staged', 'MDT/Planned', 'Financed', 'Ready', 'Ordered', 'Pharmacy', 'Administered'];
  const done = [];
  if (true) done.push(0);
  if (chart.consultations && chart.consultations.length) done.push(1);
  if (chart.diagnosis) done.push(2);
  if (chart.staging.current) done.push(3);
  if (chart.carePlans.some(x => x.status === 'SIGNED') || chart.mdt.some(m => m.status === 'SIGNED')) done.push(4);
  if (chart.finance.some(f => f.financialClearance === 'CLEARED')) done.push(5);
  if (chart.readiness.length) done.push(6);
  if (chart.treatmentOrders.some(o => o.status === 'SIGNED')) done.push(7);
  if (chart.pharmacy.some(p => p.status === 'RELEASED')) done.push(8);
  if (chart.administrations.some(a => a.status === 'COMPLETED')) done.push(9);
  const bar = el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' });
  steps.forEach((s, i) => bar.append(el('span', { class: 'badge ' + (done.includes(i) ? 'done' : 'draft'), style: 'margin-right:4px' }, s)));
  c.append(bar);
  body.append(c);

  const open = chart.tasks.filter(t => t.status === 'OPEN');
  const c2 = el('div', { class: 'card' });
  c2.append(el('h2', {}, 'Open workflow tasks'));
  if (!open.length) c2.append(el('div', { class: 'muted' }, 'No open tasks.'));
  for (const t of open) c2.append(el('div', { class: 'taskrow' }, el('div', {}, el('div', { class: 't-title' }, t.title), el('div', { class: 't-meta' }, 'Role: ' + t.role + ' · due ' + fmtDate(t.dueAt))), el('span', { class: 'badge open' }, t.role)));
  body.append(c2);
}

function tabConsultations(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Consultations'));
  if (!chart.consultations || !chart.consultations.length) c.append(el('div', { class: 'muted' }, 'No consultations recorded.'));
  for (const co of (chart.consultations || [])) {
    c.append(el('div', { class: 'prov' }, fmtDate(co.at) + ' — ' + co.consultationType + ' — ECOG ' + co.ecog + ' — by ' + co.byName));
    c.append(el('div', { class: 'kv' }, el('div', { class: 'k' }, 'Chief complaint'), el('div', {}, co.chiefComplaint || '—')));
  }
  body.append(c);
}

async function tabInvestigations(body, chart) {
  const orders = (await api('/investigation-orders')).filter(o => o.patientUuid === chart.patient.uuid);
  const results = await api('/results?patientUuid=' + chart.patient.uuid);
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Investigation orders & results'));
  const tb = el('tbody');
  for (const o of orders) {
    const res = results.find(r => r.orderUuid === o.uuid);
    tb.append(el('tr', {},
      el('td', {}, fmtDate(o.orderedAt)), el('td', {}, o.category), el('td', {}, o.test),
      el('td', {}, el('span', { class: 'badge ' + (o.status === 'RESULTED' ? 'done' : 'open') }, o.status)),
      el('td', {}, res ? res.summary : '—')));
  }
  if (!orders.length) c.append(el('div', { class: 'muted' }, 'No investigations ordered.'));
  else c.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Ordered'), el('th', {}, 'Category'), el('th', {}, 'Test'), el('th', {}, 'Status'), el('th', {}, 'Result'))), tb));
  body.append(c);
}

function tabDiagnosis(body, chart) {
  const dx = chart.diagnosis;
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Signed cancer diagnosis'));
  if (!dx) { c.append(el('div', { class: 'muted' }, 'No signed diagnosis yet. Staging is blocked until a diagnosis is signed.')); body.append(c); return; }
  c.append(el('div', { class: 'kv' },
    el('div', { class: 'k' }, 'Cancer type'), el('div', {}, dx.cancerTypeLabel),
    el('div', { class: 'k' }, 'Primary site'), el('div', {}, dx.primarySite),
    el('div', { class: 'k' }, 'Subsite'), el('div', {}, dx.subsite || '—'),
    el('div', { class: 'k' }, 'Laterality'), el('div', {}, dx.laterality || '—'),
    el('div', { class: 'k' }, 'Histology / morphology'), el('div', {}, dx.histology + (dx.morphology ? ' / ' + dx.morphology : '')),
    el('div', { class: 'k' }, 'Grade'), el('div', {}, dx.grade || '—'),
    el('div', { class: 'k' }, 'ICD-10 / ICD-O'), el('div', {}, [dx.icd10, dx.icdOtopography, dx.icdOmorphology].filter(Boolean).join(' · ') || '—'),
    el('div', { class: 'k' }, 'Diagnosis date'), el('div', {}, fmtDate(dx.diagnosisDate)),
    el('div', { class: 'k' }, 'Basis'), el('div', {}, dx.diagnosisBasis),
    el('div', { class: 'k' }, 'Confirming oncologist'), el('div', {}, dx.confirmingOncologistName + ' · signed ' + fmtDate(dx.signedAt))
  ));
  if (dx.biomarkers && dx.biomarkers.length) {
    c.append(el('h3', {}, 'Biomarkers'));
    for (const b of dx.biomarkers) c.append(el('div', { class: 'prov' }, b.code + ': ' + b.value));
  }
  if (dx.evidence && dx.evidence.length) {
    c.append(el('h3', {}, 'Evidence (provenance)'));
    for (const e of dx.evidence) c.append(el('div', { class: 'prov' }, 'Source: ' + e.type + ' · result ' + e.resultUuid.slice(0, 8) + '…'));
  }
  c.append(el('div', { class: 'prov' }, '✓ Signed & immutable · T/N/M deliberately excluded — staging is a separate object'));
  body.append(c);
}

async function tabStaging(body, chart) {
  // §33/§35: CURRENT per-classification summary first, then full history
  let summary = null;
  try { summary = await api('/staging/summary/' + chart.patient.uuid); } catch (e) { /* read-only */ }
  const cur = el('div', { class: 'card' });
  cur.append(el('h2', {}, 'CURRENT — staging per classification'));
  const clsRows = [['clinical', 'Clinical Stage'], ['pathological', 'Pathological Stage'], ['posttherapyClinical', 'Posttherapy Clinical Stage'], ['posttherapyPathological', 'Posttherapy Pathological Stage'], ['recurrence', 'Recurrence / Restaging'], ['nonTnm', 'Disease Classification']];
  let any = false;
  if (summary) {
    for (const [key, label] of clsRows) {
      if (!summary[key]) continue;
      any = true;
      cur.append(el('div', { class: 'prov' },
        el('b', {}, label + ':'), ' ' + (summary[key].stage || '—') +
        ' · ' + (summary[key].authority || '—') + ' ' + (summary[key].version || '') +
        ' · signed ' + fmtDate(summary[key].signedAt)));
    }
  }
  if (!any) cur.append(el('div', { class: 'muted' }, chart.diagnosis ? 'No signed staging yet — staging requires a signed diagnosis (stop-gate).' : 'Requires signed diagnosis first.'));
  body.append(cur);

  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'STAGING HISTORY (supersede chain — never overwritten)'));
  const h = chart.staging.history || [];
  let results = [];
  try { results = await api('/results?patientUuid=' + chart.patient.uuid); } catch (e) { /* read-only */ }
  if (!h.length) c.append(el('div', { class: 'muted' }, 'No assessments recorded.'));
  for (const s of h) {
    const prefix = s.classificationPrefix || { PATHOLOGICAL: 'p', POSTTHERAPY_CLINICAL: 'yc', POSTTHERAPY_PATHOLOGICAL: 'yp', RECURRENCE_RETREATMENT: 'r', AUTOPSY: 'a' }[s.stagingContext] || 'c';
    // §55: non-TNM classifications must never be labelled with TNM framing
    const ctxLabel = s.stagingContext === 'NON_TNM' ? 'Disease classification (non-TNM)' : s.stagingContext + ' (' + prefix + 'TNM)';
    const row = el('div', { class: 'prov' },
      el('b', {}, ctxLabel), ' · ' + s.diseaseSite + ' · result: ' + el2s(s.stageResult) +
      ' · authority ' + s.stagingAuthority + ' v' + s.authorityVersion +
      ' · ' + fmtDate(s.assessmentDate) + ' · ' + s.clinicianName + ' ',
      el('span', { class: 'badge ' + s.status }, s.status));
    // §31: disagreement is recorded, never hand-edited — the signed result carries a
    // visible flag action for the oncologist.
    if (s.status === 'SIGNED' && s.stageResult && state.user.role === 'Medical Oncologist') {
      row.append(el('button', { class: 'btn small secondary', style: 'margin-left:6px', onclick: () => flagStagingDiscrepancyModal(s) }, 'Flag discrepancy'));
    }
    c.append(row);
    const openFlags = (chart.staging.discrepancyFlags || []).filter(f => f.stagingAssessmentUuid === s.uuid);
    for (const f of openFlags) {
      c.append(el('div', { class: 'stopgate', style: 'margin-left:12px' },
        'DISCREPANCY FLAG (' + f.status + ', ' + f.flaggedByName + ', ' + fmtDate(f.flaggedAt) + '): ' + f.reason +
        ' — requested correction: ' + f.requestedCorrection + (f.resolvedByAssessmentUuid ? ' · resolved by corrected staging' : '')));
    }
    for (const ev of s.evidence || []) {
      const src = results.find(r => r.uuid === (ev.sourceRef || ev.resultUuid));
      const evLine = el('div', { style: 'font-size:12px;color:#555;margin-left:12px' },
        '· ' + (ev.variableKey || 'general') + ' ← ' + ev.sourceType + (ev.supportingFinding ? ' — ' + ev.supportingFinding : '') + (ev.sourceDate ? ' (' + fmtDate(ev.sourceDate) + ')' : '') + ' ');
      // D7: VIEW SOURCE — opens the exact signed evidence record
      if (src) {
        evLine.append(el('button', {
          class: 'btn small secondary', style: 'margin-left:6px', onclick: () => {
            const modal = el('div', { class: 'card', style: 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:560px;max-height:70vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
            modal.append(el('h3', {}, 'SOURCE — ' + src.category + ': ' + src.test),
              el('div', { class: 'prov' }, 'Status: ' + src.status + ' · finalized ' + fmtDate(src.finalizedAt) + ' by ' + src.byName));
            modal.append(el('pre', { style: 'white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:8px;border-radius:6px' },
              (src.summary || '') + '\n\n' + (src.details ? JSON.stringify(src.details, null, 2) : '')));
            modal.append(el('button', { class: 'btn small', onclick: () => modal.remove() }, 'Close source'));
            document.body.append(modal);
          }
        }, 'VIEW SOURCE'));
      }
      c.append(evLine);
    }
  }
  body.append(c);
}
function el2s(x) { return x === undefined || x === null ? '—' : String(x); }

function tabMdt(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'MDT cases'));
  if (!chart.mdt.length) c.append(el('div', { class: 'muted' }, 'No MDT cases.'));
  for (const m of chart.mdt) {
    c.append(el('div', { class: 'prov' }, fmtDate(m.openedAt) + ' — ' + m.referralReason + ' '));
    c.append(el('span', { class: 'badge ' + m.status }, m.status));
    c.append(el('div', { class: 'kv mt8' },
      el('div', { class: 'k' }, 'Decision'), el('div', {}, m.decision || '—'),
      el('div', { class: 'k' }, 'Consensus'), el('div', {}, m.consensus || '—'),
      el('div', { class: 'k' }, 'Dissent'), el('div', {}, m.dissent || '—'),
      el('div', { class: 'k' }, 'Responsible'), el('div', {}, m.responsibleClinician || '—')));
  }
  body.append(c);
}

function tabCarePlan(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Treatment care plans'));
  if (!chart.carePlans.length) c.append(el('div', { class: 'muted' }, 'No care plans. Care plan requires signed staging (stop-gate).'));
  for (const p of chart.carePlans) {
    c.append(el('div', { class: 'prov' }, fmtDate(p.createdAt) + ' — intent: ' + p.treatmentIntent + ' · line: ' + p.lineOfTherapy + ' '), el('span', { class: 'badge ' + p.status }, p.status));
    c.append(el('div', { class: 'kv mt8' },
      el('div', { class: 'k' }, 'Modalities'), el('div', {}, (p.modalitySequence || []).map(m => m.modality).join(' → ') || p.systemicTherapy || '—'),
      el('div', { class: 'k' }, 'Expected start'), el('div', {}, fmtDate(p.expectedStart)),
      el('div', { class: 'k' }, 'Rationale'), el('div', {}, p.rationale || '—'),
      el('div', { class: 'k' }, 'Oncologist'), el('div', {}, p.oncologistName + (p.signedAt ? ' · signed ' + fmtDate(p.signedAt) : ' · DRAFT'))));
  }
  body.append(c);
}

function tabTreatment(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Treatment orders & cycles'));
  if (!chart.treatmentOrders.length) c.append(el('div', { class: 'muted' }, 'No treatment orders. Requires signed care plan + readiness (stop-gates).'));
  for (const o of chart.treatmentOrders) {
    c.append(el('div', { class: 'prov' },
      el('b', {}, o.regimenName), ' v' + o.regimenVersion + ' · ' + o.plannedCycles + ' cycles · BSA ' + o.bsa +
      ' · start ' + fmtDate(o.startDate) + ' ', el('span', { class: 'badge ' + o.status }, o.status)));
    const tb = el('tbody');
    for (const cd of o.cycleDays.slice(0, 40)) {
      tb.append(el('tr', {},
        el('td', {}, 'C' + cd.cycle + 'D' + cd.day),
        el('td', {}, fmtDate(cd.plannedDate)),
        el('td', {}, cd.phase),
        el('td', {}, cd.medication),
        el('td', {}, cd.orderedDose + ' ' + cd.doseUnits + (cd.reductionPercent ? ' (−' + cd.reductionPercent + '%: ' + cd.reductionReason + ')' : '')),
        el('td', {}, el('span', { class: 'badge ' + cd.status }, cd.status))));
    }
    c.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Cycle/Day'), el('th', {}, 'Planned'), el('th', {}, 'Phase'), el('th', {}, 'Medication'), el('th', {}, 'Dose'), el('th', {}, 'Status'))), tb));
  }
  body.append(c);
}

function tabPatientCalendar(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Patient event calendar'));
  const tb = el('tbody');
  const today = new Date().toISOString().slice(0, 10);
  for (const e of chart.events) {
    tb.append(el('tr', {}, el('td', {}, fmtDate(e.plannedDate)), el('td', {}, e.title), el('td', {}, el('span', { class: 'badge ' + e.state }, e.state))));
  }
  if (!chart.events.length) c.append(el('div', { class: 'muted' }, 'No events projected yet. A signed treatment order generates cycles, labs, toxicity reviews and response assessment automatically.'));
  else c.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Planned'), el('th', {}, 'Event'), el('th', {}, 'State'))), tb));
  body.append(c);
}

function tabPharmacy(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Pharmacy'));
  if (!chart.pharmacy.length) c.append(el('div', { class: 'muted' }, 'Nothing in pharmacy queue.'));
  for (const r of chart.pharmacy) {
    const order = chart.treatmentOrders.find(o => o.uuid === r.orderUuid);
    c.append(el('div', { class: 'prov' },
      fmtDate(r.receivedAt) + ' — ' + (order ? order.regimenName : '') + ' ', el('span', { class: 'badge ' + r.status }, r.status),
      r.rejectionReason ? ' — ' + r.rejectionReason : ''));
    c.append(el('div', { style: 'font-size:12px;margin-left:10px' },
      'Regimen verified: ' + yn(r.regimenVerified) + ' · Dose verified: ' + yn(r.doseVerified) +
      ' · Allergy: ' + yn(r.allergyCheck) + ' · Interaction: ' + yn(r.interactionCheck) +
      ' · Compatibility: ' + yn(r.compatibilityCheck) + ' · Stability: ' + yn(r.stabilityCheck) +
      ' · Stock: ' + yn(r.stockAllocated) + ' · Independent check: ' + (r.independentCheckBy || '—')));
  }
  body.append(c);
}
function yn(b) { return b ? '✓' : '✗'; }

function tabAdministration(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Day care administrations'));
  if (!chart.administrations.length) c.append(el('div', { class: 'muted' }, 'No administrations. Preparation is not administration — requires a RELEASED order (stop-gate).'));
  for (const a of chart.administrations) {
    c.append(el('div', { class: 'prov' }, fmtDate(a.arrival) + ' — status: ' + a.status + ' · nurse: ' + a.nurseName));
    for (const l of a.lines || []) {
      c.append(el('div', { style: 'font-size:12px;margin-left:10px' }, l.phase + ' ' + l.medication + ' — actual ' + l.actualDose + ' via ' + l.route + (l.reaction ? ' ⚠ reaction: ' + l.reaction.type : '')));
    }
  }
  body.append(c);
}

function tabToxicity(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Toxicity assessments'));
  if (!chart.toxicities.length) c.append(el('div', { class: 'muted' }, 'No toxicity recorded.'));
  for (const t of chart.toxicities) {
    c.append(el('div', { class: 'prov' }, fmtDate(t.onset) + ' — ' + t.type + ' Grade ' + t.grade + ' · attribution ' + t.attribution + ' · ' + t.resolution + ' '),
      el('span', { class: 'badge ' + (t.status || 'SIGNED') }, t.status || 'SIGNED'));
    if (t.treatmentDelay || t.doseReduction || t.discontinuation) {
      c.append(el('div', { style: 'font-size:12px;margin-left:10px;color:var(--warn)' },
        (t.treatmentDelay ? 'delay flagged · ' : '') + (t.doseReduction ? 'dose reduction: ' + t.doseReduction.medication + ' −' + t.doseReduction.newReductionPercent + '% · ' : '') + (t.discontinuation ? 'discontinued' : '')));
    }
  }
  body.append(c);
}

function tabResponse(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Response assessments'));
  if (!chart.responses.length) c.append(el('div', { class: 'muted' }, 'No response assessments.'));
  for (const r of chart.responses) {
    c.append(el('div', { class: 'prov' }, fmtDate(r.at) + ' — ' + r.category + ' → decision: ' + r.decision + ' · ' + r.assessedByName));
  }
  // UI entry point for response assessment (MO) — previously backend-only
  if (state.user.role === 'Medical Oncologist' && chart.diagnosis) {
    const btn = el('button', { class: 'btn secondary', onclick: () => {
      const t = { uuid: null, code: 'RESPONSE_ASSESS', destination: 'response', title: 'Record response assessment', patientUuid: chart.patient.uuid, payload: {} };
      state.view = { name: 'task', task: t };
      render();
    } }, 'Record response assessment');
    c.append(btn);
  }
  body.append(c);
}

// D2: Consent tab — signed consents visible/reopenable, history preserved
function tabConsent(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Treatment consent'));
  if (!chart.consents || !chart.consents.length) c.append(el('div', { class: 'muted' }, 'No consent records. Consent is required before readiness can clear (canonical §47).'));
  for (const csn of chart.consents || []) {
    c.append(el('div', { class: 'prov' },
      fmtDate(csn.createdAt) + ' — ' + csn.consentType + ' · template ' + csn.templateCode + ' v' + csn.templateVersion +
      ' · ack: ' + csn.acknowledgedBy + ' · clinician: ' + csn.clinicianName + ' ',
      el('span', { class: 'badge ' + (csn.status === 'SIGNED' ? 'signed' : 'draft') }, csn.status)));
    c.append(el('div', { style: 'font-size:12px;margin-left:10px' },
      'Risks: ' + csn.risksDiscussed + ' · Benefits: ' + csn.benefitsDiscussed + ' · Alternatives: ' + csn.alternativesDiscussed +
      (csn.fertilityDiscussed ? ' · fertility ✓' : '') + (csn.pregnancyCounselling ? ' · pregnancy ✓' : '') +
      (csn.supersedes ? ' · supersedes v' + (csn.version - 1) : '') + (csn.signedAt ? ' · signed ' + fmtDate(csn.signedAt) : ' · DRAFT (unsigned)')));
  }
  body.append(c);
}

// D4: Disease profile / biomarkers tab (view; entry via task or button below)
function tabDiseaseProfile(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Disease profile & biomarkers'));
  if (!chart.diseaseProfiles || !chart.diseaseProfiles.length) {
    c.append(el('div', { class: 'muted' }, 'No disease profile recorded.'));
    if (chart.diagnosis) {
      c.append(el('button', { class: 'btn', onclick: () => openDiseaseProfileForm(chart) }, 'Record disease profile / biomarkers'));
    } else {
      c.append(el('div', { class: 'muted' }, 'Requires a signed diagnosis first.'));
    }
  }
  for (const dp of chart.diseaseProfiles || []) {
    c.append(el('div', { class: 'prov' }, fmtDate(dp.createdAt) + ' — by ' + dp.createdByName + ' ', el('span', { class: 'badge ' + (dp.status === 'SIGNED' ? 'signed' : 'draft') }, dp.status)));
    if (dp.histology) c.append(el('div', { style: 'font-size:12px;margin-left:10px' }, 'Histology: ' + dp.histology + (dp.grade ? ' · ' + dp.grade : '')));
    for (const b of dp.biomarkerResults || []) {
      c.append(el('div', { style: 'font-size:12px;margin-left:10px' },
        '· ' + b.code + ': ' + (b.qualitative || '') + (b.quantitative !== null && b.quantitative !== undefined ? ' ' + b.quantitative + (b.unit ? ' ' + b.unit : '') : '') +
        (b.method ? ' (' + b.method + ')' : '') + (b.interpretation ? ' — ' + b.interpretation : '') +
        (b.sourceResultUuid ? ' · source ' + b.sourceResultUuid.slice(0, 8) + '…' : '')));
    }
  }
  body.append(c);
}

// D4: biomarker entry modal (master-applicability-driven per cancer type)
async function openDiseaseProfileForm(chart) {
  const bms = await api('/biomarkers?cancerType=' + (chart.diagnosis.cancerType || ''));
  if (!bms.length) { toast('No governed biomarkers configured for ' + chart.diagnosis.cancerType, true); return; }
  const results = await api('/results?patientUuid=' + chart.patient.uuid);
  const modal = el('div', { class: 'card', style: 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:720px;max-height:80vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
  modal.append(el('h2', {}, 'Disease profile — ' + chart.diagnosis.cancerTypeLabel));
  const rows = [];
  for (const b of bms) {
    const val = el('input', { placeholder: 'Result (e.g. POSITIVE / 22)' });
    const method = el('input', { placeholder: 'Method (IHC/FISH/PCR)' });
    const unit = el('input', { placeholder: 'Unit (optional)' });
    const interp = el('input', { placeholder: 'Interpretation (optional)' });
    const src = el('select', {}, el('option', { value: '' }, '— source report —'), ...results.map(r => el('option', { value: r.uuid }, r.test + ' (' + fmtDate(r.finalizedAt) + ')')));
    rows.push({ code: b.code, val, method, unit, interp, src });
    modal.append(el('div', { class: 'grid3' }, wrap(b.code + ' — ' + b.label, val), wrap('Method', method), wrap('Unit', unit)),
      el('div', { class: 'grid2' }, wrap('Interpretation', interp), wrap('Source report', src)));
  }
  modal.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const biomarkerResults = rows.filter(r => r.val.value.trim()).map(r => ({
          code: r.code, qualitative: r.val.value.trim(), method: r.method.value || null,
          unit: r.unit.value || null, interpretation: r.interp.value || null, sourceResultUuid: r.src.value || null
        }));
        if (!biomarkerResults.length) return toast('Enter at least one biomarker result', true);
        const dp = await api('/disease-profiles', { method: 'POST', body: { patientUuid: chart.patient.uuid, diagnosisUuid: chart.diagnosis.uuid, biomarkerResults } });
        await api('/disease-profiles/' + dp.uuid + '/sign', { method: 'POST', body: {} });
        toast('Disease profile signed — staging can consume these biomarkers');
        modal.remove(); render();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Save & sign disease profile'));
  modal.append(el('button', { class: 'btn secondary', style: 'margin-left:8px', onclick: () => modal.remove() }, 'Cancel'));
  document.body.append(modal);
}

// Financial counselling tab (visibility for the canonical workspace list)
function tabFinance(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Financial counselling'));
  if (!chart.finance.length) c.append(el('div', { class: 'muted' }, 'No financial counselling records. Counselling follows a signed care plan.'));
  for (const f of chart.finance) {
    c.append(el('div', { class: 'prov' }, fmtDate(f.at) + ' — ' + f.plannedTreatment + ' · est. cost ' + f.costEstimate +
      ' · payer: ' + f.payerType + (f.insurerTpa ? ' (' + f.insurerTpa + ')' : '') +
      ' · patient choice: ' + f.patientChoice + ' ', el('span', { class: 'badge ' + (f.financialClearance === 'CLEARED' ? 'done' : 'draft') }, f.financialClearance)));
    c.append(el('div', { style: 'font-size:12px;margin-left:10px' },
      'Auth: ' + (f.authorization && f.authorization.number ? f.authorization.number + ' (' + f.authorization.status + ')' : 'n/a (self-pay)') +
      ' · self-pay: ' + f.selfPayComponent + ' · counsellor: ' + f.counsellorName +
      (f.counsellingNote ? ' · note: ' + f.counsellingNote : '')));
  }
  body.append(c);
}

function tabDocuments(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Documents'));
  const docs = [];
  for (const d of chart.staging.history || []) docs.push(['Staging assessment ' + d.stagingContext, d.status, d.signedAt]);
  for (const p of chart.carePlans) docs.push(['Treatment care plan', p.status, p.signedAt]);
  for (const o of chart.treatmentOrders) docs.push(['Treatment order ' + o.regimenName, o.status, o.signedAt]);
  for (const m of chart.mdt) docs.push(['MDT outcome', m.status, m.signedAt]);
  for (const f of chart.finance) docs.push(['Financial counselling', f.status || 'SIGNED', f.signedAt]);
  for (const s of chart.surgery) docs.push(['Surgical plan', s.status, s.signedAt]);
  for (const r of chart.rt) docs.push(['RT prescription', r.status, r.signedAt]);
  const tb = el('tbody');
  for (const d of docs) tb.append(el('tr', {}, el('td', {}, d[0]), el('td', {}, el('span', { class: 'badge ' + (d[1] === 'SIGNED' ? 'signed' : 'draft') }, d[1])), el('td', {}, fmtDate(d[2]))));
  c.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Document'), el('th', {}, 'Status'), el('th', {}, 'Signed'))), tb));
  body.append(c);
}

function tabTimeline(body, chart) {
  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'Longitudinal timeline'));
  const items = [];
  for (const e of chart.events) items.push({ date: e.plannedDate, title: e.title, state: e.state });
  for (const t of chart.toxicities) items.push({ date: t.onset, title: 'Toxicity: ' + t.type + ' G' + t.grade, state: 'COMPLETED' });
  for (const r of chart.responses) items.push({ date: r.at, title: 'Response: ' + r.category, state: 'COMPLETED' });
  // §46: the timeline is an index over authoritative records — draft assessments are
  // not yet clinical facts and must never appear as completed events.
  for (const d of (chart.staging.history || []).filter(s => s.status !== 'DRAFT')) {
    const stateLabel = d.status === 'SUPERSEDED' ? 'SUPERSEDED' : d.status === 'SIGNED' ? 'COMPLETED' : d.status;
    items.push({ date: d.assessmentDate, title: 'Staging ' + d.stagingContext + ' → ' + d.stageResult, state: stateLabel });
  }
  if (chart.diagnosis) items.push({ date: chart.diagnosis.diagnosisDate, title: 'Diagnosis signed: ' + chart.diagnosis.cancerTypeLabel, state: 'COMPLETED' });
  items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const tl = el('div', { class: 'timeline' });
  if (!items.length) tl.append(el('div', { class: 'muted' }, 'Timeline empty.'));
  for (const i of items.slice(-30)) {
    tl.append(el('div', { class: 'tl-item ' + (i.state === 'PROJECTED' ? 'PROJECTED' : i.state === 'COMPLETED' ? 'COMPLETED' : '') },
      el('div', { class: 'tl-date' }, fmtDate(i.date) + ' · ' + i.state),
      el('div', {}, i.title)));
  }
  c.append(tl);
  body.append(c);
}

// ---------------------------------------------------------------------------
// TASK FORMS (each binds a role's action to a signed record + auto task)

// D2 fix: treatment-specific informed consent (canonical §47)
async function formConsent(card, task, chart, done) {
  const plans = chart.carePlans.filter(p => p.status === 'SIGNED');
  if (!plans.length) { card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: consent requires a SIGNED care plan.')); return; }
  const tpls = await api('/consent-templates');
  const typeMap = { SYSTEMIC_THERAPY: 'SYSTEMIC_THERAPY_V1', RADIOTHERAPY: 'RADIOTHERAPY_V1', SURGERY: 'SURGERY_V1' };
  const typeSel = el('select', {}, ...Object.keys(typeMap).map(v => el('option', { value: v }, v.replace(/_/g, ' '))));
  const planSel = el('select', {}, ...plans.map(p => el('option', { value: p.uuid }, 'Plan ' + p.uuid.slice(0, 8) + ' — ' + p.treatmentIntent)));
  const risks = el('textarea', { placeholder: 'Risks discussed *' });
  const benefits = el('textarea', { placeholder: 'Benefits discussed *' });
  const alternatives = el('textarea', { placeholder: 'Alternatives discussed *' });
  const ack = el('input', { placeholder: 'Patient / caregiver acknowledgement (name) *' });
  const fert = el('input', { type: 'checkbox' }); const preg = el('input', { type: 'checkbox' });
  const sched = el('input', { type: 'checkbox' }); const adv = el('input', { type: 'checkbox' });
  const lang = el('select', {}, ['EN', 'HI', 'TA', 'TE', 'BN', 'MR'].map(v => el('option', { value: v }, v)));
  card.append(el('div', { class: 'grid3' }, wrap('Consent type *', typeSel), wrap('Care plan *', planSel), wrap('Language', lang)));
  card.append(wrap('Risks discussed *', risks), wrap('Benefits discussed *', benefits), wrap('Alternatives discussed *', alternatives));
  card.append(el('div', { class: 'checkbox-row' }, fert, el('span', {}, 'Fertility implications discussed')));
  card.append(el('div', { class: 'checkbox-row' }, preg, el('span', {}, 'Pregnancy-related counselling done')));
  card.append(el('div', { class: 'checkbox-row' }, sched, el('span', {}, 'Expected schedule explained')));
  card.append(el('div', { class: 'checkbox-row' }, adv, el('span', {}, 'Adverse effects + emergency instructions explained')));
  card.append(wrap('Acknowledged by *', ack));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const c = await api('/consents', { method: 'POST', body: {
          patientUuid: chart.patient.uuid, carePlanUuid: planSel.value,
          consentType: typeSel.value, templateCode: typeMap[typeSel.value],
          discussedRisks: risks.value, discussedBenefits: benefits.value, discussedAlternatives: alternatives.value,
          fertilityDiscussed: fert.checked, pregnancyCounselling: preg.checked,
          scheduleExplained: sched.checked, adverseEffectsExplained: adv.checked,
          acknowledgedBy: ack.value, language: lang.value
        }});
        await api('/consents/' + c.uuid + '/sign', { method: 'POST', body: {} });
        toast('Consent signed & immutable — readiness gate can now accept consent');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign consent'));
}

// ---- Structured consultation encounter (directive §1–2) -------------------
// Sections, not one notes textarea. Investigation discussion is separate from
// orders: only explicit ORDER_NOW items become InvestigationOrders at sign.
async function formConsultation(card, task, chart, done) {
  const typeSel = el('select', {},
    el('option', { value: 'FIRST_ONCOLOGY' }, 'First oncology consultation'),
    el('option', { value: 'FOLLOW_UP' }, 'Follow-up'));
  const ecogSel = el('select', {}, ...['0', '1', '2', '3', '4'].map(v => el('option', { value: v }, 'ECOG ' + v)));
  const karnofsky = el('input', { type: 'number', min: '0', max: '100', placeholder: '0–100 (if configured)' });
  const pain = el('input', { type: 'number', min: '0', max: '10', placeholder: '0–10' });
  const nutrition = el('input', { placeholder: 'Nutritional status' });
  const reason = el('input', { placeholder: 'Reason for visit' });
  const complaint = el('input', { placeholder: 'Chief complaint *' });
  const hpi = el('textarea', { placeholder: 'History of present illness' });
  const priorCancer = el('input', { placeholder: 'Prior cancer history (diagnosis / pathology / imaging / surgery / RT / systemic — none if blank)' });
  const comorbid = el('input', { placeholder: 'Comorbidities' });
  const meds = el('input', { placeholder: 'Current medications' });
  const allergies = el('input', { placeholder: 'Allergies / previous reactions' });
  const smoking = el('select', {}, el('option', { value: 'NEVER' }, 'Never smoker'), el('option', { value: 'FORMER' }, 'Former smoker'), el('option', { value: 'CURRENT' }, 'Current smoker'));
  const packYears = el('input', { type: 'number', min: '0', placeholder: 'Pack-years' });
  const family = el('input', { placeholder: 'Family history of cancer' });
  const height = el('input', { type: 'number', step: '0.1', placeholder: 'cm' });
  const weight = el('input', { type: 'number', step: '0.1', placeholder: 'kg' });
  const exam = el('textarea', { placeholder: 'Physical examination' });
  const assessment = el('textarea', { placeholder: 'Clinical assessment' });
  const differential = el('input', { placeholder: 'Differential diagnosis' });
  const invPlan = el('textarea', { placeholder: 'Investigation plan (narrative)' });
  const fuPlan = el('textarea', { placeholder: 'Follow-up plan' });

  card.append(el('div', { class: 'stopgate' }, 'Discussion is not an order: items marked ORDER_NOW become investigation orders when the consultation is signed. CONSIDER / DISCUSS / RECOMMEND / PLAN_LATER never order.'));
  card.append(el('div', { class: 'grid3' },
    wrap('Consultation type', typeSel), wrap('ECOG *', ecogSel), wrap('Karnofsky (if configured)', karnofsky),
    wrap('Pain score', pain), wrap('Nutritional status', nutrition), wrap('Height (cm)', height)),
    el('div', { class: 'grid3' },
      wrap('Weight (kg)', weight), wrap('Reason for visit', reason), wrap('Chief complaint', complaint)),
    wrap('History of present illness', hpi),
    wrap('Prior cancer history', priorCancer),
    el('div', { class: 'grid3' }, wrap('Comorbidities', comorbid), wrap('Current medications', meds), wrap('Allergies / reactions', allergies)),
    el('div', { class: 'grid3' }, wrap('Smoking', smoking), wrap('Pack-years', packYears), wrap('Family history', family)),
    wrap('Physical examination', exam),
    el('div', { class: 'grid2' }, wrap('Clinical assessment', assessment), wrap('Differential diagnosis', differential)),
    el('div', { class: 'grid2' }, wrap('Investigation plan (narrative)', invPlan), wrap('Follow-up plan', fuPlan)));

  // Investigation discussion builder (directive §2)
  const tests = state.cache.diagnosticTests || (state.cache.diagnosticTests = await api('/diagnostic-tests'));
  const discCat = el('select', {}, ...['LAB', 'RADIOLOGY', 'PATHOLOGY', 'MOLECULAR', 'GENETIC', 'PROCEDURE'].map(c => el('option', { value: c }, c)));
  const discTest = el('select', {}, el('option', { value: '' }, '— master test —'));
  const fillTests = () => {
    discTest.innerHTML = '';
    discTest.append(el('option', { value: '' }, '— master test —'));
    for (const t of tests.filter(t => t.category === discCat.value)) discTest.append(el('option', { value: t.code }, t.label + ' (' + t.testCode + ')'));
  };
  fillTests();
  discCat.addEventListener('change', fillTests);
  const discAction = el('select', {}, ...['CONSIDER', 'DISCUSS', 'RECOMMEND', 'PLAN_LATER', 'ORDER_NOW'].map(a => el('option', { value: a }, a + (a === 'ORDER_NOW' ? ' — will order' : ' — discussion only'))));
  const discNotes = el('input', { placeholder: 'Note (e.g. "may do PET-CT next week")' });
  const discussion = [];
  const discBox = el('div', {});
  card.append(el('h3', {}, 'Investigation discussion (dropdown → dropdown, master-driven)'),
    el('div', { class: 'grid3' }, wrap('Discussion category', discCat), wrap('Discussion test', discTest), wrap('Discussion action', discAction)),
    wrap('Discussion note', discNotes),
    el('button', { class: 'btn small secondary', onclick: () => {
      discussion.push({ action: discAction.value, category: discCat.value, testCode: discTest.value || null, notes: discNotes.value });
      discBox.append(el('div', { class: 'prov' }, discAction.value + (discTest.value ? ' · ' + discCat.value + ': ' + (discTest.options[discTest.selectedIndex].text) : ' · (general)') + (discNotes.value ? ' — "' + discNotes.value + '"' : '')));
      discNotes.value = '';
    } }, '+ add discussion item'), discBox);

  card.append(el('button', {
    class: 'btn mt8', onclick: async () => {
      try {
        if (!complaint.value.trim()) { toast('Chief complaint is required', true); return; }
        const c = await api('/consultations', { method: 'POST', body: {
          patientUuid: chart.patient.uuid, consultationType: typeSel.value, ecog: ecogSel.value,
          karnofsky: karnofsky.value || undefined, painScore: pain.value || undefined, nutritionalStatus: nutrition.value || undefined,
          heightCm: height.value || undefined, weightKg: weight.value || undefined,
          reasonForVisit: reason.value, chiefComplaint: complaint.value, historyPresentIllness: hpi.value,
          priorCancerHistory: priorCancer.value ? { narrative: priorCancer.value } : null,
          comorbidities: comorbid.value, currentMedications: meds.value, allergies: allergies.value ? [allergies.value] : undefined,
          smokingHistory: { status: smoking.value, packYears: packYears.value ? Number(packYears.value) : 0 },
          familyHistory: family.value, physicalExamination: exam.value,
          clinicalAssessment: assessment.value, differentialDiagnosis: differential.value,
          investigationPlan: invPlan.value, followUpPlan: fuPlan.value,
          investigationDiscussion: discussion
        }});
        // two-step: draft → sign (order generation happens exactly at sign)
        card.innerHTML = '';
        card.append(el('h2', {}, 'Review consultation before signing'));
        card.append(el('div', { class: 'prov' },
          (c.data ? c.data.consultationType : c.consultationType) + ' · ECOG ' + ecogSel.value +
          ' · ' + discussion.filter(d => d.action === 'ORDER_NOW').length + ' ORDER_NOW item(s) → will generate orders'));
        card.append(el('div', { class: 'stopgate' }, 'Signing is immutable. Corrections create an amendment. ORDER_NOW items become investigation orders now.'));
        card.append(el('button', { class: 'btn', onclick: async () => {
          try {
            await api('/consultations/' + (c.data ? c.data.uuid : c.uuid) + '/sign', { method: 'POST', body: {} });
            toast('Consultation signed — orders generated, next tasks routed');
            await done();
          } catch (e) { toast(e.error, true); }
        } }, 'Sign consultation'),
        el('button', { class: 'btn secondary', style: 'margin-left:8px', onclick: () => { state.view = { name: 'worklist' }; render(); } }, 'Back'));
      } catch (e) { toast(e.error, true); }
    }
  }, 'Save draft'));
}

async function formDiagnosis(card, task, chart, done) {
  if (!chart.diagnosis) {
    card.append(el('div', { class: 'stopgate' }, 'This form captures the structured signed diagnosis via master cascades (family → site → subsite → histology). T/N/M are NOT captured here — staging is a separate signed object.'));
    const row1 = el('div', { class: 'grid3' });
    // §8 cascade: family first — it implies the site
    const fam = await masterSelect('cancerFamily'); row1.append(wrap('Cancer family *', fam));
    const ct = await masterSelect('cancerType'); row1.append(wrap('Cancer type *', ct));
    const ps = await masterSelect('primarySite'); row1.append(wrap('Primary site *', ps));
    fam.addEventListener('change', () => {
      const f = (state.cache.masters['cancerFamily'] || []).find(x => x.code === fam.value);
      if (f && f.site && f.site !== 'OTHER') ps.value = f.site;
      ps.dispatchEvent(new Event('change'));
    });
    const ss = el('select', {}); row1.append(wrap('Subsite (filtered by site)', ss));
    const fillSubs = async () => {
      ss.innerHTML = '';
      ss.append(el('option', { value: '' }, '— none —'));
      const subs = await loadMaster('subsite');
      for (const s of subs.filter(x => x.active && x.parent === ps.value)) ss.append(el('option', { value: s.code }, s.label));
    };
    ps.addEventListener('change', fillSubs);
    await fillSubs();
    const lat = el('select', {}, el('option', { value: '' }, '—'), ...['LEFT', 'RIGHT', 'BILATERAL', 'MIDLINE', 'N_A'].map(v => el('option', { value: v }, v)));
    const hist = await masterSelect('histology'); const mor = await masterSelect('morphology'); const gr = await masterSelect('grade');
    const behaviour = await masterSelect('behaviour');
    const icd = await masterSelect('icd10'); const icdT = await masterSelect('icdOtopography'); const icdM = await masterSelect('icdOmorphology');
    const icdOVer = await masterSelect('icdOVersion');
    const dDate = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const basis = el('select', {}, ...['PATHOLOGY', 'CYTOLOGY', 'BONE_MARROW', 'MOLECULAR', 'CLINICAL', 'IMAGING', 'OTHER'].map(v => el('option', { value: v }, v)));
    const certainty = el('select', {}, el('option', { value: '' }, '— auto from basis —'), ...['CLINICAL_ONLY', 'CLINICAL_INVESTIGATIVE', 'MICROSCOPIC_CONFIRMED', 'MICROSCOPIC_CONFIRMED_METASTATIC', 'BIOCHEMICAL_ANDOR_INVESTIGATIVE', 'CYTOLOGICAL_CONFIRMED'].map(v => el('option', { value: v }, v)));
    const primSec = el('select', {}, ...['PRIMARY', 'METASTATIC', 'RECURRENCE', 'NEW_PRIMARY', 'UNKNOWN'].map(v => el('option', { value: v, selected: v === 'PRIMARY' }, v)));
    const row2 = el('div', { class: 'grid3' });
    row2.append(wrap('Laterality', lat), wrap('Histology *', hist), wrap('Morphology', mor));
    const row3 = el('div', { class: 'grid3' });
    row3.append(wrap('Grade', gr), wrap('Behaviour (ICD-O)', behaviour), wrap('Differentiation', el('select', {}, el('option', { value: '' }, '—'), ...['WELL', 'MODERATE', 'POOR', 'UNDIFFERENTIATED'].map(v => el('option', { value: v }, v.toLowerCase())))));
    const row4 = el('div', { class: 'grid3' });
    row4.append(wrap('ICD-10', icd), wrap('ICD-O topography', icdT), wrap('ICD-O morphology', icdM));
    const row5 = el('div', { class: 'grid3' });
    row5.append(wrap('ICD-O version', icdOVer), wrap('Diagnosis date *', dDate), wrap('Basis of diagnosis *', basis));
    const row6 = el('div', { class: 'grid2' });
    row6.append(wrap('Diagnostic certainty', certainty), wrap('Primary / secondary', primSec));

    // evidence picker from finalized results
    const results = await api('/results?patientUuid=' + chart.patient.uuid);
    const evBox = el('div', {});
    const evidence = [];
    const evSel = el('select', {}, ...results.map(r => el('option', { value: r.uuid }, r.category + ': ' + r.test + ' (' + fmtDate(r.finalizedAt) + ')')));
    const evType = el('select', {}, ...['PATHOLOGICAL', 'RADIOLOGICAL', 'LABORATORY', 'MOLECULAR', 'CLINICAL', 'EXTERNAL_DOCUMENT'].map(v => el('option', { value: v }, v)));
    const addEv = el('button', {
      class: 'btn small secondary', onclick: () => {
        if (!evSel.value) return;
        evidence.push({ resultUuid: evSel.value, type: evType.value });
        evBox.append(el('div', { class: 'prov' }, evType.value + ' ← ' + evSel.options[evSel.selectedIndex].text));
      }
    }, '+ link evidence');
    card.append(row1, row2, row3, row4, row5, row6, el('h3', {}, 'Evidence (pathology / radiology / lab)'), el('div', { class: 'grid2' }, wrap('Result', evSel), wrap('Evidence type', evType)), addEv, evBox);

    card.append(el('div', { style: 'margin-top:10px' },
      el('button', {
        class: 'btn secondary', onclick: async () => {
          try {
            const dx = await api('/diagnoses', { method: 'POST', body: {
              patientUuid: chart.patient.uuid,
              cancerFamily: fam.value || undefined,
              cancerType: ct.value, primarySite: ps.value, subsite: ss.value || undefined, laterality: lat.value || undefined,
              histology: hist.value, morphology: mor.value || undefined, grade: gr.value || undefined,
              behaviour: behaviour.value || undefined,
              icd10: icd.value || undefined, icdOtopography: icdT.value || undefined, icdOmorphology: icdM.value || undefined,
              icdOVersion: icdOVer.value || undefined,
              diagnosisDate: dDate.value, diagnosisBasis: basis.value,
              diagnosticCertainty: certainty.value || undefined, primaryOrSecondary: primSec.value,
              evidence
            }});
            toast('Draft saved — review and sign below (two-step)');
            const s = await api('/diagnoses/' + dx.uuid + '/sign', { method: 'POST', body: {} });
            toast('Diagnosis signed & immutable — staging task generated');
            await done();
          } catch (e) { toast(e.error, true); }
        }
      }, 'Save draft'),
      el('button', {
        class: 'btn', style: 'margin-left:8px', onclick: async () => {
          try {
            const dx = await api('/diagnoses', { method: 'POST', body: {
              patientUuid: chart.patient.uuid,
              cancerFamily: fam.value || undefined,
              cancerType: ct.value, primarySite: ps.value, subsite: ss.value || undefined, laterality: lat.value || undefined,
              histology: hist.value, morphology: mor.value || undefined, grade: gr.value || undefined,
              behaviour: behaviour.value || undefined,
              icd10: icd.value || undefined, icdOtopography: icdT.value || undefined, icdOmorphology: icdM.value || undefined,
              icdOVersion: icdOVer.value || undefined,
              diagnosisDate: dDate.value, diagnosisBasis: basis.value,
              diagnosticCertainty: certainty.value || undefined, primaryOrSecondary: primSec.value,
              evidence
            }});
            // show a review step before signing — the clinician confirms the assembled record
            card.innerHTML = '';
            card.append(el('h2', {}, 'Review diagnosis before signing'));
            card.append(el('div', { class: 'prov' },
              dx.cancerTypeLabel + ' · ' + dx.histologyLabel + ' · ' + (dx.grade || 'no grade') + ' · ' + dx.diagnosisBasis + ' · ' + fmtDate(dx.diagnosisDate),
              el('div', { style: 'font-size:12px' }, 'ICD-10 ' + (dx.icd10 || '—') + ' · ICD-O T ' + (dx.icdOtopography || '—') + ' M ' + (dx.icdOmorphology || '—') + ' (' + dx.icdOVersion + ') · ' + (dx.evidence || []).length + ' evidence links')));
            card.append(el('div', { class: 'stopgate' }, 'T/N/M are not part of the diagnosis. Signing makes this record immutable; corrections create a superseding version.'));
            card.append(el('button', {
              class: 'btn', onclick: async () => {
                try {
                  await api('/diagnoses/' + dx.uuid + '/sign', { method: 'POST', body: {} });
                  toast('Diagnosis signed & immutable — staging task generated');
                  await done();
                } catch (e) { toast(e.error, true); }
              }
            }, 'Confirm & sign diagnosis'),
            el('button', { class: 'btn secondary', style: 'margin-left:8px', onclick: () => { state.view.task.destination = 'diagnosis'; render(); } }, 'Back to edit'));
          } catch (e) { toast(e.error, true); }
        }
      }, 'Review & sign…')));
  } else {
    const dx = chart.diagnosis;
    card.append(el('div', { class: 'prov' }, '✓ Diagnosis signed ' + fmtDate(dx.signedAt) + ' — v' + (dx.version || 1) + ' ' + dx.cancerTypeLabel + ' (' + dx.histologyLabel + '). Immutable.'));
    // D6: sanctioned superseding-revision path
    const revBtn = el('button', { class: 'btn secondary', onclick: () => { revBox.style.display = revBox.style.display === 'none' ? '' : 'none'; } }, 'Revise diagnosis (creates superseding version)');
    const revBox = el('div', { style: 'display:none' });
    (async () => {
      const ct2 = await masterSelect('cancerType'); ct2.value = dx.cancerType;
      const ps2 = await masterSelect('primarySite'); ps2.value = dx.primarySite;
      const hist2 = await masterSelect('histology'); hist2.value = dx.histology;
      const gr2 = await masterSelect('grade'); gr2.value = dx.grade || '';
      const basis2 = el('select', {}, ...['CLINICAL', 'IMAGING', 'PATHOLOGY', 'MOLECULAR'].map(v => el('option', { value: v, selected: v === dx.diagnosisBasis }, v)));
      const reason = el('input', { placeholder: 'Reason for revision * (e.g. pathology revision post-op)' });
      revBox.append(el('h3', {}, 'New diagnosis version (v' + ((dx.version || 1) + 1) + ')'),
        el('div', { class: 'grid3' }, wrap('Cancer type', ct2), wrap('Primary site', ps2), wrap('Histology', hist2)),
        el('div', { class: 'grid3' }, wrap('Grade', gr2), wrap('Diagnosis basis', basis2), wrap('Revision reason *', reason)));
      revBox.append(el('button', {
        class: 'btn', onclick: async () => {
          try {
            if (!reason.value.trim()) { toast('Revision reason is required for the audit trail', true); return; }
            const ndx = await api('/diagnoses/' + dx.uuid + '/revise', { method: 'POST', body: {
              cancerType: ct2.value, primarySite: ps2.value, histology: hist2.value, grade: gr2.value || undefined,
              diagnosisBasis: basis2.value, revisionReason: reason.value.trim()
            }});
            toast('Diagnosis v' + ndx.data.version + ' created (supersedes v' + (dx.version || 1) + ') — sign to activate');
            await api('/diagnoses/' + ndx.uuid + '/sign', { method: 'POST', body: {} });
            toast('Revision signed — previous version preserved as SUPERSEDED');
            await done();
          } catch (e) { toast(e.error, true); }
        }
      }, 'Create & sign revision'));
    })();
    card.append(revBtn, revBox, el('button', { class: 'btn', style: 'margin-left:8px', onclick: done }, 'Acknowledge & complete task'));
  }
}

// §31 Flag discrepancy: record WHY the clinician disagrees with a signed (engine-derived)
// result and WHAT correction is requested. The signed record itself is immutable; the
// flag routes a review task to the oncologist, and the corrected facts re-derive the
// result through a superseding signed assessment.
function flagStagingDiscrepancyModal(s) {
  const modal = el('div', { class: 'card', style: 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:560px;max-height:80vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
  const reason = el('input', { placeholder: 'e.g. node status derived as N0, but palpable nodes were documented in the exam' });
  const correction = el('input', { placeholder: 'e.g. re-check nodal finding; re-derive N from the exam record' });
  modal.append(el('h3', {}, 'FLAG STAGING DISCREPANCY — result: ' + el2s(s.stageResult)),
    el('div', { class: 'prov' }, 'The signed result is immutable and cannot be edited. The flag records your disagreement, routes a review task to the oncologist, and the corrected facts re-derive the result in a superseding assessment.'),
    wrap('Discrepancy reason *', reason),
    wrap('Requested correction *', correction),
    el('div', { style: 'display:flex;gap:8px;margin-top:8px' },
      el('button', { class: 'btn', onclick: async () => {
        try {
          await api('/staging-assessments/' + s.uuid + '/flag', { method: 'POST', body: { reason: reason.value, requestedCorrection: correction.value } });
          toast('Discrepancy flagged — review task routed to the oncologist');
          modal.remove(); render();
        } catch (e) { toast(e.error || e.message, true); }
      } }, 'Record flag'),
      el('button', { class: 'btn secondary', onclick: () => modal.remove() }, 'Cancel')));
  document.body.append(modal);
}

async function formStaging(card, task, chart, done) {
  if (!chart.diagnosis) {
    card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: staging requires a confirmed (signed) diagnosis. This assessment cannot be created.'));
    return;
  }
  const dx = chart.diagnosis;
  let schema;
  try { schema = await api('/staging/schema/' + dx.uuid); }
  catch (e) { card.append(el('div', { class: 'stopgate' }, e.error)); return; }

  // §21 read-only header: authority / schema / version are RESOLVED BY THE SERVER
  // from the diagnosis — the clinician never picks a pack. contentStatus is shown
  // honestly (AUTHORITY_CONTENT_UNAVAILABLE without licensed content).
  card.append(el('div', { class: 'card' },
    el('h3', {}, 'Staging authority (resolved from diagnosis — read only)'),
    el('div', { class: 'kv' },
      el('div', { class: 'k' }, 'Diagnosis'), el('div', {}, dx.cancerTypeLabel + ' · ' + (dx.histologyLabel || dx.histology) + ' · ' + fmtDate(dx.diagnosisDate)),
      el('div', { class: 'k' }, 'Primary site'), el('div', {}, dx.primarySiteLabel || dx.primarySite || '—'),
      el('div', { class: 'k' }, 'Staging authority'), el('div', {}, schema.authority),
      el('div', { class: 'k' }, 'Schema'), el('div', {}, schema.schemaName || schema.schemaId || schema.providerKey),
      el('div', { class: 'k' }, 'Applicable version'), el('div', {}, schema.version + (schema.effectiveFrom ? ' (effective ' + fmtDate(schema.effectiveFrom) + ')' : '')),
      el('div', { class: 'k' }, 'Content status'), el('div', {}, schema.contentStatus || 'UNKNOWN'))));
  if (schema.notice) card.append(el('div', { class: 'stopgate' }, schema.notice + ' Version routing continues from public AJCC metadata (' + (schema.sourceReference || '') + ').'));
  // §2/§30 classification selector — mandatory enum; AUTOPSY is in the model but
  // not offered in the routine active-treatment UI (§10). Non-TNM schemas (ISS,
  // FIGO, Lugano…) get the alternative-classification option instead of TNM ones.
  const isNonTnmSchema = !['t', 'n', 'm'].every(k => schema.fields.some(f => f.key === k));
  const CLS_OPTS = isNonTnmSchema
    ? [{ code: 'NON_TNM', label: 'Disease classification (non-TNM — provider resolved)' }]
    : [
        { code: 'CLINICAL', prefix: 'c', label: 'Clinical (cTNM)' },
        { code: 'PATHOLOGICAL', prefix: 'p', label: 'Pathological (pTNM)' },
        { code: 'POSTTHERAPY_CLINICAL', prefix: 'yc', label: 'Posttherapy clinical (ycTNM)' },
        { code: 'POSTTHERAPY_PATHOLOGICAL', prefix: 'yp', label: 'Posttherapy pathological (ypTNM)' },
        { code: 'RECURRENCE_RETREATMENT', prefix: 'r', label: 'Recurrence / retreatment (rTNM)' }
      ];
  const ctxSel = el('select', {}, ...CLS_OPTS.filter(c => schema.contexts.includes(c.code)).map(c => el('option', { value: c.code }, c.label)));
  const aDate = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  // Slice E: a PATHOLOGICAL_STAGING task pins the classification (p or yp) derived from
  // the real treatment history. Prior signed assessments are shown read-only — they are
  // NEVER overwritten; this opens a separate assessment. pT/pN/pM are never pre-filled:
  // the clinician enters them from the final histopathology evidence.
  const restageCls = task && task.payload && ['PATHOLOGICAL', 'POSTTHERAPY_PATHOLOGICAL'].includes(task.payload.classification) ? task.payload.classification : null;
  if (restageCls) {
    if ([...ctxSel.options].some(o => o.value === restageCls)) ctxSel.value = restageCls;
    const prior = (chart.staging.history || []).filter(s => s.status === 'SIGNED');
    const prefix = restageCls === 'POSTTHERAPY_PATHOLOGICAL' ? 'yp' : 'p';
    card.append(el('div', { class: 'stopgate' },
      'PATHOLOGICAL RESTAGING (' + prefix + 'TNM) — ' + (task.payload.reason || 'final histopathology available') +
      '. Enter ' + prefix + 'T/' + prefix + 'N/' + prefix + 'M from the final histopathology and linked evidence. ' +
      (prior.length ? 'Prior signed assessment(s) preserved: ' + prior.map(s => s.stagingContext + ' ' + (s.stageResult || '')).join(' · ') + '. ' : '') +
      'pT/pN/pM are NOT pre-filled and the prior clinical stage is NOT changed.'));
  }
  // §31 discrepancy loop: the flag's review task opens the form PRE-FILLED from the
  // flagged assessment — the clinician corrects the underlying facts, the engine
  // re-derives, and the new signature supersedes (and resolves the flag).
  const flagged = task && task.payload && task.payload.stagingAssessmentUuid
    ? (chart.staging.history || []).find(s => s.uuid === task.payload.stagingAssessmentUuid && s.status === 'SIGNED') : null;
  if (flagged) {
    if ([...ctxSel.options].some(o => o.value === flagged.stagingContext)) ctxSel.value = flagged.stagingContext;
    aDate.value = flagged.assessmentDate || aDate.value;
    card.append(el('div', { class: 'stopgate' },
      'STAGING DISCREPANCY REVIEW — flagged result: ' + el2s(flagged.stageResult) + '. ' +
      'The signed record is immutable; correct the underlying facts below. The engine re-derives, and signing supersedes ' +
      flagged.stageResult + ' and resolves the flag.'));
  }
  card.append(el('div', { class: 'grid2' }, wrap('Staging classification *', ctxSel), wrap('Assessment date *', aDate)));

  const varsBox = el('div', { class: 'grid3' });
  const inputs = {};
  const evidence = [];   // declared before the auto-result panel, which counts linked rows live
  // §24/§25 evidence auto-suggestion: focusing a staging fact surfaces candidate
  // patient records from the relevant staging window (assessment date − 6 months),
  // filtered to the fact's source kinds. One click confirms the link — the system
  // NEVER attaches evidence silently. Focus is attached per node inside renderVars
  // so rebuilt fields keep the hook.
  const suggBox = el('div', { id: 'evidenceSuggestions' });
  let suggTimer = null;
  const showSuggestions = async (factKey) => {
    if (!factKey) { suggBox.innerHTML = ''; return; }
    suggBox.innerHTML = '';
    suggBox.append(el('div', { class: 'muted' }, 'Searching the staging window for this fact…'));
    try {
      const s = await api('/staging/suggestions/' + chart.patient.uuid + '?fact=' + encodeURIComponent(factKey) + '&assessmentDate=' + encodeURIComponent(aDate.value || ''));
      suggBox.innerHTML = '';
      if (!s.suggestions.length) {
        suggBox.append(el('div', { class: 'muted' }, 'No candidate records in the staging window (' + s.window.start + ' → ' + s.window.end + ') for this fact.'));
        return;
      }
      suggBox.append(el('div', { class: 'prov' }, 'Candidates in the staging window (' + s.window.start + ' → ' + s.window.end + ') — click to confirm as evidence for this fact:'));
      for (const it of s.suggestions.slice(0, 6)) {
        suggBox.append(el('button', {
          class: 'btn small secondary', style: 'margin:2px 4px 2px 0', onclick: () => {
            evidence.push({ variableKey: factKey, sourceType: it.evidenceType === 'CLINICAL_EXAM' ? 'CLINICAL' : it.evidenceType, sourceRef: it.sourceResourceId, sourceDate: (it.sourceDate || '').slice(0, 10), supportingFinding: it.relevantFinding || '', evidenceRole: 'PRIMARY' });
            evBox.append(renderEvRow({ ...it, variableKey: factKey }));
            suggBox.innerHTML = '';
            toast('Evidence linked: ' + factKey + ' ← ' + (it.relevantFinding || it.evidenceType));
          }
        }, '[' + it.group + '] ' + fmtDate(it.sourceDate) + ' · ' + (it.relevantFinding || it.evidenceType).slice(0, 60) + (it.reportedBy ? ' · ' + it.reportedBy : '')));
      }
    } catch (e) { suggBox.innerHTML = ''; suggBox.append(el('div', { class: 'muted' }, 'Suggestions unavailable: ' + (e.error || e.message))); }
  };
  const attachSuggestionFocus = (node) => node.addEventListener('focus', () => {
    clearTimeout(suggTimer);
    suggTimer = setTimeout(() => showSuggestions(node.getAttribute('data-field')), 150);
  });
  const autoBox = el('div', { class: 'card', id: 'autoResult' });
  let lastDerivation = null;
  let recalcTimer = null;
  // AUTOMATIC RESULT (§29/§52): the engine on the SERVER derives categories and the
  // final classification/stage from the objective facts. This panel is a live preview;
  // the authoritative derivation runs again behind the sign gate. The clinician never
  // hand-picks the result where a content pack is connected.
  async function recalcAuto() {
    const variables = {};
    for (const [k, node] of Object.entries(inputs)) {
      if (!node) continue;
      const v = node.multiple ? [...node.selectedOptions].map(o => o.value).filter(Boolean) : node.value;
      if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) continue;
      variables[k] = node.tagName === 'SELECT' && !node.multiple && ['true', 'false'].includes(v) ? v === 'true' : v;
    }
    try {
      lastDerivation = await api('/staging/evaluate', { method: 'POST', body: { diagnosisUuid: dx.uuid, classification: ctxSel.value, variables } });
    } catch (e) { lastDerivation = { status: 'INVALID_INPUT', invalid: [e.error || String(e)] }; }
    renderAuto(lastDerivation);
  }
  function renderAuto(d) {
    autoBox.innerHTML = '';
    autoBox.append(el('h3', {}, 'AUTOMATIC RESULT'));
    const linked = evidence.filter(e => e.sourceRef).length;
    if (d.status === 'CALCULATED') {
      autoBox.append(el('div', { class: 'kv' },
        el('div', { class: 'k' }, 'Classification result'), el('div', {}, d.resultLabel + ' — derived by engine (server-authoritative)'),
        el('div', { class: 'k' }, 'Authority / version'), el('div', {}, schema.authority + ' · ' + schema.version),
        el('div', { class: 'k' }, 'Content pack'), el('div', {}, d.packId + (d.version ? ' — ' + d.version : '')),
        el('div', { class: 'k' }, 'Prognostic stage'), el('div', {}, d.prognosticLabel || (d.prognosticStage || null) || '—'),
        el('div', { class: 'k' }, 'Evidence status'), el('div', {}, evidence.length ? (linked + ' linked / ' + evidence.length + ' rows') : 'no evidence rows yet')));
      if (d.warnings && d.warnings.length) for (const w of d.warnings) autoBox.append(el('div', { class: 'stopgate' }, w));
      const det = el('details', {}, el('summary', {}, 'View derivation'));
      const trace = el('div', { class: 'prov' }, 'Rules applied (pack ' + d.packId + '):');
      for (const r of d.rulesApplied || []) trace.append(el('div', {}, '• ' + r.category + ' → ' + r.output + ' — ' + r.explain + ' [' + r.source + ']'));
      det.append(trace);
      autoBox.append(det);
    } else if (d.status === 'NEEDS_INFORMATION') {
      autoBox.append(el('div', { class: 'stopgate' }, 'STAGE CANNOT YET BE DETERMINED — missing information:'));
      for (const m of d.missing) autoBox.append(el('div', { class: 'prov' }, '• ' + m));
    } else if (d.status === 'INVALID_INPUT') {
      autoBox.append(el('div', { class: 'stopgate' }, 'INVALID INPUT:'));
      for (const m of d.invalid || []) autoBox.append(el('div', { class: 'prov' }, '• ' + m));
    } else if (d.status === 'AMBIGUOUS') {
      autoBox.append(el('div', { class: 'stopgate' }, 'AMBIGUOUS — ' + (d.message || 'unable to derive a unique result')));
    } else {
      autoBox.append(el('div', { class: 'stopgate' }, 'CONTENT_PROVIDER_UNAVAILABLE — no automatic-derivation pack is connected for this disease. Governed clinician-recorded categories remain available below; automatic calculation requires licensed authority content.'));
    }
  }
  const scheduleRecalc = () => { clearTimeout(recalcTimer); recalcTimer = setTimeout(recalcAuto, 250); };
  const values = {};
  // Progressive disclosure (§10): conditional fields render only when their
  // condition holds against the current facts. Display-only mirror of the server's
  // evaluator — the server re-validates everything authoritatively.
  const vis = (cond, facts) => {
    if (!cond) return true;
    switch (cond.op) {
      case 'EQ': return facts[cond.key] === cond.value;
      case 'NE': return facts[cond.key] !== cond.value;
      case 'AND': return cond.of.every(c => vis(c, facts));
      case 'OR': return cond.of.some(c => vis(c, facts));
      default: return true;
    }
  };
  let discrepancyPrefilled = false;
  const renderVars = async () => {
    for (const [k, node] of Object.entries(inputs)) {
      if (!node) continue;
      values[k] = node.multiple ? [...node.selectedOptions].map(o => o.value).filter(Boolean) : node.value;
    }
    // §31 discrepancy review (first render only): seed the form with the flagged
    // assessment's FACTS (never its derived result) so the clinician corrects a
    // fact and the engine re-derives — result fields stay engine-owned.
    if (flagged && !discrepancyPrefilled) {
      discrepancyPrefilled = true;
      const derivedKeys = (schema.engine && schema.engine.resultFields) || ['stageResult'];
      for (const [k, v] of Object.entries(flagged.variables || {})) {
        if (!derivedKeys.includes(k)) values[k] = v;
      }
    }
    varsBox.innerHTML = '';
    const engineAvailable = schema.engine && schema.engine.status === 'AVAILABLE';
    // §17 context-aware: governed T/N/M/result picks are replaced by derivation ONLY for
    // classifications the connected pack covers; other contexts keep the fallback.
    const engineForContext = engineAvailable && (!schema.engine.classifications || schema.engine.classifications.includes(ctxSel.value));
    const prefix = { PATHOLOGICAL: 'p', POSTTHERAPY_CLINICAL: 'yc', POSTTHERAPY_PATHOLOGICAL: 'yp', RECURRENCE_RETREATMENT: 'r', AUTOPSY: 'a' }[ctxSel.value] || 'c';
    const facts = {};
    const hiddenResultFields = engineForContext && schema.engine.resultFields ? schema.engine.resultFields : (engineForContext ? ['stageResult'] : []);
    for (const hk of hiddenResultFields) delete values[hk];   // engine derives these — never hand-picked (§31)
    for (const [k, v] of Object.entries(values)) if (v !== '' && v !== undefined && !(Array.isArray(v) && !v.length)) facts[k] = ['true', 'false'].includes(v) ? v === 'true' : v;
    for (const f of schema.fields) {
      // With a derivation pack connected the stage/classification result is engine-derived,
      // never hand-picked (§31) — the field is not rendered for manual entry.
      if (hiddenResultFields.includes(f.key)) continue;
      if (f.visibleWhen && !vis(f.visibleWhen, facts)) continue;
      let node;
      if (f.type === 'coded' && f.options) {
        node = el('select', { 'data-field': f.key });
        node.append(el('option', { value: '' }, '—'));
        for (const o of f.options) node.append(el('option', { value: o.code }, (f.prefix ? prefix + '-' : '') + o.label));
      } else if (f.type === 'select') {
        node = el('select', {}, el('option', { value: '' }, '—'), ...f.options.map(o => el('option', { value: o }, o)));
      } else if (f.type === 'boolean') {
        node = el('select', {}, el('option', { value: '' }, '—'), el('option', { value: 'true' }, 'Yes'), el('option', { value: 'false' }, 'No'));
      } else if (f.type === 'multiselect') {
        node = el('select', { multiple: true, size: Math.min(4, (f.options || []).length || 3) }, ...(f.options || []).map(o => el('option', { value: o.code }, o.label)));
      } else {
        node = el('input', { type: f.type === 'number' ? 'number' : 'text' });
      }
      node.setAttribute('data-field', f.key);   // stable automation/provenance hook on every control
      if (values[f.key] !== undefined) node.value = values[f.key];
      if (node.multiple && Array.isArray(values[f.key])) [...node.options].forEach(o => { o.selected = values[f.key].includes(o.value); });
      // Live recalculation (§14): 'input' fires per keystroke/fill (debounced).
      // Rebuild-on-change is attached ONLY to visibility-driving controls (selects,
      // booleans): number/text changes never alter the visible field set, so their
      // change (e.g. the blur fired when the next field is focused) must NOT rebuild
      // the DOM — a rebuild there replaces nodes mid-fill and drops the entered value.
      const drivesVisibility = ['select', 'boolean', 'coded', 'multiselect'].includes(f.type);
      node.addEventListener('input', scheduleRecalc);
      if (drivesVisibility) {
        node.addEventListener('change', async () => { await renderVars(); scheduleRecalc(); });
      } else {
        node.addEventListener('change', scheduleRecalc);
      }
      inputs[f.key] = node;
      attachSuggestionFocus(node);
      if (hiddenResultFields.length) for (const hk of hiddenResultFields) delete inputs[hk];
      varsBox.append(wrap(f.label + (f.required ? ' *' : '') + (f.unit ? ' (' + f.unit + ')' : '') + (f.help ? ' — ' + f.help : ''), node));
    }
  };
  await renderVars();
  ctxSel.addEventListener('change', async () => { await renderVars(); scheduleRecalc(); });
  card.append(varsBox);
  card.append(autoBox);
  recalcAuto();

  // §20/§31 evidence per fact: grouped picker over existing signed records — the
  // doctor selects, never retypes source names. View Source before linking.
  const pickerItems = await api('/staging/evidence-picker/' + chart.patient.uuid);
  const results = await api('/results?patientUuid=' + chart.patient.uuid);
  card.append(el('h3', {}, 'Staging evidence (provenance per fact — required for T/N/M)'));
  card.append(suggBox);
  // §24/§26 evidence per fact: any non-result field can cite its source — objective
  // inputs (size, β2M, node counts) and governed categories alike. Engine-derived
  // result fields are excluded for classifications the connected pack covers: the
  // trace, not evidence, justifies those.
  const engineForCtx = schema.engine && schema.engine.status === 'AVAILABLE' &&
    (!schema.engine.classifications || schema.engine.classifications.includes(ctxSel.value));
  const evVarFields = schema.fields.filter(f => {
    if (!(schema.engine && schema.engine.resultFields || ['stageResult']).includes(f.key)) return true;
    return !engineForCtx;
  });
  const evVar = el('select', {}, el('option', { value: '' }, '— fact this evidence supports —'), ...evVarFields.map(f => el('option', { value: f.key }, f.label)));
  const evRole = el('select', {}, ...['PRIMARY', 'SUPPORTING', 'CONTRADICTORY'].map(v => el('option', { value: v }, v.toLowerCase())));
  const evFinding = el('input', { placeholder: 'Supporting finding (e.g. 3.2cm spiculated mass, left upper lobe)' });
  const evBox = el('div', {});
  const renderEvRow = (item) => {
    const row = el('div', { class: 'prov' },
      item.variableKey + ' ← ' + item.evidenceType + (item.relevantFinding ? ' — ' + item.relevantFinding : '') +
      ' · ' + fmtDate(item.sourceDate) + (item.reportedBy ? ' · ' + item.reportedBy : '') + ' ',
      el('span', { class: 'badge SIGNED' }, (item.evidenceRole || 'primary')));
    const srcRec = results.find(r => r.uuid === item.sourceResourceId);
    if (srcRec) {
      row.append(el('button', { class: 'btn small secondary', style: 'margin-left:6px', onclick: () => {
        const modal = el('div', { class: 'card', style: 'position: fixed;top:60px;left:50%;transform:translateX(-50%);width:560px;max-height:70vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
        modal.append(el('h3', {}, 'SOURCE — ' + srcRec.category + ': ' + srcRec.test),
          el('div', { class: 'prov' }, 'Status: ' + srcRec.status + ' · finalized ' + fmtDate(srcRec.finalizedAt) + ' by ' + srcRec.byName));
        modal.append(el('pre', { style: 'white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:8px;border-radius:6px' }, (srcRec.summary || '')));
        modal.append(el('button', { class: 'btn small', onclick: () => modal.remove() }, 'Close source'));
        document.body.append(modal);
      } }, 'View Source'));
    }
    row.append(el('button', { class: 'btn small secondary', style: 'margin-left:4px', onclick: () => { row.remove(); evidence.splice(evidence.indexOf(item), 1); } }, 'remove'));
    return row;
  };
  // grouped picker by department (§31)
  const GROUPS = ['Pathology', 'Radiology', 'Laboratory', 'Molecular results', 'Operative reports', 'Consultations', 'External documents'];
  const pickGroup = el('select', {}, ...GROUPS.map(g => el('option', { value: g }, g)));
  const pickItem = el('select', {}, el('option', { value: '' }, '— select evidence —'));
  const fillPicker = () => {
    pickItem.innerHTML = '';
    pickItem.append(el('option', { value: '' }, '— select evidence —'));
    for (const it of pickerItems.filter(i => i.group === pickGroup.value)) {
      pickItem.append(el('option', { value: it.evidenceId }, fmtDate(it.sourceDate) + ' · ' + (it.reportedBy || '—') + ' · ' + (it.relevantFinding || it.evidenceType)));
    }
  };
  fillPicker();
  pickGroup.addEventListener('change', fillPicker);
  const viewBeforeLink = el('button', { class: 'btn small secondary', onclick: () => {
    const it = pickerItems.find(i => i.evidenceId === pickItem.value);
    if (!it) return;
    const srcRec = results.find(r => r.uuid === it.sourceResourceId);
    const modal = el('div', { class: 'card', style: 'position: fixed;top:60px;left:50%;transform:translateX(-50%);width:560px;max-height:70vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
    modal.append(el('h3', {}, 'SOURCE — ' + it.evidenceType), el('div', { class: 'prov' }, fmtDate(it.sourceDate) + ' · ' + (it.reportedBy || '—') + ' · status ' + it.status));
    modal.append(el('pre', { style: 'white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:8px;border-radius:6px' }, (srcRec ? srcRec.summary : it.relevantFinding) || ''));
    modal.append(el('button', { class: 'btn small', onclick: () => modal.remove() }, 'Close source'));
    document.body.append(modal);
  } }, 'View Source before linking');
  card.append(el('div', { class: 'grid3' }, wrap('Staging fact', evVar), wrap('Evidence group', pickGroup), wrap('Evidence record', pickItem)),
    el('div', { class: 'grid3' }, wrap('Evidence role', evRole), wrap('Supporting finding', evFinding), el('div', { style: 'display:flex;align-items:flex-end;gap:6px' }, viewBeforeLink)));
  card.append(el('button', {
    class: 'btn small secondary', onclick: () => {
      if (!evVar.value) return toast('Staging fact required for evidence row', true);
      const it = pickerItems.find(i => i.evidenceId === pickItem.value);
      if (!it) return toast('Select an evidence record from the picker', true);
      const item = { variableKey: evVar.value, sourceType: it.evidenceType === 'CLINICAL_EXAM' ? 'CLINICAL' : it.evidenceType, sourceRef: it.sourceResourceId, sourceDate: (it.sourceDate || '').slice(0, 10), supportingFinding: evFinding.value || it.relevantFinding, evidenceRole: evRole.value };
      evidence.push(item);
      evBox.append(renderEvRow({ ...item, evidenceType: it.evidenceType, reportedBy: it.reportedBy }));
      evFinding.value = '';
    }
  }, '+ link evidence to fact'));
  card.append(evBox);

  const supSel = el('select', {}, el('option', { value: '' }, '— new initial staging —'),
    ...chart.staging.history.filter(s => s.status === 'SIGNED').map(s => el('option', { value: s.uuid }, 'supersedes: ' + s.stagingContext + ' ' + s.stageResult + ' (' + fmtDate(s.assessmentDate) + ')')));
  // §31: a discrepancy review supersedes the flagged assessment by default — the
  // clinician can still change it, but the corrective default is the flagged record.
  if (flagged) supSel.value = flagged.uuid;
  card.append(wrap('Supersedes (restaging / post-treatment)', supSel));

  card.append(el('button', {
    class: 'btn mt8', onclick: async () => {
      try {
        const variables = {};
        for (const [k, node] of Object.entries(inputs)) {
          if (!node) continue;
          const v = node.multiple ? [...node.selectedOptions].map(o => o.value).filter(Boolean) : node.value;
          if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) continue;
          variables[k] = node.tagName === 'SELECT' && !node.multiple && ['true', 'false'].includes(v) ? v === 'true' : v;
        }
        // resultSource tells the sign gate whether the engine derived this result
        // (AUTOMATIC_ENGINE → gate re-derives server-side and requires a match) or
        // governed clinician-recorded categories were used (fallback path).
        const a = await api('/staging-assessments', { method: 'POST', body: {
          diagnosisUuid: dx.uuid, stagingContext: ctxSel.value, assessmentDate: aDate.value,
          variables, evidence, supersedes: supSel.value || null,
          resultSource: lastDerivation && lastDerivation.status === 'CALCULATED' ? 'AUTOMATIC_ENGINE' : 'CLINICIAN_ENTERED'
        }});
        // §32 STAGING SUMMARY — clinician reviews the assembled assessment before signing
        // §55 second-disease rule: non-TNM schemas (ISS, FIGO, Lugano…) must never render
        // TNM framing — the summary shows the classification and the disease-specific
        // variables only, with no T/N/M rows and no (prefix+TNM) label.
        const prefix = { PATHOLOGICAL: 'p', POSTTHERAPY_CLINICAL: 'yc', POSTTHERAPY_PATHOLOGICAL: 'yp', RECURRENCE_RETREATMENT: 'r', AUTOPSY: 'a' }[ctxSel.value] || 'c';
        const ctxDisplay = { CLINICAL: 'Clinical', PATHOLOGICAL: 'Pathological', POSTTHERAPY_CLINICAL: 'Posttherapy clinical', POSTTHERAPY_PATHOLOGICAL: 'Posttherapy pathological', RECURRENCE_RETREATMENT: 'Recurrence/retreatment', AUTOPSY: 'Autopsy', NON_TNM: 'Non-TNM' }[ctxSel.value] || ctxSel.value;
        const isNonTnm = ctxSel.value === 'NON_TNM';
        const classificationText = isNonTnm ? 'Disease classification (non-TNM — provider resolved)' : ctxDisplay + ' (' + prefix + 'TNM)';
        const summaryCard = card;
        summaryCard.innerHTML = '';
        summaryCard.append(el('h2', {}, 'STAGING SUMMARY'));
        const summaryRows = [
          el('div', { class: 'k' }, 'Classification'), el('div', {}, classificationText)
        ];
        if (!isNonTnm) {
          summaryRows.push(
            el('div', { class: 'k' }, 'T'), el('div', {}, variables.t ? prefix + variables.t : '—'),
            el('div', { class: 'k' }, 'N'), el('div', {}, variables.n ? prefix + variables.n : '—'),
            el('div', { class: 'k' }, 'M'), el('div', {}, variables.m ? prefix + variables.m : (['PATHOLOGICAL', 'POSTTHERAPY_PATHOLOGICAL'].includes(ctxSel.value) ? 'not assessed pathologically (M remains clinical)' : '—')),
            el('div', { class: 'k' }, 'Prognostic factors'), el('div', {}, Object.keys(variables).filter(k => !['t', 'n', 'm', 'stageResult'].includes(k)).map(k => k + ': ' + variables[k]).join(', ') || '—'));
        } else {
          summaryRows.push(
            el('div', { class: 'k' }, 'Classification variables'), el('div', {}, Object.keys(variables).filter(k => !['stageResult'].includes(k)).map(k => k + ': ' + variables[k]).join(', ') || '—'));
        }
        summaryCard.append(el('div', { class: 'kv' }, ...summaryRows,
          el('div', { class: 'k' }, 'Stage / classification result'), el('div', {},
            lastDerivation && lastDerivation.status === 'CALCULATED'
              ? lastDerivation.resultLabel + ' — engine-derived (verify, then sign)'
              : (variables.stageResult || 'derived by provider at sign')),
          ...((lastDerivation && lastDerivation.status !== 'CALCULATED' && engineForContext)
            ? [el('div', { class: 'k' }, 'Engine status'), el('div', {}, lastDerivation.status + ' — signing requires the engine to calculate')]
            : []),
          el('div', { class: 'k' }, 'Evidence completeness'), el('div', {}, evidence.filter(e => e.sourceRef).length + ' linked / ' + evidence.length + ' rows'),
          el('div', { class: 'k' }, 'Authority'), el('div', {}, schema.authority + ' · ' + schema.version)));
        for (const ev of evidence) {
          summaryCard.append(el('div', { class: 'prov' }, ev.variableKey + ' ← ' + ev.sourceType + (ev.supportingFinding ? ' — ' + ev.supportingFinding : '')));
        }
        summaryCard.append(el('div', { class: 'stopgate' }, 'Signing is immutable. The provider derives the stage; a suspected discrepancy is flagged, never silently altered.'));
        summaryCard.append(el('button', { class: 'btn', onclick: async () => {
          try {
            await api('/staging-assessments/' + (a.data ? a.data.uuid : a.uuid) + '/sign', { method: 'POST', body: {} });
            toast('Staging signed (' + schema.authority + ' ' + schema.version + ') — MDT/care-plan task generated');
            await done();
          } catch (e) { toast(e.error, true); }
        } }, 'Confirm & sign'),
        el('button', { class: 'btn secondary', style: 'margin-left:8px', onclick: () => { state.view = { name: 'worklist' }; render(); } }, 'Save draft (sign later from worklist)'));
      } catch (e) { toast(e.error, true); }
    }
  }, 'Review staging summary…'));
}

async function formMdt(card, task, chart, done) {
  const isChair = state.user.role === 'MDT Chair';
  let mdt = null;
  if (task.payload && task.payload.mdtUuid && (chart.mdt || []).length) {
    mdt = (chart.mdt || []).find(m => m.uuid === task.payload.mdtUuid) || null;
  }
  if (!mdt) {
    const mine = (chart.mdt || []).filter(m => m.status !== 'SIGNED');
    if (mine.length) mdt = mine[0];
  }
  if (isChair) {
    // Chair view: read the coordinator's recorded discussion, sign the outcome
    if (!mdt) { card.append(el('div', { class: 'stopgate' }, 'No MDT case awaiting chair sign-off.')); return; }
    // D-MDT-6: if the record arrived without the required outcome fields, the chair
    // completes them here (backend audited) instead of being hard-blocked.
    const chairComplete = !mdt.decision || !mdt.responsibleClinician;
    const decisionInput = el('input', { placeholder: 'Decision *', value: mdt.decision || '' });
    const responsibleInput = el('input', { placeholder: 'Responsible clinician *', value: mdt.responsibleClinician || '' });
    card.append(el('div', { class: 'prov' }, 'Case opened ' + fmtDate(mdt.openedAt) + ' — ' + mdt.referralReason));
    card.append(el('div', { class: 'kv' },
      el('div', { class: 'k' }, 'Options'), el('div', {}, mdt.proposedOptions || '—'),
      el('div', { class: 'k' }, 'Discussion'), el('div', {}, mdt.discussion || '—'),
      el('div', { class: 'k' }, 'Consensus'), el('div', {}, mdt.consensus || '—'),
      el('div', { class: 'k' }, 'Dissent'), el('div', {}, mdt.dissent || '—')));
    if (chairComplete) card.append(el('div', { class: 'stopgate' }, 'The MDT record is incomplete (no decision / responsible clinician). Chair: complete the outcome below to sign.'));
    card.append(el('div', { class: 'grid2' },
      wrap('Decision *' + (chairComplete ? ' (missing from coordinator record)' : ''), decisionInput),
      wrap('Responsible clinician *' + (chairComplete ? ' (missing from coordinator record)' : ''), responsibleInput)));
    card.append(el('div', { class: 'stopgate' }, 'Diagnosis and staging snapshots are consumed from the signed records — no retyping.'));
    card.append(el('button', {
      class: 'btn', onclick: async () => {
        try {
          await api('/mdt-cases/' + mdt.uuid + '/sign', { method: 'POST', body: { decision: decisionInput.value, responsibleClinician: responsibleInput.value } });
          toast('MDT outcome signed by chair — care plan task generated');
          await done();
        } catch (e) { toast(e.error, true); }
      }
    }, 'Chair: sign MDT outcome'));
    return;
  }
  // Coordinator/MO view: open case + record discussion (no sign button — chair signs)
  const reason = el('input', { placeholder: 'Referral reason *', value: 'MDT discussion of treatment options' });
  const options = el('textarea', { placeholder: 'Proposed options (surgery / RT / systemic)' });
  const discussion = el('textarea', { placeholder: 'Discussion' });
  const consensus = el('textarea', { placeholder: 'Consensus' });
  const dissent = el('input', { placeholder: 'Dissent (if any)' });
  const decision = el('input', { placeholder: 'Decision *' });
  const responsible = el('input', { placeholder: 'Responsible clinician *' });
  card.append(el('div', { class: 'grid2' }, wrap('Reason *', reason), wrap('Responsible clinician *', responsible)));
  card.append(wrap('Proposed options', options), wrap('Discussion', discussion),
    wrap('Consensus', consensus), wrap('Dissent', dissent), wrap('Decision *', decision));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        let m = mdt;
        if (!m) {
          m = await api('/mdt-cases', { method: 'POST', body: {
            patientUuid: chart.patient.uuid, reason: reason.value,
            diagnosisUuid: chart.diagnosis ? chart.diagnosis.uuid : null,
            stagingUuid: chart.staging.current ? chart.staging.current.uuid : null
          }});
          m = m.data || m;
        }
        await api('/mdt-cases/' + m.uuid + '/discussion', { method: 'POST', body: { proposedOptions: options.value, discussion: discussion.value, consensus: consensus.value, dissent: dissent.value, decision: decision.value, responsibleClinician: responsible.value } });
        toast('MDT discussion recorded — MDT Chair now receives the sign-off task');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Record discussion → route to chair'));
}

async function formCarePlan(card, task, chart, done) {
  if (!chart.diagnosis || !chart.staging.current) {
    card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: care plan requires a signed diagnosis AND signed staging.'));
    return;
  }
  const intent = await masterSelect('treatmentIntent');
  const line = await masterSelect('lineOfTherapy');
  const modalities = ['CHEMOTHERAPY', 'RADIOTHERAPY', 'SURGERY', 'SUPPORTIVE'];
  const modChecks = modalities.map(m => {
    const cb = el('input', { type: 'checkbox' }); cb.dataset.mod = m;
    return el('div', { class: 'checkbox-row' }, cb, el('span', {}, m));
  });
  const systemic = el('input', { placeholder: 'Systemic therapy plan (regimen names, sequence)' });
  const rt = el('input', { placeholder: 'Radiotherapy plan' });
  const surg = el('input', { placeholder: 'Surgery plan' });
  const supportive = el('input', { placeholder: 'Supportive care' });
  const protocol = el('input', { placeholder: 'Institutional protocol reference' });
  const rationale = el('textarea', { placeholder: 'Rationale' });
  const start = el('input', { type: 'date' });
  const monitoring = el('input', { placeholder: 'Monitoring plan (labs, scans)' });
  const respPlan = el('input', { placeholder: 'Response assessment plan (imaging after N cycles)' });
  card.append(el('div', { class: 'grid3' }, wrap('Treatment intent *', intent), wrap('Line of therapy *', line), wrap('Expected start *', start)));
  card.append(el('h3', {}, 'Modality sequence'), ...modChecks);
  card.append(el('div', { class: 'grid2' }, wrap('Systemic therapy', systemic), wrap('Radiotherapy', rt)),
    el('div', { class: 'grid2' }, wrap('Surgery', surg), wrap('Supportive care', supportive)),
    wrap('Protocol', protocol), wrap('Rationale', rationale), wrap('Monitoring', monitoring), wrap('Response plan', respPlan));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const plan = await api('/care-plans', { method: 'POST', body: {
          patientUuid: chart.patient.uuid, diagnosisUuid: chart.diagnosis.uuid, stagingUuid: chart.staging.current.uuid,
          treatmentIntent: intent.value, lineOfTherapy: line.value, expectedStart: start.value,
          modalitySequence: modChecks.filter(x => x.querySelector('input').checked).map(x => ({ modality: x.querySelector('input').dataset.mod })),
          systemicTherapy: systemic.value, radiotherapy: rt.value, surgery: surg.value, supportiveCare: supportive.value,
          institutionalProtocol: protocol.value, rationale: rationale.value, monitoringPlan: monitoring.value, responseAssessmentPlan: respPlan.value
        }});
        await api('/care-plans/' + plan.uuid + '/sign', { method: 'POST', body: {} });
        toast('Care plan signed — financial counselling task generated');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign care plan'));
}

function formFinance(card, task, chart, done) {
  const plans = chart.carePlans.filter(p => p.status === 'SIGNED');
  if (!plans.length) { card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: financial counselling requires a signed care plan.')); return; }
  const planSel = el('select', {}, ...plans.map(p => el('option', { value: p.uuid }, 'Plan ' + p.uuid.slice(0, 8) + ' — ' + p.treatmentIntent)));
  const treatment = el('input', { placeholder: 'Planned treatment *' });
  const cost = el('input', { type: 'number', placeholder: 'Cost estimate *' });
  const payer = el('select', {}, el('option', { value: 'INSURER' }, 'Insurer'), el('option', { value: 'TPA' }, 'TPA'), el('option', { value: 'SELF_PAY' }, 'Self-pay'), el('option', { value: 'SCHEME' }, 'Scheme'));
  const insurer = el('input', { placeholder: 'Insurer / TPA name' });
  const authNo = el('input', { placeholder: 'Authorization number' });
  const selfPay = el('input', { type: 'number', placeholder: 'Self-pay component' });
  const choice = el('select', {}, el('option', { value: '' }, '—'), el('option', { value: 'ORIGINATOR' }, 'Originator'), el('option', { value: 'IMPORTED' }, 'Imported'), el('option', { value: 'BIOSIMILAR' }, 'Biosimilar'), el('option', { value: 'LOCAL' }, 'Local generic'));
  const note = el('textarea', { placeholder: 'Counselling notes' });
  const start = el('input', { type: 'date' });
  const clearance = el('select', {}, el('option', { value: 'CLEARED' }, 'Financial clearance: CLEARED'), el('option', { value: 'DECLINED' }, 'DECLINED'), el('option', { value: 'PENDING' }, 'PENDING'));
  card.append(wrap('Care plan', planSel), wrap('Planned treatment *', treatment), wrap('Cost estimate *', cost),
    el('div', { class: 'grid3' }, wrap('Payer *', payer), wrap('Insurer/TPA', insurer), wrap('Authorization #', authNo)),
    el('div', { class: 'grid3' }, wrap('Self-pay component', selfPay), wrap('Patient choice (drug option)', choice), wrap('Planned start', start)),
    wrap('Counselling notes', note), wrap('Clearance', clearance));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const fc = await api('/financial-counsellings', { method: 'POST', body: {
          carePlanUuid: planSel.value, plannedTreatment: treatment.value, costEstimate: cost.value,
          payerType: payer.value, insurerTpa: insurer.value, authorization: { number: authNo.value, status: authNo.value ? 'APPROVED' : 'PENDING' },
          selfPayComponent: selfPay.value, patientChoice: choice.value || 'ORIGINATOR', counsellingNote: note.value,
          plannedStartDate: start.value, financialClearance: clearance.value
        }});
        await api('/financial-counsellings/' + fc.uuid + '/sign', { method: 'POST', body: {} });
        toast('Financial counselling signed — readiness task generated (if cleared)');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign financial counselling'));
}

function formReadiness(card, task, chart, done) {
  const fcs = chart.finance.filter(f => f.financialClearance === 'CLEARED');
  if (!fcs.length) { card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: readiness requires financial clearance.')); return; }
  const fc = fcs[0];
  const checks = {};
  for (const c of ['labsCurrent', 'consentTaken', 'accessDevice', 'patientEducated']) {
    checks[c] = el('input', { type: 'checkbox' });
    card.append(el('div', { class: 'checkbox-row' }, checks[c], el('span', {}, c)));
  }
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        await api('/readiness', { method: 'POST', body: { fcUuid: fc.uuid, checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.checked])) } });
        toast('Readiness cleared — treatment ordering enabled');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Clear readiness'));
}

async function formTreatmentOrder(card, task, chart, done) {
  const plans = chart.carePlans.filter(p => p.status === 'SIGNED');
  const ready = chart.readiness.length > 0;
  if (!plans.length) { card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: treatment order requires a SIGNED care plan.')); return; }
  if (!ready) { card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: treatment readiness must be cleared (finance → readiness) before ordering.')); return; }
  const plan = plans[0];
  const regSel = el('select', {}, ...state.cache.regimens.map(r => el('option', { value: r.code }, r.name + ' (' + r.cycleLengthDays + '-day cycle, v' + r.version + ')')));
  const cycles = el('input', { type: 'number', value: 4, min: 1, max: 12 });
  const weight = el('input', { type: 'number', step: '0.1', placeholder: 'Weight (kg) *' });
  const height = el('input', { type: 'number', step: '0.1', placeholder: 'Height (cm) *' });
  const start = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const supportive = el('input', { placeholder: 'Supportive treatment (G-CSF etc.)' });
  const redPct = el('input', { type: 'number', placeholder: 'Reduction % (optional)' });
  const redWhy = el('input', { placeholder: 'Reduction reason (required if % set)' });
  card.append(el('div', { class: 'grid3' }, wrap('Regimen *', regSel), wrap('Planned cycles *', cycles), wrap('Start date *', start)),
    el('div', { class: 'grid3' }, wrap('Weight (kg) *', weight), wrap('Height (cm) *', height), wrap('Supportive', supportive)),
    el('div', { class: 'grid2' }, wrap('Dose reduction %', redPct), wrap('Reduction reason', redWhy)));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const order = await api('/treatment-orders', { method: 'POST', body: {
          patientUuid: chart.patient.uuid, carePlanUuid: plan.uuid,
          regimenCode: regSel.value, plannedCycles: Number(cycles.value),
          weight: Number(weight.value), height: Number(height.value), startDate: start.value,
          supportiveTreatment: supportive.value,
          reductions: redPct.value ? [{ medication: 'DOXORUBICIN', reductionPercent: redPct.value, reason: redWhy.value }] : []
        }});
        await api('/treatment-orders/' + order.uuid + '/sign', { method: 'POST', body: {} });
        toast('Treatment order signed — pharmacy task generated + calendar projected');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign treatment order'));
}

function formPharmacy(card, task, chart) {
  // pharmacist queue for this patient — status-aware so no task is a dead-end:
  // ORDERED→receive/verify/prepare · PREPARED→release+dispense · RELEASED→dispense only
  const rows = (chart.pharmacy || []).filter(r => task.code === 'DISPENSE' ? r.status !== 'REJECTED' : (r.status !== 'REJECTED' && r.status !== 'DISPENSED'));
  if (!rows.length) {
    // no pharmacy record yet: the signed treatment order is awaiting receipt
    const signed = (chart.treatmentOrders || []).find(o => o.status === 'SIGNED');
    if (!signed) { card.append(el('div', { class: 'muted' }, 'Nothing awaiting pharmacy for this patient.')); return; }
    rows.push({ orderUuid: signed.uuid, status: 'ORDERED', awaitingReceipt: true });
  }
  const rec = task.code === 'DISPENSE'
    ? (rows.find(r => r.status === 'RELEASED') || rows[0])
    : rows[0];
  const order = chart.treatmentOrders.find(o => o.uuid === rec.orderUuid);
  card.append(el('div', { class: 'prov' }, 'Order: ' + (order ? order.regimenName + ' — ' + order.cycleDays.length + ' planned administrations' : '')));
  const checks = {};
  for (const c of ['regimenVerified', 'doseVerified', 'allergyCheck', 'interactionCheck', 'compatibilityCheck', 'stabilityCheck', 'stockAllocated']) {
    checks[c] = el('input', { type: 'checkbox' });
    card.append(el('div', { class: 'checkbox-row' }, checks[c], el('span', {}, c)));
  }
  // DISPENSE task: standalone dispense panel (release already done)
  if (task.code === 'DISPENSE') {
    if (rec.status === 'DISPENSED') {
      card.append(el('div', { class: 'prov' }, '✓ Already dispensed (chain of custody recorded) — closing the dispense task.'));
      card.append(el('button', { class: 'btn', onclick: () => wfComplete(task) }, 'Close dispense task'));
      return;
    }
    if (rec.status !== 'RELEASED') { card.append(el('div', { class: 'muted' }, 'Preparation not yet RELEASED — release task must complete first.')); return; }
    const orderD = chart.treatmentOrders.find(o => o.uuid === rec.orderUuid);
    card.append(el('div', { class: 'prov' }, 'Released by: independent check ' + (rec.independentCheckBy || '—') + ' · Order: ' + (orderD ? orderD.regimenName : '')));
    const destD = el('select', {}, ...['DAY_CARE', 'INPATIENT', 'HOME_THERAPY'].map(v => el('option', { value: v }, v)));
    const custD = el('input', { placeholder: 'Checked out to (receiving person) *' });
    card.append(wrap('Destination *', destD), wrap('Checked out to *', custD));
    card.append(el('button', {
      class: 'btn', onclick: async () => {
        try {
          await api('/pharmacy/' + rec.uuid + '/dispense', { method: 'POST', body: { destination: destD.value, checkedOutTo: custD.value } });
          toast('Dispensed — chain of custody recorded; Day Care task generated');
          await wfComplete(task);
        } catch (e) { toast(e.error, true); }
      }
    }, 'Dispense to Day Care'));
    return;
  }
  const verifyBtn = el('button', {
    class: 'btn', onclick: async () => {
      try {
        if (rec.status === 'ORDERED') await api('/pharmacy/receive', { method: 'POST', body: { orderUuid: rec.orderUuid } });
        const all = await api('/pharmacy/queue');
        const mine = all.find(r => r.orderUuid === rec.orderUuid && r.status !== 'RELEASED');
        await api('/pharmacy/' + mine.uuid + '/verify', { method: 'POST', body: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.checked])) });
        await api('/pharmacy/' + mine.uuid + '/prepare', { method: 'POST', body: { compounded: false, notes: 'Standard preparation' } });
        const indep = el('input', { placeholder: 'Independent check by (2nd pharmacist) *' });
        card.append(wrap('Independent check *', indep));
        card.append(el('button', {
          class: 'btn', onclick: async () => {
            try {
              await api('/pharmacy/' + mine.uuid + '/release', { method: 'POST', body: { independentCheckBy: indep.value } });
              toast('Released — dispense step now required');
              // D3: dispense step (release ≠ dispense)
              card.innerHTML = '';
              card.append(el('div', { class: 'prov' }, 'Dispense the released preparation — chain of custody is recorded.'));
              const dest = el('select', {}, ...['DAY_CARE', 'INPATIENT', 'HOME_THERAPY'].map(v => el('option', { value: v }, v)));
              const custodian = el('input', { placeholder: 'Checked out to (receiving person) *' });
              card.append(wrap('Destination *', dest), wrap('Checked out to *', custodian));
              card.append(el('button', {
                class: 'btn', onclick: async () => {
                  try {
                    await api('/pharmacy/' + mine.uuid + '/dispense', { method: 'POST', body: { destination: dest.value, checkedOutTo: custodian.value } });
                    toast('Dispensed — Day Care administration task generated');
                    await wfComplete(task);
                  } catch (e) { toast(e.error, true); }
                }
              }, 'Dispense to Day Care'));
            }
            catch (e) { toast(e.error, true); }
          }
        }, 'Independent check & release'));
      } catch (e) { toast(e.error, true); }
    }
  }, 'Receive → verify → prepare');
  card.append(verifyBtn);
}

async function wfComplete(task) {
  if (task.uuid) { try { await api('/tasks/' + task.uuid + '/complete', { method: 'POST', body: { outcome: 'released to day care' } }); } catch (e) { /* already completed */ } }
  state.view = { name: 'worklist' };
  render();
}

function formDayCare(card, task, chart, done) {
  const rec = (chart.pharmacy || []).find(r => r.status === 'DISPENSED');
  if (!rec) {
    const gate = (chart.pharmacy || []).find(r => r.status === 'RELEASED');
    card.append(el('div', { class: 'stopgate' }, gate
      ? 'STOP-GATE: preparation is RELEASED but not yet DISPENSED — pharmacy must dispense (chain of custody) before administration.'
      : 'STOP-GATE: administration requires a DISPENSED treatment order. Release ≠ dispense; preparation is not administration.'));
    return;
  }
  const disp = (chart.dispenses || []).find(d => d.pharmacyUuid === rec.uuid);
  if (disp) card.append(el('div', { class: 'prov' }, 'Dispensed ' + disp.destination + ' → ' + disp.checkedOutTo + ' by ' + disp.dispensedByName));
  const order = chart.treatmentOrders.find(o => o.uuid === rec.orderUuid);
  const status = el('div', {});
  let adm = null;
  const startBtn = el('button', {
    class: 'btn', onclick: async () => {
      try {
        adm = await api('/administrations/start', { method: 'POST', body: { pharmacyUuid: rec.uuid } });
        renderSteps();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Patient arrived — start administration record');

  const renderSteps = () => {
    status.innerHTML = '';
    const vitals = el('input', { type: 'checkbox' }); const access = el('input', { type: 'checkbox' });
    status.append(el('div', { class: 'checkbox-row' }, vitals, el('span', {}, 'Vitals stable (readiness)')));
    status.append(el('div', { class: 'checkbox-row' }, access, el('span', {}, 'Vascular access confirmed')));
    status.append(wrap('Access type/site', el('input', { id: 'accessSite', placeholder: 'e.g. PICC right arm' })));
    status.append(el('button', {
      class: 'btn small', onclick: async () => {
        await api('/administrations/' + adm.uuid + '/update', { method: 'POST', body: { readiness: { vitalsStable: vitals.checked, premedicationsGiven: true }, access: { type: 'PICC', site: document.getElementById('accessSite').value }, status: 'IN_PROGRESS' } });
        toast('Readiness + premed recorded');
      }
    }, 'Record readiness & premed'));
    // D10a: two-identifier patient verification before first drug
    status.append(el('h3', {}, 'Patient identity verification (two identifiers)'));
    const idName = el('input', { type: 'checkbox' }); const idMrn = el('input', { type: 'checkbox' });
    status.append(el('div', { class: 'checkbox-row' }, idName, el('span', {}, 'Patient stated FULL NAME and it matches: ' + chart.patient.name)));
    status.append(el('div', { class: 'checkbox-row' }, idMrn, el('span', {}, 'Wristband/file MRN matches: ' + chart.patient.mrn)));
    const verifyBtn = el('button', {
      class: 'btn small', onclick: async () => {
        try {
          await api('/administrations/' + adm.uuid + '/update', { method: 'POST', body: { patientIdentityVerification: { method: 'TWO_IDENTIFIER', nameConfirmation: idName.checked, mrnConfirmation: idMrn.checked } } });
          toast('Two-identifier verification recorded');
        } catch (e) { toast(e.error, true); }
      }
    }, 'Record identity verification');
    status.append(verifyBtn);
    // drug lines from order
    const today = new Date().toISOString().slice(0, 10);
    const todaysLines = order.cycleDays.filter(c => c.plannedDate <= today && (c.status === 'PROJECTED' || c.status === 'DELAYED'));
    status.append(el('h3', {}, "Today's scheduled lines"));
    for (const l of todaysLines.slice(0, 6)) {
      const given = el('button', {
        class: 'btn small secondary', style: 'margin-right:6px', onclick: async () => {
          await api('/administrations/' + adm.uuid + '/update', { method: 'POST', body: { line: { phase: l.phase, medication: l.medication, start: new Date().toISOString(), stop: new Date(Date.now() + 60 * 60000).toISOString(), actualDose: l.orderedDose, route: l.route, rate: l.infusionRate || null, interruption: null, reaction: null } } });
          toast(l.medication + ' administered');
        }
      }, 'Give ' + l.phase + ': ' + l.medication + ' ' + l.orderedDose + ' ' + l.doseUnits);
      status.append(given);
    }
    // D10a: structured infusion reaction workflow
    status.append(el('h3', {}, 'Infusion reaction (structured)'));
    const rxDrug = el('input', { placeholder: 'Running drug' });
    const rxSev = el('select', {}, ...['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'].map(v => el('option', { value: v }, v)));
    const rxSym = el('input', { placeholder: 'Symptoms (comma-separated)' });
    const rxActions = el('select', { multiple: true, size: 4 }, ...['STOP_INFUSION', 'RESCUE_MEDICATION', 'PHYSICIAN_NOTIFIED', 'IV_FLUIDS', 'OXYGEN'].map(v => el('option', { value: v }, v)));
    status.append(el('div', { class: 'grid3' }, wrap('Running drug', rxDrug), wrap('Severity *', rxSev), wrap('Symptoms *', rxSym)),
      wrap('Actions taken (ctrl-click multi) *', rxActions));
    status.append(el('button', {
      class: 'btn small danger', onclick: async () => {
        try {
          const r = await api('/infusion-reactions', { method: 'POST', body: {
            administrationUuid: adm.uuid, runningDrug: rxDrug.value, severity: rxSev.value,
            symptoms: rxSym.value.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ symptom: s })),
            actions: Array.from(rxActions.selectedOptions || []).map(o => o.value), onsetTime: new Date().toISOString()
          }});
          toast('Infusion reaction recorded (' + r.severity + ') — physician notification task generated if notified');
        } catch (e) { toast(e.error, true); }
      }
    }, 'Record infusion reaction'));
    status.append(el('button', {
      class: 'btn', onclick: async () => {
        try {
          await api('/administrations/' + adm.uuid + '/complete', { method: 'POST', body: {} });
          toast('Administration completed — toxicity & next-cycle review tasks generated');
          await done();
        } catch (e) { toast(e.error, true); }
      }
    }, 'Complete administration & discharge'));
  };
  card.append(startBtn, status);
}

// D8: Next-cycle decision — aggregate prior context + 7 canonical options
async function formNextCycle(card, task, chart, done) {
  const orderUuid = (task.payload && task.payload.orderUuid) || (chart.activeOrder && chart.activeOrder.uuid);
  if (!orderUuid) { card.append(el('div', { class: 'stopgate' }, 'No treatment order on this patient.')); return; }
  let ctx;
  try { ctx = await api('/next-cycle-context/' + orderUuid + '?patientUuid=' + chart.patient.uuid); }
  catch (e) { card.append(el('div', { class: 'stopgate' }, e.error)); return; }

  card.append(el('h3', {}, 'Prior cycle in review (immutable)'));
  card.append(el('div', { class: 'prov' }, ctx.order.regimenName + ' v' + ctx.order.regimenVersion + ' · BSA ' + ctx.order.bsa + ' · ' + ctx.order.plannedCycles + ' planned cycles · reductions: ' + JSON.stringify(ctx.order.reductions || [])));
  const ol = el('ul', { style: 'font-size:12px;margin-left:18px' });
  for (const d of ctx.order.orderedDoses) ol.append(el('li', {}, d.phase + ': ' + d.medication + ' ' + d.orderedDose + ' (' + d.route + ')'));
  card.append(ol);

  card.append(el('h3', {}, 'What actually happened'));
  const facts = el('ul', { style: 'font-size:12px;margin-left:18px' });
  for (const a of ctx.administrations) facts.append(el('li', {}, 'Administration ' + a.status + (a.completedAt ? ' — completed ' + fmtDate(a.completedAt) : '') + ' · identity verified: ' + (a.identityVerified ? 'yes' : 'NO') + ' · lines given: ' + (a.lines || []).length));
  for (const t of ctx.toxicities) facts.append(el('li', {}, 'Toxicity: ' + t.type + ' G' + t.grade + ' (' + t.toxicityVersion + ') — ' + t.resolution + (t.hospitalization ? ' — HOSPITALIZED' : '') + (t.doseReduction ? ' — reduced ' + t.doseReduction.newReductionPercent + '%' : '')));
  for (const r of ctx.reactions) facts.append(el('li', {}, 'Infusion reaction: ' + r.severity + ' on ' + r.runningDrug + ' — outcome ' + (r.outcome || 'ongoing')));
  for (const m of ctx.missedOrDelayed) facts.append(el('li', {}, 'MISSED/DELAYED: cycle ' + m.cycleNumber + ' planned ' + m.plannedDate + ' (' + m.status + ')'));
  if (ctx.response) facts.append(el('li', {}, 'Response: ' + ctx.response.category + ' — decision ' + ctx.response.decision));
  if (facts.children.length === 0) facts.append(el('li', {}, 'No administrations, toxicities or reactions recorded.'));
  card.append(facts);
  if (ctx.priorDecisions.length) card.append(el('div', { class: 'prov' }, 'Prior decisions: ' + ctx.priorDecisions.map(d => d.decision + ' (' + fmtDate(d.at) + ')').join('; ')));

  card.append(el('h3', {}, 'Decision (canonical §40)'));
  const dec = el('select', {}, ...['PROCEED_UNCHANGED', 'PROCEED_WITH_MODIFICATION', 'DELAY', 'HOLD', 'DISCONTINUE', 'CHANGE_REGIMEN', 'COMPLETE_TREATMENT'].map(v => el('option', { value: v }, v.replace(/_/g, ' '))));
  const modMed = el('input', { placeholder: 'Modified medication' });
  const modPct = el('input', { type: 'number', placeholder: 'New reduction %' });
  const modReason = el('input', { placeholder: 'Modification reason' });
  const newReg = el('input', { placeholder: 'New regimen code' });
  const newStart = el('input', { type: 'date' });
  const rationale = el('textarea', { placeholder: 'Clinical rationale' });
  const modBox = el('div', { class: 'grid3' }, wrap('Medication', modMed), wrap('New reduction %', modPct), wrap('Reason', modReason));
  const regBox = el('div', { class: 'grid2' }, wrap('New regimen code *', newReg));
  const delayBox = el('div', {}, wrap('Revised start date *', newStart));
  const dyn = () => {
    modBox.style.display = dec.value === 'PROCEED_WITH_MODIFICATION' ? '' : 'none';
    regBox.style.display = dec.value === 'CHANGE_REGIMEN' ? '' : 'none';
    delayBox.style.display = dec.value === 'DELAY' ? '' : 'none';
  };
  dec.addEventListener('change', dyn);
  card.append(wrap('Decision *', dec), modBox, regBox, delayBox, wrap('Rationale', rationale));
  dyn();
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const body = { patientUuid: chart.patient.uuid, orderUuid, decision: dec.value, rationale: rationale.value };
        if (dec.value === 'PROCEED_WITH_MODIFICATION') body.modification = { medication: modMed.value, doseReductionPercent: modPct.value ? Number(modPct.value) : null, reason: modReason.value };
        if (dec.value === 'CHANGE_REGIMEN') body.newRegimenCode = newReg.value;
        if (dec.value === 'DELAY') body.newStartDate = newStart.value;
        const d = await api('/next-cycle-decisions', { method: 'POST', body });
        await api('/next-cycle-decisions/' + d.uuid + '/sign', { method: 'POST', body: {} });
        toast('Decision signed — next responsibility routed');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign decision & route'));
}

async function formToxicity(card, task, chart, done) {
  const type = await masterSelect('toxicity');
  const toxVersion = await masterSelect('toxicityVersion');
  const grade = el('select', {}, ...[1, 2, 3, 4, 5].map(g => el('option', { value: g }, 'Grade ' + g)));
  const onset = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const attribution = el('select', {}, ...['TREATMENT', 'DISEASE', 'OTHER', 'UNKNOWN'].map(v => el('option', { value: v }, v)));
  const intervention = el('input', { placeholder: 'Intervention' });
  const hold = el('input', { type: 'checkbox' }); const delay = el('input', { type: 'checkbox' }); const disc = el('input', { type: 'checkbox' });
  const redPct = el('input', { type: 'number', placeholder: 'Dose reduction % (optional)' });
  const resolution = el('select', {}, ...['RESOLVED', 'IMPROVING', 'ONGOING'].map(v => el('option', { value: v }, v)));
  const implication = el('input', { placeholder: 'Next-cycle implication' });
  card.append(el('div', { class: 'grid3' }, wrap('Toxicity type *', type), wrap('Grade *', grade), wrap('Onset *', onset)),
    wrap('Criteria version * (CTCAE)', toxVersion), wrap('Attribution *', attribution), wrap('Intervention', intervention),
    el('div', { class: 'checkbox-row' }, delay, el('span', {}, 'Treatment delay required')),
    el('div', { class: 'checkbox-row' }, hold, el('span', {}, 'Treatment hold')),
    el('div', { class: 'checkbox-row' }, disc, el('span', {}, 'Discontinue treatment')),
    wrap('Dose reduction %', redPct), wrap('Resolution', resolution), wrap('Next-cycle implication', implication));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const tox = await api('/toxicities', { method: 'POST', body: {
          patientUuid: chart.patient.uuid, type: type.value, grade: Number(grade.value), onset: onset.value,
          toxicityVersion: toxVersion.value,
          attribution: attribution.value, intervention: intervention.value,
          treatmentHold: hold.checked, treatmentDelay: delay.checked, discontinuation: disc.checked,
          doseReduction: redPct.value ? { medication: 'DOXORUBICIN', newReductionPercent: Number(redPct.value) } : null,
          resolution: resolution.value, nextCycleImplication: implication.value
        }});
        await api('/toxicities/' + tox.uuid + '/sign', { method: 'POST', body: {} });
        toast('Toxicity signed');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign toxicity assessment'));
}

async function formResponse(card, task, chart, done) {
  const cat = await masterSelect('response');
  const decision = el('select', {},
    el('option', { value: 'CONTINUE' }, 'Continue current treatment'),
    el('option', { value: 'MODIFY' }, 'Modify current treatment'),
    el('option', { value: 'NEXT_LINE' }, 'Next line of therapy'),
    el('option', { value: 'SURVEILLANCE' }, 'Surveillance'));
  const notes = el('textarea', { placeholder: 'Assessment notes / evidence' });
  card.append(wrap('Response category *', cat), wrap('Next treatment decision *', decision), wrap('Notes', notes));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const r = await api('/responses', { method: 'POST', body: { patientUuid: chart.patient.uuid, category: cat.value, decision: decision.value, notes: notes.value } });
        await api('/responses/' + r.uuid + '/sign', { method: 'POST', body: {} });
        toast('Response signed — next treatment decision routed');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign response assessment'));
}

async function formResultsReview(card, task, chart, done) {
  const results = await api('/results?patientUuid=' + chart.patient.uuid);
  const orders = (await api('/investigation-orders')).filter(o => o.patientUuid === chart.patient.uuid);
  const priorConsults = (chart.consultations || []).filter(c => c.consultationType !== 'RESULTS_REVIEW');
  const OUTSTANDING = ['SIGNED', 'SCHEDULED', 'COLLECTED', 'ACQUIRED', 'IN_PROGRESS'];
  const outstanding = orders.filter(o => OUTSTANDING.includes(o.status));
  const c = el('div', {});
  c.append(el('h3', {}, 'Previous consultation(s)'));
  if (!priorConsults.length) c.append(el('div', { class: 'muted' }, 'None.'));
  for (const pc of priorConsults) {
    c.append(el('div', { class: 'prov' }, el('b', {}, (pc.consultationType || '').replace(/_/g, ' ')), ' — ' + (pc.chiefComplaint || pc.clinicalNotes || '') + ' — ' + fmtDate(pc.at) + (pc.signedAt ? ' · signed' : ' · DRAFT')));
  }
  c.append(el('h3', {}, 'Investigation orders'));
  for (const o of orders) c.append(el('div', { class: 'prov' }, o.category + ': ' + o.displayName + ' — ' + o.status));
  const groups = [['PATHOLOGY', 'Pathology'], ['RADIOLOGY', 'Radiology'], ['LAB', 'Laboratory'], ['MOLECULAR', 'Molecular / biomarker']];
  for (const [cat, label] of groups) {
    const rs = results.filter(r => (r.resultType || r.category) === cat);
    if (!rs.length) continue;
    c.append(el('h3', {}, label));
    for (const r of rs) {
      c.append(el('div', { class: 'prov' }, el('b', {}, r.test), ' — ' + r.summary,
        ' — finalized ' + fmtDate(r.finalizedAt) + ' by ' + r.byName,
        r.reviewStatus ? ' · ' + r.reviewStatus : '', r.resultStatus && r.resultStatus !== 'FINAL' ? ' · ' + r.resultStatus : ''));
    }
  }
  if (!results.length) c.append(el('div', { class: 'muted' }, 'No finalized results.'));
  if (outstanding.length) {
    c.append(el('h3', {}, 'Outstanding investigations'));
    for (const o of outstanding) c.append(el('div', { class: 'prov' }, o.category + ': ' + o.displayName + ' — ' + o.status));
  }
  card.append(c);
  card.append(el('div', { class: 'stopgate' }, 'Can a cancer diagnosis now be confirmed? Record the canonical review decision (canonical §8).'));
  const ecog = el('select', {}, ...['0', '1', '2', '3', '4'].map(v => el('option', { value: v }, 'ECOG ' + v)));
  const notes = el('textarea', { placeholder: 'Review notes' });
  const tests = state.cache.diagnosticTests || (state.cache.diagnosticTests = await api('/diagnostic-tests'));
  const addCat = el('select', {}, el('option', { value: '' }, '— additional order (if needed) —'), ...['LAB', 'RADIOLOGY', 'PATHOLOGY', 'MOLECULAR', 'GENETIC', 'PROCEDURE'].map(v => el('option', { value: v }, v)));
  const addTest = el('select', {}, el('option', { value: '' }, '— master test —'));
  const fillAdd = () => {
    addTest.innerHTML = '';
    addTest.append(el('option', { value: '' }, '— master test —'));
    for (const t of tests.filter(t => t.category === addCat.value)) addTest.append(el('option', { value: t.code }, t.label));
  };
  addCat.addEventListener('change', fillAdd);
  fillAdd();
  card.append(el('div', { class: 'grid3' }, wrap('ECOG (current)', ecog), wrap('Additional category', addCat), wrap('Additional test', addTest)), wrap('Notes', notes));
  const decide = (decision) => async () => {
    try {
      const body = { patientUuid: chart.patient.uuid, decision, ecog: ecog.value, clinicalNotes: notes.value, additionalOrdersRequested: [] };
      if (addCat.value && addTest.value) body.additionalOrdersRequested = [{ category: addCat.value, testCode: addTest.value, notes: 'From results review' }];
      if (decision === 'NEEDS_MORE_INFORMATION' && !body.additionalOrdersRequested.length) { toast('NEEDS_MORE_INFORMATION requires an additional order (or pick another decision)', true); return; }
      const review = await api('/results-review', { method: 'POST', body });
      toast('Review recorded — ' + String((review && review.workflowEffect) || 'done').replace(/_/g, ' ').toLowerCase());
      if (decision === 'DIAGNOSIS_CONFIRMED') {
        // CONFIRM_DIAGNOSIS task generated by backend — route straight to the diagnosis form
        state.view = { name: 'task', task: { code: 'CONFIRM_DIAGNOSIS', destination: 'diagnosis', title: 'Confirm cancer diagnosis', patientUuid: chart.patient.uuid, payload: {}, uuid: null } };
        render();
      } else { await done(); }
    } catch (e) { toast(e.error, true); }
  };
  card.append(el('div', { style: 'margin-top:8px' },
    el('button', { class: 'btn', onclick: decide('DIAGNOSIS_CONFIRMED') }, 'Diagnosis confirmed — proceed to structured diagnosis'),
    el('button', { class: 'btn secondary', style: 'margin-left:8px', onclick: decide('NEEDS_MORE_INFORMATION') }, 'Needs more information (order investigation)'),
    el('button', { class: 'btn secondary', style: 'margin-left:8px', onclick: decide('CONTINUE_WORKUP') }, 'Continue workup — review again later')));
}

function formRadiation(card, task, chart) {
  const intent = el('select', {}, ...['CURATIVE', 'PALLIATIVE', 'ADJUVANT'].map(v => el('option', { value: v }, v)));
  const site = el('input', { placeholder: 'Treatment site *' });
  const dose = el('input', { type: 'number', placeholder: 'Dose per fraction (Gy) *' });
  const fx = el('input', { type: 'number', placeholder: 'Fractions *' });
  const technique = el('input', { placeholder: 'Technique (IMRT/VMAT/3DCRT)' });
  const sim = el('input', { type: 'date' });
  card.append(el('div', { class: 'grid3' }, wrap('Intent', intent), wrap('Site *', site), wrap('Technique', technique)),
    el('div', { class: 'grid3' }, wrap('Dose/fraction *', dose), wrap('Fractions *', fx), wrap('Simulation date', sim)));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const rx = await api('/rt-prescriptions', { method: 'POST', body: { patientUuid: chart.patient.uuid, intent: intent.value, site: site.value, dosePerFraction: dose.value, fractions: fx.value, technique: technique.value, simulationDate: sim.value } });
        await api('/rt-prescriptions/' + rx.uuid + '/approve', { method: 'POST', body: { physicsCheck: 'Plan verified — MU/dose checks passed' } });
        toast('RT plan PLANNED → APPROVED; fraction events projected');
        await wfComplete(task);
      } catch (e) { toast(e.error, true); }
    }
  }, 'Prescribe & approve (Planned → Approved)'));
}

function formSurgery(card, task, chart) {
  const procedure = el('input', { placeholder: 'Procedure *' });
  const laterality = el('select', {}, el('option', { value: '' }, '—'), ...['LEFT', 'RIGHT', 'BILATERAL'].map(v => el('option', { value: v }, v)));
  const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const findings = el('textarea', { placeholder: 'Operative findings' });
  const specimen = el('input', { placeholder: 'Specimen site (creates pathology task)' });
  card.append(el('div', { class: 'grid3' }, wrap('Procedure *', procedure), wrap('Laterality', laterality), wrap('Planned date *', date)));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const plan = await api('/surgical-plans', { method: 'POST', body: { patientUuid: chart.patient.uuid, procedure: procedure.value, laterality: laterality.value || undefined, plannedDate: date.value } });
        await api('/surgical-plans/' + plan.uuid + '/sign', { method: 'POST', body: {} });
        const rec = await api('/operative-records', { method: 'POST', body: { surgicalPlanUuid: plan.uuid, performedProcedure: procedure.value, findings: findings.value, specimens: specimen.value ? [{ site: specimen.value, laterality: laterality.value || null }] : [] } });
        await api('/operative-records/' + rec.uuid + '/sign', { method: 'POST', body: {} });
        toast('Surgical plan (signed) + operative record (signed) complete — specimen/adjuvant tasks generated');
        await wfComplete(task);
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign surgical plan & operative record'));
}

boot();
