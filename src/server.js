// CCA OS — REST API surface (mirrors the planned OpenMRS /ws/rest/v1/cca/* endpoints)
'use strict';
const express = require('express');
const path = require('path');
const store = require('./store');
const wf = require('./workflow');
const masters = require('./masters');
const clinical = require('./clinical');
const flow = require('./clinical-flow');
const treatment = require('./treatment');
const providers = require('./staging-providers');
const rbac = require('./rbac');
const consent = require('./consent');
const calendar = require('./calendar');
const ajcc = require('./ajcc');
const ajccAdapter = require('./ajcc-adapter');
const engine = require('./staging-engine');
const packs = require('./staging-packs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- session (simple; role-switcher drives the UI demo) --------------------
const USERS = [
  { uuid: 'u-front', name: 'Fatima (Front Desk)', role: 'Front Desk' },
  { uuid: 'u-intake', name: 'Joy (Intake Nurse)', role: 'Intake Nurse' },
  { uuid: 'u-onc1', name: 'Dr. Sharma (Medical Oncologist)', role: 'Medical Oncologist' },
  { uuid: 'u-radonc', name: 'Dr. Okafor (Radiation Oncologist)', role: 'Radiation Oncologist' },
  { uuid: 'u-surg', name: 'Dr. Lim (Surgical Oncologist)', role: 'Surgical Oncologist' },
  { uuid: 'u-mdtc', name: 'Grace (MDT Coordinator)', role: 'MDT Coordinator' },
  { uuid: 'u-mdtchair', name: 'Dr. Anand (MDT Chair)', role: 'MDT Chair' },
  { uuid: 'u-rad', name: 'Dr. Petit (Radiologist)', role: 'Radiologist' },
  { uuid: 'u-path', name: 'Dr. Mbeki (Pathologist)', role: 'Pathologist' },
  { uuid: 'u-lab', name: 'Luis (Lab)', role: 'Lab' },
  { uuid: 'u-pharm', name: 'Mei (Pharmacist)', role: 'Pharmacist' },
  { uuid: 'u-daycare', name: 'Sarah (Day Care Nurse)', role: 'Day Care Nurse' },
  { uuid: 'u-nav', name: 'Amina (Nurse Navigator)', role: 'Nurse Navigator' },
  { uuid: 'u-fin', name: 'Ravi (Financial Counsellor)', role: 'Financial Counsellor' },
  { uuid: 'u-admin', name: 'Admin', role: 'Administrator' },
  { uuid: 'u-ext', name: 'Dr. Rossi (External Consultant)', role: 'External Consultant' }
];

function currentActor(req) {
  const h = req.headers['x-cca-user'];
  const u = USERS.find(x => x.uuid === h || x.role === h);
  return u || USERS[2]; // default: medical oncologist
}

function ok(res, data) { res.json({ ok: true, data }); }

// Human title for a source record behind a calendar event (VIEW SOURCE)
function sourceTitle(refType, r) {
  const t = {
    consultations: 'Consultation', investigationOrders: 'Investigation order', results: 'Diagnostic result',
    diagnoses: 'Cancer diagnosis', stagingAssessments: 'Staging assessment', mdtCases: 'MDT case',
    carePlans: 'Treatment care plan', financialCounsellings: 'Financial counselling', consents: 'Consent record',
    readinessChecks: 'Readiness assessment', treatmentOrders: 'Treatment order', delayRecords: 'Delay record',
    toxicityAssessments: 'Toxicity assessment', responseAssessments: 'Response assessment',
    rtPrescriptions: 'RT prescription', rtCourses: 'RT course', events: 'RT fraction slot',
    surgicalPlans: 'Surgical plan', operativeRecords: 'Operative record'
  };
  return (t[refType] || refType) + ' ' + String(r.uuid || '').slice(0, 8);
}
function fail(res, e) {
  const status = e.httpStatus || (e.code === 'IMMUTABLE' ? 409 : 400);
  res.status(status).json({ ok: false, error: e.message, code: e.code || 'ERROR' });
}
function wrapWrite(action, handler) {
  return (req, res) => {
    try {
      const actor = currentActor(req);
      rbac.assertCanWrite(actor, action);
      const out = handler(req, res, actor);
      if (out && typeof out.catch === 'function') out.catch(e => fail(res, e)); // async handlers surface errors as HTTP failures
    } catch (e) { fail(res, e); }
  };
}
function wrap(handler) {
  return (req, res) => { try { handler(req, res); } catch (e) { fail(res, e); } };
}

// ---- bootstrap -------------------------------------------------------------
function bootstrap() {
  store.load();
  const d = store.getDb();
  if (!d.hospitals.length) {
    store.insert('hospitals', {
      uuid: 'h-1', organisation: 'Cancer Care of America', name: 'CCA Central Hospital',
      city: 'Metro City', mdtPolicy: { TNM_BREAST: 'MDT' },
      config: { formulary: 'standard', stagingProvider: 'auto' }
    });
    store.insert('hospitals', {
      uuid: 'h-2', organisation: 'Cancer Care of America', name: 'CCA Coastal Hospital',
      city: 'Coastal City', mdtPolicy: { TNM_BREAST: 'DIRECT_PLAN' },
      config: { formulary: 'coastal', stagingProvider: 'auto' }
    });
    masters.seedMasters();
    store.persist();
  }
  if (!d.masters || !Object.keys(d.masters).length) masters.seedMasters();
  packLoadSummary = packs.init();
  if (packLoadSummary.registered.length) console.log('[staging-packs] registered ' + packLoadSummary.registered.length + ' content pack(s) from ' + packLoadSummary.root);
  for (const s of packLoadSummary.skipped) console.warn('[staging-packs] SKIPPED ' + s.file + ': ' + s.errors.join(' | '));
}
let packLoadSummary = { root: '', discovered: [], registered: [], skipped: [] }; // staging content-pack registry, refreshed in bootstrap/reload
bootstrap();
consent.seedConsentTemplates();

// ---- session / reference data ----------------------------------------------
app.get('/ws/rest/v1/cca/users', wrap((req, res) => ok(res, USERS)));
app.get('/ws/rest/v1/cca/hospitals', wrap((req, res) => ok(res, store.find('hospitals', () => true))));
app.get('/ws/rest/v1/cca/masters', wrap((req, res) => ok(res, masters.listMasters())));
app.get('/ws/rest/v1/cca/masters/:name', wrap((req, res) => ok(res, masters.getMaster(req.params.name).filter(i => i.active))));
// Admin maintenance endpoints (governed; every change audited)
app.post('/ws/rest/v1/cca/masters/:name', wrap((req, res) => {
  const actor = currentActor(req);
  ok(res, masters.addMasterItem(req.params.name, req.body, actor));
}));
app.post('/ws/rest/v1/cca/masters/:name/:id/retire', wrap((req, res) => {
  const actor = currentActor(req);
  ok(res, masters.retireMasterItem(req.params.name, req.params.id, actor));
}));
app.get('/ws/rest/v1/cca/admin', wrap((req, res) => ok(res, { page: '/admin.html' })));
app.get('/ws/rest/v1/cca/regimens', wrap((req, res) => ok(res, treatment.listRegimens())));
app.get('/ws/rest/v1/cca/staging/contexts', wrap((req, res) => ok(res, providers.CONTEXTS)));
app.get('/ws/rest/v1/cca/staging/source-types', wrap((req, res) => ok(res, providers.SOURCE_TYPES)));
app.get('/ws/rest/v1/cca/biomarkers', wrap((req, res) => {
  ok(res, req.query.cancerType ? masters.biomarkersFor(req.query.cancerType) : masters.getMaster('biomarker').filter(b => b.active));
}));
app.get('/ws/rest/v1/cca/audit/verify', wrap((req, res) => ok(res, store.verifyAuditChain())));

// staging schema for a diagnosis (drives the staging form)
app.get('/ws/rest/v1/cca/staging/schema/:diagnosisUuid', wrap((req, res) => ok(res, clinical.stagingSchemaFor(req.params.diagnosisUuid))));
// AUTOMATIC STAGING (mandate §11/§14/§15): server-side authoritative evaluation —
// the frontend previews but never owns derivation. Stateless + deterministic.
app.post('/ws/rest/v1/cca/staging/evaluate', wrap((req, res) => {
  const dx = store.byUuid('diagnoses', req.body.diagnosisUuid);
  if (!dx) return fail(res, new Error('Diagnosis not found'));
  const s = clinical.stagingSchemaFor(req.body.diagnosisUuid);
  ok(res, engine.evaluate(s.fields, engine.packFor(s.providerKey, s.schemaId), { classification: req.body.classification || req.body.stagingContext, variables: req.body.variables || {} }));
}));
app.get('/ws/rest/v1/cca/staging/evaluate/:diagnosisUuid', wrap((req, res) => {
  const s = clinical.stagingSchemaFor(req.params.diagnosisUuid);
  ok(res, engine.evaluate(s.fields, engine.packFor(s.providerKey, s.schemaId), { variables: {} }));
}));
// Directive §16/§33/§34: authority/schema resolution, registry, licences
app.get('/ws/rest/v1/cca/staging/resolve/:diagnosisUuid', wrap((req, res) => {
  const dx = store.byUuid('diagnoses', req.params.diagnosisUuid);
  if (!dx) return fail(res, new Error('Diagnosis not found'));
  ok(res, ajcc.resolve_staging_schema(dx));
}));
app.get('/ws/rest/v1/cca/admin/staging-registry', wrap((req, res) => ok(res, ajcc.registrySnapshot())));
app.get('/ws/rest/v1/cca/admin/content-licenses', wrap((req, res) => ok(res, ajcc.getLicenseStatus())));
app.post('/ws/rest/v1/cca/admin/content-licenses', wrapWrite('upsertContentLicense', (req, res, actor) => ok(res, ajcc.upsertLicense(actor, req.body))));
// Staging content packs (staging mandate §5/§6/§7): the registry itself is
// read-only; reloading the pack directory is a governed Administrator action.
app.get('/ws/rest/v1/cca/admin/content-packs', wrap((req, res) => ok(res, { summary: packLoadSummary, packs: engine.packsSnapshot() })));
app.post('/ws/rest/v1/cca/admin/content-packs/reload', wrapWrite('reloadContentPacks', (req, res) => {
  packLoadSummary = packs.init();
  ok(res, { summary: packLoadSummary, ids: engine.packsSnapshot().map(p => p.id) });
}));
// Licensed AJCC adapter PoC (§7): credentials → licensed API content → validated
// engine pack. Governed to Administrator; fail-closed, never mutates the registry
// on failure; status is read-only.
app.get('/ws/rest/v1/cca/admin/ajcc-adapter/status', wrap((req, res) => ok(res, ajccAdapter.statusSnapshot())));
app.post('/ws/rest/v1/cca/admin/ajcc-adapter/connect', wrapWrite('connectLicensedAjcc', async (req, res, actor) => {
  ok(res, await ajccAdapter.connectLicensedAjcc({ actor }));
}));
app.get('/ws/rest/v1/cca/diagnostic-tests', wrap((req, res) => {
  ok(res, masters.getMaster('diagnosticTest').filter(t => t.active !== false));
}));
// signed consultations + amendments (directive §1)
app.get('/ws/rest/v1/cca/consultations', wrap((req, res) => {
  ok(res, store.find('consultations', c => !req.query.patientUuid || c.patientUuid === req.query.patientUuid)
    .sort((a, b) => new Date(a.at) - new Date(b.at)));
}));
app.post('/ws/rest/v1/cca/consultations/:uuid/sign', wrapWrite('recordConsultation', (req, res, actor) => ok(res, clinical.signConsultation(actor, req.params.uuid))));
app.post('/ws/rest/v1/cca/consultations/:uuid/amend', wrapWrite('recordConsultation', (req, res, actor) => ok(res, clinical.amendConsultation(actor, req.params.uuid, req.body))));
// directive §3: department-side order status chain
app.post('/ws/rest/v1/cca/investigation-orders/:uuid/status', wrapWrite('orderInvestigation', (req, res, actor) => ok(res, clinical.advanceOrderStatus(actor, req.params.uuid, req.body.status))));
// directive §5: result review + amendment
app.post('/ws/rest/v1/cca/results/:uuid/review', wrapWrite('createResultsReview', (req, res, actor) => ok(res, clinical.reviewResult(actor, req.params.uuid, req.body || {}))));
app.post('/ws/rest/v1/cca/results/:uuid/amend', wrapWrite('recordResult', (req, res, actor) => ok(res, clinical.amendResult(actor, req.params.uuid, req.body))));

// ---- tasks / worklists -------------------------------------------------------
app.get('/ws/rest/v1/cca/tasks', wrap((req, res) => {
  const actor = currentActor(req);
  const bucket = req.query.bucket || 'myTasks';
  let tasks;
  if (bucket === 'all') tasks = store.find('tasks', t => t.status === 'OPEN');
  else if (bucket === 'done') tasks = store.find('tasks', t => t.status === 'DONE' && t.completedBy === actor.uuid);
  else if (bucket === 'waiting') tasks = store.find('tasks', t => t.status === 'OPEN' && t.role !== actor.role);
  else tasks = store.find('tasks', t => t.status === 'OPEN' && t.role === actor.role);
  const now = Date.now();
  const enriched = tasks.map(t => ({
    ...t,
    overdue: new Date(t.dueAt).getTime() < now,
    dueToday: new Date(t.dueAt).toDateString() === new Date().toDateString(),
    patient: store.byUuid('patients', t.patientUuid) ? {
      uuid: t.patientUuid, mrn: store.byUuid('patients', t.patientUuid).mrn, name: store.byUuid('patients', t.patientUuid).name
    } : null
  }));
  ok(res, enriched.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt)));
}));
app.post('/ws/rest/v1/cca/tasks/:uuid/complete', wrap((req, res) => {
  const actor = currentActor(req);
  ok(res, wf.completeTask(actor, req.params.uuid, req.body && req.body.outcome));
}));

// ---- Phase 1 -----------------------------------------------------------------
app.post('/ws/rest/v1/cca/results-review', wrapWrite('createResultsReview', (req, res, actor) => ok(res, flow.createResultsReview(actor, req.body))));

// ---- Consent (canonical §47) ----
app.get('/ws/rest/v1/cca/consent-templates', wrap((req, res) => ok(res, consent.listConsentTemplates())));
app.get('/ws/rest/v1/cca/consents', wrap((req, res) => ok(res, store.find('consents', c => !req.query.patientUuid || c.patientUuid === req.query.patientUuid))));
app.post('/ws/rest/v1/cca/consents', wrapWrite('recordConsent', (req, res, actor) => ok(res, consent.recordConsent(actor, req.body))));
app.post('/ws/rest/v1/cca/consents/:uuid/sign', wrapWrite('signConsent', (req, res, actor) => ok(res, consent.signConsent(actor, req.params.uuid))));
app.post('/ws/rest/v1/cca/consents/:uuid/supersede', wrapWrite('recordConsent', (req, res, actor) => ok(res, consent.supersedeConsent(actor, req.params.uuid, req.body))));

app.post('/ws/rest/v1/cca/disease-profiles', wrapWrite('createDiseaseProfile', (req, res, actor) => ok(res, flow.createDiseaseProfile(actor, req.body))));
app.post('/ws/rest/v1/cca/disease-profiles/:uuid/sign', wrapWrite('signDiseaseProfile', (req, res, actor) => ok(res, flow.signDiseaseProfile(actor, req.params.uuid))));
app.get('/ws/rest/v1/cca/disease-profiles', wrap((req, res) => {
  ok(res, store.find('diseaseProfiles', d => !req.query.patientUuid || d.patientUuid === req.query.patientUuid));
}));

app.get('/ws/rest/v1/cca/staging/current/:patientUuid', wrap((req, res) => {
  ok(res, flow.getCurrentStagingAll(req.params.patientUuid));
}));
// §34 per-classification summary (header / care plan / MDT consumption)
app.get('/ws/rest/v1/cca/staging/summary/:patientUuid', wrap((req, res) => {
  ok(res, flow.getStagingSummary(req.params.patientUuid, req.query.episodeUuid || null));
}));
// §31 evidence picker: signed records grouped by department for staging evidence
// §24/§25: staging-window candidate records for a focused fact — clinician
// confirms the link; nothing is attached silently.
app.get('/ws/rest/v1/cca/staging/suggestions/:patientUuid', wrap((req, res) => {
  ok(res, clinical.stagingEvidenceSuggestions(req.params.patientUuid, req.query.fact || '', req.query.assessmentDate, req.query.months));
}));
app.get('/ws/rest/v1/cca/staging/evidence-picker/:patientUuid', wrap((req, res) => {
  ok(res, clinical.stagingEvidenceItems(req.params.patientUuid, {}));
}));

app.post('/ws/rest/v1/cca/patients', wrapWrite('registerPatient', (req, res, actor) => ok(res, clinical.registerPatient(actor, req.body))));
app.get('/ws/rest/v1/cca/patients', wrap((req, res) => {
  ok(res, store.find('patients', () => true).map(p => ({
    ...p,
    diagnosis: latestDiagnosisFor(p.uuid),
    activeOrder: latestActiveOrderFor(p.uuid)
  })));
}));
app.get('/ws/rest/v1/cca/patients/:uuid', wrap((req, res) => {
  const p = store.byUuid('patients', req.params.uuid);
  if (!p) return fail(res, new Error('Patient not found'));
  ok(res, patientChart(req.params.uuid));
}));

app.post('/ws/rest/v1/cca/consultations', wrapWrite('recordConsultation', (req, res, actor) => ok(res, clinical.recordConsultation(actor, req.body))));
app.post('/ws/rest/v1/cca/investigation-orders', wrapWrite('orderInvestigation', (req, res, actor) => ok(res, clinical.orderInvestigation(actor, req.body))));
app.get('/ws/rest/v1/cca/investigation-orders', wrap((req, res) => {
  ok(res, store.find('investigationOrders', o => !req.query.status || o.status === req.query.status).map(o => ({ ...o, patient: store.byUuid('patients', o.patientUuid) })));
}));
app.post('/ws/rest/v1/cca/results', wrapWrite('recordResult', (req, res, actor) => ok(res, clinical.recordResult(actor, req.body))));
app.get('/ws/rest/v1/cca/results', wrap((req, res) => {
  ok(res, store.find('results', r => !req.query.patientUuid || r.patientUuid === req.query.patientUuid).map(r => ({ ...r, patient: store.byUuid('patients', r.patientUuid) })));
}));

app.post('/ws/rest/v1/cca/diagnoses', wrapWrite('recordDiagnosis', (req, res, actor) => ok(res, clinical.recordDiagnosis(actor, req.body))));
app.post('/ws/rest/v1/cca/diagnoses/:uuid/sign', wrapWrite('signDiagnosis', (req, res, actor) => ok(res, clinical.signDiagnosis(actor, req.params.uuid))));
app.post('/ws/rest/v1/cca/diagnoses/:uuid/revise', wrapWrite('reviseDiagnosis', (req, res, actor) => ok(res, flow.reviseDiagnosis(actor, req.params.uuid, req.body))));

app.post('/ws/rest/v1/cca/staging-assessments', wrapWrite('createStagingAssessment', (req, res, actor) => ok(res, clinical.createStagingAssessment(actor, req.body))));
app.post('/ws/rest/v1/cca/staging-assessments/:uuid/flag', wrapWrite('flagStagingDiscrepancy', (req, res, actor) => ok(res, clinical.flagStagingDiscrepancy(actor, req.params.uuid, req.body || {}))));
app.post('/ws/rest/v1/cca/staging-assessments/:uuid/sign', wrapWrite('signStagingAssessment', (req, res, actor) => ok(res, clinical.signStagingAssessment(actor, req.params.uuid))));

// ---- Phase 2 -----------------------------------------------------------------
app.post('/ws/rest/v1/cca/mdt-cases', wrapWrite('openMdtCase', (req, res, actor) => ok(res, clinical.openMdtCase(actor, req.body))));
app.post('/ws/rest/v1/cca/mdt-cases/:uuid/discussion', wrapWrite('recordMdtDiscussion', (req, res, actor) => ok(res, clinical.recordMdtDiscussion(actor, req.params.uuid, req.body))));
app.post('/ws/rest/v1/cca/mdt-cases/:uuid/sign', wrapWrite('signMdtOutcome', (req, res, actor) => ok(res, clinical.signMdtOutcome(actor, req.params.uuid, req.body))));

app.post('/ws/rest/v1/cca/care-plans', wrapWrite('createCarePlan', (req, res, actor) => ok(res, clinical.createCarePlan(actor, req.body))));
app.post('/ws/rest/v1/cca/care-plans/:uuid/sign', wrapWrite('signCarePlan', (req, res, actor) => ok(res, clinical.signCarePlan(actor, req.params.uuid))));

app.post('/ws/rest/v1/cca/financial-counsellings', wrapWrite('recordFinancialCounselling', (req, res, actor) => ok(res, clinical.recordFinancialCounselling(actor, req.body))));
app.post('/ws/rest/v1/cca/financial-counsellings/:uuid/sign', wrapWrite('signFinancialCounselling', (req, res, actor) => ok(res, clinical.signFinancialCounselling(actor, req.params.uuid))));

app.post('/ws/rest/v1/cca/readiness', wrapWrite('recordReadiness', (req, res, actor) => ok(res, clinical.recordReadiness(actor, req.body))));

// ---- Phase 3 -----------------------------------------------------------------
app.post('/ws/rest/v1/cca/treatment-orders', wrapWrite('createTreatmentOrder', (req, res, actor) => ok(res, treatment.createTreatmentOrder(actor, req.body))));
app.post('/ws/rest/v1/cca/treatment-orders/:uuid/sign', wrapWrite('signTreatmentOrder', (req, res, actor) => ok(res, treatment.signTreatmentOrder(actor, req.params.uuid))));
app.post('/ws/rest/v1/cca/treatment-orders/:uuid/delay', wrapWrite('delayCycle', (req, res, actor) => ok(res, treatment.delayCycle(actor, { ...req.body, orderUuid: req.params.uuid }))));
app.get('/ws/rest/v1/cca/treatment-orders', wrap((req, res) => {
  ok(res, store.find('treatmentOrders', o => !req.query.patientUuid || o.patientUuid === req.query.patientUuid).map(o => ({ ...o, patient: store.byUuid('patients', o.patientUuid) })));
}));

app.get('/ws/rest/v1/cca/pharmacy/queue', wrap((req, res) => {
  ok(res, store.find('pharmacyRecords', () => true).map(r => ({
    ...r,
    order: store.byUuid('treatmentOrders', r.orderUuid),
    patient: store.byUuid('patients', r.patientUuid)
  })));
}));
app.post('/ws/rest/v1/cca/pharmacy/receive', wrapWrite('pharmacyReceive', (req, res, actor) => ok(res, treatment.pharmacyReceive(actor, req.body.orderUuid))));
app.post('/ws/rest/v1/cca/pharmacy/:uuid/verify', wrapWrite('pharmacyVerify', (req, res, actor) => ok(res, treatment.pharmacyVerify(actor, req.params.uuid, req.body))));
app.post('/ws/rest/v1/cca/pharmacy/:uuid/prepare', wrapWrite('pharmacyPrepare', (req, res, actor) => ok(res, treatment.pharmacyPrepare(actor, req.params.uuid, req.body))));
app.post('/ws/rest/v1/cca/pharmacy/:uuid/release', wrapWrite('pharmacyRelease', (req, res, actor) => ok(res, treatment.pharmacyRelease(actor, req.params.uuid, req.body.independentCheckBy))));
app.post('/ws/rest/v1/cca/pharmacy/:uuid/dispense', wrapWrite('dispense', (req, res, actor) => ok(res, treatment.dispense(actor, { pharmacyUuid: req.params.uuid, ...req.body }))));
app.get('/ws/rest/v1/cca/dispenses', wrap((req, res) => {
  ok(res, store.find('dispenseRecords', () => true).map(d => ({
    ...d, patient: store.byUuid('patients', d.patientUuid), order: store.byUuid('treatmentOrders', d.orderUuid)
  })));
}));

app.post('/ws/rest/v1/cca/administrations/start', wrapWrite('startAdministration', (req, res, actor) => ok(res, treatment.startAdministration(actor, req.body.pharmacyUuid))));
app.post('/ws/rest/v1/cca/administrations/:uuid/update', wrapWrite('updateAdministration', (req, res, actor) => ok(res, treatment.updateAdministration(actor, req.params.uuid, req.body))));
app.post('/ws/rest/v1/cca/administrations/:uuid/complete', wrapWrite('completeAdministration', (req, res, actor) => ok(res, treatment.completeAdministration(actor, req.params.uuid))));
app.get('/ws/rest/v1/cca/administrations', wrap((req, res) => {
  ok(res, store.find('administrationRecords', () => true).map(a => ({
    ...a, patient: store.byUuid('patients', a.patientUuid), order: store.byUuid('treatmentOrders', a.orderUuid)
  })));
}));

app.post('/ws/rest/v1/cca/infusion-reactions', wrapWrite('recordInfusionReaction', (req, res, actor) => ok(res, treatment.recordInfusionReaction(actor, req.body))));
app.get('/ws/rest/v1/cca/next-cycle-context/:orderUuid', wrap((req, res) => {
  const actor = currentActor(req);
  ok(res, treatment.nextCycleContext(actor, req.query.patientUuid, req.params.orderUuid));
}));
app.post('/ws/rest/v1/cca/next-cycle-decisions', wrapWrite('nextCycleDecision', (req, res, actor) => ok(res, treatment.recordNextCycleDecision(actor, req.body))));
app.post('/ws/rest/v1/cca/next-cycle-decisions/:uuid/sign', wrapWrite('nextCycleDecision', (req, res, actor) => ok(res, treatment.signNextCycleDecision(actor, req.params.uuid))));
app.get('/ws/rest/v1/cca/next-cycle-decisions', wrap((req, res) => ok(res, store.find('nextCycleDecisions', d => !req.query.patientUuid || d.patientUuid === req.query.patientUuid))));
app.post('/ws/rest/v1/cca/infusion-reactions/:uuid/resolve', wrapWrite('resolveInfusionReaction', (req, res, actor) => ok(res, treatment.resolveInfusionReaction(actor, req.params.uuid, req.body.outcome))));
app.get('/ws/rest/v1/cca/infusion-reactions', wrap((req, res) => ok(res, store.find('infusionReactions', () => true))));

app.post('/ws/rest/v1/cca/toxicities', wrapWrite('recordToxicity', (req, res, actor) => ok(res, treatment.recordToxicity(actor, req.body))));
app.post('/ws/rest/v1/cca/toxicities/:uuid/sign', wrapWrite('signToxicity', (req, res, actor) => ok(res, treatment.signToxicity(actor, req.params.uuid))));
app.post('/ws/rest/v1/cca/responses', wrapWrite('recordResponseAssessment', (req, res, actor) => ok(res, treatment.recordResponseAssessment(actor, req.body))));
app.post('/ws/rest/v1/cca/responses/:uuid/sign', wrapWrite('signResponseAssessment', (req, res, actor) => ok(res, treatment.signResponseAssessment(actor, req.params.uuid))));

// ---- Phase 4 -----------------------------------------------------------------
app.post('/ws/rest/v1/cca/rt-prescriptions', wrapWrite('createRtPrescription', (req, res, actor) => ok(res, treatment.createRtPrescription(actor, req.body))));
app.post('/ws/rest/v1/cca/rt-prescriptions/:uuid/approve', wrapWrite('approveRtPlan', (req, res, actor) => ok(res, treatment.approveRtPlan(actor, req.params.uuid, req.body.physicsCheck))));
app.post('/ws/rest/v1/cca/rt-fractions', wrapWrite('recordRtFraction', (req, res, actor) => ok(res, treatment.recordRtFraction(actor, req.body))));
app.get('/ws/rest/v1/cca/rt', wrap((req, res) => {
  ok(res, {
    prescriptions: store.find('rtPrescriptions', () => true).map(r => ({ ...r, patient: store.byUuid('patients', r.patientUuid) })),
    courses: store.find('rtCourses', () => true),
    fractions: store.find('rtFractions', () => true)
  });
}));

app.post('/ws/rest/v1/cca/surgical-plans', wrapWrite('createSurgicalPlan', (req, res, actor) => ok(res, treatment.createSurgicalPlan(actor, req.body))));
app.post('/ws/rest/v1/cca/surgical-plans/:uuid/sign', wrapWrite('signSurgicalPlan', (req, res, actor) => ok(res, treatment.signSurgicalPlan(actor, req.params.uuid))));
app.post('/ws/rest/v1/cca/operative-records', wrapWrite('recordOperativeNote', (req, res, actor) => ok(res, treatment.recordOperativeNote(actor, req.body))));
app.post('/ws/rest/v1/cca/operative-records/:uuid/sign', wrapWrite('signOperativeRecord', (req, res, actor) => ok(res, treatment.signOperativeRecord(actor, req.params.uuid))));
app.get('/ws/rest/v1/cca/surgery', wrap((req, res) => {
  ok(res, {
    plans: store.find('surgicalPlans', () => true).map(p => ({ ...p, patient: store.byUuid('patients', p.patientUuid) })),
    records: store.find('operativeRecords', () => true)
  });
}));

// ---- Calendar ------------------------------------------------------------------
// Legacy projected event rows (from signTreatmentOrder / RT approval) — kept for
// backward compatibility with older screens.
app.get('/ws/rest/v1/cca/events', wrap((req, res) => {
  const list = store.find('events', e => !req.query.patientUuid || e.patientUuid === req.query.patientUuid);
  ok(res, list.sort((a, b) => (a.plannedDate || '').localeCompare(b.plannedDate || '')));
}));

// Derived oncology calendar: a PROJECTION over authoritative records, re-computed
// per request (never a duplicate clinical store). Filters: patientUuid, from, to,
// state, type, modality, owner, q (title substring).
app.get('/ws/rest/v1/cca/calendar/events', wrap((req, res) => {
  let list = req.query.patientUuid ? calendar.deriveForPatient(req.query.patientUuid) : calendar.deriveAll();
  const f = req.query;
  if (f.from) list = list.filter(e => (e.date || '') >= f.from);
  if (f.to) list = list.filter(e => (e.date || '') <= f.to);
  if (f.state) list = list.filter(e => e.state === f.state);
  if (f.type) list = list.filter(e => e.type === f.type);
  if (f.modality) list = list.filter(e => (calendar.EVENT_TYPES[e.type] || {}).modality === f.modality);
  if (f.owner) list = list.filter(e => e.owner === f.owner);
  if (f.q) list = list.filter(e => (e.title || '').toLowerCase().includes(String(f.q).toLowerCase()));
  ok(res, list);
}));

// Enriched calendar for the UI: patient + owner + delay provenance + source-record
// display fields for VIEW SOURCE on every event.
app.get('/ws/rest/v1/cca/calendar/enriched', wrap((req, res) => {
  let list = req.query.patientUuid ? calendar.deriveForPatient(req.query.patientUuid) : calendar.deriveAll();
  // mine=1: role-personalised scope — events this user's role owns
  if (req.query.mine && !req.query.patientUuid) {
    const actor = currentActor(req);
    const mine = list.filter(e => e.owner === actor.role);
    if (mine.length) list = mine;
  }
  const patients = store.find('patients', () => true);
  const byUuid = Object.fromEntries(patients.map(p => [p.uuid, p]));
  const today = new Date().toISOString().slice(0, 10);
  const enriched = list.map(e => {
    const p = byUuid[e.patientUuid];
    const src = e.refType && e.refUuid ? store.byUuid(e.refType, e.refUuid) : null;
    return Object.assign({}, e, {
      patient: p ? { uuid: p.uuid, mrn: p.mrn, name: p.name } : null,
      source: src ? {
        refType: e.refType, refUuid: e.refUuid,
        title: sourceTitle(e.refType, src),
        status: src.status || (src.resultStatus ? 'FINAL' : null),
        byName: src.byName || src.orderedByName || src.clinicianName || src.oncologistName || src.counsellorName || src.clearedByName || src.surgeonName || src.prescribedByName || src.assessedByName || (src.signer && src.signer.name) || null,
        at: src.signedAt || src.finalizedAt || src.at || src.orderedAt || src.createdAt || src.performedDate || src.clearedAt || null,
        summary: src.summary || src.referralReason || src.plannedTreatment || src.performedProcedure || src.decision || null,
        signature: src.signature ? (src.signature.signer ? src.signature.signer.name + ' · ' + src.signature.at : 'signed') : null
      } : null,
      isToday: e.date === today,
      isPast: !!e.date && e.date < today,
      isFuture: !!e.date && e.date > today
    });
  });
  ok(res, enriched);
}));

// Operational department view: same projection, filterable by hospital/department/
// clinician/resource/treatment type/status/date (canonical calendar spec).
app.get('/ws/rest/v1/cca/calendar/department', wrap((req, res) => {
  let list = calendar.deriveAll();
  const f = req.query;
  if (f.date) list = list.filter(e => e.date === f.date);
  if (f.from) list = list.filter(e => (e.date || '') >= f.from);
  if (f.to) list = list.filter(e => (e.date || '') <= f.to);
  if (f.state) list = list.filter(e => e.state === f.state);
  if (f.type) list = list.filter(e => e.type === f.type);
  if (f.modality) list = list.filter(e => (calendar.EVENT_TYPES[e.type] || {}).modality === f.modality);
  if (f.clinician) list = list.filter(e => (e.byName || '').toLowerCase().includes(String(f.clinician).toLowerCase()) || e.owner === f.clinician);
  if (f.resource) list = list.filter(e => (e.title || '').toLowerCase().includes(String(f.resource).toLowerCase()));
  if (f.q) list = list.filter(e => (e.title || '').toLowerCase().includes(String(f.q).toLowerCase()));
  const patients = store.find('patients', () => true);
  const byUuid = Object.fromEntries(patients.map(p => [p.uuid, p]));
  if (f.hospital || f.department) {
    const hospitals = store.find('hospitals', () => true);
    const hospUuids = hospitals.filter(h => (!f.hospital || h.uuid === f.hospital || h.name === f.hospital)).map(h => h.uuid);
    // demo: hospital/department assignment lives on the patient record when present
    list = list.filter(e => {
      const p = byUuid[e.patientUuid];
      if (!p) return false;
      if (f.hospital && p.hospitalUuid && !hospUuids.includes(p.hospitalUuid)) return false;
      if (f.department && p.department && p.department !== f.department) return false;
      return true;
    });
  }
  const enriched = list.map(e => {
    const p = byUuid[e.patientUuid];
    return Object.assign({}, e, { patient: p ? { uuid: p.uuid, mrn: p.mrn, name: p.name } : null });
  });
  ok(res, enriched);
}));

// Update a calendar event's operational state (HELD / CANCELLED / DELAYED note).
// Clinical truth comes from the source records — this only annotates the
// operational view and writes an audit entry. PROJECTED state can never be
// flipped to anything that looks like delivered care.
app.post('/ws/rest/v1/cca/calendar/events/:refType/:refUuid/state', wrap((req, res) => {
  const actor = currentActor(req);
  const { refType, refUuid } = req.params;
  const state = req.body.state;
  rbac.assertCanWrite(actor, 'annotateCalendar');
  gate(!['HELD', 'CANCELLED', 'DELAYED'].includes(state), 'state must be HELD | CANCELLED | DELAYED');
  const rec = store.byUuid(refType, refUuid);
  gate(!rec, 'Source record not found: ' + refType + '/' + refUuid);
  store.audit(actor, 'CALENDAR_EVENT_' + state, refType, refUuid, req.body.reason || null);
  ok(res, { ok: true, state });
}));

// ---- Audit ------------------------------------------------------------------
app.get('/ws/rest/v1/cca/audit', wrap((req, res) => {
  let list = store.find('audit', () => true);
  if (req.query.entityUuid) list = list.filter(a => a.entityUuid === req.query.entityUuid);
  if (req.query.patientUuid) list = list.filter(a => (a.detail || '').includes(req.query.patientUuid) || a.entityUuid === req.query.patientUuid);
  ok(res, list.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 200));
}));

// ---- helpers -----------------------------------------------------------------
function latestDiagnosisFor(patientUuid) {
  // current = newest signed/confirmed version (superseded versions are history)
  const dx = store.find('diagnoses', d => d.patientUuid === patientUuid && ['CONFIRMED', 'SIGNED', 'REVISED'].includes(d.status) && !d.supersededBy)
    .sort((a, b) => new Date(b.signedAt || 0) - new Date(a.signedAt || 0))[0];
  if (!dx) return null;
  return { ...dx,
    cancerTypeLabel: masters.label('cancerType', dx.cancerType),
    histologyLabel: masters.label('histology', dx.histology),
    primarySiteLabel: dx.primarySite ? masters.label('primarySite', dx.primarySite) : undefined };
}
function latestActiveOrderFor(patientUuid) {
  return store.find('treatmentOrders', o => o.patientUuid === patientUuid).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}
function patientChart(uuid) {
  const p = store.byUuid('patients', uuid);
  const dx = latestDiagnosisFor(uuid);
  const staging = store.find('stagingAssessments', s => s.patientUuid === uuid).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const currentStaging = staging.find(s => s.status === 'SIGNED') || null;
  const order = latestActiveOrderFor(uuid);
  return {
    patient: p,
    diagnosis: dx,
    staging: { current: currentStaging, history: staging },
    consultations: store.find('consultations', c => c.patientUuid === uuid).sort((a, b) => new Date(a.at) - new Date(b.at)),
    investigationOrders: store.find('investigationOrders', o => o.patientUuid === uuid),
    results: store.find('results', r => r.patientUuid === uuid),
    mdt: store.find('mdtCases', m => m.patientUuid === uuid),
    carePlans: store.find('carePlans', c => c.patientUuid === uuid),
    finance: store.find('financialCounsellings', f => f.patientUuid === uuid),
    consents: store.find('consents', c => c.patientUuid === uuid),
    diseaseProfiles: store.find('diseaseProfiles', d => d.patientUuid === uuid),
    readiness: store.find('readinessChecks', r => r.patientUuid === uuid),
    treatmentOrders: store.find('treatmentOrders', o => o.patientUuid === uuid),
    pharmacy: store.find('pharmacyRecords', r => r.patientUuid === uuid),
    dispenses: store.find('dispenseRecords', d => d.patientUuid === uuid),
    infusionReactions: store.find('infusionReactions', r => r.patientUuid === uuid),
    nextCycleDecisions: store.find('nextCycleDecisions', d => d.patientUuid === uuid),
    administrations: store.find('administrationRecords', a => a.patientUuid === uuid),
    toxicities: store.find('toxicityAssessments', t => t.patientUuid === uuid),
    responses: store.find('responseAssessments', r => r.patientUuid === uuid),
    rt: store.find('rtPrescriptions', r => r.patientUuid === uuid),
    surgery: store.find('surgicalPlans', s => s.patientUuid === uuid),
    events: store.find('events', e => e.patientUuid === uuid).sort((a, b) => (a.plannedDate || '').localeCompare(b.plannedDate || '')),
    tasks: wf.tasksForPatient(uuid),
    activeOrder: order
  };
}

const PORT = Number(process.env.PORT) || 3210;
app.listen(PORT, () => console.log('CCA OS running on http://localhost:' + PORT));
module.exports = app;
