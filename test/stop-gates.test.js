// CCA OS — Stop-gate negative-path unit tests (no server needed)
// Uses the service layer directly with an isolated data directory.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-stoptest-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const wf = require('../src/workflow');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const treatment = require('../src/treatment');
const consent = require('../src/consent');

let passes = 0, failures = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log('  ✓ ' + name);
  } catch (e) {
    if (e && e.expected) { passes++; console.log('  ✓ ' + name); }
    else { failures++; console.log('  ✗ FAIL: ' + name + ' — ' + e.message); }
  }
}
// helper: expect a stop-gate rejection
function expectGate(fn) {
  return () => {
    try { fn(); } catch (e) {
      if (e.code === 'STOP_GATE' || e.code === 'IMMUTABLE' || /required|not allowed|must be|Unknown governed|Invalid|does not belong|future|not found/i.test(e.message)) {
        e.expected = true;
      }
      throw e;
    }
    throw new Error('expected rejection but call succeeded');
  };
}

consent.seedConsentTemplates(); // direct-service tests bypass the server boot seeding

const onc = { uuid: 'u-onc1', name: 'Dr. Sharma', role: 'Medical Oncologist' };
const front = { uuid: 'u-front', name: 'Fatima', role: 'Front Desk' };
const pharm = { uuid: 'u-pharm', name: 'Mei', role: 'Pharmacist' };
const nurse = { uuid: 'u-daycare', name: 'Sarah', role: 'Day Care Nurse' };
const fin = { uuid: 'u-fin', name: 'Ravi', role: 'Financial Counsellor' };
const lab = { uuid: 'u-lab', name: 'Luis', role: 'Lab' };
const pathologist = { uuid: 'u-path', name: 'Mbeki', role: 'Pathologist' };
const radiologist = { uuid: 'u-rad', name: 'Petit', role: 'Radiologist' };
const navigator = { uuid: 'u-nav', name: 'Amina', role: 'Nurse Navigator' };
const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toISOString().slice(0, 10); };

store.load();
masters.seedMasters();
store.insert('hospitals', { uuid: 'h-test', organisation: 'CCA', name: 'Test Hospital', mdtPolicy: {} });

console.log('== Data integrity stop-gates ==');

check('registration requires name/dob/sex',
  expectGate(() => clinical.registerPatient(front, { name: 'X', dob: '', sex: '', hospitalUuid: 'h-test' })));

const reg = clinical.registerPatient(front, { name: 'Gate Tester', dob: '1970-01-01', sex: 'F', hospitalUuid: 'h-test' });
const pid = reg.patient.uuid;

check('staging blocked before signed diagnosis',
  expectGate(() => clinical.stagingSchemaFor('no-such-diagnosis')));

const dx = clinical.recordDiagnosis(onc, {
  patientUuid: pid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC',
  diagnosisDate: d(-10), diagnosisBasis: 'PATHOLOGY'
});

check('unknown governed cancerType rejected',
  expectGate(() => clinical.recordDiagnosis(onc, { patientUuid: pid, cancerType: 'ZZZ', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: d(-1), diagnosisBasis: 'PATHOLOGY' })));

check('subsite/site mismatch rejected',
  expectGate(() => clinical.recordDiagnosis(onc, { patientUuid: pid, cancerType: 'BREAST', primarySite: 'LUNG', subsite: 'UPPER_OUTER', histology: 'IDC', diagnosisDate: d(-1), diagnosisBasis: 'PATHOLOGY' })));

check('T/N/M inside diagnosis rejected',
  expectGate(() => clinical.recordDiagnosis(onc, { patientUuid: pid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: d(-1), diagnosisBasis: 'PATHOLOGY', t: 'T2' })));

check('future diagnosis date rejected',
  expectGate(() => clinical.recordDiagnosis(onc, { patientUuid: pid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: d(30), diagnosisBasis: 'PATHOLOGY' })));

const signedDx = clinical.signDiagnosis(onc, dx.uuid);

check('signed diagnosis is immutable (re-sign rejected)',
  expectGate(() => clinical.signDiagnosis(onc, dx.uuid)));

check('staging requires SIGNED diagnosis',
  expectGate(() => clinical.createStagingAssessment(onc, { diagnosisUuid: 'missing', stagingContext: 'CLINICAL', assessmentDate: d(0), variables: {} })));

check('fabricated staging value rejected at signing', () => {
  const a = clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: d(0),
    variables: { t: 'T99', n: 'N0', m: 'M0', stageResult: 'STAGE_I' },
    evidence: [
      { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'test tumour' },
      { variableKey: 'n', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'test nodes' },
      { variableKey: 'm', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'no distant spread' }
    ]
  });
  try { clinical.signStagingAssessment(onc, a.uuid); } catch (e) { e.expected = true; throw e; }
  throw new Error('expected rejection');
});

check('unknown staging field rejected at signing', () => {
  const a = clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N0', m: 'M0', stageResult: 'STAGE_I', unicornField: 'x' },
    evidence: [
      { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' },
      { variableKey: 'n', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' },
      { variableKey: 'm', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' }
    ]
  });
  try { clinical.signStagingAssessment(onc, a.uuid); } catch (e) { e.expected = true; throw e; }
  throw new Error('expected rejection');
});

check('future assessment date rejected',
  expectGate(() => clinical.createStagingAssessment(onc, { diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: d(5), variables: { t: 'T2', n: 'N0', m: 'M0', stageResult: 'STAGE_I' } })));

const stg = clinical.createStagingAssessment(onc, {
  diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: d(0),
  variables: { t: 'T2', n: 'N0', m: 'M0', stageResult: 'STAGE_II' },
  evidence: [
    { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: '2.1 cm spiculated mass' },
    { variableKey: 'n', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'no axillary nodes' },
    { variableKey: 'm', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'no distant metastases' }
  ]
});
const stgSigned = clinical.signStagingAssessment(onc, stg.uuid);

check('T category without linked evidence is rejected (directive §20)',
  expectGate(() => clinical.signStagingAssessment(onc, clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N0', m: 'M0', stageResult: 'STAGE_II' }
  }).uuid)));

check('evidence citing unknown staging field rejected',
  expectGate(() => clinical.signStagingAssessment(onc, clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N0', m: 'M0', stageResult: 'STAGE_II' },
    evidence: [
      { variableKey: 't', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' },
      { variableKey: 'n', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' },
      { variableKey: 'm', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' },
      { variableKey: 'teapot', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), sourceRef: null, supportingFinding: 'x' }
    ]
  }).uuid)));

// cross-patient supersession
const reg2 = clinical.registerPatient(front, { name: 'Second Patient', dob: '1975-05-05', sex: 'M', hospitalUuid: 'h-test' });
const dx2 = clinical.recordDiagnosis(onc, { patientUuid: reg2.patient.uuid, cancerType: 'LUNG', primarySite: 'LUNG', histology: 'NSCLC_NOS', diagnosisDate: d(-2), diagnosisBasis: 'IMAGING' });
clinical.signDiagnosis(onc, dx2.uuid);

check('cross-patient supersession rejected', () => {
  const a = clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx2.uuid, stagingContext: 'CLINICAL', assessmentDate: d(0), supersedes: stg.uuid,
    variables: { t: 'T1', n: 'N0', m: 'M0', stageResult: 'STAGE_I' },
    evidence: [
      { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' },
      { variableKey: 'n', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' },
      { variableKey: 'm', sourceType: 'RADIOLOGICAL', sourceDate: d(-1), supportingFinding: 'x' }
    ]
  });
  try { clinical.signStagingAssessment(onc, a.uuid); } catch (e) { e.expected = true; throw e; }
  throw new Error('expected rejection');
});

check('restaging of same patient supersedes correctly', () => {
  const a = clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: d(0), supersedes: stg.uuid,
    variables: { t: 'T2', n: 'N1', stageResult: 'STAGE_IIB' }, // no pM0 — M stays with the clinical assessment (§9)
    evidence: [
      { variableKey: 't', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'specimen' },
      { variableKey: 'n', sourceType: 'PATHOLOGICAL', sourceDate: d(-1), supportingFinding: 'nodes positive' }
    ]
  });
  const s = clinical.signStagingAssessment(onc, a.uuid);
  if (s.status !== 'SIGNED') throw new Error('not signed');
  const prev = store.byUuid('stagingAssessments', stg.uuid);
  if (prev.status !== 'SUPERSEDED') throw new Error('previous not superseded');
});

check('care plan blocked without signed staging (patient 2)',
  expectGate(() => clinical.createCarePlan(onc, { patientUuid: reg2.patient.uuid, diagnosisUuid: dx2.uuid, treatmentIntent: 'CURATIVE', lineOfTherapy: 'L1', expectedStart: d(3) })));

check('care plan blocked for unknown staging uuid',
  expectGate(() => clinical.createCarePlan(onc, { patientUuid: pid, diagnosisUuid: dx.uuid, stagingUuid: 'missing', treatmentIntent: 'CURATIVE', lineOfTherapy: 'L1', expectedStart: d(3) })));

const plan = clinical.createCarePlan(onc, {
  patientUuid: pid, diagnosisUuid: dx.uuid, stagingUuid: stgSigned.uuid,
  treatmentIntent: 'CURATIVE', lineOfTherapy: 'L1', expectedStart: d(3)
});
const planSigned = clinical.signCarePlan(onc, plan.uuid);

check('finance blocked without signed care plan',
  expectGate(() => clinical.recordFinancialCounselling(fin, { carePlanUuid: 'missing', plannedTreatment: 'x', costEstimate: 1, payerType: 'SELF_PAY', patientChoice: 'ORIGINATOR' })));

const fc = clinical.recordFinancialCounselling(fin, {
  carePlanUuid: plan.uuid, plannedTreatment: 'AC x4', costEstimate: 100000, payerType: 'SELF_PAY',
  patientChoice: 'BIOSIMILAR', financialClearance: 'CLEARED'
});

check('non-self-pay without authorization number rejected at signing', () => {
  const fc2 = clinical.recordFinancialCounselling(fin, {
    carePlanUuid: plan.uuid, plannedTreatment: 'x', costEstimate: 10, payerType: 'INSURER',
    authorization: { number: '', status: 'PENDING' }, patientChoice: 'ORIGINATOR'
  });
  try { clinical.signFinancialCounselling(onc, fc2.uuid); } catch (e) { e.expected = true; throw e; }
  throw new Error('expected rejection');
});

clinical.signFinancialCounselling(fin, fc.uuid);

check('readiness blocked without financial clearance',
  expectGate(() => clinical.recordReadiness(navigator, { fcUuid: 'missing', checks: { labsCurrent: true, consentTaken: true, accessDevice: true, patientEducated: true } })));

check('readiness requires all checklist items',
  expectGate(() => clinical.recordReadiness(navigator, { fcUuid: fc.uuid, checks: { labsCurrent: true, consentTaken: false, accessDevice: true, patientEducated: true } })));

// D2: consent stop-gates
check('readiness blocked without SIGNED consent (D2 gate)',
  expectGate(() => clinical.recordReadiness(navigator, { fcUuid: fc.uuid, checks: { labsCurrent: true, consentTaken: true, accessDevice: true, patientEducated: true } })));

check('consent blocked without care plan reference',
  expectGate(() => consent.recordConsent(onc, { patientUuid: pid, templateCode: 'SYSTEMIC_THERAPY_V1', consentType: 'SYSTEMIC_THERAPY', discussedRisks: 'r', discussedBenefits: 'b', discussedAlternatives: 'a', acknowledgedBy: 'Patient' })));

check('consent blocked with unknown governed template',
  expectGate(() => consent.recordConsent(onc, { patientUuid: pid, carePlanUuid: plan.uuid, templateCode: 'MADE_UP_TEMPLATE', consentType: 'SYSTEMIC_THERAPY', discussedRisks: 'r', discussedBenefits: 'b', discussedAlternatives: 'a', acknowledgedBy: 'Patient' })));

check('consent blocked for another patients care plan',
  expectGate(() => consent.recordConsent(onc, { patientUuid: reg2.patient.uuid, carePlanUuid: plan.uuid, templateCode: 'SYSTEMIC_THERAPY_V1', consentType: 'SYSTEMIC_THERAPY', discussedRisks: 'r', discussedBenefits: 'b', discussedAlternatives: 'a', acknowledgedBy: 'Patient' })));

const consentRec = consent.recordConsent(onc, { patientUuid: pid, carePlanUuid: plan.uuid, templateCode: 'SYSTEMIC_THERAPY_V1', consentType: 'SYSTEMIC_THERAPY', discussedRisks: 'Myelosuppression', discussedBenefits: 'Cure intent', discussedAlternatives: 'Observation', acknowledgedBy: 'Patient' });
check('consent version stamped from template', () => {
  if (consentRec.templateVersion !== '1.0') throw new Error('template version missing: ' + consentRec.templateVersion);
});
consent.signConsent(onc, consentRec.uuid);

check('signed consent immutable (re-sign blocked)',
  expectGate(() => consent.signConsent(onc, consentRec.uuid)));

clinical.recordReadiness(navigator, { fcUuid: fc.uuid, checks: { labsCurrent: true, consentTaken: true, accessDevice: true, patientEducated: true } });

console.log('== Treatment execution stop-gates ==');

check('treatment order blocked without readiness',
  expectGate(() => treatment.createTreatmentOrder(onc, { patientUuid: reg2.patient.uuid, carePlanUuid: 'x', regimenCode: 'AC', plannedCycles: 2, weight: 70, height: 170, startDate: d(0) })));

check('treatment order blocked with unknown regimen',
  expectGate(() => treatment.createTreatmentOrder(onc, { patientUuid: pid, carePlanUuid: plan.uuid, regimenCode: 'NOPE', plannedCycles: 2, weight: 70, height: 170, startDate: d(0) })));

check('treatment order blocked with missing weight/height',
  expectGate(() => treatment.createTreatmentOrder(onc, { patientUuid: pid, carePlanUuid: plan.uuid, regimenCode: 'AC', plannedCycles: 2, weight: null, height: null, startDate: d(0) })));

check('dose reduction requires a reason',
  expectGate(() => treatment.createTreatmentOrder(onc, { patientUuid: pid, carePlanUuid: plan.uuid, regimenCode: 'AC', plannedCycles: 2, weight: 68, height: 163, startDate: d(0), reductions: [{ medication: 'DOXORUBICIN', reductionPercent: 20, reason: '' }] })));

const order = treatment.createTreatmentOrder(onc, {
  patientUuid: pid, carePlanUuid: plan.uuid, regimenCode: 'AC', plannedCycles: 2,
  weight: 68, height: 163, startDate: d(-1)
});
const orderSigned = treatment.signTreatmentOrder(onc, order.uuid);

check('signed treatment order immutable',
  expectGate(() => treatment.signTreatmentOrder(onc, order.uuid)));

check('pharmacy cannot receive a draft order', () => {
  const draft = treatment.createTreatmentOrder(onc, {
    patientUuid: pid, carePlanUuid: plan.uuid, regimenCode: 'AC', plannedCycles: 1, weight: 68, height: 163, startDate: d(0)
  });
  try { treatment.pharmacyReceive(pharm, draft.uuid); } catch (e) { e.expected = true; throw e; }
  throw new Error('expected rejection');
});

const rec = treatment.pharmacyReceive(pharm, order.uuid);
check('release blocked before preparation',
  expectGate(() => treatment.pharmacyRelease(pharm, rec.uuid, 'Second pharmacist')));

check('prepare blocked before verification',
  expectGate(() => treatment.pharmacyPrepare(pharm, rec.uuid, {})));

treatment.pharmacyVerify(pharm, rec.uuid, { regimenVerified: true, doseVerified: true, allergyCheck: true, interactionCheck: true, compatibilityCheck: true, stabilityCheck: true, stockAllocated: true });
treatment.pharmacyPrepare(pharm, rec.uuid, { compounded: false });

check('release requires independent second check',
  expectGate(() => treatment.pharmacyRelease(pharm, rec.uuid, '')));

treatment.pharmacyRelease(pharm, rec.uuid, 'Pharmacist B');

// D3: dispensing stop-gates
check('administration blocked without dispense (release ≠ dispense) — D3 gate',
  expectGate(() => treatment.startAdministration(nurse, rec.uuid)));

const dispensed = treatment.dispense(pharm, { pharmacyUuid: rec.uuid, destination: 'DAY_CARE', checkedOutTo: 'Sarah (Day Care)' });
check('dispense chain of custody recorded (prepare→release→dispense)', () => {
  if (dispensed.chainOfCustody.length !== 3) throw new Error('custody length ' + dispensed.chainOfCustody.length);
});

check('double dispense blocked',
  expectGate(() => treatment.dispense(pharm, { pharmacyUuid: rec.uuid, destination: 'DAY_CARE', checkedOutTo: 'X' })));

check('dispense of non-released preparation blocked', () => {
  const draft = treatment.createTreatmentOrder(onc, { patientUuid: pid, carePlanUuid: plan.uuid, regimenCode: 'AC', plannedCycles: 1, weight: 68, height: 163, startDate: d(0) });
  try { treatment.dispense(pharm, { pharmacyUuid: draft.uuid, destination: 'DAY_CARE', checkedOutTo: 'X' }); } catch (e) { e.expected = true; throw e; }
  throw new Error('expected rejection');
});

check('administration blocked without dispense (second pharmacy record)',
  expectGate(() => treatment.startAdministration(nurse, 'no-such-release')));

check('second administration for same release blocked', () => {
  treatment.startAdministration(nurse, rec.uuid);
  try { treatment.startAdministration(nurse, rec.uuid); } catch (e) { e.expected = true; throw e; }
  throw new Error('expected rejection');
});

// D10a: two-identifier + infusion reaction stop-gates
const adm = store.find('administrationRecords', a => a.pharmacyUuid === rec.uuid)[0];
check('administration without identity verification blocked at completion',
  expectGate(() => treatment.completeAdministration(nurse, adm.uuid)));

treatment.updateAdministration(nurse, adm.uuid, { patientIdentityVerification: { method: 'TWO_IDENTIFIER', nameConfirmation: true, mrnConfirmation: true } });

check('single-identifier verification rejected',
  expectGate(() => treatment.updateAdministration(nurse, adm.uuid, { patientIdentityVerification: { method: 'SINGLE', nameConfirmation: true, mrnConfirmation: false } })));

check('infusion reaction requires symptoms + actions',
  expectGate(() => treatment.recordInfusionReaction(nurse, { administrationUuid: adm.uuid, severity: 'MODERATE', onsetTime: new Date().toISOString() })));

const rx = treatment.recordInfusionReaction(nurse, { administrationUuid: adm.uuid, runningDrug: 'DOXORUBICIN', severity: 'SEVERE', symptoms: [{ symptom: 'hypotension' }], actions: ['STOP_INFUSION', 'PHYSICIAN_NOTIFIED'], onsetTime: new Date().toISOString() });
check('infusion reaction generates physician review task', () => {
  const t = store.find('tasks', t => t.payload && t.payload.infusionReactionUuid === rx.uuid);
  if (!t.length) throw new Error('no review task');
});

treatment.resolveInfusionReaction(onc, rx.uuid, 'RESTARTED');
check('infusion reaction resolution invalid outcome rejected',
  expectGate(() => treatment.resolveInfusionReaction(onc, rx.uuid, 'WHATEVER')));

// D10b: CTCAE version governance
check('toxicity with unknown version rejected (D10b gate)',
  expectGate(() => treatment.recordToxicity(onc, { patientUuid: pid, type: 'NAUSEA', grade: 1, onset: d(-1), attribution: 'TREATMENT', toxicityVersion: 'CTCAE_V99' })));

check('toxicity with unknown governed type rejected',
  expectGate(() => treatment.recordToxicity(onc, { patientUuid: pid, type: 'MADE_UP', grade: 2, onset: d(-1), attribution: 'TREATMENT' })));

check('toxicity grade must be 1-5',
  expectGate(() => treatment.recordToxicity(onc, { patientUuid: pid, type: 'NAUSEA', grade: 9, onset: d(-1), attribution: 'TREATMENT' })));

check('toxicity onset in future rejected',
  expectGate(() => treatment.recordToxicity(onc, { patientUuid: pid, type: 'NAUSEA', grade: 2, onset: d(3), attribution: 'TREATMENT' })));

check('response category must be governed',
  expectGate(() => treatment.recordResponseAssessment(onc, { patientUuid: pid, category: 'MAYBE', decision: 'CONTINUE' })));

check('response decision must route next treatment',
  expectGate(() => treatment.recordResponseAssessment(onc, { patientUuid: pid, category: 'PR', decision: 'SOMEDAY' })));

console.log('== Masters governance ==');

check('unknown master name rejected',
  expectGate(() => masters.addMasterItem('notAMaster', { code: 'X', label: 'X' }, onc)));

check('master item without label rejected',
  expectGate(() => masters.addMasterItem('grade', { code: 'GX2' }, onc)));

masters.addMasterItem('grade', { code: 'G_TEST', label: 'Test grade' }, onc);
check('master add is audited', () => {
  const found = store.find('audit', a => a.action === 'MASTER_ADD' && a.entityUuid === 'G_TEST');
  if (!found.length) throw new Error('no audit entry');
});

console.log('\n========================================');
console.log('PASSED: ' + passes + '   FAILED: ' + failures);
process.exit(failures ? 1 : 0);
