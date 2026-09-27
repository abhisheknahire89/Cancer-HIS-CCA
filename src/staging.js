// CCA OS — Staging & Classification domain
// One owner for the staging domain: schema resolution, sign gates, assessments,
// derivation, evidence suggestion (§24/§25), discrepancy flags (§31), Slice-E
// pathological restaging, and the latest-signed lookup consumed by care planning.
// clinical.js keeps registration/consultation/orders/results/diagnosis/MDT/
// care-plan/finance; clinical-flow.js keeps the canonical results-review flow
// and reuses these services verbatim.
'use strict';
const store = require('./store');
const wf = require('./workflow');
const masters = require('./masters');
const providers = require('./staging-providers');
const ajcc = require('./ajcc');
const engine = require('./staging-engine');
const tnm = require('./tnm');
const rbac = require('./rbac');

const { uuid, nowIso, gate, sign, assertNotSigned, createTask } = wf;

function getPatient(uuidOrMrn) {
  return store.findOne('patients', p => p.uuid === uuidOrMrn || p.mrn === uuidOrMrn);
}

// Directive §16: the SERVER resolves authority + schema + effective version from
// the diagnosis (site/histology/morphology/behaviour/date). The clinician never
// picks a pack. Without licensed content the resolver still routes versions from
// public AJCC metadata and the provider reports AUTHORITY_CONTENT_UNAVAILABLE.
function stagingSchemaFor(diagnosisUuid) {
  const dx = store.byUuid('diagnoses', diagnosisUuid);
  gate(!dx, 'Diagnosis not found');
  const legacy = providers.resolveProvider(dx);           // field-schema provider (neutral skeleton)
  const schema = legacy.provider.resolveSchema(dx);
  const route = ajcc.resolve_staging_schema(dx, legacy.key); // authority/version routing (public metadata)
  // Automatic-derivation availability (staging mandate §3/§7): a pack exists only
  // where permitted content is connected. AJCC packs arrive exclusively via the
  // licensed provider; until then TNM diseases report CONTENT_PROVIDER_UNAVAILABLE
  // and governed clinician-recorded categories remain the valid fallback.
  const pack = engine.packFor(legacy.key, route.schemaId);
  return {
    providerKey: legacy.key,
    authority: route.authority,
    schemaId: route.schemaId,
    schemaName: route.schemaName,
    version: route.version,
    versionRaw: route.versionRaw,
    effectiveFrom: route.effectiveFrom,
    sourceReference: route.sourceReference,
    provider: route.provider,
    contentStatus: route.contentStatus,
    licensedContentAvailable: !!route.licensedContentAvailable,
    notice: route.contentStatus === 'AUTHORITY_CONTENT_UNAVAILABLE' ? 'AJCC authoritative content provider not configured. Staging workflow is available, but governed AJCC category definitions and stage calculation require licensed AJCC content.' : null,
    availableContexts: route.availableContexts,
    contexts: schema.contexts,
    fields: schema.fields,
    inputSchema: { fields: schema.fields },
    // §17 context-aware engine availability: the engine substitutes hand-picking
    // ONLY for classifications the connected pack actually covers — other contexts
    // keep the governed clinician-recorded categories.
    engine: pack ? { status: 'AVAILABLE', packId: pack.packId, provenance: pack.provenance, resultFields: engine.resultFields(pack), classifications: pack.classifications } : { status: 'CONTENT_PROVIDER_UNAVAILABLE' }
  };
}

// Directive §26: the resolved schema+version snapshot becomes part of the record
// and is LOCKED at sign time — sign-time re-resolution must match the stored one.
function resolvedSnapshotFor(dx) {
  const legacy = providers.resolveProvider(dx);
  const route = ajcc.resolve_staging_schema(dx, legacy.key);
  return { authority: route.authority, schemaId: route.schemaId, version: route.versionRaw, effectiveFrom: route.effectiveFrom };
}

// Sign-time validation shared by BOTH staging service entries (clinical.* and
// clinical-flow.*) so the stop-gates hold for every caller (directive §26/§39).
function applyStagingSignGates(a, dx) {
  const { key, provider } = providers.resolveProvider(dx);

  // STOP-GATE 0: the locked schema snapshot must still match a fresh resolution
  const nowResolved = resolvedSnapshotFor(dx);
  gate(nowResolved.schemaId !== a.schemaId || nowResolved.version !== a.authorityVersion,
    'STOP_GATE: resolved staging schema/version changed since this assessment was drafted — re-resolve before signing');

  // STOP-GATE 1: unknown governed fields rejected FIRST (schema mismatch, e.g. TNM on
  // a haematological disease, must report the schema mismatch — not a required-field error)
  const schema = provider.resolveSchema(dx);
  for (const known of Object.keys(a.variables)) {
    const f = schema.fields.find(x => x.key === known);
    gate(!f, 'STOP_GATE: unknown staging field "' + known + '" for schema ' + key);
  }

  // STOP-GATE 2: required fields / allowed values / fabricated stage
  const validation = provider.validateAssessment(a);
  gate(!validation.ok, 'STOP_GATE: staging validation failed — ' + validation.errors.join('; '));

  // Generic TNM engine gates (mandate §7/§9/§13): classification enum, MX impossible,
  // pM0 impossible, pM1 evidence requirement, staging-window check.
  const tnmErrors = tnm.validateTnmAssessment(a, provider);
  gate(tnmErrors.length, 'STOP_GATE: ' + tnmErrors.join('; '));

  // AUTOMATIC DERIVATION (staging mandate §11–§15): the deterministic engine —
  // not the frontend, not the clinician — derives categories/stage when a content
  // pack is connected; the clinician confirms or signs, never hand-edits the result.
  // Server-side, so the browser can display a live preview but never own the logic.
  if (a.resultSource === 'AUTOMATIC_ENGINE') {
    const derivation = engine.evaluate(schema.fields, engine.packFor(key, a.schemaId), { classification: a.stagingContext, variables: a.variables });
    gate(derivation.status !== 'CALCULATED', 'STOP_GATE: automatic derivation not available — ' + derivation.status +
      (derivation.invalid ? ' (' + derivation.invalid.join('; ') + ')' : '') +
      (derivation.missing ? ' (missing: ' + derivation.missing.join('; ') + ')' : ''));
    gate(a.variables.stageResult && derivation.result !== a.variables.stageResult,
      'STOP_GATE: signed stage must match the engine-derived result (' + derivation.result + ')');
    a.derivationTrace = derivation;   // §27 machine-readable trace, stored with the record
    a.stageResult = derivation.result;          // engine-derived result IS the record's result
    a.resultLabel = derivation.resultLabel || derivation.result;
    if (derivation.prognosticStage) a.prognosticStageGroup = derivation.prognosticStage; // §22: kept separate
  }

  // STOP-GATE 3: evidence provenance — every governed fact (T/N/M) must cite
  // evidence: a linked same-patient source result or an explicit supporting finding
  // Evidence-type vocabulary: mandate §16 names (PATHOLOGY/RADIOLOGY/LABORATORY …)
  // are normalized to the canonical source vocabulary so both spellings validate.
  const SOURCE_SYNONYMS = { PATHOLOGY: 'PATHOLOGICAL', RADIOLOGY: 'RADIOLOGICAL', LAB: 'LABORATORY', LABORATORY: 'LABORATORY', EXTERNAL_RECORD: 'EXTERNAL_DOCUMENT' };
  for (const ev of a.evidence || []) {
    if (ev && SOURCE_SYNONYMS[ev.sourceType]) ev.sourceType = SOURCE_SYNONYMS[ev.sourceType];
    gate(!providers.SOURCE_TYPES.includes(ev.sourceType), 'Invalid evidence sourceType');
    if (ev.variableKey) {
      const factField = schema.fields.find(x => x.key === ev.variableKey);
      gate(!factField, 'STOP_GATE: evidence cites unknown staging field "' + ev.variableKey + '"');
    }
    if (ev.sourceRef) {
      // The evidence picker offers finalized results, signed consultations and signed
      // operative records (§19: clinical examination and operative findings are valid
      // staging evidence) — the validator must accept exactly what the picker offers.
      const r = store.byUuid('results', ev.sourceRef);
      const c = r ? null : store.byUuid('consultations', ev.sourceRef);
      const o = (!r && !c) ? store.byUuid('operativeRecords', ev.sourceRef) : null;
      const src = r || (c && c.status === 'SIGNED' ? c : null) || (o && o.status === 'SIGNED' ? o : null);
      gate(!src, 'Evidence source not found: ' + ev.sourceRef);
      gate(src.patientUuid !== a.patientUuid, 'CROSS_PATIENT_EVIDENCE: staging evidence belongs to another patient');
    } else if (!ev.supportingFinding) {
      gate(true, 'STOP_GATE: evidence row for ' + (ev.variableKey || 'unknown field') + ' must cite a source result or a supporting finding');
    }
  }
  const covered = new Set((a.evidence || [])
    .filter(e => e.variableKey && (e.sourceRef || (e.supportingFinding || '').trim()))
    .map(e => e.variableKey));
  for (const f of schema.fields) {
    if (['t', 'n', 'm'].includes(f.key) && a.variables[f.key] && !covered.has(f.key)) {
      gate(true, 'STOP_GATE: required evidence missing for ' + f.key + ' — each staging fact must cite its source (directive §20)');
    }
  }
  // supersedes: same patient only (directive §39)
  if (a.supersedes) {
    const prev = store.byUuid('stagingAssessments', a.supersedes);
    gate(!prev, 'Superseded assessment not found');
    gate(prev.patientUuid !== a.patientUuid, 'CROSS_PATIENT_SUPERSESSION: cannot supersede another patient\u2019s staging');
    gate(!['SIGNED', 'SUPERSEDED'].includes(prev.status), 'Can only supersede a signed assessment');
  }
  return { key, provider, schema };
}

function createStagingAssessment(actor, data) {
  rbac.assertCanWrite(actor, 'createStagingAssessment');
  const dx = store.byUuid('diagnoses', data.diagnosisUuid);
  gate(!dx, 'Diagnosis not found');
  // STOP-GATE: staging requires a confirmed (signed) diagnosis — accept both status
  // vocabularies ('SIGNED' from clinical.recordDiagnosis, 'CONFIRMED' from clinical-flow)
  gate(!['SIGNED', 'CONFIRMED'].includes(dx.status), 'STOP_GATE: staging requires a confirmed (signed) diagnosis');
  gate(!data.stagingContext || !providers.CONTEXTS.includes(data.stagingContext), 'Invalid stagingContext');
  gate(!data.assessmentDate, 'assessmentDate is required');
  gate(new Date(data.assessmentDate) > new Date(), 'STOP_GATE: assessment date cannot be in the future');

  const { key, provider } = providers.resolveProvider(dx);
  gate(key === 'TNM_FALLBACK', 'STOP_GATE: no governed staging schema for this disease (arbitrary pack selection is not permitted)');
  const resolved = resolvedSnapshotFor(dx);

  const assessment = {
    uuid: uuid(),
    patientUuid: dx.patientUuid,
    episodeUuid: dx.episodeUuid,
    diagnosisUuid: dx.uuid,
    diseaseSite: masters.label('primarySite', dx.primarySite),
    providerKey: key,
    stagingAuthority: resolved.authority,
    authorityVersion: resolved.version,
    schemaId: resolved.schemaId,
    effectiveFrom: resolved.effectiveFrom,
    resultSource: data.resultSource || 'CLINICIAN_ENTERED',
    stagingContext: data.stagingContext,
    assessmentDate: data.assessmentDate,
    variables: data.variables || {},
    prognosticFactors: data.prognosticFactors || [],
    evidence: (data.evidence || []).map(e => ({
      variableKey: e.variableKey || null,
      sourceType: e.sourceType,       // CLINICAL|RADIOLOGICAL|PATHOLOGICAL|LABORATORY|MOLECULAR|EXTERNAL_DOCUMENT
      sourceRef: e.sourceRef || null, // result uuid or document reference
      sourceDate: e.sourceDate || null,
      supportingFinding: e.supportingFinding || ''
    })),
    clinician: actor.uuid,
    clinicianName: actor.name,
    status: 'DRAFT',
    supersedes: data.supersedes || null,
    createdAt: nowIso(),
    signedAt: null
  };
  store.insert('stagingAssessments', assessment);
  return assessment;
}

function signStagingAssessment(actor, assessmentUuid) {
  rbac.assertCanWrite(actor, 'signStagingAssessment');
  const a = store.byUuid('stagingAssessments', assessmentUuid);
  gate(!a, 'Staging assessment not found');
  assertNotSigned('stagingAssessment', a);

  const dx = store.byUuid('diagnoses', a.diagnosisUuid);
  const { key, provider } = applyStagingSignGates(a, dx);

  // supersedes: same patient+episode only (stop-gate)
  if (a.supersedes) {
    const prev = store.byUuid('stagingAssessments', a.supersedes);
    gate(!prev, 'Superseded assessment not found');
    gate(prev.patientUuid !== a.patientUuid, 'CROSS_PATIENT_SUPERSESSION: cannot supersede another patient\u2019s staging');
    gate(prev.status !== 'SIGNED', 'Can only supersede a SIGNED assessment');
    // §31 loop closure: the superseding signature resolves any OPEN discrepancy
    // flag on the superseded assessment (and consumes its review task).
    resolveOpenDiscrepancyFlag(actor, a.supersedes, a.uuid);
  }

  const derived = provider.deriveStage(a);
  a.resultSource = a.resultSource || 'CLINICIAN_ENTERED';
  a.stageResult = derived.stage || a.stageResult || null; // engine path: gate already set the derived result
  // §4/§21: record the classification prefix and label the result honestly —
  // anatomic vs prognostic distinction is preserved where the provider gives both
  a.classificationPrefix = tnm.classificationPrefix(a.stagingContext) || null;
  a.stageGroupStatus = derived.stage || derived.stageGroup ? 'DERIVED' : (derived.stageGroupStatus || 'INSUFFICIENT_INFORMATION');
  if (derived.anatomicStage !== undefined) a.anatomicStageGroup = derived.anatomicStage;
  if (derived.prognosticStage !== undefined) a.prognosticStageGroup = derived.prognosticStage;
  a.status = 'SIGNED';
  a.signedAt = nowIso();
  a.stageResult = a.stageResult || derived.stage;   // engine path: gate already derived it
  a.stageDerivation = derived.derivation;
  // §32 evidence completeness shown at signing, stored on the record
  a.evidenceCompleteness = (a.evidence || []).filter(e => e.sourceRef).length + ' linked / ' + (a.evidence || []).length + ' rows';
  a.signature = sign(actor, 'stagingAssessment', a.uuid, (a.stagingContext + ' → ' + (derived.stage || 'INSUFFICIENT_INFORMATION')));

  // supersede previous
  if (a.supersedes) store.update('stagingAssessments', a.supersedes, { status: 'SUPERSEDED' });

  store.update('stagingAssessments', a.uuid, a);
  store.audit(actor, 'STAGING_SIGNED', 'stagingAssessment', a.uuid, a.stagingContext + ' → ' + derived.stage + ' (authority ' + a.stagingAuthority + ' ' + a.authorityVersion + ')');

  // Task: staging signed → MDT or direct care plan (hospital config)
  const hospital = store.byUuid('hospitals', getPatient(a.patientUuid).hospitalUuid);
  const routeDirect = hospital && hospital.mdtPolicy && hospital.mdtPolicy[a.providerKey] === 'DIRECT_PLAN';
  createTask(actor, routeDirect ? 'CREATE_CARE_PLAN' : 'MDT_REVIEW', a.patientUuid, { stagingUuid: a.uuid });
  return a;
}

// ---- Staging-window evidence auto-suggestion (staging mandate §24/§25) ----
// When a staging fact is focused, the UI surfaces candidate patient records from
// the relevant staging window (window end = assessment date, start = N months
// back) whose source kind matches the fact. The clinician ALWAYS confirms the
// link — records are never silently attached (§24). Suggested items carry the
// same shape as the evidence picker so linking validates identically at sign.
const EVIDENCE_FACT_HINTS = {
  tumourSizeMm: ['RADIOLOGICAL', 'PATHOLOGICAL'],
  clinicalNodalStatus: ['RADIOLOGICAL', 'PATHOLOGICAL', 'CLINICAL'],
  regionalNodesExamined: ['PATHOLOGICAL'],
  regionalNodesPositive: ['PATHOLOGICAL'],
  distantMetastasis: ['RADIOLOGICAL', 'CLINICAL'],
  metastaticSites: ['RADIOLOGICAL', 'PATHOLOGICAL'],
  chestWallInvolvement: ['CLINICAL', 'RADIOLOGICAL'],
  skinInvolvement: ['CLINICAL'],
  inflammatoryFeatures: ['CLINICAL'],
  erStatus: ['PATHOLOGICAL', 'LABORATORY'],
  prStatus: ['PATHOLOGICAL', 'LABORATORY'],
  her2Status: ['PATHOLOGICAL', 'LABORATORY'],
  ki67: ['PATHOLOGICAL'],
  beta2Microglobulin: ['LABORATORY'],
  albumin: ['LABORATORY'],
  ldhElevated: ['LABORATORY'],
  cytogeneticRisk: ['MOLECULAR'],
  psa: ['LABORATORY'],
  t: ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL'],
  n: ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL'],
  m: ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL'],
  figoStage: ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL']
};
// Record source vocab → canonical evidence source vocabulary (same normalization
// the sign gate applies, so a suggested record always validates once linked).
const EVIDENCE_SOURCE_SYNONYMS = { PATHOLOGY: 'PATHOLOGICAL', RADIOLOGY: 'RADIOLOGICAL', LAB: 'LABORATORY', LABORATORY: 'LABORATORY', MOLECULAR: 'MOLECULAR', CLINICAL: 'CLINICAL' };

// §31/§24/§25: the ONE place patient records become picker-shaped evidence items.
// Used by the evidence-picker route (all finalized/signed records) and by the
// staging-window suggestion service (windowed, filtered to the fact's source kinds).
// opts: { windowStart: Date, windowEnd: 'YYYY-MM-DD', types: ['PATHOLOGICAL',…] } —
// both optional; without them every eligible record is returned.
function stagingEvidenceItems(patientUuid, opts) {
  const o = opts || {};
  const inWindow = d => {
    if (!o.windowStart && !o.windowEnd) return true;
    if (!d) return false;
    const t = new Date(d);
    // 'Z': stored timestamps are UTC ISO; a zone-less parse makes the bound local
    // time, so records stamped after local-midnight UTC fall outside their own day.
    return !isNaN(t) && (!o.windowStart || t >= o.windowStart) && (!o.windowEnd || t <= new Date(o.windowEnd + 'T23:59:59Z'));
  };
  const kindOf = t => EVIDENCE_SOURCE_SYNONYMS[t] || t;
  const matches = t => !o.types || o.types.includes(kindOf(t));
  const items = [];
  for (const r of store.find('results', r => r.patientUuid === patientUuid && r.resultStatus !== 'PRELIMINARY' && inWindow(r.reportDate || r.finalizationDate || r.at))) {
    if (!matches(r.resultType || r.category)) continue;
    items.push({ evidenceId: r.uuid, evidenceType: r.resultType || r.category, sourceResourceType: 'DiagnosticResult', sourceResourceId: r.uuid, sourceDate: r.reportDate || r.finalizationDate || r.at, reportedBy: r.reportingClinicianName || r.byName, status: r.status, relevantFinding: (r.summary || '').slice(0, 140), group: r.resultType === 'PATHOLOGY' ? 'Pathology' : r.resultType === 'RADIOLOGY' ? 'Radiology' : r.resultType === 'LAB' ? 'Laboratory' : 'Molecular results' });
  }
  for (const c of store.find('consultations', c => c.patientUuid === patientUuid && c.status === 'SIGNED' && inWindow(c.signedAt || c.at))) {
    if (!matches('CLINICAL')) continue;
    items.push({ evidenceId: c.uuid, evidenceType: 'CLINICAL_EXAM', sourceResourceType: 'Consultation', sourceResourceId: c.uuid, sourceDate: c.signedAt || c.at, reportedBy: c.signedByName || c.byName, status: c.status, relevantFinding: (c.clinicalAssessment || c.chiefComplaint || '').slice(0, 140), group: 'Consultations' });
  }
  for (const op of store.find('operativeRecords', op => op.patientUuid === patientUuid && inWindow(op.signedAt || op.createdAt))) {
    if (!matches('PATHOLOGICAL') && !matches('CLINICAL')) continue;
    items.push({ evidenceId: op.uuid, evidenceType: 'OPERATIVE_FINDING', sourceResourceType: 'OperativeRecord', sourceResourceId: op.uuid, sourceDate: op.signedAt || op.createdAt, reportedBy: op.signedByName || null, status: op.status, relevantFinding: (op.findings || op.performedProcedure || '').slice(0, 140), group: 'Operative reports' });
  }
  return items.sort((a, b) => new Date(b.sourceDate || 0) - new Date(a.sourceDate || 0));
}

function stagingEvidenceSuggestions(patientUuid, fact, assessmentDate, months) {
  const windowEnd = assessmentDate || nowIso().slice(0, 10);
  const windowMonths = Math.min(Math.max(Number(months) || 6, 1), 24);
  const windowStart = new Date(windowEnd);
  windowStart.setMonth(windowStart.getMonth() - windowMonths);
  // Per-fact source kinds: schema field override (disease-specific), else the
  // generic hint map, else all kinds (honest broadest default).
  let types = null;
  const dx = store.find('diagnoses', d => d.patientUuid === patientUuid)
    .sort((a, b) => new Date(b.diagnosisDate || b.createdAt || 0) - new Date(a.diagnosisDate || a.createdAt || 0))[0] || null;
  if (dx) {
    const { provider } = providers.resolveProvider(dx);
    const f = provider.resolveSchema(dx).fields.find(x => x.key === fact);
    types = (f && f.evidenceSourceTypes) || EVIDENCE_FACT_HINTS[fact] || null;
  }
  const suggestions = stagingEvidenceItems(patientUuid, { windowStart, windowEnd, types });
  return { fact, window: { start: windowStart.toISOString().slice(0, 10), end: windowEnd, months: windowMonths }, sourceTypes: types, suggestions };
}

// ---- Staging discrepancy flag (staging mandate §31) -----------------------
// The clinician NEVER hand-edits a calculated result. Disagreement is recorded as
// a flag on the signed assessment + a review task for the oncologist; correction
// happens by fixing the underlying facts and signing a superseding assessment.
function flagStagingDiscrepancy(actor, assessmentUuid, data) {
  rbac.assertCanWrite(actor, 'flagStagingDiscrepancy');
  const a = store.byUuid('stagingAssessments', assessmentUuid);
  gate(!a, 'Staging assessment not found');
  gate(a.status !== 'SIGNED', 'Only a SIGNED staging assessment can be flagged');
  gate(!a.stageResult, 'Assessment has no stage result to flag');
  const reason = String((data && data.reason) || '').trim();
  const requestedCorrection = String((data && data.requestedCorrection) || '').trim();
  gate(!reason, 'A discrepancy reason is required');
  gate(!requestedCorrection, 'A requested correction is required — describe the wrong fact or source');
  if (store.find('stagingDiscrepancyFlags', f => f.stagingAssessmentUuid === assessmentUuid && f.status === 'OPEN').length) {
    gate(true, 'An OPEN discrepancy flag already exists for this assessment');
  }
  const flag = {
    uuid: uuid(),
    patientUuid: a.patientUuid,
    stagingAssessmentUuid: assessmentUuid,
    flaggedResult: a.stageResult,
    reason,
    requestedCorrection,
    status: 'OPEN',
    flaggedBy: actor.uuid,
    flaggedByName: actor.name,
    flaggedAt: nowIso(),
    resolvedAt: null,
    resolvedByAssessmentUuid: null
  };
  store.insert('stagingDiscrepancyFlags', flag);
  store.audit(actor, 'STAGING_DISCREPANCY_FLAGGED', 'stagingAssessment', assessmentUuid, reason + ' — correction requested: ' + requestedCorrection);
  createTask(actor, 'STAGING_DISCREPANCY', a.patientUuid, { flagUuid: flag.uuid, stagingAssessmentUuid: assessmentUuid }, 48);
  return flag;
}

// Sign-side resolution (§31 loop closure): signing a superseding assessment whose
// supersedes target carries the OPEN flag marks it resolved with the new record.
function resolveOpenDiscrepancyFlag(actor, supersededUuid, newAssessmentUuid) {
  const open = store.find('stagingDiscrepancyFlags', f => f.stagingAssessmentUuid === supersededUuid && f.status === 'OPEN');
  if (!open.length) return;
  for (const f of open) {
    store.update('stagingDiscrepancyFlags', f.uuid, { status: 'RESOLVED', resolvedAt: nowIso(), resolvedByAssessmentUuid: newAssessmentUuid });
    store.audit(actor, 'STAGING_DISCREPANCY_RESOLVED', 'stagingAssessment', supersededUuid, 'resolved by superseding assessment ' + newAssessmentUuid);
  }
  // §49: the flag's review task is consumed by the corrective signature itself.
  wf.completeOpenTasks(actor, open[0].patientUuid, t => t.code === 'STAGING_DISCREPANCY' && t.payload && t.payload.flagUuid === open[0].uuid, 'discrepancy resolved by corrected staging assessment');
}


// Slice E: after an operative record is SIGNED and its specimen histopathology
// is FINAL, determine staging eligibility and emit the pathological-staging task.
// Classification follows the real treatment history (§45/§46):
//   - prior posttherapy-clinical staging, delivered systemic administration or
//     delivered RT fraction before the operation → POSTTHERAPY_PATHOLOGICAL (yp)
//   - otherwise (upfront surgery)               → PATHOLOGICAL (p)
// Prior signed assessments are never overwritten: a NEW assessment context is
// opened and the clinician enters pT/pN/pM from the pathology evidence. Every
// finalization path funnels here (recordResult, amendResult, and the
// signOperativeRecord catch-up in treatment.js); the flag makes it idempotent.
function maybeCreatePathologicalRestaging(actor, patientUuid, order, result) {
  if (!order || !order.operativeRecordUuid || !result) return;
  if (!(order.category === 'PATHOLOGY' || result.resultType === 'PATHOLOGY')) return;
  const rec = store.byUuid('operativeRecords', order.operativeRecordUuid);
  if (!rec || rec.status !== 'SIGNED') return;   // open record: signOperativeRecord catches up
  if (rec.pathologicalStagingTriggered) return;  // idempotent per operative record
  const opDate = rec.performedDate || (rec.signedAt || '').slice(0, 10);
  const priorStaging = store.find('stagingAssessments', s => s.patientUuid === patientUuid && s.status === 'SIGNED');
  const posttherapyStaging = priorStaging.some(s => s.stagingContext === 'POSTTHERAPY_CLINICAL');
  const deliveredSystemic = store.find('administrationRecords', a => a.patientUuid === patientUuid)
    .some(a => (a.actualStart || a.createdAt || '').slice(0, 10) && opDate && (a.actualStart || a.createdAt).slice(0, 10) <= opDate);
  const deliveredRt = store.find('rtFractions', f => f.patientUuid === patientUuid)
    .some(f => opDate && (f.deliveredDate || '').slice(0, 10) <= opDate);
  const neoadjuvant = posttherapyStaging || deliveredSystemic || deliveredRt;
  const classification = neoadjuvant ? 'POSTTHERAPY_PATHOLOGICAL' : 'PATHOLOGICAL';
  // one live restaging task per operative record
  const existing = wf.tasksForPatient(patientUuid).find(t => t.code === 'PATHOLOGICAL_STAGING' && t.payload && t.payload.operativeRecordUuid === order.operativeRecordUuid && t.status === 'OPEN');
  if (existing) return;
  createTask(actor, 'PATHOLOGICAL_STAGING', patientUuid, {
    operativeRecordUuid: order.operativeRecordUuid, resultUuid: result.uuid, classification,
    prefix: classification === 'POSTTHERAPY_PATHOLOGICAL' ? 'yp' : 'p',
    reason: neoadjuvant ? 'surgery after neoadjuvant therapy' : 'upfront surgery — final histopathology available'
  });
  rec.pathologicalStagingTriggered = true;
  store.update('operativeRecords', rec.uuid, rec);
  store.audit(actor, 'PATHOLOGICAL_STAGING_DUE', 'operativeRecord', rec.uuid, classification + ' restaging task created from finalized histopathology');
}

function latestSignedStaging(patientUuid) {
  const all = store.find('stagingAssessments', s => s.patientUuid === patientUuid && s.status === 'SIGNED');
  all.sort((a, b) => new Date(b.signedAt) - new Date(a.signedAt));
  return all[0] || null;
}


module.exports = {
  stagingSchemaFor, resolvedSnapshotFor, applyStagingSignGates,
  createStagingAssessment, signStagingAssessment,
  flagStagingDiscrepancy, resolveOpenDiscrepancyFlag,
  stagingEvidenceSuggestions, stagingEvidenceItems, maybeCreatePathologicalRestaging,
  latestSignedStaging
};
