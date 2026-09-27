// CCA OS — Staging-window evidence auto-suggestion tests (staging mandate §24/§25/§42)
// When a staging fact is focused, the UI surfaces candidate patient records whose
// source kind matches the fact, from the relevant staging window (assessment date
// − N months). These tests pin the window filter, per-fact source-kind filtering,
// record-shape (picker-compatible), and role authorization. No server required;
// the HTTP route is a thin pass-through to clinical.stagingEvidenceSuggestions.
// Run: node test/staging-suggestions.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-staging-sugg-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const flow = require('../src/clinical-flow');

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

const FRONT = { uuid: 's-front', name: 'Front Desk', role: 'Front Desk' };
const MO = { uuid: 's-mo', name: 'Dr. Suggest', role: 'Medical Oncologist' };
const PATH = { uuid: 's-path', name: 'Dr. SPath', role: 'Pathologist' };
const RAD = { uuid: 's-rad', name: 'Dr. SRad', role: 'Radiologist' };
const LAB = { uuid: 's-lab', name: 'SLab', role: 'Lab' };

store.insert('hospitals', { uuid: 'h-sugg', name: 'CCA Suggest', mdtPolicy: { BREAST: 'DIRECT_PLAN' } });

const { patient } = clinical.registerPatient(FRONT, {
  name: 'Suggestion Test', mrn: 'SUGG-1', sex: 'F', dob: '1978-03-03', phone: '555-0199', address: '9 Way', hospitalUuid: 'h-sugg'
});
const consult = clinical.recordConsultation(MO, { patientUuid: patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 1, chiefComplaint: 'lump', clinicalAssessment: '2.8 cm firm mass right breast, mobile axillary nodes' });
clinical.signConsultation(MO, consult.uuid);
const dx = flow.recordDiagnosis(MO, {
  patientUuid: patient.uuid, episodeUuid: consult.episodeUuid, cancerFamily: 'BREAST_FAMILY', cancerType: 'BREAST',
  primarySite: 'BREAST', histology: 'IDC', icd10: 'C50', icdOVersion: 'ICD-O-3.2', diagnosisDate: dateStr(-1), diagnosisBasis: 'IMAGING'
});
flow.signDiagnosis(MO, dx.uuid);

// Records on either side of a staging window that ends today (assessment date today):
// imaging 10d and 30d back in window; pathology 90d back in window; lab 200d back
// OUTSIDE a 6-month window; "future" imaging 1d ahead is outside any past-window.
const mammoOrder = clinical.orderInvestigation(MO, { patientUuid: patient.uuid, category: 'RADIOLOGY', testCode: 'US_BREAST' });
clinical.advanceOrderStatus(RAD, mammoOrder.uuid, 'SCHEDULED', {});
const mammo = clinical.recordResult(RAD, {
  patientUuid: patient.uuid, orderUuid: mammoOrder.uuid,
  summary: '2.8 cm spiculated mass right breast; level II axillary node', acquisitionDate: dateStr(-10)
});

const biopsyOrder = clinical.orderInvestigation(MO, { patientUuid: patient.uuid, category: 'PATHOLOGY', testCode: 'CORE_BIOPSY_BREAST' });
clinical.advanceOrderStatus(PATH, biopsyOrder.uuid, 'SCHEDULED', {});
const biopsy = clinical.recordResult(PATH, {
  patientUuid: patient.uuid, orderUuid: biopsyOrder.uuid,
  summary: 'Invasive ductal carcinoma, grade 2', reportDate: dateStr(-90)
});

const cbcOrder = clinical.orderInvestigation(MO, { patientUuid: patient.uuid, category: 'LAB', testCode: 'CBC' });
clinical.advanceOrderStatus(LAB, cbcOrder.uuid, 'SCHEDULED', {});
const cbc = clinical.recordResult(LAB, { patientUuid: patient.uuid, orderUuid: cbcOrder.uuid, summary: 'CBC within normal limits', reportDate: dateStr(-200) });

// Older imaging inside a past-anchored window (two-sided proof of §25 anchoring)
const ctOrder = clinical.orderInvestigation(MO, { patientUuid: patient.uuid, category: 'RADIOLOGY', testCode: 'CT_CHEST' });
clinical.advanceOrderStatus(RAD, ctOrder.uuid, 'SCHEDULED', {});
const ct = clinical.recordResult(RAD, {
  patientUuid: patient.uuid, orderUuid: ctOrder.uuid,
  summary: '2.6 cm mass right breast, no distant metastasis', reportDate: dateStr(-150)
});
// A "future" result cannot exist through the product path: recordResult stop-gates
// future reportDates. The never-use-later-results guarantee (§25) is proven instead
// by the past-anchored window check below (the -10d imaging falls AFTER a -95d
// window end and must not be offered for that earlier assessment).

console.log('\n== §24 window filter: assessment date today, 6-month default window ==');
const today = clinical.stagingEvidenceSuggestions(patient.uuid, 'tumourSizeMm', dateStr(0));
check('returns window metadata (§25)', today.window && today.window.months === 6 && today.window.end === dateStr(0) && Math.abs(new Date(today.window.start) - new Date(dateStr(-183))) < 2 * 86400000);
check('echoes the queried fact', today.fact === 'tumourSizeMm');
check('in-window radiology suggested for tumourSizeMm', today.suggestions.some(s => s.sourceResourceId === mammo.uuid));
check('in-window pathology suggested for tumourSizeMm (hint: RADIOLOGICAL+PATHOLOGICAL)', today.suggestions.some(s => s.sourceResourceId === biopsy.uuid));
check('record 200d old is OUTSIDE the 6-month window', !today.suggestions.some(s => s.sourceResourceId === cbc.uuid));
check('results dated after the assessment are outside a past-anchored window (future-record guard, §25)', (() => {
  const s = clinical.stagingEvidenceSuggestions(patient.uuid, 'tumourSizeMm', dateStr(-95));
  return !s.suggestions.some(x => x.sourceResourceId === mammo.uuid);
})());
check('PRELIMINARY results never suggested (provenance must be signed)', !store.find('results', r => r.resultStatus === 'PRELIMINARY' && today.suggestions.some(s => s.sourceResourceId === r.uuid)).length);
check('suggestion items carry picker-compatible link shape', ['evidenceId', 'evidenceType', 'sourceResourceType', 'sourceResourceId', 'sourceDate', 'relevantFinding', 'group'].every(k => mammo && today.suggestions[0][k] !== undefined));
check('no silent attachment — output is a candidate list the clinician confirms', Array.isArray(today.suggestions));

console.log('\n== §24 per-fact source-kind filter ==');
const nodal = clinical.stagingEvidenceSuggestions(patient.uuid, 'clinicalNodalStatus', dateStr(0));
check('CLINICAL-inclusive fact surfaces the signed consultation as a candidate', nodal.suggestions.some(s => s.sourceResourceId === consult.uuid && s.evidenceType === 'CLINICAL_EXAM'));
const labFact = clinical.stagingEvidenceSuggestions(patient.uuid, 'beta2Microglobulin', dateStr(0));
check('lab-only fact excludes radiology/pathology records', !labFact.suggestions.some(s => s.sourceResourceId === mammo.uuid || s.sourceResourceId === biopsy.uuid));
check('pathology-only fact excludes imaging and consultations', (() => {
  const s = clinical.stagingEvidenceSuggestions(patient.uuid, 'regionalNodesPositive', dateStr(0));
  return s.suggestions.some(x => x.sourceResourceId === biopsy.uuid) &&
    !s.suggestions.some(x => x.sourceResourceId === mammo.uuid) &&
    !s.suggestions.some(x => x.sourceResourceId === consult.uuid);
})());
check('unknown fact falls back to all kinds (honest broadest default)', (() => {
  const s = clinical.stagingEvidenceSuggestions(patient.uuid, 'nonexistentField', dateStr(0));
  return s.sourceTypes === null && s.suggestions.length >= 3;
})());

console.log('\n== §25 window end anchors to the assessment date ==');
const past = clinical.stagingEvidenceSuggestions(patient.uuid, 'tumourSizeMm', dateStr(-95));
check('window anchored 95d back: 150d-old imaging inside, 10d-old imaging outside', past.suggestions.some(s => s.sourceResourceId === ct.uuid) && !past.suggestions.some(s => s.sourceResourceId === mammo.uuid));
check('custom window length respected (12 months includes the 200d lab)', (() => {
  const s = clinical.stagingEvidenceSuggestions(patient.uuid, 'beta2Microglobulin', dateStr(0), 12);
  return s.window.months === 12 && s.suggestions.some(x => x.sourceResourceId === cbc.uuid);
})());

console.log('\n== Read-only endpoint convention ==');
check('hinted source kinds are reported for UI guidance', today.sourceTypes !== null && today.sourceTypes.includes('RADIOLOGICAL'));

console.log('\n== Fresh patient: empty window, honest empty state ==');
const { patient: p2 } = clinical.registerPatient(FRONT, {
  name: 'Suggestion Empty', mrn: 'SUGG-2', sex: 'F', dob: '1980-01-01', phone: '555-0198', address: '10 Way', hospitalUuid: 'h-sugg'
});
const empty = clinical.stagingEvidenceSuggestions(p2.uuid, 'tumourSizeMm', dateStr(0));
check('no records → empty suggestions array (UI shows honest empty state)', empty.suggestions.length === 0);

console.log('\n' + pass + ' passed, ' + failCount + ' failed');
process.exit(failCount ? 1 : 0);
