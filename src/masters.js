// CCA OS — Governed Masters (Sumant requirement: dropdown → dropdown → dropdown)
'use strict';
const store = require('./store');
const wf = require('./workflow');
const crypto = require('crypto');

// The 23 governed masters from the spec
const MASTER_KEYS = [
  'cancerType', 'primarySite', 'subsite', 'histology', 'morphology', 'icd10',
  'icdOtopography', 'icdOmorphology', 'icdOVersion', 'grade', 'biomarker', 'stagingFramework',
  't', 'n', 'm', 'stageClassification', 'treatmentIntent', 'lineOfTherapy',
  'regimen', 'medication', 'route', 'diluent', 'schedule', 'toxicity', 'toxicityVersion', 'response',
  'cancerFamily', 'behaviour', 'diagnosticTest'
];

function uuid() { return crypto.randomUUID(); }

// Seed governed masters. Values are neutral/common terminology only.
// No historical AJCC/FIGO tables and no proprietary content are embedded.
function seedMasters() {
  const d = store.getDb();
  const put = (name, items) => {
    if (d.masters[name] && d.masters[name].length) return; // idempotent
    d.masters[name] = items.map(i => Object.assign({ id: uuid(), active: true }, i));
  };

  put('cancerType', [
    { code: 'BREAST', label: 'Breast cancer', site: 'BREAST' },
    { code: 'LUNG', label: 'Lung cancer' },
    { code: 'COLORECTAL', label: 'Colorectal cancer' },
    { code: 'PROSTATE', label: 'Prostate cancer' },
    { code: 'HEADNECK', label: 'Head & neck cancer' },
    { code: 'CERVIX', label: 'Cervical cancer' },
    { code: 'ENDOMETRIUM', label: 'Endometrial cancer' },
    { code: 'OVARY', label: 'Ovarian / fallopian tube cancer' },
    { code: 'HL', label: 'Hodgkin lymphoma' },
    { code: 'NHL', label: 'Non-Hodgkin lymphoma' },
    { code: 'CLL_SLL', label: 'CLL / SLL' },
    { code: 'AML', label: 'Acute myeloid leukaemia' },
    { code: 'ALL', label: 'Acute lymphoblastic leukaemia' },
    { code: 'MM', label: 'Multiple myeloma' },
    { code: 'OTHER_SOLID', label: 'Other solid tumour' }
  ]);

  put('primarySite', [
    { code: 'BREAST', label: 'Breast' },
    { code: 'LUNG', label: 'Lung' },
    { code: 'COLON', label: 'Colon' },
    { code: 'RECTUM', label: 'Rectum' },
    { code: 'PROSTATE', label: 'Prostate' },
    { code: 'ORAL_CAVITY', label: 'Oral cavity' },
    { code: 'OROPHARYNX', label: 'Oropharynx' },
    { code: 'LARYNX', label: 'Larynx' },
    { code: 'NASOPHARYNX', label: 'Nasopharynx' },
    { code: 'CERVIX', label: 'Cervix' },
    { code: 'ENDOMETRIUM', label: 'Endometrium' },
    { code: 'OVARY', label: 'Ovary' },
    { code: 'FALLOPIAN', label: 'Fallopian tube' },
    { code: 'LYMPH_NODE', label: 'Lymph node' },
    { code: 'BONE_MARROW', label: 'Bone marrow' },
    { code: 'OTHER', label: 'Other (specify in notes)' }
  ]);

  put('subsite', [
    { code: 'UPPER_OUTER', label: 'Upper outer quadrant', parent: 'BREAST' },
    { code: 'LOWER_OUTER', label: 'Lower outer quadrant', parent: 'BREAST' },
    { code: 'UPPER_INNER', label: 'Upper inner quadrant', parent: 'BREAST' },
    { code: 'LOWER_INNER', label: 'Lower inner quadrant', parent: 'BREAST' },
    { code: 'CENTRAL', label: 'Central portion', parent: 'BREAST' },
    { code: 'UPPER_LOBE', label: 'Upper lobe', parent: 'LUNG' },
    { code: 'MIDDLE_LOBE', label: 'Middle lobe', parent: 'LUNG' },
    { code: 'LOWER_LOBE', label: 'Lower lobe', parent: 'LUNG' },
    { code: 'CAECUM', label: 'Caecum', parent: 'COLON' },
    { code: 'ASCENDING', label: 'Ascending colon', parent: 'COLON' },
    { code: 'TRANSVERSE', label: 'Transverse colon', parent: 'COLON' },
    { code: 'DESCENDING', label: 'Descending colon', parent: 'COLON' },
    { code: 'SIGMOID', label: 'Sigmoid colon', parent: 'COLON' },
    { code: 'RECTOSIGMOID', label: 'Rectosigmoid junction', parent: 'RECTUM' },
    { code: 'TONGUE', label: 'Tongue', parent: 'ORAL_CAVITY' },
    { code: 'FLOOR_MOUTH', label: 'Floor of mouth', parent: 'ORAL_CAVITY' },
    { code: 'TONSIL', label: 'Tonsil', parent: 'OROPHARYNX' },
    { code: 'BASE_TONGUE', label: 'Base of tongue', parent: 'OROPHARYNX' },
    { code: 'GLOTTIS', label: 'Glottis', parent: 'LARYNX' },
    { code: 'SUPRAGLOTTIS', label: 'Supraglottis', parent: 'LARYNX' },
    { code: 'ECTOCERVIX', label: 'Ectocervix', parent: 'CERVIX' },
    { code: 'ENDOCERVIX', label: 'Endocervix', parent: 'CERVIX' }
  ]);

  put('histology', [
    { code: 'IDC', label: 'Invasive ductal carcinoma' },
    { code: 'ILC', label: 'Invasive lobular carcinoma' },
    { code: 'ADENO', label: 'Adenocarcinoma' },
    { code: 'SCC', label: 'Squamous cell carcinoma' },
    { code: 'NSCLC_NOS', label: 'Non-small cell carcinoma, NOS' },
    { code: 'SCLC', label: 'Small cell carcinoma' },
    { code: 'ACINAR', label: 'Acinar cell adenocarcinoma' },
    { code: 'DLBCL', label: 'Diffuse large B-cell lymphoma' },
    { code: 'NODULAR_SCLEROSIS', label: 'Nodular sclerosis (Hodgkin)' },
    { code: 'AML_NOS', label: 'Acute myeloid leukaemia, NOS' },
    { code: 'B_ALL', label: 'B-lymphoblastic leukaemia' },
    { code: 'PLASMA_CELL', label: 'Plasma cell myeloma' },
    { code: 'OTHER', label: 'Other (specify)' }
  ]);

  put('morphology', [
    { code: 'NOS', label: 'NOS' },
    { code: 'WELL_DIFF', label: 'Well differentiated' },
    { code: 'MOD_DIFF', label: 'Moderately differentiated' },
    { code: 'POOR_DIFF', label: 'Poorly differentiated' },
    { code: 'UNDIFF', label: 'Undifferentiated' }
  ]);

  put('icd10', [
    { code: 'C50', label: 'C50 — Breast' },
    { code: 'C34', label: 'C34 — Bronchus and lung' },
    { code: 'C18', label: 'C18 — Colon' },
    { code: 'C20', label: 'C20 — Rectum' },
    { code: 'C61', label: 'C61 — Prostate' },
    { code: 'C00-C14', label: 'C00–C14 — Lip, oral cavity, pharynx' },
    { code: 'C32', label: 'C32 — Larynx' },
    { code: 'C11', label: 'C11 — Nasopharynx' },
    { code: 'C53', label: 'C53 — Cervix uteri' },
    { code: 'C54', label: 'C54 — Corpus uteri' },
    { code: 'C56', label: 'C56 — Ovary' },
    { code: 'C81', label: 'C81 — Hodgkin lymphoma' },
    { code: 'C82-C85', label: 'C82–C85 — Non-Hodgkin lymphoma' },
    { code: 'C91', label: 'C91 — Lymphoid leukaemia' },
    { code: 'C92', label: 'C92 — Myeloid leukaemia' },
    { code: 'C90', label: 'C90 — Multiple myeloma' }
  ]);

  put('icdOtopography', [
    { code: 'C50.4', label: 'C50.4 — Upper outer quadrant breast' },
    { code: 'C50.9', label: 'C50.9 — Breast, NOS' },
    { code: 'C34.1', label: 'C34.1 — Upper lobe lung' },
    { code: 'C18.7', label: 'C18.7 — Sigmoid colon' },
    { code: 'C61.9', label: 'C61.9 — Prostate' },
    { code: 'C53.9', label: 'C53.9 — Cervix uteri' },
    { code: 'C56.9', label: 'C56.9 — Ovary' },
    { code: 'C77', label: 'C77 — Lymph node' }
  ]);

  put('icdOmorphology', [
    { code: '8500/3', label: '8500/3 — Invasive ductal carcinoma' },
    { code: '8140/3', label: '8140/3 — Adenocarcinoma, NOS' },
    { code: '8070/3', label: '8070/3 — Squamous cell carcinoma, NOS' },
    { code: '8041/3', label: '8041/3 — Small cell carcinoma' },
    { code: '9680/3', label: '9680/3 — DLBCL' },
    { code: '9861/3', label: '9861/3 — AML, NOS' },
    { code: '9687/3', label: '9687/3 — Burkitt lymphoma' }
  ]);

  put('grade', [
    { code: 'GX', label: 'GX — Cannot be assessed' },
    { code: 'G1', label: 'G1 — Well differentiated' },
    { code: 'G2', label: 'G2 — Moderately differentiated' },
    { code: 'G3', label: 'G3 — Poorly differentiated' },
    { code: 'G4', label: 'G4 — Undifferentiated' }
  ]);

  // Biomarkers with disease applicability (canonical §11): no universal list.
  // Extended per directive §10: result type, unit and allowed values live in master data
  // (BiomarkerMaster), so applicability-driven forms never hard-code marker lists.
  put('biomarker', [
    { code: 'ER', label: 'ER (oestrogen receptor)', category: 'PREDICTIVE', applicability: ['BREAST'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'EQUIVOCAL', 'NOT_DONE'] },
    { code: 'PR', label: 'PR (progesterone receptor)', category: 'PREDICTIVE', applicability: ['BREAST'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'EQUIVOCAL', 'NOT_DONE'] },
    { code: 'HER2_IHC', label: 'HER2 IHC', category: 'PREDICTIVE', applicability: ['BREAST', 'GASTRIC'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'EQUIVOCAL', 'NOT_DONE'] },
    { code: 'HER2_FISH', label: 'HER2 FISH', category: 'PREDICTIVE', applicability: ['BREAST', 'GASTRIC'], resultType: 'QUALITATIVE', allowedValues: ['AMPLIFIED', 'NOT_AMPLIFIED', 'EQUIVOCAL', 'NOT_DONE'] },
    { code: 'KI67', label: 'Ki-67 index', category: 'PROGNOSTIC', applicability: ['BREAST'], resultType: 'QUANTITATIVE', unit: '%' },
    { code: 'PSA', label: 'PSA', category: 'PROGNOSTIC', applicability: ['PROSTATE'], resultType: 'QUANTITATIVE', unit: 'ng/mL' },
    { code: 'EGFR', label: 'EGFR mutation', category: 'PREDICTIVE', applicability: ['LUNG'], resultType: 'QUALITATIVE', allowedValues: ['MUTATION_DETECTED', 'NO_MUTATION_DETECTED', 'NOT_DONE'] },
    { code: 'ALK', label: 'ALK rearrangement', category: 'PREDICTIVE', applicability: ['LUNG'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'NOT_DONE'] },
    { code: 'ROS1', label: 'ROS1 rearrangement', category: 'PREDICTIVE', applicability: ['LUNG'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'NOT_DONE'] },
    { code: 'PDL1', label: 'PD-L1 TPS', category: 'PREDICTIVE', applicability: ['LUNG', 'HEADNECK', 'CERVIX'], resultType: 'QUANTITATIVE', unit: '%' },
    { code: 'KRAS', label: 'KRAS mutation', category: 'PREDICTIVE', applicability: ['COLORECTAL', 'LUNG'], resultType: 'QUALITATIVE', allowedValues: ['MUTATION_DETECTED', 'NO_MUTATION_DETECTED', 'NOT_DONE'] },
    { code: 'MSI', label: 'MSI / MMR status', category: 'PREDICTIVE', applicability: ['COLORECTAL'], resultType: 'QUALITATIVE', allowedValues: ['MSI_HIGH', 'MSI_LOW', 'MSS', 'NOT_DONE'] },
    { code: 'HPV', label: 'HPV status', category: 'PREDICTIVE', applicability: ['HEADNECK', 'CERVIX'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'NOT_DONE'] },
    { code: 'CA125', label: 'CA-125', category: 'TUMOR_MARKER', applicability: ['OVARY'], resultType: 'QUANTITATIVE', unit: 'U/mL' },
    { code: 'AFP', label: 'AFP', category: 'TUMOR_MARKER', applicability: ['OTHER_SOLID'], resultType: 'QUANTITATIVE', unit: 'ng/mL' },
    { code: 'BETA_HCG', label: 'Beta-hCG', category: 'TUMOR_MARKER', applicability: ['OTHER_SOLID'], resultType: 'QUANTITATIVE', unit: 'IU/L' },
    { code: 'BCR_ABL', label: 'BCR::ABL1 (p210)', category: 'MOLECULAR', applicability: ['AML', 'ALL', 'CML'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'NOT_DONE'] },
    { code: 'FLT3_ITD', label: 'FLT3-ITD', category: 'MOLECULAR', applicability: ['AML'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'NOT_DONE'] },
    { code: 'NPM1', label: 'NPM1 mutation', category: 'MOLECULAR', applicability: ['AML'], resultType: 'QUALITATIVE', allowedValues: ['MUTATION_DETECTED', 'NO_MUTATION_DETECTED', 'NOT_DONE'] },
    { code: 'IDH1', label: 'IDH1 mutation', category: 'MOLECULAR', applicability: ['AML'], resultType: 'QUALITATIVE', allowedValues: ['MUTATION_DETECTED', 'NO_MUTATION_DETECTED', 'NOT_DONE'] },
    { code: 'IDH2', label: 'IDH2 mutation', category: 'MOLECULAR', applicability: ['AML'], resultType: 'QUALITATIVE', allowedValues: ['MUTATION_DETECTED', 'NO_MUTATION_DETECTED', 'NOT_DONE'] },
    { code: 'MRD', label: 'MRD status', category: 'MOLECULAR', applicability: ['ALL', 'MM', 'AML'], resultType: 'QUALITATIVE', allowedValues: ['POSITIVE', 'NEGATIVE', 'NOT_DONE'] },
    { code: 'CYTOGENETICS', label: 'Cytogenetics (karyotype)', category: 'MOLECULAR', applicability: ['AML', 'ALL', 'MM'], resultType: 'QUALITATIVE', allowedValues: ['NORMAL_KARYOTYPE', 'ABNORMAL', 'NOT_DONE'] },
    { code: 'LDH', label: 'LDH', category: 'PROGNOSTIC', applicability: ['HL', 'NHL', 'MM'], resultType: 'QUANTITATIVE', unit: 'U/L' },
    { code: 'B2M', label: 'Beta-2 microglobulin', category: 'PROGNOSTIC', applicability: ['MM', 'CLL_SLL'], resultType: 'QUANTITATIVE', unit: 'mg/L' },
    { code: 'ALBUMIN', label: 'Albumin', category: 'PROGNOSTIC', applicability: ['MM'], resultType: 'QUANTITATIVE', unit: 'g/dL' },
    { code: 'CREATININE', label: 'Serum creatinine', category: 'LAB', applicability: ['MM', 'BREAST', 'LUNG'], resultType: 'QUANTITATIVE', unit: 'mg/dL' }
  ]);

  // ICD-O versions (canonical §10/§67): ICD-O-4 final tables released July 2026.
  // Historical coding retains its original version; mapping is stored, never rewritten.
  put('icdOVersion', [
    { code: 'ICD-O-2', label: 'ICD-O Second Edition' },
    { code: 'ICD-O-3', label: 'ICD-O Third Edition' },
    { code: 'ICD-O-3.2', label: 'ICD-O-3.2 (2024 web release)' },
    { code: 'ICD-O-4', label: 'ICD-O Fourth Edition (final tables July 2026)' }
  ]);

  put('stagingFramework', [
    { code: 'TNM_SOLID', label: 'TNM (solid tumour)' },
    { code: 'TNM_PROSTATE', label: 'TNM + PSA + Grade Group (prostate)' },
    { code: 'FIGO_CERVIX', label: 'FIGO (cervix)' },
    { code: 'FIGO_ENDOMETRIUM', label: 'FIGO (endometrium)' },
    { code: 'FIGO_OVARY', label: 'FIGO (ovary / fallopian)' },
    { code: 'LYMPHOMA', label: 'Lugano / Ann-Arbor concepts (lymphoma)' },
    { code: 'RAI_BINET', label: 'Rai / Binet (CLL/SLL)' },
    { code: 'AML_ELNCODED', label: 'WHO/ICC + ELN risk (AML)' },
    { code: 'ALL_RISK', label: 'Genetics / CNS / MRD / phase (ALL)' },
    { code: 'MM_ISS', label: 'ISS / R-ISS / R2-ISS (myeloma)' },
    { code: 'NON_TNM_CUSTOM', label: 'Non-TNM disease classification' }
  ]);

  // Directive §10 (BiomarkerMaster) complete; directive §7/§8 cascading masters:
  put('cancerFamily', [
    { code: 'BREAST_FAMILY', label: 'Breast carcinoma', site: 'BREAST' },
    { code: 'LUNG_FAMILY', label: 'Lung carcinoma', site: 'LUNG' },
    { code: 'COLORECTAL_FAMILY', label: 'Colorectal carcinoma', site: 'COLON' },
    { code: 'PROSTATE_FAMILY', label: 'Prostate carcinoma', site: 'PROSTATE' },
    { code: 'HEADNECK_FAMILY', label: 'Head & neck carcinoma', site: 'ORAL_CAVITY' },
    { code: 'GYNAECOLOGICAL_FAMILY', label: 'Gynaecological malignancy', site: 'CERVIX' },
    { code: 'HAEMATOLOGICAL_FAMILY', label: 'Haematological malignancy', site: 'BONE_MARROW' },
    { code: 'OTHER_FAMILY', label: 'Other malignancy', site: 'OTHER' }
  ]);

  put('behaviour', [
    { code: '0', label: '/0 — Benign' },
    { code: '1', label: '/1 — Uncertain whether benign or malignant' },
    { code: '2', label: '/2 — In situ' },
    { code: '3', label: '/3 — Invasive (malignant)' },
    { code: '6', label: '/6 — Metastatic' }
  ]);

  // Directive §3: master-driven diagnostic test catalogue (BiomarkerMaster-style
  // applicability + terminology, so doctors never retype free-text test names).
  put('diagnosticTest', [
    { code: 'CBC', label: 'Complete blood count', category: 'LAB', testCode: 'LA-26465-7', terminology: { system: 'LOINC', version: '2.78' }, specimenType: 'WHOLE_BLOOD' },
    { code: 'CMP', label: 'Comprehensive metabolic panel', category: 'LAB', testCode: 'LA-24323-6', terminology: { system: 'LOINC', version: '2.78' }, specimenType: 'SERUM' },
    { code: 'BETA_HCG_LAB', label: 'Beta-hCG (quantitative)', category: 'LAB', testCode: '2103-3', terminology: { system: 'LOINC', version: '2.78' }, specimenType: 'SERUM' },
    { code: 'CT_CHEST', label: 'CT chest with contrast', category: 'RADIOLOGY', testCode: 'C1376044', terminology: { system: 'SNOMED_CT', version: '20260301' } },
    { code: 'CT_ABDO_PELVIS', label: 'CT abdomen/pelvis with contrast', category: 'RADIOLOGY', testCode: 'C3604693', terminology: { system: 'SNOMED_CT', version: '20260301' } },
    { code: 'MRI_BREAST', label: 'MRI breast bilateral', category: 'RADIOLOGY', testCode: 'C1272708', terminology: { system: 'SNOMED_CT', version: '20260301' } },
    { code: 'PET_CT_STAGING', label: 'PET-CT whole body staging', category: 'RADIOLOGY', testCode: 'C1432268', terminology: { system: 'SNOMED_CT', version: '20260301' } },
    { code: 'US_BREAST', label: 'Ultrasound breast', category: 'RADIOLOGY', testCode: 'C1293959', terminology: { system: 'SNOMED_CT', version: '20260301' } },
    { code: 'CORE_BIOPSY_BREAST', label: 'Core biopsy breast', category: 'PATHOLOGY', testCode: 'C1514291', terminology: { system: 'SNOMED_CT', version: '20260301' }, specimenType: 'BREAST_TISSUE' },
    { code: 'CX_BIOPSY_LUNG', label: 'Core biopsy lung', category: 'PATHOLOGY', testCode: 'C1514291', terminology: { system: 'SNOMED_CT', version: '20260301' }, specimenType: 'LUNG_TISSUE' },
    { code: 'BM_ASPIRATE_TREPHINE', label: 'Bone marrow aspirate & trephine', category: 'PATHOLOGY', testCode: 'C1266977', terminology: { system: 'SNOMED_CT', version: '20260301' }, specimenType: 'BONE_MARROW' },
    { code: 'LYMPH_NODE_EXCISION', label: 'Lymph node excision biopsy', category: 'PATHOLOGY', testCode: 'C1514291', terminology: { system: 'SNOMED_CT', version: '20260301' }, specimenType: 'LYMPH_NODE' },
    { code: 'NGS_SOLID_PANEL', label: 'Solid tumour NGS panel', category: 'MOLECULAR', testCode: 'LA-26381-4', terminology: { system: 'LOINC', version: '2.78' }, specimenType: 'FFPE_TISSUE' },
    { code: 'HER2_ISH', label: 'HER2 dual-probe ISH', category: 'MOLECULAR', testCode: '18474-7', terminology: { system: 'LOINC', version: '2.78' }, specimenType: 'FFPE_TISSUE' },
    { code: 'PDL1_IHC_22C3', label: 'PD-L1 IHC 22C3 pharmDx', category: 'MOLECULAR', testCode: '84483-7', terminology: { system: 'LOINC', version: '2.78' }, specimenType: 'FFPE_TISSUE' },
    { code: 'CYTOLOGY_FNA', label: 'Fine needle aspirate cytology', category: 'CYTOLOGY', testCode: 'C1321233', terminology: { system: 'SNOMED_CT', version: '20260301' }, specimenType: 'FNA_ASPIRATE' }
  ]);

  // Neutral T/N/M value sets (prefix + category only — no AJCC tables shipped)
  put('t', [
    { code: 'TX', label: 'TX' }, { code: 'T0', label: 'T0' }, { code: 'Tis', label: 'Tis' },
    { code: 'T1', label: 'T1' }, { code: 'T1a', label: 'T1a' }, { code: 'T1b', label: 'T1b' },
    { code: 'T1c', label: 'T1c' }, { code: 'T2', label: 'T2' }, { code: 'T3', label: 'T3' },
    { code: 'T4', label: 'T4' }, { code: 'T4a', label: 'T4a' }, { code: 'T4b', label: 'T4b' }
  ]);
  put('n', [
    { code: 'NX', label: 'NX' }, { code: 'N0', label: 'N0' },
    { code: 'N1', label: 'N1' }, { code: 'N1mi', label: 'N1mi' },
    { code: 'N2', label: 'N2' }, { code: 'N2a', label: 'N2a' },
    { code: 'N3', label: 'N3' }, { code: 'N3a', label: 'N3a' }, { code: 'N3b', label: 'N3b' }, { code: 'N3c', label: 'N3c' }
  ]);
  // §7: MX is INVALID under current AJCC rules — no MX option exists in masters,
  // frontend, validation or imports. Legacy MX data may only be imported as
  // flagged historical source data for reconciliation (never as a live option).
  put('m', [
    { code: 'M0', label: 'M0' },
    { code: 'M0(i+)', label: 'M0(i+)' }, { code: 'M1', label: 'M1' }, { code: 'M1a', label: 'M1a' }, { code: 'M1b', label: 'M1b' }, { code: 'M1c', label: 'M1c' }
  ]);

  put('stageClassification', [
    { code: 'STAGE_0', label: 'Stage 0' },
    { code: 'STAGE_I', label: 'Stage I' }, { code: 'STAGE_IA', label: 'Stage IA' }, { code: 'STAGE_IB', label: 'Stage IB' },
    { code: 'STAGE_II', label: 'Stage II' }, { code: 'STAGE_IIA', label: 'Stage IIA' }, { code: 'STAGE_IIB', label: 'Stage IIB' }, { code: 'STAGE_IIC', label: 'Stage IIC' },
    { code: 'STAGE_III', label: 'Stage III' }, { code: 'STAGE_IIIA', label: 'Stage IIIA' }, { code: 'STAGE_IIIB', label: 'Stage IIIB' }, { code: 'STAGE_IIIC', label: 'Stage IIIC' },
    { code: 'STAGE_IV', label: 'Stage IV' }, { code: 'STAGE_IVA', label: 'Stage IVA' }, { code: 'STAGE_IVB', label: 'Stage IVB' },
    { code: 'LIMITED', label: 'Limited stage' }, { code: 'EXTENSIVE', label: 'Extensive stage' },
    { code: 'I_RAI', label: 'Rai stage I' }, { code: 'II_RAI', label: 'Rai stage II' }, { code: 'III_RAI', label: 'Rai stage III' }, { code: 'IV_RAI', label: 'Rai stage IV' },
    { code: 'A_BINET', label: 'Binet A' }, { code: 'B_BINET', label: 'Binet B' }, { code: 'C_BINET', label: 'Binet C' },
    { code: 'ELN_LOW', label: 'ELN low risk' }, { code: 'ELN_INT', label: 'ELN intermediate risk' }, { code: 'ELN_HIGH', label: 'ELN high risk' },
    { code: 'ALL_STD', label: 'Standard risk' }, { code: 'ALL_HIGH', label: 'High risk' }, { code: 'ALL_VHIGH', label: 'Very high risk' },
    { code: 'ISS_I', label: 'ISS stage I' }, { code: 'ISS_II', label: 'ISS stage II' }, { code: 'ISS_III', label: 'ISS stage III' },
    { code: 'RISS_I', label: 'R-ISS stage I' }, { code: 'RISS_II', label: 'R-ISS stage II' }, { code: 'RISS_III', label: 'R-ISS stage III' },
    { code: 'CUSTOM', label: 'Classification per authority (see provider)' }
  ]);

  put('treatmentIntent', [
    { code: 'CURATIVE', label: 'Curative' },
    { code: 'PALLIATIVE_SYSTEMIC', label: 'Palliative systemic therapy' },
    { code: 'PALLIATION_ONLY', label: 'Palliation only' },
    { code: 'ADJUVANT', label: 'Adjuvant' },
    { code: 'NEOADJUVANT', label: 'Neoadjuvant' }
  ]);

  put('lineOfTherapy', [
    { code: 'L1', label: '1st line' }, { code: 'L2', label: '2nd line' },
    { code: 'L3', label: '3rd line' }, { code: 'L4', label: '4th line' },
    { code: 'L5_PLUS', label: '5th line or beyond' }, { code: 'MAINT', label: 'Maintenance' }
  ]);

  put('medication', [
    { code: 'DOXORUBICIN', label: 'Doxorubicin' },
    { code: 'CYCLOPHOSPHAMIDE', label: 'Cyclophosphamide' },
    { code: 'PACLITAXEL', label: 'Paclitaxel' },
    { code: 'CARBOPLATIN', label: 'Carboplatin' },
    { code: 'CISPLATIN', label: 'Cisplatin' },
    { code: '5FU', label: '5-Fluorouracil' },
    { code: 'LEUCOVORIN', label: 'Leucovorin' },
    { code: 'OXALIPLATIN', label: 'Oxaliplatin' },
    { code: 'DOCETAXEL', label: 'Docetaxel' },
    { code: 'TRASTUZUMAB', label: 'Trastuzumab' },
    { code: 'RITUXIMAB', label: 'Rituximab' },
    { code: 'VINCRISTINE', label: 'Vincristine' },
    { code: 'CYTARABINE', label: 'Cytarabine' },
    { code: 'IMATINIB', label: 'Imatinib' },
    { code: 'ONDANSETRON', label: 'Ondansetron' },
    { code: 'DEXAMETHASONE', label: 'Dexamethasone' },
    { code: 'PALONOSETRON', label: 'Palonosetron' },
    { code: 'APREPITANT', label: 'Aprepitant' },
    { code: 'GCSF', label: 'G-CSF (filgrastim)' },
    { code: 'MESNA', label: 'Mesna' },
    { code: 'NS0900', label: 'Sodium chloride 0.9% (1L)' },
    { code: 'NS0900_500', label: 'Sodium chloride 0.9% (500mL)' },
    { code: 'MANITOL', label: 'Mannitol' }
  ]);

  put('route', [
    { code: 'IV', label: 'Intravenous' },
    { code: 'IV_PUSH', label: 'Intravenous push' },
    { code: 'ORAL', label: 'Oral' },
    { code: 'SC', label: 'Subcutaneous' },
    { code: 'IM', label: 'Intramuscular' },
    { code: 'INTRATHECAL', label: 'Intrathecal' },
    { code: 'TOPICAL', label: 'Topical' }
  ]);

  put('diluent', [
    { code: 'NS', label: '0.9% Sodium chloride' },
    { code: 'D5W', label: '5% Dextrose in water' },
    { code: 'SWFI', label: 'Sterile water for injection' },
    { code: 'NONE', label: 'No dilution' }
  ]);

  put('schedule', [
    { code: 'Q1W', label: 'Weekly' },
    { code: 'Q2W', label: 'Every 2 weeks' },
    { code: 'Q3W', label: 'Every 3 weeks (21-day cycle)' },
    { code: 'Q4W', label: 'Every 4 weeks (28-day cycle)' },
    { code: 'D1_ONLY', label: 'Day 1 only' },
    { code: 'D1_D8', label: 'Days 1 and 8' },
    { code: 'D1_D2', label: 'Days 1 and 2' }
  ]);

  // CTCAE versions (canonical §39/§66): v6.0 (July 2025, MedDRA 28.0) is the
  // current version for NEW assessments; historical records keep their version.
  put('toxicityVersion', [
    { code: 'CTCAE_V5', label: 'CTCAE v5.0 (2017)' },
    { code: 'CTCAE_V6', label: 'CTCAE v6.0 (July 2025, MedDRA 28.0) — current for new assessments' }
  ]);

  put('toxicity', [
    { code: 'NEUTROPENIA', label: 'Neutropenia' },
    { code: 'FN', label: 'Febrile neutropenia' },
    { code: 'ANAEMIA', label: 'Anaemia' },
    { code: 'THROMBOCYTOPENIA', label: 'Thrombocytopenia' },
    { code: 'NAUSEA', label: 'Nausea' },
    { code: 'VOMITING', label: 'Vomiting' },
    { code: 'DIARRHOEA', label: 'Diarrhoea' },
    { code: 'MUCOSITIS', label: 'Mucositis' },
    { code: 'NEUROPATHY', label: 'Peripheral neuropathy' },
    { code: 'FATIGUE', label: 'Fatigue' },
    { code: 'ALOPECIA', label: 'Alopecia' },
    { code: 'RASH', label: 'Rash' },
    { code: 'HFS', label: 'Hand-foot syndrome' },
    { code: 'INFUSION_REACTION', label: 'Infusion reaction' },
    { code: 'CARDIOTOX', label: 'Cardiotoxicity (LVEF decline)' },
    { code: 'HEPATOTOX', label: 'Hepatotoxicity' },
    { code: 'NEPHROTOX', label: 'Nephrotoxicity' },
    { code: 'INFECTION', label: 'Infection' },
    { code: 'OTHER', label: 'Other' }
  ]);

  put('response', [
    { code: 'CR', label: 'Complete response' },
    { code: 'PR', label: 'Partial response' },
    { code: 'SD', label: 'Stable disease' },
    { code: 'PD', label: 'Progressive disease' },
    { code: 'RECURRENT', label: 'Recurrence' },
    { code: 'NOT_EVALUABLE', label: 'Not evaluable' }
  ]);

  store.persist();
  return d.masters;
}

function getMaster(name) {
  const d = store.getDb();
  return d.masters[name] || [];
}

function getByCode(name, code) {
  return getMaster(name).find(i => i.code === code) || null;
}

function label(name, code) {
  if (!code) return '';
  const item = getByCode(name, code);
  return item ? item.label : String(code);
}

function listMasters() {
  const d = store.getDb();
  return Object.keys(d.masters).map(k => ({ name: k, count: d.masters[k].length }));
}

// Terminology coding helpers (canonical §52): store code+system+version+display,
// never just labels.
function addMasterItem(name, item, actor) {
  gateMasterName(name);
  wf.gate(!item || !item.code || !item.label, 'STOP_GATE: master item requires code and label');
  if (item.coding) validateCoding(item.coding);
  const d = store.getDb();
  d.masters[name].push({
    id: uuid(), code: item.code, label: item.label,
    parent: item.parent || null, category: item.category || null,
    applicability: item.applicability || null, coding: item.coding || null,
    testCode: item.testCode || null,          // diagnosticTest: canonical test code
    terminology: item.terminology || null,    // diagnosticTest: {system, version}
    specimenType: item.specimenType || null,  // diagnosticTest: required specimen
    resultType: item.resultType || null,      // diagnosticTest/biomarker: QUALITATIVE|QUANTITATIVE|BOTH
    allowedValues: item.allowedValues || null,// biomarker: permitted qualitative values
    unit: item.unit || null,                  // biomarker: quantitative unit
    active: true
  });
  store.persist();
  store.audit(actor, 'MASTER_ADD', 'master:' + name, item.code, item.label);
  return item;
}

function gateMasterName(name) {
  wf.gate(!MASTER_KEYS.includes(name), 'STOP_GATE: unknown master ' + name);
}

function validateCoding(coding) {
  wf.gate(typeof coding !== 'object', 'STOP_GATE: coding must be an object');
  for (const req of ['code', 'system']) {
    wf.gate(!coding[req], 'STOP_GATE: coding.' + req + ' is required');
  }
  wf.gate(coding.system !== 'SNOMED_CT' && coding.system !== 'LOINC' && coding.system !== 'ICD10' && coding.system !== 'ICD_O', 'STOP_GATE: coding.system must be SNOMED_CT, LOINC, ICD10 or ICD_O');
}

// Terminology validation for clinical entries (SNOMED-first; canonical §52)
// Governed codes are validated via master lookup at the field level (validateDiagnosisFields).

// Biomarker applicability lookup (canonical §11): which markers apply to a disease
function biomarkersFor(cancerType) {
  return getMaster('biomarker').filter(b => b.active && b.applicability && b.applicability.includes(cancerType));
}

function icdOVersionValid(versionCode) {
  return !!getByCode('icdOVersion', versionCode);
}

function retireMasterItem(name, id, actor) {
  const d = store.getDb();
  const item = (d.masters[name] || []).find(i => i.id === id);
  wf.gate(!item, 'STOP_GATE: master item not found');
  item.active = false;
  store.persist();
  store.audit(actor, 'MASTER_RETIRE', 'master:' + name, item.code, item.label);
  return item;
}

module.exports = { MASTER_KEYS, seedMasters, getMaster, getByCode, label, listMasters, addMasterItem, retireMasterItem, uuid, biomarkersFor, icdOVersionValid, validateCoding, gateMasterName };
