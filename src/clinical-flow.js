// CCA OS — Canonical Clinical Flow (canonical spec §5–§21)
// Results-review consult → confirmed diagnosis → disease profile → staging/classification
'use strict';
const store = require('./store');
const wf = require('./workflow');
const masters = require('./masters');
const providers = require('./staging-providers');
const clinical = require('./clinical');
const staging = require('./staging');
const rbac = require('./rbac');

const { uuid, nowIso, gate, sign, assertNotSigned, createTask } = wf;

function getPatient(uuidOrMrn) {
  return store.findOne('patients', p => p.uuid === uuidOrMrn || p.mrn === uuidOrMrn);
}

// ---- §8 Results-review consultation ---------------------------------------
// A separate encounter after results arrive. Doctor sees prior consult + results
// (enforced via review_status) and records a diagnosis decision:
// DIAGNOSIS_CONFIRMED / DIAGNOSIS_NOT_CONFIRMED / NEEDS_MORE_INFORMATION.
const DIAGNOSIS_DECISIONS = ['DIAGNOSIS_CONFIRMED', 'DIAGNOSIS_NOT_CONFIRMED', 'NEEDS_MORE_INFORMATION'];

function createResultsReview(actor, data) {
  rbac.assertCanWrite(actor, 'createResultsReview');
  const patient = getPatient(data.patientUuid);
  gate(!patient, 'Patient not found');
  gate(!data.decision || !DIAGNOSIS_DECISIONS.includes(data.decision),
    'decision must be one of ' + DIAGNOSIS_DECISIONS.join('/'));
  gate(!data.ecog && data.ecog !== 0, 'ECOG status is required');

  // The doctor sees all available results; the consultation itself marks them REVIEWED
  // (provenance: reviewedBy/reviewedAt). Unreviewed results are the normal input here.
  const results = store.find('results', r => r.patientUuid === patient.uuid);

  const review = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    consultType: 'RESULTS_REVIEW',
    decision: data.decision,
    ecog: data.ecog,
    clinicalNotes: data.clinicalNotes || '',
    additionalOrdersRequested: data.additionalOrdersRequested || [], // [{category,test,notes}]
    priorConsultUuids: (data.priorConsultUuids || []).concat(
      store.find('consultations', c => c.patientUuid === patient.uuid).map(c => c.uuid)
    ),
    reviewedResults: results.map(r => r.uuid),
    at: nowIso(), by: actor.uuid, byName: actor.name,
    signedAt: null
  };
  store.insert('consultations', review);

  // Mark results REVIEWED (provenance: who reviewed, when)
  for (const r of results) {
    if (r.reviewStatus === 'UNREVIEWED') {
      store.update('results', r.uuid, { reviewStatus: 'REVIEWED', reviewedBy: actor.uuid, reviewedAt: nowIso() });
    }
  }

  // Review task flow — completeOpenTasks is the engine idiom (§49): the signed
  // review consultation supersedes the review tasks that asked for it.
  wf.completeOpenTasks(actor, patient.uuid, t => t.code === 'REVIEW_RESULTS', 'results review consultation recorded');

  if (review.additionalOrdersRequested.length) {
    for (const inv of review.additionalOrdersRequested) {
      orderMore(actor, patient, inv, review.uuid);
    }
    // More information needed before diagnosis can be confirmed (canonical §8)
    createTask(actor, 'REVIEW_RESULTS', patient.uuid, { consultUuid: review.uuid }, 48);
    review.workflowEffect = 'NEEDS_MORE_INFORMATION';
  } else if (data.decision === 'DIAGNOSIS_CONFIRMED') {
    createTask(actor, 'CONFIRM_DIAGNOSIS', patient.uuid, { consultUuid: review.uuid });
    review.workflowEffect = 'PROCEED_TO_DIAGNOSIS';
  } else if (data.decision === 'NEEDS_MORE_INFORMATION') {
    createTask(actor, 'REVIEW_RESULTS', patient.uuid, { consultUuid: review.uuid }, 48);
    review.workflowEffect = 'NEEDS_MORE_INFORMATION';
  } else {
    review.workflowEffect = 'CONTINUE_WORKUP';
  }
  store.update('consultations', review.uuid, review);
  store.audit(actor, 'RESULTS_REVIEW_RECORDED', 'consultation', review.uuid,
    patient.mrn + ' decision=' + data.decision);
  return review;
}

// Directive §3: additional orders are master-test driven (testCode required).
function orderMore(actor, patient, inv, consultUuid) {
  const order = clinical.orderInvestigation(actor, {
    patientUuid: patient.uuid, category: inv.category, testCode: inv.testCode || inv.test,
    priority: inv.priority, clinicalIndication: inv.notes || inv.clinicalIndication,
    notes: inv.notes, fromConsultUuid: consultUuid
  }, { internal: true });
  return order;
}

// ---- §9 CancerDiagnosis (structured; T/N/M forbidden) ----------------------
const DIAGNOSIS_FIELDS = ['cancerType', 'primarySite', 'subsite', 'laterality', 'histology', 'morphology',
  'grade', 'icd10', 'icdOtopography', 'icdOmorphology', 'icdOVersion', 'diagnosisDate', 'diagnosisBasis'];
const LATERALITY = ['LEFT', 'RIGHT', 'BILATERAL', 'MIDLINE', 'N_A'];
const DIAG_BASIS = ['CLINICAL', 'IMAGING', 'PATHOLOGY', 'CYTOLOGY', 'BONE_MARROW', 'MOLECULAR', 'OTHER'];
const DIAGNOSIS_STATUS = ['SUSPECTED', 'PROVISIONAL', 'CONFIRMED', 'REVISED', 'SUPERSEDED'];

function validateDiagnosisFields(data) {
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
  if (data.morphology) gate(!masters.getByCode('morphology', data.morphology), 'Unknown governed value morphology=' + data.morphology);
  if (data.grade) gate(!masters.getByCode('grade', data.grade), 'Unknown governed value grade=' + data.grade);
  if (data.icd10) gate(!masters.getByCode('icd10', data.icd10), 'Unknown governed value icd10=' + data.icd10);
  if (data.icdOtopography) gate(!masters.getByCode('icdOtopography', data.icdOtopography), 'Unknown governed icdOtopography=' + data.icdOtopography);
  if (data.icdOmorphology) gate(!masters.getByCode('icdOmorphology', data.icdOmorphology), 'Unknown governed icdOmorphology=' + data.icdOmorphology);
  if (data.icdOVersion) {
    gate(!masters.icdOVersionValid(data.icdOVersion), 'Unknown governed icdOVersion=' + data.icdOVersion);
  }
  if (data.snomedCode) {
    // canonical §52: code + system stored; SNOMED CT primary clinical terminology
    gate(typeof data.snomedCode !== 'string' || data.snomedCode.length > 32, 'Invalid SNOMED CT code');
  }
  gate(!data.diagnosisDate, 'diagnosisDate is required');
  gate(new Date(data.diagnosisDate) > new Date(), 'diagnosisDate cannot be in the future');
  gate(!data.diagnosisBasis || !DIAG_BASIS.includes(data.diagnosisBasis), 'diagnosisBasis must be one of ' + DIAG_BASIS.join('/'));
  if (data.laterality) gate(!LATERALITY.includes(data.laterality), 'Invalid laterality');
  if (data.primaryOrSecondary) gate(!['PRIMARY', 'METASTATIC', 'RECURRENCE', 'NEW_PRIMARY', 'UNKNOWN'].includes(data.primaryOrSecondary), 'Invalid primaryOrSecondary');
  // T/N/M must NOT be inside diagnosis (canonical §80)
  for (const forbidden of ['t', 'n', 'm', 'tnm', 'T', 'N', 'M', 'stageGroup', 'stage_group']) {
    gate(Object.prototype.hasOwnProperty.call(data, forbidden), 'T/N/M/stage fields are not allowed in a diagnosis (staging is a separate signed object)');
  }
}

// §9 diagnosis creation is the SAME canonical service as clinical.recordDiagnosis —
// one validation cascade (family→site→histology coherence, code+system+version,
// T/N/M prohibition) so no caller can bypass the governed rules.
function recordDiagnosis(actor, data) {
  return clinical.recordDiagnosis(actor, data);
}

// Structured revision (canonical §61): a signed diagnosis is never edited in place.
// Correction creates a SUPERSEDING VERSION preserving the complete history.
function reviseDiagnosis(actor, dxUuid, data) {
  rbac.assertCanWrite(actor, 'reviseDiagnosis');
  const prev = store.byUuid('diagnoses', dxUuid);
  gate(!prev, 'Diagnosis not found');
  gate(!['CONFIRMED', 'REVISED'].includes(prev.status), 'Only a signed/confirmed diagnosis can be revised through supersession');
  gate(!data.revisionReason, 'revisionReason is required for the audit trail (D6)');
  validateDiagnosisFields(Object.assign({}, prev, data));
  // Merge: new fields win; identity/history fields reset
  const merged = Object.assign({}, prev, data, {
    uuid: uuid(),
    version: (prev.version || 1) + 1,
    supersedes: prev.uuid,
    supersededBy: null,
    status: 'REVISED',
    evidence: data.evidence || prev.evidence,
    createdAt: nowIso(),
    confirmedAt: null,
    signedAt: null,
    signature: null
  });
  delete merged.supersededBy;
  store.insert('diagnoses', merged);
  store.update('diagnoses', prev.uuid, { supersededBy: merged.uuid, status: 'SUPERSEDED' });
  merged.revisionReason = data.revisionReason;
  store.audit(actor, 'DIAGNOSIS_REVISED', 'diagnosis', merged.uuid, 'v' + merged.version + ' supersedes v' + (prev.version || 1) + ' — ' + data.revisionReason);
  return merged;
}

function signDiagnosis(actor, dxUuid) {
  rbac.assertCanWrite(actor, 'signDiagnosis');
  const dx = store.byUuid('diagnoses', dxUuid);
  gate(!dx, 'Diagnosis not found');
  assertNotSigned('diagnosis', dx);
  gate(dx.status === 'SUPERSEDED', 'Cannot sign a superseded diagnosis version');
  // Evidence must belong to the same patient (stop-gate)
  for (const ev of dx.evidence || []) {
    const r = store.byUuid('results', ev.resultUuid);
    gate(!r, 'Evidence result not found: ' + ev.resultUuid);
    gate(r.patientUuid !== dx.patientUuid, 'CROSS_PATIENT_EVIDENCE: evidence ' + ev.resultUuid + ' belongs to another patient');
  }
  dx.status = 'CONFIRMED';
  dx.statusLabel = 'CONFIRMED';
  dx.confirmedAt = nowIso();
  dx.signedAt = nowIso();
  dx.signature = sign(actor, 'diagnosis', dx.uuid, masters.label('cancerType', dx.cancerType) + ' (' + dx.icdOVersion + ')');
  store.update('diagnoses', dx.uuid, dx);
  store.audit(actor, 'DIAGNOSIS_SIGNED', 'diagnosis', dx.uuid, masters.label('cancerType', dx.cancerType));

  // Task engine: diagnosis confirmed → staging
  createTask(actor, 'CREATE_STAGING', dx.patientUuid, { diagnosisUuid: dx.uuid });
  return dx;
}

// ---- §11 DiseaseProfile / BiomarkerResult -----------------------------------
function createDiseaseProfile(actor, data) {
  rbac.assertCanWrite(actor, 'createDiseaseProfile');
  const patient = getPatient(data.patientUuid);
  gate(!patient, 'Patient not found');
  const dx = store.byUuid('diagnoses', data.diagnosisUuid);
  gate(!dx, 'Diagnosis not found');
  gate(dx.patientUuid !== patient.uuid, 'CROSS_PATIENT: diagnosis belongs to another patient');
  gate(!['CONFIRMED', 'REVISED', 'SUPERSEDED'].includes(dx.status), 'Disease profile requires a signed (confirmed) diagnosis');

  const dp = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    episodeUuid: dx.episodeUuid,
    diagnosisUuid: dx.uuid,
    histology: data.histology || dx.histology,
    morphology: data.morphology || dx.morphology,
    grade: data.grade || dx.grade,
    differentiation: data.differentiation || dx.differentiation,
    biomarkerResults: (data.biomarkerResults || []).map(b => {
      const master = masters.getByCode('biomarker', b.code);
      gate(!master, 'Unknown governed biomarker ' + b.code);
      gate(!master.applicability || !master.applicability.includes(dx.cancerType),
        'Biomarker ' + b.code + ' is not applicable to ' + dx.cancerType + ' (master-driven applicability)');
      return {
        code: b.code,
        method: b.method || null,
        qualitative: b.qualitative || null,
        quantitative: b.quantitative !== undefined && b.quantitative !== null && b.quantitative !== '' ? Number(b.quantitative) : null,
        unit: b.unit || null,
        interpretation: b.interpretation || null,
        specimenId: b.specimenId || null,
        sourceResultUuid: b.sourceResultUuid || null,
        resultDate: b.resultDate || null
      };
    }),
    molecularFindings: data.molecularFindings || '',
    createdBy: actor.uuid, createdByName: actor.name,
    createdAt: nowIso(),
    status: 'DRAFT',
    signedAt: null
  };
  store.insert('diseaseProfiles', dp);
  return dp;
}

function signDiseaseProfile(actor, dpUuid) {
  rbac.assertCanWrite(actor, 'signDiseaseProfile');
  const dp = store.byUuid('diseaseProfiles', dpUuid);
  gate(!dp, 'Disease profile not found');
  assertNotSigned('diseaseProfile', dp);
  // Every linked source result must belong to the same patient
  for (const b of dp.biomarkerResults || []) {
    if (b.sourceResultUuid) {
      const r = store.byUuid('results', b.sourceResultUuid);
      gate(!r, 'Biomarker source result not found: ' + b.sourceResultUuid);
      gate(r.patientUuid !== dp.patientUuid, 'CROSS_PATIENT_EVIDENCE: biomarker source belongs to another patient');
    }
  }
  dp.status = 'SIGNED';
  dp.signedAt = nowIso();
  dp.signature = sign(actor, 'diseaseProfile', dp.uuid, (dp.biomarkerResults || []).length + ' biomarker results');
  store.update('diseaseProfiles', dp.uuid, dp);
  createTask(actor, 'CREATE_STAGING', dp.patientUuid, { diseaseProfileUuid: dp.uuid });
  store.audit(actor, 'DISEASE_PROFILE_SIGNED', 'diseaseProfile', dp.uuid);
  return dp;
}

// ---- §12–§21 Staging with version routing -----------------------------------
function stagingSchemaFor(diagnosisUuid) {
  // Delegates to the single authoritative resolver (staging.stagingSchemaFor) so
  // every consumer sees identical authority/schema/version routing.
  return staging.stagingSchemaFor(diagnosisUuid);
}

// §14: version resolves by diagnosis date + site + histology + authority.
// Until licensed content exists, resolveProvider returns the CCA-REFERENCE-SKELETON
// and the note records how a licensed provider would route.
function versionRoutingNote(dx) {
  const { key, provider } = providers.resolveProvider(dx);
  if (key.startsWith('TNM')) {
    return 'AJCC/UICC version routing by (diagnosis date ' + dx.diagnosisDate + ', site ' + dx.primarySite +
      ', histology ' + dx.histology + '): licensed provider required to resolve site-specific edition; ' +
      'AUTHORITY_CONTENT_UNAVAILABLE until connected.';
  }
  if (key.startsWith('FIGO')) return 'FIGO revision metadata per site (Cervix 2018 / Vulva 2021 / Endometrium 2023 / Ovary 2014 framework) — licensed provider resolves effective revision.';
  if (key === 'MM') return 'ISS / R-ISS / R2-ISS per licensed authority.';
  return 'Authority version routing by licensed provider; AUTHORITY_CONTENT_UNAVAILABLE until connected.';
}

function createStagingAssessment(actor, data) {
  rbac.assertCanWrite(actor, 'createStagingAssessment');
  const dx = store.byUuid('diagnoses', data.diagnosisUuid);
  gate(!dx, 'Diagnosis not found');
  gate(!['CONFIRMED', 'REVISED'].includes(dx.status), 'STOP_GATE: staging requires a confirmed (signed) diagnosis');
  gate(!data.stagingContext || !providers.CONTEXTS.includes(data.stagingContext), 'Invalid stagingContext');
  gate(!data.assessmentDate, 'assessmentDate is required');
  gate(new Date(data.assessmentDate) > new Date(), 'STOP_GATE: assessment date cannot be in the future');

  const { key, provider } = providers.resolveProvider(dx);
  gate(key === 'TNM_FALLBACK', 'STOP_GATE: no governed staging schema for this disease (pack selection not permitted)');
  // Locked resolved snapshot (directive §26) — same contract as staging.createStagingAssessment
  const resolved = staging.resolvedSnapshotFor(dx);

  // Biomarker consumption: staging may READ the signed disease profile; never own it.
  let profile = store.find('diseaseProfiles', p => p.diagnosisUuid === dx.uuid)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;

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
    effectiveVersionNote: versionRoutingNote(dx),
    stagingContext: data.stagingContext,
    assessmentDate: data.assessmentDate,
    variables: data.variables || {},
    biomarkerSnapshot: profile ? (profile.biomarkerResults || []).map(b => ({ code: b.code, value: b.qualitative || b.quantitative })) : [],
    evidence: (data.evidence || []).map(e => ({
      variableKey: e.variableKey || null,
      sourceType: e.sourceType,
      sourceRef: e.sourceRef || null,
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
  // Shared sign-time gates (schema lock, unknown fields, governed values,
  // evidence-per-fact, same-patient supersession) — directive §26/§39
  const { key, provider } = staging.applyStagingSignGates(a, dx);

  const derived = provider.deriveStage(a);
  a.stageResult = derived.stage || a.stageResult || null; // engine path: shared gate set the derived result
  a.status = 'SIGNED';
  a.signedAt = nowIso();
  a.stageResult = a.stageResult || derived.stage;   // engine path: shared gate already derived it
  a.stageDerivation = derived.derivation;
  a.signature = sign(actor, 'stagingAssessment', a.uuid, (a.stagingContext + ' \u2192 ' + derived.stage));

  if (a.supersedes) store.update('stagingAssessments', a.supersedes, { status: 'SUPERSEDED' });
  store.update('stagingAssessments', a.uuid, a);
  store.audit(actor, 'STAGING_SIGNED', 'stagingAssessment', a.uuid, a.stagingContext + ' \u2192 ' + derived.stage);

  const hospital = store.byUuid('hospitals', getPatient(a.patientUuid).hospitalUuid);
  const routeDirect = hospital && hospital.mdtPolicy && hospital.mdtPolicy[a.providerKey] === 'DIRECT_PLAN';
  createTask(actor, routeDirect ? 'CREATE_CARE_PLAN' : 'MDT_REVIEW', a.patientUuid, { stagingUuid: a.uuid });
  return a;
}

// §79/§34: one authoritative current-stage resolver. Downstream code must use this,
// never "latest stage row" queries. Contexts never collapse into one ambiguous value.
function get_current_staging(patientUuid, episodeUuid, stagingContext) {
  let list = store.find('stagingAssessments', s => s.patientUuid === patientUuid);
  if (episodeUuid) list = list.filter(s => s.episodeUuid === episodeUuid);
  if (stagingContext) list = list.filter(s => s.stagingContext === stagingContext);
  // current = signed/superseded with the latest signedAt; superseded ones are history
  const signed = list.filter(s => ['SIGNED', 'SUPERSEDED'].includes(s.status));
  signed.sort((a, b) => new Date(b.signedAt || 0) - new Date(a.signedAt || 0));
  return signed[0] || null;
}

function getCurrentStagingAll(patientUuid) {
  const contexts = providers.CONTEXTS;
  const out = {};
  for (const ctx of contexts) {
    const cur = get_current_staging(patientUuid, null, ctx);
    if (cur) out[ctx] = cur;
  }
  return out;
}

// §34 getStagingSummary: per-classification current results for the header and
// care plan — clinical / pathological / posttherapy / recurrence kept separate.
function getStagingSummary(patientUuid, episodeUuid) {
  const all = getCurrentStagingAll(patientUuid);
  const f = (a) => a ? {
    stage: a.stageResult,
    classification: a.stagingContext,
    prefix: a.classificationPrefix || null,
    authority: a.stagingAuthority,
    version: a.authorityVersion,
    signedAt: a.signedAt,
    assessmentUuid: a.uuid
  } : null;
  return {
    clinical: f(all.CLINICAL),
    pathological: f(all.PATHOLOGICAL),
    posttherapyClinical: f(all.POSTTHERAPY_CLINICAL),
    posttherapyPathological: f(all.POSTTHERAPY_PATHOLOGICAL),
    recurrence: f(all.RECURRENCE_RETREATMENT),
    nonTnm: f(all.NON_TNM)
  };
}

module.exports = {
  getPatient, createResultsReview, orderMore, DIAGNOSIS_DECISIONS,
  recordDiagnosis, reviseDiagnosis, signDiagnosis, validateDiagnosisFields,
  DIAGNOSIS_FIELDS, LATERALITY, DIAG_BASIS, DIAGNOSIS_STATUS,
  createDiseaseProfile, signDiseaseProfile,
  stagingSchemaFor, versionRoutingNote, createStagingAssessment, signStagingAssessment,
  get_current_staging, getCurrentStagingAll, getStagingSummary
};
