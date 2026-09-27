// CCA OS — Oncology Calendar: clinical-event derivation engine
// Calendar events are a PROJECTION over authoritative clinical records — never a
// duplicate store of clinical truth (canonical mandate: derive the timeline from
// authoritative records). Every event carries its source record reference
// (refType/refUuid) so the UI can offer VIEW SOURCE. Re-derived at read time.
// PROJECTED events are pure appointments-in-the-future: they never advance the
// clinical state machine and can never appear as delivered care.
'use strict';
const store = require('./store');
const masters = require('./masters');

const EVENT_STATES = ['ACTUAL', 'SCHEDULED', 'PROJECTED', 'READY', 'HELD', 'DELAYED', 'CANCELLED', 'COMPLETED'];

const MODALITY = {
  MEDICAL_ONCOLOGY: 'MEDICAL_ONCOLOGY',
  RADIATION_ONCOLOGY: 'RADIATION_ONCOLOGY',
  SURGICAL_ONCOLOGY: 'SURGICAL_ONCOLOGY',
  DIAGNOSTICS: 'DIAGNOSTICS',
  JOURNEY: 'JOURNEY'
};

// Canonical calendar event catalogue: type → { modality, label, defaultOwner }
const EVENT_TYPES = {
  CONSULTATION:          { modality: MODALITY.JOURNEY,             label: 'Consultation',                owner: 'Medical Oncologist' },
  INVESTIGATION_ORDER:   { modality: MODALITY.DIAGNOSTICS,         label: 'Investigation order',         owner: 'Medical Oncologist' },
  SPECIMEN_COLLECTION:   { modality: MODALITY.DIAGNOSTICS,         label: 'Specimen collection',         owner: 'Lab' },
  LABORATORY_RESULT:     { modality: MODALITY.DIAGNOSTICS,         label: 'Laboratory result',           owner: 'Lab' },
  PATHOLOGY:             { modality: MODALITY.DIAGNOSTICS,         label: 'Pathology',                   owner: 'Pathologist' },
  RADIOLOGY:             { modality: MODALITY.DIAGNOSTICS,         label: 'Radiology',                   owner: 'Radiologist' },
  RESULTS_REVIEW:        { modality: MODALITY.JOURNEY,             label: 'Results-review consultation', owner: 'Medical Oncologist' },
  DIAGNOSIS:             { modality: MODALITY.JOURNEY,             label: 'Diagnosis',                   owner: 'Medical Oncologist' },
  STAGING:               { modality: MODALITY.JOURNEY,             label: 'Staging',                     owner: 'Medical Oncologist' },
  MDT:                   { modality: MODALITY.JOURNEY,             label: 'MDT',                         owner: 'MDT Coordinator' },
  CARE_PLAN:             { modality: MODALITY.JOURNEY,             label: 'Care plan',                   owner: 'Medical Oncologist' },
  FINANCIAL_COUNSELLING: { modality: MODALITY.JOURNEY,             label: 'Financial counselling',       owner: 'Financial Counsellor' },
  AUTHORIZATION:         { modality: MODALITY.JOURNEY,             label: 'Authorization',               owner: 'Financial Counsellor' },
  CONSENT:               { modality: MODALITY.JOURNEY,             label: 'Consent',                     owner: 'Medical Oncologist' },
  TREATMENT_READINESS:   { modality: MODALITY.JOURNEY,             label: 'Treatment readiness',         owner: 'Nurse Navigator' },
  SYSTEMIC_CYCLE:        { modality: MODALITY.MEDICAL_ONCOLOGY,    label: 'Systemic therapy cycle',      owner: 'Medical Oncologist' },
  SUPPORTIVE_TREATMENT:  { modality: MODALITY.MEDICAL_ONCOLOGY,    label: 'Supportive treatment',        owner: 'Pharmacist' },
  TOXICITY_REVIEW:       { modality: MODALITY.MEDICAL_ONCOLOGY,    label: 'Toxicity review',             owner: 'Medical Oncologist' },
  RESPONSE_ASSESSMENT:   { modality: MODALITY.MEDICAL_ONCOLOGY,    label: 'Response assessment',         owner: 'Medical Oncologist' },
  SURVEILLANCE:          { modality: MODALITY.JOURNEY,             label: 'Surveillance',                owner: 'Medical Oncologist' },
  RT_SIMULATION:         { modality: MODALITY.RADIATION_ONCOLOGY,  label: 'Radiation simulation',        owner: 'Radiation Oncologist' },
  RT_PLANNING:           { modality: MODALITY.RADIATION_ONCOLOGY,  label: 'RT planning',                 owner: 'Radiation Oncologist' },
  RT_PHYSICS_QA:         { modality: MODALITY.RADIATION_ONCOLOGY,  label: 'RT physics QA',               owner: 'Radiation Oncologist' },
  RT_APPROVAL:           { modality: MODALITY.RADIATION_ONCOLOGY,  label: 'RT plan approval',            owner: 'Radiation Oncologist' },
  RT_FRACTION:           { modality: MODALITY.RADIATION_ONCOLOGY,  label: 'RT fraction',                 owner: 'Radiation Oncologist' },
  RT_COMPLETION:         { modality: MODALITY.RADIATION_ONCOLOGY,  label: 'RT course completion',        owner: 'Radiation Oncologist' },
  SURGERY_PREOP:         { modality: MODALITY.SURGICAL_ONCOLOGY,   label: 'Pre-op',                      owner: 'Surgical Oncologist' },
  SURGERY_ADMISSION:     { modality: MODALITY.SURGICAL_ONCOLOGY,   label: 'Admission',                   owner: 'Surgical Oncologist' },
  SURGERY:               { modality: MODALITY.SURGICAL_ONCOLOGY,   label: 'Operation',                   owner: 'Surgical Oncologist' },
  SURGERY_PATHOLOGY:     { modality: MODALITY.SURGICAL_ONCOLOGY,   label: 'Pathology after surgery',     owner: 'Pathologist' },
  SURGERY_POSTOP_REVIEW: { modality: MODALITY.SURGICAL_ONCOLOGY,   label: 'Post-operative review',       owner: 'Surgical Oncologist' },
  ADJUVANT_DECISION:     { modality: MODALITY.SURGICAL_ONCOLOGY,   label: 'Adjuvant decision',           owner: 'Medical Oncologist' }
};

// ---------- date helpers ----------
function dayOf(ts) { return ts ? String(ts).slice(0, 10) : null; }
function plusDays(dateStr, n) { const d = new Date(dateStr); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function minusDays(dateStr, n) { return plusDays(dateStr, -n); }

function mk(patientUuid, type, date, state, refType, refUuid, extra) {
  return Object.assign({
    patientUuid, type,
    date: date || null,
    state: state || 'ACTUAL',
    refType: refType || null,
    refUuid: refUuid || null,
    owner: (EVENT_TYPES[type] || {}).owner || null,
    title: (EVENT_TYPES[type] || {}).label || type
  }, extra || {});
}

// ---------- per-source projections ----------
function projConsultations(list, add) {
  for (const c of list) {
    const titleMap = { INTAKE: 'Intake assessment', FIRST_ONCOLOGY: 'Oncology consultation', RESULTS_REVIEW: 'Results-review consultation', FOLLOW_UP: 'Follow-up consultation' };
    // consultations are recorded+signed in one step here — existence of the record
    // IS the clinical fact that the visit happened
    add(mk(c.patientUuid, c.consultType === 'RESULTS_REVIEW' || c.consultationType === 'RESULTS_REVIEW' ? 'RESULTS_REVIEW' : 'CONSULTATION', dayOf(c.at), 'ACTUAL', 'consultations', c.uuid, {
      title: titleMap[c.consultationType || c.consultType] || 'Oncology consultation', byName: c.byName || null
    }));
  }
}

function projInvestigations(list, add) {
  const OPEN_STATUSES = ['SIGNED', 'SCHEDULED', 'COLLECTED', 'ACQUIRED', 'IN_PROGRESS']; // order awaiting the department
  for (const o of list) {
    const name = o.displayName || o.test || o.testCode || 'investigation';
    add(mk(o.patientUuid, 'INVESTIGATION_ORDER', dayOf(o.orderedAt), 'ACTUAL', 'investigationOrders', o.uuid, {
      title: 'Investigation ordered: ' + name, byName: o.orderedByName || null, detail: o.category
    }));
    if (OPEN_STATUSES.includes(o.status)) {
      // awaiting the department — visible in "what is happening now" (READY)
      add(mk(o.patientUuid, o.category === 'IMAGING' || o.category === 'RADIOLOGY' ? 'RADIOLOGY' : o.category === 'PATHOLOGY' ? 'PATHOLOGY' : 'LABORATORY_RESULT', null, 'READY', 'investigationOrders', o.uuid, {
        title: 'Awaiting ' + name + ' result', byName: o.orderedByName || null
      }));
    }
    if (!['IMAGING', 'RADIOLOGY'].includes(o.category) && ['RESULT_AVAILABLE', 'REVIEWED'].includes(o.status)) {
      // specimen was collected between order and result — provenance: the order
      add(mk(o.patientUuid, 'SPECIMEN_COLLECTION', dayOf(o.collectionDate || o.orderedAt), 'ACTUAL', 'investigationOrders', o.uuid, {
        title: 'Specimen collected — ' + name
      }));
    }
  }
}

function projResults(list, add) {
  for (const r of list) {
    const type = r.category === 'PATHOLOGY' ? 'PATHOLOGY' : r.category === 'IMAGING' ? 'RADIOLOGY' : 'LABORATORY_RESULT';
    add(mk(r.patientUuid, type, dayOf(r.finalizedAt || r.at), 'ACTUAL', 'results', r.uuid, {
      title: r.test + ' — result finalized', byName: r.byName || null, detail: r.summary ? String(r.summary).slice(0, 90) : null
    }));
  }
}

function projDiagnosis(list, add) {
  for (const dx of list) {
    if (dx.status === 'SIGNED' || dx.status === 'CONFIRMED') {
      add(mk(dx.patientUuid, 'DIAGNOSIS', dayOf(dx.signedAt), 'ACTUAL', 'diagnoses', dx.uuid, {
        title: 'Cancer diagnosis signed: ' + masters.label('cancerType', dx.cancerType),
        byName: dx.oncologistName || dx.byName || null
      }));
    } else if (dx.status === 'SUPERSEDED') {
      add(mk(dx.patientUuid, 'DIAGNOSIS', dayOf(dx.signedAt), 'CANCELLED', 'diagnoses', dx.uuid, {
        title: 'Diagnosis superseded (history preserved)'
      }));
    }
  }
}

function projStaging(list, add) {
  for (const a of list) {
    const state = a.status === 'SIGNED' ? 'ACTUAL' : a.status === 'SUPERSEDED' ? 'COMPLETED' : 'SCHEDULED';
    add(mk(a.patientUuid, 'STAGING', dayOf(a.assessmentDate), state, 'stagingAssessments', a.uuid, {
      title: 'Staging (' + a.stagingContext + ')' + (a.stageResult ? ' → ' + a.stageResult : ''), byName: a.clinicianName || null
    }));
  }
}

function projMdt(list, add) {
  for (const m of list) {
    add(mk(m.patientUuid, 'MDT', dayOf(m.openedAt), m.status === 'SIGNED' ? 'ACTUAL' : 'SCHEDULED', 'mdtCases', m.uuid, {
      title: 'MDT — ' + (m.decision ? 'decision: ' + m.decision : 'presentation scheduled'),
      byName: m.coordinatorName || null, detail: m.referralReason || null
    }));
  }
}

function projCarePlans(list, add) {
  for (const p of list) {
    add(mk(p.patientUuid, 'CARE_PLAN', dayOf(p.signedAt || p.createdAt), p.status === 'SIGNED' ? 'ACTUAL' : 'SCHEDULED', 'carePlans', p.uuid, {
      title: 'Care plan — ' + (p.treatmentIntent || 'intent pending'), byName: p.oncologistName || null
    }));
  }
}

function projFinance(list, add) {
  for (const f of list) {
    add(mk(f.patientUuid, 'FINANCIAL_COUNSELLING', dayOf(f.signedAt || f.createdAt), f.status === 'SIGNED' ? 'ACTUAL' : 'SCHEDULED', 'financialCounsellings', f.uuid, {
      title: 'Financial counselling', byName: f.counsellorName || null
    }));
    if (f.authorization && f.authorization.status === 'APPROVED') {
      add(mk(f.patientUuid, 'AUTHORIZATION', dayOf(f.signedAt), 'ACTUAL', 'financialCounsellings', f.uuid, {
        title: 'Authorization approved' + (f.authorization.number ? ' (' + f.authorization.number + ')' : ''),
        byName: f.counsellorName || null
      }));
    }
  }
}

function projConsent(list, add) {
  for (const c of list) {
    if (c.status === 'SUPERSEDED') continue;
    add(mk(c.patientUuid, 'CONSENT', dayOf(c.signedAt || c.createdAt), c.status === 'SIGNED' ? 'ACTUAL' : 'SCHEDULED', 'consents', c.uuid, {
      title: 'Consent (' + c.consentType + ')', byName: c.clinicianName || null
    }));
  }
}

function projReadiness(list, add) {
  for (const r of list) {
    add(mk(r.patientUuid, 'TREATMENT_READINESS', dayOf(r.clearedAt || r.createdAt), 'ACTUAL', 'readinessChecks', r.uuid, {
      title: 'Treatment readiness cleared', byName: r.clearedByName || null
    }));
  }
}

// Signed treatment order → future treatment schedule (PROJECTED; never delivered care)
function projOrders(list, add) {
  for (const o of list) {
    if (o.status !== 'SIGNED') continue;
    // day-level systemic events (group the per-drug rows)
    const days = {};
    for (const cd of o.cycleDays || []) {
      const k = cd.cycle + '-' + cd.day;
      if (!days[k]) days[k] = { cycle: cd.cycle, day: cd.day, plannedDate: cd.plannedDate, supportives: [], status: cd.status };
      else if (cd.status === 'DELAYED') days[k].status = 'DELAYED';
      if (cd.phase && cd.phase !== 'DRUG') days[k].supportives.push(cd.phase + ' ' + cd.medication);
    }
    for (const k of Object.keys(days)) {
      const d = days[k];
      add(mk(o.patientUuid, 'SYSTEMIC_CYCLE', d.plannedDate, d.status === 'DELAYED' ? 'DELAYED' : 'PROJECTED', 'treatmentOrders', o.uuid, {
        title: 'Chemo C' + d.cycle + 'D' + d.day + ' — ' + o.regimenName, byName: o.orderedByName || null,
        detail: 'cycle ' + d.cycle + ' day ' + d.day, cycle: d.cycle, day: d.day,
        supportives: d.supportives
      }));
    }
    // supportive/premedication rows as their own events
    for (const cd of o.cycleDays || []) {
      if (cd.phase && cd.phase !== 'DRUG') {
        add(mk(o.patientUuid, 'SUPPORTIVE_TREATMENT', cd.plannedDate, cd.status === 'DELAYED' ? 'DELAYED' : 'PROJECTED', 'treatmentOrders', o.uuid, {
          title: cd.phase + ' — ' + cd.medication + (cd.orderedDose ? ' ' + cd.orderedDose + ' ' + (cd.doseUnits || '') : ''),
          detail: cd.route || null, cycle: cd.cycle, day: cd.day, byName: o.orderedByName || null
        }));
      }
    }
    // pre-cycle labs 48h before each cycle day-1; toxicity review ~10d after
    const starts = [...new Set((o.cycleDays || []).filter(c => c.day === 1).map(c => c.plannedDate))].sort();
    starts.forEach((d, i) => {
      add(mk(o.patientUuid, 'LABORATORY_RESULT', minusDays(d, 2), 'PROJECTED', 'treatmentOrders', o.uuid, {
        title: 'Pre-cycle labs C' + (i + 1), cycle: i + 1, day: 0
      }));
      add(mk(o.patientUuid, 'TOXICITY_REVIEW', plusDays(d, 10), 'PROJECTED', 'treatmentOrders', o.uuid, {
        title: 'Toxicity review C' + (i + 1), cycle: i + 1
      }));
    });
    // response assessment after the final cycle
    const last = starts[starts.length - 1];
    if (last) {
      add(mk(o.patientUuid, 'RESPONSE_ASSESSMENT', plusDays(last, (o.cycleLengthDays || 21) + 7), 'PROJECTED', 'treatmentOrders', o.uuid, {
        title: 'Response assessment (post-course imaging)'
      }));
    }
  }
}

// Delay records preserve original planned date + reason + revised date + downstream shifts
function projDelays(list, add) {
  for (const d of list) {
    const order = store.byUuid('treatmentOrders', d.orderUuid);
    add(mk(order ? order.patientUuid : null, 'SYSTEMIC_CYCLE', d.originalPlannedDate, 'DELAYED', 'delayRecords', d.uuid, {
      title: 'Cycle delayed: ' + (d.reason || 'reason recorded'),
      detail: 'original ' + d.originalPlannedDate + ' → revised ' + d.revisedDate,
      cycle: d.cycle, byName: d.by || null
    }));
  }
}

// administrations actually delivered → mark PROJECTED events COMPLETED (mirrors legacy rule)
function projAdministrations(add) {
  for (const adm of store.find('administrationRecords', a => a.status === 'COMPLETED')) {
    const ph = store.byUuid('pharmacyRecords', adm.pharmacyUuid);
    const orderUuid = ph ? ph.orderUuid : null;
    if (!orderUuid) continue;
    const order = store.byUuid('treatmentOrders', orderUuid);
    if (!order) continue;
    const upTo = dayOf(adm.completedAt || adm.arrival);
    for (const ev of add.refs.SYSTEMIC_CYCLE) {
      if (ev.refUuid === orderUuid && ev.state === 'PROJECTED' && ev.date && ev.date <= upTo) {
        ev.state = 'COMPLETED'; ev.actualDate = ev.date;
      }
    }
  }
}

function projRt(rxList, add) {
  for (const rx of rxList) {
    add(mk(rx.patientUuid, 'RT_SIMULATION', rx.simulationDate || dayOf(rx.createdAt), rx.signedAt ? 'ACTUAL' : 'SCHEDULED', 'rtPrescriptions', rx.uuid, { title: 'RT simulation — ' + rx.site, byName: rx.prescribedByName || null }));
    add(mk(rx.patientUuid, 'RT_PLANNING', rx.simulationDate || dayOf(rx.createdAt), rx.signedAt ? 'ACTUAL' : 'SCHEDULED', 'rtPrescriptions', rx.uuid, { title: 'RT planning & contouring — ' + rx.site, byName: rx.prescribedByName || null }));
    add(mk(rx.patientUuid, 'RT_PHYSICS_QA', dayOf(rx.signedAt), rx.physicsCheck ? 'ACTUAL' : 'SCHEDULED', 'rtPrescriptions', rx.uuid, { title: 'RT physics QA — ' + rx.site, byName: rx.prescribedByName || null }));
    add(mk(rx.patientUuid, 'RT_APPROVAL', dayOf(rx.signedAt), rx.signedAt ? 'ACTUAL' : 'SCHEDULED', 'rtPrescriptions', rx.uuid, { title: 'RT plan approval — ' + rx.totalDose + ' cGy / ' + rx.fractions + ' fx', byName: rx.prescribedByName || null }));
  }
  // fraction events: legacy per-fraction calendar rows are authoritative delivery slots
  for (const course of store.find('rtCourses', () => true)) {
    for (const ev of store.find('events', e => e.refUuid === course.uuid && e.type === 'RT_FRACTION')) {
      add(mk(course.patientUuid, 'RT_FRACTION', ev.plannedDate, ev.state === 'COMPLETED' ? 'COMPLETED' : ev.state, 'events', ev.uuid, {
        title: ev.title, fraction: ev.fraction || null
      }));
    }
    if (course.status === 'COMPLETED') {
      const dates = store.find('rtFractions', f => f.courseUuid === course.uuid).map(f => f.deliveredDate).sort();
      add(mk(course.patientUuid, 'RT_COMPLETION', dates[dates.length - 1] || null, 'ACTUAL', 'rtCourses', course.uuid, { title: 'RT course completed' }));
    }
  }
}

function projSurgery(planList, add) {
  const records = store.find('operativeRecords', () => true);
  for (const p of planList) {
    const rec = records.find(r => r.surgicalPlanUuid === p.uuid);
    if (rec) continue; // operative record becomes the SURGERY event
    add(mk(p.patientUuid, 'SURGERY', p.plannedDate, 'SCHEDULED', 'surgicalPlans', p.uuid, { title: p.procedure + ' (planned)', byName: p.surgeonName || null }));
    if (p.status === 'SIGNED') {
      add(mk(p.patientUuid, 'SURGERY_PREOP', minusDays(p.plannedDate, 1), 'SCHEDULED', 'surgicalPlans', p.uuid, { title: 'Pre-op assessment — ' + p.procedure, byName: p.surgeonName || null }));
      add(mk(p.patientUuid, 'SURGERY_ADMISSION', p.plannedDate, 'SCHEDULED', 'surgicalPlans', p.uuid, { title: 'Admission — ' + p.procedure }));
    }
  }
  for (const rec of records) {
    add(mk(rec.patientUuid, 'SURGERY', dayOf(rec.performedDate), rec.status === 'SIGNED' ? 'ACTUAL' : 'SCHEDULED', 'operativeRecords', rec.uuid, { title: rec.performedProcedure, byName: rec.surgeonName || null }));
    for (const s of rec.specimens || []) {
      add(mk(rec.patientUuid, 'SURGERY_PATHOLOGY', plusDays(dayOf(rec.performedDate), 3), 'SCHEDULED', 'operativeRecords', rec.uuid, { title: 'Specimen pathology — ' + s.site }));
    }
    add(mk(rec.patientUuid, 'SURGERY_POSTOP_REVIEW', plusDays(dayOf(rec.performedDate), 14), 'SCHEDULED', 'operativeRecords', rec.uuid, { title: 'Post-operative review', byName: rec.surgeonName || null }));
    if ((rec.specimens || []).length) {
      add(mk(rec.patientUuid, 'ADJUVANT_DECISION', plusDays(dayOf(rec.performedDate), 28), 'SCHEDULED', 'operativeRecords', rec.uuid, { title: 'Adjuvant treatment decision (after histopathology)' }));
    }
  }
}

function projToxicity(list, add) {
  for (const t of list) {
    add(mk(t.patientUuid, 'TOXICITY_REVIEW', dayOf(t.onset), t.status === 'SIGNED' ? 'ACTUAL' : 'SCHEDULED', 'toxicityAssessments', t.uuid, {
      title: 'Toxicity: ' + t.type + ' Grade ' + t.grade, byName: t.byName || null
    }));
  }
}

function projResponse(list, add) {
  for (const r of list) {
    add(mk(r.patientUuid, 'RESPONSE_ASSESSMENT', dayOf(r.at), 'ACTUAL', 'responseAssessments', r.uuid, {
      title: 'Response: ' + r.category, byName: r.assessedByName || null
    }));
  }
}

// CR/PR → projected surveillance visits (never advance state; pure future appointments)
function projSurveillance(diagnoses, responses, add) {
  for (const dx of diagnoses) {
    if (dx.status !== 'SIGNED') continue;
    const resp = (responses || []).filter(r => r.patientUuid === dx.patientUuid)
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).pop();
    if (resp && /COMPLETE_RESPONSE|PARTIAL_RESPONSE/.test(resp.category || '')) {
      add(mk(dx.patientUuid, 'SURVEILLANCE', plusDays(dayOf(resp.at), 90), 'PROJECTED', 'responseAssessments', resp.uuid, {
        title: 'Surveillance visit (~12 weeks)'
      }));
    }
  }
}

// ---------- main derivation ----------
function deriveForPatient(patientUuid) {
  const out = [];
  const add = (ev) => { if (ev && ev.patientUuid === patientUuid) out.push(ev); };
  const refs = { SYSTEMIC_CYCLE: out };
  const q = (name) => store.find(name, r => r.patientUuid === patientUuid);

  projConsultations(q('consultations'), add);
  projInvestigations(q('investigationOrders'), add);
  projResults(q('results'), add);
  projDiagnosis(q('diagnoses'), add);
  projStaging(q('stagingAssessments'), add);
  projMdt(q('mdtCases'), add);
  projCarePlans(q('carePlans'), add);
  projFinance(q('financialCounsellings'), add);
  projConsent(q('consents'), add);
  projReadiness(q('readinessChecks'), add);
  projOrders(q('treatmentOrders'), add);
  projDelays(store.find('delayRecords', d => {
    const o = store.byUuid('treatmentOrders', d.orderUuid);
    return o && o.patientUuid === patientUuid;
  }), add);
  projToxicity(q('toxicityAssessments'), add);
  projResponse(q('responseAssessments'), add);
  projRt(q('rtPrescriptions'), add);
  projSurgery(q('surgicalPlans'), add);
  projSurveillance(q('diagnoses'), q('responseAssessments'), add);

  // administration completion pass needs the collected SYSTEMIC_CYCLE refs
  add.refs = refs;
  projAdministrations(add);
  delete add.refs;

  out.sort((a, b) => String(a.date || '9999-99-99').localeCompare(String(b.date || '9999-99-99')));
  return out;
}

function deriveAll() {
  const patients = store.find('patients', () => true);
  const all = [];
  for (const p of patients) all.push(...deriveForPatient(p.uuid));
  return all;
}

module.exports = { EVENT_STATES, EVENT_TYPES, MODALITY, deriveForPatient, deriveAll };
