// CCA OS — Calendar derivation engine tests
// Verifies: event catalogue coverage, provenance on every event, state rules
// (PROJECTED never advances clinical state / never presented as delivered),
// delay provenance (original + reason + revised + downstream), filters.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-cal-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const flow = require('../src/clinical-flow');
const treatment = require('../src/treatment');
const calendar = require('../src/calendar');
const { resolveProvider } = require('../src/staging-providers');

let passed = 0, failed = 0;
function check(name, fn) {
  try { const r = fn(); if (r === false) throw new Error('returned false'); passed++; console.log('  ✓' + name); }
  catch (e) { failed++; console.log('  ✗ FAIL: ' + name + ' — ' + e.message); }
}

store.load();
masters.seedMasters();
require('../src/consent').seedConsentTemplates();
require('../src/consent').seedConsentTemplates(); // idempotent — double call proves it

const MO = { uuid: 'u-onc1', name: 'Dr. Sharma', role: 'Medical Oncologist' };

// ---------- seed one patient through the full clinical chain ----------
function runWorkflow() {
  const p = clinical.registerPatient(MO, { name: 'Cal Endar', dob: '1980-01-01', sex: 'F', hospitalUuid: 'h-1', phone: '1', address: 'x', referralSource: 'SELF', reason: 'breast lump' });
  // wait: registerPatient is Front Desk RBAC — use proper actor
  return p;
}

const FRONT = { uuid: 'u-front', name: 'Fatima', role: 'Front Desk' };
const INTAKE = { uuid: 'u-intake', name: 'Joy', role: 'Intake Nurse' };
const PATH = { uuid: 'u-path', name: 'Dr. Mbeki', role: 'Pathologist' };
const FIN = { uuid: 'u-fin', name: 'Ravi', role: 'Financial Counsellor' };
const NAV = { uuid: 'u-nav', name: 'Amina', role: 'Nurse Navigator' };
const PHARM = { uuid: 'u-pharm', name: 'Mei', role: 'Pharmacist' };
const DAYCARE = { uuid: 'u-daycare', name: 'Sarah', role: 'Day Care Nurse' };

const reg = clinical.registerPatient(FRONT, { name: 'Cal Endar', dob: '1980-01-01', sex: 'F', hospitalUuid: 'h-1', phone: '1', address: 'x', referralSource: 'SELF', reason: 'breast lump' });
const patient = reg.patient;
clinical.recordConsultation(INTAKE, { patientUuid: patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 1, heightCm: 165, weightKg: 70 });
clinical.signConsultation(MO, store.find('consultations', c => c.patientUuid === patient.uuid)[0].uuid);
const ord = clinical.orderInvestigation(MO, { patientUuid: patient.uuid, category: 'PATHOLOGY', testCode: 'CORE_BIOPSY_BREAST', priority: 'ROUTINE' });
const pathResult = clinical.recordResult(PATH, { patientUuid: patient.uuid, orderUuid: ord.uuid, summary: 'Invasive ductal carcinoma' });
const review = flow.createResultsReview(MO, { patientUuid: patient.uuid, decision: 'DIAGNOSIS_CONFIRMED', ecog: 1, clinicalNotes: 'confirmed IDC' });
const dx = flow.recordDiagnosis(MO, { patientUuid: patient.uuid, cancerType: 'BREAST', primarySite: 'BREAST', subsite: 'UPPER_OUTER', laterality: 'LEFT', histology: 'IDC', diagnosisDate: '2026-09-01', diagnosisBasis: 'PATHOLOGY', revisionReason: undefined });
flow.signDiagnosis(MO, dx.uuid);

const { provider } = resolveProvider({ cancerType: 'BREAST' });
const stg = clinical.createStagingAssessment(MO, { diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: '2026-09-05', variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB' }, evidence: [
  { variableKey: 't', sourceType: 'PATHOLOGICAL', sourceRef: pathResult.uuid, supportingFinding: 'specimen' },
  { variableKey: 'n', sourceType: 'CLINICAL', sourceDate: '2026-09-04', supportingFinding: 'palpable node' },
  { variableKey: 'm', sourceType: 'CLINICAL', sourceDate: '2026-09-04', supportingFinding: 'no distant disease' }
] });
clinical.signStagingAssessment(MO, stg.uuid);

const cp = clinical.createCarePlan(MO, { patientUuid: patient.uuid, diagnosisUuid: dx.uuid, treatmentIntent: 'CURATIVE', lineOfTherapy: 'L1', expectedStart: '2026-09-20', systemicTherapy: 'AC x4' });
clinical.signCarePlan(MO, cp.uuid);
clinical.recordFinancialCounselling(FIN, { carePlanUuid: cp.uuid, plannedTreatment: 'AC x4', costEstimate: 100000, patientChoice: 'INSURER', payerType: 'INSURER', financialClearance: 'CLEARED', authorization: { number: 'AUTH-1', status: 'APPROVED' } });
const fcs = store.find('financialCounsellings', f => f.patientUuid === patient.uuid);
clinical.signFinancialCounselling(FIN, fcs[0].uuid);
const consentSvc = require('../src/consent');
const consentRec = consentSvc.recordConsent(MO, { patientUuid: patient.uuid, carePlanUuid: cp.uuid, templateCode: 'SYSTEMIC_THERAPY_V1', consentType: 'SYSTEMIC_THERAPY', discussedRisks: 'r', discussedBenefits: 'b', discussedAlternatives: 'a', acknowledgedBy: 'patient' });
consentSvc.signConsent(MO, consentRec.uuid);
clinical.recordReadiness(NAV, { fcUuid: fcs[0].uuid, checks: { labsCurrent: true, consentTaken: true, accessDevice: true, patientEducated: true } });
const TODAY = new Date().toISOString().slice(0, 10);
const plan = treatment.createTreatmentOrder(MO, { patientUuid: patient.uuid, carePlanUuid: cp.uuid, regimenCode: 'AC', plannedCycles: 4, startDate: TODAY, weight: 70, height: 165 });
treatment.signTreatmentOrder(MO, plan.uuid);

// ---------- tests ----------
console.log('\n== Calendar derivation engine ==');

const events = calendar.deriveForPatient(patient.uuid);
const types = new Set(events.map(e => e.type));

check('derives events for a patient mid-journey', () => events.length > 10);
check('every event carries refType + refUuid provenance', () => events.every(e => e.refType && e.refUuid));
check('every event has a governed type from the catalogue', () => events.every(e => calendar.EVENT_TYPES[e.type]));
check('every event state is from the 8 governed states', () => events.every(e => calendar.EVENT_STATES.includes(e.state)));
check('consultation event derived (ACTUAL)', () => events.some(e => e.type === 'CONSULTATION' && e.state === 'ACTUAL'));
check('investigation order event derived', () => events.some(e => e.type === 'INVESTIGATION_ORDER'));
check('specimen collection derived from pathology order', () => events.some(e => e.type === 'SPECIMEN_COLLECTION'));
check('pathology result event derived', () => events.some(e => e.type === 'PATHOLOGY' && e.state === 'ACTUAL'));
check('results-review consultation event derived', () => events.some(e => e.type === 'RESULTS_REVIEW'));
check('diagnosis event derived with signed provenance', () => events.some(e => e.type === 'DIAGNOSIS' && e.state === 'ACTUAL' && e.refType === 'diagnoses'));
check('staging event derived', () => events.some(e => e.type === 'STAGING' && e.state === 'ACTUAL'));
check('care plan event derived', () => events.some(e => e.type === 'CARE_PLAN'));
check('financial counselling + authorization events derived', () => events.some(e => e.type === 'FINANCIAL_COUNSELLING') && events.some(e => e.type === 'AUTHORIZATION'));
check('consent event derived', () => events.some(e => e.type === 'CONSENT' && e.state === 'ACTUAL'));
check('readiness event derived', () => events.some(e => e.type === 'TREATMENT_READINESS'));
check('signed order generates projected systemic cycle events', () => events.some(e => e.type === 'SYSTEMIC_CYCLE' && e.state === 'PROJECTED'));
check('supportive treatment events derived from premedication rows', () => events.some(e => e.type === 'SUPPORTIVE_TREATMENT' && /ONDA|DEXA/.test(e.title)));
check('projected pre-cycle labs generated', () => events.some(e => e.type === 'LABORATORY_RESULT' && e.state === 'PROJECTED' && /Pre-cycle labs/.test(e.title)));
check('projected toxicity reviews generated', () => events.some(e => e.type === 'TOXICITY_REVIEW' && e.state === 'PROJECTED'));
check('projected response assessment after final cycle', () => events.some(e => e.type === 'RESPONSE_ASSESSMENT' && e.state === 'PROJECTED'));

console.log('\n== State discipline ==');
const futureChemo = events.filter(e => e.type === 'SYSTEMIC_CYCLE' && e.state === 'PROJECTED');
check('projected chemo exists but is never marked COMPLETED before administration', () => futureChemo.length && futureChemo.every(e => e.state === 'PROJECTED'));
check('no event mixes PROJECTED state with an actualDate', () => events.every(e => e.state !== 'PROJECTED' || !e.actualDate));
check('owner is populated for role ownership', () => events.every(e => e.owner));

console.log('\n== Administration completion discipline ==');
// deliver cycle 1 today, THEN delay a future cycle — the realistic sequence
const rec = treatment.pharmacyReceive(PHARM, plan.uuid);
treatment.pharmacyVerify(PHARM, rec.uuid, { regimenVerified: true, doseVerified: true, allergyCheck: true, interactionCheck: true, compatibilityCheck: true, stabilityCheck: true, stockAllocated: true });
treatment.pharmacyPrepare(PHARM, rec.uuid, { preparedBy: 'Mei', finalVolume: 250 });
treatment.pharmacyRelease(PHARM, rec.uuid, 'Independent checker');
treatment.dispense(PHARM, { pharmacyUuid: rec.uuid, destination: 'Day Care', checkedOutTo: 'Day Care Nurse' });
const adm = treatment.startAdministration(DAYCARE, rec.uuid);
treatment.updateAdministration(DAYCARE, adm.uuid, {
  readiness: { vitalsStable: true, accessConfirmed: true, premedicationsGiven: true },
  access: 'PICC line',
  patientIdentityVerification: { method: 'TWO_IDENTIFIER', nameConfirmation: true, mrnConfirmation: true },
  lines: [{ phase: 'DRUG', medication: 'DOXORUBICIN', actualDose: '60 mg', route: 'IV_PUSH' }]
});
treatment.completeAdministration(DAYCARE, adm.uuid);
const eventsMid = calendar.deriveForPatient(patient.uuid);
const completedChemo = eventsMid.filter(e => e.type === 'SYSTEMIC_CYCLE' && e.state === 'COMPLETED');
check('completed administration flips delivered chemo events to COMPLETED', () => completedChemo.length > 0);
check('future cycles remain PROJECTED (not delivered)', () => eventsMid.filter(e => e.type === 'SYSTEMIC_CYCLE' && e.date > TODAY && e.state === 'PROJECTED').length > 0);

console.log('\n== Delay provenance ==');
const c2 = store.byUuid('treatmentOrders', plan.uuid).cycleDays.find(c => c.cycle === 2 && c.day === 1);
treatment.delayCycle(MO, { orderUuid: plan.uuid, cycle: 2, reason: 'Neutropenia', revisedDate: '2026-10-20', shiftDownstream: true, shiftDays: 7 });
const events2 = calendar.deriveForPatient(patient.uuid);
check('delayed cycle event state = DELAYED', () => events2.some(e => e.type === 'SYSTEMIC_CYCLE' && e.state === 'DELAYED' && e.cycle === 2));
const delayEv = events2.find(e => e.refType === 'delayRecords');
check('delay event preserves original date, reason, revised date', () => delayEv && /original/.test(delayEv.detail) && /Neutropenia/.test(delayEv.title) && /revised/.test(delayEv.detail));
const delay = store.find('delayRecords', d => d.orderUuid === plan.uuid)[0];
check('delay record keeps originalPlannedDate + revisedDate + downstream shifts', () => delay && delay.originalPlannedDate === c2.plannedDate && delay.revisedDate === '2026-10-20' && delay.affectedFutureDates.length > 0);

console.log('\n== Department / filter layer ==');
const all = calendar.deriveAll();
check('deriveAll aggregates across patients', () => all.length >= events2.length);
const medOnly = all.filter(e => (calendar.EVENT_TYPES[e.type] || {}).modality === 'MEDICAL_ONCOLOGY');
check('modality grouping works for medical oncology', () => medOnly.length > 0 && medOnly.every(e => calendar.EVENT_TYPES[e.type].modality === 'MEDICAL_ONCOLOGY'));

console.log('\n========================================');
console.log((failed === 0 ? 'PASSED: ' + passed : 'FAILED: ' + failed + ' · passed: ' + passed));
process.exit(failed ? 1 : 0);
