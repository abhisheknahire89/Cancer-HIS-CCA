// CCA OS — Task/Handoff Engine (mandate §18) + Signature service + Stop-gates
'use strict';
const store = require('./store');
const crypto = require('crypto');

function uuid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }

// ---- Task engine -------------------------------------------------------
// TaskDefinition catalog: code -> { title, role, destination, dueHours }
// Every destination is a real screen in the UI (see public/app.js routes).
const TASK_DEFS = {
  INTAKE_ASSESSMENT:      { title: 'Perform intake assessment',            role: 'Intake Nurse',        destination: 'consult-new' },
  FIRST_CONSULT:          { title: 'First oncology consultation',          role: 'Medical Oncologist',  destination: 'consult-new' },
  REVIEW_RESULTS:         { title: 'Review investigation results',         role: 'Medical Oncologist',  destination: 'results-review' },
  PERFORM_LAB:            { title: 'Collect specimen / perform lab test',  role: 'Lab',                 destination: 'dept-lab' },
  PERFORM_IMAGING:        { title: 'Perform imaging and report',           role: 'Radiologist',         destination: 'dept-radiology' },
  PERFORM_PATHOLOGY:      { title: 'Process specimen / issue pathology report', role: 'Pathologist',    destination: 'dept-pathology' },
  CONFIRM_DIAGNOSIS:      { title: 'Record and sign cancer diagnosis',     role: 'Medical Oncologist',  destination: 'diagnosis' },
  CREATE_STAGING:         { title: 'Complete staging / classification',    role: 'Medical Oncologist',  destination: 'staging' },
  MDT_REVIEW:             { title: 'Present case at MDT',                  role: 'MDT Coordinator',     destination: 'mdt' },
  MDT_CHAIR_SIGN:         { title: 'Chair MDT and sign outcome',           role: 'MDT Chair',           destination: 'mdt' },
  CREATE_CARE_PLAN:       { title: 'Create signed treatment care plan',    role: 'Medical Oncologist',  destination: 'care-plan' },
  FINANCIAL_COUNSEL:      { title: 'Financial counselling and authorization', role: 'Financial Counsellor', destination: 'finance' },
  RECORD_CONSENT:         { title: 'Obtain treatment-specific informed consent', role: 'Medical Oncologist', destination: 'consent' },
  READINESS_CHECK:        { title: 'Treatment readiness checklist',        role: 'Nurse Navigator',     destination: 'readiness' },
  CREATE_TREATMENT_ORDER: { title: 'Sign treatment order',                 role: 'Medical Oncologist',  destination: 'treatment-order' },
  PHARMACY_VERIFY:        { title: 'Verify and prepare treatment',         role: 'Pharmacist',          destination: 'pharmacy' },
  PHARMACY_RELEASE:       { title: 'Independent check and release',        role: 'Pharmacist',          destination: 'pharmacy' },
  DISPENSE:               { title: 'Dispense released preparation (chain of custody)', role: 'Pharmacist', destination: 'pharmacy' },
  ADMINISTER:             { title: 'Day care administration',              role: 'Day Care Nurse',      destination: 'daycare' },
  INFUSION_REACTION_REVIEW: { title: 'Review infusion reaction',           role: 'Medical Oncologist',  destination: 'daycare' },
  TOXICITY_REVIEW:        { title: 'Toxicity assessment',                  role: 'Medical Oncologist',  destination: 'toxicity' },
  NEXT_CYCLE_REVIEW:      { title: 'Next cycle decision',                  role: 'Medical Oncologist',  destination: 'next-cycle' },
  RESPONSE_ASSESS:        { title: 'Response assessment',                  role: 'Medical Oncologist',  destination: 'response' },
  RT_CONSULT:             { title: 'Radiation oncology consultation',      role: 'Radiation Oncologist', destination: 'radiation' },
  RT_PLAN_APPROVE:        { title: 'Approve RT plan (physicist)',          role: 'Radiation Oncologist', destination: 'radiation' },
  SURGICAL_CONSULT:       { title: 'Surgical oncology consultation',       role: 'Surgical Oncologist', destination: 'surgery' },
  SURGERY_RECORD:         { title: 'Complete operative record',            role: 'Surgical Oncologist', destination: 'surgery' },
  SURGERY_SPECIMEN:       { title: 'Send specimen to pathology',           role: 'Pathologist',         destination: 'dept-pathology' },
  PATHOLOGICAL_STAGING:   { title: 'Complete pathological staging from final histopathology', role: 'Medical Oncologist', destination: 'staging' },
  STAGING_DISCREPANCY:    { title: 'Review flagged staging discrepancy',   role: 'Medical Oncologist',  destination: 'staging' },
  ADJUVANT_DECISION:      { title: 'Adjuvant treatment decision',          role: 'Medical Oncologist',  destination: 'care-plan' }
};

function createTask(actor, code, patientUuid, payload, dueHours) {
  const def = TASK_DEFS[code];
  if (!def) throw new Error('Unknown task code: ' + code);
  const task = {
    uuid: uuid(),
    code,
    title: def.title,
    role: def.role,
    destination: def.destination,
    patientUuid,
    payload: payload || {},
    status: 'OPEN',
    createdAt: nowIso(),
    dueAt: new Date(Date.now() + (dueHours || 24) * 3600 * 1000).toISOString(),
    createdBy: actor ? actor.uuid : null,
    completedAt: null,
    completedBy: null
  };
  store.insert('tasks', task);
  return task;
}

function openTasksForRole(role) {
  return store.find('tasks', t => t.role === role && t.status === 'OPEN');
}

function tasksForPatient(patientUuid) {
  return store.find('tasks', t => t.patientUuid === patientUuid);
}

// Complete every OPEN task for a patient matching a predicate, as the signing
// actor. This is the canonical "signed record supersedes the tasks that asked
// for it" idiom (§49) — callers pass a filter so each signing flow states its
// own trigger condition; the engine owns loop + status guard.
function completeOpenTasks(actor, patientUuid, predicate, outcome) {
  for (const t of tasksForPatient(patientUuid)) {
    if (t.status === 'OPEN' && predicate(t)) completeTask(actor, t.uuid, outcome);
  }
}

function completeTask(actor, taskUuid, outcome) {
  const task = store.byUuid('tasks', taskUuid);
  if (!task) throw new Error('Task not found');
  if (task.status !== 'OPEN') throw new Error('Task is not open (already ' + task.status + ')');
  // Handoff contract (canonical §49): only the assigned role completes a task.
  // A cross-role completion silently consumed the MDT chair's signature step.
  if (actor && task.role && actor.role && actor.role !== task.role) {
    throw new Error('ROLE_MISMATCH: task "' + task.title + '" is assigned to ' + task.role + ' (signed in as ' + actor.role + ')');
  }
  task.status = 'DONE';
  task.completedAt = nowIso();
  task.completedBy = actor.uuid;
  task.outcome = outcome || null;
  store.update('tasks', taskUuid, task);
  store.audit(actor, 'TASK_DONE', 'task', taskUuid, task.code + (outcome ? ' — ' + outcome : ''));
  return task;
}

// ---- Signature service -------------------------------------------------
// Signing makes a record immutable: any later update attempt is rejected (stop-gate #8).
function sign(actor, entityType, entityUuid, detail) {
  const event = {
    uuid: uuid(),
    at: nowIso(),
    signer: { uuid: actor.uuid, name: actor.name, role: actor.role },
    entityType, entityUuid,
    detail: detail || null
  };
  // Audit through the hash-chained writer ONLY (raw inserts would break chain integrity)
  store.audit(actor, 'SIGN', entityType, entityUuid, detail);
  return event;
}

function assertNotSigned(collection, rec) {
  if (!rec) throw new Error('Record not found');
  if (rec.signedAt || rec.status === 'SIGNED') {
    const e = new Error('IMMUTABLE: ' + collection + ' ' + rec.uuid + ' is signed and cannot be modified. Create a superseding record.');
    e.code = 'IMMUTABLE';
    throw e;
  }
}

// ---- Stop-gates (mandate §23) -----------------------------------------
function gate(condition, message) {
  if (condition) {
    const e = new Error(message);
    e.code = 'STOP_GATE';
    e.httpStatus = 422;
    throw e;
  }
}

module.exports = { uuid, nowIso, TASK_DEFS, createTask, openTasksForRole, tasksForPatient, completeTask, completeOpenTasks, sign, assertNotSigned, gate };
