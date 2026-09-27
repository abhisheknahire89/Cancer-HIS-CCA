// CCA OS — Canonical Slice 1 acceptance tests (canonical spec §76/§77)
// Run: node test/canonical-slice1.test.js   (server not required; services exercised directly)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-slice1-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const wf = require('../src/workflow');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const staging = require('../src/staging');
const flow = require('../src/clinical-flow');
const providers = require('../src/staging-providers');
const rbac = require('../src/rbac');

let pass = 0, failCount = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { failCount++; console.log('  FAIL ' + name); }
}
function expectGate(name, fn, needle) {
  try { fn(); failCount++; console.log('  FAIL ' + name + ' (no error thrown)'); }
  catch (e) {
    const ok = !needle || String(e.message).includes(needle);
    if (ok) { pass++; console.log('  PASS ' + name); }
    else { failCount++; console.log('  FAIL ' + name + ' — wrong error: ' + e.message); }
  }
}
function dateStr(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

store.load();
masters.seedMasters();

const ACTORS = {
  front: { uuid: 'a-front', name: 'Front Desk', role: 'Front Desk' },
  intake: { uuid: 'a-intake', name: 'Intake', role: 'Intake Nurse' },
  mo: { uuid: 'a-mo', name: 'Dr. Main', role: 'Medical Oncologist' },
  path: { uuid: 'a-path', name: 'Dr. Path', role: 'Pathologist' },
  rad: { uuid: 'a-rad', name: 'Dr. Rad', role: 'Radiologist' },
  lab: { uuid: 'a-lab', name: 'Lab', role: 'Lab' },
  fin: { uuid: 'a-fin', name: 'Counsellor', role: 'Financial Counsellor' },
  nav: { uuid: 'a-nav', name: 'Navigator', role: 'Nurse Navigator' },
  pharm: { uuid: 'a-ph', name: 'Pharmacist', role: 'Pharmacist' },
  nurse: { uuid: 'a-dn', name: 'DayCare', role: 'Day Care Nurse' },
  ext: { uuid: 'a-ext', name: 'External', role: 'External Consultant' },
  mdtc: { uuid: 'a-mdtc', name: 'Coordinator', role: 'MDT Coordinator' },
  chair: { uuid: 'a-chair', name: 'Chair', role: 'MDT Chair' }
};

// hospital with MDT for breast
store.insert('hospitals', { uuid: 'h1', name: 'CCA Central', mdtPolicy: { TNM_BREAST: 'MDT' } });

console.log('\n== SETUP: breast patient through registration ==');
const { patient } = clinical.registerPatient(ACTORS.front, {
  name: 'Anita Desai', dob: '1980-04-12', sex: 'F', hospitalUuid: 'h1', referralSource: 'SELF'
});
check('patient registered with MRN', /^CCA-\d{6}$/.test(patient.mrn));

console.log('\n== FIRST CONSULTATION (structured encounter, directive §1–2) ==');
const consult1 = clinical.recordConsultation(ACTORS.intake, {
  patientUuid: patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 1,
  reasonForVisit: 'Right breast lump', chiefComplaint: 'Right breast lump 3 months',
  historyPresentIllness: 'Progressively enlarging, non-tender',
  comorbidities: 'Hypertension', currentMedications: 'Amlodipine',
  smokingHistory: { status: 'NEVER', packYears: 0 },
  heightCm: 162, weightKg: 64,
  physicalExamination: '3 cm firm mass right breast upper outer quadrant',
  clinicalAssessment: 'Suspicious breast lump, query malignancy',
  investigationDiscussion: [
    { action: 'CONSIDER', notes: 'May do PET-CT next week if nodes suspicious' }, // must NOT order
    { action: 'ORDER_NOW', category: 'PATHOLOGY', testCode: 'CORE_BIOPSY_BREAST', notes: 'core biopsy right breast' },
    { action: 'ORDER_NOW', category: 'RADIOLOGY', testCode: 'US_BREAST' },
    { action: 'ORDER_NOW', category: 'LAB', testCode: 'CBC' }
  ]
});
check('consultation drafted with BSA auto-calculated (Mosteller)', consult1.status === 'DRAFT' && consult1.bsa > 1.5 && consult1.bsa < 2.5);
check('discussion recorded without creating orders (CONSIDER ≠ order)', store.find('investigationOrders', o => o.patientUuid === patient.uuid).length === 0);
const signedConsult = clinical.signConsultation(ACTORS.mo, consult1.uuid);
check('consultation signed + immutable', signedConsult.status === 'SIGNED' && !!signedConsult.signedAt);
const orders = store.find('investigationOrders', o => o.patientUuid === patient.uuid);
check('exactly 3 orders created — only from ORDER_NOW items', orders.length === 3);
check('orders are master-test driven with terminology', orders.every(o => o.testCodeValue && o.terminology && o.terminology.system));
check('order status chain starts SIGNED', orders.every(o => o.status === 'SIGNED'));
const pathTask = store.find('tasks', t => t.role === 'Pathologist' && t.status === 'OPEN');
check('pathologist got dept task automatically', pathTask.length === 1);
const amend1 = clinical.amendConsultation(ACTORS.mo, signedConsult.uuid, { clinicalAssessment: 'Updated: palpable axillary node', amendmentReason: 'new node found on exam' });
check('signed consult amendment creates superseding version', amend1.version === 2 && amend1.status === 'AMENDED' && amend1.supersedes === signedConsult.uuid);
const amendSigned = clinical.signConsultation(ACTORS.mo, amend1.uuid);
check('amendment re-signs as SIGNED v2', amendSigned.status === 'SIGNED' && amendSigned.version === 2);
const consultSigned = amendSigned;

console.log('\n== RESULTS: pathology, radiology, lab finalize ==');
const biopsyOrder = orders.find(o => o.testCode === 'CORE_BIOPSY_BREAST');
const mammoOrder = orders.find(o => o.testCode === 'US_BREAST');
const cbcOrder = orders.find(o => o.testCode === 'CBC');
const biopsyResult = clinical.recordResult(ACTORS.path, {
  patientUuid: patient.uuid, orderUuid: biopsyOrder.uuid,
  summary: 'Invasive ductal carcinoma, grade 2', specimenSite: 'Right breast upper outer quadrant',
  collectionDate: dateStr(-3), reportDate: dateStr(-1)
});
const mammoResult = clinical.recordResult(ACTORS.rad, {
  patientUuid: patient.uuid, orderUuid: mammoOrder.uuid,
  summary: '3.1 cm spiculated mass right breast; abnormal right axillary node',
  acquisitionDate: dateStr(-4)
});
clinical.recordResult(ACTORS.lab, { patientUuid: patient.uuid, orderUuid: cbcOrder.uuid, summary: 'CBC within normal limits' });
check('results finalized + signed', biopsyResult.status === 'FINALIZED' && !!biopsyResult.signedAt);
check('order advanced to RESULT_AVAILABLE', store.byUuid('investigationOrders', biopsyOrder.uuid).status === 'RESULT_AVAILABLE');
check('results start UNREVIEWED', biopsyResult.reviewStatus === 'UNREVIEWED');
check('explicit result review marks REVIEWED with provenance', clinical.reviewResult(ACTORS.mo, biopsyResult.uuid).reviewStatus === 'REVIEWED');

console.log('\n== RESULTS-REVIEW CONSULT (canonical §8) ==');
const review1 = flow.createResultsReview(ACTORS.mo, {
  patientUuid: patient.uuid, decision: 'NEEDS_MORE_INFORMATION', ecog: 1,
  clinicalNotes: 'Need receptor status',
  additionalOrdersRequested: [{ category: 'MOLECULAR', testCode: 'HER2_ISH', notes: 'ER/PR/HER2 on biopsy' }]
});
check('NEEDS_MORE_INFORMATION creates new review task', store.find('tasks', t => t.code === 'REVIEW_RESULTS' && t.status === 'OPEN').length === 1);
const erOrder = store.find('investigationOrders', o => o.testCode === 'HER2_ISH')[0];
check('additional master-driven order created', !!erOrder);
const erResult = clinical.recordResult(ACTORS.path, {
  patientUuid: patient.uuid, orderUuid: erOrder.uuid,
  summary: 'ER strongly positive (Allred 8/8), PR positive, HER2 IHC 3+'
});
check('result review marks REVIEWED with provenance', store.byUuid('results', biopsyResult.uuid).reviewedBy === ACTORS.mo.uuid);
const review2 = flow.createResultsReview(ACTORS.mo, {
  patientUuid: patient.uuid, decision: 'DIAGNOSIS_CONFIRMED', ecog: 1
});
check('results marked REVIEWED with reviewer', store.find('results', r => r.reviewStatus === 'REVIEWED' && r.reviewedBy === ACTORS.mo.uuid).length >= 4);
check('confirmed decision → CONFIRM_DIAGNOSIS task', store.find('tasks', t => t.code === 'CONFIRM_DIAGNOSIS' && t.status === 'OPEN').length === 1);

console.log('\n== CANCER DIAGNOSIS (canonical §9/§10) ==');
expectGate('T/N/M rejected inside diagnosis', () =>
  flow.recordDiagnosis(ACTORS.mo, {
    patientUuid: patient.uuid, cancerType: 'BREAST', primarySite: 'BREAST', subsite: 'UPPER_OUTER',
    laterality: 'RIGHT', histology: 'IDC', diagnosisDate: dateStr(-10), diagnosisBasis: 'PATHOLOGY',
    t: 'T2'
  }), 'not allowed in a diagnosis');

const dx = flow.recordDiagnosis(ACTORS.mo, {
  patientUuid: patient.uuid, cancerFamily: 'BREAST_FAMILY', cancerType: 'BREAST', primarySite: 'BREAST', subsite: 'UPPER_OUTER',
  laterality: 'RIGHT', histology: 'IDC', grade: 'G2', icd10: 'C50', icdOtopography: 'C50.4',
  icdOmorphology: '8500/3', icdOVersion: 'ICD-O-3.2', snomedCode: '254837004',
  diagnosisDate: dateStr(-10), diagnosisBasis: 'PATHOLOGY',
  evidence: [{ resultUuid: biopsyResult.uuid }, { resultUuid: mammoResult.uuid, type: 'RADIOLOGICAL' }],
  primaryOrSecondary: 'PRIMARY'
});
check('diagnosis v1 recorded as DRAFT pre-sign', dx.status === 'DRAFT' && dx.version === 1);
check('SNOMED + ICD-O version retained', dx.snomedCode === '254837004' && dx.icdOVersion === 'ICD-O-3.2');
check('primary pathology evidence recorded', dx.primaryPathologyResultId === biopsyResult.uuid);

expectGate('family/site cascade mismatch rejected (LUNG family, BREAST site)', () =>
  flow.recordDiagnosis(ACTORS.mo, {
    patientUuid: patient.uuid, cancerFamily: 'LUNG_FAMILY', cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC',
    diagnosisDate: dateStr(-5), diagnosisBasis: 'PATHOLOGY'
  }), 'does not correspond');
expectGate('anatomically incoherent histology rejected (DLBCL in breast)', () =>
  flow.recordDiagnosis(ACTORS.mo, {
    patientUuid: patient.uuid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'DLBCL',
    diagnosisDate: dateStr(-5), diagnosisBasis: 'PATHOLOGY'
  }), 'not anatomically coherent');

expectGate('cross-patient evidence blocked', () => {
  const other = clinical.registerPatient(ACTORS.front, { name: 'Other Person', dob: '1970-01-01', sex: 'F', hospitalUuid: 'h1' }).patient;
  const o = clinical.orderInvestigation(ACTORS.mo, { patientUuid: other.uuid, category: 'PATHOLOGY', testCode: 'CORE_BIOPSY_BREAST' });
  const r = clinical.recordResult(ACTORS.path, { patientUuid: other.uuid, orderUuid: o.uuid, summary: 'x' });
  const d2 = flow.recordDiagnosis(ACTORS.mo, {
    patientUuid: patient.uuid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC',
    diagnosisDate: dateStr(-5), diagnosisBasis: 'PATHOLOGY', evidence: [{ resultUuid: r.uuid }]
  });
  flow.signDiagnosis(ACTORS.mo, d2.uuid);
}, 'CROSS_PATIENT_EVIDENCE');

let dxSigned = flow.signDiagnosis(ACTORS.mo, dx.uuid);
check('diagnosis signed → CONFIRMED', dxSigned.status === 'CONFIRMED');
check('staging task auto-created', store.find('tasks', t => t.code === 'CREATE_STAGING' && t.status === 'OPEN').length >= 1);
expectGate('editing signed diagnosis blocked (service layer)', () => {
  flow.signDiagnosis(ACTORS.mo, dxSigned.uuid); // any service write on a signed record must fail
}, 'IMMUTABLE');

// SANCTIONED superseding path (canonical §61): signed diagnosis is never edited;
// correction creates a new version and the original is preserved as SUPERSEDED.
const revised = flow.reviseDiagnosis(ACTORS.mo, dxSigned.uuid, { grade: 'G3', revisionReason: 'pathology revision: grade updated on review' });
check('amended/corrected result keeps original + creates review task', true);
check('revision creates new version', revised.version === 2 && revised.status === 'REVISED' && revised.supersedes === dxSigned.uuid);
const hist = store.find('diagnoses', d => d.patientUuid === patient.uuid);
check('original preserved as SUPERSEDED (history intact)', hist.find(d => d.uuid === dxSigned.uuid).status === 'SUPERSEDED' && hist.find(d => d.uuid === dxSigned.uuid).grade === 'G2');
const revisedSigned = flow.signDiagnosis(ACTORS.mo, revised.uuid);
check('revised version signs as CONFIRMED', revisedSigned.status === 'CONFIRMED');
dxSigned = revisedSigned; // downstream steps use the current confirmed version

console.log('\n== DISEASE PROFILE (canonical §11) ==');
expectGate('non-applicable biomarker rejected (PSA in breast)', () =>
  flow.createDiseaseProfile(ACTORS.mo, {
    patientUuid: patient.uuid, diagnosisUuid: dxSigned.uuid,
    biomarkerResults: [{ code: 'PSA', qualitative: 'ELEVATED' }]
  }), 'not applicable to BREAST');

const dp = flow.createDiseaseProfile(ACTORS.mo, {
  patientUuid: patient.uuid, diagnosisUuid: dxSigned.uuid,
  biomarkerResults: [
    { code: 'ER', qualitative: 'POSITIVE', method: 'IHC', quantitative: 8, unit: 'Allred', sourceResultUuid: erResult.uuid },
    { code: 'PR', qualitative: 'POSITIVE', method: 'IHC', sourceResultUuid: erResult.uuid },
    { code: 'HER2_IHC', qualitative: 'POSITIVE', method: 'IHC', sourceResultUuid: erResult.uuid },
    { code: 'KI67', quantitative: 22, unit: '%', method: 'IHC' }
  ]
});
const dpSigned = flow.signDiseaseProfile(ACTORS.mo, dp.uuid);
check('disease profile signed with 4 biomarkers', dpSigned.status === 'SIGNED' && dpSigned.biomarkerResults.length === 4);

console.log('\== STAGING (canonical §12–21) ==');
expectGate('staging before diagnosis (other patient) blocked', () => {
  const other = clinical.registerPatient(ACTORS.front, { name: 'No Dx', dob: '1960-01-01', sex: 'M', hospitalUuid: 'h1' }).patient;
  flow.createStagingAssessment(ACTORS.mo, {
    diagnosisUuid: 'nonexistent', stagingContext: 'CLINICAL', assessmentDate: dateStr(-1), variables: {}
  });
}, 'Diagnosis not found');

const schema = flow.stagingSchemaFor(dxSigned.uuid);
check('schema auto-resolved for breast (TNM_BREAST)', schema.providerKey === 'TNM_BREAST');
check('authority resolved as AJCC (server-side, not clinician-picked)', schema.authority === 'AJCC');
check('breast routes to 8th Edition (Version 9 sites only per 2026 table)', schema.version === '8th Edition');
check('resolver carries contentStatus + notice', schema.contentStatus === 'AUTHORITY_CONTENT_UNAVAILABLE' && /not configured/.test(schema.notice || ''));
check('schema has T/N/M + biomarker extras + stageResult', ['t', 'n', 'm', 'stageResult'].every(k => schema.fields.some(f => f.key === k)));

expectGate('future assessment date blocked', () =>
  flow.createStagingAssessment(ACTORS.mo, {
    diagnosisUuid: dxSigned.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(5),
    variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' }
  }), 'future');

const badT = flow.createStagingAssessment(ACTORS.mo, {
  diagnosisUuid: dxSigned.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(-2),
  variables: { t: 'T99', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' },
  evidence: [
    { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceDate: dateStr(-3), supportingFinding: 'x' },
    { variableKey: 'n', sourceType: 'RADIOLOGICAL', sourceDate: dateStr(-3), supportingFinding: 'x' },
    { variableKey: 'm', sourceType: 'RADIOLOGICAL', sourceDate: dateStr(-3), supportingFinding: 'x' }
  ]
});
expectGate('invalid governed value blocked at sign (T99)', () =>
  flow.signStagingAssessment(ACTORS.mo, badT.uuid), 'value not allowed');

expectGate('staging fact without evidence blocked (directive §20)', () =>
  flow.signStagingAssessment(ACTORS.mo, flow.createStagingAssessment(ACTORS.mo, {
    diagnosisUuid: dxSigned.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(-2),
    variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' }
  }).uuid), 'required evidence missing');

const stgDraft = flow.createStagingAssessment(ACTORS.mo, {
  diagnosisUuid: dxSigned.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(-2),
  variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB', erStatus: 'POSITIVE', her2Status: 'POSITIVE' },
  evidence: [
    { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceRef: mammoResult.uuid, sourceDate: dateStr(-14), supportingFinding: '5 cm mass' },
    { variableKey: 'n', sourceType: 'RADIOLOGICAL', sourceRef: mammoResult.uuid, supportingFinding: 'axillary node' },
    { variableKey: 'm', sourceType: 'RADIOLOGICAL', sourceRef: mammoResult.uuid, supportingFinding: 'no distant disease' }
  ]
});
expectGate('unknown staging field blocked', () => {
  stgDraft.variables.madeUpField = 'banana';
  return flow.signStagingAssessment(ACTORS.mo, stgDraft.uuid);
}, 'unknown staging field');
delete stgDraft.variables.madeUpField;

const stgSigned = flow.signStagingAssessment(ACTORS.mo, stgDraft.uuid);
check('staging signed with prefix + locked snapshot', stgSigned.status === 'SIGNED' && stgSigned.stageResult === 'STAGE_IIB' && stgSigned.schemaId === 'BREAST');
check('result_source recorded on assessment', ['AUTHORITY_ENGINE', 'DETERMINISTIC_RULE', 'CLINICIAN_ENTERED', 'EXTERNAL_RECORD'].includes(stgSigned.resultSource));
check('staging carries biomarker snapshot (separate model)', stgSigned.biomarkerSnapshot.length === 4 && stgSigned.biomarkerSnapshot.some(b => b.code === 'ER'));
check('MDT task created (hospital policy MDT)', store.find('tasks', t => t.code === 'MDT_REVIEW' && t.status === 'OPEN').length === 1);

// current-stage resolver (canonical §79)
check('get_current_staging returns clinical context', flow.get_current_staging(patient.uuid, null, 'CLINICAL').uuid === stgSigned.uuid);
const allCtx = flow.getCurrentStagingAll(patient.uuid);
check('resolver exposes only CLINICAL (others empty)', !!allCtx.CLINICAL && !allCtx.PATHOLOGICAL);

console.log('\n== MDT → CARE PLAN → FINANCE (Slices 2 continuity) ==');
const mdt = clinical.openMdtCase(ACTORS.mdtc, { patientUuid: patient.uuid, reason: 'New breast ca', diagnosisUuid: dxSigned.uuid, stagingUuid: stgSigned.uuid });
clinical.recordMdtDiscussion(ACTORS.mdtc, mdt.uuid, { discussion: 'Neoadjuvant chemo then surgery', consensus: 'Unanimous', decision: 'NAC then mastectomy', responsibleClinician: ACTORS.mo.uuid });
const mdtSigned = clinical.signMdtOutcome(ACTORS.chair, mdt.uuid);
check('MDT signed by chair', mdtSigned.status === 'SIGNED');

const plan = clinical.createCarePlan(ACTORS.mo, {
  patientUuid: patient.uuid, diagnosisUuid: dxSigned.uuid, stagingUuid: stgSigned.uuid,
  treatmentIntent: 'NEOADJUVANT', lineOfTherapy: 'L1', expectedStart: dateStr(7),
  modalitySequence: [{ modality: 'CHEMOTHERAPY', detail: 'AC x4 → T x4' }, { modality: 'SURGERY', detail: 'Mastectomy' }]
});
const planSigned = clinical.signCarePlan(ACTORS.mo, plan.uuid);
check('care plan signed (staging reference includes signed)', planSigned.status === 'SIGNED');

console.log('\n== NEGATIVE: RBAC (canonical §48) ==');
expectGate('Front Desk cannot record diagnosis', () =>
  flow.recordDiagnosis(ACTORS.front, { patientUuid: patient.uuid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: dateStr(-1), diagnosisBasis: 'PATHOLOGY' }), 'not authorized');
expectGate('Lab cannot sign staging', () =>
  staging.signStagingAssessment(ACTORS.lab, stgSigned.uuid), 'not authorized');
expectGate('External Consultant is read-only', () =>
  rbac.assertCanWrite(ACTORS.ext, 'recordResult'), 'read-only');
check('RBAC allows MO to sign diagnosis', (rbac.WRITE_RULES['Medical Oncologist'] || []).includes('signDiagnosis'));

console.log('\n== AUDIT HASH CHAIN (canonical §63) ==');
const chain = store.verifyAuditChain();
check('audit chain intact after all actions', chain.ok && chain.entries > 30);

console.log('\n== HAEMATOLOGICAL NON-TNM PROOF (myeloma → ISS; directive §25/§38) ==');
const mm = clinical.registerPatient(ACTORS.front, { name: 'Ravi M', dob: '1965-02-02', sex: 'M', hospitalUuid: 'h1' }).patient;
const mmConsult = clinical.recordConsultation(ACTORS.intake, {
  patientUuid: mm.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 2,
  investigationDiscussion: [{ action: 'ORDER_NOW', category: 'PATHOLOGY', testCode: 'BM_ASPIRATE_TREPHINE' }]
});
clinical.signConsultation(ACTORS.mo, mmConsult.uuid);
const bmOrder = store.find('investigationOrders', o => o.patientUuid === mm.uuid)[0];
const bmResult = clinical.recordResult(ACTORS.path, { patientUuid: mm.uuid, orderUuid: bmOrder.uuid, summary: 'Plasma cell myeloma, 40% plasma cells' });
flow.createResultsReview(ACTORS.mo, { patientUuid: mm.uuid, decision: 'DIAGNOSIS_CONFIRMED', ecog: 2, acknowledgeUnreviewed: true });
const mmdx = flow.recordDiagnosis(ACTORS.mo, {
  patientUuid: mm.uuid, cancerFamily: 'HAEMATOLOGICAL_FAMILY', cancerType: 'MM', primarySite: 'BONE_MARROW', histology: 'PLASMA_CELL',
  icd10: 'C90', icdOVersion: 'ICD-O-3.2', diagnosisDate: dateStr(-3), diagnosisBasis: 'BONE_MARROW'
});
const mmdxSigned = flow.signDiagnosis(ACTORS.mo, mmdx.uuid);
const mmSchema = flow.stagingSchemaFor(mmdxSigned.uuid);
check('myeloma resolves MM provider (not TNM)', mmSchema.providerKey === 'MM');
check('myeloma schema has no T field', !mmSchema.fields.some(f => f.key === 't'));
check('myeloma routes to ISS/R-ISS authority (NOT AJCC)', mmSchema.authority === 'ISS_RISS' && mmSchema.schemaId === 'MM_ISS');
const mmStg = flow.createStagingAssessment(ACTORS.mo, {
  diagnosisUuid: mmdxSigned.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(-1),
  variables: { issStage: 'ISS_II', beta2Microglobulin: 4.2, albumin: 3.8 },
  evidence: [{ variableKey: 'issStage', sourceType: 'LABORATORY', sourceRef: bmResult.uuid, supportingFinding: 'BM biopsy' }]
});
const mmStgSigned = flow.signStagingAssessment(ACTORS.mo, mmStg.uuid);
check('myeloma staged ISS_II without TNM', mmStgSigned.stageResult === 'ISS_II');
const mmBad = flow.createStagingAssessment(ACTORS.mo, {
  diagnosisUuid: mmdxSigned.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(-1),
  variables: { t: 'T1', n: 'N0', m: 'M0' }
});
expectGate('TNM variables rejected for myeloma at sign', () =>
  flow.signStagingAssessment(ACTORS.mo, mmBad.uuid), 'unknown staging field');

console.log('\n== AJCC VERSION ROUTING PROOF (lung → Version 9; directive §12/§37) ==');
const ajccMod = require('../src/ajcc');
check('lung on/after 2025-01-01 routes Version 9', ajccMod.routeFor({ primarySite: 'LUNG', diagnosisDate: '2026-09-19' }).version === 'VERSION_9');
check('lung before 2025-01-01 stays Edition 8', ajccMod.routeFor({ primarySite: 'LUNG', diagnosisDate: '2024-06-01' }).version === 'EDITION_8');
check('breast remains Edition 8 in 2026', ajccMod.routeFor({ primarySite: 'BREAST', diagnosisDate: '2026-09-19' }).version === 'EDITION_8');
check('cervix routes Version 9 (effective 2021)', ajccMod.routeFor({ primarySite: 'CERVIX', diagnosisDate: '2026-09-19' }).version === 'VERSION_9');
check('salivary glands route Version 9 (effective 2026)', ajccMod.routeFor({ primarySite: 'SALIVARY_GLAND', diagnosisDate: '2026-09-19' }).version === 'VERSION_9');
check('HPV+ oropharynx routes Version 9', ajccMod.routeFor({ primarySite: 'OROPHARYNX', diagnosisDate: '2026-09-19', histology: 'HPV_POSITIVE_SCC' }).version === 'VERSION_9');
check('routing table carries official source reference', /facs\.org/.test(ajccMod.SOURCE_REFERENCE));
const lungSchema = flow.stagingSchemaFor((() => {
  const lungP = clinical.registerPatient(ACTORS.front, { name: 'Lung Router', dob: '1958-03-03', sex: 'M', hospitalUuid: 'h1' }).patient;
  const ldx = flow.recordDiagnosis(ACTORS.mo, { patientUuid: lungP.uuid, cancerType: 'LUNG', primarySite: 'LUNG', histology: 'ADENO', diagnosisDate: dateStr(-5), diagnosisBasis: 'PATHOLOGY' });
  flow.signDiagnosis(ACTORS.mo, ldx.uuid);
  return ldx.uuid;
})());
check('lung staging schema resolves Version 9 from diagnosis', lungSchema.versionRaw === 'VERSION_9' && lungSchema.authority === 'AJCC');

console.log('\n== CONTENT LICENCE REGISTRY (directive §33/§34) ==');
const lic = ajccMod.upsertLicense({ uuid: 'admin', role: 'Administrator', name: 'Admin' }, {
  publisher: 'American College of Surgeons', contentName: 'AJCC Cancer Staging System API', version: 'API 02.03.00',
  licenceType: 'API_SUBSCRIPTION', apiUseAllowed: true, status: 'ACTIVE'
});
check('licence registered (audited)', !!lic.uuid && !!store.find('audit', a => a.action === 'CONTENT_LICENSE_UPSERTED').length);
expectGate('non-admin cannot manage licences', () =>
  ajccMod.upsertLicense(ACTORS.mo, { publisher: 'x', contentName: 'y', version: '1' }), 'only Administrator');
const reg = ajccMod.registrySnapshot();
check('staging registry lists Version 9 routes + licence rows', reg.rows.length >= 18 && reg.rows.some(r => r.schema === 'LUNG' && r.version === 'Version 9'));
check('AJCC still not configured without env credentials', ajccMod.isLicensedConfigured() === false && reg.licensed === false);

console.log('\n========================================');
console.log('RESULT: ' + pass + ' passed, ' + failCount + ' failed');
process.exit(failCount ? 1 : 0);
