// CCA OS — Automatic staging / classification engine (mandate: AUTOMATIC DISEASE-SPECIFIC STAGING)
//
// PIPELINE: normalized facts → validation → missing-information detection →
// category derivation (declarative rules) → stage/classification result → trace.
// The clinician never picks categories or stage groups when a content pack can
// derive them; the result is CALCULATED, and only becomes authoritative when a
// clinician signs (sign path in clinical.js / clinical-flow.js).
//
// CONTENT RULE (§7): disease rule content lives in loadable, versioned packs.
// This build ships ONE public-criteria pack (myeloma ISS / R-ISS — IMWG published
// cutpoints, not protected AJCC tables). AJCC disease packs plug in exclusively
// through licensed content; with no pack the engine reports
// CONTENT_PROVIDER_UNAVAILABLE and never fabricates a category or stage.
//
// RULE ENGINE (§38/§39): rules are pure DATA — condition trees over
// EQ / NE / GT / GTE / LT / LTE / BETWEEN / IN / NOT_IN / EXISTS / NOT_EXISTS /
// AND / OR / ALWAYS. No eval(), no executable text from content packages.
'use strict';

// ---------------------------------------------------------------------------
// Condition evaluator (§39)
// ---------------------------------------------------------------------------
function evalCondition(node, facts) {
  if (!node) return false;
  switch (node.op) {
    case 'ALWAYS': return true;
    case 'AND': return node.of.every(c => evalCondition(c, facts));
    case 'OR': return node.of.some(c => evalCondition(c, facts));
    case 'EQ': return facts[node.key] === node.value;
    case 'NE': return facts[node.key] !== node.value;
    case 'GT': return facts[node.key] > node.value;
    case 'GTE': return facts[node.key] >= node.value;
    case 'LT': return facts[node.key] < node.value;
    case 'LTE': return facts[node.key] <= node.value;
    case 'BETWEEN': return facts[node.key] >= node.min && facts[node.key] <= node.max;
    case 'IN': return node.values.includes(facts[node.key]);
    case 'NOT_IN': return !node.values.includes(facts[node.key]);
    case 'EXISTS': return facts[node.key] !== undefined;
    case 'NOT_EXISTS': return facts[node.key] === undefined;
    default: return false; // unknown operator never matches (fail-closed)
  }
}

// ---------------------------------------------------------------------------
// Built-in pack. `proprietary: true` packs hide rule text from the UI trace
// (§28) — only inputs, categories and result are shown for those.
// Disease packs are loadable, versioned data (§7): the engine owns derivation
// and the pack registry; src/staging-packs.js discovers and validates pack
// FILES and registers them here — licensed AJCC packs plug in through that
// seam with no engine changes.
// ---------------------------------------------------------------------------
const PACKS = {
  MYELOMA_ISS_RISS_PUBLIC: {
    packId: 'MYELOMA_ISS_RISS_PUBLIC',
    authority: 'ISS_RISS',
    schemaId: 'MM_ISS',
    providerKey: 'MM',
    version: 'ISS (IMWG 2005) / R-ISS (IMWG 2015) — published criteria',
    effectiveFrom: '2015-01-01',
    provenance: 'Publicly published IMWG criteria (serum β2-microglobulin, albumin, LDH, iFISH risk). Not AJCC licensed content; no protected stage tables.',
    classifications: ['NON_TNM'],
    proprietary: false,
    requiredInputs: ['beta2Microglobulin', 'albumin'],
    optionalInputs: ['ldhElevated', 'cytogeneticRisk'],
    // Schema fields that become redundant when the engine is connected — the UI
    // hides them so the result is never hand-picked alongside derivation (§31).
    resultFields: ['issStage', 'rissStage'],
    categoryRules: {
      iss: [
        { id: 'ISS_III', priority: 1, conditions: { op: 'GTE', key: 'beta2Microglobulin', value: 5.5 }, output: 'ISS_III', explain: 'Serum β2-microglobulin ≥ 5.5 mg/L', source: 'IMWG International Staging System — published criteria' },
        { id: 'ISS_I', priority: 2, conditions: { op: 'AND', of: [{ op: 'LT', key: 'beta2Microglobulin', value: 3.5 }, { op: 'GTE', key: 'albumin', value: 3.5 }] }, output: 'ISS_I', explain: 'Serum β2-microglobulin < 3.5 mg/L AND serum albumin ≥ 3.5 g/dL', source: 'IMWG International Staging System — published criteria' },
        { id: 'ISS_II', priority: 3, conditions: { op: 'ALWAYS' }, output: 'ISS_II', explain: 'Neither ISS III nor ISS I criterion met (residual class)', source: 'IMWG International Staging System — published criteria' }
      ]
    },
    resultKey: 'iss',
    resultLabels: { ISS_I: 'ISS stage I', ISS_II: 'ISS stage II', ISS_III: 'ISS stage III' },
    prognostic: {
      key: 'riss',
      label: 'R-ISS (prognostic refinement)',
      requiresAll: ['ldhElevated', 'cytogeneticRisk'],
      missingNotice: 'R-ISS cannot be derived — LDH status and/or iFISH cytogenetic risk not provided (ISS result unaffected).',
      rules: [
        { id: 'RISS_I', priority: 1, conditions: { op: 'AND', of: [{ op: 'EQ', key: 'iss', value: 'ISS_I' }, { op: 'EQ', key: 'cytogeneticRisk', value: 'STANDARD' }, { op: 'EQ', key: 'ldhElevated', value: false }] }, output: 'RISS_I', explain: 'ISS I AND standard-risk iFISH AND LDH not elevated', source: 'IMWG Revised-ISS — published criteria' },
        { id: 'RISS_III', priority: 2, conditions: { op: 'AND', of: [{ op: 'EQ', key: 'iss', value: 'ISS_III' }, { op: 'OR', of: [{ op: 'EQ', key: 'cytogeneticRisk', value: 'HIGH' }, { op: 'EQ', key: 'ldhElevated', value: true }] }] }, output: 'RISS_III', explain: 'ISS III with high-risk iFISH and/or elevated LDH', source: 'IMWG Revised-ISS — published criteria' },
        { id: 'RISS_II', priority: 3, conditions: { op: 'ALWAYS' }, output: 'RISS_II', explain: 'Neither R-ISS I nor R-ISS III criterion met (residual class)', source: 'IMWG Revised-ISS — published criteria' }
      ],
      labels: { RISS_I: 'R-ISS stage I', RISS_II: 'R-ISS stage II', RISS_III: 'R-ISS stage III' }
    }
  }
};

// ---------------------------------------------------------------------------
// Pack registry: packId → { pack, source, status, supersededBy }.
// Versioning (§5/§6): one ACTIVE pack per (providerKey, schemaId); a pack
// replaces an incumbent only by explicitly declaring supersedes: '<packId>'.
// ---------------------------------------------------------------------------
const REGISTRY = new Map();
for (const p of Object.values(PACKS)) REGISTRY.set(p.packId, { pack: p, source: 'BUILT_IN', status: 'ACTIVE', supersededBy: null });

function registerPack(pack, meta) {
  if (!pack || typeof pack !== 'object') throw new Error('pack must be an object');
  if (REGISTRY.has(pack.packId)) throw new Error('duplicate packId "' + pack.packId + '"');
  const incumbent = [...REGISTRY.values()].find(r => r.status === 'ACTIVE' && r.pack.providerKey === pack.providerKey && r.pack.schemaId === pack.schemaId);
  if (incumbent && incumbent.pack.packId !== pack.supersedes) {
    throw new Error('another ACTIVE pack already covers ' + pack.providerKey + '/' + pack.schemaId + ' ("' + incumbent.pack.packId + '") — declare supersedes: "' + incumbent.pack.packId + '" to replace it');
  }
  if (pack.supersedes) {
    const prior = REGISTRY.get(pack.supersedes);
    if (!prior) throw new Error('supersedes names unknown pack "' + pack.supersedes + '"');
    if (prior.status !== 'ACTIVE') throw new Error('supersedes names a non-ACTIVE pack "' + pack.supersedes + '"');
    prior.status = 'SUPERSEDED';
    prior.supersededBy = pack.packId;
  }
  REGISTRY.set(pack.packId, { pack, source: (meta && meta.source) || 'UNKNOWN', status: 'ACTIVE', supersededBy: null });
}

function removePacksBySourcePrefix(prefix) {
  for (const [id, r] of [...REGISTRY.entries()]) {
    if (!String(r.source).startsWith(prefix)) continue;
    REGISTRY.delete(id);
    if (r.pack.supersedes) {
      const prior = REGISTRY.get(r.pack.supersedes);
      if (prior && prior.supersededBy === id) { prior.status = 'ACTIVE'; prior.supersededBy = null; }
    }
  }
}

function packsSnapshot() {
  return [...REGISTRY.values()].map(r => ({
    packId: r.pack.packId, authority: r.pack.authority, providerKey: r.pack.providerKey, schemaId: r.pack.schemaId,
    version: r.pack.version, effectiveFrom: r.pack.effectiveFrom, provenance: r.pack.provenance,
    proprietary: !!r.pack.proprietary, classifications: r.pack.classifications,
    source: r.source, status: r.status, supersededBy: r.supersededBy
  }));
}

function packFor(providerKey, schemaId) {
  let best = null;
  for (const r of REGISTRY.values()) {
    if (r.status !== 'ACTIVE') continue;
    const p = r.pack;
    if (p.providerKey !== providerKey || p.schemaId !== schemaId) continue;
    if (!best || String(p.effectiveFrom) > String(best.effectiveFrom)) best = p;
  }
  return best;
}

// Schema fields the UI must hide when this pack drives derivation (defaults to
// the generic governed stageResult field).
function resultFields(pack) {
  return (pack && pack.resultFields) || ['stageResult'];
}

// ---------------------------------------------------------------------------
// Normalization + field validation (§8: input schema is disease-specific; the
// field definitions come from the provider schema, not duplicated here)
// ---------------------------------------------------------------------------
function normalizeValue(f, raw) {
  const t = f.type;
  if (t === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (raw === '' || raw === null || !isFinite(n)) return { error: 'not a valid number' };
    if (f.min !== undefined && n < f.min) return { error: 'below allowed minimum (' + f.min + ')' };
    if (f.max !== undefined && n > f.max) return { error: 'above allowed maximum (' + f.max + ')' };
    return { value: n };
  }
  if (t === 'boolean') {
    if (typeof raw === 'boolean') return { value: raw };
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'not a valid boolean' };
  }
  if (t === 'multiselect' || Array.isArray(raw)) {
    const arr = Array.isArray(raw) ? raw : String(raw).split(',').map(s => s.trim()).filter(Boolean);
    const allowed = f.allowedValues || (f.options ? f.options.map(o => (o && o.code !== undefined ? o.code : o)) : null);
    for (const v of arr) if (allowed && !allowed.includes(String(v))) return { error: 'value not allowed for this schema (' + v + ')' };
    return { value: arr };
  }
  const s = String(raw);
  const allowed = f.allowedValues || (f.options ? f.options.map(o => (o && o.code !== undefined ? o.code : o)) : null);
  if (allowed && !allowed.includes(s)) return { error: 'value not allowed for this schema (' + s + ')' };
  return { value: s };
}

function isVisible(f, facts) {
  if (!f.visibleWhen) return true;
  return evalCondition(f.visibleWhen, facts);
}

// ---------------------------------------------------------------------------
// evaluate() — the §11/§12 pipeline. Pure: same inputs → same output.
// fields: provider schema field definitions (single source of display+validation)
// pack:   content pack from PACKS (or null → CONTENT_PROVIDER_UNAVAILABLE)
// ---------------------------------------------------------------------------
function evaluate(fields, pack, { classification, variables }) {
  const calculatedAt = new Date().toISOString();
  if (!pack) {
    return {
      status: 'CONTENT_PROVIDER_UNAVAILABLE',
      reason: 'No automatic-derivation content pack is connected for this disease schema. Governed clinician-recorded categories remain available; automatic T/N/M and stage-group calculation require licensed authority content.',
      calculatedAt
    };
  }
  if (classification && !pack.classifications.includes(classification)) {
    return {
      status: 'CONTENT_PROVIDER_UNAVAILABLE',
      reason: 'The connected content pack does not cover classification ' + classification + ' (covers: ' + pack.classifications.join('/') + '). Governed clinician-recorded categories remain available for this classification; automatic derivation requires the licensed content that covers it.',
      calculatedAt
    };
  }

  // 1. normalize + per-field validation (§11, §45)
  const normalized = {};
  const invalid = [];
  for (const [k, raw] of Object.entries(variables || {})) {
    if (raw === '' || raw === null || raw === undefined) continue;
    const f = (fields || []).find(x => x.key === k);
    if (!f) { invalid.push('unknown input for this schema: ' + k); continue; }
    const n = normalizeValue(f, raw);
    if (n.error) { invalid.push(k + ': ' + n.error); continue; }
    normalized[k] = n.value;
  }
  if (invalid.length) return { status: 'INVALID_INPUT', invalid, calculatedAt };

  // 2. required-information detection (§13/§44) — visibility-aware
  const missing = (pack.requiredInputs || [])
    .filter(k => normalized[k] === undefined)
    .map(k => { const f = (fields || []).find(x => x.key === k); return f ? (f.label || k) : k; });
  if (missing.length) {
    return { status: 'NEEDS_INFORMATION', missing, warnings: [], calculatedAt };
  }

  // 3. category derivation — declarative rules, first match by priority (§12)
  const categories = {};
  const rulesApplied = [];
  for (const [catKey, rules] of Object.entries(pack.categoryRules || {})) {
    const facts = Object.assign({}, normalized, categories);
    const rule = [...rules].sort((a, b) => a.priority - b.priority).find(r => evalCondition(r.conditions, facts));
    if (rule) {
      categories[catKey] = rule.output;
      rulesApplied.push({ category: catKey, id: rule.id, output: rule.output, explain: rule.explain, source: rule.source, provenance: pack.provenance });
    }
  }
  if (Object.keys(categories).length === 0) {
    return { status: 'AMBIGUOUS', message: 'Unable to distinguish between provider-valid classifications — additional information required.', calculatedAt };
  }
  // §53: never output a definitive result the provider rules did not produce.
  // Some categories derived but the result category is undetermined → explicit
  // non-final status, never CALCULATED with an empty result.
  if (pack.resultKey && categories[pack.resultKey] === undefined) {
    return {
      status: 'NEEDS_INFORMATION',
      missing: ['The ' + pack.resultKey + ' result could not be derived from the entered facts — no provider rule matched. Enter the missing staging facts (or record a governed clinician-recorded result instead).'],
      warnings: [],
      calculatedAt
    };
  }

  // 4. prognostic stage (§21/§22) — separate result, never overwrites the primary
  const warnings = [];
  let prognosticStage = null;
  let prognosticLabel = null;
  const prog = pack.prognostic;
  if (prog) {
    const allPresent = (prog.requiresAll || []).every(k => normalized[k] !== undefined);
    if (!allPresent) {
      warnings.push(prog.missingNotice);
    } else {
      const facts = Object.assign({}, normalized, categories);
      const rule = [...prog.rules].sort((a, b) => a.priority - b.priority).find(r => evalCondition(r.conditions, facts));
      if (rule) {
        prognosticStage = rule.output;
        prognosticLabel = prog.labels[rule.output] || rule.output;
        rulesApplied.push({ category: prog.key, id: rule.id, output: rule.output, explain: rule.explain, source: rule.source, provenance: pack.provenance });
      }
    }
  }

  // 5. result + machine-readable trace (§27)
  const result = categories[pack.resultKey];
  return {
    status: 'CALCULATED',
    result,
    resultLabel: (pack.resultLabels || {})[result] || result,
    prognosticStage,
    prognosticLabel,
    categories,
    packId: pack.packId,
    version: pack.version,
    provenance: pack.provenance,
    proprietary: !!pack.proprietary,
    normalizedInputs: normalized,
    rulesApplied: pack.proprietary ? rulesApplied.map(r => ({ category: r.category, output: r.output, source: r.source })) : rulesApplied,
    missing: [],
    warnings,
    calculatedAt
  };
}

module.exports = { PACKS, packFor, resultFields, evaluate, evalCondition, normalizeValue, registerPack, removePacksBySourcePrefix, packsSnapshot };
