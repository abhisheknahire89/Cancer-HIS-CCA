// CCA OS — UI regression: every field a task form constructs must be reachable in
// the DOM. Guards the orphan-field bug class: a field built but never appended to
// the card silently disappears from the UI while the submit handler still reads it
// — values are then always submitted empty. Found live in formSurgery, where
// 'Operative findings' and 'Specimen site' were unreachable (fixed 2026-09-28);
// this test fails on both the render and the submitted-value side if it returns.
// Boots its own server on a fresh DB and drives real Chrome via playwright-core,
// following demo-harness.js conventions (CHROME_PATH, byLabel helper, pageerror
// capture). Run directly: node test/ui-regression-forms.test.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = Number(process.env.UI_REGRESSION_PORT) || 3213;
const BASE = 'http://127.0.0.1:' + PORT;
const API = BASE + '/ws/rest/v1/cca';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.join(__dirname, '..');

let passes = 0, failures = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  ✓ ' + name); }
  else { failures++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 300) : '')); }
}
async function api(p, opts = {}, user) {
  const res = await fetch(API + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-cca-user': user || 'u-onc1' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  return { status: res.status, ...(await res.json()) };
}
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise(r => setTimeout(r, 200));
  }
}
const USER_UUIDS = { 'Surgical Oncologist': 'u-surg' };
async function switchUser(page, role) {
  await page.selectOption('#userSel', USER_UUIDS[role]);
  await page.waitForTimeout(250);
}
function byLabel(page, labelText) {
  // DOM is <div><label>..</label><input/></div> — the field follows its label
  return page.locator(`div:has(> label:has-text("${labelText}")) > *:not(label)`).first();
}
async function clickButton(page, label) {
  await page.click(`button:has-text("${label}")`);
  await page.waitForTimeout(400);
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error('Chrome not found at ' + CHROME + ' — set CHROME_PATH to your Chrome binary.');
    process.exit(2);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-uireg-'));
  process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  const server = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCA_DATA_DIR: dataDir }, stdio: 'pipe'
  });
  await new Promise(r => setTimeout(r, 1500));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000); // fail fast on missing fields instead of hanging
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0].slice(0, 200)));

  try {
    // Seed via the real chain: patient → SIGNED surgical plan → auto SURGERY_RECORD task
    const reg = await api('/patients', { method: 'POST', body: { name: 'Regressia Field', dob: '1970-01-01', sex: 'F', referralSource: 'EXTERNAL_REFERRAL', reason: 'surgery form regression', hospitalUuid: 'h-1' } }, 'u-front');
    check('patient registered', reg.ok && reg.data.patient.uuid, reg.error || reg);
    const pid = reg.data.patient.uuid;
    const plan = await api('/surgical-plans', { method: 'POST', body: { patientUuid: pid, procedure: 'Wide local excision', plannedDate: new Date().toISOString().slice(0, 10) } }, 'u-surg');
    check('surgical plan created', plan.ok, plan.error || plan);
    const signed = await api('/surgical-plans/' + plan.data.uuid + '/sign', { method: 'POST', body: {} }, 'u-surg');
    check('surgical plan signed → SURGERY_RECORD task', signed.ok && signed.data.status === 'SIGNED', signed.error || signed);

    // Open the task through the real UI (worklist → Open)
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await switchUser(page, 'Surgical Oncologist');
    await page.click('.taskrow:has-text("Complete operative record") button:has-text("Open")');
    await page.waitForTimeout(400);

    // THE REGRESSION: fields constructed by formSurgery must exist in the rendered
    // form. Before the fix, 'Operative findings' (textarea) and 'Specimen site'
    // (input) existed only as detached nodes — these two checks failed.
    for (const label of ['Procedure *', 'Laterality', 'Planned date *', 'Operative findings', 'Specimen site']) {
      const visible = await byLabel(page, label).waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
      check('form renders field: ' + label, visible);
    }

    // Fill everything — including the previously-orphaned fields — and submit.
    await byLabel(page, 'Procedure *').fill('Wide local excision, left breast');
    await byLabel(page, 'Laterality').selectOption('LEFT');
    await byLabel(page, 'Operative findings').fill('Complete excision, clear margins (regression probe)');
    await byLabel(page, 'Specimen site').fill('Left breast upper outer quadrant');
    await clickButton(page, 'Sign surgical plan & operative record');

    // Submitted VALUES must reach the record — with the bug, findings/specimen
    // would arrive as '' / [] because the detached nodes were never in the DOM.
    const taskDone = await until(async () => {
      const t = await api('/tasks?bucket=done', {}, 'u-surg');
      return (t.data || []).some(x => x.code === 'SURGERY_RECORD');
    });
    check('task completed via wfComplete', !!taskDone);
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    const rec = db.operativeRecords.filter(r => r.patientUuid === pid).pop();
    check('operative record signed', !!(rec && rec.status === 'SIGNED'));
    check('findings text submitted (not orphan-empty)', !!(rec && rec.findings === 'Complete excision, clear margins (regression probe)'), rec && JSON.stringify(rec.findings));
    check('specimen site submitted (not orphan-empty)', !!(rec && rec.specimens.length === 1 && rec.specimens[0].site === 'Left breast upper outer quadrant'), rec && JSON.stringify(rec.specimens));
    // D1 chain: each submitted specimen must generate a real pathology task
    const specTask = await until(async () => {
      const t = await api('/tasks?bucket=myTasks', {}, 'u-path');
      return (t.data || []).some(x => x.code === 'SURGERY_SPECIMEN' && x.patientUuid === pid);
    });
    check('specimen chain: SURGERY_SPECIMEN task generated from the submitted specimen', !!specTask);
    check('no JavaScript page errors during the run', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close().catch(() => { /* already closed */ });
    server.kill();
  }
  console.log('----------------------------------------');
  console.log('UI FORM REGRESSION — checks passed: ' + passes + '   failed: ' + failures);
  if (failures) process.exit(1);
}
main().catch(e => { console.error('CRASH', e); process.exit(1); });
