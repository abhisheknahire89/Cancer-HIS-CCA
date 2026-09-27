// CCA OS — Clinical services (Phases 1 & 2)
// Registration → Consultation → Investigation → Result → Diagnosis → Staging
// → MDT → Care Plan → Finance → Readiness
'use strict';
const store = require('./store');
const wf = require('./workflow');
const masters = require('./masters');
const providers = require('./staging-providers');
const ajcc = require('./ajcc');
const engine = require('./staging-engine');
const tnm = require('./tnm');
const rbac = require('./rbac');
const consentSvc = require('./consent');

// Service-layer RBAC (canonical §48): enforced at every write entry point so the
// guarantee holds for any caller (HTTP, internal, future FHIR facade).

const { uuid, nowIso, gate, sign, createTask, assertNotSigned } = wf;

function getPatient(uuidOrMrn) {
  return store.findOne('patients', p => p.uuid === uuidOrMrn || p.mrn === uuidOrMrn);
}

// ---- 1.1 Registration / Referral ---------------------------------------
function registerPatient(actor, data) {
  rbac.assertCanWrite(actor, 'registerPatient');
  gate(!data.name || !data.dob || !data.sex, 'Name, date of birth and sex are required');
  gate(!data.hospitalUuid, 'Hospital is required');
  const patient = {
    uuid: uuid(),
    mrn: 'CCA-' + String(store.nextSeq('mrn')).padStart(6, '0'),
    name: data.name,
    dob: data.dob,
    sex: data.sex,
    phone: data.phone || '',
    address: data.address || '',
    hospitalUuid: data.hospitalUuid,
    ecog: null,
    allergies: data.allergies || [],
    registeredAt: nowIso(),
    registeredBy: actor.uuid
  };
  store.insert('patients', patient);

  const referral = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    referralSource: data.referralSource || 'WALK_IN',
    referringFacility: data.referringFacility || '',
    reason: data.reason || '',
    hospitalUuid: data.hospitalUuid,
    status: 'REGISTERED',
    at: nowIso(), by: actor.uuid
  };
  store.insert('referrals', referral);

  // Task engine: intake nurse automatically gets a task
  createTask(actor, 'INTAKE_ASSESSMENT', patient.uuid, { referralUuid: referral.uuid });
  store.audit(actor, 'PATIENT_REGISTERED', 'patient', patient.uuid, patient.mrn);
  return { patient, referral };
}

// ---- 1.2 Structured oncology consultation encounter (directive §1) -------
// A structured encounter — NOT one generic notes textarea. Sections follow the
// directive field list. Status: DRAFT → SIGNED (immutable) → amendments create
// a new version; the signed original is preserved.
const CONSULT_TYPES = ['FIRST_ONCOLOGY', 'RESULTS_REVIEW', 'FOLLOW_UP'];
const DISCUSSION_ACTIONS = ['CONSIDER', 'DISCUSS', 'RECOMMEND', 'PLAN_LATER', 'ORDER_NOW'];

function validateConsultationData(data) {
  gate(!data.consultationType || !CONSULT_TYPES.includes(data.consultationType), 'Consultation type required (FIRST_ONCOLOGY/RESULTS_REVIEW/FOLLOW_UP)');
  gate(data.ecog === undefined || data.ecog === null || data.ecog === '', 'ECOG status is required');
  if (data.karnofsky !== undefined && data.karnofsky !== null && data.karnofsky !== '') {
    const k = Number(data.karnofsky);
    gate(Number.isNaN(k) || k < 0 || k > 100, 'Karnofsky score must be 0–100');
  }
  if (data.painScore !== undefined && data.painScore !== null && data.painScore !== '') {
    const p = Number(data.painScore);
    gate(Number.isNaN(p) || p < 0 || p > 10, 'Pain score must be 0–10');
  }
  if (data.heightCm !== undefined && data.heightCm !== null && data.heightCm !== '') {
    const h = Number(data.heightCm);
    gate(Number.isNaN(h) || h < 30 || h > 260, 'Height must be 30–260 cm');
  }
  if (data.weightKg !== undefined && data.weightKg !== null && data.weightKg !== '') {
    const w = Number(data.weightKg);
    gate(Number.isNaN(w) || w < 1 || w > 400, 'Weight must be 1–400 kg');
  }
  // directive §2: every investigation discussion item carries an explicit action;
  // only ORDER_NOW may generate an InvestigationOrder.
  for (const d of data.investigationDiscussion || []) {
    gate(!d.action || !DISCUSSION_ACTIONS.includes(d.action),
      'Investigation discussion action must be one of ' + DISCUSSION_ACTIONS.join('/'));
  }
}

function recordConsultation(actor, data) {
  rbac.assertCanWrite(actor, 'recordConsultation');
  const patient = getPatient(data.patientUuid);
  gate(!patient, 'Patient not found');
  validateConsultationData(data);
  const prior = store.find('consultations', c => c.patientUuid === patient.uuid);
  const consult = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    consultationType: data.consultationType, // FIRST_ONCOLOGY | RESULTS_REVIEW | FOLLOW_UP
    encounterDatetime: data.encounterDatetime || nowIso(),
    ecog: data.ecog,
    karnofsky: data.karnofsky !== undefined && data.karnofsky !== '' ? Number(data.karnofsky) : null,
    painScore: data.painScore !== undefined && data.painScore !== '' ? Number(data.painScore) : null,
    nutritionalStatus: data.nutritionalStatus || null,
    heightCm: data.heightCm !== undefined && data.heightCm !== '' ? Number(data.heightCm) : null,
    weightKg: data.weightKg !== undefined && data.weightKg !== '' ? Number(data.weightKg) : null,
    bsa: data.bsa !== undefined && data.bsa !== '' ? Number(data.bsa) : (data.heightCm && data.weightKg ? bsaFrom(data.heightCm, data.weightKg) : null),
    reasonForVisit: data.reasonForVisit || '',
    chiefComplaint: data.chiefComplaint || '',
    historyPresentIllness: data.historyPresentIllness || '',
    priorCancerHistory: data.priorCancerHistory || null,   // {priorDiagnosis, priorPathology, priorImaging, priorSurgery, priorRadiotherapy, priorSystemicTherapy, priorLinesOfTherapy}
    comorbidities: data.comorbidities || '',
    currentMedications: data.currentMedications || '',
    allergies: data.allergies || patient.allergies || [],
    previousReactions: data.previousReactions || '',
    smokingHistory: data.smokingHistory || null,           // {status, packYears}
    alcoholHistory: data.alcoholHistory || null,
    familyHistory: data.familyHistory || '',
    physicalExamination: data.physicalExamination || '',
    clinicalAssessment: data.clinicalAssessment || '',
    differentialDiagnosis: data.differentialDiagnosis || '',
    investigationPlan: data.investigationPlan || '',
    followUpPlan: data.followUpPlan || '',
    suspectedCancerType: data.suspectedCancerType || null, // governed dropdown
    investigationDiscussion: (data.investigationDiscussion || []).map(d => ({
      action: d.action, category: d.category || null, testCode: d.testCode || null, notes: d.notes || ''
    })),
    priorConsultUuids: (data.priorConsultUuids || []).concat(prior.map(c => c.uuid)),
    version: 1,
    supersedes: null,
    supersededBy: null,
    status: 'DRAFT',
    at: nowIso(), by: actor.uuid, byName: actor.name,
    signedAt: null
  };
  store.insert('consultations', consult);
  patient.ecog = data.ecog;
  if (consult.heightCm && consult.weightKg) { patient.heightCm = consult.heightCm; patient.weightKg = consult.weightKg; patient.bsa = consult.bsa; }
  store.audit(actor, 'CONSULT_DRAFTED', 'consultation', consult.uuid, patient.mrn + ' v' + consult.version);
  return consult;
}

function bsaFrom(heightCm, weightKg) {
  // Mosteller: sqrt(h(cm) × w(kg) / 3600), rounded to 2 dp
  return Math.round(Math.sqrt((Number(heightCm) * Number(weightKg)) / 3600) * 100) / 100;
}

// Sign a consultation encounter (directive §1: DRAFT → SIGNED; immutable once
// signed). ORDER_NOW discussion items become InvestigationOrders exactly at this
// point — discussion alone never orders (directive §2).
function signConsultation(actor, consultUuid) {
  rbac.assertCanWrite(actor, 'recordConsultation');
  const consult = store.byUuid('consultations', consultUuid);
  gate(!consult, 'Consultation not found');
  gate(consult.status === 'SIGNED', 'Consultation already signed');
  const patient = store.byUuid('patients', consult.patientUuid);
  const ordered = [];
  for (const d of consult.investigationDiscussion || []) {
    if (d.action !== 'ORDER_NOW') continue;
    const o = orderInvestigation(actor, {
      patientUuid: consult.patientUuid, category: d.category, testCode: d.testCode, notes: d.notes,
      fromConsultUuid: consult.uuid
    }, { internal: true });
    ordered.push(o.uuid);
  }
  consult.orderUuids = ordered;
  consult.status = 'SIGNED';
  consult.signedAt = nowIso();
  consult.signedBy = actor.uuid;
  consult.signedByName = actor.name;
  consult.signature = sign(actor, 'consultation', consult.uuid, (consult.consultationType || 'CONSULT') + ' v' + consult.version);
  store.update('consultations', consult.uuid, consult);
  if (consult.consultationType === 'FIRST_ONCOLOGY') {
    // §49 handoff: the MO's own signed consultation completes the intake nurse's
    // FIRST_CONSULT task instead of minting a duplicate ghost task.
    if (actor.role === 'Medical Oncologist') {
      wf.completeOpenTasks(actor, consult.patientUuid, t => t.code === 'FIRST_CONSULT', 'first oncology consultation signed');
    } else if (!wf.tasksForPatient(consult.patientUuid).some(t => t.code === 'FIRST_CONSULT' && t.status === 'OPEN')) {
      createTask(actor, 'FIRST_CONSULT', consult.patientUuid, { consultUuid: consult.uuid });
    }
  }
  if (consult.consultationType === 'RESULTS_REVIEW') {
    // results-review encounter recorded: complete the review task it came from
    wf.completeOpenTasks(actor, consult.patientUuid, t => t.code === 'REVIEW_RESULTS', 'results-review consultation signed');
  }
  if (!ordered.length && consult.consultationType !== 'RESULTS_REVIEW') {
    createTask(actor, 'CONFIRM_DIAGNOSIS', consult.patientUuid, { consultUuid: consult.uuid });
  }
  store.audit(actor, 'CONSULT_SIGNED', 'consultation', consult.uuid, patient.mrn + ' v' + consult.version + ' orders=' + ordered.length);
  return consult;
}

// Amend a signed consultation (directive §1: signed is immutable; corrections
// create a superseding version preserving history).
function amendConsultation(actor, consultUuid, data) {
  rbac.assertCanWrite(actor, 'recordConsultation');
  const prev = store.byUuid('consultations', consultUuid);
  gate(!prev, 'Consultation not found');
  gate(prev.status !== 'SIGNED', 'Only a signed consultation can be amended');
  gate(!data.amendmentReason, 'amendmentReason is required for the audit trail');
  validateConsultationData(Object.assign({}, prev, data));
  const merged = Object.assign({}, prev, data, {
    uuid: uuid(),
    version: (prev.version || 1) + 1,
    supersedes: prev.uuid,
    status: 'AMENDED',
    at: nowIso(), by: actor.uuid, byName: actor.name,
    signedAt: null, signedBy: null, signedByName: null, signature: null,
    orderUuids: []
  });
  merged.amendmentReason = data.amendmentReason;
  store.insert('consultations', merged);
  store.update('consultations', prev.uuid, { supersededBy: merged.uuid, status: 'AMENDED' });
  store.audit(actor, 'CONSULT_AMENDED', 'consultation', merged.uuid, 'v' + merged.version + ' supersedes v' + (prev.version || 1) + ' — ' + data.amendmentReason);
  return merged;
}

// ---- 1.3 Investigation orders (directive §3: master-driven order object) --
// Orders carry master-test identity + terminology (code/system/version) so doctors
// never retype "PET CT / PETCT / pet scan" as unrelated strings.
const ORDER_CATEGORIES = ['LAB', 'RADIOLOGY', 'PATHOLOGY', 'MOLECULAR', 'GENETIC', 'PROCEDURE', 'OTHER'];
const ORDER_STATUSES = ['DRAFT', 'SIGNED', 'SCHEDULED', 'COLLECTED', 'ACQUIRED', 'IN_PROGRESS', 'RESULT_AVAILABLE', 'REVIEWED', 'CANCELLED'];
const ORDER_PRIORITIES = ['ROUTINE', 'URGENT', 'STAT'];
function deptRoleForCategory(category) {
  switch (category) {
    case 'LAB': return 'Lab';
    case 'RADIOLOGY': return 'Radiologist';
    case 'PATHOLOGY': case 'MOLECULAR': case 'GENETIC': return 'Pathologist';
    default: return 'Lab';
  }
}
function orderTaskForCategory(category) {
  switch (category) {
    case 'LAB': return 'PERFORM_LAB';
    case 'RADIOLOGY': return 'PERFORM_IMAGING';
    case 'PATHOLOGY': case 'MOLECULAR': case 'GENETIC': return 'PERFORM_PATHOLOGY';
    default: return 'PERFORM_LAB';
  }
}
function orderInvestigation(actor, data, opts) {
  if (!(opts && opts.internal)) rbac.assertCanWrite(actor, 'orderInvestigation');
  const patient = getPatient(data.patientUuid);
  gate(!patient, 'Patient not found');
  gate(!ORDER_CATEGORIES.includes(data.category), 'Category must be one of ' + ORDER_CATEGORIES.join('/'));
  gate(!ORDER_PRIORITIES.includes(data.priority || 'ROUTINE'), 'Priority must be ROUTINE/URGENT/STAT');
  // Master-test resolution: testCode is the governed identity (directive §3)
  let mt = null;
  gate(!data.testCode, 'testCode (master diagnosticTest code) is required — free-text test names are not accepted');
  mt = masters.getByCode('diagnosticTest', data.testCode);
  gate(!mt || mt.active === false, 'Unknown governed diagnostic test: ' + data.testCode);
  gate(mt.category !== data.category, 'Test ' + data.testCode + ' belongs to category ' + mt.category + ', not ' + data.category);
  if (data.requestedDate) gate(new Date(data.requestedDate) < new Date(new Date().toDateString()), 'requestedDate cannot be in the past');
  const order = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    episodeUuid: data.episodeUuid || (store.find('episodes', e => e.patientUuid === patient.uuid && e.status === 'ACTIVE')[0] || {}).uuid || null,
    fromConsultUuid: data.fromConsultUuid || null,
    category: data.category,
    testCode: mt.code,
    displayName: mt.label,
    testCodeValue: mt.testCode || null,
    terminology: mt.terminology || null,       // {system, version} — LOINC / SNOMED CT
    specimenType: data.specimenType || mt.specimenType || null,
    bodySite: data.bodySite || null,
    clinicalIndication: data.clinicalIndication || data.notes || '',
    priority: data.priority || 'ROUTINE',
    requestedDate: data.requestedDate || null,
    scheduledDate: data.scheduledDate || null,
    performingDepartment: deptRoleForCategory(data.category),
    notes: data.notes || '',
    operativeRecordUuid: data.operativeRecordUuid || null,  // specimen orders: links the result to the surgery for restaging
    orderedBy: actor.uuid, orderedByName: actor.name,
    orderedAt: nowIso(),
    status: 'SIGNED', // ordered-by-doctor = signed (DRAFT only for pre-sign drafts)
    signedAt: nowIso(), signedBy: actor.uuid
  };
  store.insert('investigationOrders', order);
  createTask(actor, orderTaskForCategory(order.category), patient.uuid, { orderUuid: order.uuid });
  store.audit(actor, 'INVESTIGATION_ORDERED', 'investigationOrder', order.uuid, order.category + ': ' + order.displayName + ' (' + order.priority + ')');
  return order;
}

// Directive §3 status chain: SCHEDULED → COLLECTED/ACQUIRED → IN_PROGRESS → RESULT_AVAILABLE → REVIEWED
function advanceOrderStatus(actor, orderUuid, newStatus) {
  rbac.assertCanWrite(actor, 'orderInvestigation');
  const o = store.byUuid('investigationOrders', orderUuid);
  gate(!o, 'Investigation order not found');
  gate(!ORDER_STATUSES.includes(newStatus), 'Unknown order status: ' + newStatus);
  const flow = { SIGNED: ['SCHEDULED', 'CANCELLED'], SCHEDULED: ['COLLECTED', 'ACQUIRED', 'IN_PROGRESS', 'CANCELLED'], COLLECTED: ['IN_PROGRESS', 'RESULT_AVAILABLE'], ACQUIRED: ['IN_PROGRESS', 'RESULT_AVAILABLE'], IN_PROGRESS: ['RESULT_AVAILABLE', 'CANCELLED'], RESULT_AVAILABLE: ['REVIEWED'] };
  const allowed = flow[o.status] || [];
  gate(!allowed.includes(newStatus), 'Illegal order status transition ' + o.status + ' → ' + newStatus);
  store.update('investigationOrders', o.uuid, { status: newStatus });
  store.audit(actor, 'ORDER_STATUS_' + newStatus, 'investigationOrder', o.uuid, o.displayName + ': ' + o.status + ' → ' + newStatus);
  return store.byUuid('investigationOrders', orderUuid);
}

// ---- 1.4 Diagnostic results (directive §5) --------------------------------
const RESULT_STATUSES = ['PRELIMINARY', 'FINAL', 'AMENDED', 'CORRECTED'];
function recordResult(actor, data) {
  rbac.assertCanWrite(actor, 'recordResult');
  const patient = getPatient(data.patientUuid);
  gate(!patient, 'Patient not found');
  const order = store.byUuid('investigationOrders', data.orderUuid);
  gate(!order, 'Investigation order not found');
  gate(order.patientUuid !== patient.uuid, "RESULT_NOT_FOR_PATIENT: order does not belong to this patient");
  gate(!['SIGNED', 'SCHEDULED', 'COLLECTED', 'ACQUIRED', 'IN_PROGRESS'].includes(order.status), 'Order already resulted or cancelled');
  gate(!data.summary, 'Result summary required');
  gate(data.resultStatus && !RESULT_STATUSES.includes(data.resultStatus), 'resultStatus must be PRELIMINARY/FINAL/AMENDED/CORRECTED');
  if (data.collectionDate) gate(new Date(data.collectionDate) > new Date(), 'collectionDate cannot be in the future');
  if (data.reportDate) gate(new Date(data.reportDate) > new Date(), 'reportDate cannot be in the future');
  const preliminary = data.resultStatus === 'PRELIMINARY';
  const result = {
    uuid: uuid(),
    orderUuid: order.uuid,
    patientUuid: patient.uuid,
    episodeUuid: order.episodeUuid || null,
    category: order.category,
    testCode: order.testCode,
    test: order.displayName,
    resultType: data.resultType || order.category,          // LAB | RADIOLOGY | PATHOLOGY | MOLECULAR | GENETIC | PROCEDURE
    summary: data.summary,
    findings: data.findings || {},
    structuredValues: data.structuredValues || [],          // [{code, value, unit}] from master catalogue
    accessionNumber: data.accessionNumber || null,
    specimenId: data.specimenId || null,
    imagingStudyId: data.imagingStudyId || null,
    specimenSite: data.specimenSite || data.bodySite || null,
    biomarkers: data.biomarkers || [],   // [{code, value}]
    histologyCode: data.histologyCode || null,
    morphologyCode: data.morphologyCode || null,
    collectionDate: data.collectionDate || null,
    acquisitionDate: data.acquisitionDate || null,
    reportDate: data.reportDate || nowIso(),
    finalizationDate: null,
    sourceSystem: data.sourceSystem || 'CCA-OS',
    sourceFacility: data.sourceFacility || null,
    performingDepartment: order.performingDepartment,
    reportingClinician: actor.uuid, reportingClinicianName: actor.name,
    at: nowIso(), by: actor.uuid, byName: actor.name,
    resultStatus: preliminary ? 'PRELIMINARY' : 'FINAL',
    reviewStatus: 'UNREVIEWED',
    reviewedBy: null, reviewedAt: null,
    finalizedAt: null,
    supersedesResultUuid: data.supersedesResultUuid || null
  };
  if (preliminary) {
    store.insert('results', result);
    store.audit(actor, 'RESULT_PRELIMINARY', 'result', result.uuid, order.displayName);
    return result;
  }
  store.insert('results', result);
  assertNotSigned('result', result);
  result.status = 'FINALIZED';
  result.finalizationDate = nowIso();
  result.finalizedAt = nowIso();
  result.signedAt = nowIso();
  store.update('results', result.uuid, result);
  store.update('investigationOrders', order.uuid, { status: 'RESULT_AVAILABLE' });
  sign(actor, 'result', result.uuid, order.displayName);

  // Task engine: treating oncologist gets review task (directive §5)
  createTask(actor, 'REVIEW_RESULTS', patient.uuid, { resultUuid: result.uuid });
  store.audit(actor, 'RESULT_FINALIZED', 'result', result.uuid, order.displayName);
  maybeCreatePathologicalRestaging(actor, patient.uuid, order, result);
  return result;
}

// Slice E: after an operative record is SIGNED and its specimen histopathology
// is FINAL, determine staging eligibility and emit the pathological-staging task.
// Classification follows the real treatment history (§45/§46):
//   - prior posttherapy-clinical staging, delivered systemic administration or
//     delivered RT fraction before the operation → POSTTHERAPY_PATHOLOGICAL (yp)
//   - otherwise (upfront surgery)               → PATHOLOGICAL (p)
// Prior signed assessments are never overwritten: a NEW assessment context is
// opened and the clinician enters pT/pN/pM from the pathology evidence. Every
// finalization path funnels here (recordResult, amendResult, and the
// signOperativeRecord catch-up in treatment.js); the flag makes it idempotent.
function maybeCreatePathologicalRestaging(actor, patientUuid, order, result) {
  if (!order || !order.operativeRecordUuid || !result) return;
  if (!(order.category === 'PATHOLOGY' || result.resultType === 'PATHOLOGY')) return;
  const rec = store.byUuid('operativeRecords', order.operativeRecordUuid);
  if (!rec || rec.status !== 'SIGNED') return;   // open record: signOperativeRecord catches up
  if (rec.pathologicalStagingTriggered) return;  // idempotent per operative record
  const opDate = rec.performedDate || (rec.signedAt || '').slice(0, 10);
  const priorStaging = store.find('stagingAssessments', s => s.patientUuid === patientUuid && s.status === 'SIGNED');
  const posttherapyStaging = priorStaging.some(s => s.stagingContext === 'POSTTHERAPY_CLINICAL');
  const deliveredSystemic = store.find('administrationRecords', a => a.patientUuid === patientUuid)
    .some(a => (a.actualStart || a.createdAt || '').slice(0, 10) && opDate && (a.actualStart || a.createdAt).slice(0, 10) <= opDate);
  const deliveredRt = store.find('rtFractions', f => f.patientUuid === patientUuid)
    .some(f => opDate && (f.deliveredDate || '').slice(0, 10) <= opDate);
  const neoadjuvant = posttherapyStaging || deliveredSystemic || deliveredRt;
  const classification = neoadjuvant ? 'POSTTHERAPY_PATHOLOGICAL' : 'PATHOLOGICAL';
  // one live restaging task per operative record
  const existing = wf.tasksForPatient(patientUuid).find(t => t.code === 'PATHOLOGICAL_STAGING' && t.payload && t.payload.operativeRecordUuid === order.operativeRecordUuid && t.status === 'OPEN');
  if (existing) return;
  createTask(actor, 'PATHOLOGICAL_STAGING', patientUuid, {
    operativeRecordUuid: order.operativeRecordUuid, resultUuid: result.uuid, classification,
    prefix: classification === 'POSTTHERAPY_PATHOLOGICAL' ? 'yp' : 'p',
    reason: neoadjuvant ? 'surgery after neoadjuvant therapy' : 'upfront surgery — final histopathology available'
  });
  rec.pathologicalStagingTriggered = true;
  store.update('operativeRecords', rec.uuid, rec);
  store.audit(actor, 'PATHOLOGICAL_STAGING_DUE', 'operativeRecord', rec.uuid, classification + ' restaging task created from finalized histopathology');
}

// Amend/correct a FINAL result (directive §5): the original is never overwritten;
// the amended version references its predecessor.
function amendResult(actor, resultUuid, data) {
  rbac.assertCanWrite(actor, 'recordResult');
  const prev = store.byUuid('results', resultUuid);
  gate(!prev, 'Result not found');
  gate(!['FINAL', 'AMENDED', 'CORRECTED'].includes(prev.resultStatus), 'Only a FINAL result can be amended or corrected');
  gate(!data.summary, 'Amended result summary required');
  const kind = data.correctionKind === 'CORRECTED' ? 'CORRECTED' : 'AMENDED';
  const result = Object.assign({}, prev, {
    uuid: uuid(),
    summary: data.summary,
    findings: data.findings || prev.findings,
    structuredValues: data.structuredValues || prev.structuredValues,
    resultStatus: kind,
    supersedesResultUuid: prev.uuid,
    at: nowIso(), by: actor.uuid, byName: actor.name,
    finalizedAt: null, finalizationDate: null, signedAt: null
  });
  store.insert('results', result);
  store.update('results', prev.uuid, { supersededByResultUuid: result.uuid, status: 'SUPERSEDED' });
  result.status = 'FINALIZED';
  result.finalizedAt = nowIso();
  result.finalizationDate = nowIso();
  result.signedAt = nowIso();
  store.update('results', result.uuid, result);
  sign(actor, 'result', result.uuid, prev.test + ' (' + kind + ')');
  createTask(actor, 'REVIEW_RESULTS', result.patientUuid, { resultUuid: result.uuid });
  store.audit(actor, 'RESULT_' + kind, 'result', result.uuid, prev.test);
  // an amended/corrected specimen histopathology also completes the restaging trigger
  maybeCreatePathologicalRestaging(actor, result.patientUuid, amendedOrder, result);
  return result;
}

// Oncologist review of a finalized result (directive §5 reviewed_status)
function reviewResult(actor, resultUuid, data) {
  rbac.assertCanWrite(actor, 'createResultsReview');
  const r = store.byUuid('results', resultUuid);
  gate(!r, 'Result not found');
  gate(r.resultStatus === 'PRELIMINARY', 'Only FINAL results can be reviewed');
  gate(r.reviewStatus === 'REVIEWED', 'Result already reviewed');
  store.update('results', r.uuid, { reviewStatus: 'REVIEWED', reviewedBy: actor.uuid, reviewedByName: actor.name, reviewedAt: nowIso(), reviewNotes: (data && data.notes) || '' });
  store.update('investigationOrders', r.orderUuid, { status: 'REVIEWED' });
  wf.completeOpenTasks(actor, r.patientUuid, t => t.code === 'REVIEW_RESULTS' && t.payload && t.payload.resultUuid === r.uuid, 'result reviewed');
  store.audit(actor, 'RESULT_REVIEWED', 'result', r.uuid, r.test);
  return store.byUuid('results', resultUuid);
}

// ---- 1.5 Cancer diagnosis (signed; NO T/N/M fields — directive §9) --------
const DIAGNOSIS_FIELDS = ['cancerFamily', 'cancerType', 'primarySite', 'subsite', 'laterality', 'histology', 'morphology', 'grade', 'icd10', 'icdOtopography', 'icdOmorphology', 'diagnosisDate', 'diagnosisBasis'];
const LATERALITY = ['LEFT', 'RIGHT', 'BILATERAL', 'MIDLINE', 'N_A'];
const DIAG_BASIS = ['PATHOLOGY', 'CYTOLOGY', 'BONE_MARROW', 'MOLECULAR', 'CLINICAL', 'IMAGING', 'OTHER'];
const DIAG_CERTAINTY = ['CLINICAL_ONLY', 'CLINICAL_INVESTIGATIVE', 'MICROSCOPIC_CONFIRMED', 'MICROSCOPIC_CONFIRMED_METASTATIC', 'BIOCHEMICAL_ANDOR_INVESTIGATIVE', 'CYTOLOGICAL_CONFIRMED'];
const DIAGNOSIS_STATUS = ['SUSPECTED', 'PROVISIONAL', 'CONFIRMED', 'REVISED', 'SUPERSEDED'];

// Master cascade (directive §8): family → site → histology. A family implies a
// default site; a site/histology pair must be anatomically coherent.
function validateDiagnosisFields(data) {
  if (data.cancerFamily) {
    const fam = masters.getByCode('cancerFamily', data.cancerFamily);
    gate(!fam, 'Unknown governed value cancerFamily=' + data.cancerFamily);
    if (data.primarySite && fam.site !== 'OTHER') {
      gate(fam.site !== data.primarySite, 'Cancer family ' + data.cancerFamily + ' does not correspond to primary site ' + data.primarySite);
    }
  }
  gate(!data.cancerType, 'cancerType is required');
  gate(!masters.getByCode('cancerType', data.cancerType), 'Unknown governed value cancerType=' + data.cancerType);
  gate(!data.primarySite, 'primarySite is required');
  gate(!masters.getByCode('primarySite', data.primarySite), 'Unknown governed value primarySite=' + data.primarySite);
  if (data.subsite) {
    const sub = masters.getByCode('subsite', data.subsite);
    gate(!sub, 'Unknown governed value subsite=' + data.subsite);
    gate(sub.parent !== data.primarySite, 'subsite ' + data.subsite + ' does not belong to primarySite ' + data.primarySite);
  }
  gate(!data.histology || !masters.getByCode('histology', data.histology), 'Unknown governed value histology=' + data.histology);
  // anatomical coherence (cascade §8): lung primaries are carcinoma classes, not lymphoma/leukaemia etc.
  const SOLID_CARCINOMA_SITES = ['BREAST', 'LUNG', 'COLON', 'RECTUM', 'PROSTATE', 'ORAL_CAVITY', 'OROPHARYNX', 'LARYNX', 'NASOPHARYNX', 'CERVIX', 'ENDOMETRIUM', 'OVARY', 'STOMACH', 'PANCREAS', 'SALIVARY_GLAND', 'THYMUS', 'PLEURA', 'ANUS', 'APPENDIX', 'VULVA', 'FALLOPIAN', 'OTHER_SOLID'];
  if (data.primarySite && data.histology && SOLID_CARCINOMA_SITES.includes(data.primarySite)) {
    gate(['DLBCL', 'NODULAR_SCLEROSIS', 'AML_NOS', 'B_ALL', 'PLASMA_CELL'].includes(data.histology), 'Histology ' + data.histology + ' is not anatomically coherent with primary site ' + data.primarySite);
  }
  if (data.morphology) gate(!masters.getByCode('morphology', data.morphology), 'Unknown governed value morphology=' + data.morphology);
  if (data.behaviour) gate(!masters.getByCode('behaviour', data.behaviour), 'Unknown governed value behaviour=' + data.behaviour);
  if (data.grade) gate(!masters.getByCode('grade', data.grade), 'Unknown governed value grade=' + data.grade);
  if (data.differentiation) gate(!['WELL', 'MODERATE', 'POOR', 'UNDIFFERENTIATED'].includes(data.differentiation), 'Invalid differentiation');
  if (data.icd10) gate(!masters.getByCode('icd10', data.icd10), 'Unknown governed value icd10=' + data.icd10);
  if (data.icdOtopography) gate(!masters.getByCode('icdOtopography', data.icdOtopography), 'Unknown governed icdOtopography=' + data.icdOtopography);
  if (data.icdOmorphology) gate(!masters.getByCode('icdOmorphology', data.icdOmorphology), 'Unknown governed icdOmorphology=' + data.icdOmorphology);
  if (data.icdOVersion) gate(!masters.icdOVersionValid(data.icdOVersion), 'Unknown governed icdOVersion=' + data.icdOVersion);
  gate(!data.diagnosisDate, 'diagnosisDate is required');
  gate(new Date(data.diagnosisDate) > new Date(), 'diagnosisDate cannot be in the future');
  gate(!data.diagnosisBasis || !DIAG_BASIS.includes(data.diagnosisBasis), 'diagnosisBasis must be one of ' + DIAG_BASIS.join('/'));
  if (data.diagnosticCertainty) gate(!DIAG_CERTAINTY.includes(data.diagnosticCertainty), 'diagnosticCertainty must be one of ' + DIAG_CERTAINTY.join('/'));
  if (data.primaryOrSecondary) gate(!['PRIMARY', 'METASTATIC', 'RECURRENCE', 'NEW_PRIMARY', 'UNKNOWN'].includes(data.primaryOrSecondary), 'Invalid primaryOrSecondary');
  if (data.laterality) gate(!LATERALITY.includes(data.laterality), 'Invalid laterality');
  // T/N/M must NOT be inside diagnosis (mandate)
  for (const forbidden of ['t', 'n', 'm', 'tnm', 'T', 'N', 'M', 'stageGroup', 'stage_group']) {
    gate(Object.prototype.hasOwnProperty.call(data, forbidden), 'T/N/M/stage fields are not allowed in a diagnosis (staging is a separate object)');
  }
}

function recordDiagnosis(actor, data) {
  rbac.assertCanWrite(actor, 'recordDiagnosis');
  const patient = getPatient(data.patientUuid);
  gate(!patient, 'Patient not found');
  validateDiagnosisFields(data);

  let episode = store.find('episodes', e => e.patientUuid === patient.uuid && e.status === 'ACTIVE')[0];
  if (!episode) {
    episode = { uuid: uuid(), patientUuid: patient.uuid, status: 'ACTIVE', openedAt: nowIso() };
    store.insert('episodes', episode);
  }

  const evidence = (data.evidence || []).map(e => ({ resultUuid: e.resultUuid, type: e.type || 'PATHOLOGICAL' }));
  const dx = {
    uuid: uuid(),
    episodeUuid: episode.uuid,
    patientUuid: patient.uuid,
    status: 'DRAFT',
    version: 1,
    supersedes: null,
    supersededBy: null,
    primaryOrSecondary: data.primaryOrSecondary || 'PRIMARY',
    cancerFamily: data.cancerFamily || null,
    cancerType: data.cancerType,
    primarySite: data.primarySite,
    subsite: data.subsite || null,
    laterality: data.laterality || null,
    histology: data.histology,
    morphology: data.morphology || null,
    behaviour: data.behaviour || null,
    grade: data.grade || null,
    differentiation: data.differentiation || null,
    diagnosisDate: data.diagnosisDate,
    diagnosticCertainty: data.diagnosticCertainty || (data.diagnosisBasis === 'PATHOLOGY' ? 'MICROSCOPIC_CONFIRMED' : 'CLINICAL_INVESTIGATIVE'),
    snomedCode: data.snomedCode || null,          // {code, display, version} — code+system+version stored, not just display
    icd10: data.icd10 || null,
    icdOVersion: data.icdOVersion || 'ICD-O-3.2',
    icdOtopography: data.icdOtopography || null,
    icdOmorphology: data.icdOmorphology || null,
    icdOMapping: data.icdOMapping || null,
    diagnosisBasis: data.diagnosisBasis,
    evidence,
    primaryPathologyResultId: (evidence.find(e => e.type === 'PATHOLOGICAL') || {}).resultUuid || null,
    biomarkers: (data.biomarkers || []).map(b => ({ code: b.code, value: b.value, sourceResultUuid: b.sourceResultUuid || null })),
    confirmingOncologist: actor.uuid,
    confirmingOncologistName: actor.name,
    notes: data.notes || '',
    createdAt: nowIso(),
    signedAt: null
  };
  store.insert('diagnoses', dx);
  return dx;
}

function signDiagnosis(actor, dxUuid) {
  rbac.assertCanWrite(actor, 'signDiagnosis');
  const dx = store.byUuid('diagnoses', dxUuid);
  gate(!dx, 'Diagnosis not found');
  assertNotSigned('diagnosis', dx);
  // evidence must belong to same patient (stop-gate)
  for (const ev of dx.evidence || []) {
    const r = store.byUuid('results', ev.resultUuid);
    gate(!r, 'Evidence result not found: ' + ev.resultUuid);
    gate(r.patientUuid !== dx.patientUuid, "CROSS_PATIENT_EVIDENCE: evidence " + ev.resultUuid + " belongs to another patient");
  }
  dx.status = 'CONFIRMED';
  dx.confirmedAt = nowIso();
  dx.signedAt = nowIso();
  dx.signature = sign(actor, 'diagnosis', dx.uuid, masters.label('cancerType', dx.cancerType) + ' (' + dx.icdOVersion + ')');
  store.update('diagnoses', dx.uuid, dx);
  store.audit(actor, 'DIAGNOSIS_SIGNED', 'diagnosis', dx.uuid, masters.label('cancerType', dx.cancerType));

  // Signed record supersedes its open tasks (§49): the diagnosis now exists, so the
  // CONFIRM_DIAGNOSIS tasks that asked for it are fulfilled — no stale re-entry points.
  wf.completeOpenTasks(actor, dx.patientUuid, t => t.code === 'CONFIRM_DIAGNOSIS', 'diagnosis signed');

  // Task engine: diagnosis confirmed → staging (directive §9)
  createTask(actor, 'CREATE_STAGING', dx.patientUuid, { diagnosisUuid: dx.uuid });
  return dx;
}

// ---- 1.6 Staging (separate signed object; supersedes, never overwrites) --
// Directive §16: the SERVER resolves authority + schema + effective version from
// the diagnosis (site/histology/morphology/behaviour/date). The clinician never
// picks a pack. Without licensed content the resolver still routes versions from
// public AJCC metadata and the provider reports AUTHORITY_CONTENT_UNAVAILABLE.
function stagingSchemaFor(diagnosisUuid) {
  const dx = store.byUuid('diagnoses', diagnosisUuid);
  gate(!dx, 'Diagnosis not found');
  const legacy = providers.resolveProvider(dx);           // field-schema provider (neutral skeleton)
  const schema = legacy.provider.resolveSchema(dx);
  const route = ajcc.resolve_staging_schema(dx, legacy.key); // authority/version routing (public metadata)
  // Automatic-derivation availability (staging mandate §3/§7): a pack exists only
  // where permitted content is connected. AJCC packs arrive exclusively via the
  // licensed provider; until then TNM diseases report CONTENT_PROVIDER_UNAVAILABLE
  // and governed clinician-recorded categories remain the valid fallback.
  const pack = engine.packFor(legacy.key, route.schemaId);
  return {
    providerKey: legacy.key,
    authority: route.authority,
    schemaId: route.schemaId,
    schemaName: route.schemaName,
    version: route.version,
    versionRaw: route.versionRaw,
    effectiveFrom: route.effectiveFrom,
    sourceReference: route.sourceReference,
    provider: route.provider,
    contentStatus: route.contentStatus,
    licensedContentAvailable: !!route.licensedContentAvailable,
    notice: route.contentStatus === 'AUTHORITY_CONTENT_UNAVAILABLE' ? 'AJCC authoritative content provider not configured. Staging workflow is available, but governed AJCC category definitions and stage calculation require licensed AJCC content.' : null,
    availableContexts: route.availableContexts,
    contexts: schema.contexts,
    fields: schema.fields,
    inputSchema: { fields: schema.fields },
    // §17 context-aware engine availability: the engine substitutes hand-picking
    // ONLY for classifications the connected pack actually covers — other contexts
    // keep the governed clinician-recorded categories.
    engine: pack ? { status: 'AVAILABLE', packId: pack.packId, provenance: pack.provenance, resultFields: engine.resultFields(pack), classifications: pack.classifications } : { status: 'CONTENT_PROVIDER_UNAVAILABLE' }
  };
}

// Directive §26: the resolved schema+version snapshot becomes part of the record
// and is LOCKED at sign time — sign-time re-resolution must match the stored one.
function resolvedSnapshotFor(dx) {
  const legacy = providers.resolveProvider(dx);
  const route = ajcc.resolve_staging_schema(dx, legacy.key);
  return { authority: route.authority, schemaId: route.schemaId, version: route.versionRaw, effectiveFrom: route.effectiveFrom };
}

// Sign-time validation shared by BOTH staging service entries (clinical.* and
// clinical-flow.*) so the stop-gates hold for every caller (directive §26/§39).
function applyStagingSignGates(a, dx) {
  const { key, provider } = providers.resolveProvider(dx);

  // STOP-GATE 0: the locked schema snapshot must still match a fresh resolution
  const nowResolved = resolvedSnapshotFor(dx);
  gate(nowResolved.schemaId !== a.schemaId || nowResolved.version !== a.authorityVersion,
    'STOP_GATE: resolved staging schema/version changed since this assessment was drafted — re-resolve before signing');

  // STOP-GATE 1: unknown governed fields rejected FIRST (schema mismatch, e.g. TNM on
  // a haematological disease, must report the schema mismatch — not a required-field error)
  const schema = provider.resolveSchema(dx);
  for (const known of Object.keys(a.variables)) {
    const f = schema.fields.find(x => x.key === known);
    gate(!f, 'STOP_GATE: unknown staging field "' + known + '" for schema ' + key);
  }

  // STOP-GATE 2: required fields / allowed values / fabricated stage
  const validation = provider.validateAssessment(a);
  gate(!validation.ok, 'STOP_GATE: staging validation failed — ' + validation.errors.join('; '));

  // Generic TNM engine gates (mandate §7/§9/§13): classification enum, MX impossible,
  // pM0 impossible, pM1 evidence requirement, staging-window check.
  const tnmErrors = tnm.validateTnmAssessment(a, provider);
  gate(tnmErrors.length, 'STOP_GATE: ' + tnmErrors.join('; '));

  // AUTOMATIC DERIVATION (staging mandate §11–§15): the deterministic engine —
  // not the frontend, not the clinician — derives categories/stage when a content
  // pack is connected; the clinician confirms or signs, never hand-edits the result.
  // Server-side, so the browser can display a live preview but never own the logic.
  if (a.resultSource === 'AUTOMATIC_ENGINE') {
    const derivation = engine.evaluate(schema.fields, engine.packFor(key, a.schemaId), { classification: a.stagingContext, variables: a.variables });
    gate(derivation.status !== 'CALCULATED', 'STOP_GATE: automatic derivation not available — ' + derivation.status +
      (derivation.invalid ? ' (' + derivation.invalid.join('; ') + ')' : '') +
      (derivation.missing ? ' (missing: ' + derivation.missing.join('; ') + ')' : ''));
    gate(a.variables.stageResult && derivation.result !== a.variables.stageResult,
      'STOP_GATE: signed stage must match the engine-derived result (' + derivation.result + ')');
    a.derivationTrace = derivation;   // §27 machine-readable trace, stored with the record
    a.stageResult = derivation.result;          // engine-derived result IS the record's result
    a.resultLabel = derivation.resultLabel || derivation.result;
    if (derivation.prognosticStage) a.prognosticStageGroup = derivation.prognosticStage; // §22: kept separate
  }

  // STOP-GATE 3: evidence provenance — every governed fact (T/N/M) must cite
  // evidence: a linked same-patient source result or an explicit supporting finding
  // Evidence-type vocabulary: mandate §16 names (PATHOLOGY/RADIOLOGY/LABORATORY …)
  // are normalized to the canonical source vocabulary so both spellings validate.
  const SOURCE_SYNONYMS = { PATHOLOGY: 'PATHOLOGICAL', RADIOLOGY: 'RADIOLOGICAL', LAB: 'LABORATORY', LABORATORY: 'LABORATORY', EXTERNAL_RECORD: 'EXTERNAL_DOCUMENT' };
  for (const ev of a.evidence || []) {
    if (ev && SOURCE_SYNONYMS[ev.sourceType]) ev.sourceType = SOURCE_SYNONYMS[ev.sourceType];
    gate(!providers.SOURCE_TYPES.includes(ev.sourceType), 'Invalid evidence sourceType');
    if (ev.variableKey) {
      const factField = schema.fields.find(x => x.key === ev.variableKey);
      gate(!factField, 'STOP_GATE: evidence cites unknown staging field "' + ev.variableKey + '"');
    }
    if (ev.sourceRef) {
      // The evidence picker offers finalized results, signed consultations and signed
      // operative records (§19: clinical examination and operative findings are valid
      // staging evidence) — the validator must accept exactly what the picker offers.
      const r = store.byUuid('results', ev.sourceRef);
      const c = r ? null : store.byUuid('consultations', ev.sourceRef);
      const o = (!r && !c) ? store.byUuid('operativeRecords', ev.sourceRef) : null;
      const src = r || (c && c.status === 'SIGNED' ? c : null) || (o && o.status === 'SIGNED' ? o : null);
      gate(!src, 'Evidence source not found: ' + ev.sourceRef);
      gate(src.patientUuid !== a.patientUuid, 'CROSS_PATIENT_EVIDENCE: staging evidence belongs to another patient');
    } else if (!ev.supportingFinding) {
      gate(true, 'STOP_GATE: evidence row for ' + (ev.variableKey || 'unknown field') + ' must cite a source result or a supporting finding');
    }
  }
  const covered = new Set((a.evidence || [])
    .filter(e => e.variableKey && (e.sourceRef || (e.supportingFinding || '').trim()))
    .map(e => e.variableKey));
  for (const f of schema.fields) {
    if (['t', 'n', 'm'].includes(f.key) && a.variables[f.key] && !covered.has(f.key)) {
      gate(true, 'STOP_GATE: required evidence missing for ' + f.key + ' — each staging fact must cite its source (directive §20)');
    }
  }
  // supersedes: same patient only (directive §39)
  if (a.supersedes) {
    const prev = store.byUuid('stagingAssessments', a.supersedes);
    gate(!prev, 'Superseded assessment not found');
    gate(prev.patientUuid !== a.patientUuid, 'CROSS_PATIENT_SUPERSESSION: cannot supersede another patient\u2019s staging');
    gate(!['SIGNED', 'SUPERSEDED'].includes(prev.status), 'Can only supersede a signed assessment');
  }
  return { key, provider, schema };
}

function createStagingAssessment(actor, data) {
  rbac.assertCanWrite(actor, 'createStagingAssessment');
  const dx = store.byUuid('diagnoses', data.diagnosisUuid);
  gate(!dx, 'Diagnosis not found');
  // STOP-GATE: staging requires a confirmed (signed) diagnosis — accept both status
  // vocabularies ('SIGNED' from clinical.recordDiagnosis, 'CONFIRMED' from clinical-flow)
  gate(!['SIGNED', 'CONFIRMED'].includes(dx.status), 'STOP_GATE: staging requires a confirmed (signed) diagnosis');
  gate(!data.stagingContext || !providers.CONTEXTS.includes(data.stagingContext), 'Invalid stagingContext');
  gate(!data.assessmentDate, 'assessmentDate is required');
  gate(new Date(data.assessmentDate) > new Date(), 'STOP_GATE: assessment date cannot be in the future');

  const { key, provider } = providers.resolveProvider(dx);
  gate(key === 'TNM_FALLBACK', 'STOP_GATE: no governed staging schema for this disease (arbitrary pack selection is not permitted)');
  const resolved = resolvedSnapshotFor(dx);

  const assessment = {
    uuid: uuid(),
    patientUuid: dx.patientUuid,
    episodeUuid: dx.episodeUuid,
    diagnosisUuid: dx.uuid,
    diseaseSite: masters.label('primarySite', dx.primarySite),
    providerKey: key,
    stagingAuthority: resolved.authority,
    authorityVersion: resolved.version,
    schemaId: resolved.schemaId,
    effectiveFrom: resolved.effectiveFrom,
    resultSource: data.resultSource || 'CLINICIAN_ENTERED',
    stagingContext: data.stagingContext,
    assessmentDate: data.assessmentDate,
    variables: data.variables || {},
    prognosticFactors: data.prognosticFactors || [],
    evidence: (data.evidence || []).map(e => ({
      variableKey: e.variableKey || null,
      sourceType: e.sourceType,       // CLINICAL|RADIOLOGICAL|PATHOLOGICAL|LABORATORY|MOLECULAR|EXTERNAL_DOCUMENT
      sourceRef: e.sourceRef || null, // result uuid or document reference
      sourceDate: e.sourceDate || null,
      supportingFinding: e.supportingFinding || ''
    })),
    clinician: actor.uuid,
    clinicianName: actor.name,
    status: 'DRAFT',
    supersedes: data.supersedes || null,
    createdAt: nowIso(),
    signedAt: null
  };
  store.insert('stagingAssessments', assessment);
  return assessment;
}

function signStagingAssessment(actor, assessmentUuid) {
  rbac.assertCanWrite(actor, 'signStagingAssessment');
  const a = store.byUuid('stagingAssessments', assessmentUuid);
  gate(!a, 'Staging assessment not found');
  assertNotSigned('stagingAssessment', a);

  const dx = store.byUuid('diagnoses', a.diagnosisUuid);
  const { key, provider } = applyStagingSignGates(a, dx);

  // supersedes: same patient+episode only (stop-gate)
  if (a.supersedes) {
    const prev = store.byUuid('stagingAssessments', a.supersedes);
    gate(!prev, 'Superseded assessment not found');
    gate(prev.patientUuid !== a.patientUuid, 'CROSS_PATIENT_SUPERSESSION: cannot supersede another patient\u2019s staging');
    gate(prev.status !== 'SIGNED', 'Can only supersede a SIGNED assessment');
    // §31 loop closure: the superseding signature resolves any OPEN discrepancy
    // flag on the superseded assessment (and consumes its review task).
    resolveOpenDiscrepancyFlag(actor, a.supersedes, a.uuid);
  }

  const derived = provider.deriveStage(a);
  a.resultSource = a.resultSource || 'CLINICIAN_ENTERED';
  a.stageResult = derived.stage || a.stageResult || null; // engine path: gate already set the derived result
  // §4/§21: record the classification prefix and label the result honestly —
  // anatomic vs prognostic distinction is preserved where the provider gives both
  a.classificationPrefix = tnm.classificationPrefix(a.stagingContext) || null;
  a.stageGroupStatus = derived.stage || derived.stageGroup ? 'DERIVED' : (derived.stageGroupStatus || 'INSUFFICIENT_INFORMATION');
  if (derived.anatomicStage !== undefined) a.anatomicStageGroup = derived.anatomicStage;
  if (derived.prognosticStage !== undefined) a.prognosticStageGroup = derived.prognosticStage;
  a.status = 'SIGNED';
  a.signedAt = nowIso();
  a.stageResult = a.stageResult || derived.stage;   // engine path: gate already derived it
  a.stageDerivation = derived.derivation;
  // §32 evidence completeness shown at signing, stored on the record
  a.evidenceCompleteness = (a.evidence || []).filter(e => e.sourceRef).length + ' linked / ' + (a.evidence || []).length + ' rows';
  a.signature = sign(actor, 'stagingAssessment', a.uuid, (a.stagingContext + ' → ' + (derived.stage || 'INSUFFICIENT_INFORMATION')));

  // supersede previous
  if (a.supersedes) store.update('stagingAssessments', a.supersedes, { status: 'SUPERSEDED' });

  store.update('stagingAssessments', a.uuid, a);
  store.audit(actor, 'STAGING_SIGNED', 'stagingAssessment', a.uuid, a.stagingContext + ' → ' + derived.stage + ' (authority ' + a.stagingAuthority + ' ' + a.authorityVersion + ')');

  // Task: staging signed → MDT or direct care plan (hospital config)
  const hospital = store.byUuid('hospitals', getPatient(a.patientUuid).hospitalUuid);
  const routeDirect = hospital && hospital.mdtPolicy && hospital.mdtPolicy[a.providerKey] === 'DIRECT_PLAN';
  createTask(actor, routeDirect ? 'CREATE_CARE_PLAN' : 'MDT_REVIEW', a.patientUuid, { stagingUuid: a.uuid });
  return a;
}

// ---- Staging-window evidence auto-suggestion (staging mandate §24/§25) ----
// When a staging fact is focused, the UI surfaces candidate patient records from
// the relevant staging window (window end = assessment date, start = N months
// back) whose source kind matches the fact. The clinician ALWAYS confirms the
// link — records are never silently attached (§24). Suggested items carry the
// same shape as the evidence picker so linking validates identically at sign.
const EVIDENCE_FACT_HINTS = {
  tumourSizeMm: ['RADIOLOGICAL', 'PATHOLOGICAL'],
  clinicalNodalStatus: ['RADIOLOGICAL', 'PATHOLOGICAL', 'CLINICAL'],
  regionalNodesExamined: ['PATHOLOGICAL'],
  regionalNodesPositive: ['PATHOLOGICAL'],
  distantMetastasis: ['RADIOLOGICAL', 'CLINICAL'],
  metastaticSites: ['RADIOLOGICAL', 'PATHOLOGICAL'],
  chestWallInvolvement: ['CLINICAL', 'RADIOLOGICAL'],
  skinInvolvement: ['CLINICAL'],
  inflammatoryFeatures: ['CLINICAL'],
  erStatus: ['PATHOLOGICAL', 'LABORATORY'],
  prStatus: ['PATHOLOGICAL', 'LABORATORY'],
  her2Status: ['PATHOLOGICAL', 'LABORATORY'],
  ki67: ['PATHOLOGICAL'],
  beta2Microglobulin: ['LABORATORY'],
  albumin: ['LABORATORY'],
  ldhElevated: ['LABORATORY'],
  cytogeneticRisk: ['MOLECULAR'],
  psa: ['LABORATORY'],
  t: ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL'],
  n: ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL'],
  m: ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL'],
  figoStage: ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL']
};
// Record source vocab → canonical evidence source vocabulary (same normalization
// the sign gate applies, so a suggested record always validates once linked).
const EVIDENCE_SOURCE_SYNONYMS = { PATHOLOGY: 'PATHOLOGICAL', RADIOLOGY: 'RADIOLOGICAL', LAB: 'LABORATORY', LABORATORY: 'LABORATORY', MOLECULAR: 'MOLECULAR', CLINICAL: 'CLINICAL' };

// §31/§24/§25: the ONE place patient records become picker-shaped evidence items.
// Used by the evidence-picker route (all finalized/signed records) and by the
// staging-window suggestion service (windowed, filtered to the fact's source kinds).
// opts: { windowStart: Date, windowEnd: 'YYYY-MM-DD', types: ['PATHOLOGICAL',…] } —
// both optional; without them every eligible record is returned.
function stagingEvidenceItems(patientUuid, opts) {
  const o = opts || {};
  const inWindow = d => {
    if (!o.windowStart && !o.windowEnd) return true;
    if (!d) return false;
    const t = new Date(d);
    // 'Z': stored timestamps are UTC ISO; a zone-less parse makes the bound local
    // time, so records stamped after local-midnight UTC fall outside their own day.
    return !isNaN(t) && (!o.windowStart || t >= o.windowStart) && (!o.windowEnd || t <= new Date(o.windowEnd + 'T23:59:59Z'));
  };
  const kindOf = t => EVIDENCE_SOURCE_SYNONYMS[t] || t;
  const matches = t => !o.types || o.types.includes(kindOf(t));
  const items = [];
  for (const r of store.find('results', r => r.patientUuid === patientUuid && r.resultStatus !== 'PRELIMINARY' && inWindow(r.reportDate || r.finalizationDate || r.at))) {
    if (!matches(r.resultType || r.category)) continue;
    items.push({ evidenceId: r.uuid, evidenceType: r.resultType || r.category, sourceResourceType: 'DiagnosticResult', sourceResourceId: r.uuid, sourceDate: r.reportDate || r.finalizationDate || r.at, reportedBy: r.reportingClinicianName || r.byName, status: r.status, relevantFinding: (r.summary || '').slice(0, 140), group: r.resultType === 'PATHOLOGY' ? 'Pathology' : r.resultType === 'RADIOLOGY' ? 'Radiology' : r.resultType === 'LAB' ? 'Laboratory' : 'Molecular results' });
  }
  for (const c of store.find('consultations', c => c.patientUuid === patientUuid && c.status === 'SIGNED' && inWindow(c.signedAt || c.at))) {
    if (!matches('CLINICAL')) continue;
    items.push({ evidenceId: c.uuid, evidenceType: 'CLINICAL_EXAM', sourceResourceType: 'Consultation', sourceResourceId: c.uuid, sourceDate: c.signedAt || c.at, reportedBy: c.signedByName || c.byName, status: c.status, relevantFinding: (c.clinicalAssessment || c.chiefComplaint || '').slice(0, 140), group: 'Consultations' });
  }
  for (const op of store.find('operativeRecords', op => op.patientUuid === patientUuid && inWindow(op.signedAt || op.createdAt))) {
    if (!matches('PATHOLOGICAL') && !matches('CLINICAL')) continue;
    items.push({ evidenceId: op.uuid, evidenceType: 'OPERATIVE_FINDING', sourceResourceType: 'OperativeRecord', sourceResourceId: op.uuid, sourceDate: op.signedAt || op.createdAt, reportedBy: op.signedByName || null, status: op.status, relevantFinding: (op.findings || op.performedProcedure || '').slice(0, 140), group: 'Operative reports' });
  }
  return items.sort((a, b) => new Date(b.sourceDate || 0) - new Date(a.sourceDate || 0));
}

function stagingEvidenceSuggestions(patientUuid, fact, assessmentDate, months) {
  const windowEnd = assessmentDate || nowIso().slice(0, 10);
  const windowMonths = Math.min(Math.max(Number(months) || 6, 1), 24);
  const windowStart = new Date(windowEnd);
  windowStart.setMonth(windowStart.getMonth() - windowMonths);
  // Per-fact source kinds: schema field override (disease-specific), else the
  // generic hint map, else all kinds (honest broadest default).
  let types = null;
  const dx = store.find('diagnoses', d => d.patientUuid === patientUuid)
    .sort((a, b) => new Date(b.diagnosisDate || b.createdAt || 0) - new Date(a.diagnosisDate || a.createdAt || 0))[0] || null;
  if (dx) {
    const { provider } = providers.resolveProvider(dx);
    const f = provider.resolveSchema(dx).fields.find(x => x.key === fact);
    types = (f && f.evidenceSourceTypes) || EVIDENCE_FACT_HINTS[fact] || null;
  }
  const suggestions = stagingEvidenceItems(patientUuid, { windowStart, windowEnd, types });
  return { fact, window: { start: windowStart.toISOString().slice(0, 10), end: windowEnd, months: windowMonths }, sourceTypes: types, suggestions };
}

// ---- Staging discrepancy flag (staging mandate §31) -----------------------
// The clinician NEVER hand-edits a calculated result. Disagreement is recorded as
// a flag on the signed assessment + a review task for the oncologist; correction
// happens by fixing the underlying facts and signing a superseding assessment.
function flagStagingDiscrepancy(actor, assessmentUuid, data) {
  rbac.assertCanWrite(actor, 'flagStagingDiscrepancy');
  const a = store.byUuid('stagingAssessments', assessmentUuid);
  gate(!a, 'Staging assessment not found');
  gate(a.status !== 'SIGNED', 'Only a SIGNED staging assessment can be flagged');
  gate(!a.stageResult, 'Assessment has no stage result to flag');
  const reason = String((data && data.reason) || '').trim();
  const requestedCorrection = String((data && data.requestedCorrection) || '').trim();
  gate(!reason, 'A discrepancy reason is required');
  gate(!requestedCorrection, 'A requested correction is required — describe the wrong fact or source');
  if (store.find('stagingDiscrepancyFlags', f => f.stagingAssessmentUuid === assessmentUuid && f.status === 'OPEN').length) {
    gate(true, 'An OPEN discrepancy flag already exists for this assessment');
  }
  const flag = {
    uuid: uuid(),
    patientUuid: a.patientUuid,
    stagingAssessmentUuid: assessmentUuid,
    flaggedResult: a.stageResult,
    reason,
    requestedCorrection,
    status: 'OPEN',
    flaggedBy: actor.uuid,
    flaggedByName: actor.name,
    flaggedAt: nowIso(),
    resolvedAt: null,
    resolvedByAssessmentUuid: null
  };
  store.insert('stagingDiscrepancyFlags', flag);
  store.audit(actor, 'STAGING_DISCREPANCY_FLAGGED', 'stagingAssessment', assessmentUuid, reason + ' — correction requested: ' + requestedCorrection);
  createTask(actor, 'STAGING_DISCREPANCY', a.patientUuid, { flagUuid: flag.uuid, stagingAssessmentUuid: assessmentUuid }, 48);
  return flag;
}

// Sign-side resolution (§31 loop closure): signing a superseding assessment whose
// supersedes target carries the OPEN flag marks it resolved with the new record.
function resolveOpenDiscrepancyFlag(actor, supersededUuid, newAssessmentUuid) {
  const open = store.find('stagingDiscrepancyFlags', f => f.stagingAssessmentUuid === supersededUuid && f.status === 'OPEN');
  if (!open.length) return;
  for (const f of open) {
    store.update('stagingDiscrepancyFlags', f.uuid, { status: 'RESOLVED', resolvedAt: nowIso(), resolvedByAssessmentUuid: newAssessmentUuid });
    store.audit(actor, 'STAGING_DISCREPANCY_RESOLVED', 'stagingAssessment', supersededUuid, 'resolved by superseding assessment ' + newAssessmentUuid);
  }
  // §49: the flag's review task is consumed by the corrective signature itself.
  wf.completeOpenTasks(actor, open[0].patientUuid, t => t.code === 'STAGING_DISCREPANCY' && t.payload && t.payload.flagUuid === open[0].uuid, 'discrepancy resolved by corrected staging assessment');
}

// ---- 2.1 MDT --------------------------------------------------------------
function openMdtCase(actor, data) {
  rbac.assertCanWrite(actor, 'openMdtCase');
  const patient = getPatient(data.patientUuid);
  gate(!patient, 'Patient not found');
  gate(!data.reason, 'MDT referral reason is required');
  const mdt = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    referralReason: data.reason,
    diagnosisUuid: data.diagnosisUuid || null,
    stagingUuid: data.stagingUuid || null,
    imagingResultUuids: data.imagingResultUuids || [],
    pathologyResultUuids: data.pathologyResultUuids || [],
    participants: data.participants || [],
    proposedOptions: data.proposedOptions || '',
    discussion: '',
    consensus: '',
    dissent: '',
    decision: '',
    responsibleClinician: null,
    status: 'SCHEDULED',
    openedAt: nowIso(),
    signedAt: null
  };
  store.insert('mdtCases', mdt);
  createTask(actor, 'MDT_CHAIR_SIGN', patient.uuid, { mdtUuid: mdt.uuid });
  store.audit(actor, 'MDT_OPENED', 'mdtCase', mdt.uuid, data.reason);
  return mdt;
}

function recordMdtDiscussion(actor, mdtUuid, data) {
  rbac.assertCanWrite(actor, 'recordMdtDiscussion');
  const mdt = store.byUuid('mdtCases', mdtUuid);
  gate(!mdt, 'MDT case not found');
  assertNotSigned('mdtCase', mdt);
  // Required fields at record time (D-MDT-6): the chair screen is a read-only
  // confirmation with no amend path, so the record must be complete pre-routing.
  const missing = requireMdtOutcomeFields(data);
  gate(missing, 'MDT ' + missing + ' is required before routing to the chair');
  mdt.participants = data.participants || mdt.participants;
  mdt.proposedOptions = data.proposedOptions || mdt.proposedOptions;
  mdt.discussion = data.discussion || mdt.discussion;
  mdt.consensus = data.consensus || mdt.consensus;
  mdt.dissent = data.dissent || '';
  mdt.decision = data.decision || mdt.decision;
  mdt.responsibleClinician = data.responsibleClinician || mdt.responsibleClinician;
  store.update('mdtCases', mdtUuid, mdt);
  store.audit(actor, 'MDT_DISCUSSION', 'mdtCase', mdtUuid);
  return mdt;
}

// The outcome fields the chair needs to sign (D-MDT-6). Returns the missing
// field's name, or null when complete — one policy, enforced at record time and
// again at sign time.
function requireMdtOutcomeFields(m) {
  if (!m || !m.decision) return 'decision';
  if (!m.responsibleClinician) return 'responsible clinician';
  return null;
}

function signMdtOutcome(actor, mdtUuid, data) {
  rbac.assertCanWrite(actor, 'signMdtOutcome');
  const mdt = store.byUuid('mdtCases', mdtUuid);
  gate(!mdt, 'MDT case not found');
  assertNotSigned('mdtCase', mdt);
  // Chair fallback (D-MDT-6): the chair owns the outcome — if the coordinator's
  // record reached the chair without the required fields, the chair supplies them
  // at sign and the amendment is audited under the chair's identity. The record is
  // only mutated after the gate passes (validated against a merged copy).
  const supplied = {};
  if (data && data.decision) supplied.decision = data.decision;
  if (data && data.responsibleClinician) supplied.responsibleClinician = data.responsibleClinician;
  const missing = requireMdtOutcomeFields(Object.assign({}, mdt, supplied));
  gate(missing, 'MDT ' + missing + ' is required before signing');
  Object.assign(mdt, supplied);
  if (supplied.decision !== undefined || supplied.responsibleClinician !== undefined) {
    store.audit(actor, 'MDT_CHAIR_COMPLETED_RECORD', 'mdtCase', mdtUuid, 'chair supplied decision/responsible at sign');
  }
  mdt.status = 'SIGNED';
  mdt.signedAt = nowIso();
  mdt.signedBy = actor.uuid;
  mdt.signature = sign(actor, 'mdtCase', mdt.uuid, mdt.decision);
  store.update('mdtCases', mdtUuid, mdt);
  createTask(actor, 'CREATE_CARE_PLAN', mdt.patientUuid, { mdtUuid: mdt.uuid });
  store.audit(actor, 'MDT_SIGNED', 'mdtCase', mdtUuid, mdt.decision);
  return mdt;
}

// ---- 2.2 Treatment Care Plan ----------------------------------------------
function createCarePlan(actor, data) {
  rbac.assertCanWrite(actor, 'createCarePlan');
  const patient = getPatient(data.patientUuid);
  gate(!patient, 'Patient not found');
  const dx = store.byUuid('diagnoses', data.diagnosisUuid);
  gate(!dx || !['SIGNED', 'CONFIRMED', 'REVISED'].includes(dx.status), 'STOP_GATE: care plan requires a signed (confirmed) diagnosis');
  // STOP-GATE: required staging (may reference a superseded assessment as the historical basis,
  // but the patient must always HAVE at least one signed staging)
  const hasAnySigned = store.find('stagingAssessments', s => s.patientUuid === patient.uuid && s.status === 'SIGNED').length > 0;
  gate(!hasAnySigned, 'STOP_GATE: treatment planning before required staging is not allowed');
  let staging = null;
  if (data.stagingUuid) {
    staging = store.byUuid('stagingAssessments', data.stagingUuid);
    gate(!staging, 'Staging assessment not found');
    gate(staging.patientUuid !== patient.uuid, 'CROSS_PATIENT: staging belongs to another patient');
    gate(!['SIGNED', 'SUPERSEDED'].includes(staging.status), 'Referenced staging must be a signed (or superseded signed) assessment');
  } else {
    staging = latestSignedStaging(patient.uuid);
    gate(!staging || staging.status !== 'SIGNED', 'STOP_GATE: treatment planning before required staging is not allowed');
  }
  gate(!data.treatmentIntent || !masters.getByCode('treatmentIntent', data.treatmentIntent), 'Unknown governed treatmentIntent');
  gate(!data.lineOfTherapy || !masters.getByCode('lineOfTherapy', data.lineOfTherapy), 'Unknown governed lineOfTherapy');
  gate(!data.expectedStart, 'expectedStart is required');

  const plan = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    diagnosisUuid: dx.uuid,
    stagingUuid: staging.uuid,
    treatmentIntent: data.treatmentIntent,
    lineOfTherapy: data.lineOfTherapy,
    modalitySequence: data.modalitySequence || [],   // e.g. [{modality:'CHEMOTHERAPY', detail:'AC x4 then Paclitaxel x4'}]
    systemicTherapy: data.systemicTherapy || '',
    radiotherapy: data.radiotherapy || '',
    surgery: data.surgery || '',
    supportiveCare: data.supportiveCare || '',
    institutionalProtocol: data.institutionalProtocol || null,
    rationale: data.rationale || '',
    expectedStart: data.expectedStart,
    monitoringPlan: data.monitoringPlan || '',
    responseAssessmentPlan: data.responseAssessmentPlan || '',
    oncologist: actor.uuid, oncologistName: actor.name,
    status: 'DRAFT',
    createdAt: nowIso(),
    signedAt: null
  };
  store.insert('carePlans', plan);
  return plan;
}

function signCarePlan(actor, planUuid) {
  rbac.assertCanWrite(actor, 'signCarePlan');
  const plan = store.byUuid('carePlans', planUuid);
  gate(!plan, 'Care plan not found');
  assertNotSigned('carePlan', plan);
  plan.status = 'SIGNED';
  plan.signedAt = nowIso();
  plan.signature = sign(actor, 'carePlan', plan.uuid, masters.label('treatmentIntent', plan.treatmentIntent));
  store.update('carePlans', plan.uuid, plan);
  store.audit(actor, 'CARE_PLAN_SIGNED', 'carePlan', plan.uuid, plan.treatmentIntent);
  // Tasks: care plan signed → finance AND treatment-specific consent capture (canonical §47)
  createTask(actor, 'FINANCIAL_COUNSEL', plan.patientUuid, { carePlanUuid: plan.uuid });
  createTask(actor, 'RECORD_CONSENT', plan.patientUuid, { carePlanUuid: plan.uuid });
  return plan;
}

function latestSignedStaging(patientUuid) {
  const all = store.find('stagingAssessments', s => s.patientUuid === patientUuid && s.status === 'SIGNED');
  all.sort((a, b) => new Date(b.signedAt) - new Date(a.signedAt));
  return all[0] || null;
}

// ---- 2.3 Financial counselling ---------------------------------------------
function recordFinancialCounselling(actor, data) {
  rbac.assertCanWrite(actor, 'recordFinancialCounselling');
  const plan = store.byUuid('carePlans', data.carePlanUuid);
  gate(!plan || plan.status !== 'SIGNED', 'STOP_GATE: financial counselling requires a signed care plan');
  gate(!data.plannedTreatment, 'plannedTreatment is required');
  gate(!data.costEstimate || isNaN(Number(data.costEstimate)), 'costEstimate must be a number');
  gate(!data.patientChoice, 'patientChoice is required');
  gate(!data.payerType, 'payerType is required');
  const fc = {
    uuid: uuid(),
    patientUuid: plan.patientUuid,
    carePlanUuid: plan.uuid,
    plannedTreatment: data.plannedTreatment,
    costEstimate: Number(data.costEstimate),
    drugOptions: data.drugOptions || [], // {type: LOCAL|ORIGINATOR|IMPORTED|BIOSIMILAR, name, cost}
    payerType: data.payerType,           // INSURER | TPA | SELF_PAY | SCHEME
    insurerTpa: data.insurerTpa || '',
    authorization: data.authorization || { number: '', status: 'PENDING', validTo: null },
    selfPayComponent: data.selfPayComponent ? Number(data.selfPayComponent) : 0,
    counsellingNote: data.counsellingNote || '',
    patientChoice: data.patientChoice,
    plannedStartDate: data.plannedStartDate || null,
    financialClearance: data.financialClearance || 'PENDING', // PENDING | CLEARED | DECLINED
    counsellor: actor.uuid, counsellorName: actor.name,
    signedAt: null, at: nowIso()
  };
  store.insert('financialCounsellings', fc);
  return fc;
}

function signFinancialCounselling(actor, fcUuid) {
  rbac.assertCanWrite(actor, 'signFinancialCounselling');
  const fc = store.byUuid('financialCounsellings', fcUuid);
  gate(!fc, 'Financial counselling record not found');
  assertNotSigned('financialCounselling', fc);
  gate(!fc.authorization.number && fc.payerType !== 'SELF_PAY', 'Authorization number required for non-self-pay');
  fc.status = 'SIGNED';
  fc.signedAt = nowIso();
  fc.signature = sign(actor, 'financialCounselling', fc.uuid, fc.financialClearance);
  store.update('financialCounsellings', fc.uuid, fc);

  if (fc.financialClearance === 'CLEARED') {
    createTask(actor, 'READINESS_CHECK', fc.patientUuid, { fcUuid: fc.uuid });
  } else {
    createTask(actor, 'CREATE_CARE_PLAN', fc.patientUuid, { fcUuid: fc.uuid, reason: 'finance not cleared — revise plan' });
  }
  store.audit(actor, 'FINANCE_SIGNED', 'financialCounselling', fc.uuid, fc.financialClearance);
  return fc;
}

// ---- 2.4 Treatment readiness ------------------------------------------------
function recordReadiness(actor, data) {
  rbac.assertCanWrite(actor, 'recordReadiness');
  const fc = store.byUuid('financialCounsellings', data.fcUuid);
  gate(!fc || fc.financialClearance !== 'CLEARED', 'STOP_GATE: readiness requires financial clearance');
  const checks = data.checks || {};
  gate(!checks.labsCurrent, 'Labs must be current');
  gate(!checks.consentTaken, 'Consent must be taken');
  gate(!checks.accessDevice, 'Vascular access device required');
  gate(!checks.patientEducated, 'Patient education required');
  // D2 fix: consentTaken now requires an actual SIGNED consent record (canonical §47)
  const signedConsent = consentSvc.latestSignedConsent(fc.patientUuid, null);
  gate(!signedConsent, 'STOP_GATE: a signed treatment consent record is required (Consent tab)');
  const r = {
    uuid: uuid(),
    patientUuid: fc.patientUuid,
    fcUuid: fc.uuid,
    checks,
    clearedBy: actor.uuid, clearedByName: actor.name,
    clearedAt: nowIso()
  };
  store.insert('readinessChecks', r);
  // Handoff: readiness cleared → oncologist may now sign the treatment order
  createTask(actor, 'CREATE_TREATMENT_ORDER', fc.patientUuid, { fcUuid: fc.uuid, reason: 'readiness cleared — finance + consent + labs complete' });
  store.audit(actor, 'READINESS_CLEARED', 'readinessCheck', r.uuid);
  return r;
}

module.exports = {
  getPatient, registerPatient, recordConsultation, signConsultation, amendConsultation,
  orderInvestigation, advanceOrderStatus, recordResult, amendResult, reviewResult,
  recordDiagnosis, signDiagnosis,  stagingSchemaFor, resolvedSnapshotFor, applyStagingSignGates,
  createStagingAssessment, signStagingAssessment, maybeCreatePathologicalRestaging,
  flagStagingDiscrepancy, resolveOpenDiscrepancyFlag, stagingEvidenceSuggestions, stagingEvidenceItems,
  openMdtCase, recordMdtDiscussion, signMdtOutcome,
  createCarePlan, signCarePlan, latestSignedStaging,
  recordFinancialCounselling, signFinancialCounselling, recordReadiness,
  CONSULT_TYPES, DISCUSSION_ACTIONS, ORDER_CATEGORIES, ORDER_STATUSES, ORDER_PRIORITIES,
  RESULT_STATUSES, DIAGNOSIS_FIELDS, LATERALITY, DIAG_BASIS, DIAG_CERTAINTY, DIAGNOSIS_STATUS,
  validateDiagnosisFields, tnm
};
