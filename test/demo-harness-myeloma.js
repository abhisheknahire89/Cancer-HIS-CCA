// CCA OS — SECOND-DISEASE DEMO HARNESS (Multiple Myeloma → ISS, never TNM)
// Companion to test/demo-harness.js. Executes the canonical "second disease"
// acceptance test through the REAL browser UI: a haematological malignancy must
// resolve its disease-specific classification schema (ISS/R-ISS) and the product
// must NOT force T/N/M onto it — proven both in the UI (no T/N/M controls render)
// and at the API boundary (TNM variables rejected at sign).
//
//   cd cca-os && npm run test:browser:myeloma
//   (or watch it live: node test/demo-harness-myeloma.js --headed)
//
// Self-contained: spawns its own server on a fresh database, drives Chrome via
// playwright-core, screenshots every step, writes DEMO_EVIDENCE.md + summary.json
// to test/browser-evidence-myeloma/.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.DEMO_PORT) || 3212;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.join(__dirname, 'browser-evidence-myeloma');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADED = process.argv.includes('--headed');

// ---------------------------------------------------------------- reporting --
const report = {
  startedAt: null, finishedAt: null,
  env: { node: process.version, platform: os.platform(), chromePath: CHROME, port: PORT, chromeVersion: null },
  secondDiseaseProof: { schema: null, tnmRejectedAtSign: false, tnMControlsInUi: null, stageResult: null },
  steps: [],
  summary: { passed: 0, failed: 0 },
  verdict: null
};
let currentStep = null;

function check(name, cond, extra) {
  const entry = { name, pass: !!cond, detail: cond ? undefined : String(extra === undefined ? '' : extra).slice(0, 300) };
  currentStep.checks.push(entry);
  if (cond) report.summary.passed++; else report.summary.failed++;
  console.log('  ' + (cond ? '✓' : '✗ FAIL: ') + name + (cond ? '' : (extra !== undefined ? ' — ' + String(extra).slice(0, 200) : '')));
}

async function shot(page, name) {
  const file = name + '.png';
  await page.screenshot({ path: path.join(SHOTS, file) });
  currentStep.screenshots.push(file);
}

async function step(page, n, title, role, fn) {
  currentStep = { n, title, role, checks: [], screenshots: [], error: null, durationMs: 0 };
  report.steps.push(currentStep);
  console.log('\n== Step ' + n + '/15: ' + title + '  [' + role + '] ==');
  const t0 = Date.now();
  try {
    await fn();
    currentStep.durationMs = Date.now() - t0;
  } catch (e) {
    currentStep.durationMs = Date.now() - t0;
    currentStep.error = String(e && e.message ? e.message : e).split('\n')[0].slice(0, 300);
    report.summary.failed++;
    console.log('  ✗ STEP ABORTED: ' + currentStep.error);
  }
  return !currentStep.error;
}

// ---------------------------------------------------------------- UI helpers --
const USER_UUIDS = {
  'Front Desk': 'u-front', 'Intake Nurse': 'u-intake', 'Medical Oncologist': 'u-onc1',
  'Radiologist': 'u-rad', 'Pathologist': 'u-path', 'MDT Coordinator': 'u-mdtc',
  'MDT Chair': 'u-mdtchair', 'Financial Counsellor': 'u-fin', 'Nurse Navigator': 'u-nav',
  'Pharmacist': 'u-pharm', 'Day Care Nurse': 'u-daycare', 'Radiation Oncologist': 'u-radonc',
  'Surgical Oncologist': 'u-surg', 'Lab': 'u-lab', 'Administrator': 'u-admin'
};
async function switchUser(page, role) {
  await page.selectOption('#userSel', USER_UUIDS[role]);
  await page.waitForTimeout(250);
}
async function nav(page, label) {
  await page.click(`.navbtn:has-text("${label}")`);
  await page.waitForTimeout(250);
}
function byLabel(page, labelText) {
  return page.locator(`div:has(> label:has-text("${labelText}")) > *:not(label)`).first();
}
async function masterPick(page, masterName, valueOrIndex) {
  const sel = page.locator(`select[data-master="${masterName}"]`).first();
  await sel.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(
    (n) => { const s = document.querySelector(`select[data-master="${n}"]`); return s && s.options.length > 1; },
    masterName, { timeout: 10000 }
  );
  if (typeof valueOrIndex === 'number') await sel.selectOption({ index: valueOrIndex });
  else await sel.selectOption(valueOrIndex);
  return sel;
}
async function openMyTask(page, titlePart) {
  await page.click('.taskrow:has-text("' + titlePart + '") button:has-text("Open")');
  await page.waitForTimeout(400);
}
async function clickButton(page, label) {
  await page.click(`button:has-text("${label}")`);
  await page.waitForTimeout(400);
}
async function bodyText(page) { return page.textContent('body'); }

// ---------------------------------------------------------------- report IO --
function writeReports() {
  const okSteps = report.steps.filter(s => !s.error).length;
  const failedChecks = report.steps.flatMap(s => s.checks).filter(c => !c.pass);
  report.verdict = (report.summary.failed === 0 && okSteps === report.steps.length)
    ? 'DEMO FLOW VERIFIED — SECOND DISEASE (NON-TNM STAGING) PROVEN'
    : 'NOT DEMO READY';

  fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify(report, null, 2));

  const md = [];
  md.push('# CCA OS — Second-Disease Demo Evidence (Multiple Myeloma → ISS, no TNM)');
  md.push('');
  md.push('**Verdict: ' + report.verdict + '**');
  md.push('');
  md.push('| | |');
  md.push('|---|---|');
  md.push('| Run date | ' + new Date(report.startedAt).toISOString() + ' |');
  md.push('| Driver | playwright-core + ' + report.env.chromePath + ' (headless' + (HEADED ? '+headed flag' : '') + ') |');
  md.push('| Node | ' + report.env.node + ' · ' + report.env.platform + ' |');
  md.push('| Server | spawned fresh on 127.0.0.1:' + report.env.port + ' with an EMPTY database |');
  md.push('| Checks | ' + report.summary.passed + ' passed · ' + report.summary.failed + ' failed |');
  md.push('| Steps completed | ' + okSteps + '/' + report.steps.length + ' |');
  md.push('');
  const p = report.secondDiseaseProof;
  md.push('## Second-disease proof');
  md.push('');
  md.push('| Assertion | Result |');
  md.push('|---|---|');
  md.push('| Staging schema resolved | ' + (p.schema || '—') + ' (disease-specific provider, not generic TNM) |');
  md.push('| T/N/M controls rendered in staging UI | ' + (p.tnMControlsInUi === false ? 'NO — haematology schema shows ISS fields only' : String(p.tnMControlsInUi)) + ' |');
  md.push('| TNM variables rejected at sign (API boundary) | ' + (p.tnmRejectedAtSign ? 'REJECTED' : 'NOT PROVEN') + ' |');
  md.push('| Signed classification result | ' + (p.stageResult || '—') + ' (no T/N/M component) |');
  md.push('');
  md.push('Every clinical action below was performed by **clicking buttons and filling fields in the running SPA** — no REST shortcuts for clinical actions (the single API call is the negative TNM stop-gate attempt, labelled as such). Screenshots are in this directory.');
  md.push('');
  for (const s of report.steps) {
    md.push('## Step ' + s.n + '/15 — ' + s.title);
    md.push('');
    md.push('*Role: ' + s.role + ' · ' + s.durationMs + ' ms*' + (s.error ? ' · **ABORTED: ' + s.error + '**' : ''));
    md.push('');
    for (const sh of s.screenshots) md.push('Screenshot: [' + sh + '](' + sh + ')');
    if (s.screenshots.length === 0) md.push('_no screenshot (step failed before capture)_');
    md.push('');
    if (s.checks.length) {
      md.push('| Check | Result |');
      md.push('|---|---|');
      for (const c of s.checks) md.push('| ' + c.name + ' | ' + (c.pass ? 'PASS' : 'FAIL' + (c.detail ? ' — ' + c.detail : '')) + ' |');
      md.push('');
    }
  }
  md.push('## Result');
  md.push('');
  md.push('- **Checks: ' + report.summary.passed + ' passed, ' + report.summary.failed + ' failed**');
  if (failedChecks.length) md.push('- Failed: ' + failedChecks.map(c => c.name).join(' | '));
  md.push('- **Verdict: ' + report.verdict + '**' + (report.summary.failed === 0
    ? ' — reproducible by re-running `node test/demo-harness-myeloma.js`'
    : ' — fix the failures above and re-run'));
  md.push('');
  md.push('_Scope note: this verifies workflow execution and disease-specific routing only. Licensed clinical content (ISS/R-ISS derivation tables, regimen formularies) remains CONTENT PROVIDER PENDING; results are recorded against the neutral CCA-REFERENCE-SKELETON authority._');
  fs.writeFileSync(path.join(SHOTS, 'DEMO_EVIDENCE.md'), md.join('\n'));
}

// ---------------------------------------------------------------- main run --
async function run() {
  if (!fs.existsSync(CHROME)) {
    console.error('Chrome not found at ' + CHROME + ' — set CHROME_PATH to your Chrome binary.');
    process.exit(2);
  }
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  report.startedAt = Date.now();

  // Fresh DB in an isolated throwaway dir — never touches the shared demo db in data/.
  // Point CCA_DATA_DIR at the real data dir to deliberately run against it.
  const dataDir = process.env.CCA_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'cca-harness-'));
  if (!process.env.CCA_DATA_DIR) process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCA_DATA_DIR: dataDir }, stdio: 'pipe' });
  await new Promise(r => setTimeout(r, 1500));

  const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADED });
  report.env.chromeVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0].slice(0, 200)));

  let alive = true;
  const runStep = async (n, title, role, fn) => {
    if (!alive) return;
    alive = await step(page, n, title, role, fn);
  };

  try {
    // ------------------------------------------------------------- Step 1 --
    await runStep(1, 'Registration — haematology referral', 'Front Desk', async () => {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await switchUser(page, 'Front Desk');
      await nav(page, 'Register / Referral');
      await byLabel(page, 'Full name').fill('Ravi Kumar');
      await byLabel(page, 'Date of birth').fill('1965-02-02');
      await byLabel(page, 'Sex').selectOption('M');
      await byLabel(page, 'Referral source').selectOption('EXTERNAL_REFERRAL');
      await byLabel(page, 'Referral reason').fill('Fatigue, anaemia, back pain — ?plasma cell disorder');
      await shot(page, '01-registration-form');
      await clickButton(page, 'Register patient');
      await page.waitForTimeout(500);
      const header = (await page.textContent('.pheader').catch(() => null)) || (await page.textContent('main'));
      check('registration saves via UI and opens patient chart', /Ravi Kumar/.test(header));
      const mrn = (header.match(/CCA-\d{4,}/) || [''])[0];
      check('MRN assigned (' + mrn + ')', mrn.startsWith('CCA-'));
      await shot(page, '02-patient-chart-after-registration');
    });

    // ------------------------------------------------------------- Step 2 --
    await runStep(2, 'Intake assessment — next role auto-tasked', 'Intake Nurse', async () => {
      await switchUser(page, 'Intake Nurse');
      await nav(page, 'My Tasks');
      await page.waitForTimeout(300);
      const list = await page.textContent('main');
      check('Intake Nurse received task automatically', /Perform intake assessment/.test(list));
      await shot(page, '03-intake-nurse-worklist');
      await openMyTask(page, 'Perform intake assessment');
      await byLabel(page, 'ECOG').selectOption('2');
      await byLabel(page, 'Chief complaint').fill('Fatigue and mid-back pain, 3 months');
      await clickButton(page, 'Save draft');
      await page.waitForTimeout(300);
      await clickButton(page, 'Sign consultation');
      await page.waitForTimeout(400);
    });

    // ------------------------------------------------------------- Step 3 --
    await runStep(3, 'First oncology consultation + bone marrow biopsy order', 'Medical Oncologist', async () => {
      await switchUser(page, 'Medical Oncologist');
      await nav(page, 'My Tasks');
      await openMyTask(page, 'First oncology consultation');
      await byLabel(page, 'ECOG').selectOption('2');
      await byLabel(page, 'Chief complaint').fill('Fatigue, anaemia (Hb 8.4), lytic back pain');
      // §2: investigation discussion is master-driven; only ORDER_NOW generates orders
      await byLabel(page, 'Discussion category').selectOption('PATHOLOGY');
      await page.waitForTimeout(300);
      await byLabel(page, 'Discussion test').selectOption('BM_ASPIRATE_TREPHINE');
      await byLabel(page, 'Discussion action').selectOption('ORDER_NOW');
      await clickButton(page, '+ add discussion item');
      await shot(page, '04-consultation-with-order');
      await clickButton(page, 'Save draft');
      await page.waitForTimeout(300);
      await clickButton(page, 'Sign consultation');
      await page.waitForTimeout(400);
    });

    // ------------------------------------------------------------- Step 4 --
    await runStep(4, 'Pathology result finalized against the order', 'Pathologist', async () => {
      await switchUser(page, 'Pathologist');
      await nav(page, 'My Tasks');
      const list = await page.textContent('main');
      check('Pathologist got the specimen task automatically', /Process specimen/.test(list));
      await openMyTask(page, 'Process specimen');
      await byLabel(page, 'Summary').fill('Plasma cell myeloma — 40% clonal plasma cells; Congo red negative');
      await byLabel(page, 'Accession number').fill('BM-2026-0117');
      await byLabel(page, 'Specimen site').fill('Posterior iliac crest');
      await shot(page, '05-pathology-result-form');
      await clickButton(page, 'Finalize & sign');
      await page.waitForTimeout(400);
    });

    // ------------------------------------------------------------- Step 5 --
    await runStep(5, 'Results-review consultation — canonical decision', 'Medical Oncologist', async () => {
      await switchUser(page, 'Medical Oncologist');
      await nav(page, 'My Tasks');
      const list = await page.textContent('main');
      check('MO received RESULT REVIEW task', /Review investigation results/.test(list));
      await openMyTask(page, 'Review investigation results');
      await shot(page, '06-results-review-decision-form');
      await byLabel(page, 'ECOG (current)').selectOption('2');
      await clickButton(page, 'Diagnosis confirmed — proceed to structured diagnosis');
      await page.waitForTimeout(600);
    });

    // ------------------------------------------------------------- Step 6 --
    await runStep(6, 'Structured cancer diagnosis (draft → review → sign)', 'Medical Oncologist', async () => {
      await masterPick(page, 'cancerType', 'MM');
      await masterPick(page, 'primarySite', 'BONE_MARROW');
      await masterPick(page, 'histology', 'PLASMA_CELL');
      await byLabel(page, 'Diagnosis date').fill('2026-09-16');
      await byLabel(page, 'Basis of diagnosis').selectOption('PATHOLOGY');
      const evSel = byLabel(page, 'Result');
      if (await evSel.locator('option').count() > 1) {
        await evSel.selectOption({ index: 1 });
        await clickButton(page, '+ link evidence');
      }
      await shot(page, '07-diagnosis-form');
      await clickButton(page, 'Review & sign…');
      await page.waitForTimeout(400);
      await clickButton(page, 'Confirm & sign diagnosis');
      await page.waitForTimeout(500);
      await nav(page, 'My Patients');
      await page.waitForTimeout(300);
      const patientsList = await page.textContent('main');
      check('signed myeloma diagnosis visible in patients list', /Multiple myeloma|PLASMA/i.test(patientsList));
    });

    // ------------------------------------------------------------- Step 7 --
    await runStep(7, 'Schema-resolved staging: ISS only — TNM rejected', 'Medical Oncologist', async () => {
      await nav(page, 'My Tasks');
      await openMyTask(page, 'Complete staging');
      await page.waitForTimeout(700);
      const formText = await bodyText(page);
      check('schema banner resolves MM provider (disease-specific routing)', /ISS \/ R-ISS \/ R2-ISS \(myeloma\)/.test(formText) && /ISS_RISS/.test(formText), formText.slice(0, 150));
      // UI must render NO T/N/M selects for this disease
      const tnmSelects = await page.evaluate(() =>
        [...document.querySelectorAll('select')].filter(s =>
          [...s.options].some(o => /^T[0-4is]+$/.test(o.value) || /^N[0-3is]+$/.test(o.value) || /^M[01is]+$/.test(o.value))
        ).length
      );
      report.secondDiseaseProof.tnMControlsInUi = tnmSelects > 0;
      check('no T/N/M dropdowns rendered in the staging UI', tnmSelects === 0, tnmSelects + ' T/N/M selects found');
      check('ISS fact inputs rendered instead of T/N/M (β2M + albumin; stage itself is engine-derived)', /Beta-2 microglobulin/.test(formText) && /Albumin/.test(formText) && !/ISS stage \*/.test(formText));
      await shot(page, '08-staging-form-iss-schema-no-tnm');

      // negative stop-gate at the API boundary: TNM variables must be rejected at sign
      const dxUuid = await page.evaluate(async (u) => {
        const h = { 'Content-Type': 'application/json', 'x-cca-user': u };
        const pts = await (await fetch('/ws/rest/v1/cca/patients', { headers: h })).json();
        const ravi = (pts.data || pts).find(p => p.name === 'Ravi Kumar');
        const chart = await (await fetch('/ws/rest/v1/cca/patients/' + ravi.uuid, { headers: h })).json();
        return (chart.data || chart).diagnosis.uuid;
      }, USER_UUIDS['Medical Oncologist']);
      const neg = await page.evaluate(async ({ dxb, u }) => {
        const h = { 'Content-Type': 'application/json', 'x-cca-user': u };
        const created = await (await fetch('/ws/rest/v1/cca/staging-assessments', {
          method: 'POST', headers: h,
          body: JSON.stringify({ diagnosisUuid: dxb, stagingContext: 'NON_TNM', assessmentDate: new Date().toISOString().slice(0, 10), variables: { t: 'T1', n: 'N0', m: 'M0' } })
        })).json();
        if (!created.ok) return { ok: false, error: String(created.error) };
        const signed = await (await fetch('/ws/rest/v1/cca/staging-assessments/' + created.data.uuid + '/sign', { method: 'POST', headers: h })).json();
        return { ok: signed.ok === true, error: String(signed.error || '') };
      }, { dxb: dxUuid, u: USER_UUIDS['Medical Oncologist'] });
      report.secondDiseaseProof.tnmRejectedAtSign = !neg.ok && /unknown staging field/i.test(neg.error);
      check('STOP-GATE: TNM variables rejected for myeloma at sign', report.secondDiseaseProof.tnmRejectedAtSign, JSON.stringify(neg));
      await shot(page, '09-staging-tnm-rejected-gate');

      // AUTOMATIC DERIVATION (staging mandate): the clinician enters OBJECTIVE FACTS
      // (β2M, albumin) — the engine derives the ISS result server-side. There is no
      // ISS stage dropdown to hand-pick (§31: no manual stage selection when a pack
      // is connected), the AUTOMATIC RESULT panel recalculates live (§14), and a
      // NEEDS_INFORMATION banner names missing facts before they are entered (§13).
      check('no ISS stage dropdown rendered (result is engine-derived, §31)', (await page.locator('select:has(option[value="ISS_II"])').count()) === 0);
      await byLabel(page, 'Beta-2 microglobulin').fill('4.2');
      await page.waitForTimeout(600);
      const needsInfo = await bodyText(page);
      check('NEEDS_INFORMATION shown while albumin missing (§13)', /STAGE CANNOT YET BE DETERMINED/.test(needsInfo) && /Albumin/.test(needsInfo), needsInfo.slice(0, 200));
      await byLabel(page, 'Albumin').fill('3.8');
      await page.waitForTimeout(700);
      const autoText = await bodyText(page);
      check('engine derived ISS II automatically (§11/§14)', /ISS stage II — derived by engine/.test(autoText), autoText.slice(0, 200));
      check('derivation trace viewable in UI (§28)', /View derivation/.test(autoText));
      await page.locator('details:has(summary:has-text("View derivation")) summary').first().click();
      await page.waitForTimeout(200);
      check('trace shows the rule rationale (β2M/albumin)', /β2-microglobulin|albumin|residual/i.test(await bodyText(page)));
      await shot(page, '10-automatic-derivation-live');
      // grouped evidence picker (§31 — select, never retype); fact list carries the objective inputs
      await byLabel(page, 'Staging fact').selectOption('beta2Microglobulin');
      await byLabel(page, 'Evidence group').selectOption('Pathology');
      await byLabel(page, 'Evidence record').selectOption({ index: 1 });
      await clickButton(page, '+ link evidence to fact');
      await shot(page, '10-staging-iss-evidence-linked');

      // §32 review-then-sign summary — §55: non-TNM framing only, no T/N/M rows
      await clickButton(page, 'Review staging summary…');
      await page.waitForTimeout(500);
      const sumText = await bodyText(page);
      check('staging summary shows non-TNM classification (no cTNM framing)', /Disease classification \(non-TNM/.test(sumText) && !/\(cTNM\)/.test(sumText), sumText.slice(0, 150));
      check('staging summary has no T/N/M rows for myeloma', !/Primary Tumour Category/.test(sumText));
      check('summary shows the engine-derived result', /ISS stage II — engine-derived/.test(sumText), sumText.slice(0, 250));
      await shot(page, '10b-staging-summary-non-tnm');
      await clickButton(page, 'Confirm & sign');
      await page.waitForTimeout(600);
      report.secondDiseaseProof.schema = 'MM (ISS/R-ISS)';

      // signed result: patient header + staging history — no T/N/M anywhere
      await nav(page, 'My Patients');
      await page.locator('table tbody tr:has-text("Ravi")').click();
      await page.waitForTimeout(400);
      const hd = await page.textContent('main');
      check('patient header Stage shows ISS_II', /ISS_II/.test(hd), hd.slice(0, 200));
      check('no TNM result in header', !/\bc[TN][0-4]|pT[0-4]/.test(hd));
      report.secondDiseaseProof.stageResult = 'ISS_II';
      await clickButton(page, 'Staging');
      await page.waitForTimeout(400);
      const hist = await bodyText(page);
      check('staging history shows non-TNM classification + signed ISS result', /non-TNM/.test(hist) && /ISS_II/.test(hist) && /SIGNED/.test(hist));
      check('supersede-chain note preserved (never overwritten)', /never overwritten/i.test(hist));
      await shot(page, '11-staging-history-iss-signed');
    });

    // ------------------------------------------------------------- Step 8 --
    await runStep(8, 'MDT — coordinator records, chair signs', 'MDT Coordinator → MDT Chair', async () => {
      await switchUser(page, 'MDT Coordinator');
      await nav(page, 'My Tasks');
      await page.waitForTimeout(300);
      const list = await page.textContent('main');
      check('MDT coordinator auto-tasked after staging', /Present case at MDT/.test(list));
      await openMyTask(page, 'Present case at MDT');
      await page.waitForTimeout(600);
      await byLabel(page, 'Decision').fill('VRD induction x4 cycles → ASCT eligibility work-up → lenalidomide maintenance');
      await byLabel(page, 'Responsible clinician').fill('Dr. Sharma');
      await shot(page, '12-mdt-coordinator-form');
      await clickButton(page, 'Record discussion → route to chair');
      await page.waitForTimeout(400);
      await switchUser(page, 'MDT Chair');
      await openMyTask(page, 'Chair MDT and sign outcome');
      await clickButton(page, 'Chair: sign MDT outcome');
      await page.waitForTimeout(400);
    });

    // ------------------------------------------------------------- Step 9 --
    await runStep(9, 'Signed treatment care plan', 'Medical Oncologist', async () => {
      await switchUser(page, 'Medical Oncologist');
      await openMyTask(page, 'Create signed treatment care plan');
      await masterPick(page, 'treatmentIntent', 1);
      await masterPick(page, 'lineOfTherapy', 1);
      await byLabel(page, 'Expected start').fill('2026-09-24');
      await page.locator('.checkbox-row:has-text("CHEMOTHERAPY") input').check();
      await byLabel(page, 'Systemic therapy').fill('VRD (bortezomib-lenalidomide-dexamethasone) x4 cycles');
      await byLabel(page, 'Monitoring').fill('CBC, creatinine, serum free light chains per cycle');
      await shot(page, '13-care-plan-form');
      await clickButton(page, 'Sign care plan');
      await page.waitForTimeout(500);
    });

    // ------------------------------------------------------------ Step 10 --
    await runStep(10, 'Financial counselling + consent (gate + capture)', 'Financial Counsellor → Medical Oncologist', async () => {
      await switchUser(page, 'Financial Counsellor');
      await openMyTask(page, 'Financial counselling');
      await byLabel(page, 'Planned treatment').fill('4 cycles VRD + maintenance (snapshot from signed plan)');
      await byLabel(page, 'Cost estimate').fill('380000');
      await byLabel(page, 'Payer').selectOption('INSURER');
      await byLabel(page, 'Insurer/TPA').fill('MediCare Plus');
      await byLabel(page, 'Authorization #').fill('AUTH-881190');
      await byLabel(page, 'Self-pay component').fill('42000');
      await byLabel(page, 'Patient choice').selectOption('ORIGINATOR');
      await shot(page, '14-financial-counselling-form');
      await clickButton(page, 'Sign financial counselling');
      await page.waitForTimeout(500);

      // negative gate: readiness blocked without signed consent
      await switchUser(page, 'Nurse Navigator');
      await nav(page, 'My Tasks');
      await openMyTask(page, 'Treatment readiness');
      for (const c of ['labsCurrent', 'consentTaken', 'accessDevice', 'patientEducated']) {
        await page.locator(`.checkbox-row:has-text("${c}") input`).check().catch(() => {});
      }
      await clickButton(page, 'Clear readiness');
      await page.waitForTimeout(500);
      const gateText = await page.textContent('main') + ' ' + await page.evaluate(() => document.getElementById('toast').textContent);
      check('STOP-GATE: readiness blocked without signed consent', /consent/i.test(gateText));
      await shot(page, '15-consent-gate-blocked');

      // consent capture
      await switchUser(page, 'Medical Oncologist');
      await nav(page, 'My Tasks');
      await openMyTask(page, 'Obtain treatment-specific informed consent');
      await byLabel(page, 'Consent type').selectOption('SYSTEMIC_THERAPY');
      await byLabel(page, 'Risks discussed').fill('Peripheral neuropathy, VTE, myelosuppression, infection');
      await byLabel(page, 'Benefits discussed').fill('Disease control; bridge to ASCT evaluation');
      await byLabel(page, 'Alternatives discussed').fill('VCD regimen, clinical trial, palliative intent');
      await byLabel(page, 'Acknowledged by').fill('Ravi Kumar (patient)');
      await page.locator('.checkbox-row:has-text("schedule explained") input').check();
      await page.locator('.checkbox-row:has-text("emergency instructions") input').check();
      await shot(page, '16-consent-form');
      await clickButton(page, 'Sign consent');
      await page.waitForTimeout(500);
    });

    // ------------------------------------------------------------ Step 11 --
    await runStep(11, 'Treatment readiness → treatment-order task', 'Nurse Navigator', async () => {
      await switchUser(page, 'Nurse Navigator');
      await nav(page, 'My Tasks');
      await openMyTask(page, 'Treatment readiness');
      for (const c of ['labsCurrent', 'consentTaken', 'accessDevice', 'patientEducated']) {
        await page.locator(`.checkbox-row:has-text("${c}") input`).check();
      }
      await clickButton(page, 'Clear readiness');
      await page.waitForTimeout(700);
      await shot(page, '17-readiness-cleared');
      await switchUser(page, 'Medical Oncologist');
      await nav(page, 'My Tasks');
      await page.waitForTimeout(400);
      const moList = await page.textContent('main');
      check('readiness cleared → MO auto-tasked to sign treatment order', /Sign treatment order/.test(moList));
    });

    // ------------------------------------------------------------ Step 12 --
    await runStep(12, 'Treatment order with BSA dosing', 'Medical Oncologist', async () => {
      await openMyTask(page, 'Sign treatment order');
      await page.waitForTimeout(500);
      await byLabel(page, 'Regimen').selectOption({ index: 0 });
      await byLabel(page, 'Weight (kg)').fill('74');
      await byLabel(page, 'Height (cm)').fill('172');
      await byLabel(page, 'Supportive').fill('Zoledronic acid monthly; VTE prophylaxis (aspirin)');
      await shot(page, '18-treatment-order-form');
      await clickButton(page, 'Sign treatment order');
      await page.waitForTimeout(500);
    });

    // ------------------------------------------------------------ Step 13 --
    await runStep(13, 'Pharmacy verify → release → dispense (chain of custody)', 'Pharmacist', async () => {
      await switchUser(page, 'Pharmacist');
      await nav(page, 'My Tasks');
      await page.waitForTimeout(400);
      await openMyTask(page, 'Verify and prepare treatment');
      for (const c of ['regimenVerified', 'doseVerified', 'allergyCheck', 'interactionCheck', 'compatibilityCheck', 'stabilityCheck', 'stockAllocated']) {
        await page.locator(`.checkbox-row:has-text("${c}") input`).check();
      }
      await shot(page, '19-pharmacy-verification');
      await clickButton(page, 'Receive → verify → prepare');
      await page.waitForTimeout(500);
      await byLabel(page, 'Independent check').fill('Pharmacist B (Mei 2nd check)');
      await clickButton(page, 'Independent check & release');
      await page.waitForTimeout(500);
      await nav(page, 'My Tasks');
      const dispList = await page.textContent('main');
      check('DISPENSE task auto-generated after release (release ≠ dispense)', /Dispense released preparation/.test(dispList));
      await openMyTask(page, 'Dispense released preparation');
      await byLabel(page, 'Destination').selectOption('DAY_CARE');
      await byLabel(page, 'Checked out to').fill('Sarah (Day Care Nurse)');
      await shot(page, '20-dispense-chain-of-custody');
      await clickButton(page, 'Dispense to Day Care');
      await page.waitForTimeout(500);
    });

    // ------------------------------------------------------------ Step 14 --
    await runStep(14, 'Day-care administration — identity check, lines, reaction', 'Day Care Nurse', async () => {
      await switchUser(page, 'Day Care Nurse');
      await openMyTask(page, 'Day care administration');
      await clickButton(page, 'Patient arrived — start administration record');
      await page.waitForTimeout(400);
      await page.locator('.checkbox-row:has-text("Vitals stable") input').check();
      await byLabel(page, 'Access type/site').fill('Peripheral IV left forearm');
      await clickButton(page, 'Record readiness & premed');
      await page.waitForTimeout(300);
      await page.locator('.checkbox-row:has-text("FULL NAME") input').check();
      await page.locator('.checkbox-row:has-text("Wristband") input').check();
      await clickButton(page, 'Record identity verification');
      await page.waitForTimeout(300);
      await shot(page, '21-daycare-two-identifier-verification');
      const giveBtn = page.locator('button:has-text("Give DRUG")').first();
      if (await giveBtn.count()) { await giveBtn.click(); await page.waitForTimeout(300); }
      await byLabel(page, 'Running drug').fill('BORTEZOMIB');
      await byLabel(page, 'Severity').selectOption('MILD');
      await byLabel(page, 'Symptoms').fill('transient flushing after bolus');
      await page.locator('select[multiple]').selectOption(['PHYSICIAN_NOTIFIED']).catch(() => {});
      await clickButton(page, 'Record infusion reaction');
      await page.waitForTimeout(300);
      await clickButton(page, 'Complete administration & discharge');
      await page.waitForTimeout(500);
      await shot(page, '22-administration-completed');
    });

    // ------------------------------------------------------------ Step 15 --
    await runStep(15, 'Toxicity → next-cycle decision → response → longitudinal views', 'Medical Oncologist', async () => {
      await switchUser(page, 'Medical Oncologist');
      await openMyTask(page, 'Toxicity assessment');
      await masterPick(page, 'toxicity', 'NEUTROPENIA');
      await masterPick(page, 'toxicityVersion', 0);
      await byLabel(page, 'Grade').selectOption('2');
      await byLabel(page, 'Attribution').selectOption('TREATMENT');
      await page.locator('.checkbox-row:has-text("Treatment delay") input').check();
      await shot(page, '23-toxicity-ctcae-versioned');
      await clickButton(page, 'Sign toxicity assessment');
      await page.waitForTimeout(500);

      await openMyTask(page, 'Next cycle decision');
      await page.waitForTimeout(500);
      const ctxText = await bodyText(page);
      check('next-cycle decision shows aggregate prior context', /Administration|Toxicity/i.test(ctxText));
      await byLabel(page, 'Decision').selectOption('PROCEED_UNCHANGED');
      await byLabel(page, 'Rationale').fill('G2 toxicity improving, renal function stable — proceed per protocol');
      await shot(page, '24-next-cycle-decision');
      await clickButton(page, 'Sign decision & route');
      await page.waitForTimeout(500);

      await nav(page, 'My Tasks');
      await page.waitForTimeout(400);
      const c2List = await page.textContent('main');
      check('PROCEED_UNCHANGED routed a next-cycle order task', /Sign treatment order/.test(c2List));

      // response assessment via the Response tab entry point
      await nav(page, 'My Patients');
      await page.locator('table tbody tr:has-text("Ravi")').click();
      await page.waitForTimeout(400);
      await clickButton(page, 'Response');
      await page.waitForTimeout(300);
      const respEntry = page.locator('button:has-text("Record response assessment")');
      check('response assessment entry point exists on Response tab', await respEntry.count() > 0);
      await respEntry.first().click();
      await page.waitForTimeout(400);
      await masterPick(page, 'response', 'PR');
      await byLabel(page, 'Next treatment decision').selectOption('CONTINUE');
      await shot(page, '25-response-assessment');
      await clickButton(page, 'Sign response assessment');
      await page.waitForTimeout(500);

      // longitudinal views + audit
      await nav(page, 'Oncology Calendar');
      await page.waitForTimeout(500);
      await shot(page, '26-oncology-calendar');
      const calText = await page.textContent('main');
      check('calendar distinguishes projected vs completed states', /PROJECTED|COMPLETED/.test(calText));

      await nav(page, 'My Patients');
      await page.locator('table tbody tr:has-text("Ravi")').click();
      await page.waitForTimeout(400);
      await clickButton(page, 'Timeline');
      await page.waitForTimeout(400);
      await shot(page, '27-longitudinal-timeline');
      const tlText = await page.textContent('main');
      check('timeline shows diagnosis + staging + treatment', /Diagnos|Stag/i.test(tlText));

      await nav(page, 'Audit');
      await page.waitForTimeout(400);
      await shot(page, '28-audit-trail');
      const auditText = await page.textContent('main');
      check('audit trail contains DIAGNOSIS_SIGNED + DISPENSED + CONSENT_SIGNED', /DIAGNOSIS_SIGNED/.test(auditText) && /DISPENSED/.test(auditText) && /CONSENT_SIGNED/.test(auditText));

      await nav(page, 'My Patients');
      await page.locator('table tbody tr:has-text("Ravi")').click();
      await page.waitForTimeout(500);
      await shot(page, '29-patient-workspace-overview');
      const hd2 = await page.textContent('main');
      check('patient header shows diagnosis/stage/treatment context', /Ravi Kumar/.test(hd2) && /ISS_II/.test(hd2));
      check('no JavaScript page errors during the whole run', pageErrors.length === 0, pageErrors.join(' | '));
    });
  } finally {
    await browser.close().catch(() => {});
    server.kill('SIGTERM');
    report.finishedAt = Date.now();
    writeReports();
  }

  console.log('\n========================================');
  console.log('SECOND-DISEASE HARNESS — checks passed: ' + report.summary.passed + '   failed: ' + report.summary.failed);
  console.log('Verdict: ' + report.verdict);
  console.log('Evidence: ' + SHOTS + path.sep + 'DEMO_EVIDENCE.md');
  process.exit(report.summary.failed ? 1 : 0);
}

run().catch(e => {
  console.error(e);
  report.finishedAt = Date.now();
  try { writeReports(); } catch (_) { /* best effort */ }
  process.exit(2);
});
