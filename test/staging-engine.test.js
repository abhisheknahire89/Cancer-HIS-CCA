// CCA OS — Automatic staging engine tests (staging mandate §43–§50)
// Deterministic regression suite for the automatic staging/classification engine:
// status semantics, wrong-schema routing, evidence integration, non-TNM (no T/N/M),
// and the engine gate behind an AUTOMATIC_ENGINE sign. No server required.
// Run: node test/staging-engine.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-staging-engine-'));
process.env.CCA_DATA_DIR = path.join(TMP, 'data');

const store = require('../src/store');
const masters = require('../src/masters');
const clinical = require('../src/clinical');
const flow = require('../src/clinical-flow');
const engine = require('../src/staging-engine');
const providers = require('../src/staging-providers');

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

const MO = { uuid: 'a-mo', name: 'Dr. Derive', role: 'Medical Oncologist' };
store.insert('hospitals', { uuid: 'h-auto', name: 'CCA Auto', mdtPolicy: { MM: 'DIRECT_PLAN' } });

console.log('\n== §43/§47 SETUP: MM patient — CONFIRMED diagnosis → automatic schema routing ==');
const { patient } = clinical.registerPatient({ uuid: 'a-front', name: 'FD', role: 'Front Desk' }, {
  name: 'Auto Engine Test', mrn: 'AUTO-1', sex: 'F', dob: '1962-02-02', phone: '555-0100', address: '1 Way', hospitalUuid: 'h-auto'
});
const consult = clinical.recordConsultation(MO, { patientUuid: patient.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 1, chiefComplaint: 'fatigue', clinicalAssessment: 'suspected myeloma' });
clinical.signConsultation(MO, consult.uuid);
const dx = flow.recordDiagnosis(MO, {
  patientUuid: patient.uuid, episodeUuid: consult.episodeUuid, cancerFamily: 'HAEMATOLOGICAL_FAMILY',
  cancerType: 'MM', primarySite: 'BONE_MARROW', histology: 'PLASMA_CELL', icd10: 'C90',
  icdOVersion: 'ICD-O-3.2', diagnosisDate: dateStr(-3), diagnosisBasis: 'BONE_MARROW'
});
const dxSigned = flow.signDiagnosis(MO, dx.uuid);

const schema = clinical.stagingSchemaFor(dxSigned.uuid);
check('diagnosis → schema auto-resolved (no clinician pack picking)', schema.providerKey === 'MM' && schema.authority === 'ISS_RISS');
check('no T/N/M fields for non-TNM schema (§47)', !['t', 'n', 'm'].some(k => schema.fields.some(f => f.key === k)));
check('derivation pack AVAILABLE for MM (public IMWG criteria)', schema.engine.status === 'AVAILABLE' && schema.engine.packId === 'MYELOMA_ISS_RISS_PUBLIC');
check('engine availability reported honestly for TNM disease (breast → CONTENT_PROVIDER_UNAVAILABLE)', (() => {
  const { patient: p2 } = clinical.registerPatient({ uuid: 'a-front', name: 'FD', role: 'Front Desk' }, {
    name: 'Breast Engine Test', mrn: 'AUTO-2', sex: 'F', dob: '1975-05-05', phone: '555-0101', address: '2 Way', hospitalUuid: 'h-auto'
  });
  const c2 = clinical.recordConsultation(MO, { patientUuid: p2.uuid, consultationType: 'FIRST_ONCOLOGY', ecog: 1, chiefComplaint: 'lump', clinicalAssessment: 'breast mass' });
  clinical.signConsultation(MO, c2.uuid);
  const dx2 = flow.recordDiagnosis(MO, {
    patientUuid: p2.uuid, episodeUuid: c2.episodeUuid, cancerFamily: 'BREAST_FAMILY', cancerType: 'BREAST',
    primarySite: 'BREAST', histology: 'IDC', icd10: 'C50', icdOVersion: 'ICD-O-3.2', diagnosisDate: dateStr(-2), diagnosisBasis: 'IMAGING'
  });
  const s = clinical.stagingSchemaFor(flow.signDiagnosis(MO, dx2.uuid).uuid);
  return s.providerKey === 'TNM_BREAST' && s.engine.status === 'CONTENT_PROVIDER_UNAVAILABLE';
})());
check('TNM disease schema carries objective FACT inputs (§8)', (() => {
  const bf = providers.inputSchema({ cancerType: 'BREAST' }).fields.filter(f => ['tumourSizeMm', 'chestWallInvolvement', 'skinInvolvement', 'regionalNodesPositive', 'distantMetastasis', 'metastaticSites'].includes(f.key));
  return bf.length === 6 && bf.find(f => f.key === 'metastaticSites').visibleWhen.value === true;
})());

console.log('\n== §43 complete input → CALCULATED with trace ==');
const good = { beta2Microglobulin: 4.2, albumin: 3.8 };
const r = engine.evaluate(schema.fields, engine.packFor(schema.providerKey, schema.schemaId), { classification: 'NON_TNM', variables: good });
check('CALCULATED with derived result (no clinician stage pick)', r.status === 'CALCULATED' && r.result === 'ISS_II');
check('derivation trace is machine-readable and complete (§27)', !!(r.rulesApplied.length && r.normalizedInputs.beta2Microglobulin === 4.2 && r.packId && r.version && r.calculatedAt));
check('human-readable trace explains the derivation (§28)', /β2-microglobulin.*3\.8|albumin/.test(r.rulesApplied.map(x => x.explain).join(' ')) || r.rulesApplied[0].explain.length > 10);

console.log('\n== §44 missing information → NEEDS_INFORMATION, no stage guessed ==');
const rMiss = engine.evaluate(schema.fields, engine.packFor(schema.providerKey, schema.schemaId), { classification: 'NON_TNM', variables: { albumin: 3.8 } });
check('missing β2M → NEEDS_INFORMATION naming the missing fact', rMiss.status === 'NEEDS_INFORMATION' && rMiss.missing.includes('Beta-2 microglobulin'));

console.log('\n== §45 invalid information → INVALID_INPUT ==');
const pack = engine.packFor('MM', 'MM_ISS');
const bad = engine.evaluate(schema.fields, pack, { classification: 'NON_TNM', variables: { beta2Microglobulin: 'abc', albumin: 3.8 } });
check('non-numeric measurement rejected', bad.status === 'INVALID_INPUT');
const unknown = engine.evaluate(schema.fields, pack, { classification: 'NON_TNM', variables: { beta2Microglobulin: 4, albumin: 4, unicorn: 1 } });
check('wrong-disease field rejected (§46 shape)', unknown.status === 'INVALID_INPUT' && /unknown input/.test(unknown.invalid[0]));
const badCls = engine.evaluate(schema.fields, pack, { classification: 'CLINICAL', variables: good });
check('classification the pack does not cover → content unavailable, not invalid input (§7)', badCls.status === 'CONTENT_PROVIDER_UNAVAILABLE');

console.log('\n== §46 wrong schema: breast diagnosis is never evaluated against MM pack ==');
const breastFields = providers.inputSchema({ cancerType: 'BREAST' }).fields;
const wrongSchema = engine.evaluate(breastFields, engine.packFor('TNM_BREAST', 'BREAST'), { classification: 'CLINICAL', variables: { beta2Microglobulin: 4.2, albumin: 3.8 } });
check('breast + MM pack → no pack (CONTENT_PROVIDER_UNAVAILABLE), not a fabricated stage', wrongSchema.status === 'CONTENT_PROVIDER_UNAVAILABLE');
check('MM facts entered on MM schema still derive', engine.evaluate(schema.fields, pack, { classification: 'NON_TNM', variables: good }).result === 'ISS_II');

console.log('\n== Determinism (§40): same inputs → byte-identical derivation (modulo timestamp) ==');
const strip = o => { const { calculatedAt, ...rest } = o; return JSON.stringify(rest); };
const d1 = engine.evaluate(schema.fields, pack, { classification: 'NON_TNM', variables: good });
const d2 = engine.evaluate(schema.fields, pack, { classification: 'NON_TNM', variables: { beta2Microglobulin: '4.2', albumin: '3.8' } });
check('string-coerced inputs produce the identical result', strip(d1) === strip(d2));
check('repeat run identical', strip(d1) === strip(engine.evaluate(schema.fields, pack, { classification: 'NON_TNM', variables: good })));

console.log('\n== Automatic classification result derivation (R-ISS separate from ISS, §22) ==');
const rIss3 = engine.evaluate(schema.fields, pack, { classification: 'NON_TNM', variables: { beta2Microglobulin: 6.0, albumin: 3.0, ldhElevated: true, cytogeneticRisk: 'HIGH' } });
check('ISS III with high-risk features → R-ISS III', rIss3.status === 'CALCULATED' && rIss3.result === 'ISS_III' && rIss3.prognosticStage === 'RISS_III');
check('anatomic/primary result never overwritten by prognostic (§22)', rIss3.categories.iss === 'ISS_III' && rIss3.prognosticLabel === 'R-ISS stage III');

console.log('\n== Engine gate behind AUTOMATIC_ENGINE sign (server-authoritative) ==');
const LAB = { uuid: 'a-lab', name: 'Lab', role: 'Lab' };
const bmOrder = clinical.orderInvestigation(MO, { patientUuid: patient.uuid, category: 'LAB', testCode: 'CMP', displayName: 'Comprehensive metabolic panel', priority: 'ROUTINE' });
const bmLab = clinical.recordResult(LAB, {
  patientUuid: patient.uuid, orderUuid: bmOrder.uuid,
  summary: 'β2M 4.2 mg/L; albumin 3.8 g/dL', resultDate: dateStr(-1)
});
// A lab result record: the findings text is the human record; the engine consumes
// the structured variables below. (§24/§26 evidence points at the finalized result.)
const evOk = [{ variableKey: 'beta2Microglobulin', sourceType: 'LABORATORY', sourceRef: bmLab.uuid, sourceDate: dateStr(-1), supportingFinding: 'β2M 4.2 mg/L' },
  { variableKey: 'albumin', sourceType: 'LABORATORY', sourceRef: bmLab.uuid, sourceDate: dateStr(-1), supportingFinding: 'albumin 3.8 g/dL' }];
const draft = flow.createStagingAssessment(MO, {
  diagnosisUuid: dxSigned.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  resultSource: 'AUTOMATIC_ENGINE', variables: { beta2Microglobulin: 4.2, albumin: 3.8 }, evidence: evOk
});
check('engine-derived draft created', draft.status === 'DRAFT' && draft.resultSource === 'AUTOMATIC_ENGINE');
const signed = flow.signStagingAssessment(MO, draft.uuid);
check('sign gate re-derives server-side and signs the matching result', signed.status === 'SIGNED' && signed.stageResult === 'ISS_II');
check('derivation trace persisted on the signed record (§27)', !!(signed.derivationTrace && signed.derivationTrace.status === 'CALCULATED' && signed.derivationTrace.result === 'ISS_II'));
check('MDT/direct-plan task generated from signed staging', store.find('tasks', t => t.patientUuid === patient.uuid && ['MDT_REVIEW', 'CREATE_CARE_PLAN'].includes(t.code) && t.status === 'OPEN').length >= 1);

const wrongDraft = flow.createStagingAssessment(MO, {
  diagnosisUuid: dxSigned.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  resultSource: 'AUTOMATIC_ENGINE', variables: { beta2Microglobulin: 4.2, albumin: 3.8, stageResult: 'ISS_III' }, evidence: evOk
});
// A hand-picked result on a non-TNM schema is an unknown governed field — rejected
// before derivation. (The result-match gate additionally guards schemas whose
// stageResult is a governed field, e.g. future licensed TNM packs.)
expectGate('rogue hand-picked stage rejected on the engine path', () => flow.signStagingAssessment(MO, wrongDraft.uuid), 'unknown staging field');
const missingDraft = flow.createStagingAssessment(MO, {
  diagnosisUuid: dxSigned.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  resultSource: 'AUTOMATIC_ENGINE', variables: { beta2Microglobulin: 4.2 }, evidence: [evOk[0]]
});
expectGate('sign blocked when the engine reports NEEDS_INFORMATION', () => flow.signStagingAssessment(MO, missingDraft.uuid), 'NEEDS_INFORMATION');
const badVarDraft = flow.createStagingAssessment(MO, {
  diagnosisUuid: dxSigned.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  resultSource: 'AUTOMATIC_ENGINE', variables: { beta2Microglobulin: 9000, albumin: 3.8 }, evidence: evOk
});
expectGate('sign blocked when the engine reports INVALID_INPUT', () => flow.signStagingAssessment(MO, badVarDraft.uuid), 'INVALID_INPUT');

console.log('\n== Clinician-recorded fallback unaffected (governed manual path still signs) ==');
const manual = flow.createStagingAssessment(MO, {
  diagnosisUuid: dxSigned.uuid, stagingContext: 'NON_TNM', assessmentDate: dateStr(0),
  resultSource: 'CLINICIAN_ENTERED', variables: { issStage: 'ISS_II', beta2Microglobulin: 4.2, albumin: 3.8 },
  evidence: [{ variableKey: 'issStage', sourceType: 'LABORATORY', sourceRef: bmLab.uuid, supportingFinding: 'BM/lab' }]
});
const manualSigned = flow.signStagingAssessment(MO, manual.uuid);
check('CLINICIAN_ENTERED governed path still signs (no regression)', manualSigned.status === 'SIGNED' && manualSigned.stageResult === 'ISS_II');

console.log('\n== Downstream propagation (§35): header/summary consume the signed engine result ==');
const summary = flow.getStagingSummary(patient.uuid);
check('staging summary exposes the signed automatic result as nonTnm', summary.nonTnm && summary.nonTnm.stage === 'ISS_II' && summary.nonTnm.classification === 'NON_TNM');

console.log('\n== Evidence provenance discipline (§24/§26) ==');
check('engine consumed only clinician-confirmed facts with evidence rows', signed.evidence.length === 2 && signed.evidence.every(e => e.sourceRef === bmLab.uuid));

console.log('\n========================================');
console.log('staging-engine: ' + pass + ' passed, ' + failCount + ' failed');
process.exit(failCount ? 1 : 0);
