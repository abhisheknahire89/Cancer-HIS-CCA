// CCA OS — Staging Content Providers (SPI)
// CRITICAL RULE ENFORCED HERE: this file ships NEUTRAL reference schemas only.
// No historical AJCC/FIGO tables, no proprietary content. Licensed packs plug in later.
'use strict';
const masters = require('./masters');

const AUTHORITY = 'CCA-REFERENCE-SKELETON';
const VERSION = '0.1.0';

// Staging contexts
const CONTEXTS = ['CLINICAL', 'PATHOLOGICAL', 'POSTTHERAPY_CLINICAL', 'POSTTHERAPY_PATHOLOGICAL', 'RECURRENCE_RETREATMENT', 'AUTOPSY', 'NON_TNM'];

// Evidence source types (mandate §4)
const SOURCE_TYPES = ['CLINICAL', 'RADIOLOGICAL', 'PATHOLOGICAL', 'LABORATORY', 'MOLECULAR', 'EXTERNAL_DOCUMENT'];

// Governed coded options: every coded field must render/validate against real option objects
// ({code,label}). A raw string like ['ISS_I'] is not master-governed and rendered an empty value
// in the UI — normalize to the governed master item so dropdown → governed value holds.
function normalizeOptions(options) {
  if (!options) return null;
  return options.map(o => {
    if (o && typeof o === 'object') return o;                       // already {code,label}
    const governed = masters.getByCode('stageClassification', String(o));
    return governed ? { code: governed.code, label: governed.label } : { code: String(o), label: String(o) };
  });
}

// TNM prefix by context
function tnmPrefixFor(context) {
  switch (context) {
    case 'PATHOLOGICAL': return 'p';
    case 'POSTTHERAPY_CLINICAL': return 'yc';
    case 'POSTTHERAPY_PATHOLOGICAL': return 'yp';
    case 'RECURRENCE_RETREATMENT': return 'r';
    case 'AUTOPSY': return 'a';
    default: return 'c';
  }
}

function field(key, label, type, options, opts) {
  return Object.assign({ key, label, type, options: options || null }, opts || {});
}

function tnmFields(includePrefix, context, extras) {
  const fields = [];
  if (includePrefix) {
    // §1 terminology: categories, not stages. §9: there is NO pM0 — in pathological
    // contexts M is OPTIONAL (pM1 only when metastatic disease is pathologically
    // demonstrated; otherwise M stays with the clinical assessment).
    const mOptional = ['PATHOLOGICAL', 'POSTTHERAPY_PATHOLOGICAL', 'AUTOPSY'].includes(context);
    fields.push(field('t', 'Primary Tumour Category (T)', 'coded', masters.getMaster('t'), { required: true, prefix: tnmPrefixFor(context) }));
    fields.push(field('n', 'Regional Node Category (N)', 'coded', masters.getMaster('n'), { required: true, prefix: tnmPrefixFor(context) }));
    fields.push(field('m', 'Distant Metastasis Category (M)', 'coded', masters.getMaster('m'), { required: !mOptional, prefix: tnmPrefixFor(context) }));
  }
  if (extras) fields.push(...extras);
  return fields;
}

function stageResultField() {
  return field('stageResult', 'Stage / classification result', 'coded', masters.getMaster('stageClassification'), { required: true });
}

// Generic TNM-oriented provider used by breast, lung, colorectal etc.
function tnmProvider(diseaseCodes, extras, derive) {
  return {
    authority: AUTHORITY,
    version: VERSION,
    supports(dx) { return diseaseCodes.includes(dx.cancerType); },
    resolveSchema(dx) {
      return { authority: AUTHORITY, version: VERSION, contexts: CONTEXTS.filter(c => c !== 'NON_TNM'), fields: tnmFields(true, 'CLINICAL', extras(dx)).concat([stageResultField()]) };
    },
    fieldsForContext(context) { return tnmFields(true, context, extras(dx)); },
    getAllowedValues(fieldKey) {
      if (fieldKey === 't') return masters.getMaster('t').map(i => i.code);
      if (fieldKey === 'n') return masters.getMaster('n').map(i => i.code);
      if (fieldKey === 'm') return masters.getMaster('m').map(i => i.code);
      if (fieldKey === 'stageResult') return masters.getMaster('stageClassification').map(i => i.code);
      return [];
    },
    validateAssessment(assessment) {
      // Automatic-derivation path (staging mandate §11–§15): the engine owns
      // categories/result — sign gates in clinical.js re-derive server-side and
      // refuse any non-CALCULATED status, so required category picks are satisfied
      // by derivation instead of manual entry (mirrors the myeloma provider).
      if (assessment.resultSource === 'AUTOMATIC_ENGINE') return { ok: true, errors: [] };
      const errs = [];
      const allFields = tnmFields(true, assessment.stagingContext, extras(assessment)).concat([stageResultField()]);
      for (const f of allFields) {
        if (f.required && (assessment.variables[f.key] === undefined || assessment.variables[f.key] === '')) errs.push(f.key + ' is required');
        else if (assessment.variables[f.key] !== undefined && assessment.variables[f.key] !== '') {
          if (f.type === 'coded' && f.options && !f.options.find(o => o.code === assessment.variables[f.key])) errs.push(f.key + ' value not allowed: ' + assessment.variables[f.key]);
          if (f.type === 'select' && f.options && !f.options.includes(String(assessment.variables[f.key]))) errs.push(f.key + ' value not allowed: ' + assessment.variables[f.key]);
        }
      }
      if (!assessment.variables.stageResult) errs.push('stageResult is required');
      return { ok: errs.length === 0, errors: errs };
    },
    deriveStage(assessment) {
      return { stage: assessment.variables.stageResult, derivation: 'Provider reference skeleton — authority content pending license', authority: AUTHORITY, version: VERSION };
    },
    _derive: derive
  };
}

// Objective TNM FACT inputs (staging mandate §8): disease-specific raw facts the
// automatic engine derives categories FROM. These are NOT the governed T/N/M
// category selects — clinicians enter objective findings; the engine (or the
// licensed provider) derives categories. Conditional visibility (§10) comes from
// visibleWhen on the field itself; the provider controls these conditions.
const MET_SITES = [
  { code: 'PUL', label: 'Pulmonary' }, { code: 'OSS', label: 'Osseous' },
  { code: 'HEP', label: 'Hepatic' }, { code: 'BRA', label: 'Brain' },
  { code: 'LYM', label: 'Lymph nodes' }, { code: 'MAR', label: 'Bone marrow' },
  { code: 'PLE', label: 'Pleura' }, { code: 'PER', label: 'Peritoneum' },
  { code: 'OTH', label: 'Other' }
];
const MET_FACTOR = () => [
  field('distantMetastasis', 'Distant metastasis (clinical/imaging assessment)', 'boolean', null, { required: false, help: 'Yes opens metastatic-site detail (progressive disclosure)' }),
  field('metastaticSites', 'Metastatic sites', 'multiselect', MET_SITES, { required: false, visibleWhen: { op: 'EQ', key: 'distantMetastasis', value: true }, help: 'Shown only when distant metastasis is present' })
];
const SIZE_FACTOR = () => [
  field('tumourSizeMm', 'Tumour size (largest invasive dimension)', 'number', null, { required: false, min: 0, max: 500, unit: 'mm', help: 'Invasive component only — does NOT determine T by itself without local-extension facts' })
];
const BREAST_FACTS = () => [
  ...SIZE_FACTOR(),
  field('chestWallInvolvement', 'Chest wall involvement', 'boolean', null, { required: false }),
  field('skinInvolvement', 'Skin involvement (ulceration / satellite nodules)', 'boolean', null, { required: false }),
  field('inflammatoryFeatures', 'Inflammatory carcinoma features', 'boolean', null, { required: false }),
  field('regionalNodesExamined', 'Regional nodes examined', 'number', null, { required: false, min: 0, max: 100, help: 'Pathological node count — from the pathology report' }),
  field('regionalNodesPositive', 'Regional nodes positive', 'number', null, { required: false, min: 0, max: 100 }),
  ...MET_FACTOR()
];

// Prostate: adds PSA + Grade Group prognostic factors
function prostateExtras() {
  return [
    field('psa', 'PSA (ng/mL)', 'number', null, { required: true }),
    field('gradeGroup', 'ISUP Grade Group', 'select', ['1', '2', '3', '4', '5'], { required: true })
  ];
}

// Cervix/endometrium/ovary: FIGO-oriented — neutral labels, no FIGO tables
function figoProvider(diseaseCodes, siteLabel) {
  return {
    authority: AUTHORITY,
    version: VERSION,
    supports(dx) { return diseaseCodes.includes(dx.cancerType); },
    resolveSchema() {
      return {
        authority: AUTHORITY, version: VERSION,
        contexts: CONTEXTS.filter(c => c !== 'NON_TNM'),
        fields: [
          field('figoStage', siteLabel + ' FIGO stage (per licensed authority)', 'coded', masters.getMaster('stageClassification'), { required: true }),
          field('histologyConfirmed', 'Histology confirmed', 'boolean', null, { required: true }),
          field('imagingFindings', 'Imaging findings supporting stage', 'text', null, { required: false })
        ]
      };
    },
    getAllowedValues(k) { return k === 'figoStage' ? masters.getMaster('stageClassification').map(i => i.code) : []; },
    validateAssessment(a) {
      const errs = [];
      if (!a.variables.figoStage) errs.push('figoStage is required');
      if (a.variables.histologyConfirmed !== true) errs.push('Histology must be confirmed for FIGO staging');
      return { ok: errs.length === 0, errors: errs };
    },
    deriveStage(a) { return { stage: a.variables.figoStage, derivation: 'FIGO result recorded against licensed authority (skeleton pending)', authority: AUTHORITY, version: VERSION }; }
  };
}

// Lymphoma: Lugano/Ann-Arbor concepts — neutral representation
function lymphomaProvider(diseaseCodes) {
  return {
    authority: AUTHORITY, version: VERSION,
    supports(dx) { return diseaseCodes.includes(dx.cancerType); },
    resolveSchema() {
      return {
        authority: AUTHORITY, version: VERSION,
        contexts: CONTEXTS.filter(c => c !== 'NON_TNM'),
        fields: [
          field('annArborStage', 'Ann-Arbor / Lugano stage concept', 'coded', masters.getMaster('stageClassification'), { required: true }),
          field('bulky', 'Bulky disease', 'boolean', null, { required: true }),
          field('bSymptoms', 'B symptoms', 'boolean', null, { required: true }),
          field('ldhElevated', 'LDH elevated', 'boolean', null, { required: false }),
          field('extranodalSites', 'Number of extranodal sites', 'number', null, { required: false })
        ]
      };
    },
    getAllowedValues(k) { return k === 'annArborStage' ? masters.getMaster('stageClassification').map(i => i.code) : []; },
    validateAssessment(a) {
      const errs = [];
      if (!a.variables.annArborStage) errs.push('annArborStage is required');
      if (typeof a.variables.bulky !== 'boolean') errs.push('bulky is required');
      if (typeof a.variables.bSymptoms !== 'boolean') errs.push('bSymptoms is required');
      return { ok: errs.length === 0, errors: errs };
    },
    deriveStage(a) { return { stage: a.variables.annArborStage, derivation: 'Lugano/Ann-Arbor concept — authority pending license', authority: AUTHORITY, version: VERSION }; }
  };
}

// CLL/SLL — Rai / Binet
function cllProvider() {
  return {
    authority: AUTHORITY, version: VERSION,
    supports(dx) { return dx.cancerType === 'CLL_SLL'; },
    resolveSchema() {
      return {
        authority: AUTHORITY, version: VERSION,
        contexts: CONTEXTS.filter(c => c !== 'NON_TNM'),
        fields: [
          field('raiStage', 'Rai stage', 'coded', normalizeOptions(['I_RAI', 'II_RAI', 'III_RAI', 'IV_RAI']), { required: false }),
          field('binetStage', 'Binet stage', 'coded', normalizeOptions(['A_BINET', 'B_BINET', 'C_BINET']), { required: false }),
          field('absoluteLymphocytes', 'Absolute lymphocyte count', 'number', null, { required: false })
        ]
      };
    },
    getAllowedValues(k) { return ['raiStage', 'binetStage'].includes(k) ? masters.getMaster('stageClassification').map(i => i.code) : []; },
    validateAssessment(a) {
      const errs = [];
      if (!a.variables.raiStage && !a.variables.binetStage) errs.push('Either Rai or Binet stage is required');
      return { ok: errs.length === 0, errors: errs };
    },
    deriveStage(a) { return { stage: a.variables.raiStage || a.variables.binetStage, derivation: 'Rai/Binet — authority pending license', authority: AUTHORITY, version: VERSION }; }
  };
}

// AML — WHO/ICC + ELN risk
function amlProvider() {
  return {
    authority: AUTHORITY, version: VERSION,
    supports(dx) { return dx.cancerType === 'AML'; },
    resolveSchema() {
      return {
        authority: AUTHORITY, version: VERSION,
        contexts: CONTEXTS,
        fields: [
          field('elnRisk', 'ELN genetic risk group', 'coded', normalizeOptions(['ELN_LOW', 'ELN_INT', 'ELN_HIGH']), { required: true }),
          field('whoClassification', 'WHO/ICC classification', 'text', null, { required: true }),
          field('cytogenetics', 'Cytogenetics', 'text', null, { required: false }),
          field('molecular', 'Molecular markers', 'text', null, { required: false })
        ]
      };
    },
    getAllowedValues(k) { return k === 'elnRisk' ? ['ELN_LOW', 'ELN_INT', 'ELN_HIGH'] : []; },
    validateAssessment(a) {
      const errs = [];
      if (!a.variables.elnRisk) errs.push('elnRisk is required');
      if (!a.variables.whoClassification) errs.push('whoClassification is required');
      return { ok: errs.length === 0, errors: errs };
    },
    deriveStage(a) { return { stage: a.variables.elnRisk, derivation: 'ELN risk group — authority pending license', authority: AUTHORITY, version: VERSION }; }
  };
}

// ALL — genetics/CNS/MRD/phase
function allProvider() {
  return {
    authority: AUTHORITY, version: VERSION,
    supports(dx) { return dx.cancerType === 'ALL'; },
    resolveSchema() {
      return {
        authority: AUTHORITY, version: VERSION,
        contexts: CONTEXTS,
        fields: [
          field('riskGroup', 'Risk group', 'coded', normalizeOptions(['ALL_STD', 'ALL_HIGH', 'ALL_VHIGH']), { required: true }),
          field('cnsStatus', 'CNS status', 'select', ['CNS1', 'CNS2', 'CNS3', 'TRAUMATIC'], { required: true }),
          field('mrd', 'MRD status', 'coded', normalizeOptions(['NEGATIVE', 'POSITIVE', 'NOT_DONE']), { required: true }),
          field('genetics', 'Genetics (e.g. Ph status)', 'text', null, { required: false }),
          field('treatmentPhase', 'Treatment phase', 'select', ['INDUCTION', 'CONSOLIDATION', 'MAINTENANCE'], { required: true })
        ]
      };
    },
    getAllowedValues(k) { return k === 'riskGroup' ? masters.getMaster('stageClassification').map(i => i.code) : []; },
    validateAssessment(a) {
      const errs = [];
      for (const k of ['riskGroup', 'cnsStatus', 'mrd', 'treatmentPhase']) if (!a.variables[k]) errs.push(k + ' is required');
      return { ok: errs.length === 0, errors: errs };
    },
    deriveStage(a) { return { stage: a.variables.riskGroup, derivation: 'ALL risk group — authority pending license', authority: AUTHORITY, version: VERSION }; }
  };
}

// Myeloma — ISS/R-ISS/R2-ISS
function mmProvider() {
  return {
    authority: AUTHORITY, version: VERSION,
    supports(dx) { return dx.cancerType === 'MM'; },
    resolveSchema() {
      return {
        authority: AUTHORITY, version: VERSION,
        contexts: CONTEXTS,
        fields: [
          field('issStage', 'ISS stage', 'coded', normalizeOptions(['ISS_I', 'ISS_II', 'ISS_III']), { required: true }),
          field('rissStage', 'R-ISS stage (if available)', 'coded', normalizeOptions(['RISS_I', 'RISS_II', 'RISS_III']), { required: false }),
          field('beta2Microglobulin', 'Beta-2 microglobulin', 'number', null, { required: false, min: 0, max: 100, unit: 'mg/L' }),
          field('albumin', 'Albumin', 'number', null, { required: false, min: 0, max: 10, unit: 'g/dL' }),
          field('ldhElevated', 'LDH elevated above upper limit of normal', 'boolean', null, { required: false }),
          field('cytogeneticRisk', 'Cytogenetic risk (iFISH)', 'select', ['STANDARD', 'HIGH'], { required: false })
        ]
      };
    },
    getAllowedValues(k) { return ['issStage', 'rissStage'].includes(k) ? masters.getMaster('stageClassification').map(i => i.code) : []; },
    validateAssessment(a) {
      // Engine-derived path: the derivation pack owns completeness and value
      // validation (server gate re-runs evaluate()); the hand-picked governed
      // stage remains the clinician-recorded fallback path.
      if (a.resultSource === 'AUTOMATIC_ENGINE') return { ok: true, errors: [] };
      const errs = [];
      if (!a.variables.issStage) errs.push('issStage is required (or β2M + albumin facts for engine derivation)');
      return { ok: errs.length === 0, errors: errs };
    },
    deriveStage(a) { return { stage: a.variables.rissStage || a.variables.issStage, derivation: 'ISS/R-ISS — authority pending license', authority: AUTHORITY, version: VERSION }; }
  };
}

// Provider registry — disease-specific routing (mandate §5)
const PROVIDERS = {
  TNM_BREAST: tnmProvider(['BREAST'], () => [
    ...BREAST_FACTS(),
    // §8: nodal status as an objective clinical fact — the engine derives the N
    // category FROM this; the clinician never picks N1/N2/N3 by hand when a pack
    // can derive it.
    field('clinicalNodalStatus', 'Clinical regional nodal status', 'select', ['NODE_NEGATIVE', 'NODES_MOBILE_1_3', 'NODES_FIXED_MATTED', 'INFRACLAVICULAR', 'SUPRACLAVICULAR'], { required: false, help: 'Palpable regional node findings — fixed/matted or infra/supraclavicular disease drives higher N categories' }),
    field('erStatus', 'ER status', 'select', ['POSITIVE', 'NEGATIVE', 'NOT_DONE'], { required: false }),
    field('prStatus', 'PR status', 'select', ['POSITIVE', 'NEGATIVE', 'NOT_DONE'], { required: false }),
    field('her2Status', 'HER2 status', 'select', ['POSITIVE', 'NEGATIVE', 'EQUIVOCAL', 'NOT_DONE'], { required: false }),
    field('ki67', 'Ki-67 (%)', 'number', null, { required: false })
  ]),
  TNM_LUNG: tnmProvider(['LUNG'], () => [
    ...SIZE_FACTOR(),
    ...MET_FACTOR(),
    field('histologyType', 'Histology type', 'select', ['NSCLC_NOS', 'SCLC', 'ADENO', 'SCC'], { required: false })
  ]),
  TNM_COLORECTAL: tnmProvider(['COLORECTAL'], () => [
    ...MET_FACTOR(),
    field('msiStatus', 'MSI status', 'select', ['MSI_HIGH', 'MSI_LOW', 'MSS', 'NOT_DONE'], { required: false })
  ]),
  TNM_PROSTATE: tnmProvider(['PROSTATE'], prostateExtras),
  TNM_HEADNECK: tnmProvider(['HEADNECK'], () => [
    field('subsite', 'Subsite', 'coded', masters.getMaster('subsite').map(i => i.code), { required: true }),
    field('hpvStatus', 'HPV status', 'select', ['POSITIVE', 'NEGATIVE', 'NOT_DONE'], { required: false })
  ]),
  FIGO_CERVIX: figoProvider(['CERVIX'], 'Cervix'),
  FIGO_ENDOMETRIUM: figoProvider(['ENDOMETRIUM'], 'Endometrium'),
  FIGO_OVARY: figoProvider(['OVARY', 'OTHER_SOLID'], 'Ovary / Fallopian tube'),
  LYMPHOMA: lymphomaProvider(['HL', 'NHL']),
  CLL: cllProvider(),
  AML: amlProvider(),
  ALL: allProvider(),
  MM: mmProvider()
};

function resolveProvider(diagnosis) {
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (p.supports(diagnosis)) return { key, provider: p };
  }
  // Fallback generic TNM provider
  return { key: 'TNM_FALLBACK', provider: tnmProvider([diagnosis.cancerType], () => []) };
}

// §9: the input schema IS the disease schema — every field definition carries the
// dynamic-render contract (key, label, type, options, required, conditional
// visibility, validation bounds, help, unit).
function inputSchema(dx) {
  const { key, provider } = resolveProvider(dx);
  return { providerKey: key, fields: provider.resolveSchema(dx).fields };
}

module.exports = { AUTHORITY, VERSION, CONTEXTS, SOURCE_TYPES, tnmPrefixFor, resolveProvider, inputSchema, PROVIDERS };
