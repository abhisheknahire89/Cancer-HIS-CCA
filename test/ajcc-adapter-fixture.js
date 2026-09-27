// Shared fixture for the licensed-AJCC-adapter suites: the unit suite (injected
// transport) and the wire suite (stub HTTP server) prove the same contract, so
// they share the isolated data-dir bootstrap, assertion helpers, actors, and the
// breast-diagnosis fixture. IMPORTANT: require() this module FIRST in a suite —
// it sets CCA_DATA_DIR before the store is ever loaded.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-ajcc-adapter-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const staging = require('../src/staging');
const flow = require('../src/clinical-flow');

let pass = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { failCount++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function expectError(name, fn, needle) {
  try { fn(); failCount++; console.log('  FAIL ' + name + ' (no error thrown)'); }
  catch (e) {
    const ok = !needle || String(e.message).includes(needle);
    if (ok) { pass++; console.log('  PASS ' + name); }
    else { failCount++; console.log('  FAIL ' + name + ' — wrong error: ' + e.message); }
  }
}
async function expectErrorAsync(name, fn, needle) {
  try { await fn(); failCount++; console.log('  FAIL ' + name + ' (no error thrown)'); }
  catch (e) {
    const ok = !needle || String(e.message).includes(needle);
    if (ok) { pass++; console.log('  PASS ' + name); }
    else { failCount++; console.log('  FAIL ' + name + ' — wrong error: ' + e.message); }
  }
}
function summary() { return pass + ' passed, ' + failCount + ' failed'; }
function exitCode() { return failCount ? 1 : 0; }

function dateStr(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}
function licensedPack() {
  return fs.readFileSync(path.join(__dirname, '..', 'content-packs', 'ajcc-breast-clinical-poc.json'), 'utf8');
}

// Isolated store + the minimal clinical path to a CONFIRMED breast diagnosis —
// the sign-gate target both suites assert against.
function setupBreastFixture() {
  store.load();
  masters.seedMasters();
  const ADMIN = { uuid: 'ad', name: 'Admin', role: 'Administrator' };
  const FRONT = { uuid: 'f', name: 'Front Desk', role: 'Front Desk' };
  const MO = { uuid: 'mo', name: 'Dr. Adapter', role: 'Medical Oncologist' };
  store.insert('hospitals', { uuid: 'h-adapter', name: 'CCA Adapter', mdtPolicy: { BREAST: 'DIRECT_PLAN' } });
  const { patient } = clinical.registerPatient(FRONT, {
    name: 'Adapter Test', mrn: 'ADP-1', sex: 'F', dob: '1975-05-05', phone: '555-0301', address: '1 Way', hospitalUuid: 'h-adapter'
  });
  const consult = clinical.recordConsultation(MO, { patientUuid: patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 1, chiefComplaint: 'lump', clinicalAssessment: '2.8 cm mass right breast' });
  clinical.signConsultation(MO, consult.uuid);
  const dx = flow.recordDiagnosis(MO, {
    patientUuid: patient.uuid, episodeUuid: consult.episodeUuid, cancerFamily: 'BREAST_FAMILY', cancerType: 'BREAST',
    primarySite: 'BREAST', histology: 'IDC', icd10: 'C50', icdOVersion: 'ICD-O-3.2', diagnosisDate: dateStr(-1), diagnosisBasis: 'IMAGING'
  });
  flow.signDiagnosis(MO, dx.uuid);
  return { ADMIN, FRONT, MO, patient, dx };
}

module.exports = { check, expectError, expectErrorAsync, summary, exitCode, dateStr, licensedPack, setupBreastFixture };
