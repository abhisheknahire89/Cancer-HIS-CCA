// CCA OS — Staging content-pack loader (staging mandate §5/§6/§7)
//
// INTERFACE CONTRACT: automatic-derivation rule content lives in pack FILES, not
// in engine code. A pack is a JSON document with:
//   packId (unique), authority, providerKey + schemaId (the disease schema it
//   drives), version, effectiveFrom, provenance, classifications[], and
//   categoryRules: { <categoryKey>: [{ id, priority, conditions, output,
//   explain, source }] } — the same declarative condition vocabulary the engine
//   evaluates (§38/§39: EQ/NE/GT/GTE/LT/LTE/BETWEEN/IN/NOT_IN/EXISTS/
//   NOT_EXISTS/AND/OR/ALWAYS — never eval(), never executable text).
//   Optional: proprietary (hide rule text from UI traces), resultKey,
//   resultLabels, requiredInputs/optionalInputs, resultFields (UI fields the
//   engine replaces), prognostic { key, label, requiresAll, missingNotice,
//   rules, labels }, supersedes ('<packId>' this pack replaces).
//
// SEMANTICS: one ACTIVE pack per (providerKey, schemaId). A pack replaces an
// incumbent only by declaring supersedes — version bumps are never silent.
// Discovery runs once at server boot: a pack that fails validation is skipped
// and REPORTED, never half-registered. Licensed AJCC packs plug in through this
// seam with zero engine changes.
'use strict';
const fs = require('fs');
const path = require('path');
const engine = require('./staging-engine');

const PACK_INTERFACE_ERROR = 'pack does not satisfy the content-pack interface';

// Pure validation: returns { ok, errors[], warnings[] }. No I/O, no mutation.
// Every rule here encodes a way a malformed pack could corrupt derivation or
// leak authority into the UI — fail-closed, specific messages.
function validatePack(p) {
  const errors = [];
  const warnings = [];
  const bad = m => errors.push(PACK_INTERFACE_ERROR + ': ' + m);

  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, errors: [PACK_INTERFACE_ERROR + ': pack must be a JSON object'], warnings };
  for (const k of ['packId', 'authority', 'providerKey', 'schemaId', 'version', 'effectiveFrom', 'provenance', 'classifications', 'categoryRules']) {
    if (p[k] === undefined) bad('missing required field "' + k + '"');
  }
  if (errors.length) return { ok: false, errors, warnings };
  for (const k of ['packId', 'authority', 'providerKey', 'schemaId', 'version', 'provenance']) {
    if (typeof p[k] !== 'string' || !p[k].trim()) bad('"' + k + '" must be a non-empty string');
  }
  if (typeof p.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveFrom)) bad('"effectiveFrom" must be a YYYY-MM-DD date');
  if (!Array.isArray(p.classifications) || !p.classifications.length || !p.classifications.every(c => typeof c === 'string' && c.trim())) bad('"classifications" must be a non-empty array of strings');

  const catOut = new Map();
  const ruleIds = new Set();
  for (const [catKey, rules] of Object.entries(p.categoryRules)) {
    if (!Array.isArray(rules) || !rules.length) { bad('categoryRules.' + catKey + ' must be a non-empty rule array'); continue; }
    const outs = new Set();
    for (const r of rules) {
      if (!r || typeof r !== 'object') { bad('categoryRules.' + catKey + ' contains a non-object rule'); continue; }
      for (const k of ['id', 'priority', 'conditions', 'output']) {
        if (r[k] === undefined) bad('categoryRules.' + catKey + '.' + (r.id || '?') + ' missing "' + k + '"');
      }
      if (typeof r.priority !== 'number' || !Number.isInteger(r.priority) || r.priority < 1) bad('categoryRules.' + catKey + '.' + (r.id || '?') + ' priority must be a positive integer');
      if (typeof r.output !== 'string' || !r.output.trim()) bad('categoryRules.' + catKey + '.' + (r.id || '?') + ' output must be a non-empty string');
      if (!ruleIds.has(r.id)) ruleIds.add(r.id); else bad('duplicate rule id "' + r.id + '"');
      validateCondition(r.conditions, 'categoryRules.' + catKey + '.' + (r.id || '?'), bad);
      outs.add(r.output);
    }
    catOut.set(catKey, outs);
  }
  if (!catOut.size) bad('"categoryRules" must define at least one category');

  // Cross-references the engine relies on at derivation time.
  if (p.resultKey !== undefined && !catOut.has(p.resultKey)) bad('"resultKey" must name a categoryRules key');
  if (p.resultFields !== undefined) {
    if (!Array.isArray(p.resultFields) || !p.resultFields.every(x => typeof x === 'string')) bad('"resultFields" must be an array of schema field keys');
  }
  if (p.requiredInputs !== undefined && (!Array.isArray(p.requiredInputs) || !p.requiredInputs.every(x => typeof x === 'string'))) bad('"requiredInputs" must be an array of schema field keys');
  if (p.optionalInputs !== undefined && (!Array.isArray(p.optionalInputs) || !p.optionalInputs.every(x => typeof x === 'string'))) bad('"optionalInputs" must be an array of schema field keys');
  if (p.classifications.includes('NON_TNM') && p.classifications.length > 1) warnings.push('NON_TNM packs normally declare classifications: ["NON_TNM"] only');
  if (p.supersedes !== undefined && (typeof p.supersedes !== 'string' || !p.supersedes.trim())) bad('"supersedes" must be a packId string');

  const prog = p.prognostic;
  if (prog !== undefined) {
    if (!prog || typeof prog !== 'object' || Array.isArray(prog)) bad('"prognostic" must be an object');
    else {
      for (const k of ['key', 'label', 'rules', 'labels']) if (prog[k] === undefined) bad('prognostic missing "' + k + '"');
      // NB: prog.key is the trace label for the prognostic result (engine §21/§22);
      // prognostic RULES evaluate against the primary category outputs (e.g. ISS),
      // so it need not — and normally does not — name a categoryRules key.
      if (Array.isArray(prog.rules)) {
        const outs = new Set();
        for (const r of prog.rules) {
          if (!r || typeof r !== 'object') { bad('prognostic.rules contains a non-object rule'); continue; }
          for (const k of ['id', 'priority', 'conditions', 'output']) if (r[k] === undefined) bad('prognostic.rules.' + (r.id || '?') + ' missing "' + k + '"');
          if (typeof r.priority !== 'number' || !Number.isInteger(r.priority) || r.priority < 1) bad('prognostic.rules.' + (r.id || '?') + ' priority must be a positive integer');
          if (!ruleIds.has(r.id)) ruleIds.add(r.id); else bad('duplicate rule id "' + r.id + '"');
          validateCondition(r.conditions, 'prognostic.rules.' + (r.id || '?'), bad);
          if (typeof r.output === 'string') outs.add(r.output);
        }
        if (prog.labels !== undefined && Object.keys(prog.labels).length && [...outs].every(o => prog.labels[o] === undefined)) warnings.push('prognostic.labels matches no rule output');
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Declarative condition vocabulary check (§38/§39) — the engine's fail-closed
// unknown-operator default means a typo would silently never match; validation
// makes it a boot-time error instead.
function validateCondition(node, where, bad) {
  if (!node || typeof node !== 'object') { bad(where + ' conditions must be an object'); return; }
  const OPS = new Set(['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'BETWEEN', 'IN', 'NOT_IN', 'EXISTS', 'NOT_EXISTS', 'AND', 'OR', 'ALWAYS']);
  if (!OPS.has(node.op)) { bad(where + ' unknown operator "' + node.op + '"'); return; }
  if (node.op === 'AND' || node.op === 'OR') {
    if (!Array.isArray(node.of) || !node.of.length) { bad(where + ' ' + node.op + ' requires a non-empty "of" array'); return; }
    for (const c of node.of) validateCondition(c, where, bad);
    return;
  }
  if (node.op === 'ALWAYS') return;
  if (typeof node.key !== 'string' || !node.key) { bad(where + ' missing fact "key"'); return; }
  if (node.op === 'BETWEEN' && !(typeof node.min === 'number' && typeof node.max === 'number' && node.min <= node.max)) bad(where + ' BETWEEN requires numeric min ≤ max');
  if ((node.op === 'IN' || node.op === 'NOT_IN') && (!Array.isArray(node.values) || !node.values.length)) bad(where + ' ' + node.op + ' requires a non-empty "values" array');
  if (['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NE'].includes(node.op) && node.value === undefined) bad(where + ' missing "value"');
}

// Discover + register every *.json pack under root. Re-runnable: removes the
// previous FILE-sourced generation first so a reload reflects the directory,
// then re-links supersedes chains. One bad file never blocks the others.
function loadPacksFromRoot(root) {
  engine.removePacksBySourcePrefix('FILE:');
  const summary = { root, discovered: [], registered: [], skipped: [] };
  let files = [];
  try { files = fs.readdirSync(root).filter(f => f.endsWith('.json')).sort(); } catch (e) { summary.error = 'content-pack directory unreadable: ' + e.message; return summary; }
  const parsedFiles = [];
  for (const f of files) {
    const full = path.join(root, f);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      summary.skipped.push({ file: f, errors: ['unreadable or invalid JSON: ' + e.message] });
      continue;
    }
    summary.discovered.push(f);
    const v = validatePack(parsed);
    if (!v.ok) { summary.skipped.push({ file: f, errors: v.errors }); continue; }
    parsedFiles.push({ file: f, pack: parsed, warnings: v.warnings });
  }
  // Dependency-ordered registration: a pack whose supersedes target lives in the
  // same directory must load after it regardless of filename order (chains
  // included). Anything whose chain never resolves is skipped with a reason.
  const pending = parsedFiles.slice();
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    // Forward iteration keeps registration order deterministic (filename order),
    // so a duplicate packId always resolves in favour of the first file.
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      if (item.pack.supersedes && !REGISTRY_HAS(engine, item.pack.supersedes)) continue;
      try {
        engine.registerPack(item.pack, { source: 'FILE:' + item.file });
        summary.registered.push({ file: item.file, packId: item.pack.packId, warnings: item.warnings });
      } catch (e) {
        // Registry-level rejection (duplicate packId, unsuperseded ACTIVE conflict…)
        summary.skipped.push({ file: item.file, errors: ['pack rejected: ' + e.message] });
      }
      pending.splice(i, 1);
      i--;
      progress = true;
    }
  }
  for (const item of pending) {
    summary.skipped.push({ file: item.file, errors: ['pack rejected: supersedes chain does not resolve — "' + item.pack.supersedes + '" is not a registered ACTIVE pack'] });
  }
  return summary;
}
function REGISTRY_HAS(engine, packId) {
  return engine.packsSnapshot().some(p => p.packId === packId && p.status === 'ACTIVE');
}

// Boot-time entry. Default dir is the project's content-packs/ resolved from this
// module's location (NOT process.cwd(), which is unreliable under daemon/service
// launches); CCA_CONTENT_PACKS_DIR overrides (a licensed deployment points this at
// its mounted pack directory).
function init() {
  const dir = process.env.CCA_CONTENT_PACKS_DIR || path.join(__dirname, '..', 'content-packs');
  return loadPacksFromRoot(dir);
}

module.exports = { validatePack, loadPacksFromRoot, init, validateCondition };
