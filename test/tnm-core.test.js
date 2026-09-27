// CCA OS — AJCC TNM core engine tests (mandate §39 negative + history positives)
// Run: node test/tnm-core.test.js   (services exercised directly; server not required)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-tnmcore-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const flow = require('../src/clinical-flow');
const tnm = require('../src/tnm');

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
function d(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

store.load();
masters.seedMasters();
store.insert('hospitals', { uuid: 'h1', name: 'TNM Core Test', mdtPolicy: { TNM_BREAST: 'DIRECT_PLAN' } });

const front = { uuid: 't-front', name: 'Front', role: 'Front Desk' };
const intake = { uuid: 't-intake', name: 'Intake', role: 'Intake Nurse' };
const onc = { uuid: 't-onc', name: 'Dr. T', role: 'Medical Oncologist' };
const path_ = { uuid: 't-path', name: 'Dr. P', role: 'Pathologist' };
const rad = { uuid: 't-rad', name: 'Dr. R', role: 'Radiologist' };

console.log('== Setup: breast patient to confirmed diagnosis ==');
const { patient } = clinical.registerPatient(front, { name: 'Cee Tee', dob: '1972-02-02', sex: 'F', hospitalUuid: 'h1' });
clinical.recordConsultation(intake, {
  patientUuid: patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 1,
  investigationDiscussion: [{ action: 'ORDER_NOW', category: 'PATHOLOGY', testCode: 'CORE_BIOPSY_BREAST' }]
});
clinical.signConsultation(onc, store.find('consultations', c => c.patientUuid === patient.uuid)[0].uuid);
const biopOrder = store.find('investigationOrders', o => o.patientUuid === patient.uuid)[0];
const biopResult = clinical.recordResult(path_, { patientUuid: patient.uuid, orderUuid: biopOrder.uuid, summary: 'IDC grade 2, ER+ PR+ HER2-' });
const review = flow.createResultsReview(onc, { patientUuid: patient.uuid, decision: 'DIAGNOSIS_CONFIRMED', ecog: 1 });
const dx = flow.recordDiagnosis(onc, { patientUuid: patient.uuid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: d(-10), diagnosisBasis: 'PATHOLOGY', evidence: [{ resultUuid: biopResult.uuid }] });
flow.signDiagnosis(onc, dx.uuid);

const mkStaging = (vars, ev) => clinical.createStagingAssessment(onc, {
  diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: d(0), variables: vars, evidence: ev || []
});
const cEv = [
  { variableKey: 't', sourceType: 'CLINICAL', sourceDate: d(-2), supportingFinding: 'palpable 3cm mass' },
  { variableKey: 'n', sourceType: 'CLINICAL', sourceDate: d(-2), supportingFinding: 'mobile axillary node' },
  { variableKey: 'm', sourceType: 'CLINICAL', sourceDate: d(-2), supportingFinding: 'no distant disease on exam + history' }
];

console.log('\n== §7/§39 M-category safety ==');
expectGate('MX rejected (mandate: MX is invalid)', () =>
  clinical.signStagingAssessment(onc, mkStaging({ t: 'T2', n: 'N1', m: 'MX', stageResult: 'STAGE_IIB' }, cEv).uuid), 'MX');
expectGate('arbitrary M value rejected (M7)', () =>
  clinical.signStagingAssessment(onc, mkStaging({ t: 'T2', n: 'N1', m: 'M7', stageResult: 'STAGE_IIB' }, cEv).uuid), 'not allowed');
check('MX absent from governed masters', !masters.getMaster('m').some(i => i.code === 'MX'));

console.log('\n== §39 arbitrary category values ==');
expectGate('arbitrary T value rejected (banana)', () =>
  clinical.signStagingAssessment(onc, mkStaging({ t: 'banana', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' }, cEv).uuid), 'not allowed');
expectGate('arbitrary N value rejected (ZZ9)', () =>
  clinical.signStagingAssessment(onc, mkStaging({ t: 'T2', n: 'ZZ9', m: 'M0', stageResult: 'STAGE_IIB' }, cEv).uuid), 'not allowed');
expectGate('fabricated stage group rejected (Stage 99)', () =>
  clinical.signStagingAssessment(onc, mkStaging({ t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_99' }, cEv).uuid), 'not allowed');

console.log('\n== §9 NO pM0 ==');
const pEv = [
  { variableKey: 't', sourceType: 'PATHOLOGICAL', sourceRef: biopResult.uuid, supportingFinding: 'specimen' },
  { variableKey: 'n', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'nodes negative' }
];
expectGate('pM0 rejected — M0 cannot exist in pathological classification', () =>
  clinical.signStagingAssessment(onc, clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N0', m: 'M0', stageResult: 'STAGE_IIB' }, evidence: pEv
  }).uuid), 'pM0 does not exist');
expectGate('pM1 without pathological evidence rejected', () =>
  clinical.signStagingAssessment(onc, clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N0', m: 'M1', stageResult: 'STAGE_IV' },
    evidence: [{ variableKey: 't', sourceType: 'PATHOLOGICAL', sourceRef: biopResult.uuid, supportingFinding: 'x' },
               { variableKey: 'n', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' },
               { variableKey: 'm', sourceType: 'CLINICAL', sourceDate: d(-1), supportingFinding: 'felt lump in liver' }]
  }).uuid), 'pM1 requires pathological demonstration');
// pM1 WITH pathology evidence signs
const pm1 = clinical.createStagingAssessment(onc, {
  diagnosisUuid: dx.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: d(0),
  variables: { t: 'T2', n: 'N0', m: 'M1', stageResult: 'STAGE_IV' },
  evidence: [
    { variableKey: 't', sourceType: 'PATHOLOGICAL', sourceRef: biopResult.uuid, supportingFinding: 'primary specimen' },
    { variableKey: 'n', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'nodes negative' },
    { variableKey: 'm', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'liver biopsy: metastatic adenocarcinoma, breast primary' }
  ]
});
check('pM1 with pathological evidence signs', clinical.signStagingAssessment(onc, pm1.uuid).stageResult === 'STAGE_IV');

console.log('\n== §13 staging window ==');
expectGate('evidence dated AFTER assessment rejected (not in staging window)', () =>
  clinical.signStagingAssessment(onc, mkStaging({ t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' }, [
    { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceDate: d(5), supportingFinding: 'future MRI' },
    { variableKey: 'n', sourceType: 'CLINICAL', sourceDate: d(-2), supportingFinding: 'x' },
    { variableKey: 'm', sourceType: 'CLINICAL', sourceDate: d(-2), supportingFinding: 'x' }
  ]).uuid), 'staging window');

console.log('\n== §2/§4 classification enum ==');
expectGate('NON_TNM context rejected for a TNM schema', () =>
  clinical.signStagingAssessment(onc, clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'NON_TNM', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' }, evidence: cEv
  }).uuid), 'classification is mandatory');
expectGate('unknown classification rejected', () =>
  clinical.signStagingAssessment(onc, clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'TELEPATHY', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' }, evidence: cEv
  }).uuid), 'stagingContext');

console.log('\n== §3/§11 classification history: cTNM → pTNM → ypTNM coexist ==');
const ctnm = mkStaging({ t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' }, cEv);
clinical.signStagingAssessment(onc, ctnm.uuid);
const ptnm = clinical.createStagingAssessment(onc, {
  diagnosisUuid: dx.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: d(0),
  variables: { t: 'T2', n: 'N0', stageResult: 'STAGE_IIA' }, evidence: pEv
});
clinical.signStagingAssessment(onc, ptnm.uuid);
const yctnm = clinical.createStagingAssessment(onc, {
  diagnosisUuid: dx.uuid, stagingContext: 'POSTTHERAPY_CLINICAL', assessmentDate: d(0),
  variables: { t: 'T1', n: 'N0', m: 'M0', stageResult: 'STAGE_IIA' }, evidence: cEv
});
clinical.signStagingAssessment(onc, yctnm.uuid);
const yptnm = clinical.createStagingAssessment(onc, {
  diagnosisUuid: dx.uuid, stagingContext: 'POSTTHERAPY_PATHOLOGICAL', assessmentDate: d(0),
  variables: { t: 'T1', n: 'N0', stageResult: 'STAGE_IA' }, evidence: pEv
});
clinical.signStagingAssessment(onc, yptnm.uuid);

const hist = store.find('stagingAssessments', s => s.patientUuid === patient.uuid && s.diagnosisUuid === dx.uuid && s.status === 'SIGNED');
check('cTNM remains after pTNM and ypTNM (never overwritten)', hist.some(s => s.stagingContext === 'CLINICAL' && s.variables.t === 'T2'));
check('pTNM remains after ypTNM', hist.some(s => s.stagingContext === 'PATHOLOGICAL' && s.variables.n === 'N0'));
check('ycTNM stored separately', hist.some(s => s.stagingContext === 'POSTTHERAPY_CLINICAL'));
check('ypTNM stored separately', hist.some(s => s.stagingContext === 'POSTTHERAPY_PATHOLOGICAL'));
check('classification prefixes recorded (c/p/yc/yp)', hist.every(s => s.classificationPrefix));
check('no pM0 serialized anywhere (§9 invariant)', !hist.some(s => ['PATHOLOGICAL', 'POSTTHERAPY_PATHOLOGICAL', 'AUTOPSY'].includes(s.stagingContext) && s.variables.m === 'M0'));
check('pM1 assessment serialized correctly with pathological M', hist.some(s => s.stagingContext === 'PATHOLOGICAL' && s.variables.m === 'M1'));
check('aTNM prefix defined in enum', tnm.classificationPrefix('AUTOPSY') === 'a');
check('recurrence prefix is r', tnm.classificationPrefix('RECURRENCE_RETREATMENT') === 'r');

console.log('\n== §34 per-classification current-stage summary ==');
const summary = flow.getStagingSummary(patient.uuid);
check('summary keeps clinical separate', summary.clinical && summary.clinical.stage === 'STAGE_IIB');
check('summary keeps pathological separate', summary.pathological && summary.pathological.stage === 'STAGE_IIA');
check('summary keeps posttherapyClinical separate', summary.posttherapyClinical && summary.posttherapyClinical.stage === 'STAGE_IIA');
check('summary keeps posttherapyPathological separate', summary.posttherapyPathological && summary.posttherapyPathological.stage === 'STAGE_IA');
check('summary exposes prefixes', summary.clinical.prefix === 'c' && summary.pathological.prefix === 'p');

console.log('\n== §26 insufficient information (no fabricated stage) ==');
const insuf = tnm.insufficientInformation(['Regional node category']);
check('INSUFFICIENT_INFORMATION carries missing facts', insuf.stageGroupStatus === 'INSUFFICIENT_INFORMATION' && insuf.missing.includes('Regional node category'));

console.log('\n== §39 signed assessment immutability ==');
expectGate('signed staging cannot be re-signed/modified', () =>
  clinical.signStagingAssessment(onc, ctnm.uuid), 'IMMUTABLE');

console.log('\n== Audit chain ==');
const chain = store.verifyAuditChain();
check('audit chain intact', chain.ok && chain.entries > 20);

console.log('\n========================================');
console.log('RESULT: ' + pass + ' passed, ' + failCount + ' failed');
process.exit(failCount ? 1 : 0);
