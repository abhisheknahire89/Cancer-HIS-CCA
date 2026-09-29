// CCA OS — Task Worklist UI (frontend seam for the role worklist)
// Owns the role worklist view (viewWorklist with its My Tasks / Waiting /
// Completed-by-me buckets), task navigation (openTask), the task action shell
// (viewTaskAction — patient header, backlink, the 20-destination route table
// and the shared completeAndRoute completion helper) and the department
// result form (formDeptResult). renderPatientHeader comes from chart-ui.js;
// every routed form (formConsultation … formSurgery) resolves globally at
// dispatch time by the shared-globals convention. Loads after app.js and
// shares its globals (el, api, state, toast, render, fmtDate, wrap) — the
// established staging-ui.js/treatment-ui.js/chart-ui.js convention.
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
    'consult-new': () => formConsultation(card, task, chart, completeAndRoute('consultation signed')),
    'dept-lab': () => formDeptResult(card, task, chart, 'LAB', completeAndRoute('lab result finalized')),
    'dept-radiology': () => formDeptResult(card, task, chart, 'RADIOLOGY', completeAndRoute('radiology result finalized')),
    'dept-pathology': () => formDeptResult(card, task, chart, 'PATHOLOGY', completeAndRoute('pathology result finalized')),
    'diagnosis': () => formDiagnosis(card, task, chart, completeAndRoute('diagnosis signed')),
    'staging': () => formStaging(card, task, chart, completeAndRoute('staging signed')),
    // two task codes share this screen: the coordinator records discussion (chair signs separately, §D-MDT-6), only MDT_CHAIR_SIGN actually signs
    'mdt': () => formMdt(card, task, chart, completeAndRoute(task.code === 'MDT_CHAIR_SIGN' ? 'MDT outcome signed by chair' : 'MDT discussion recorded — routed to chair for sign-out')),
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
