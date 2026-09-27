// CCA OS — Clinical services (Phases 1 & 2)
// Registration → Consultation → Investigation → Result → Diagnosis → Staging
// → MDT → Care Plan → Finance → Readiness
'use strict';
const store = require('./store');
const wf = require('./workflow');
const masters = require('./masters');
const staging = require('./staging');
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
  staging.maybeCreatePathologicalRestaging(actor, patient.uuid, order, result);
  return result;
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
  staging.maybeCreatePathologicalRestaging(actor, result.patientUuid, amendedOrder, result);
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
  let stagingRec = null;
  if (data.stagingUuid) {
    stagingRec = store.byUuid('stagingAssessments', data.stagingUuid);
    gate(!stagingRec, 'Staging assessment not found');
    gate(stagingRec.patientUuid !== patient.uuid, 'CROSS_PATIENT: staging belongs to another patient');
    gate(!['SIGNED', 'SUPERSEDED'].includes(stagingRec.status), 'Referenced staging must be a signed (or superseded signed) assessment');
  } else {
    stagingRec = staging.latestSignedStaging(patient.uuid);
    gate(!stagingRec || stagingRec.status !== 'SIGNED', 'STOP_GATE: treatment planning before required staging is not allowed');
  }
  gate(!data.treatmentIntent || !masters.getByCode('treatmentIntent', data.treatmentIntent), 'Unknown governed treatmentIntent');
  gate(!data.lineOfTherapy || !masters.getByCode('lineOfTherapy', data.lineOfTherapy), 'Unknown governed lineOfTherapy');
  gate(!data.expectedStart, 'expectedStart is required');

  const plan = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    diagnosisUuid: dx.uuid,
    stagingUuid: stagingRec.uuid,
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
  recordDiagnosis, signDiagnosis,
  openMdtCase, recordMdtDiscussion, signMdtOutcome,
  createCarePlan, signCarePlan,
  recordFinancialCounselling, signFinancialCounselling, recordReadiness,
  CONSULT_TYPES, DISCUSSION_ACTIONS, ORDER_CATEGORIES, ORDER_STATUSES, ORDER_PRIORITIES,
  RESULT_STATUSES, DIAGNOSIS_FIELDS, LATERALITY, DIAG_BASIS, DIAG_CERTAINTY, DIAGNOSIS_STATUS,
  validateDiagnosisFields
};
