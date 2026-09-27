// CCA OS — Admin console (governed masters + hospital configuration)
'use strict';
(function () {
  const state = { user: localStorage.getItem('ccaUser') || 'u-admin', masters: {}, current: null, hospitals: [] };
  const $ = s => document.querySelector(s);
  const el = (t, a = {}, ...c) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const x of c.flat()) if (x != null) e.append(x.nodeType ? x : document.createTextNode(x)); return e; };

  async function api(p, opts = {}) {
    const r = await fetch('/ws/rest/v1/cca' + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', 'x-cca-user': state.user }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json();
    if (!j.ok) throw j;
    return j.data;
  }
  function toast(m, err) { const t = $('#toast'); t.textContent = m; t.className = 'toast' + (err ? ' error' : ''); setTimeout(() => t.classList.add('hidden'), 4000); }

  async function boot() {
    $('#userSel').value = state.user;
    $('#userSel').addEventListener('change', e => { state.user = e.target.value; render(); });
    state.hospitals = await api('/hospitals');
    const list = await api('/masters');
    const nav = $('#masterList');
    for (const m of list) {
      nav.append(el('button', { class: 'masterbtn' + (state.current === m.name ? ' active' : ''), onclick: () => { state.current = m.name; renderItems(); } }, m.name + ' (' + m.count + ')'));
    }
    renderHospitals();
    if (list.length) { state.current = state.current || list[0].name; renderItems(); }
  }

  async function renderItems() {
    const box = $('#itemBox');
    box.innerHTML = '';
    if (!state.current) return;
    box.append(el('h2', {}, 'Master: ' + state.current));
    const items = await api('/masters/' + state.current);
    const tb = el('tbody');
    for (const i of items) {
      tb.append(el('tr', {},
        el('td', {}, i.code),
        el('td', {}, i.label),
        el('td', {}, i.parent || ''),
        el('td', {}, el('span', { class: 'badge ' + (i.active ? 'done' : 'superseded') }, i.active ? 'active' : 'retired')),
        el('td', {}, i.active ? el('button', {
          class: 'btn small danger', onclick: async () => {
            try { await fetch('/ws/rest/v1/cca/masters/' + state.current + '/' + i.id + '/retire', { method: 'POST', headers: { 'x-cca-user': state.user } }); toast('Retired (audited)'); renderItems(); } catch (e) { toast(e.error, true); }
          }
        }, 'retire') : '—')));
    }
    box.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Code'), el('th', {}, 'Label'), el('th', {}, 'Parent'), el('th', {}, 'Status'), el('th', {}, ''))), tb));

    const code = el('input', { placeholder: 'Code (e.g. G_NEW)' });
    const label = el('input', { placeholder: 'Label (governed display value)' });
    const parent = el('input', { placeholder: 'Parent code (only for subsite)' });
    box.append(el('h3', {}, 'Add governed value'));
    box.append(el('div', { class: 'grid3' }, wrap('Code', code), wrap('Label', label), wrap('Parent (optional)', parent)));
    box.append(el('button', {
      class: 'btn', onclick: async () => {
        try {
          const r = await fetch('/ws/rest/v1/cca/masters/' + state.current, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cca-user': state.user }, body: JSON.stringify({ code: code.value, label: label.value, parent: parent.value || undefined }) });
          const j = await r.json();
          if (!j.ok) throw j;
          toast('Value added to ' + state.current + ' (audited)');
          renderItems();
        } catch (e) { toast(e.error, true); }
      }
    }, 'Add value'));
  }

  function renderHospitals() {
    const box = $('#hospitalBox');
    box.innerHTML = '';
    box.append(el('h2', {}, 'Hospital configuration (multi-hospital without forks)'));
    const tb = el('tbody');
    for (const h of state.hospitals) {
      tb.append(el('tr', {},
        el('td', {}, h.organisation),
        el('td', {}, el('b', {}, h.name)),
        el('td', {}, h.city || ''),
        el('td', {}, 'MDT policy: ' + JSON.stringify(h.mdtPolicy || {})),
        el('td', {}, 'formulary: ' + (h.config && h.config.formulary))));
    }
    box.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Organisation'), el('th', {}, 'Hospital'), el('th', {}, 'City'), el('th', {}, 'Routing policy'), el('th', {}, 'Config'))), tb));
    box.append(el('div', { class: 'prov' }, 'Hospitals are configuration rows, not code forks. Adding a hospital = adding data: departments, formulary, regimen library, staging provider, finance rules, RT/surgery templates, integrations.'));
  }

  // Directive §33: Clinical Content → Staging Authorities registry
  async function renderStagingRegistry() {
    const box = $('#stagingRegistryBox');
    box.innerHTML = '';
    box.append(el('h2', {}, 'Clinical Content — Staging Authorities (directive §33)'));
    try {
      const reg = await api('/admin/staging-registry');
      const tb = el('tbody');
      for (const r of reg.rows) {
        tb.append(el('tr', {},
          el('td', {}, el('b', {}, r.authority)),
          el('td', {}, r.schema),
          el('td', {}, r.version),
          el('td', {}, r.effectiveFrom || '—'),
          el('td', {}, r.effectiveTo || '—'),
          el('td', {}, r.licenceStatus),
          el('td', {}, r.providerStatus),
          el('td', {}, r.provider),
          el('td', { class: 'muted' }, (r.sourceReference || '').slice(0, 60) + '… (verified ' + (r.verifiedAt || '—') + ')')));
      }
      box.append(el('table', {}, el('thead', {}, el('tr', {},
        el('th', {}, 'Authority'), el('th', {}, 'Disease / schema'), el('th', {}, 'Version'), el('th', {}, 'Effective from'), el('th', {}, 'Effective to'),
        el('th', {}, 'Licence status'), el('th', {}, 'Provider status'), el('th', {}, 'Provider'), el('th', {}, 'Source'))), tb));
      box.append(el('div', { class: reg.licensed ? 'prov' : 'stopgate' },
        reg.licensed
          ? 'Licensed AJCC provider is configured (API credentials + ACTIVE licence record).'
          : 'No licensed AJCC content provider is configured. Version routing above is PUBLIC metadata (official AJCC Current Staging System 2026 table). Governed T/N/M definitions and stage calculation remain AUTHORITY_CONTENT_UNAVAILABLE until a licensed provider (AJCC API / Cancer Surveillance DLL) is connected. The product does NOT claim "AJCC integrated".'));
    } catch (e) { box.append(el('div', { class: 'stopgate' }, 'Registry unavailable: ' + (e.error || e.message))); }
  }

  // Directive §34: ClinicalContentLicense registry with add form
  async function renderLicenses() {
    const box = $('#licenceBox');
    box.innerHTML = '';
    box.append(el('h2', {}, 'Clinical Content Licences (directive §34)'));
    let list = [];
    try { list = await api('/admin/content-licenses'); } catch (e) { /* ignore */ }
    const tb = el('tbody');
    for (const l of list) {
      tb.append(el('tr', {},
        el('td', {}, l.publisher), el('td', {}, l.contentName), el('td', {}, l.version),
        el('td', {}, l.licenceType || '—'), el('td', {}, (l.effectiveFrom || '—') + ' → ' + (l.effectiveTo || 'open')), el('td', {}, l.status)));
    }
    if (!list.length) tb.append(el('tr', {}, el('td', { colspan: '6', class: 'muted' }, 'No licences registered — AJCC/UICC/FIGO content is treated as NOT CONFIGURED.')));
    box.append(el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Publisher'), el('th', {}, 'Content'), el('th', {}, 'Version'), el('th', {}, 'Type'), el('th', {}, 'Effective'), el('th', {}, 'Status')), tb)));
    const pub = el('input', { placeholder: 'Publisher (e.g. American College of Surgeons)' });
    const name = el('input', { placeholder: 'Content name (e.g. AJCC Cancer Staging System API)' });
    const ver = el('input', { placeholder: 'Version (e.g. API 02.03.00)' });
    const type = el('select', {}, ...['API_SUBSCRIPTION', 'SITE_LICENCE', 'DLL'].map(v => el('option', { value: v }, v)));
    const status = el('select', {}, ...['PENDING', 'ACTIVE', 'EXPIRED'].map(v => el('option', { value: v }, v)));
    box.append(el('div', { class: 'grid3' }, wrap('Publisher', pub), wrap('Content', name), wrap('Version', ver)),
      el('div', { class: 'grid2' }, wrap('Licence type', type), wrap('Status', status)),
      el('button', { class: 'btn', onclick: async () => {
        try {
          await api('/admin/content-licenses', { method: 'POST', body: { publisher: pub.value, contentName: name.value, version: ver.value, licenceType: type.value, status: status.value } });
          toast('Licence registered (audited) — provider configuration still requires env credentials');
          renderLicenses(); renderStagingRegistry();
        } catch (e) { toast(e.error, true); }
      } }, 'Register licence'));
  }

  // Staging mandate §5/§6/§7: visible registry of connected content packs —
  // provenance, effective date, source file, and whether a pack supersedes another.
  async function renderContentPacks() {
    const box = $('#contentPackBox');
    box.innerHTML = '';
    box.append(el('h2', {}, 'Staging Content Packs (automatic derivation)'));
    let data;
    try { data = await api('/admin/content-packs'); } catch (e) { box.append(el('div', { class: 'stopgate' }, 'Pack registry unavailable: ' + (e.error || e.message))); return; }
    const packs = data.packs || [];
    const tb = el('tbody');
    for (const p of packs) {
      tb.append(el('tr', {},
        el('td', {}, el('b', {}, p.packId)),
        el('td', {}, p.providerKey + ' / ' + p.schemaId),
        el('td', {}, p.version),
        el('td', {}, p.effectiveFrom || '—'),
        el('td', {}, el('span', { class: 'badge ' + (p.status === 'ACTIVE' ? 'done' : 'superseded') }, p.status + (p.supersededBy ? ' → ' + p.supersededBy : ''))),
        el('td', {}, p.source),
        el('td', {}, p.proprietary ? 'proprietary (trace text hidden)' : 'public')));
    }
    if (!packs.length) tb.append(el('tr', {}, el('td', { colspan: '7', class: 'muted' }, 'No content packs registered — automatic derivation is unavailable for every disease schema.')));
    box.append(el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Pack'), el('th', {}, 'Covers (provider / schema)'), el('th', {}, 'Version'), el('th', {}, 'Effective from'), el('th', {}, 'Status'), el('th', {}, 'Source'), el('th', {}, 'Licence mode'))), tb));
    const skipped = (data.summary && data.summary.skipped) || [];
    for (const s of skipped) box.append(el('div', { class: 'stopgate' }, 'SKIPPED ' + s.file + ': ' + s.errors.join(' | ')));
    box.append(el('div', { class: 'prov' },
      'Packs are loaded from the content-pack directory at boot (CCA_CONTENT_PACKS_DIR overrides the path). Licensed AJCC packs plug in through this seam with no engine changes; a pack replaces another only by declaring supersedes, so version changes are never silent.'));
    box.append(el('button', { class: 'btn', onclick: async () => {
      try { await api('/admin/content-packs/reload', { method: 'POST' }); toast('Content-pack directory reloaded (audited)'); renderContentPacks(); } catch (e) { toast(e.error, true); }
    } }, 'Reload pack directory'));

    // Licensed AJCC adapter PoC (§7): connection status + governed connect action.
    // Credentials themselves are env-only (never entered or displayed in the UI).
    let st;
    try { st = await api('/admin/ajcc-adapter/status'); } catch (e) { st = null; }
    if (st) {
      box.append(el('h3', {}, 'Licensed AJCC adapter'));
      const cred = st.credentialsPresent ? 'credentials present' : 'credentials absent';
      const lic = st.licenceRecordActive ? 'ACTIVE licence record' : 'no ACTIVE licence record';
      box.append(el('div', { class: 'prov' },
        'Status: ' + (st.configured ? 'configured' : 'not configured') + ' (' + cred + ', ' + lic + ') · ' +
        'connected licensed packs: ' + st.packs.length +
        (st.packs.length ? ' — ' + st.packs.map(p => p.packId + ' (' + p.schemaId + ', ' + p.version + ')').join('; ') : '')));
      if (!st.connected) {
        box.append(el('button', { class: 'btn', onclick: async () => {
          try { await api('/admin/ajcc-adapter/connect', { method: 'POST' }); toast('Licensed AJCC content connected (audited)'); renderContentPacks(); } catch (e) { toast(e.error, true); }
        } }, 'Connect licensed AJCC content'));
      }
    }
  }

  function wrap(l, n) { const w = el('div', {}); w.append(el('label', {}, l)); w.append(n); return w; }

  boot();
  renderStagingRegistry();
  renderLicenses();
  renderContentPacks();
})();
