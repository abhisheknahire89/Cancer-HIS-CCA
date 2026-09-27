// CCA OS — Licensed AJCC adapter WIRE-path tests
// The unit suite (ajcc-adapter.test.js) drives an injected transport; THIS suite
// exercises the adapter's DEFAULT fetch transport over real HTTP against a local
// stub server, with the production credential contract (env credentials + ACTIVE
// licence record, base URL at the stub). Proven over the wire:
//   connect → fetch → validate → register → breast cTNM derivation with licensed
//   provenance → the unchanged sign gate; and the fail-closed branches —
//   connection refused, HTTP error status, non-JSON body, invalid pack payload —
//   with the registry untouched in each.
// Shared fixture: ajcc-adapter-fixture.js.
'use strict';
const fixture = require('./ajcc-adapter-fixture');
const { check, expectErrorAsync, summary, exitCode, dateStr, licensedPack, setupBreastFixture } = fixture;

const http = require('http');
const engine = require('../src/staging-engine');
const ajcc = require('../src/ajcc');
const adapter = require('../src/ajcc-adapter');
const clinical = require('../src/clinical');
const providers = require('../src/staging-providers');

const { ADMIN, MO, dx } = setupBreastFixture();

// ---- stub AJCC API server (records the credential header it receives) -------
let hits = 0;
let lastAuth = null;
let lastAccept = null;
let mode = 'valid'; // valid | xml | invalid-pack | status503
const stub = http.createServer((req, res) => {
  hits++;
  lastAuth = req.headers.authorization || null;
  lastAccept = req.headers.accept || null;
  if (mode === 'status503') { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('service unavailable'); return; }
  if (mode === 'xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end('<ajcc>not json</ajcc>'); return; }
  if (mode === 'invalid-pack') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ packId: 'BAD_WIRE_PACK', authority: 'AJCC', providerKey: 'TNM_BREAST', schemaId: 'BREAST', version: 'v', effectiveFrom: '2017-01-01', provenance: 'p', classifications: ['CLINICAL'], categoryRules: { tCategory: [{ id: 'R1', priority: 1, conditions: { op: 'HACK', key: 'x' }, output: 'T1' }] } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(licensedPack());
});

(async () => {
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const baseUrl = 'http://127.0.0.1:' + port;

  // production credential contract: env credentials + ACTIVE licence record
  process.env.AJCC_PROVIDER = 'api';
  process.env.AJCC_API_BASE_URL = baseUrl;
  process.env.AJCC_API_KEY = 'wire-test-key';
  ajcc.upsertLicense(ADMIN, { publisher: 'American College of Surgeons', contentName: 'AJCC Cancer Staging System', version: 'API 02.03.00', status: 'ACTIVE' });

  console.log('\n== happy path over real HTTP: connect → fetch → validate → register ==');
  mode = 'valid';
  const connected = await adapter.connectLicensedAjcc({ actor: ADMIN });   // NO injected transport — the default fetch runs
  check('connect succeeds through the default transport', connected && connected.connected && connected.status === 'ACTIVE' && connected.packId === 'AJCC_BREAST_CTNM_LICENSED_POC');
  check('stub actually received the request', hits === 1);
  check('credentials flowed over the wire (Authorization: APIKEY …)', lastAuth === 'APIKEY wire-test-key', 'got: ' + lastAuth);
  check('spec-discovery Accept header sent', lastAccept === 'application/xml', 'got: ' + lastAccept);
  check('registered from LICENSED_AJCC_API source', engine.packsSnapshot().some(p => p.packId === connected.packId && p.source === 'LICENSED_AJCC_API' && p.status === 'ACTIVE'));
  check('provenance stamped as licensed API content', /Licensed AJCC API content/.test(connected.provenance));

  console.log('\n== licensed derivation + unchanged sign gate, using the wire-fetched pack ==');
  const pack = engine.packFor('TNM_BREAST', 'BREAST');
  check('packFor resolves the wire-fetched pack for breast', pack && pack.packId === 'AJCC_BREAST_CTNM_LICENSED_POC');
  const FACTS = { tumourSizeMm: 28, chestWallInvolvement: false, skinInvolvement: false, distantMetastasis: false, clinicalNodalStatus: 'NODES_MOBILE_1_3' };
  const schema = providers.resolveProvider(dx).provider.resolveSchema(dx).fields;
  const d1 = engine.evaluate(schema, pack, { classification: 'CLINICAL', variables: FACTS });
  check('CALCULATED: T2 N1 cM0 → Stage IIB from objective facts', d1.status === 'CALCULATED' && d1.categories.tCategory === 'T2' && d1.categories.nCategory === 'N1' && d1.categories.mCategory === 'cM0' && d1.result === 'STAGE_IIB');
  check('trace carries licensed provenance from the fetched content', d1.packId === connected.packId && /Licensed AJCC API content/.test(d1.provenance));

  const a = clinical.createStagingAssessment(MO, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(0),
    variables: Object.assign({}, FACTS), resultSource: 'AUTOMATIC_ENGINE'
  });
  const signed = clinical.signStagingAssessment(MO, a.uuid);
  check('sign gate accepts and stores the wire-derived stage + trace', signed.status === 'SIGNED' && signed.stageResult === 'STAGE_IIB' && signed.derivationTrace && signed.derivationTrace.status === 'CALCULATED');
  const tampered = clinical.createStagingAssessment(MO, {
    diagnosisUuid: dx.uuid, stagingContext: 'CLINICAL', assessmentDate: dateStr(0),
    variables: Object.assign({}, FACTS, { stageResult: 'STAGE_IA' }), resultSource: 'AUTOMATIC_ENGINE'
  });
  await expectErrorAsync('tampered result refused by the unchanged gate',
    () => clinical.signStagingAssessment(MO, tampered.uuid), 'must match the engine-derived result');

  console.log('\n== fail-closed branches over real HTTP (registry must stay untouched) ==');
  const licensedCount = () => engine.packsSnapshot().filter(p => p.source === 'LICENSED_AJCC_API').length;
  const baseline = licensedCount();

  mode = 'status503';
  await expectErrorAsync('HTTP error status → CCA_AJCC_FETCH_FAILED with status',
    () => adapter.connectLicensedAjcc({ actor: ADMIN }), 'CCA_AJCC_FETCH_FAILED');
  check('503 branch left registry untouched', licensedCount() === baseline);

  mode = 'xml';
  await expectErrorAsync('non-JSON body → CCA_AJCC_FETCH_FAILED (not valid JSON)',
    () => adapter.connectLicensedAjcc({ actor: ADMIN }), 'not valid JSON');
  check('non-JSON branch left registry untouched', licensedCount() === baseline);

  mode = 'invalid-pack';
  await expectErrorAsync('invalid pack payload → CCA_AJCC_FETCH_FAILED (pack validation)',
    () => adapter.connectLicensedAjcc({ actor: ADMIN }), 'pack validation');
  check('invalid-pack branch left registry untouched', licensedCount() === baseline);

  // connection refused: point the credential contract at a closed port
  const dead = http.createServer();
  const deadPort = await new Promise(r => { dead.listen(0, '127.0.0.1', () => { const p = dead.address().port; dead.close(() => r(p)); }); });
  process.env.AJCC_API_BASE_URL = 'http://127.0.0.1:' + deadPort;
  await expectErrorAsync('connection refused → CCA_AJCC_FETCH_FAILED (unreachable), never a raw fetch error',
    () => adapter.connectLicensedAjcc({ actor: ADMIN }), 'unreachable');
  check('connection-refused branch left registry untouched', licensedCount() === baseline);
  check('failures after connect never duplicated the licensed pack', licensedCount() === 1);

  stub.close();
  console.log('\n' + summary());
  process.exit(exitCode());
})().catch(e => { console.error('SUITE ERROR:', e); process.exit(1); });
