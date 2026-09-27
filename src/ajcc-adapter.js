// CCA OS — Licensed AJCC adapter (proof-of-concept)
//
// CONTRACT: given configured AJCC API credentials (AJCC_PROVIDER=api,
// AJCC_API_BASE_URL, AJCC_API_KEY — the same configuration ajcc.isLicensedConfigured()
// already honours, plus an ACTIVE licence record), the adapter fetches AJCC disease
// content from the licensed API, VALIDATES it into the engine's declarative rule
// vocabulary, and registers it as an engine content pack. Derivation itself then
// runs through the existing deterministic engine and the existing sign gate —
// this module adds no derivation logic and no new gate semantics.
//
// WHAT IS NOT DONE HERE (licence scope): this PoC does not invent endpoint paths
// or decode protected AJCC tables. The wire format is discovered from the
// deployment's own spec (same discipline as ajcc.ajccFetchContent); the mapping
// layer below understands one documented shape — the engine's content-pack rules
// object — and fails closed on anything else. A production deployment supplies
// the licensed converter for its contracted AJCC API response shape.
//
// FAIL-CLOSED: no credential/licence configuration → CCA_AJCC_NOT_CONFIGURED
// (checked before any transport runs, injected or real). Unreachable API, non-OK
// status, or content failing engine pack validation → CCA_AJCC_FETCH_FAILED with
// the reason; the registry is never mutated on failure.
'use strict';
const engine = require('./staging-engine');
const ajcc = require('./ajcc');
const rbac = require('./rbac');
const wf = require('./workflow');
const { gate } = wf;

const NOT_CONFIGURED = 'CCA_AJCC_NOT_CONFIGURED: AJCC API credentials/licence are not configured — licensed derivation is unavailable.';
const FETCH_FAILED = 'CCA_AJCC_FETCH_FAILED: the AJCC API content could not be loaded';

// Transport: fetches the licensed content document from the configured API,
// discovering the content location from the deployment's own spec document
// (directive §14: endpoint paths are never invented here). Injectable in tests
// via connectLicensedAjcc({ fetchContent }).
async function fetchLicensedContent() {
  const cfg = ajcc.ajccConfigFromEnv();
  const specUrl = cfg.baseUrl.replace(/\/$/, '') + '/spec';
  let res;
  try {
    res = await fetch(specUrl, {
      headers: { 'Authorization': 'APIKEY ' + cfg.apiKey, 'Accept': 'application/xml' }
    });
  } catch (e) {
    // connection refused, DNS failure, TLS abort — node surfaces these as raw
    // fetch errors; they must carry the documented fail-closed vocabulary.
    throw new Error(FETCH_FAILED + ' — ' + specUrl + ' unreachable: ' + (e.cause ? e.cause.message || e.cause : e.message));
  }
  gate(!res.ok, FETCH_FAILED + ' — spec discovery: HTTP ' + res.status);
  try {
    return await res.text();
  } catch (e) {
    throw new Error(FETCH_FAILED + ' — response body could not be read: ' + e.message);
  }
}

// Maps the licensed content document into engine content-pack rules. PoC mapping:
// the payload IS the content-pack rules object (packId/authority/providerKey/
// schemaId/version/effectiveFrom/provenance/classifications/categoryRules).
// Licensed content is protected by default: rule text is hidden from UI traces
// (§28) and the provenance is stamped so trace/admin/audit all report the source.
function mapToPack(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error(FETCH_FAILED + ' — content is not a JSON object');
  }
  content.provenance = 'Licensed AJCC API content — API ' + (ajcc.ajccConfigFromEnv().apiVersion) + '. ' + (content.provenance || '');
  content.proprietary = content.proprietary !== false;
  return content;
}

// Full adapter round-trip: authorization → credentials → fetch → parse → map →
// engine validation → register. Returns the ACTIVE registered pack summary;
// throws CCA_AJCC_* on any failure, leaving the registry untouched.
async function connectLicensedAjcc(options) {
  const opts = options || {};
  if (opts.actor) rbac.assertCanWrite(opts.actor, 'connectLicensedAjcc');
  gate(!ajcc.isLicensedConfigured(), NOT_CONFIGURED);
  const doc = opts.fetchContent ? await opts.fetchContent() : await fetchLicensedContent();
  let content;
  try {
    content = typeof doc === 'string' ? JSON.parse(doc) : doc;
  } catch (e) {
    throw new Error(FETCH_FAILED + ' — content is not valid JSON: ' + e.message);
  }
  const pack = mapToPack(content);
  const { validatePack } = require('./staging-packs');
  const validation = validatePack(pack);
  if (!validation.ok) {
    throw new Error(FETCH_FAILED + ' — content rejected by pack validation: ' + validation.errors.join(' | '));
  }
  try {
    engine.registerPack(pack, { source: 'LICENSED_AJCC_API' });
  } catch (e) {
    throw new Error(FETCH_FAILED + ' — engine registration refused: ' + e.message);
  }
  try {
    require('./store').audit(opts.actor || { uuid: 'system', name: 'System', role: 'Administrator' },
      'LICENSED_AJCC_PACK_CONNECTED', 'stagingContentPack', pack.packId, 'licensed AJCC content pack registered from API');
  } catch (e) { /* audit must never break the connection flow */ }
  const row = engine.packsSnapshot().find(p => p.packId === pack.packId);
  return Object.assign({ connected: true }, row);
}

// Connection status for the admin screen: credential/licence state and which
// disease schemas have licensed derivation connected.
function statusSnapshot() {
  const packs = engine.packsSnapshot().filter(p => p.source === 'LICENSED_AJCC_API' && p.status === 'ACTIVE');
  return {
    configured: ajcc.isLicensedConfigured(),
    credentialsPresent: !!(process.env.AJCC_PROVIDER === 'api' && process.env.AJCC_API_BASE_URL && process.env.AJCC_API_KEY),
    licenceRecordActive: ajcc.getLicenseStatus().some(l => l.status === 'ACTIVE' && /AJCC/i.test(l.contentName)),
    connected: packs.length > 0,
    packs: packs.map(p => ({ packId: p.packId, providerKey: p.providerKey, schemaId: p.schemaId, version: p.version, effectiveFrom: p.effectiveFrom, provenance: p.provenance, proprietary: p.proprietary, classifications: p.classifications }))
  };
}

module.exports = { connectLicensedAjcc, fetchLicensedContent, mapToPack, statusSnapshot, NOT_CONFIGURED, FETCH_FAILED };
