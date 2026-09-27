// CCA OS — Treatment UI (frontend seam for the treatment delivery chain)
// Owns the active-treatment task forms: the treatment-order sign form
// (formTreatmentOrder), the pharmacy receive → verify → prepare → release →
// dispense chain (formPharmacy) and the day-care administration form
// (formDayCare), plus the shared wfComplete task-completion helper.
// Loads after app.js and shares its globals (el, api, state, toast, render,
// wrap, fmtDate) — the established calendar-ui.js/staging-ui.js convention.
// Extracted verbatim from app.js (was lines 1350–1568; wfComplete is also used
// by the radiation/surgery forms that remain in app.js).
async function formTreatmentOrder(card, task, chart, done) {
  const plans = chart.carePlans.filter(p => p.status === 'SIGNED');
  const ready = chart.readiness.length > 0;
  if (!plans.length) { card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: treatment order requires a SIGNED care plan.')); return; }
  if (!ready) { card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: treatment readiness must be cleared (finance → readiness) before ordering.')); return; }
  const plan = plans[0];
  const regSel = el('select', {}, ...state.cache.regimens.map(r => el('option', { value: r.code }, r.name + ' (' + r.cycleLengthDays + '-day cycle, v' + r.version + ')')));
  const cycles = el('input', { type: 'number', value: 4, min: 1, max: 12 });
  const weight = el('input', { type: 'number', step: '0.1', placeholder: 'Weight (kg) *' });
  const height = el('input', { type: 'number', step: '0.1', placeholder: 'Height (cm) *' });
  const start = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const supportive = el('input', { placeholder: 'Supportive treatment (G-CSF etc.)' });
  const redPct = el('input', { type: 'number', placeholder: 'Reduction % (optional)' });
  const redWhy = el('input', { placeholder: 'Reduction reason (required if % set)' });
  card.append(el('div', { class: 'grid3' }, wrap('Regimen *', regSel), wrap('Planned cycles *', cycles), wrap('Start date *', start)),
    el('div', { class: 'grid3' }, wrap('Weight (kg) *', weight), wrap('Height (cm) *', height), wrap('Supportive', supportive)),
    el('div', { class: 'grid2' }, wrap('Dose reduction %', redPct), wrap('Reduction reason', redWhy)));
  card.append(el('button', {
    class: 'btn', onclick: async () => {
      try {
        const order = await api('/treatment-orders', { method: 'POST', body: {
          patientUuid: chart.patient.uuid, carePlanUuid: plan.uuid,
          regimenCode: regSel.value, plannedCycles: Number(cycles.value),
          weight: Number(weight.value), height: Number(height.value), startDate: start.value,
          supportiveTreatment: supportive.value,
          reductions: redPct.value ? [{ medication: 'DOXORUBICIN', reductionPercent: redPct.value, reason: redWhy.value }] : []
        }});
        await api('/treatment-orders/' + order.uuid + '/sign', { method: 'POST', body: {} });
        toast('Treatment order signed — pharmacy task generated + calendar projected');
        await done();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Sign treatment order'));
}

function formPharmacy(card, task, chart) {
  // pharmacist queue for this patient — status-aware so no task is a dead-end:
  // ORDERED→receive/verify/prepare · PREPARED→release+dispense · RELEASED→dispense only
  const rows = (chart.pharmacy || []).filter(r => task.code === 'DISPENSE' ? r.status !== 'REJECTED' : (r.status !== 'REJECTED' && r.status !== 'DISPENSED'));
  if (!rows.length) {
    // no pharmacy record yet: the signed treatment order is awaiting receipt
    const signed = (chart.treatmentOrders || []).find(o => o.status === 'SIGNED');
    if (!signed) { card.append(el('div', { class: 'muted' }, 'Nothing awaiting pharmacy for this patient.')); return; }
    rows.push({ orderUuid: signed.uuid, status: 'ORDERED', awaitingReceipt: true });
  }
  const rec = task.code === 'DISPENSE'
    ? (rows.find(r => r.status === 'RELEASED') || rows[0])
    : rows[0];
  const order = chart.treatmentOrders.find(o => o.uuid === rec.orderUuid);
  card.append(el('div', { class: 'prov' }, 'Order: ' + (order ? order.regimenName + ' — ' + order.cycleDays.length + ' planned administrations' : '')));
  const checks = {};
  for (const c of ['regimenVerified', 'doseVerified', 'allergyCheck', 'interactionCheck', 'compatibilityCheck', 'stabilityCheck', 'stockAllocated']) {
    checks[c] = el('input', { type: 'checkbox' });
    card.append(el('div', { class: 'checkbox-row' }, checks[c], el('span', {}, c)));
  }
  // DISPENSE task: standalone dispense panel (release already done)
  if (task.code === 'DISPENSE') {
    if (rec.status === 'DISPENSED') {
      card.append(el('div', { class: 'prov' }, '✓ Already dispensed (chain of custody recorded) — closing the dispense task.'));
      card.append(el('button', { class: 'btn', onclick: () => wfComplete(task) }, 'Close dispense task'));
      return;
    }
    if (rec.status !== 'RELEASED') { card.append(el('div', { class: 'muted' }, 'Preparation not yet RELEASED — release task must complete first.')); return; }
    const orderD = chart.treatmentOrders.find(o => o.uuid === rec.orderUuid);
    card.append(el('div', { class: 'prov' }, 'Released by: independent check ' + (rec.independentCheckBy || '—') + ' · Order: ' + (orderD ? orderD.regimenName : '')));
    const destD = el('select', {}, ...['DAY_CARE', 'INPATIENT', 'HOME_THERAPY'].map(v => el('option', { value: v }, v)));
    const custD = el('input', { placeholder: 'Checked out to (receiving person) *' });
    card.append(wrap('Destination *', destD), wrap('Checked out to *', custD));
    card.append(el('button', {
      class: 'btn', onclick: async () => {
        try {
          await api('/pharmacy/' + rec.uuid + '/dispense', { method: 'POST', body: { destination: destD.value, checkedOutTo: custD.value } });
          toast('Dispensed — chain of custody recorded; Day Care task generated');
          await wfComplete(task);
        } catch (e) { toast(e.error, true); }
      }
    }, 'Dispense to Day Care'));
    return;
  }
  const verifyBtn = el('button', {
    class: 'btn', onclick: async () => {
      try {
        if (rec.status === 'ORDERED') await api('/pharmacy/receive', { method: 'POST', body: { orderUuid: rec.orderUuid } });
        const all = await api('/pharmacy/queue');
        const mine = all.find(r => r.orderUuid === rec.orderUuid && r.status !== 'RELEASED');
        await api('/pharmacy/' + mine.uuid + '/verify', { method: 'POST', body: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.checked])) });
        await api('/pharmacy/' + mine.uuid + '/prepare', { method: 'POST', body: { compounded: false, notes: 'Standard preparation' } });
        const indep = el('input', { placeholder: 'Independent check by (2nd pharmacist) *' });
        card.append(wrap('Independent check *', indep));
        card.append(el('button', {
          class: 'btn', onclick: async () => {
            try {
              await api('/pharmacy/' + mine.uuid + '/release', { method: 'POST', body: { independentCheckBy: indep.value } });
              toast('Released — dispense step now required');
              // D3: dispense step (release ≠ dispense)
              card.innerHTML = '';
              card.append(el('div', { class: 'prov' }, 'Dispense the released preparation — chain of custody is recorded.'));
              const dest = el('select', {}, ...['DAY_CARE', 'INPATIENT', 'HOME_THERAPY'].map(v => el('option', { value: v }, v)));
              const custodian = el('input', { placeholder: 'Checked out to (receiving person) *' });
              card.append(wrap('Destination *', dest), wrap('Checked out to *', custodian));
              card.append(el('button', {
                class: 'btn', onclick: async () => {
                  try {
                    await api('/pharmacy/' + mine.uuid + '/dispense', { method: 'POST', body: { destination: dest.value, checkedOutTo: custodian.value } });
                    toast('Dispensed — Day Care administration task generated');
                    await wfComplete(task);
                  } catch (e) { toast(e.error, true); }
                }
              }, 'Dispense to Day Care'));
            }
            catch (e) { toast(e.error, true); }
          }
        }, 'Independent check & release'));
      } catch (e) { toast(e.error, true); }
    }
  }, 'Receive → verify → prepare');
  card.append(verifyBtn);
}

async function wfComplete(task) {
  if (task.uuid) { try { await api('/tasks/' + task.uuid + '/complete', { method: 'POST', body: { outcome: 'released to day care' } }); } catch (e) { /* already completed */ } }
  state.view = { name: 'worklist' };
  render();
}

function formDayCare(card, task, chart, done) {
  const rec = (chart.pharmacy || []).find(r => r.status === 'DISPENSED');
  if (!rec) {
    const gate = (chart.pharmacy || []).find(r => r.status === 'RELEASED');
    card.append(el('div', { class: 'stopgate' }, gate
      ? 'STOP-GATE: preparation is RELEASED but not yet DISPENSED — pharmacy must dispense (chain of custody) before administration.'
      : 'STOP-GATE: administration requires a DISPENSED treatment order. Release ≠ dispense; preparation is not administration.'));
    return;
  }
  const disp = (chart.dispenses || []).find(d => d.pharmacyUuid === rec.uuid);
  if (disp) card.append(el('div', { class: 'prov' }, 'Dispensed ' + disp.destination + ' → ' + disp.checkedOutTo + ' by ' + disp.dispensedByName));
  const order = chart.treatmentOrders.find(o => o.uuid === rec.orderUuid);
  const status = el('div', {});
  let adm = null;
  const startBtn = el('button', {
    class: 'btn', onclick: async () => {
      try {
        adm = await api('/administrations/start', { method: 'POST', body: { pharmacyUuid: rec.uuid } });
        renderSteps();
      } catch (e) { toast(e.error, true); }
    }
  }, 'Patient arrived — start administration record');

  const renderSteps = () => {
    status.innerHTML = '';
    const vitals = el('input', { type: 'checkbox' }); const access = el('input', { type: 'checkbox' });
    status.append(el('div', { class: 'checkbox-row' }, vitals, el('span', {}, 'Vitals stable (readiness)')));
    status.append(el('div', { class: 'checkbox-row' }, access, el('span', {}, 'Vascular access confirmed')));
    status.append(wrap('Access type/site', el('input', { id: 'accessSite', placeholder: 'e.g. PICC right arm' })));
    status.append(el('button', {
      class: 'btn small', onclick: async () => {
        await api('/administrations/' + adm.uuid + '/update', { method: 'POST', body: { readiness: { vitalsStable: vitals.checked, premedicationsGiven: true }, access: { type: 'PICC', site: document.getElementById('accessSite').value }, status: 'IN_PROGRESS' } });
        toast('Readiness + premed recorded');
      }
    }, 'Record readiness & premed'));
    // D10a: two-identifier patient verification before first drug
    status.append(el('h3', {}, 'Patient identity verification (two identifiers)'));
    const idName = el('input', { type: 'checkbox' }); const idMrn = el('input', { type: 'checkbox' });
    status.append(el('div', { class: 'checkbox-row' }, idName, el('span', {}, 'Patient stated FULL NAME and it matches: ' + chart.patient.name)));
    status.append(el('div', { class: 'checkbox-row' }, idMrn, el('span', {}, 'Wristband/file MRN matches: ' + chart.patient.mrn)));
    const verifyBtn = el('button', {
      class: 'btn small', onclick: async () => {
        try {
          await api('/administrations/' + adm.uuid + '/update', { method: 'POST', body: { patientIdentityVerification: { method: 'TWO_IDENTIFIER', nameConfirmation: idName.checked, mrnConfirmation: idMrn.checked } } });
          toast('Two-identifier verification recorded');
        } catch (e) { toast(e.error, true); }
      }
    }, 'Record identity verification');
    status.append(verifyBtn);
    // drug lines from order
    const today = new Date().toISOString().slice(0, 10);
    const todaysLines = order.cycleDays.filter(c => c.plannedDate <= today && (c.status === 'PROJECTED' || c.status === 'DELAYED'));
    status.append(el('h3', {}, "Today's scheduled lines"));
    for (const l of todaysLines.slice(0, 6)) {
      const given = el('button', {
        class: 'btn small secondary', style: 'margin-right:6px', onclick: async () => {
          await api('/administrations/' + adm.uuid + '/update', { method: 'POST', body: { line: { phase: l.phase, medication: l.medication, start: new Date().toISOString(), stop: new Date(Date.now() + 60 * 60000).toISOString(), actualDose: l.orderedDose, route: l.route, rate: l.infusionRate || null, interruption: null, reaction: null } } });
          toast(l.medication + ' administered');
        }
      }, 'Give ' + l.phase + ': ' + l.medication + ' ' + l.orderedDose + ' ' + l.doseUnits);
      status.append(given);
    }
    // D10a: structured infusion reaction workflow
    status.append(el('h3', {}, 'Infusion reaction (structured)'));
    const rxDrug = el('input', { placeholder: 'Running drug' });
    const rxSev = el('select', {}, ...['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'].map(v => el('option', { value: v }, v)));
    const rxSym = el('input', { placeholder: 'Symptoms (comma-separated)' });
    const rxActions = el('select', { multiple: true, size: 4 }, ...['STOP_INFUSION', 'RESCUE_MEDICATION', 'PHYSICIAN_NOTIFIED', 'IV_FLUIDS', 'OXYGEN'].map(v => el('option', { value: v }, v)));
    status.append(el('div', { class: 'grid3' }, wrap('Running drug', rxDrug), wrap('Severity *', rxSev), wrap('Symptoms *', rxSym)),
      wrap('Actions taken (ctrl-click multi) *', rxActions));
    status.append(el('button', {
      class: 'btn small danger', onclick: async () => {
        try {
          const r = await api('/infusion-reactions', { method: 'POST', body: {
            administrationUuid: adm.uuid, runningDrug: rxDrug.value, severity: rxSev.value,
            symptoms: rxSym.value.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ symptom: s })),
            actions: Array.from(rxActions.selectedOptions || []).map(o => o.value), onsetTime: new Date().toISOString()
          }});
          toast('Infusion reaction recorded (' + r.severity + ') — physician notification task generated if notified');
        } catch (e) { toast(e.error, true); }
      }
    }, 'Record infusion reaction'));
    status.append(el('button', {
      class: 'btn', onclick: async () => {
        try {
          await api('/administrations/' + adm.uuid + '/complete', { method: 'POST', body: {} });
          toast('Administration completed — toxicity & next-cycle review tasks generated');
          await done();
        } catch (e) { toast(e.error, true); }
      }
    }, 'Complete administration & discharge'));
  };
  card.append(startBtn, status);
}
