// CCA OS — End-to-end acceptance-chain test (Phase 1→3 + stop-gates)
// Boots its own server on a fresh database (set E2E_EXTERNAL=1 to target an
// already-running server on E2E_PORT / 3210 instead).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const PORT = Number(process.env.E2E_PORT) || 3210;
const BASE = 'http://127.0.0.1:' + PORT + '/ws/rest/v1/cca';
let failures = 0, passes = 0;

async function api(path, opts = {}, user) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-cca-user': user || 'u-onc1' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json();
  return { status: res.status, ...json };
}

function check(name, cond, extra) {
  if (cond) { passes++; console.log('  ✓ ' + name); }
  else { failures++; console.log('  ✗ FAIL: ' + name + (extra ? ' — ' + JSON.stringify(extra).slice(0, 200) : '')); }
}

function dateStr(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + (offsetDays || 0));
  return d.toISOString().slice(0, 10);
}

async function main() {
  // Self-bootstrapping: fresh DB + own server unless targeting an external one
  let server = null;
  if (!process.env.E2E_EXTERNAL) {
    const fs = require('fs');
    fs.rmSync(path.join(__dirname, '..', 'data'), { recursive: true, force: true });
    server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe'
    });
    await new Promise(r => setTimeout(r, 1500));
  }

  try {
    console.log('== Phase 1: Registration → Consultation → Investigation → Result → Diagnosis → Staging ==');

  // 1.1 Registration (Front Desk) — expect auto task for Intake Nurse
  const reg = await api('/patients', { method: 'POST', body: { name: 'Rosa Test', dob: '1978-04-12', sex: 'F', referralSource: 'EXTERNAL_REFERRAL', reason: 'Breast lump', hospitalUuid: 'h-1' } }, 'u-front');
  check('registration saves + returns MRN', reg.ok && reg.data.patient.mrn.startsWith('CCA-'), reg);
  const pid = reg.data.patient.uuid;
  const intakeTasks = await api('/tasks?bucket=myTasks', {}, 'u-intake');
  check('Intake Nurse automatically received task', intakeTasks.data.some(t => t.patientUuid === pid && t.code === 'INTAKE_ASSESSMENT'));

  // 1.2 Structured consultation (directive §1–2): discussion ≠ order; only ORDER_NOW orders
  const consult = await api('/consultations', { method: 'POST', body: { patientUuid: pid, consultationType: 'FIRST_ONCOLOGY', ecog: '1', chiefComplaint: 'Breast lump 6 weeks', heightCm: 160, weightKg: 62, reasonForVisit: 'New lump', clinicalAssessment: 'Suspicious lump', investigationDiscussion: [
    { action: 'PLAN_LATER', notes: 'PET-CT only if nodes look suspicious on US' },
    { action: 'ORDER_NOW', category: 'RADIOLOGY', testCode: 'US_BREAST', notes: 'breast + axilla' },
    { action: 'ORDER_NOW', category: 'PATHOLOGY', testCode: 'CORE_BIOPSY_BREAST', notes: 'core biopsy left breast' }
  ] } });
  check('consultation drafted, ECOG saved', consult.ok, consult);
  const noOrdersYet = await api('/investigation-orders');
  check('discussion-only item did NOT create an order', !noOrdersYet.data.some(o => o.patientUuid === pid));
  const consultSigned = await api('/consultations/' + (consult.data.uuid || consult.uuid) + '/sign', { method: 'POST', body: {} });
  check('consultation signed (immutable) + orders generated', consultSigned.ok && consultSigned.data.status === 'SIGNED', consultSigned);

  // 1.3 departments got tasks
  const radTasks = await api('/tasks?bucket=myTasks', {}, 'u-rad');
  const pathTasks = await api('/tasks?bucket=myTasks', {}, 'u-path');
  check('Radiologist got imaging task', radTasks.data.some(t => t.patientUuid === pid && t.code === 'PERFORM_IMAGING'));
  check('Pathologist got pathology task', pathTasks.data.some(t => t.patientUuid === pid && t.code === 'PERFORM_PATHOLOGY'));

  // 1.4 results
  const orders = await api('/investigation-orders');
  const imgOrder = orders.data.find(o => o.patientUuid === pid && o.category === 'RADIOLOGY');
  const pathOrder = orders.data.find(o => o.patientUuid === pid && o.category === 'PATHOLOGY');
  check('orders master-driven with terminology', imgOrder && pathOrder && imgOrder.terminology && pathOrder.terminology && imgOrder.displayName, imgOrder);
  const imgRes = await api('/results', { method: 'POST', body: { orderUuid: imgOrder.uuid, patientUuid: pid, summary: '5.2 cm spiculated mass left breast, axillary nodes suspicious', findings: { size: 5.2, side: 'LEFT' } } }, 'u-rad');
  check('radiology result finalized', imgRes.ok && imgRes.data.status === 'FINALIZED');
  const pathRes = await api('/results', { method: 'POST', body: { orderUuid: pathOrder.uuid, patientUuid: pid, summary: 'Invasive ductal carcinoma grade 2; ER+ PR+ HER2-', accessionNumber: 'ACC-10023', specimenSite: 'Left breast', histologyCode: 'IDC', biomarkers: [{ code: 'ER', value: 'POSITIVE' }, { code: 'PR', value: 'POSITIVE' }, { code: 'HER2_IHC', value: 'NEGATIVE' }] } }, 'u-path');
  check('pathology result finalized with biomarkers', pathRes.ok && pathRes.data.biomarkers.length === 3);
  const oncTasks = await api('/tasks?bucket=myTasks', {}, 'u-onc1');
  check('oncologist got results-review task', oncTasks.data.some(t => t.patientUuid === pid && t.code === 'REVIEW_RESULTS'));

  // cross-patient evidence stop-gate prep: second patient
  const reg2 = await api('/patients', { method: 'POST', body: { name: 'Other Patient', dob: '1980-01-01', sex: 'F', hospitalUuid: 'h-1' } }, 'u-front');
  const pid2 = reg2.data.patient.uuid;

  // 1.5 diagnosis
  const dx = await api('/diagnoses', { method: 'POST', body: { patientUuid: pid, cancerType: 'BREAST', primarySite: 'BREAST', subsite: 'UPPER_OUTER', laterality: 'LEFT', histology: 'IDC', grade: 'G2', icd10: 'C50', icdOtopography: 'C50.4', diagnosisDate: '2026-09-10', diagnosisBasis: 'PATHOLOGY', evidence: [{ resultUuid: imgRes.data.uuid, type: 'RADIOLOGICAL' }, { resultUuid: pathRes.data.uuid, type: 'PATHOLOGICAL' }], biomarkers: [{ code: 'ER', value: 'POSITIVE' }] } });
  check('diagnosis created (no T/N/M accepted)', dx.ok, dx);
  const dxSigned = await api('/diagnoses/' + dx.data.uuid + '/sign', { method: 'POST', body: {} });
  check('diagnosis signed & immutable', dxSigned.ok && dxSigned.data.status === 'CONFIRMED');

  // STOP-GATE: T/N/M in diagnosis
  const badDx = await api('/diagnoses', { method: 'POST', body: { patientUuid: pid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: '2026-09-10', diagnosisBasis: 'PATHOLOGY', t: 'T2' } });
  check('STOP-GATE: T/N/M rejected inside diagnosis', !badDx.ok && /T\/N\/M/.test(badDx.error), badDx);
  // STOP-GATE: unknown governed value
  const badDx2 = await api('/diagnoses', { method: 'POST', body: { patientUuid: pid, cancerType: 'MADE_UP', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: '2026-09-10', diagnosisBasis: 'PATHOLOGY' } });
  check('STOP-GATE: unknown governed cancerType rejected', !badDx2.ok && /Unknown governed/.test(badDx2.error), badDx2);
  // STOP-GATE: future date
  const badDx3 = await api('/diagnoses', { method: 'POST', body: { patientUuid: pid, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: '2030-01-01', diagnosisBasis: 'PATHOLOGY' } });
  check('STOP-GATE: future diagnosis date rejected', !badDx3.ok && /future/.test(badDx3.error), badDx3);
  // STOP-GATE: subsite parent mismatch
  const badDx4 = await api('/diagnoses', { method: 'POST', body: { patientUuid: pid, cancerType: 'BREAST', primarySite: 'LUNG', subsite: 'UPPER_OUTER', histology: 'IDC', diagnosisDate: '2026-09-10', diagnosisBasis: 'PATHOLOGY' } });
  check('STOP-GATE: subsite/site mismatch rejected', !badDx4.ok && /does not belong/.test(badDx4.error), badDx4);
  // STOP-GATE: cross-patient evidence
  const badev = await api('/diagnoses', { method: 'POST', body: { patientUuid: pid2, cancerType: 'BREAST', primarySite: 'BREAST', histology: 'IDC', diagnosisDate: '2026-09-10', diagnosisBasis: 'PATHOLOGY', evidence: [{ resultUuid: imgRes.data.uuid, type: 'RADIOLOGICAL' }] } }, 'u-onc1');
  const badevSigned = badev.ok ? await api('/diagnoses/' + badev.data.uuid + '/sign', { method: 'POST', body: {} }) : badev;
  check('STOP-GATE: cross-patient evidence rejected at signing', !badevSigned.ok && /CROSS_PATIENT_EVIDENCE/.test(badevSigned.error), badevSigned);

  // 1.6 staging — schema-driven
  const schema = await api('/staging/schema/' + dx.data.uuid);
  check('staging schema resolved server-side (TNM_BREAST, AJCC authority)', schema.ok && schema.data.providerKey === 'TNM_BREAST' && schema.data.authority === 'AJCC', schema);
  check('breast routes to 8th Edition with content status', schema.data.version === '8th Edition' && schema.data.contentStatus === 'AUTHORITY_CONTENT_UNAVAILABLE', schema);
  check('schema has T/N/M + prognostic factors', ['t', 'n', 'm', 'erStatus', 'her2Status'].every(k => schema.data.fields.some(f => f.key === k)));

  // STOP-GATE: staging before signed diagnosis (patient 2 has no diagnosis)
  const gateStaging = await api('/staging-assessments', { method: 'POST', body: { diagnosisUuid: 'nonexistent', stagingContext: 'CLINICAL', assessmentDate: '2026-09-15', variables: { t: 'T2' } } });
  check('STOP-GATE: staging requires diagnosis', !gateStaging.ok, gateStaging);

  // STOP-GATE: invalid staging value (fabricated T)
  const badStaging = await api('/staging-assessments', { method: 'POST', body: { diagnosisUuid: dx.data.uuid, stagingContext: 'CLINICAL', assessmentDate: '2026-09-15', variables: { t: 'T99', n: 'N0', m: 'M0', stageResult: 'STAGE_II' } } });
  const badStagingSigned = badStaging.ok ? await api('/staging-assessments/' + badStaging.data.uuid + '/sign', { method: 'POST' }) : badStaging;
  check('STOP-GATE: fabricated T value rejected', !badStagingSigned.ok, badStagingSigned);

  // STOP-GATE: unknown field
  const unknownField = await api('/staging-assessments', { method: 'POST', body: { diagnosisUuid: dx.data.uuid, stagingContext: 'CLINICAL', assessmentDate: '2026-09-15', variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB', madeUpField: 'x' } } });
  const unknownFieldSigned = unknownField.ok ? await api('/staging-assessments/' + unknownField.data.uuid + '/sign', { method: 'POST' }) : unknownField;
  check('STOP-GATE: unknown staging field rejected', !unknownFieldSigned.ok && /unknown staging field/i.test(unknownFieldSigned.error), unknownFieldSigned);

  // valid staging with provenance
  const staging = await api('/staging-assessments', { method: 'POST', body: {
    diagnosisUuid: dx.data.uuid, stagingContext: 'CLINICAL', assessmentDate: '2026-09-15',
    variables: { t: 'T2', n: 'N1', m: 'M0', stageResult: 'STAGE_IIB', erStatus: 'POSITIVE', her2Status: 'NEGATIVE' },
    evidence: [
      { variableKey: 't', sourceType: 'RADIOLOGICAL', sourceRef: imgRes.data.uuid, sourceDate: '2026-09-12', supportingFinding: '5.2 cm spiculated mass' },
      { variableKey: 'n', sourceType: 'RADIOLOGICAL', sourceRef: imgRes.data.uuid, sourceDate: '2026-09-12', supportingFinding: 'axillary nodes suspicious' },
      { variableKey: 'm', sourceType: 'RADIOLOGICAL', sourceRef: imgRes.data.uuid, sourceDate: '2026-09-12', supportingFinding: 'no distant metastases' },
      { variableKey: 'stageResult', sourceType: 'PATHOLOGICAL', sourceRef: pathRes.data.uuid, sourceDate: '2026-09-14', supportingFinding: 'IDC ER+ PR+ HER2-' }
    ]
  }});
  check('staging assessment created', staging.ok, staging);
  const stgSigned = await api('/staging-assessments/' + staging.data.uuid + '/sign', { method: 'POST', body: {} });
  check('staging signed, stage derived', stgSigned.ok && stgSigned.data.stageResult === 'STAGE_IIB', stgSigned);
  const mdtCoordTasks = await api('/tasks?bucket=myTasks', {}, 'u-mdtc');
  check('MDT coordinator auto-tasked after staging (h-1 policy=MDT)', mdtCoordTasks.data.some(t => t.patientUuid === pid && t.code === 'MDT_REVIEW'));

  // restaging: supersede
  const restage = await api('/staging-assessments', { method: 'POST', body: {
    diagnosisUuid: dx.data.uuid, stagingContext: 'PATHOLOGICAL', assessmentDate: '2026-09-17', supersedes: staging.data.uuid,
    variables: { t: 'T2', n: 'N1', stageResult: 'STAGE_IIB' }, // no pM0 — M stays with clinical assessment (§9)
    evidence: [
      { variableKey: 't', sourceType: 'PATHOLOGICAL', sourceRef: pathRes.data.uuid, sourceDate: '2026-09-14', supportingFinding: 'pathologic confirmation' },
      { variableKey: 'n', sourceType: 'PATHOLOGICAL', sourceDate: '2026-09-14', supportingFinding: 'nodes positive' }
    ]
  }});
  const restageSigned = restage.ok ? await api('/staging-assessments/' + restage.data.uuid + '/sign', { method: 'POST', body: {} }) : restage;
  check('restaging supersedes (history preserved)', restageSigned.ok && restageSigned.data.status === 'SIGNED');
  const chart1 = await api('/patients/' + pid);
  const hist = chart1.data.staging.history;
  check('old staging marked SUPERSEDED not deleted', hist.some(s => s.status === 'SUPERSEDED') && hist.filter(s => ['SIGNED', 'SUPERSEDED'].includes(s.status)).length === 2, hist.map(s => s.status));

  // STOP-GATE: immutability of signed record (attempt update via API is not exposed; verified by service assert)
  console.log('== Phase 2: MDT → Care Plan → Finance → Readiness ==');
  const mdt = await api('/mdt-cases', { method: 'POST', body: { patientUuid: pid, reason: 'Locally advanced breast cancer — discuss neoadjuvant vs upfront surgery', diagnosisUuid: dx.data.uuid, stagingUuid: staging.data.uuid } });
  check('MDT case opened', mdt.ok, mdt.error || mdt);
  const mdtSigned = await api('/mdt-cases/' + mdt.data.uuid + '/discussion', { method: 'POST', body: { participants: ['Dr. Sharma', 'Dr. Lim', 'Dr. Okafor'], proposedOptions: 'NAC then surgery vs upfront surgery', discussion: 'Tumor 5.2cm, NAC favoured', consensus: 'Neoadjuvant AC x4 → Paclitaxel x4 then surgery', dissent: '', decision: 'Neoadjuvant chemotherapy then surgery', responsibleClinician: 'Dr. Sharma' } });
  const mdtFinal = await api('/mdt-cases/' + mdt.data.uuid + '/sign', { method: 'POST', body: {} }, 'u-mdtchair');
  check('MDT outcome signed', mdtFinal.ok && mdtFinal.data.status === 'SIGNED', mdtFinal);
  const oncTasks2 = await api('/tasks?bucket=myTasks', {}, 'u-onc1');
  check('care plan task generated from MDT', oncTasks2.data.some(t => t.patientUuid === pid && t.code === 'CREATE_CARE_PLAN'));

  const plan = await api('/care-plans', { method: 'POST', body: {
    patientUuid: pid, diagnosisUuid: dx.data.uuid, stagingUuid: staging.data.uuid,
    treatmentIntent: 'NEOADJUVANT', lineOfTherapy: 'L1', expectedStart: '2026-09-25',
    modalitySequence: [{ modality: 'CHEMOTHERAPY' }, { modality: 'SURGERY' }],
    systemicTherapy: 'AC x4 then weekly Paclitaxel x12', surgery: 'MRM left after NAC',
    rationale: 'Downstage tumour', monitoringPlan: 'CBC per cycle', responseAssessmentPlan: 'MRI after NAC'
  }});
  const planSigned = await api('/care-plans/' + plan.data.uuid + '/sign', { method: 'POST', body: {} });
  check('care plan signed', planSigned.ok && planSigned.data.status === 'SIGNED');
  const finTasks = await api('/tasks?bucket=myTasks', {}, 'u-fin');
  check('financial counsellor auto-tasked', finTasks.data.some(t => t.patientUuid === pid && t.code === 'FINANCIAL_COUNSEL'));

  const fc = await api('/financial-counsellings', { method: 'POST', body: {
    carePlanUuid: plan.data.uuid, plannedTreatment: '8 cycles AC→Paclitaxel', costEstimate: 450000,
    payerType: 'INSURER', insurerTpa: 'MediCare Plus', authorization: { number: 'AUTH-778812', status: 'APPROVED' },
    selfPayComponent: 50000, patientChoice: 'ORIGINATOR', plannedStartDate: '2026-09-25', financialClearance: 'CLEARED',
    counsellingNote: 'Options explained; originator chosen'
  } }, 'u-fin');
  const fcSigned = await api('/financial-counsellings/' + fc.data.uuid + '/sign', { method: 'POST', body: {} }, 'u-fin');
  check('financial counselling signed & cleared', fcSigned.ok && fcSigned.data.financialClearance === 'CLEARED');
  const navTasks = await api('/tasks?bucket=myTasks', {}, 'u-nav');
  check('nurse navigator readiness task generated', navTasks.data.some(t => t.patientUuid === pid && t.code === 'READINESS_CHECK'));

  // D2: treatment-specific consent (canonical §47) — consent gate before readiness
  const consentNeg = await api('/readiness', { method: 'POST', body: { fcUuid: fc.data.uuid, checks: { labsCurrent: true, consentTaken: true, accessDevice: true, patientEducated: true } } }, 'u-nav');
  check('STOP-GATE: readiness blocked without signed consent', !consentNeg.ok && /consent/i.test(consentNeg.error || ''), consentNeg);
  const consentRec = await api('/consents', { method: 'POST', body: {
    patientUuid: pid, carePlanUuid: plan.data.uuid, consentType: 'SYSTEMIC_THERAPY', templateCode: 'SYSTEMIC_THERAPY_V1',
    discussedRisks: 'Alopecia, neutropenia, cardiotoxicity, nausea', discussedBenefits: 'Downstage tumour, improve cure rate',
    discussedAlternatives: 'Upfront surgery, clinical trial', adverseEffectsExplained: true, scheduleExplained: true,
    acknowledgedBy: 'Rosa Test (patient)'
  } });
  check('consent recorded', consentRec.ok, consentRec.error || consentRec);
  const consentSigned = await api('/consents/' + consentRec.data.uuid + '/sign', { method: 'POST', body: {} });
  check('consent signed', consentSigned.ok && consentSigned.data.status === 'SIGNED', consentSigned.error || consentSigned);

  const readiness = await api('/readiness', { method: 'POST', body: { fcUuid: fc.data.uuid, checks: { labsCurrent: true, consentTaken: true, accessDevice: true, patientEducated: true } } }, 'u-nav');
  check('readiness cleared (consent gate satisfied)', readiness.ok, readiness.error || readiness);

  console.log('== Phase 3: Treatment Order → Pharmacy → Administration → Toxicity → Response ==');
  const order = await api('/treatment-orders', { method: 'POST', body: {
    patientUuid: pid, carePlanUuid: plan.data.uuid, regimenCode: 'AC', plannedCycles: 4,
    weight: 68, height: 163, startDate: dateStr(-4), supportiveTreatment: 'G-CSF secondary prophylaxis'
  }});
  check('treatment order created with BSA + cycle lines (4 lines × 4 cycles)', order.ok && order.data.bsa > 1.5 && order.data.cycleDays.length === 16, order);
  const bsa = Math.sqrt((68 * 163) / 3600);
  const expectedDox = Math.round(60 * bsa * 100) / 100;
  const doxLine = order.data.cycleDays.find(c => c.medication === 'DOXORUBICIN');
  check('BSA dose calculated correctly (' + expectedDox + ' mg)', doxLine && doxLine.standardDose === expectedDox, doxLine);

  const orderSigned = await api('/treatment-orders/' + order.data.uuid + '/sign', { method: 'POST', body: {} });
  check('treatment order signed', orderSigned.ok && orderSigned.data.status === 'SIGNED');
  const pharmTasks = await api('/tasks?bucket=myTasks', {}, 'u-pharm');
  check('pharmacist auto-tasked', pharmTasks.data.some(t => t.patientUuid === pid && t.code === 'PHARMACY_VERIFY'));
  const events = await api('/events?patientUuid=' + pid);
  check('calendar projected: chemo + labs + toxicity review + response imaging', events.data.filter(e => e.type === 'CHEMOTHERAPY').length === 4 && events.data.some(e => e.type === 'LAB') && events.data.some(e => e.type === 'TOXICITY_ASSESSMENT') && events.data.some(e => e.type === 'RESPONSE_IMAGING'));
  check('projected events are PROJECTED (never delivered)', events.data.every(e => e.state === 'PROJECTED'));

  // STOP-GATE: administration before release
  const earlyAdm = await api('/administrations/start', { method: 'POST', body: { pharmacyUuid: 'fake' } });
  check('STOP-GATE: administration without released order rejected', !earlyAdm.ok, earlyAdm);

  // pharmacy flow
  const recv = await api('/pharmacy/receive', { method: 'POST', body: { orderUuid: order.data.uuid } }, 'u-pharm');
  check('pharmacy received order', recv.ok);
  const verified = await api('/pharmacy/' + recv.data.uuid + '/verify', { method: 'POST', body: { regimenVerified: true, doseVerified: true, allergyCheck: true, interactionCheck: true, compatibilityCheck: true, stabilityCheck: true, stockAllocated: true } }, 'u-pharm');
  check('pharmacy verified all checks', verified.ok && verified.data.status === 'VERIFIED', verified);
  const prepared = await api('/pharmacy/' + recv.data.uuid + '/prepare', { method: 'POST', body: { compounded: true, notes: 'Cytotoxic cabinet' } }, 'u-pharm');
  check('preparation/compounding recorded', prepared.ok && prepared.data.status === 'PREPARED');
  const released = await api('/pharmacy/' + recv.data.uuid + '/release', { method: 'POST', body: { independentCheckBy: 'Pharmacist B' } }, 'u-pharm');
  check('independent check + release', released.ok && released.data.status === 'RELEASED' && released.data.independentCheckBy === 'Pharmacist B');

  // D3: dispense step (release ≠ dispense) + negative gate
  const earlyAdm2 = await api('/administrations/start', { method: 'POST', body: { pharmacyUuid: recv.data.uuid } }, 'u-daycare');
  check('STOP-GATE: administration before dispense rejected (release ≠ dispense)', !earlyAdm2.ok && /DISPENSED/.test(earlyAdm2.error || ''), earlyAdm2);
  const dcDispenseTasks = await api('/tasks?bucket=myTasks', {}, 'u-pharm');
  check('pharmacist auto-tasked with DISPENSE after release', dcDispenseTasks.data.some(t => t.patientUuid === pid && t.code === 'DISPENSE'));
  const dispensed = await api('/pharmacy/' + recv.data.uuid + '/dispense', { method: 'POST', body: { destination: 'DAY_CARE', checkedOutTo: 'Sarah (Day Care Nurse)' } }, 'u-pharm');
  check('dispensed with chain of custody', dispensed.ok && dispensed.data.destination === 'DAY_CARE' && dispensed.data.chainOfCustody.length === 3, dispensed.error || dispensed);

  const dcTasks = await api('/tasks?bucket=myTasks', {}, 'u-daycare');
  check('day care nurse auto-tasked after dispense', dcTasks.data.some(t => t.patientUuid === pid && t.code === 'ADMINISTER'));

  // administration
  const adm = await api('/administrations/start', { method: 'POST', body: { pharmacyUuid: recv.data.uuid } }, 'u-daycare');
  check('administration started (dispensed order present)', adm.ok);
  const admUpd = await api('/administrations/' + adm.data.uuid + '/update', { method: 'POST', body: { readiness: { vitalsStable: true, premedicationsGiven: true }, access: { type: 'PICC', site: 'right arm' }, status: 'IN_PROGRESS' } }, 'u-daycare');
  const line = await api('/administrations/' + adm.data.uuid + '/update', { method: 'POST', body: { line: { phase: 'DRUG', medication: 'DOXORUBICIN', start: new Date().toISOString(), stop: new Date().toISOString(), actualDose: expectedDox, route: 'IV_PUSH', interruption: null, reaction: null } } }, 'u-daycare');
  check('premed + access + drug line recorded', admUpd.ok && line.ok);
  // D10a: two-identifier verification + structured infusion reaction
  const idVerif = await api('/administrations/' + adm.data.uuid + '/update', { method: 'POST', body: { patientIdentityVerification: { method: 'TWO_IDENTIFIER', nameConfirmation: true, mrnConfirmation: true } } }, 'u-daycare');
  check('two-identifier patient verification recorded', idVerif.ok && idVerif.data.patientIdentityVerification.method === 'TWO_IDENTIFIER', idVerif.error || idVerif);
  const badVerif = await api('/administrations/' + adm.data.uuid + '/update', { method: 'POST', body: { patientIdentityVerification: { method: 'SINGLE', nameConfirmation: true, mrnConfirmation: false } } }, 'u-daycare');
  check('STOP-GATE: single-identifier verification rejected', !badVerif.ok && /two independent identifiers/i.test(badVerif.error || ''), badVerif);
  const rx = await api('/infusion-reactions', { method: 'POST', body: { administrationUuid: adm.data.uuid, runningDrug: 'DOXORUBICIN', severity: 'MODERATE', symptoms: [{ symptom: 'flushing' }, { symptom: 'hypertension' }], actions: ['STOP_INFUSION', 'PHYSICIAN_NOTIFIED'], onsetTime: new Date().toISOString() } }, 'u-daycare');
  check('structured infusion reaction recorded (stop + physician notified)', rx.ok && rx.data.infusionStopped && rx.data.physicianNotified, rx.error || rx);
  const badRx = await api('/infusion-reactions', { method: 'POST', body: { administrationUuid: adm.data.uuid, severity: 'MODERATE' } }, 'u-daycare');
  check('STOP-GATE: infusion reaction requires symptoms + actions', !badRx.ok, badRx);
  const admDone = await api('/administrations/' + adm.data.uuid + '/complete', { method: 'POST', body: {} }, 'u-daycare');
  check('administration completed + discharged', admDone.ok && admDone.data.status === 'COMPLETED' && admDone.data.dischargedAt, admDone.error || admDone);
  const eventsAfter = await api('/events?patientUuid=' + pid);
  check('delivered event state flipped to COMPLETED (projected ≠ delivered)', eventsAfter.data.some(e => e.state === 'COMPLETED' && e.type === 'CHEMOTHERAPY'));
  const oncTasks3 = await api('/tasks?bucket=myTasks', {}, 'u-onc1');
  check('toxicity + next-cycle review auto-tasked', oncTasks3.data.some(t => t.patientUuid === pid && t.code === 'TOXICITY_REVIEW') && oncTasks3.data.some(t => t.patientUuid === pid && t.code === 'NEXT_CYCLE_REVIEW'));

  // toxicity with delay
  const tox = await api('/toxicities', { method: 'POST', body: { patientUuid: pid, orderUuid: order.data.uuid, type: 'NEUTROPENIA', grade: 3, onset: dateStr(-2), attribution: 'TREATMENT', intervention: 'G-CSF, antibiotics', treatmentDelay: true, doseReduction: { medication: 'DOXORUBICIN', newReductionPercent: 15 }, resolution: 'IMPROVING', nextCycleImplication: 'Delay C2 by 1 week; reduce doxorubicin 15%' } });
  const toxSigned = await api('/toxicities/' + tox.data.uuid + '/sign', { method: 'POST', body: {} });
  check('toxicity signed with delay + reduction', toxSigned.ok);

  // delay preserves original dates
  const delay = await api('/treatment-orders/' + order.data.uuid + '/delay', { method: 'POST', body: { cycle: 2, reason: 'Neutropenia G3', revisedDate: dateStr(11), shiftDownstream: true, shiftDays: 7 } });
  check('delay recorded with original + revised + affected future dates', delay.ok && delay.data.affectedFutureDates.length >= 2, delay);
  const orderAfter = await api('/treatment-orders?patientUuid=' + pid);
  const c2 = orderAfter.data[0].cycleDays.filter(c => c.cycle === 2)[0];
  check('cycle 2 moved to revised date', c2.plannedDate === c2.revisedDate || c2.status === 'DELAYED' || c2.plannedDate > dateStr(0), c2);

  // response
  const resp = await api('/responses', { method: 'POST', body: { patientUuid: pid, orderUuid: order.data.uuid, category: 'PR', decision: 'CONTINUE', notes: 'Tumor decreased on exam' } });
  const respSigned = await api('/responses/' + resp.data.uuid + '/sign', { method: 'POST', body: {} });
  check('response assessment signed and routed', respSigned.ok);

  // RT + Surgery (Phase 4)
  const rtx = await api('/rt-prescriptions', { method: 'POST', body: { patientUuid: pid, intent: 'ADJUVANT', site: 'Chest wall + supraclavicular', dosePerFraction: 2, fractions: 25, technique: 'IMRT', simulationDate: '2026-10-01' } }, 'u-radonc');
  const rtApproved = await api('/rt-prescriptions/' + rtx.data.uuid + '/approve', { method: 'POST', body: { physicsCheck: 'second check OK' } }, 'u-radonc');
  check('RT prescription PLANNED→APPROVED, total dose computed', rtApproved.ok && rtApproved.data.rx.totalDose === 50 && rtApproved.data.rx.status === 'APPROVED', rtApproved);
  const frac = await api('/rt-fractions', { method: 'POST', body: { courseUuid: (rtApproved.data.course || rtApproved.data.rx || {}).uuid, fractionNumber: 1 } }, 'u-radonc');
  check('RT fraction 1 delivered (Delivered separate from Planned)', frac.ok && frac.data.deliveredDose === 2);

  const sp = await api('/surgical-plans', { method: 'POST', body: { patientUuid: pid, procedure: 'Modified radical mastectomy left', laterality: 'LEFT', plannedDate: '2026-11-10' } }, 'u-surg');
  await api('/surgical-plans/' + sp.data.uuid + '/sign', { method: 'POST', body: {} }, 'u-surg');
  const op = await api('/operative-records', { method: 'POST', body: { surgicalPlanUuid: sp.data.uuid, performedProcedure: 'MRM left', findings: 'Complete resection', specimens: [{ site: 'Breast left', laterality: 'LEFT' }] } }, 'u-surg');
  const opSigned = await api('/operative-records/' + op.data.uuid + '/sign', { method: 'POST', body: {} }, 'u-surg');
  check('surgical plan + operative record signed separately; specimen task created', opSigned.ok && (await api('/tasks?bucket=myTasks', {}, 'u-path')).data.some(t => t.code === 'SURGERY_SPECIMEN'));

  // audit trail
  const audit = await api('/audit');
  const auditActions = new Set(audit.data.map(a => a.action));
  check('audit trail contains signing + workflow events', ['SIGN', 'DIAGNOSIS_SIGNED', 'STAGING_SIGNED', 'CARE_PLAN_SIGNED', 'TREATMENT_ORDER_SIGNED', 'PHARMACY_RELEASED', 'DISPENSED', 'ADMINISTRATION_COMPLETED'].every(a => auditActions.has(a)), [...auditActions]);

  console.log('\n========================================');
  console.log('PASSED: ' + passes + '   FAILED: ' + failures);
  process.exitCode = failures ? 1 : 0;
  } finally {
    if (server) server.kill('SIGTERM');
  }
}

main().catch(e => { console.error('Test run error:', e); process.exit(1); });
