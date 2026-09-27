// CCA OS — Regression tests for human-playtest fixes (no server needed)
// Covers: Slice E pathological restaging (p/yp), task role guard, signed-record
// task suppression (CONFIRM_DIAGNOSIS / FIRST_CONSULT), staging evidence alignment.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-surgtest-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const wf = require('../src/workflow');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const treatment = require('../src/treatment');
const consent = require('../src/consent');

let passes = 0, failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ FAIL: ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

consent.seedConsentTemplates();
store.load();
masters.seedMasters();
store.insert('hospitals', { uuid: 'h-test', organisation: 'CCA', name: 'Test Hospital', mdtPolicy: {} });

const front = { uuid: 'u-front', name: 'Fatima', role: 'Front Desk' };
const intake = { uuid: 'u-intake', name: 'Nina', role: 'Intake Nurse' };
const onc = { uuid: 'u-onc1', name: 'Dr. Sharma', role: 'Medical Oncologist' };
const surgeon = { uuid: 'u-surg', name: 'Dr. Rao', role: 'Surgical Oncologist' };
const pathologist = { uuid: 'u-path', name: 'Mbeki', role: 'Pathologist' };
const coordinator = { uuid: 'u-mdtc', name: 'Kiran', role: 'MDT Coordinator' };
const chair = { uuid: 'u-chair', name: 'Dr. Hsu', role: 'MDT Chair' };
const d = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toISOString().slice(0, 10); };

// Full breast journey up to a signed CLINICAL staging assessment (baseline cTNM).
function breastCase(name) {
  const reg = clinical.registerPatient(front, { name, dob: '1975-04-10', sex: 'F', hospitalUuid: 'h-test' });
  const pid = reg.patient.uuid;
  const dx = clinical.recordDiagnosis(onc, {
    patientUuid: pid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC',
    diagnosisDate: d(-10), diagnosisBasis: 'PATHOLOGY'
  });
  clinical.signDiagnosis(onc, dx.uuid);
  const stg = clinical.createStagingAssessment(onc, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: d(-5),
    variables: { t: 'T2', n: 'N0', m: 'M0', stageResult: 'STAGE_II' },
    evidence: [
      { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceDate: d(-6), supportingFinding: '2.1 cm spiculated mass' },
      { variableKey: 'n', sourceType: 'RADIOLOGICAL', sourceDate: d(-6), supportingFinding: 'no axillary nodes' },
      { variableKey: 'm', sourceType: 'CLINICAL', sourceDate: d(-5), supportingFinding: 'no distant metastases on assessment' }
    ]
  });
  clinical.signStagingAssessment(onc, stg.uuid);
  return { pid, dx };
}

function surgeryChain(pid, specimenResults) {
  const plan = treatment.createSurgicalPlan(surgeon, { patientUuid: pid, procedure: 'Modified radical mastectomy', plannedDate: d(-1) });
  treatment.signSurgicalPlan(surgeon, plan.uuid);
  const rec = treatment.recordOperativeNote(surgeon, {
    surgicalPlanUuid: plan.uuid, performedProcedure: 'Modified radical mastectomy',
    anesthesia: 'GA', findings: 'Tumour involves upper outer quadrant',
    specimens: [{ site: 'Breast' }, { site: 'Axillary lymph nodes' }],
    performedDate: d(-1), postOpPlan: 'Recover, adjuvant discussion'
  });
  // optional pre-finalized results used when testing the sign-time catch-up
  const orders = store.find('investigationOrders', o => o.operativeRecordUuid === rec.uuid);
  if (specimenResults) {
    for (const o of orders) clinical.recordResult(pathologist, {
      patientUuid: pid, orderUuid: o.uuid, resultType: 'PATHOLOGY',
      summary: 'Invasive ductal carcinoma, grade 2; nodes positive', reportDate: d(0)
    });
  }
  treatment.signOperativeRecord(surgeon, rec.uuid);
  return { rec, orders };
}

console.log('== Slice E: upfront surgery → pTNM restaging ==');
const A = breastCase('Restage Upfront');
surgeryChain(A.pid, false);
// finalize specimen histopathology AFTER the operative record is signed
const ordA = store.find('investigationOrders', o => o.patientUuid === A.pid && o.operativeRecordUuid)[0];
clinical.recordResult(pathologist, {
  patientUuid: A.pid, orderUuid: ordA.uuid, resultType: 'PATHOLOGY',
  summary: 'IDC grade 2, tumour 2.4 cm; one node positive', reportDate: d(0)
});
let taskA = wf.tasksForPatient(A.pid).find(t => t.code === 'PATHOLOGICAL_STAGING');
check('finalized specimen histopathology creates PATHOLOGICAL_STAGING task', () => assert(taskA, 'no task'));
check('upfront surgery resolves classification PATHOLOGICAL (prefix p)', () => {
  assert(taskA.payload.classification === 'PATHOLOGICAL', 'got ' + taskA.payload.classification);
  assert(taskA.payload.prefix === 'p', 'got ' + taskA.payload.prefix);
});
check('pT/pN/pM are never pre-filled by the system', () => {
  assert(!taskA.payload.variables, 'payload carries invented variables');
  assert(taskA.payload.resultUuid, 'payload must link the source result');
});
check('prior cTNM assessment preserved untouched', () => {
  const prior = store.find('stagingAssessments', s => s.patientUuid === A.pid && s.stagingContext === 'CLINICAL' && s.status === 'SIGNED');
  assert(prior.length === 1 && prior[0].stageResult === 'STAGE_II', 'clinical stage changed');
});
// second specimen result must not duplicate the task (idempotent)
const ordA2 = store.find('investigationOrders', o => o.patientUuid === A.pid && o.operativeRecordUuid)[1];
clinical.recordResult(pathologist, {
  patientUuid: A.pid, orderUuid: ordA2.uuid, resultType: 'PATHOLOGY',
  summary: 'Axillary nodes: metastatic carcinoma in 1 of 12', reportDate: d(0)
});
check('second specimen result does not duplicate the restaging task', () => {
  const count = wf.tasksForPatient(A.pid).filter(t => t.code === 'PATHOLOGICAL_STAGING').length;
  assert(count === 1, 'got ' + count);
});

console.log('== Slice E: signing the new pTNM assessment (consultation evidence accepted) ==');
const consultA = clinical.recordConsultation(onc, {
  patientUuid: A.pid, consultationType: 'FOLLOW_UP', ecog: '0',
  clinicalAssessment: 'Post-op day 1: mobile, afebrile, drains intact'
});
clinical.signConsultation(onc, consultA.uuid);
const pStg = clinical.createStagingAssessment(onc, {
  diagnosisUuid: A.dx.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: d(0),
  variables: { t: 'T2', n: 'N1', m: 'M1', stageResult: 'STAGE_IV' },
  evidence: [
    { variableKey: 't', sourceType: 'PATHOLOGICAL', sourceRef: taskA.payload.resultUuid, sourceDate: d(0), supportingFinding: 'tumour 2.4 cm' },
    { variableKey: 'n', sourceType: 'CLINICAL', sourceRef: consultA.uuid, sourceDate: d(0), supportingFinding: 'palpable axillary node' },
    { variableKey: 'm', sourceType: 'PATHOLOGICAL', sourceRef: taskA.payload.resultUuid, sourceDate: d(0), supportingFinding: 'metastatic carcinoma in node' }
  ]
});
check('pTNM assessment signs with result + consultation evidence (picker/validator aligned)', () => {
  const signed = clinical.signStagingAssessment(onc, pStg.uuid);
  assert(signed.status === 'SIGNED', 'not signed');
  assert(signed.classificationPrefix === 'p', 'prefix got ' + signed.classificationPrefix);
});
check('both CLINICAL and PATHOLOGICAL assessments coexist in history', () => {
  const all = store.find('stagingAssessments', s => s.patientUuid === A.pid && s.status === 'SIGNED');
  assert(all.some(s => s.stagingContext === 'CLINICAL') && all.some(s => s.stagingContext === 'PATHOLOGICAL'), 'history incomplete');
});
check('pM0 rejected under pathological classification (engine rule intact)', () => {
  const bad = clinical.createStagingAssessment(onc, {
    diagnosisUuid: A.dx.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_II' },
    evidence: [{ variableKey: 't', sourceType: 'PATHOLOGICAL', sourceRef: taskA.payload.resultUuid, sourceDate: d(0), supportingFinding: 'x' }]
  });
  try { clinical.signStagingAssessment(onc, bad.uuid); } catch (e) {
    if (/pM0|M0 does not exist/i.test(e.message)) return;
    throw e;
  }
  throw new Error('expected pM0 rejection');
});

console.log('== Slice E: neoadjuvant systemic therapy → ypTNM restaging ==');
const B = breastCase('Restage PostNeoadj');
store.insert('administrationRecords', {
  uuid: wf.uuid(), patientUuid: B.pid, cycle: 1, day: 1,
  actualStart: d(-3) + 'T09:00:00.000Z', status: 'COMPLETED', createdAt: new Date().toISOString()
});
surgeryChain(B.pid, false);
const ordB = store.find('investigationOrders', o => o.patientUuid === B.pid && o.operativeRecordUuid)[0];
clinical.recordResult(pathologist, {
  patientUuid: B.pid, orderUuid: ordB.uuid, resultType: 'PATHOLOGY',
  summary: 'Residual invasive carcinoma, Miller-Payne grade 3', reportDate: d(0)
});
check('neoadjuvant administration resolves POSTTHERAPY_PATHOLOGICAL (yp)', () => {
  const t = wf.tasksForPatient(B.pid).find(t => t.code === 'PATHOLOGICAL_STAGING');
  assert(t, 'no task');
  assert(t.payload.classification === 'POSTTHERAPY_PATHOLOGICAL', 'got ' + t.payload.classification);
  assert(t.payload.prefix === 'yp', 'got ' + t.payload.prefix);
});
check('yc/cTNM preserved when yp task created', () => {
  const prior = store.find('stagingAssessments', s => s.patientUuid === B.pid && s.stagingContext === 'CLINICAL' && s.status === 'SIGNED');
  assert(prior.length === 1, 'clinical stage lost');
});

console.log('== Slice E: result finalized before op-record sign → catch-up at sign ==');
const C = breastCase('Restage Catchup');
const planC = treatment.createSurgicalPlan(surgeon, { patientUuid: C.pid, procedure: 'Wide local excision', plannedDate: d(-1) });
treatment.signSurgicalPlan(surgeon, planC.uuid);
const recC = treatment.recordOperativeNote(surgeon, {
  surgicalPlanUuid: planC.uuid, performedProcedure: 'Wide local excision',
  specimens: [{ site: 'Breast' }], performedDate: d(-1), findings: 'Clear margins'
});
const ordC = store.find('investigationOrders', o => o.operativeRecordUuid === recC.uuid)[0];
clinical.recordResult(pathologist, { patientUuid: C.pid, orderUuid: ordC.uuid, resultType: 'PATHOLOGY', summary: 'IDC 1.8 cm, margins clear', reportDate: d(0) });
check('no task while operative record still open', () => {
  assert(!wf.tasksForPatient(C.pid).some(t => t.code === 'PATHOLOGICAL_STAGING'), 'task created too early');
});
treatment.signOperativeRecord(surgeon, recC.uuid);
check('signing the operative record catches up the restaging task', () => {
  const t = wf.tasksForPatient(C.pid).find(t => t.code === 'PATHOLOGICAL_STAGING');
  assert(t && t.payload.classification === 'PATHOLOGICAL', 'catch-up failed');
});

console.log('== Task engine: role guard + double-completion guard ==');
const D = breastCase('Guard Case');
clinical.openMdtCase(coordinator, { patientUuid: D.pid, reason: 'adjuvant recommendation', proposedOptions: 'Post-op therapy?' });
const mdtTask = wf.tasksForPatient(D.pid).find(t => t.code === 'MDT_REVIEW');
check('cross-role completion is rejected (coordinator cannot complete chair task)', () => {
  // coordinator completes the coordinator task, then tries the CHAIR task it routes
  wf.completeTask(coordinator, mdtTask.uuid, 'presented');
  const chairTask = wf.tasksForPatient(D.pid).find(t => t.code === 'MDT_CHAIR_SIGN');
  assert(chairTask, 'chair task missing');
  try { wf.completeTask(coordinator, chairTask.uuid, 'usurped'); } catch (e) {
    if (/ROLE_MISMATCH/.test(e.message)) return;
    throw e;
  }
  throw new Error('expected ROLE_MISMATCH rejection');
});
check('assigned role completes its own task; second completion rejected', () => {
  const chairTask = wf.tasksForPatient(D.pid).find(t => t.code === 'MDT_CHAIR_SIGN');
  wf.completeTask(chair, chairTask.uuid, 'signed outcome');
  try { wf.completeTask(chair, chairTask.uuid, 'again'); } catch (e) {
    if (/not open/i.test(e.message)) return;
    throw e;
  }
  throw new Error('expected double-completion rejection');
});

console.log('== D-MDT-6: required MDT outcome fields + chair fallback ==');
const F = breastCase('Mdt Required Case');
const mdtF = clinical.openMdtCase(coordinator, { patientUuid: F.pid, reason: 'MDT discussion', proposedOptions: 'surgery first' });
check('recordMdtDiscussion rejects an empty decision (required-field enforcement)', () => {
  try {
    clinical.recordMdtDiscussion(coordinator, mdtF.uuid, { discussion: 'panel met', consensus: 'agreed', decision: '', responsibleClinician: '' });
  } catch (e) {
    if (/decision is required/.test(e.message)) return;
    throw e;
  }
  throw new Error('expected decision-required rejection');
});
check('complete record routes to chair; chair sign produces CREATE_CARE_PLAN', () => {
  clinical.recordMdtDiscussion(coordinator, mdtF.uuid, { discussion: 'panel met', consensus: 'agreed', decision: 'Upfront surgery', responsibleClinician: 'Dr. Rao' });
  const taskF = wf.tasksForPatient(F.pid).find(t => t.code === 'MDT_REVIEW');
  wf.completeTask(coordinator, taskF.uuid, 'presented');
  const chairTask = wf.tasksForPatient(F.pid).find(t => t.code === 'MDT_CHAIR_SIGN');
  assert(chairTask, 'no chair task');
  clinical.signMdtOutcome(chair, chairTask.payload.mdtUuid, {});
  wf.completeTask(chair, chairTask.uuid, 'signed');
  assert(wf.tasksForPatient(F.pid).some(t => t.code === 'CREATE_CARE_PLAN'), 'no care-plan task');
});

const G = breastCase('Mdt Chair Fallback');
const mdtG = clinical.openMdtCase(coordinator, { patientUuid: G.pid, reason: 'legacy incomplete record probe', proposedOptions: 'surgery first' });
check('chair fallback: sign accepts decision/responsible supplied by the chair', () => {
  // simulate a pre-fix record that already reached the chair without required fields
  store.update('mdtCases', mdtG.uuid, { discussion: 'panel discussed', consensus: 'consensus reached', decision: '', responsibleClinician: null });
  const taskG = wf.tasksForPatient(G.pid).find(t => t.code === 'MDT_REVIEW');
  wf.completeTask(coordinator, taskG.uuid, 'presented');
  const chairTask = wf.tasksForPatient(G.pid).find(t => t.code === 'MDT_CHAIR_SIGN');
  assert(chairTask, 'no chair task for incomplete record');
  clinical.signMdtOutcome(chair, chairTask.payload.mdtUuid, { decision: 'Neoadjuvant chemo', responsibleClinician: 'Dr. Sharma' });
  const signed = store.byUuid('mdtCases', mdtG.uuid);
  assert(signed.status === 'SIGNED', 'not signed');
  assert(signed.decision === 'Neoadjuvant chemo', 'chair decision not stored');
  assert(wf.tasksForPatient(G.pid).some(t => t.code === 'CREATE_CARE_PLAN'), 'no care-plan task after chair fallback');
});

console.log('== Signed records suppress their open tasks (§49) ==');
const E = breastCase('Suppression Case');
// breastCase already signed the diagnosis: any CONFIRM_DIAGNOSIS tasks must be done
check('signDiagnosis completes open CONFIRM_DIAGNOSIS tasks', () => {
  const open = wf.tasksForPatient(E.pid).filter(t => t.code === 'CONFIRM_DIAGNOSIS' && t.status === 'OPEN');
  assert(open.length === 0, open.length + ' open tasks remain');
});
// FIRST_CONSULT ghost-task fix: intake consult creates the MO task; MO sign completes it
const regF = clinical.registerPatient(front, { name: 'Ghost Check', dob: '1980-02-02', sex: 'F', hospitalUuid: 'h-test' });
const intakeConsult = clinical.recordConsultation(intake, {
  patientUuid: regF.patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: '1',
  chiefComplaint: 'breast lump', clinicalAssessment: 'lump noted, referral to oncology'
});
clinical.signConsultation(intake, intakeConsult.uuid);
check('intake consult creates exactly one FIRST_CONSULT task', () => {
  const open = wf.tasksForPatient(regF.patient.uuid).filter(t => t.code === 'FIRST_CONSULT' && t.status === 'OPEN');
  assert(open.length === 1, 'got ' + open.length);
});
const moConsult = clinical.recordConsultation(onc, {
  patientUuid: regF.patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: '1',
  chiefComplaint: 'breast lump', clinicalAssessment: 'carcinoma breast suspected'
});
clinical.signConsultation(onc, moConsult.uuid);
check('MO consult sign completes the FIRST_CONSULT task without creating a ghost', () => {
  const open = wf.tasksForPatient(regF.patient.uuid).filter(t => t.code === 'FIRST_CONSULT' && t.status === 'OPEN');
  assert(open.length === 0, open.length + ' ghost task(s)');
});

console.log('== Staging evidence: cross-patient protection intact ==');
check('cross-patient staging evidence still rejected', () => {
  const bad = clinical.createStagingAssessment(onc, {
    diagnosisUuid: E.dx.uuid, stagingContext: 'CLINICAL', assessmentDate: d(0),
    variables: { t: 'T2', n: 'N0', m: 'M0', stageResult: 'STAGE_II' },
    evidence: [{ variableKey: 't', sourceType: 'RADIOLOGICAL', sourceRef: taskA.payload.resultUuid, sourceDate: d(0), supportingFinding: 'stolen evidence' }]
  });
  try { clinical.signStagingAssessment(onc, bad.uuid); } catch (e) {
    if (/CROSS_PATIENT_EVIDENCE/.test(e.message)) return;
    throw e;
  }
  throw new Error('expected cross-patient rejection');
});

console.log('');
console.log('PASSED: ' + passes + '  FAILED: ' + failures);
process.exit(failures ? 1 : 0);
