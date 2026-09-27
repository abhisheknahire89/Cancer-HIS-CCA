// CCA OS — Licensed AJCC adapter PoC tests (injected transport)
// Proves the full licensed-derivation contract: credentials → fetch → validate →
// register → engine derivation with licensed provenance → the SAME sign gate
// (server-authoritative re-derivation, tamper refusal, NEEDS_INFORMATION refusal).
// The AJCC API transport is injected; the DEFAULT transport is proven over real
// HTTP in ajcc-adapter-wire.test.js. Shared fixture: ajcc-adapter-fixture.js.
'use strict';
const fixture = require('./ajcc-adapter-fixture');
const { check, expectError, expectErrorAsync, summary, exitCode, dateStr, licensedPack, setupBreastFixture } = fixture;

const engine = require('../src/staging-engine');
const ajcc = require('../src/ajcc');
const adapter = require('../src/ajcc-adapter');
const clinical = require('../src/clinical');
const staging = require('../src/staging');
const providers = require('../src/staging-providers');

const { ADMIN, MO, dx } = setupBreastFixture();
const licensedTransport = async () => licensedPack();

(async () => {
  console.log('\n== fail-closed connection: no credentials, no licence ==');
  await expectErrorAsync('connect without ANY configuration → CCA_AJCC_NOT_CONFIGURED',
    () => adapter.connectLicensedAjcc({ fetchContent: licensedTransport, actor: ADMIN }), 'CCA_AJCC_NOT_CONFIGURED');

  // env credentials present, licence record still missing
  process.env.AJCC_PROVIDER = 'api';
  process.env.AJCC_API_BASE_URL = 'https://ajcc.example';
  process.env.AJCC_API_KEY = 'test-key';
  await expectErrorAsync('credentials alone are not enough — ACTIVE licence record required',
    () => adapter.connectLicensedAjcc({ fetchContent: licensedTransport, actor: ADMIN }), 'CCA_AJCC_NOT_CONFIGURED');
  check('failed connections never mutate the registry',
    engine.packsSnapshot().filter(p => p.source === 'LICENSED_AJCC_API').length === 0);

  console.log('\n== authorization ==');
  ajcc.upsertLicense(ADMIN, { publisher: 'American College of Surgeons', contentName: 'AJCC Cancer Staging System', version: 'API 02.03.00', status: 'ACTIVE' });
  await expectErrorAsync('non-admin actor cannot connect licensed content',
    () => adapter.connectLicensedAjcc({ fetchContent: licensedTransport, actor: MO }), '');
  await expectErrorAsync('bad content (unknown rule operator) rejected by pack validation',
    () => adapter.connectLicensedAjcc({
      fetchContent: async () => JSON.stringify({ packId: 'BAD_PACK', authority: 'AJCC', providerKey: 'TNM_BREAST', schemaId: 'BREAST', version: 'v', effectiveFrom: '2017-01-01', provenance: 'p', classifications: ['CLINICAL'], categoryRules: { tCategory: [{ id: 'R1', priority: 1, conditions: { op: 'HACK', key: 'x' }, output: 'T1' }] } }),
      actor: ADMIN
    }), 'pack validation');
  await expectErrorAsync('non-JSON payload → CCA_AJCC_FETCH_FAILED',
    () => adapter.connectLicensedAjcc({ fetchContent: async () => '<xml>not json</xml>', actor: ADMIN }), 'not valid JSON');
  check('still no registered licensed packs after every failure',
    engine.packsSnapshot().filter(p => p.source === 'LICENSED_AJCC_API').length === 0);

  console.log('\n== successful connection ==');
  const connected = await adapter.connectLicensedAjcc({ fetchContent: licensedTransport, actor: ADMIN });
  check('connect returns the ACTIVE pack summary', connected && connected.connected && connected.status === 'ACTIVE' && connected.packId === 'AJCC_BREAST_CTNM_LICENSED_POC');
  check('pack registered with LICENSED_AJCC_API source', engine.packsSnapshot().some(p => p.packId === connected.packId && p.source === 'LICENSED_AJCC_API' && p.status === 'ACTIVE'));
  check('provenance stamped as licensed API content', /Licensed AJCC API content/.test(connected.provenance));
  await expectErrorAsync('duplicate connection refused (registry stays consistent)',
    () => adapter.connectLicensedAjcc({ fetchContent: licensedTransport, actor: ADMIN }), 'registration refused');

  console.log('\n== engine derivation from objective facts (licensed pack) ==');
  const pack = engine.packFor('TNM_BREAST', 'BREAST');
  check('packFor resolves the licensed pack for breast', pack && pack.packId === 'AJCC_BREAST_CTNM_LICENSED_POC');
  const FACTS = { tumourSizeMm: 28, chestWallInvolvement: false, skinInvolvement: false, distantMetastasis: false, clinicalNodalStatus: 'NODES_MOBILE_1_3' };
  const schema = providers.resolveProvider(dx).provider.resolveSchema(dx).fields;
  const d1 = engine.evaluate(schema, pack, { classification: 'CLINICAL', variables: FACTS });
  check('CALCULATED from objective facts', d1.status === 'CALCULATED');
  check('T category derived (28 mm → T2)', d1.categories.tCategory === 'T2');
  check('N category derived (mobile nodes → N1)', d1.categories.nCategory === 'N1');
  check('M category derived (no mets → cM0)', d1.categories.mCategory === 'cM0');
  check('anatomic stage group derived (→ Stage IIB)', d1.result === 'STAGE_IIB' && d1.resultLabel === 'Stage IIB');
  check('trace carries licensed provenance + pack identity', d1.packId === 'AJCC_BREAST_CTNM_LICENSED_POC' && /Licensed AJCC API content/.test(d1.provenance));
  check('licensed (proprietary) trace hides rule text, keeps category + source', d1.proprietary === true && d1.rulesApplied.length > 0 && d1.rulesApplied.every(r => r.explain === undefined && r.output && r.source));
  check('M1 case derives Stage IV', engine.evaluate(schema, pack, { classification: 'CLINICAL', variables: Object.assign({}, FACTS, { distantMetastasis: true }) }).result === 'STAGE_IV');
  check('determinism: same facts → identical result', JSON.stringify(engine.evaluate(schema, pack, { classification: 'CLINICAL', variables: FACTS }).categories) === JSON.stringify(d1.categories) && engine.evaluate(schema, pack, { classification: 'CLINICAL', variables: FACTS }).result === d1.result);
  const missing = engine.evaluate(schema, pack, { classification: 'CLINICAL', variables: { tumourSizeMm: 28 } });
  check('missing facts → NEEDS_INFORMATION, never a guessed stage', missing.status === 'NEEDS_INFORMATION' && missing.missing.length >= 3);
  check('invalid fact → INVALID_INPUT', engine.evaluate(schema, pack, { classification: 'CLINICAL', variables: Object.assign({}, FACTS, { tumourSizeMm: 'abc' }) }).status === 'INVALID_INPUT');
  check('uncovered classification → CONTENT_PROVIDER_UNAVAILABLE (governed fallback stays)',
    engine.evaluate(schema, pack, { classification: 'PATHOLOGICAL', variables: FACTS }).status === 'CONTENT_PROVIDER_UNAVAILABLE');

  console.log('\n== sign-gate contract: same gate, licensed derivation ==');
  const header = staging.stagingSchemaFor(dx.uuid);
  check('schema header reports engine AVAILABLE with the licensed pack', header.engine.status === 'AVAILABLE' && header.engine.packId === 'AJCC_BREAST_CTNM_LICENSED_POC');
  check('schema header hides hand-pickable t/n/m/stage for covered context', header.engine.resultFields.includes('t') && header.engine.resultFields.includes('stageResult'));

  const a = staging.createStagingAssessment(MO, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(0),
    variables: Object.assign({}, FACTS), resultSource: 'AUTOMATIC_ENGINE'
  });
  const signed = staging.signStagingAssessment(MO, a.uuid);
  check('signed record carries the engine-derived stage', signed.status === 'SIGNED' && signed.stageResult === 'STAGE_IIB' && signed.resultLabel === 'Stage IIB');
  check('machine-readable derivation trace stored with the record (§27)', signed.derivationTrace && signed.derivationTrace.status === 'CALCULATED' && signed.derivationTrace.packId === 'AJCC_BREAST_CTNM_LICENSED_POC' && signed.derivationTrace.normalizedInputs.tumourSizeMm === 28);

  const tampered = staging.createStagingAssessment(MO, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(0),
    variables: Object.assign({}, FACTS, { stageResult: 'STAGE_IA' }), resultSource: 'AUTOMATIC_ENGINE'
  });
  expectError('tampered result refused — sign gate re-derives and compares',
    () => staging.signStagingAssessment(MO, tampered.uuid), 'must match the engine-derived result');

  const incomplete = staging.createStagingAssessment(MO, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(0),
    variables: { tumourSizeMm: 28 }, resultSource: 'AUTOMATIC_ENGINE'
  });
  expectError('incomplete facts refused at sign — NEEDS_INFORMATION is never signable',
    () => staging.signStagingAssessment(MO, incomplete.uuid), 'NEEDS_INFORMATION');

  console.log('\n== adapter status snapshot (admin visibility) ==');
  const st = adapter.statusSnapshot();
  check('status reports configured + connected with the licensed pack', st.configured === true && st.connected === true && st.packs.length === 1 && st.packs[0].schemaId === 'BREAST');

  console.log('\n' + summary());
  process.exit(exitCode());
})().catch(e => { console.error('SUITE ERROR:', e); process.exit(1); });
