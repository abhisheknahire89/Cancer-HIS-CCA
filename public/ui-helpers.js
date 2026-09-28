// CCA OS — Shared UI helpers
// Owns tiny display helpers used across UI modules. el2s was duplicated
// verbatim in staging-ui.js and chart-ui.js (originally extracted from app.js);
// this module is now its single definition. Loads first in index.html so the
// helpers exist before any consuming module's top-level or click-time code
// runs — same shared-globals convention as the rest of the UI modules.
function el2s(x) { return x === undefined || x === null ? '—' : String(x); }
