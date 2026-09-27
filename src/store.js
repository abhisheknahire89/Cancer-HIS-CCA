// CCA OS — persistence layer (atomic JSON file store)
// Swappable adapter: mirrors the OpenMRS service/DAO split so the same
// service contracts can be backed by OpenMRS entities + FHIR later.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.CCA_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = null;

function emptyDb() {
  return {
    meta: { createdAt: new Date().toISOString(), version: 1 },
    hospitals: [],
    users: [],
    patients: [],
    referrals: [],
    consultations: [],
    investigationOrders: [],
    results: [],
    diagnoses: [],
    episodes: [],
    stagingAssessments: [],
    mdtCases: [],
    carePlans: [],
    financialCounsellings: [],
    readinessChecks: [],
    treatmentOrders: [],
    pharmacyRecords: [],
    dispenseRecords: [],
    infusionReactions: [],
    administrationRecords: [],
    toxicityAssessments: [],
    responseAssessments: [],
    rtPrescriptions: [],
    rtCourses: [],
    rtFractions: [],
    surgicalPlans: [],
    operativeRecords: [],
    delayRecords: [],
    diseaseProfiles: [],
    consents: [],
    consentTemplates: [],
    nextCycleDecisions: [],
    verificationEvents: [],
    events: [],
    tasks: [],
    audit: [],
    masters: {},
    regimens: [],
    counters: {}
  };
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    db = emptyDb();
    persist();
  }
  return db;
}

function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

function getDb() { return db || load(); }

function nextSeq(key) {
  const d = getDb();
  d.counters[key] = (d.counters[key] || 0) + 1;
  return d.counters[key];
}

function insert(collection, obj) {
  const d = getDb();
  if (!d[collection]) d[collection] = [];
  d[collection].push(obj);
  persist();
  return obj;
}

function update(collection, uuid, patch) {
  const d = getDb();
  const idx = (d[collection] || []).findIndex(x => x.uuid === uuid);
  if (idx === -1) return null;
  d[collection][idx] = Object.assign({}, d[collection][idx], patch);
  persist();
  return d[collection][idx];
}

function find(collection, predicate) {
  const d = getDb();
  return (d[collection] || []).filter(predicate);
}

function findOne(collection, predicate) {
  const d = getDb();
  return (d[collection] || []).find(predicate) || null;
}

function byUuid(collection, uuid) {
  const d = getDb();
  return (d[collection] || []).find(x => x.uuid === uuid) || null;
}

// Audit hash chain (canonical §63): each entry commits to the previous one,
// so tampering with any historical entry breaks verification.
function audit(actor, action, entityType, entityUuid, detail) {
  const d = getDb();
  const prev = d.audit[d.audit.length - 1];
  const entry = {
    uuid: crypto.randomUUID(),
    index: d.audit.length,
    at: new Date().toISOString(),
    actor: actor ? { uuid: actor.uuid, name: actor.name, role: actor.role } : null,
    action, entityType, entityUuid, detail: detail || null,
    prevHash: prev ? prev.hash : ''
  };
  entry.hash = crypto.createHash('sha256')
    .update([entry.index, entry.at, entry.actor ? entry.actor.uuid : '-', entry.action,
      entry.entityType, entry.entityUuid, entry.detail || '-', entry.prevHash].join('|'))
    .digest('hex');
  d.audit.push(entry);
  persist();
  return entry;
}

function verifyAuditChain() {
  const d = getDb();
  let prevHash = '';
  for (const e of d.audit) {
    const expected = crypto.createHash('sha256')
      .update([e.index, e.at, e.actor ? e.actor.uuid : '-', e.action,
        e.entityType, e.entityUuid, e.detail || '-', prevHash].join('|'))
      .digest('hex');
    if (e.hash !== expected || e.prevHash !== prevHash) {
      return { ok: false, brokenAt: e.index, uuid: e.uuid };
    }
    prevHash = e.hash;
  }
  return { ok: true, entries: d.audit.length };
}

module.exports = { load, getDb, persist, insert, update, find, findOne, byUuid, audit, verifyAuditChain, nextSeq };
