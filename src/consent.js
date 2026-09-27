// CCA OS — Consent services (canonical §47) — remediation D2
// Versioned consent templates; treatment-specific informed consent record;
// required before readiness can clear consentTaken. Signed records immutable.
'use strict';
const store = require('./store');
const rbac = require('./rbac');
const masters = require('./masters');

const { uuid, nowIso, gate, sign, assertNotSigned, createTask } = require('./workflow');

// ---- Consent template master (versioned; governed) -------------------------
// seedTemplates() is idempotent; templates carry version + effective dates.
const SEED_TEMPLATES = [
  { code: 'SYSTEMIC_THERAPY_V1', title: 'Informed consent — systemic therapy (antineoplastic)', version: '1.0', risks: 'Myelosuppression, infection, nausea/vomiting, alopecia, organ toxicity per regimen', benefits: 'Disease control / cure intent per care plan', alternatives: 'Observation, other regimens, palliative care', adverseEffects: 'Regimen-specific; emergency contact instructions provided' },
  { code: 'RADIOTHERAPY_V1', title: 'Informed consent — radiotherapy', version: '1.0', risks: 'Skin reaction, fatigue, site-specific toxicity', benefits: 'Local disease control', alternatives: 'Systemic therapy only, observation', adverseEffects: 'Site-specific; provided in education sheet' },
  { code: 'SURGERY_V1', title: 'Informed consent — surgical oncology', version: '1.0', risks: 'Bleeding, infection, anaesthetic risk, site-specific complications', benefits: 'Resection / staging', alternatives: 'Neoadjuvant therapy, observation', adverseEffects: 'Procedure-specific; provided in education sheet' }
];

function seedConsentTemplates() {
  const d = store.getDb();
  if (!d.consentTemplates) d.consentTemplates = [];
  for (const t of SEED_TEMPLATES) {
    if (!d.consentTemplates.find(x => x.code === t.code)) {
      d.consentTemplates.push(Object.assign({ id: uuid(), active: true, effectiveFrom: '2026-01-01', language: 'EN' }, t));
    }
  }
  store.persist();
}

function listConsentTemplates() {
  seedConsentTemplates();
  return store.getDb().consentTemplates.filter(t => t.active);
}

// ---- Consent record ---------------------------------------------------------
function recordConsent(actor, data) {
  rbac.assertCanWrite(actor, 'recordConsent');
  const patient = store.byUuid('patients', data.patientUuid);
  gate(!patient, 'Patient not found');
  const tpl = store.getDb().consentTemplates.find(t => t.code === data.templateCode && t.active);
  gate(!tpl, 'Unknown governed consent template: ' + data.templateCode);
  gate(!data.carePlanUuid, 'carePlanUuid is required (treatment-specific consent)');
  const plan = store.byUuid('carePlans', data.carePlanUuid);
  gate(!plan || plan.status !== 'SIGNED', 'STOP_GATE: consent requires a SIGNED care plan');
  gate(plan.patientUuid !== patient.uuid, 'CROSS_PATIENT: care plan belongs to another patient');
  gate(!data.consentType, 'consentType required');
  gate(!data.discussedRisks, 'discussedRisks required');
  gate(!data.discussedBenefits, 'discussedBenefits required');
  gate(!data.discussedAlternatives, 'discussedAlternatives required');
  gate(!data.acknowledgedBy, 'patient/caregiver acknowledgement required');

  const consent = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    carePlanUuid: plan.uuid,
    consentType: data.consentType,           // SYSTEMIC_THERAPY | RADIOTHERAPY | SURGERY | OTHER
    templateCode: tpl.code, templateVersion: tpl.version,
    regimenRef: data.regimenRef || plan.systemicTherapy || '',
    risksDiscussed: data.discussedRisks,
    benefitsDiscussed: data.discussedBenefits,
    alternativesDiscussed: data.discussedAlternatives,
    fertilityDiscussed: !!data.fertilityDiscussed,
    pregnancyCounselling: !!data.pregnancyCounselling,
    scheduleExplained: !!data.scheduleExplained,
    adverseEffectsExplained: !!data.adverseEffectsExplained,
    emergencyInstructions: data.emergencyInstructions || 'Provided',
    language: data.language || 'EN',
    acknowledgedBy: data.acknowledgedBy,      // patient or caregiver name
    clinician: actor.uuid, clinicianName: actor.name,
    documentRef: data.documentRef || null,
    version: 1, supersedes: null, supersededBy: null,
    status: 'DRAFT', createdAt: nowIso(), signedAt: null
  };
  store.insert('consents', consent);
  store.audit(actor, 'CONSENT_RECORDED', 'consent', consent.uuid, tpl.code + ' v' + tpl.version);
  return consent;
}

function signConsent(actor, consentUuid) {
  rbac.assertCanWrite(actor, 'signConsent');
  const c = store.byUuid('consents', consentUuid);
  gate(!c, 'Consent not found');
  assertNotSigned('consent', c);
  c.status = 'SIGNED';
  c.signedAt = nowIso();
  c.signature = sign(actor, 'consent', c.uuid, c.consentType + ' (' + c.templateCode + ' v' + c.templateVersion + ')');
  store.update('consents', consentUuid, c);
  store.audit(actor, 'CONSENT_SIGNED', 'consent', c.uuid, c.consentType);
  return c;
}

// Material change → versioned supersession (canonical §47 "versioned if treatment materially changes")
function supersedeConsent(actor, consentUuid, data) {
  rbac.assertCanWrite(actor, 'recordConsent');
  const prev = store.byUuid('consents', consentUuid);
  gate(!prev, 'Consent not found');
  gate(!['SIGNED'].includes(prev.status), 'Only a signed consent can be superseded');
  const merged = Object.assign({}, prev, data, {
    uuid: uuid(), version: (prev.version || 1) + 1, supersedes: prev.uuid,
    status: 'DRAFT', createdAt: nowIso(), signedAt: null, signature: null
  });
  delete merged.supersededBy;
  store.insert('consents', merged);
  store.update('consents', prev.uuid, { supersededBy: merged.uuid });
  store.audit(actor, 'CONSENT_SUPERSEDED', 'consent', merged.uuid, 'v' + merged.version + ' supersedes v' + prev.version);
  return merged;
}

function latestSignedConsent(patientUuid, consentType) {
  let list = store.find('consents', c => c.patientUuid === patientUuid && c.status === 'SIGNED');
  if (consentType) list = list.filter(c => c.consentType === consentType);
  list.sort((a, b) => new Date(b.signedAt) - new Date(a.signedAt));
  return list[0] || null;
}

module.exports = { seedConsentTemplates, listConsentTemplates, recordConsent, signConsent, supersedeConsent, latestSignedConsent };
