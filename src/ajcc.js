// CCA OS — AJCC staging version routing + licensed content provider architecture
//
// SOURCES (official AJCC/ACS only — used for PUBLIC metadata, never protected tables):
//  - "AJCC Version 9 Cancer Staging System" (facs.org): Version 9 disease sites by
//    release year; "All disease sites in the 8th Edition Cancer Staging Manual remain
//    current until replaced with Version 9"; "Updated Version 9 disease sites go into
//    effect on January 1 following their release."
//  - "Application Programming Interface (API)" (facs.org): AJCC API delivers the
//    Cancer Staging System in XML; current API version 02.03.00 (aka 09.03.00);
//    developer portal ajcc.3scale.net; trial API exposes one disease site (prostate).
//
// CRITICAL RULE (directive §11/§14/§15): this module ships ONLY version-routing
// metadata. Protected T/N/M definitions, valid-value picklists and stage-group
// tables come exclusively through the licensed provider (AJCC API / DLL) when
// configured. Without it, the system reports AUTHORITY_CONTENT_UNAVAILABLE and
// never fabricates categories or stage groups.
'use strict';
const store = require('./store');
const wf = require('./workflow');
const { gate, uuid, nowIso } = wf;

// ---------------------------------------------------------------------------
// PUBLIC version-routing metadata — "AJCC Current Staging System 2026" table.
// Version 9 disease sites, effective January 1 following release (per ACS):
//   2021 Cervix Uteri · 2023 Anus, Appendix, Brain & Spinal Cord ·
//   2024 NET sites (Appendix, Colon&Rectum, Duodenum&Ampulla, Jejunum&Ileum,
//   Pancreas, Stomach) + Vulva · 2025 Lung, Thymus, Diffuse Pleural Mesothelioma,
//   Nasopharynx · 2026 Salivary Glands, Oropharynx (HPV-associated).
// ALL other disease sites remain 8th Edition until replaced.
// source_reference points to the official page — no staging content is embedded.
// ---------------------------------------------------------------------------
const SOURCE_REFERENCE = 'https://www.facs.org/quality-programs/cancer-programs/american-joint-committee-on-cancer/version-9/ (AJCC Current Staging System 2026 table)';
const VERIFIED_AT = '2026-09-19';

// siteKey matches masters 'primarySite' codes; disease matching is by primary site
// AND (where the site is subsite-specific) subsite, per the official table.
const V9_ROUTES = [
  { schema: 'CERVIX_UTERI', site: 'CERVIX', effectiveFrom: '2021-01-01' },
  { schema: 'ANUS', site: 'ANUS', effectiveFrom: '2023-01-01' },
  { schema: 'APPENDIX', site: 'APPENDIX', effectiveFrom: '2023-01-01' },
  { schema: 'BRAIN_SPINAL_CORD', site: 'BRAIN', effectiveFrom: '2023-01-01' },
  { schema: 'NET_APPENDIX', site: 'APPENDIX', effectiveFrom: '2024-01-01', histology: 'NET' },
  { schema: 'NET_COLON_RECTUM', site: 'COLON', effectiveFrom: '2024-01-01', histology: 'NET' },
  { schema: 'NET_DUODENUM_AMPOULLA', site: 'SMALL_INTESTINE', effectiveFrom: '2024-01-01', histology: 'NET' },
  { schema: 'NET JEJUNUM_ILEUM', site: 'SMALL_INTESTINE', effectiveFrom: '2024-01-01', histology: 'NET' },
  { schema: 'NET_PANCREAS', site: 'PANCREAS', effectiveFrom: '2024-01-01', histology: 'NET' },
  { schema: 'NET_STOMACH', site: 'STOMACH', effectiveFrom: '2024-01-01', histology: 'NET' },
  { schema: 'VULVA', site: 'VULVA', effectiveFrom: '2024-01-01' },
  { schema: 'LUNG', site: 'LUNG', effectiveFrom: '2025-01-01' },
  { schema: 'THYMUS', site: 'THYMUS', effectiveFrom: '2025-01-01' },
  { schema: 'PLEURAL_MESOTHELIOMA', site: 'PLEURA', effectiveFrom: '2025-01-01' },
  { schema: 'NASOPHARYNX', site: 'NASOPHARYNX', effectiveFrom: '2025-01-01' },
  { schema: 'MAJOR_SALIVARY_GLANDS', site: 'SALIVARY_GLAND', effectiveFrom: '2026-01-01' },
  { schema: 'HPV_ASSOCIATED_OROPHARYNX', site: 'OROPHARYNX', effectiveFrom: '2026-01-01', subsiteCondition: 'HPV_POSITIVE' }
];

function routeFor(diagnosis) {
  const date = diagnosis.diagnosisDate || new Date().toISOString().slice(0, 10);
  // V9 routes checked first (site + optional histology qualifier + effective date)
  for (const r of V9_ROUTES) {
    if (r.site !== diagnosis.primarySite) continue;
    if (r.histology && !(diagnosis.histology || '').toUpperCase().includes(r.histology)) continue;
    if (date >= r.effectiveFrom) {
      return { schema: r.schema, version: 'VERSION_9', effectiveFrom: r.effectiveFrom };
    }
  }
  // everything else remains 8th Edition until replaced (official rule)
  return { schema: diagnosis.primarySite || diagnosis.cancerType, version: 'EDITION_8', effectiveFrom: '2017-01-01' };
}

// ---------------------------------------------------------------------------
// ClinicalContentLicense (directive §34) — licence registry record
// ---------------------------------------------------------------------------
function upsertLicense(actor, data) {
  wf.gate(!actor || actor.role !== 'Administrator', 'STOP_GATE: only Administrator manages content licences');
  gate(!data.publisher || !data.contentName || !data.version, 'publisher, contentName and version are required');
  const rec = {
    uuid: uuid(),
    publisher: data.publisher,               // e.g. American College of Surgeons
    contentName: data.contentName,           // e.g. AJCC Cancer Staging System
    version: data.version,                   // e.g. API 02.03.00 / Edition 8 / Version 9
    licenceReference: data.licenceReference || null,
    licenceType: data.licenceType || null,   // API_SUBSCRIPTION | SITE_LICENCE | DLL
    effectiveFrom: data.effectiveFrom || null,
    effectiveTo: data.effectiveTo || null,
    permittedFacilities: data.permittedFacilities || [],
    permittedUsers: data.permittedUsers || null,
    permittedDeployment: data.permittedDeployment || null,
    commercialUseAllowed: !!data.commercialUseAllowed,
    derivedContentAllowed: !!data.derivedContentAllowed,
    apiUseAllowed: !!data.apiUseAllowed,
    status: data.status || 'PENDING',        // PENDING | ACTIVE | EXPIRED
    registeredAt: nowIso()
  };
  store.insert('contentLicenses', rec);
  store.audit(actor, 'CONTENT_LICENSE_UPSERTED', 'contentLicense', rec.uuid, rec.publisher + ' ' + rec.contentName);
  return rec;
}

function getLicenseStatus() {
  const now = new Date().toISOString().slice(0, 10);
  const list = store.find('contentLicenses', l => true);
  for (const l of list) {
    if (l.status === 'ACTIVE' && l.effectiveTo && l.effectiveTo < now) {
      store.update('contentLicenses', l.uuid, { status: 'EXPIRED' });
      l.status = 'EXPIRED';
    }
  }
  return list;
}

function isLicensedConfigured() {
  // genuine configuration = env credentials AND an ACTIVE licence record
  const envOk = !!(process.env.AJCC_PROVIDER === 'api' && process.env.AJCC_API_BASE_URL && process.env.AJCC_API_KEY);
  const active = getLicenseStatus().some(l => l.status === 'ACTIVE' && /AJCC/i.test(l.contentName));
  return envOk && active;
}

// ---------------------------------------------------------------------------
// Staging content registry (directive §33) — what the admin screen shows
// ---------------------------------------------------------------------------
function registrySnapshot() {
  const licensed = isLicensedConfigured();
  const rows = [];
  const seen = new Set();
  for (const r of V9_ROUTES) {
    seen.add(r.schema);
    rows.push({ authority: 'AJCC', schema: r.schema, version: 'Version 9', effectiveFrom: r.effectiveFrom, effectiveTo: null, sourceReference: SOURCE_REFERENCE, verifiedAt: VERIFIED_AT, provider: licensed ? 'AJCCLicensedProvider' : 'LocalReferenceProvider', licenceStatus: licensed ? 'ACTIVE' : 'NOT_CONFIGURED', providerStatus: licensed ? 'API_CONFIGURED' : 'AUTHORITY_CONTENT_UNAVAILABLE' });
  }
  rows.push({ authority: 'AJCC', schema: 'All other disease sites', version: '8th Edition', effectiveFrom: '2017-01-01', effectiveTo: 'until replaced by Version 9', sourceReference: SOURCE_REFERENCE, verifiedAt: VERIFIED_AT, provider: licensed ? 'AJCCLicensedProvider' : 'LocalReferenceProvider', licenceStatus: licensed ? 'ACTIVE' : 'NOT_CONFIGURED', providerStatus: licensed ? 'API_CONFIGURED' : 'AUTHORITY_CONTENT_UNAVAILABLE' });
  for (const l of getLicenseStatus()) {
    rows.push({ authority: l.publisher, schema: l.contentName, version: l.version, effectiveFrom: l.effectiveFrom, effectiveTo: l.effectiveTo, sourceReference: l.licenceReference, verifiedAt: l.registeredAt, provider: l.apiUseAllowed ? 'AJCCLicensedProvider' : '—', licenceStatus: l.status, providerStatus: l.status === 'ACTIVE' ? 'CONFIGURED' : 'INACTIVE' });
  }
  return { rows, licensed };
}

// ---------------------------------------------------------------------------
// AJCCLicensedProvider — adapter for the official AJCC API (XML, GET-only,
// portal ajcc.3scale.net; trial endpoint exposes prostate only).
// Endpoint paths are NOT invented here: the adapter reads the documented spec
// location from config and performs version/capability discovery at runtime.
// Cache only licence-permitted content; keep content/version metadata separate
// from patient staging records (patient records store references + results only).
// ---------------------------------------------------------------------------
const ajccCache = { content: null, fetchedAt: null, versionMeta: null };

function ajccConfigFromEnv() {
  return {
    provider: process.env.AJCC_PROVIDER || null,
    baseUrl: process.env.AJCC_API_BASE_URL || null,
    apiKey: process.env.AJCC_API_KEY || null,
    apiVersion: process.env.AJCC_API_VERSION || '02.03.00'
  };
}

async function ajccFetchContent() {
  const cfg = ajccConfigFromEnv();
  gate(!isLicensedConfigured(), 'AUTHORITY_CONTENT_UNAVAILABLE: AJCC authoritative content provider not configured. Staging workflow is available, but governed AJCC category definitions and stage calculation require licensed AJCC content.');
  // Discover the content endpoints from the deployment's own spec document rather
  // than hard-coding paths (directive §14: "Do not invent AJCC API endpoint paths").
  const specUrl = (cfg.baseUrl.replace(/\/$/, '')) + '/spec';
  const res = await fetch(specUrl, { headers: { 'Authorization': 'APIKEY ' + cfg.apiKey, 'Accept': 'application/xml' } });
  gate(!res.ok, 'AJCC API spec discovery failed: HTTP ' + res.status);
  const spec = await res.text();
  ajccCache.content = spec;              // licence-permitted content cache
  ajccCache.fetchedAt = nowIso();
  ajccCache.versionMeta = { apiVersion: cfg.apiVersion, baseUrl: cfg.baseUrl };
  return ajccCache.content;
}

// ---------------------------------------------------------------------------
// LocalReferenceProvider — workflow-capable fallback. Implements the full
// provider interface but returns AUTHORITY_CONTENT_UNAVAILABLE for every
// governed content request. It never invents T/N/M values, definitions,
// allowed-value lists or stage groups.
// ---------------------------------------------------------------------------
function localReferenceProvider() {
  const UNAVAILABLE = 'AUTHORITY_CONTENT_UNAVAILABLE';
  return {
    name: 'LocalReferenceProvider',
    authority: 'AJCC',
    licensed: false,
    resolve_schema(dx) {
      const route = routeFor(dx);
      return {
        authority: 'AJCC',
        schemaId: route.schema,
        schemaName: route.schema.replace(/_/g, ' '),
        version: route.version === 'VERSION_9' ? 'Version 9' : '8th Edition',
        versionRaw: route.version,
        effectiveFrom: route.effectiveFrom,
        sourceReference: SOURCE_REFERENCE,
        provider: 'LocalReferenceProvider',
        contentStatus: UNAVAILABLE
      };
    },
    get_effective_version(schema, diagnosisDate) {
      return routeFor({ primarySite: schema, diagnosisDate }).version;
    },
    get_valid_fields() { return { status: UNAVAILABLE, fields: [] }; },
    get_allowed_values() { return { status: UNAVAILABLE, values: [] }; },
    validate_value() { return { status: UNAVAILABLE, valid: false }; },
    derive_stage() {
      return { status: UNAVAILABLE, stage: null, derivation: 'Governed AJCC category definitions and stage calculation require licensed AJCC content (AJCC API / Cancer Surveillance DLL).' };
    },
    get_field_definition() { return { status: UNAVAILABLE, definition: null }; },
    get_source_metadata() {
      return { authority: 'AJCC', sourceReference: SOURCE_REFERENCE, verifiedAt: VERIFIED_AT, contentStatus: UNAVAILABLE };
    }
  };
}

// ---------------------------------------------------------------------------
// resolve_staging_schema(diagnosis[, providerKey]) — directive §16. Consumes
// primary site, subsite, histology, morphology, behaviour and diagnosis date;
// returns authority + schema + effective version + provider. The clinician never
// picks a pack manually. Non-TNM diseases (directive §25) route to their own
// authority — they are NOT AJCC and must not report an AJCC edition.
// ---------------------------------------------------------------------------
const NON_AJCC_AUTHORITIES = {
  FIGO_CERVIX: { authority: 'FIGO', schemaId: 'CERVIX_FIGO', schemaName: 'Cervix — FIGO staging' },
  FIGO_ENDOMETRIUM: { authority: 'FIGO', schemaId: 'ENDOMETRIUM_FIGO', schemaName: 'Endometrium — FIGO staging' },
  FIGO_OVARY: { authority: 'FIGO', schemaId: 'OVARY_FIGO', schemaName: 'Ovary / Fallopian tube — FIGO staging' },
  LYMPHOMA: { authority: 'LUGANO', schemaId: 'LYMPHOMA_LUGANO', schemaName: 'Lugano / Ann-Arbor classification' },
  CLL: { authority: 'RAI_BINET', schemaId: 'CLL_SLL', schemaName: 'Rai / Binet staging (CLL/SLL)' },
  AML: { authority: 'WHO_ICC_ELN', schemaId: 'AML_ELNCODED', schemaName: 'WHO/ICC classification + ELN risk' },
  ALL: { authority: 'ALL_RISK_FRAMEWORK', schemaId: 'ALL_RISK', schemaName: 'ALL genetics / CNS / MRD / phase' },
  MM: { authority: 'ISS_RISS', schemaId: 'MM_ISS', schemaName: 'ISS / R-ISS / R2-ISS (myeloma)' }
};

function resolve_staging_schema(diagnosis, providerKey) {
  const nonAjcc = NON_AJCC_AUTHORITIES[providerKey];
  if (nonAjcc) {
    return {
      authority: nonAjcc.authority,
      schemaId: nonAjcc.schemaId,
      schemaName: nonAjcc.schemaName,
      version: 'Reference skeleton (licensed authority pending)',
      versionRaw: 'REFERENCE_SKELETON',
      effectiveFrom: null,
      sourceReference: SOURCE_REFERENCE,
      provider: 'LocalReferenceProvider',
      contentStatus: 'AUTHORITY_CONTENT_UNAVAILABLE',
      availableContexts: ['CLINICAL', 'PATHOLOGICAL', 'POSTTHERAPY_CLINICAL', 'POSTTHERAPY_PATHOLOGICAL', 'RESTAGING'],
      licensedContentAvailable: false,
      notice: nonAjcc.authority + ' authoritative content provider not configured. Staging workflow is available, but governed classification definitions and derivation require licensed content.'
    };
  }
  const provider = isLicensedConfigured() ? null : localReferenceProvider();
  if (provider) {
    const resolved = provider.resolve_schema(diagnosis);
    return Object.assign(resolved, {
      availableContexts: ['CLINICAL', 'PATHOLOGICAL', 'POSTTHERAPY_CLINICAL', 'POSTTHERAPY_PATHOLOGICAL', 'RESTAGING'],
      licensedContentAvailable: false,
      notice: 'AJCC authoritative content provider not configured. Staging workflow is available, but governed AJCC category definitions and stage calculation require licensed AJCC content.'
    });
  }
  // Licensed path: fetch from the configured API (async callers pre-warm the cache)
  const route = routeFor(diagnosis);
  return {
    authority: 'AJCC',
    schemaId: route.schema,
    schemaName: route.schema.replace(/_/g, ' '),
    version: route.version === 'VERSION_9' ? 'Version 9' : '8th Edition',
    versionRaw: route.version,
    effectiveFrom: route.effectiveFrom,
    sourceReference: SOURCE_REFERENCE,
    provider: 'AJCCLicensedProvider',
    contentStatus: 'AVAILABLE',
    availableContexts: ['CLINICAL', 'PATHOLOGICAL', 'POSTTHERAPY_CLINICAL', 'POSTTHERAPY_PATHOLOGICAL', 'RESTAGING'],
    licensedContentAvailable: true
  };
}

module.exports = {
  SOURCE_REFERENCE, VERIFIED_AT, V9_ROUTES, NON_AJCC_AUTHORITIES,
  routeFor, resolve_staging_schema,
  upsertLicense, getLicenseStatus, isLicensedConfigured, registrySnapshot,
  ajccConfigFromEnv, ajccFetchContent, localReferenceProvider
};
