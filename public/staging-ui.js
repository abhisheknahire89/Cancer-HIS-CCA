// CCA OS — Staging UI (frontend seam matching src/staging.js)
// Owns the staging user interface: the Staging chart tab, the staging task form
// (schema resolution, dynamic inputs, evidence suggestions/picker, derivation
// view, §32 summary, sign) and the §31 flag-discrepancy modal. Loads after
// app.js and shares its globals (el, api, state, toast, render, wrap, fmtDate)
// — the established calendar-ui.js convention.
// tabStaging + el2s extracted verbatim from app.js (was lines 605–676);
// flagStagingDiscrepancyModal + formStaging (was lines 1250–1667).
async function tabStaging(body, chart) {
  // §33/§35: CURRENT per-classification summary first, then full history
  let summary = null;
  try { summary = await api('/staging/summary/' + chart.patient.uuid); } catch (e) { /* read-only */ }
  const cur = el('div', { class: 'card' });
  cur.append(el('h2', {}, 'CURRENT — staging per classification'));
  const clsRows = [['clinical', 'Clinical Stage'], ['pathological', 'Pathological Stage'], ['posttherapyClinical', 'Posttherapy Clinical Stage'], ['posttherapyPathological', 'Posttherapy Pathological Stage'], ['recurrence', 'Recurrence / Restaging'], ['nonTnm', 'Disease Classification']];
  let any = false;
  if (summary) {
    for (const [key, label] of clsRows) {
      if (!summary[key]) continue;
      any = true;
      cur.append(el('div', { class: 'prov' },
        el('b', {}, label + ':'), ' ' + (summary[key].stage || '—') +
        ' · ' + (summary[key].authority || '—') + ' ' + (summary[key].version || '') +
        ' · signed ' + fmtDate(summary[key].signedAt)));
    }
  }
  if (!any) cur.append(el('div', { class: 'muted' }, chart.diagnosis ? 'No signed staging yet — staging requires a signed diagnosis (stop-gate).' : 'Requires signed diagnosis first.'));
  body.append(cur);

  const c = el('div', { class: 'card' });
  c.append(el('h2', {}, 'STAGING HISTORY (supersede chain — never overwritten)'));
  const h = chart.staging.history || [];
  let results = [];
  try { results = await api('/results?patientUuid=' + chart.patient.uuid); } catch (e) { /* read-only */ }
  if (!h.length) c.append(el('div', { class: 'muted' }, 'No assessments recorded.'));
  for (const s of h) {
    const prefix = s.classificationPrefix || { PATHOLOGICAL: 'p', POSTTHERAPY_CLINICAL: 'yc', POSTTHERAPY_PATHOLOGICAL: 'yp', RECURRENCE_RETREATMENT: 'r', AUTOPSY: 'a' }[s.stagingContext] || 'c';
    // §55: non-TNM classifications must never be labelled with TNM framing
    const ctxLabel = s.stagingContext === 'NON_TNM' ? 'Disease classification (non-TNM)' : s.stagingContext + ' (' + prefix + 'TNM)';
    const row = el('div', { class: 'prov' },
      el('b', {}, ctxLabel), ' · ' + s.diseaseSite + ' · result: ' + el2s(s.stageResult) +
      ' · authority ' + s.stagingAuthority + ' v' + s.authorityVersion +
      ' · ' + fmtDate(s.assessmentDate) + ' · ' + s.clinicianName + ' ',
      el('span', { class: 'badge ' + s.status }, s.status));
    // §31: disagreement is recorded, never hand-edited — the signed result carries a
    // visible flag action for the oncologist.
    if (s.status === 'SIGNED' && s.stageResult && state.user.role === 'Medical Oncologist') {
      row.append(el('button', { class: 'btn small secondary', style: 'margin-left:6px', onclick: () => flagStagingDiscrepancyModal(s) }, 'Flag discrepancy'));
    }
    c.append(row);
    const openFlags = (chart.staging.discrepancyFlags || []).filter(f => f.stagingAssessmentUuid === s.uuid);
    for (const f of openFlags) {
      c.append(el('div', { class: 'stopgate', style: 'margin-left:12px' },
        'DISCREPANCY FLAG (' + f.status + ', ' + f.flaggedByName + ', ' + fmtDate(f.flaggedAt) + '): ' + f.reason +
        ' — requested correction: ' + f.requestedCorrection + (f.resolvedByAssessmentUuid ? ' · resolved by corrected staging' : '')));
    }
    for (const ev of s.evidence || []) {
      const src = results.find(r => r.uuid === (ev.sourceRef || ev.resultUuid));
      const evLine = el('div', { style: 'font-size:12px;color:#555;margin-left:12px' },
        '· ' + (ev.variableKey || 'general') + ' ← ' + ev.sourceType + (ev.supportingFinding ? ' — ' + ev.supportingFinding : '') + (ev.sourceDate ? ' (' + fmtDate(ev.sourceDate) + ')' : '') + ' ');
      // D7: VIEW SOURCE — opens the exact signed evidence record
      if (src) {
        evLine.append(el('button', {
          class: 'btn small secondary', style: 'margin-left:6px', onclick: () => {
            const modal = el('div', { class: 'card', style: 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:560px;max-height:70vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
            modal.append(el('h3', {}, 'SOURCE — ' + src.category + ': ' + src.test),
              el('div', { class: 'prov' }, 'Status: ' + src.status + ' · finalized ' + fmtDate(src.finalizedAt) + ' by ' + src.byName));
            modal.append(el('pre', { style: 'white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:8px;border-radius:6px' },
              (src.summary || '') + '\n\n' + (src.details ? JSON.stringify(src.details, null, 2) : '')));
            modal.append(el('button', { class: 'btn small', onclick: () => modal.remove() }, 'Close source'));
            document.body.append(modal);
          }
        }, 'VIEW SOURCE'));
      }
      c.append(evLine);
    }
  }
  body.append(c);
}
function el2s(x) { return x === undefined || x === null ? '—' : String(x); }
// §31 Flag discrepancy: record WHY the clinician disagrees with a signed (engine-derived)
// result and WHAT correction is requested. The signed record itself is immutable; the
// flag routes a review task to the oncologist, and the corrected facts re-derive the
// result through a superseding signed assessment.
function flagStagingDiscrepancyModal(s) {
  const modal = el('div', { class: 'card', style: 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:560px;max-height:80vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
  const reason = el('input', { placeholder: 'e.g. node status derived as N0, but palpable nodes were documented in the exam' });
  const correction = el('input', { placeholder: 'e.g. re-check nodal finding; re-derive N from the exam record' });
  modal.append(el('h3', {}, 'FLAG STAGING DISCREPANCY — result: ' + el2s(s.stageResult)),
    el('div', { class: 'prov' }, 'The signed result is immutable and cannot be edited. The flag records your disagreement, routes a review task to the oncologist, and the corrected facts re-derive the result in a superseding assessment.'),
    wrap('Discrepancy reason *', reason),
    wrap('Requested correction *', correction),
    el('div', { style: 'display:flex;gap:8px;margin-top:8px' },
      el('button', { class: 'btn', onclick: async () => {
        try {
          await api('/staging-assessments/' + s.uuid + '/flag', { method: 'POST', body: { reason: reason.value, requestedCorrection: correction.value } });
          toast('Discrepancy flagged — review task routed to the oncologist');
          modal.remove(); render();
        } catch (e) { toast(e.error || e.message, true); }
      } }, 'Record flag'),
      el('button', { class: 'btn secondary', onclick: () => modal.remove() }, 'Cancel')));
  document.body.append(modal);
}

async function formStaging(card, task, chart, done) {
  if (!chart.diagnosis) {
    card.append(el('div', { class: 'stopgate' }, 'STOP-GATE: staging requires a confirmed (signed) diagnosis. This assessment cannot be created.'));
    return;
  }
  const dx = chart.diagnosis;
  let schema;
  try { schema = await api('/staging/schema/' + dx.uuid); }
  catch (e) { card.append(el('div', { class: 'stopgate' }, e.error)); return; }

  // §21 read-only header: authority / schema / version are RESOLVED BY THE SERVER
  // from the diagnosis — the clinician never picks a pack. contentStatus is shown
  // honestly (AUTHORITY_CONTENT_UNAVAILABLE without licensed content).
  card.append(el('div', { class: 'card' },
    el('h3', {}, 'Staging authority (resolved from diagnosis — read only)'),
    el('div', { class: 'kv' },
      el('div', { class: 'k' }, 'Diagnosis'), el('div', {}, dx.cancerTypeLabel + ' · ' + (dx.histologyLabel || dx.histology) + ' · ' + fmtDate(dx.diagnosisDate)),
      el('div', { class: 'k' }, 'Primary site'), el('div', {}, dx.primarySiteLabel || dx.primarySite || '—'),
      el('div', { class: 'k' }, 'Staging authority'), el('div', {}, schema.authority),
      el('div', { class: 'k' }, 'Schema'), el('div', {}, schema.schemaName || schema.schemaId || schema.providerKey),
      el('div', { class: 'k' }, 'Applicable version'), el('div', {}, schema.version + (schema.effectiveFrom ? ' (effective ' + fmtDate(schema.effectiveFrom) + ')' : '')),
      el('div', { class: 'k' }, 'Content status'), el('div', {}, schema.contentStatus || 'UNKNOWN'))));
  if (schema.notice) card.append(el('div', { class: 'stopgate' }, schema.notice + ' Version routing continues from public AJCC metadata (' + (schema.sourceReference || '') + ').'));
  // §2/§30 classification selector — mandatory enum; AUTOPSY is in the model but
  // not offered in the routine active-treatment UI (§10). Non-TNM schemas (ISS,
  // FIGO, Lugano…) get the alternative-classification option instead of TNM ones.
  const isNonTnmSchema = !['t', 'n', 'm'].every(k => schema.fields.some(f => f.key === k));
  const CLS_OPTS = isNonTnmSchema
    ? [{ code: 'NON_TNM', label: 'Disease classification (non-TNM — provider resolved)' }]
    : [
        { code: 'CLINICAL', prefix: 'c', label: 'Clinical (cTNM)' },
        { code: 'PATHOLOGICAL', prefix: 'p', label: 'Pathological (pTNM)' },
        { code: 'POSTTHERAPY_CLINICAL', prefix: 'yc', label: 'Posttherapy clinical (ycTNM)' },
        { code: 'POSTTHERAPY_PATHOLOGICAL', prefix: 'yp', label: 'Posttherapy pathological (ypTNM)' },
        { code: 'RECURRENCE_RETREATMENT', prefix: 'r', label: 'Recurrence / retreatment (rTNM)' }
      ];
  const ctxSel = el('select', {}, ...CLS_OPTS.filter(c => schema.contexts.includes(c.code)).map(c => el('option', { value: c.code }, c.label)));
  const aDate = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  // Slice E: a PATHOLOGICAL_STAGING task pins the classification (p or yp) derived from
  // the real treatment history. Prior signed assessments are shown read-only — they are
  // NEVER overwritten; this opens a separate assessment. pT/pN/pM are never pre-filled:
  // the clinician enters them from the final histopathology evidence.
  const restageCls = task && task.payload && ['PATHOLOGICAL', 'POSTTHERAPY_PATHOLOGICAL'].includes(task.payload.classification) ? task.payload.classification : null;
  if (restageCls) {
    if ([...ctxSel.options].some(o => o.value === restageCls)) ctxSel.value = restageCls;
    const prior = (chart.staging.history || []).filter(s => s.status === 'SIGNED');
    const prefix = restageCls === 'POSTTHERAPY_PATHOLOGICAL' ? 'yp' : 'p';
    card.append(el('div', { class: 'stopgate' },
      'PATHOLOGICAL RESTAGING (' + prefix + 'TNM) — ' + (task.payload.reason || 'final histopathology available') +
      '. Enter ' + prefix + 'T/' + prefix + 'N/' + prefix + 'M from the final histopathology and linked evidence. ' +
      (prior.length ? 'Prior signed assessment(s) preserved: ' + prior.map(s => s.stagingContext + ' ' + (s.stageResult || '')).join(' · ') + '. ' : '') +
      'pT/pN/pM are NOT pre-filled and the prior clinical stage is NOT changed.'));
  }
  // §31 discrepancy loop: the flag's review task opens the form PRE-FILLED from the
  // flagged assessment — the clinician corrects the underlying facts, the engine
  // re-derives, and the new signature supersedes (and resolves the flag).
  const flagged = task && task.payload && task.payload.stagingAssessmentUuid
    ? (chart.staging.history || []).find(s => s.uuid === task.payload.stagingAssessmentUuid && s.status === 'SIGNED') : null;
  if (flagged) {
    if ([...ctxSel.options].some(o => o.value === flagged.stagingContext)) ctxSel.value = flagged.stagingContext;
    aDate.value = flagged.assessmentDate || aDate.value;
    card.append(el('div', { class: 'stopgate' },
      'STAGING DISCREPANCY REVIEW — flagged result: ' + el2s(flagged.stageResult) + '. ' +
      'The signed record is immutable; correct the underlying facts below. The engine re-derives, and signing supersedes ' +
      flagged.stageResult + ' and resolves the flag.'));
  }
  card.append(el('div', { class: 'grid2' }, wrap('Staging classification *', ctxSel), wrap('Assessment date *', aDate)));

  const varsBox = el('div', { class: 'grid3' });
  const inputs = {};
  const evidence = [];   // declared before the auto-result panel, which counts linked rows live
  // §24/§25 evidence auto-suggestion: focusing a staging fact surfaces candidate
  // patient records from the relevant staging window (assessment date − 6 months),
  // filtered to the fact's source kinds. One click confirms the link — the system
  // NEVER attaches evidence silently. Focus is attached per node inside renderVars
  // so rebuilt fields keep the hook.
  const suggBox = el('div', { id: 'evidenceSuggestions' });
  let suggTimer = null;
  const showSuggestions = async (factKey) => {
    if (!factKey) { suggBox.innerHTML = ''; return; }
    suggBox.innerHTML = '';
    suggBox.append(el('div', { class: 'muted' }, 'Searching the staging window for this fact…'));
    try {
      const s = await api('/staging/suggestions/' + chart.patient.uuid + '?fact=' + encodeURIComponent(factKey) + '&assessmentDate=' + encodeURIComponent(aDate.value || ''));
      suggBox.innerHTML = '';
      if (!s.suggestions.length) {
        suggBox.append(el('div', { class: 'muted' }, 'No candidate records in the staging window (' + s.window.start + ' → ' + s.window.end + ') for this fact.'));
        return;
      }
      suggBox.append(el('div', { class: 'prov' }, 'Candidates in the staging window (' + s.window.start + ' → ' + s.window.end + ') — click to confirm as evidence for this fact:'));
      for (const it of s.suggestions.slice(0, 6)) {
        suggBox.append(el('button', {
          class: 'btn small secondary', style: 'margin:2px 4px 2px 0', onclick: () => {
            evidence.push({ variableKey: factKey, sourceType: it.evidenceType === 'CLINICAL_EXAM' ? 'CLINICAL' : it.evidenceType, sourceRef: it.sourceResourceId, sourceDate: (it.sourceDate || '').slice(0, 10), supportingFinding: it.relevantFinding || '', evidenceRole: 'PRIMARY' });
            evBox.append(renderEvRow({ ...it, variableKey: factKey }));
            suggBox.innerHTML = '';
            toast('Evidence linked: ' + factKey + ' ← ' + (it.relevantFinding || it.evidenceType));
          }
        }, '[' + it.group + '] ' + fmtDate(it.sourceDate) + ' · ' + (it.relevantFinding || it.evidenceType).slice(0, 60) + (it.reportedBy ? ' · ' + it.reportedBy : '')));
      }
    } catch (e) { suggBox.innerHTML = ''; suggBox.append(el('div', { class: 'muted' }, 'Suggestions unavailable: ' + (e.error || e.message))); }
  };
  const attachSuggestionFocus = (node) => node.addEventListener('focus', () => {
    clearTimeout(suggTimer);
    suggTimer = setTimeout(() => showSuggestions(node.getAttribute('data-field')), 150);
  });
  const autoBox = el('div', { class: 'card', id: 'autoResult' });
  let lastDerivation = null;
  let recalcTimer = null;
  // AUTOMATIC RESULT (§29/§52): the engine on the SERVER derives categories and the
  // final classification/stage from the objective facts. This panel is a live preview;
  // the authoritative derivation runs again behind the sign gate. The clinician never
  // hand-picks the result where a content pack is connected.
  async function recalcAuto() {
    const variables = {};
    for (const [k, node] of Object.entries(inputs)) {
      if (!node) continue;
      const v = node.multiple ? [...node.selectedOptions].map(o => o.value).filter(Boolean) : node.value;
      if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) continue;
      variables[k] = node.tagName === 'SELECT' && !node.multiple && ['true', 'false'].includes(v) ? v === 'true' : v;
    }
    try {
      lastDerivation = await api('/staging/evaluate', { method: 'POST', body: { diagnosisUuid: dx.uuid, classification: ctxSel.value, variables } });
    } catch (e) { lastDerivation = { status: 'INVALID_INPUT', invalid: [e.error || String(e)] }; }
    renderAuto(lastDerivation);
  }
  function renderAuto(d) {
    autoBox.innerHTML = '';
    autoBox.append(el('h3', {}, 'AUTOMATIC RESULT'));
    const linked = evidence.filter(e => e.sourceRef).length;
    if (d.status === 'CALCULATED') {
      autoBox.append(el('div', { class: 'kv' },
        el('div', { class: 'k' }, 'Classification result'), el('div', {}, d.resultLabel + ' — derived by engine (server-authoritative)'),
        el('div', { class: 'k' }, 'Authority / version'), el('div', {}, schema.authority + ' · ' + schema.version),
        el('div', { class: 'k' }, 'Content pack'), el('div', {}, d.packId + (d.version ? ' — ' + d.version : '')),
        el('div', { class: 'k' }, 'Prognostic stage'), el('div', {}, d.prognosticLabel || (d.prognosticStage || null) || '—'),
        el('div', { class: 'k' }, 'Evidence status'), el('div', {}, evidence.length ? (linked + ' linked / ' + evidence.length + ' rows') : 'no evidence rows yet')));
      if (d.warnings && d.warnings.length) for (const w of d.warnings) autoBox.append(el('div', { class: 'stopgate' }, w));
      const det = el('details', {}, el('summary', {}, 'View derivation'));
      const trace = el('div', { class: 'prov' }, 'Rules applied (pack ' + d.packId + '):');
      for (const r of d.rulesApplied || []) trace.append(el('div', {}, '• ' + r.category + ' → ' + r.output + ' — ' + r.explain + ' [' + r.source + ']'));
      det.append(trace);
      autoBox.append(det);
    } else if (d.status === 'NEEDS_INFORMATION') {
      autoBox.append(el('div', { class: 'stopgate' }, 'STAGE CANNOT YET BE DETERMINED — missing information:'));
      for (const m of d.missing) autoBox.append(el('div', { class: 'prov' }, '• ' + m));
    } else if (d.status === 'INVALID_INPUT') {
      autoBox.append(el('div', { class: 'stopgate' }, 'INVALID INPUT:'));
      for (const m of d.invalid || []) autoBox.append(el('div', { class: 'prov' }, '• ' + m));
    } else if (d.status === 'AMBIGUOUS') {
      autoBox.append(el('div', { class: 'stopgate' }, 'AMBIGUOUS — ' + (d.message || 'unable to derive a unique result')));
    } else {
      autoBox.append(el('div', { class: 'stopgate' }, 'CONTENT_PROVIDER_UNAVAILABLE — no automatic-derivation pack is connected for this disease. Governed clinician-recorded categories remain available below; automatic calculation requires licensed authority content.'));
    }
  }
  const scheduleRecalc = () => { clearTimeout(recalcTimer); recalcTimer = setTimeout(recalcAuto, 250); };
  const values = {};
  // Progressive disclosure (§10): conditional fields render only when their
  // condition holds against the current facts. Display-only mirror of the server's
  // evaluator — the server re-validates everything authoritatively.
  const vis = (cond, facts) => {
    if (!cond) return true;
    switch (cond.op) {
      case 'EQ': return facts[cond.key] === cond.value;
      case 'NE': return facts[cond.key] !== cond.value;
      case 'AND': return cond.of.every(c => vis(c, facts));
      case 'OR': return cond.of.some(c => vis(c, facts));
      default: return true;
    }
  };
  let discrepancyPrefilled = false;
  const renderVars = async () => {
    for (const [k, node] of Object.entries(inputs)) {
      if (!node) continue;
      values[k] = node.multiple ? [...node.selectedOptions].map(o => o.value).filter(Boolean) : node.value;
    }
    // §31 discrepancy review (first render only): seed the form with the flagged
    // assessment's FACTS (never its derived result) so the clinician corrects a
    // fact and the engine re-derives — result fields stay engine-owned.
    if (flagged && !discrepancyPrefilled) {
      discrepancyPrefilled = true;
      const derivedKeys = (schema.engine && schema.engine.resultFields) || ['stageResult'];
      for (const [k, v] of Object.entries(flagged.variables || {})) {
        if (!derivedKeys.includes(k)) values[k] = v;
      }
    }
    varsBox.innerHTML = '';
    const engineAvailable = schema.engine && schema.engine.status === 'AVAILABLE';
    // §17 context-aware: governed T/N/M/result picks are replaced by derivation ONLY for
    // classifications the connected pack covers; other contexts keep the fallback.
    const engineForContext = engineAvailable && (!schema.engine.classifications || schema.engine.classifications.includes(ctxSel.value));
    const prefix = { PATHOLOGICAL: 'p', POSTTHERAPY_CLINICAL: 'yc', POSTTHERAPY_PATHOLOGICAL: 'yp', RECURRENCE_RETREATMENT: 'r', AUTOPSY: 'a' }[ctxSel.value] || 'c';
    const facts = {};
    const hiddenResultFields = engineForContext && schema.engine.resultFields ? schema.engine.resultFields : (engineForContext ? ['stageResult'] : []);
    for (const hk of hiddenResultFields) delete values[hk];   // engine derives these — never hand-picked (§31)
    for (const [k, v] of Object.entries(values)) if (v !== '' && v !== undefined && !(Array.isArray(v) && !v.length)) facts[k] = ['true', 'false'].includes(v) ? v === 'true' : v;
    for (const f of schema.fields) {
      // With a derivation pack connected the stage/classification result is engine-derived,
      // never hand-picked (§31) — the field is not rendered for manual entry.
      if (hiddenResultFields.includes(f.key)) continue;
      if (f.visibleWhen && !vis(f.visibleWhen, facts)) continue;
      let node;
      if (f.type === 'coded' && f.options) {
        node = el('select', { 'data-field': f.key });
        node.append(el('option', { value: '' }, '—'));
        for (const o of f.options) node.append(el('option', { value: o.code }, (f.prefix ? prefix + '-' : '') + o.label));
      } else if (f.type === 'select') {
        node = el('select', {}, el('option', { value: '' }, '—'), ...f.options.map(o => el('option', { value: o }, o)));
      } else if (f.type === 'boolean') {
        node = el('select', {}, el('option', { value: '' }, '—'), el('option', { value: 'true' }, 'Yes'), el('option', { value: 'false' }, 'No'));
      } else if (f.type === 'multiselect') {
        node = el('select', { multiple: true, size: Math.min(4, (f.options || []).length || 3) }, ...(f.options || []).map(o => el('option', { value: o.code }, o.label)));
      } else {
        node = el('input', { type: f.type === 'number' ? 'number' : 'text' });
      }
      node.setAttribute('data-field', f.key);   // stable automation/provenance hook on every control
      if (values[f.key] !== undefined) node.value = values[f.key];
      if (node.multiple && Array.isArray(values[f.key])) [...node.options].forEach(o => { o.selected = values[f.key].includes(o.value); });
      // Live recalculation (§14): 'input' fires per keystroke/fill (debounced).
      // Rebuild-on-change is attached ONLY to visibility-driving controls (selects,
      // booleans): number/text changes never alter the visible field set, so their
      // change (e.g. the blur fired when the next field is focused) must NOT rebuild
      // the DOM — a rebuild there replaces nodes mid-fill and drops the entered value.
      const drivesVisibility = ['select', 'boolean', 'coded', 'multiselect'].includes(f.type);
      node.addEventListener('input', scheduleRecalc);
      if (drivesVisibility) {
        node.addEventListener('change', async () => { await renderVars(); scheduleRecalc(); });
      } else {
        node.addEventListener('change', scheduleRecalc);
      }
      inputs[f.key] = node;
      attachSuggestionFocus(node);
      if (hiddenResultFields.length) for (const hk of hiddenResultFields) delete inputs[hk];
      varsBox.append(wrap(f.label + (f.required ? ' *' : '') + (f.unit ? ' (' + f.unit + ')' : '') + (f.help ? ' — ' + f.help : ''), node));
    }
  };
  await renderVars();
  ctxSel.addEventListener('change', async () => { await renderVars(); scheduleRecalc(); });
  card.append(varsBox);
  card.append(autoBox);
  recalcAuto();

  // §20/§31 evidence per fact: grouped picker over existing signed records — the
  // doctor selects, never retypes source names. View Source before linking.
  const pickerItems = await api('/staging/evidence-picker/' + chart.patient.uuid);
  const results = await api('/results?patientUuid=' + chart.patient.uuid);
  card.append(el('h3', {}, 'Staging evidence (provenance per fact — required for T/N/M)'));
  card.append(suggBox);
  // §24/§26 evidence per fact: any non-result field can cite its source — objective
  // inputs (size, β2M, node counts) and governed categories alike. Engine-derived
  // result fields are excluded for classifications the connected pack covers: the
  // trace, not evidence, justifies those.
  const engineForCtx = schema.engine && schema.engine.status === 'AVAILABLE' &&
    (!schema.engine.classifications || schema.engine.classifications.includes(ctxSel.value));
  const evVarFields = schema.fields.filter(f => {
    if (!(schema.engine && schema.engine.resultFields || ['stageResult']).includes(f.key)) return true;
    return !engineForCtx;
  });
  const evVar = el('select', {}, el('option', { value: '' }, '— fact this evidence supports —'), ...evVarFields.map(f => el('option', { value: f.key }, f.label)));
  const evRole = el('select', {}, ...['PRIMARY', 'SUPPORTING', 'CONTRADICTORY'].map(v => el('option', { value: v }, v.toLowerCase())));
  const evFinding = el('input', { placeholder: 'Supporting finding (e.g. 3.2cm spiculated mass, left upper lobe)' });
  const evBox = el('div', {});
  const renderEvRow = (item) => {
    const row = el('div', { class: 'prov' },
      item.variableKey + ' ← ' + item.evidenceType + (item.relevantFinding ? ' — ' + item.relevantFinding : '') +
      ' · ' + fmtDate(item.sourceDate) + (item.reportedBy ? ' · ' + item.reportedBy : '') + ' ',
      el('span', { class: 'badge SIGNED' }, (item.evidenceRole || 'primary')));
    const srcRec = results.find(r => r.uuid === item.sourceResourceId);
    if (srcRec) {
      row.append(el('button', { class: 'btn small secondary', style: 'margin-left:6px', onclick: () => {
        const modal = el('div', { class: 'card', style: 'position: fixed;top:60px;left:50%;transform:translateX(-50%);width:560px;max-height:70vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
        modal.append(el('h3', {}, 'SOURCE — ' + srcRec.category + ': ' + srcRec.test),
          el('div', { class: 'prov' }, 'Status: ' + srcRec.status + ' · finalized ' + fmtDate(srcRec.finalizedAt) + ' by ' + srcRec.byName));
        modal.append(el('pre', { style: 'white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:8px;border-radius:6px' }, (srcRec.summary || '')));
        modal.append(el('button', { class: 'btn small', onclick: () => modal.remove() }, 'Close source'));
        document.body.append(modal);
      } }, 'View Source'));
    }
    row.append(el('button', { class: 'btn small secondary', style: 'margin-left:4px', onclick: () => { row.remove(); evidence.splice(evidence.indexOf(item), 1); } }, 'remove'));
    return row;
  };
  // grouped picker by department (§31)
  const GROUPS = ['Pathology', 'Radiology', 'Laboratory', 'Molecular results', 'Operative reports', 'Consultations', 'External documents'];
  const pickGroup = el('select', {}, ...GROUPS.map(g => el('option', { value: g }, g)));
  const pickItem = el('select', {}, el('option', { value: '' }, '— select evidence —'));
  const fillPicker = () => {
    pickItem.innerHTML = '';
    pickItem.append(el('option', { value: '' }, '— select evidence —'));
    for (const it of pickerItems.filter(i => i.group === pickGroup.value)) {
      pickItem.append(el('option', { value: it.evidenceId }, fmtDate(it.sourceDate) + ' · ' + (it.reportedBy || '—') + ' · ' + (it.relevantFinding || it.evidenceType)));
    }
  };
  fillPicker();
  pickGroup.addEventListener('change', fillPicker);
  const viewBeforeLink = el('button', { class: 'btn small secondary', onclick: () => {
    const it = pickerItems.find(i => i.evidenceId === pickItem.value);
    if (!it) return;
    const srcRec = results.find(r => r.uuid === it.sourceResourceId);
    const modal = el('div', { class: 'card', style: 'position: fixed;top:60px;left:50%;transform:translateX(-50%);width:560px;max-height:70vh;overflow:auto;z-index:40;box-shadow:0 8px 30px rgba(0,0,0,.25)' });
    modal.append(el('h3', {}, 'SOURCE — ' + it.evidenceType), el('div', { class: 'prov' }, fmtDate(it.sourceDate) + ' · ' + (it.reportedBy || '—') + ' · status ' + it.status));
    modal.append(el('pre', { style: 'white-space:pre-wrap;font-size:12px;background:#f6f8fa;padding:8px;border-radius:6px' }, (srcRec ? srcRec.summary : it.relevantFinding) || ''));
    modal.append(el('button', { class: 'btn small', onclick: () => modal.remove() }, 'Close source'));
    document.body.append(modal);
  } }, 'View Source before linking');
  card.append(el('div', { class: 'grid3' }, wrap('Staging fact', evVar), wrap('Evidence group', pickGroup), wrap('Evidence record', pickItem)),
    el('div', { class: 'grid3' }, wrap('Evidence role', evRole), wrap('Supporting finding', evFinding), el('div', { style: 'display:flex;align-items:flex-end;gap:6px' }, viewBeforeLink)));
  card.append(el('button', {
    class: 'btn small secondary', onclick: () => {
      if (!evVar.value) return toast('Staging fact required for evidence row', true);
      const it = pickerItems.find(i => i.evidenceId === pickItem.value);
      if (!it) return toast('Select an evidence record from the picker', true);
      const item = { variableKey: evVar.value, sourceType: it.evidenceType === 'CLINICAL_EXAM' ? 'CLINICAL' : it.evidenceType, sourceRef: it.sourceResourceId, sourceDate: (it.sourceDate || '').slice(0, 10), supportingFinding: evFinding.value || it.relevantFinding, evidenceRole: evRole.value };
      evidence.push(item);
      evBox.append(renderEvRow({ ...item, evidenceType: it.evidenceType, reportedBy: it.reportedBy }));
      evFinding.value = '';
    }
  }, '+ link evidence to fact'));
  card.append(evBox);

  const supSel = el('select', {}, el('option', { value: '' }, '— new initial staging —'),
    ...chart.staging.history.filter(s => s.status === 'SIGNED').map(s => el('option', { value: s.uuid }, 'supersedes: ' + s.stagingContext + ' ' + s.stageResult + ' (' + fmtDate(s.assessmentDate) + ')')));
  // §31: a discrepancy review supersedes the flagged assessment by default — the
  // clinician can still change it, but the corrective default is the flagged record.
  if (flagged) supSel.value = flagged.uuid;
  card.append(wrap('Supersedes (restaging / post-treatment)', supSel));

  card.append(el('button', {
    class: 'btn mt8', onclick: async () => {
      try {
        const variables = {};
        for (const [k, node] of Object.entries(inputs)) {
          if (!node) continue;
          const v = node.multiple ? [...node.selectedOptions].map(o => o.value).filter(Boolean) : node.value;
          if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) continue;
          variables[k] = node.tagName === 'SELECT' && !node.multiple && ['true', 'false'].includes(v) ? v === 'true' : v;
        }
        // resultSource tells the sign gate whether the engine derived this result
        // (AUTOMATIC_ENGINE → gate re-derives server-side and requires a match) or
        // governed clinician-recorded categories were used (fallback path).
        const a = await api('/staging-assessments', { method: 'POST', body: {
          diagnosisUuid: dx.uuid, stagingContext: ctxSel.value, assessmentDate: aDate.value,
          variables, evidence, supersedes: supSel.value || null,
          resultSource: lastDerivation && lastDerivation.status === 'CALCULATED' ? 'AUTOMATIC_ENGINE' : 'CLINICIAN_ENTERED'
        }});
        // §32 STAGING SUMMARY — clinician reviews the assembled assessment before signing
        // §55 second-disease rule: non-TNM schemas (ISS, FIGO, Lugano…) must never render
        // TNM framing — the summary shows the classification and the disease-specific
        // variables only, with no T/N/M rows and no (prefix+TNM) label.
        const prefix = { PATHOLOGICAL: 'p', POSTTHERAPY_CLINICAL: 'yc', POSTTHERAPY_PATHOLOGICAL: 'yp', RECURRENCE_RETREATMENT: 'r', AUTOPSY: 'a' }[ctxSel.value] || 'c';
        const ctxDisplay = { CLINICAL: 'Clinical', PATHOLOGICAL: 'Pathological', POSTTHERAPY_CLINICAL: 'Posttherapy clinical', POSTTHERAPY_PATHOLOGICAL: 'Posttherapy pathological', RECURRENCE_RETREATMENT: 'Recurrence/retreatment', AUTOPSY: 'Autopsy', NON_TNM: 'Non-TNM' }[ctxSel.value] || ctxSel.value;
        const isNonTnm = ctxSel.value === 'NON_TNM';
        const classificationText = isNonTnm ? 'Disease classification (non-TNM — provider resolved)' : ctxDisplay + ' (' + prefix + 'TNM)';
        const summaryCard = card;
        summaryCard.innerHTML = '';
        summaryCard.append(el('h2', {}, 'STAGING SUMMARY'));
        const summaryRows = [
          el('div', { class: 'k' }, 'Classification'), el('div', {}, classificationText)
        ];
        if (!isNonTnm) {
          summaryRows.push(
            el('div', { class: 'k' }, 'T'), el('div', {}, variables.t ? prefix + variables.t : '—'),
            el('div', { class: 'k' }, 'N'), el('div', {}, variables.n ? prefix + variables.n : '—'),
            el('div', { class: 'k' }, 'M'), el('div', {}, variables.m ? prefix + variables.m : (['PATHOLOGICAL', 'POSTTHERAPY_PATHOLOGICAL'].includes(ctxSel.value) ? 'not assessed pathologically (M remains clinical)' : '—')),
            el('div', { class: 'k' }, 'Prognostic factors'), el('div', {}, Object.keys(variables).filter(k => !['t', 'n', 'm', 'stageResult'].includes(k)).map(k => k + ': ' + variables[k]).join(', ') || '—'));
        } else {
          summaryRows.push(
            el('div', { class: 'k' }, 'Classification variables'), el('div', {}, Object.keys(variables).filter(k => !['stageResult'].includes(k)).map(k => k + ': ' + variables[k]).join(', ') || '—'));
        }
        summaryCard.append(el('div', { class: 'kv' }, ...summaryRows,
          el('div', { class: 'k' }, 'Stage / classification result'), el('div', {},
            lastDerivation && lastDerivation.status === 'CALCULATED'
              ? lastDerivation.resultLabel + ' — engine-derived (verify, then sign)'
              : (variables.stageResult || 'derived by provider at sign')),
          ...((lastDerivation && lastDerivation.status !== 'CALCULATED' && engineForContext)
            ? [el('div', { class: 'k' }, 'Engine status'), el('div', {}, lastDerivation.status + ' — signing requires the engine to calculate')]
            : []),
          el('div', { class: 'k' }, 'Evidence completeness'), el('div', {}, evidence.filter(e => e.sourceRef).length + ' linked / ' + evidence.length + ' rows'),
          el('div', { class: 'k' }, 'Authority'), el('div', {}, schema.authority + ' · ' + schema.version)));
        for (const ev of evidence) {
          summaryCard.append(el('div', { class: 'prov' }, ev.variableKey + ' ← ' + ev.sourceType + (ev.supportingFinding ? ' — ' + ev.supportingFinding : '')));
        }
        summaryCard.append(el('div', { class: 'stopgate' }, 'Signing is immutable. The provider derives the stage; a suspected discrepancy is flagged, never silently altered.'));
        summaryCard.append(el('button', { class: 'btn', onclick: async () => {
          try {
            await api('/staging-assessments/' + (a.data ? a.data.uuid : a.uuid) + '/sign', { method: 'POST', body: {} });
            toast('Staging signed (' + schema.authority + ' ' + schema.version + ') — MDT/care-plan task generated');
            await done();
          } catch (e) { toast(e.error, true); }
        } }, 'Confirm & sign'),
        el('button', { class: 'btn secondary', style: 'margin-left:8px', onclick: () => { state.view = { name: 'worklist' }; render(); } }, 'Save draft (sign later from worklist)'));
      } catch (e) { toast(e.error, true); }
    }
  }, 'Review staging summary…'));
}
