// CCA OS — §31 Flag-discrepancy flow tests (staging mandate §31)
// Loop: signed result → clinician flags (reason + requested correction) →
// STAGING_DISCREPANCY task for the oncologist → corrected facts re-derive →
// superseding signature resolves the flag and consumes the task. The signed
// record is NEVER edited. Run: node test/staging-discrepancy.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-disc-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const staging = require('../src/staging');
const flow = require('../src/clinical-flow');
const engine = require('../src/staging-engine');
const wf = require('../src/workflow');

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
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

store.load();
masters.seedMasters();

const FRONT = { uuid: 'a-front', name: 'FD', role: 'Front Desk' };
const MO = { uuid: 'a-mo', name: 'Dr. Flag', role: 'Medical Oncologist' };
store.insert('hospitals', { uuid: 'h-disc', name: 'CCA Disc', mdtPolicy: { MM: 'DIRECT_PLAN' } });

// Setup: MM patient (engine-derived ISS stage) with a signed assessment
console.log('\n== SETUP: signed engine-derived staging assessment ==');
const { patient } = clinical.registerPatient(FRONT, {
  name: 'Disc Test', mrn: 'DISC-1', sex: 'F', dob: '1960-01-01', phone: '555-0111', address: '1 Way', hospitalUuid: 'h-disc'
});
const consult = clinical.recordConsultation(MO, { patientUuid: patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 1, chiefComplaint: 'fatigue', clinicalAssessment: 'suspected myeloma' });
clinical.signConsultation(MO, consult.uuid);
const dx = flow.signDiagnosis(MO, flow.recordDiagnosis(MO, {
  patientUuid: patient.uuid, episodeUuid: consult.episodeUuid, cancerFamily: 'HAEMATOLOGICAL_FAMILY',
  cancerType: 'MM', primarySite: 'BONE_MARROW', histology: 'PLASMA_CELL', icd10: 'C90',
  icdOVersion: 'ICD-O-3.2', diagnosisDate: dateStr(-3), diagnosisBasis: 'BONE_MARROW'
}).uuid);

const draft = staging.createStagingAssessment(MO, {
  diagnosisUuid: dx.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  variables: { beta2Microglobulin: 4.2, albumin: 3.8 },
  resultSource: 'AUTOMATIC_ENGINE'
});
const signed = staging.signStagingAssessment(MO, draft.uuid);
check('signed engine-derived result exists (ISS_II)', signed.status === 'SIGNED' && signed.stageResult === 'ISS_II');

console.log('\n== §31 flag creation: reason + requested correction are mandatory ==');
const stillDraft = staging.createStagingAssessment(MO, {
  diagnosisUuid: dx.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  variables: { beta2Microglobulin: 4.2, albumin: 3.8 }, resultSource: 'AUTOMATIC_ENGINE'
});
expectGate('flagging a DRAFT assessment rejected', () => staging.flagStagingDiscrepancy(MO, stillDraft.uuid, { reason: 'x', requestedCorrection: 'y' }), 'SIGNED');
expectGate('missing reason rejected', () => staging.flagStagingDiscrepancy(MO, signed.uuid, { requestedCorrection: 're-check nodes' }), 'reason is required');
expectGate('missing requested correction rejected', () => staging.flagStagingDiscrepancy(MO, signed.uuid, { reason: 'node finding not reflected' }), 'requested correction is required');
const flag = staging.flagStagingDiscrepancy(MO, signed.uuid, {
  reason: 'Derived ISS II, but the lab slip shows β2M 5.6 — specimen mix-up suspected',
  requestedCorrection: 'Re-enter β2M from the corrected lab record; re-derive'
});
check('flag persisted OPEN with both fields', flag.status === 'OPEN' && flag.reason.length > 0 && flag.requestedCorrection.length > 0 && flag.flaggedResult === 'ISS_II');
check('flag routed a STAGING_DISCREPANCY task to the Medical Oncologist', wf.openTasksForRole('Medical Oncologist').some(t => t.code === 'STAGING_DISCREPANCY' && t.payload && t.payload.flagUuid === flag.uuid));
expectGate('second OPEN flag on the same assessment rejected', () => staging.flagStagingDiscrepancy(MO, signed.uuid, { reason: 'r', requestedCorrection: 'c' }));

console.log('\n== §31 loop closure: corrected facts re-derive; superseding signature resolves flag + task ==');
const corrected = staging.createStagingAssessment(MO, {
  diagnosisUuid: dx.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  variables: { beta2Microglobulin: 5.8, albumin: 3.8 },
  evidence: [],
  supersedes: signed.uuid,
  resultSource: 'AUTOMATIC_ENGINE'
});
const correctedSigned = staging.signStagingAssessment(MO, corrected.uuid);
check('corrected facts re-derive ISS_III (no hand-editing)', correctedSigned.stageResult === 'ISS_III');
const reread = store.byUuid('stagingAssessments', signed.uuid);
check('original signed assessment superseded (immutable record, never edited)', reread.status === 'SUPERSEDED' && reread.stageResult === 'ISS_II' && reread.reason === undefined);
const resolved = store.find('stagingDiscrepancyFlags', f => f.uuid === flag.uuid)[0];
check('flag RESOLVED pointing at the corrective assessment', resolved.status === 'RESOLVED' && resolved.resolvedByAssessmentUuid === corrected.uuid);
check('flag review task consumed by the corrective signature (§49)', !wf.openTasksForRole('Medical Oncologist').some(t => t.code === 'STAGING_DISCREPANCY' && t.payload && t.payload.flagUuid === flag.uuid));

console.log('\n== §31 engine gate: sign refuses a result the engine cannot derive ==');
const badDraft = staging.createStagingAssessment(MO, {
  diagnosisUuid: dx.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  variables: { beta2Microglobulin: 4.2 }, // albumin missing → NEEDS_INFORMATION
  supersedes: correctedSigned.uuid,
  resultSource: 'AUTOMATIC_ENGINE'
});
expectGate('incomplete facts refuse to sign (no stage guessed)', () => staging.signStagingAssessment(MO, badDraft.uuid), 'NEEDS_INFORMATION');

console.log('\n== §31 summary + header: current staging reflects the corrected result ==');
const summary = flow.getStagingSummary(patient.uuid);
check('staging summary reports the corrected stage', JSON.stringify(summary).includes('ISS_III'));

console.log('\nRESULT: ' + pass + ' passed, ' + failCount + ' failed');
process.exit(failCount ? 1 : 0);
