// CCA OS — RBAC (canonical §48: every write action needs role authorization)
'use strict';

// role -> allowed write actions (service functions)
const WRITE_RULES = {
  'Front Desk': ['registerPatient'],
  'Intake Nurse': ['recordConsultation'],
  'Medical Oncologist': ['recordConsultation', 'orderInvestigation', 'createResultsReview', 'recordDiagnosis', 'reviseDiagnosis', 'signDiagnosis',
    'recordConsent', 'signConsent', // canonical §47 consent capture
    'createDiseaseProfile', 'signDiseaseProfile', 'createStagingAssessment', 'signStagingAssessment', 'flagStagingDiscrepancy',
    'openMdtCase', 'recordMdtDiscussion', // canonical §24: treating oncologist refers to MDT; chair-sign stays exclusive to MDT Chair
    'resolveInfusionReaction', // MO decides restart/discontinue after a reaction
    'createCarePlan', 'signCarePlan', 'createTreatmentOrder', 'signTreatmentOrder', 'delayCycle',
    'nextCycleDecision', 'recordResponseAssessment', 'signResponseAssessment', 'recordToxicity', 'signToxicity'],
  'Radiation Oncologist': ['createRtPrescription', 'approveRtPlan', 'recordRtFraction'],
  'Surgical Oncologist': ['createSurgicalPlan', 'signSurgicalPlan', 'recordOperativeNote', 'signOperativeRecord'],
  'Radiologist': ['recordResult'],
  'Pathologist': ['recordResult'],
  'Lab': ['recordResult'],
  'MDT Coordinator': ['openMdtCase', 'recordMdtDiscussion'],
  'MDT Chair': ['signMdtOutcome'],
  'Financial Counsellor': ['recordFinancialCounselling', 'signFinancialCounselling'],
  'Nurse Navigator': ['recordReadiness', 'annotateCalendar'],
  'Pharmacist': ['pharmacyReceive', 'pharmacyVerify', 'pharmacyPrepare', 'pharmacyRelease', 'dispense'],
  'Day Care Nurse': ['startAdministration', 'updateAdministration', 'completeAdministration', 'recordInfusionReaction', 'resolveInfusionReaction'],
  'Administrator': ['annotateCalendar', 'upsertContentLicense', 'reloadContentPacks', 'connectLicensedAjcc'], // masters, content licences, staging pack reloads, licensed AJCC connection
  'External Consultant': []
};

const IMMUTABLE_ROLES = new Set(['External Consultant']);

// Service-layer enforcement: a few service entry points are invoked internally by
// other services (e.g. consultation creating investigation orders) — those internal
// calls bypass RBAC intentionally via this set.
const INTERNAL_ACTIONS = new Set(['orderInvestigation', 'recordConsent', 'signConsent', 'supersedeConsent']);

function assertCanWrite(actor, action) {
  if (INTERNAL_ACTIONS.has(action)) return; // internal service-to-service call
  if (IMMUTABLE_ROLES.has(actor.role)) {
    const e = new Error('RBAC: role ' + actor.role + ' has read-only access (' + action + ')');
    e.code = 'RBAC';
    e.httpStatus = 403;
    throw e;
  }
  const allowed = WRITE_RULES[actor.role];
  if (!allowed || !allowed.includes(action)) {
    const e = new Error('RBAC: role ' + actor.role + ' is not authorized for ' + action);
    e.code = 'RBAC';
    e.httpStatus = 403;
    throw e;
  }
}

module.exports = { assertCanWrite, WRITE_RULES };
