// CCA OS — Patient Chart UI (frontend seam for the longitudinal patient workspace)
// Owns the patient chart view: the workspace shell (viewPatientChart — header,
// tab bar, tab dispatch), the patient header (renderPatientHeader/pcell) and all
// tab renderers (Overview, Consultations, Investigations, Diagnosis, MDT, Care
// Plan, Treatment, Pharmacy, Administration, Toxicity, Response, Consent, Disease
// Profile + its biomarker modal, Finance, Documents, Timeline) plus the yn helper. The Staging tab delegates to tabStaging (staging-ui.js) and the
// Calendar tab to tabPatientCalendarV2 (calendar-ui.js) — cross-module by the
// shared-globals convention. el2s comes from ui-helpers.js (shared module,
// loaded first); yn is local. Loads after app.js and shares its globals
// (el, api, state, toast, render, wrap, fmtDate) — the established
// calendar-ui.js/staging-ui.js/treatment-ui.js convention.
// Extracted verbatim from app.js (was lines 442–878); tabPatientCalendar remains
// included although currently unreferenced (superseded by tabPatientCalendarV2).
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
