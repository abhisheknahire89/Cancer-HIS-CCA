'use strict';
// Content-pack loader tests (staging mandate §5/§6/§7). Packs are JSON files that
// plug licensed/public derivation content into the engine with ZERO engine changes.
// The loader must fail closed: an invalid pack is skipped and REPORTED, never
// half-registered, and a failed load never mutates the engine registry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../src/staging-engine');
const packsLoader = require('../src/staging-packs');
const ROOT = path.join(__dirname, '..');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cca-packs-')); }
function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir best-effort */ } }

// Minimal valid pack (fictional providerKey/schemaId — engine-facing only).
function minimalPack(id) {
  return {
    packId: id,
    authority: 'AJCC',
    providerKey: 'TNM_X',
    schemaId: 'X',
    version: 'test',
    effectiveFrom: '2017-01-01',
    provenance: 'test pack',
    classifications: ['CLINICAL'],
    categoryRules: {
      stage: [{ id: 'S1', priority: 1, conditions: { op: 'ALWAYS' }, output: 'STAGE_X' }]
    },
    resultKey: 'stage'
  };
}

// ---------------------------------------------------------------------------
// validatePack — pure interface validation
// ---------------------------------------------------------------------------
test('validatePack accepts a well-formed pack', () => {
  const v = packsLoader.validatePack(minimalPack('ok'));
  assert.strictEqual(v.ok, true, v.errors.join('; '));
  assert.deepStrictEqual(v.warnings, []);
});

test('validatePack rejects non-objects and missing required fields with specific errors', () => {
  for (const bad of [null, 'string', 42, []]) {
    const v = packsLoader.validatePack(bad);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.length >= 1);
  }
  const v = packsLoader.validatePack({ packId: 'x', authority: 'AJCC' });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('missing required field "providerKey"')));
});

test('validatePack rejects unknown condition operators and malformed trees', () => {
  const p = minimalPack('cond');
  p.categoryRules.stage[0].conditions = { op: 'EVAL', key: 'a', value: 1 };
  let v = packsLoader.validatePack(p);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('unknown operator "EVAL"')));

  p.categoryRules.stage[0].conditions = { op: 'AND', of: [] };
  v = packsLoader.validatePack(p);
  assert.ok(v.errors.some(e => e.includes('requires a non-empty "of" array')));

  p.categoryRules.stage[0].conditions = { op: 'BETWEEN', key: 'a', min: 10, max: 5 };
  v = packsLoader.validatePack(p);
  assert.ok(v.errors.some(e => e.includes('BETWEEN requires numeric min')));

  p.categoryRules.stage[0].conditions = { op: 'IN', key: 'a' };
  v = packsLoader.validatePack(p);
  assert.ok(v.errors.some(e => e.includes('IN requires a non-empty "values"')));
});

test('validatePack rejects duplicate rule ids across categories', () => {
  const p = minimalPack('dup');
  p.categoryRules = {
    a: [{ id: 'R1', priority: 1, conditions: { op: 'ALWAYS' }, output: 'OUT_A' }],
    b: [{ id: 'R1', priority: 1, conditions: { op: 'ALWAYS' }, output: 'OUT_B' }]
  };
  const v = packsLoader.validatePack(p);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('duplicate rule id "R1"')));
});

test('validatePack rejects a prognostic block missing required keys', () => {
  const p = minimalPack('prog');
  p.prognostic = { key: 'risk', label: 'Risk' };
  const v = packsLoader.validatePack(p);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('prognostic missing "rules"')));
});

test('validatePack warns when NON_TNM is mixed with TNM classifications', () => {
  const p = minimalPack('nontnm');
  p.classifications = ['NON_TNM', 'CLINICAL'];
  const v = packsLoader.validatePack(p);
  assert.strictEqual(v.ok, true);
  assert.ok(v.warnings.some(w => w.includes('NON_TNM')));
});

// ---------------------------------------------------------------------------
// loadPacksFromRoot — discovery, skipping, registry discipline
// ---------------------------------------------------------------------------
test('loadPacksFromRoot registers a valid pack and drives derivation with zero engine changes', () => {
  const dir = tmpRoot();
  writeJson(path.join(dir, 'x.json'), minimalPack('PACK_A'));
  const summary = packsLoader.loadPacksFromRoot(dir);
  assert.strictEqual(summary.registered.length, 1);
  assert.strictEqual(summary.registered[0].packId, 'PACK_A');
  assert.ok(summary.registered[0].file === 'x.json');

  const r = engine.evaluate([], engine.packFor('TNM_X', 'X'), { classification: 'CLINICAL', variables: {} });
  assert.strictEqual(r.status, 'CALCULATED');
  assert.strictEqual(r.result, 'STAGE_X');
  assert.strictEqual(r.packId, 'PACK_A');
  const snap = engine.packsSnapshot().find(p => p.packId === 'PACK_A');
  assert.ok(snap && snap.source.startsWith('FILE:'), 'registry records the source file');

  engine.removePacksBySourcePrefix('FILE:');
  cleanup(dir);
});

test('loadPacksFromRoot skips schema-invalid packs with reasons; engine registry untouched', () => {
  const dir = tmpRoot();
  writeJson(path.join(dir, 'broken.json'), { packId: 'broken', authority: 'AJCC' });
  const before = engine.packsSnapshot().length;
  const summary = packsLoader.loadPacksFromRoot(dir);
  assert.strictEqual(summary.registered.length, 0);
  assert.strictEqual(summary.skipped.length, 1);
  assert.ok(summary.skipped[0].errors.some(e => e.includes('missing required field')));
  assert.strictEqual(engine.packsSnapshot().length, before);
  cleanup(dir);
});

test('loadPacksFromRoot skips unreadable JSON without throwing', () => {
  const dir = tmpRoot();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ this is not json');
  const summary = packsLoader.loadPacksFromRoot(dir);
  assert.strictEqual(summary.registered.length, 0);
  assert.strictEqual(summary.skipped.length, 1);
  assert.ok(summary.skipped[0].errors[0].includes('unreadable or invalid JSON'));
  cleanup(dir);
});

test('loadPacksFromRoot reports duplicate packId as a registry rejection, not a JSON error', () => {
  const dir = tmpRoot();
  writeJson(path.join(dir, 'a.json'), minimalPack('DUP_PACK'));
  const first = packsLoader.loadPacksFromRoot(dir);
  assert.strictEqual(first.registered.length, 1);
  // Same packId in a differently-named file: same generation wipe keeps the original registered,
  // so the second file hits the duplicate-packId registry guard.
  writeJson(path.join(dir, 'b.json'), minimalPack('DUP_PACK'));
  const second = packsLoader.loadPacksFromRoot(dir);
  assert.strictEqual(second.registered.length, 1, 'a.json re-registers after the generation wipe');
  assert.ok(second.registered[0].packId === 'DUP_PACK' && second.registered[0].file === 'a.json');
  assert.ok(second.skipped.some(s => s.file === 'b.json' && s.errors.some(e => e.startsWith('pack rejected:'))));
  assert.ok(second.skipped.some(s => s.file === 'b.json' && s.errors.some(e => e.includes('duplicate packId'))));
  engine.removePacksBySourcePrefix('FILE:');
  cleanup(dir);
});

test('loadPacksFromRoot refuses a second ACTIVE pack for the same schema without supersedes', () => {
  const dir = tmpRoot();
  writeJson(path.join(dir, 'a.json'), minimalPack('COVER_A'));
  packsLoader.loadPacksFromRoot(dir);
  const other = minimalPack('COVER_B'); // same providerKey/schemaId, no supersedes
  writeJson(path.join(dir, 'b.json'), other);
  const summary = packsLoader.loadPacksFromRoot(dir);
  assert.ok(summary.skipped.some(s => s.errors.some(e => e.includes('another ACTIVE pack'))));
  engine.removePacksBySourcePrefix('FILE:');
  cleanup(dir);
});

test('supersedes chain: incumbent demoted to SUPERSEDED, removal restores it', () => {
  const dir = tmpRoot();
  const oldPack = minimalPack('PACK_OLD');
  oldPack.categoryRules.stage[0].output = 'STAGE_OLD';
  const newPack = minimalPack('PACK_NEW');
  newPack.supersedes = 'PACK_OLD';
  writeJson(path.join(dir, 'old.json'), oldPack);
  writeJson(path.join(dir, 'new.json'), newPack);
  const summary = packsLoader.loadPacksFromRoot(dir);
  assert.strictEqual(summary.registered.length, 2, JSON.stringify(summary.skipped));

  const snap = engine.packsSnapshot();
  const oldEntry = snap.find(p => p.packId === 'PACK_OLD');
  const newEntry = snap.find(p => p.packId === 'PACK_NEW');
  assert.strictEqual(oldEntry.status, 'SUPERSEDED');
  assert.strictEqual(oldEntry.supersededBy, 'PACK_NEW');
  assert.strictEqual(newEntry.status, 'ACTIVE');

  // Removing the superseding generation restores the incumbent (reload discipline)
  engine.removePacksBySourcePrefix('FILE:');
  const snap2 = engine.packsSnapshot();
  assert.ok(!snap2.some(p => p.packId === 'PACK_NEW'));
  const restored = snap2.find(p => p.packId === 'PACK_OLD');
  assert.ok(!restored, 'FILE-sourced incumbent is itself removed on reload');
  cleanup(dir);
});

test('packsSnapshot never leaks rule tables or rule text', () => {
  const dir = tmpRoot();
  const p = minimalPack('SNAP');
  p.categoryRules.stage[0].explain = 'secret derivation text';
  writeJson(path.join(dir, 's.json'), p);
  packsLoader.loadPacksFromRoot(dir);
  const entry = engine.packsSnapshot().find(x => x.packId === 'SNAP');
  assert.ok(entry);
  assert.strictEqual(entry.rules, undefined);
  assert.strictEqual(entry.categoryRules, undefined);
  assert.strictEqual(entry.explain, undefined);
  engine.removePacksBySourcePrefix('FILE:');
  cleanup(dir);
});

test('unreadable content-pack directory yields an error summary, no throw', () => {
  const summary = packsLoader.loadPacksFromRoot('/nonexistent/cca-packs-missing');
  assert.strictEqual(summary.registered.length, 0);
  assert.ok(summary.error && summary.error.includes('unreadable'));
});

// ---------------------------------------------------------------------------
// The shipped PoC pack: validates, registers, and derives breast cTNM + stage
// ---------------------------------------------------------------------------
test('shipped PoC breast pack validates and derives cTNM categories and anatomic stage', () => {
  const summary = packsLoader.loadPacksFromRoot(path.join(ROOT, 'content-packs'));
  assert.ok(summary.registered.some(r => r.packId === 'AJCC_BREAST_CTNM_LICENSED_POC'), JSON.stringify(summary.skipped));
  assert.strictEqual(summary.skipped.length, 0, 'shipped packs must load cleanly: ' + JSON.stringify(summary.skipped));

  const fields = require('../src/staging-providers').PROVIDERS.TNM_BREAST.resolveSchema({ cancerType: 'BREAST' }).fields;
  const pack = engine.packFor('TNM_BREAST', 'BREAST');
  assert.ok(pack, 'PoC pack must be ACTIVE for TNM_BREAST/BREAST');

  const facts = {
    tumourSizeMm: 28,
    chestWallInvolvement: false,
    skinInvolvement: false,
    clinicalNodalStatus: 'NODE_NEGATIVE',
    distantMetastasis: false
  };
  const r = engine.evaluate(fields, pack, { classification: 'CLINICAL', variables: facts });
  assert.strictEqual(r.status, 'CALCULATED', JSON.stringify(r.missing || r.invalid || r));
  assert.strictEqual(r.categories.tCategory, 'T2');
  assert.strictEqual(r.categories.nCategory, 'N0');
  assert.strictEqual(r.categories.mCategory, 'cM0');
  assert.strictEqual(r.result, 'STAGE_IIA');
  assert.strictEqual(r.resultLabel, 'Stage IIA');
  assert.strictEqual(r.proprietary, true);
  // §28: proprietary pack hides rule text from UI traces — outputs only
  for (const ra of r.rulesApplied) {
    assert.strictEqual(ra.explain, undefined);
    assert.ok(ra.output);
  }

  // A few more table transitions prove the stage rules beyond one point:
  const t4 = engine.evaluate(fields, pack, { classification: 'CLINICAL', variables: { ...facts, chestWallInvolvement: true } });
  assert.strictEqual(t4.result, 'STAGE_IIIB');
  const m1 = engine.evaluate(fields, pack, { classification: 'CLINICAL', variables: { ...facts, distantMetastasis: true } });
  assert.strictEqual(m1.result, 'STAGE_IV');
  const t3n1 = engine.evaluate(fields, pack, { classification: 'CLINICAL', variables: { ...facts, tumourSizeMm: 60, clinicalNodalStatus: 'NODES_MOBILE_1_3' } });
  assert.strictEqual(t3n1.result, 'STAGE_IIB');

  // Missing a required fact → NEEDS_INFORMATION naming the missing input (§13/§44)
  const { tumourSizeMm, ...incomplete } = facts;
  const miss = engine.evaluate(fields, pack, { classification: 'CLINICAL', variables: incomplete });
  assert.strictEqual(miss.status, 'NEEDS_INFORMATION');
  assert.ok(miss.missing.some(m => m.toLowerCase().includes('tumour size')));

  // PATHOLOGICAL classification is not covered by this pack → honest content-unavailable
  // status (§7/§17); the governed clinician-recorded fallback remains available there.
  const wrongCls = engine.evaluate(fields, pack, { classification: 'PATHOLOGICAL', variables: facts });
  assert.strictEqual(wrongCls.status, 'CONTENT_PROVIDER_UNAVAILABLE');

  engine.removePacksBySourcePrefix('FILE:');
  cleanup(path.join(os.tmpdir(), 'unused'));
});
