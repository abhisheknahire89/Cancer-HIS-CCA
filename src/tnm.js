// CCA OS — Generic AJCC TNM core staging engine (mandate §1–§13, §21, §25–§28)
//
// SCOPE SPLIT (mandate §23): this module owns the GENERIC classification
// mechanics — prefixes, category semantics, assessment history rules, evidence
// requirements, M-category safety rules. Disease providers own T/N/M
// definitions, subcategories, prognostic factors and stage grouping.
//
// CRITICAL LIMITATION (mandate §41): the general AJCC material provides the
// architecture below but NOT disease-specific T/N/M definitions or stage-group
// tables. Those come only from the configured licensed disease provider; until
// then the platform reports AUTHORITY_CONTENT_UNAVAILABLE and never fabricates.
'use strict';

// ---------------------------------------------------------------------------
// §2 StagingClassification — mandatory on every TNM assessment, with display
// prefixes. AUTOPSY (a) exists in the model but is not offered in the routine
// active-treatment UI (§10).
// ---------------------------------------------------------------------------
const STAGING_CLASSIFICATIONS = [
  { code: 'CLINICAL', prefix: 'c', label: 'Clinical (cTNM)' },
  { code: 'PATHOLOGICAL', prefix: 'p', label: 'Pathological (pTNM)' },
  { code: 'POSTTHERAPY_CLINICAL', prefix: 'yc', label: 'Posttherapy clinical (ycTNM)' },
  { code: 'POSTTHERAPY_PATHOLOGICAL', prefix: 'yp', label: 'Posttherapy pathological (ypTNM)' },
  { code: 'RECURRENCE_RETREATMENT', prefix: 'r', label: 'Recurrence / retreatment (rTNM)' },
  { code: 'AUTOPSY', prefix: 'a', label: 'Autopsy (aTNM)' }
];
const CLASSIFICATION_CODES = STAGING_CLASSIFICATIONS.map(c => c.code);

function classificationPrefix(classification) {
  const c = STAGING_CLASSIFICATIONS.find(x => x.code === classification);
  return c ? c.prefix : null;
}
function classificationLabel(classification) {
  const c = STAGING_CLASSIFICATIONS.find(x => x.code === classification);
  return c ? c.label : classification;
}
// Contexts that are part of the AJCC TNM classification enum (NON_TNM is the
// alternative-classification context used by haematological providers — §25)
function isTnmClassification(code) { return CLASSIFICATION_CODES.includes(code); }

// ---------------------------------------------------------------------------
// §1 Terminology rule: T/N/M are CATEGORIES; STAGE is the aggregate. UI text
// helper so no screen can accidentally label a category as a "stage".
// ---------------------------------------------------------------------------
const CATEGORY_LABELS = {
  t: 'Primary Tumour Category (T)',
  n: 'Regional Node Category (N)',
  m: 'Distant Metastasis Category (M)'
};
const STAGE_GROUP_LABELS = {
  ANATOMIC: 'Anatomic Prognostic Stage Group',
  PROGNOSTIC: 'Prognostic Stage Group'
};

// ---------------------------------------------------------------------------
// §7/§9 M-category safety rules.
//  - MX is INVALID (legacy MX may exist only as flagged historical source data)
//  - There is NO pM0: pathological classification with M0 is a data error
//  - pM1 requires pathological demonstration of metastatic disease
// ---------------------------------------------------------------------------
const M_VALID_GENERIC = ['M0', 'M1'];
const M_LEGACY_ONLY = ['MX']; // rejected on new assessments; import-only, flagged for reconciliation
const METASTATIC_SITES = [
  { code: 'PUL', label: 'Pulmonary' }, { code: 'OSS', label: 'Osseous' },
  { code: 'HEP', label: 'Hepatic' }, { code: 'BRA', label: 'Brain' },
  { code: 'LYM', label: 'Lymph nodes' }, { code: 'MAR', label: 'Bone marrow' },
  { code: 'PLE', label: 'Pleura' }, { code: 'PER', label: 'Peritoneum' },
  { code: 'ADR', label: 'Adrenal' }, { code: 'SKI', label: 'Skin' },
  { code: 'OTH', label: 'Other' }
];

// ---------------------------------------------------------------------------
// §13 Staging window: evidence must belong to the assessment's time period.
// A source dated after the assessment (or absurdly before the diagnosis window)
// does not belong to this classification's staging period.
// ---------------------------------------------------------------------------
function validateEvidenceWindow(assessment) {
  const errors = [];
  const aDate = assessment.assessmentDate;
  for (const ev of assessment.evidence || []) {
    if (!ev.sourceDate) continue; // clinical evaluation without a recorded date is allowed
    if (new Date(ev.sourceDate) > new Date(aDate)) {
      errors.push('evidence for ' + (ev.variableKey || 'general') + ' is dated ' + ev.sourceDate +
        ', after the assessment date ' + aDate + ' — not part of this staging window');
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Generic TNM sign-time validation. Runs AFTER the provider's own schema
// validation (unknown fields / governed values) and BEFORE signing.
// classification: mandatory, enum-locked, prefix recorded
// m: M0/M1(+ provider subcategories); MX impossible; pM0 impossible
// evidence window: per §13
// Returns array of error strings (empty = pass).
// ---------------------------------------------------------------------------
function validateTnmAssessment(assessment, provider) {
  const errors = [];
  const cls = assessment.stagingContext || assessment.classification;

  // TNM-specific gates apply only to TNM schemas (schema has T+N+M fields).
  // Alternative classifications (FIGO, ISS, Lugano…) use the NON_TNM context
  // and are governed by their own providers (mandate §23/§25).
  const schemaFields = (provider.resolveSchema().fields || []);
  const isTnmSchema = ['t', 'n', 'm'].every(k => schemaFields.some(f => f.key === k));
  if (!isTnmSchema) return errors;

  // §2 classification is mandatory and from the enum
  if (!isTnmClassification(cls)) {
    errors.push('staging classification is mandatory — must be one of ' + CLASSIFICATION_CODES.join('/'));
    return errors;
  }
  const prefix = classificationPrefix(cls);

  const m = assessment.variables.m;
  if (m != null && m !== '') {
    const mDef = (provider.resolveSchema().fields || []).find(f => f.key === 'm');
    const mAllowed = (mDef && mDef.options ? mDef.options.map(o => o.code) : M_VALID_GENERIC);
    if (M_LEGACY_ONLY.includes(m)) {
      errors.push('MX is not a valid M category under current AJCC rules (cannot be assessed: use clinical judgement or leave unrecorded; legacy MX is import-only historical data)');
    } else if (!mAllowed.includes(m)) {
      errors.push('m value not allowed: ' + m);
    }
    // §9 NO pM0 — pathological classification never carries M0
    if (m === 'M0' && (cls === 'PATHOLOGICAL' || cls === 'POSTTHERAPY_PATHOLOGICAL' || cls === 'AUTOPSY')) {
      errors.push('STOP_GATE: ' + prefix + 'M0 does not exist — pathological classification is used only when metastatic disease is pathologically demonstrated (pM1); a negative metastatic biopsy contributes to the clinical (cM0) assessment');
    }
    // pM1 requires pathological evidence on this assessment
    if (m === 'M1' && (cls === 'PATHOLOGICAL' || cls === 'POSTTHERAPY_PATHOLOGICAL')) {
      const mEv = (assessment.evidence || []).filter(e => e.variableKey === 'm');
      const hasPathEvidence = mEv.some(e => e.sourceType === 'PATHOLOGICAL' || e.sourceType === 'MOLECULAR');
      if (!hasPathEvidence) {
        errors.push(prefix + 'M1 requires pathological demonstration of metastatic disease (link pathology evidence to the M category)');
      }
    }
  }

  // §5/§6/§25 unknown semantics are governed: empty/blank junk values are already
  // rejected by provider value checks; TX/NX are allowed only where the provider
  // schema offers them (their definitions state "cannot be assessed").

  // §13 staging window
  errors.push(...validateEvidenceWindow(assessment));

  // §26 stage-group unknown handling: a provider that cannot derive must say so
  // with INSUFFICIENT_INFORMATION rather than fabricate — enforced in deriveStage
  // callers (provider contract), not by inventing a group here.
  return errors;
}

// §26: missing-fact helper — used by providers to report why no stage group
// can be derived (e.g. "Missing: Regional node category").
function insufficientInformation(missingFacts) {
  return {
    stageGroupStatus: 'INSUFFICIENT_INFORMATION',
    stage: null,
    missing: missingFacts,
    derivation: 'Stage group cannot yet be determined. Missing: ' + missingFacts.join(', ')
  };
}

// ---------------------------------------------------------------------------
// §31 Evidence picker grouping — the doctor selects from existing signed
// records grouped by department, never retypes source names.
// ---------------------------------------------------------------------------
const EVIDENCE_GROUPS = [
  { group: 'Pathology', match: ['PATHOLOGY'] },
  { group: 'Radiology', match: ['RADIOLOGY', 'IMAGING'] },
  { group: 'Laboratory', match: ['LAB'] },
  { group: 'Molecular results', match: ['MOLECULAR', 'GENETIC'] },
  { group: 'Operative reports', match: ['PROCEDURE'] },
  { group: 'Consultations', match: ['CONSULTATION'] },
  { group: 'External documents', match: ['EXTERNAL_DOCUMENT'] }
];

module.exports = {
  STAGING_CLASSIFICATIONS, CLASSIFICATION_CODES, CATEGORY_LABELS, STAGE_GROUP_LABELS,
  M_VALID_GENERIC, M_LEGACY_ONLY, METASTATIC_SITES, EVIDENCE_GROUPS,
  classificationPrefix, classificationLabel, isTnmClassification,
  validateTnmAssessment, validateEvidenceWindow, insufficientInformation
};
