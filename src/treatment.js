// CCA OS — Treatment execution services (Phase 3 & 4)
// Treatment Order → Pharmacy → Administration → Toxicity → Response
// Radiation Oncology & Surgical Oncology
'use strict';
const store = require('./store');
const wf = require('./workflow');
const rbac = require('./rbac');
const masters = require('./masters');
const clinical = require('./clinical');
const staging = require('./staging');

const { uuid, nowIso, gate, sign, createTask, assertNotSigned } = wf;

// ---- Regimen library (versioned; seeded neutral, institutional) ----------
const REGIMENS = [
  {
    code: 'AC', name: 'AC (breast, adjuvant/neoadjuvant)', cycleLengthDays: 21,
    version: 'CCA-INST-1.0',
    drugs: [
      { phase: 'PREMEDICATION', day: 1, medication: 'ONDANSETRON', dose: 8, doseUnits: 'mg', doseBasis: 'FIXED', route: 'ORAL', timing: '60 min prior to chemo' },
      { phase: 'PREMEDICATION', day: 1, medication: 'DEXAMETHASONE', dose: 8, doseUnits: 'mg', doseBasis: 'FIXED', route: 'ORAL', timing: '60 min prior to chemo' },
      { phase: 'DRUG', day: 1, medication: 'DOXORUBICIN', dose: 60, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV_PUSH', diluent: 'NS', timing: 'IV push over 15 min' },
      { phase: 'DRUG', day: 1, medication: 'CYCLOPHOSPHAMIDE', dose: 600, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV', diluent: 'NS', volume: 500, timing: 'Infuse over 1-2 h' }
    ]
  },
  {
    code: 'AC_PACLI', name: 'AC followed by Paclitaxel (breast)', cycleLengthDays: 21,
    version: 'CCA-INST-1.0',
    drugs: [
      { phase: 'PREMEDICATION', day: 1, medication: 'DEXAMETHASONE', dose: 8, doseUnits: 'mg', doseBasis: 'FIXED', route: 'ORAL', timing: '60 min prior' },
      { phase: 'DRUG', day: 1, medication: 'PACLITAXEL', dose: 175, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV', diluent: 'NS', volume: 500, infusionRate: '3 h continuous', timing: 'Infuse over 3 h' }
    ]
  },
  {
    code: 'CHOP', name: 'CHOP (NHL)', cycleLengthDays: 21,
    version: 'CCA-INST-1.0',
    drugs: [
      { phase: 'PREMEDICATION', day: 1, medication: 'ONDANSETRON', dose: 8, doseUnits: 'mg', doseBasis: 'FIXED', route: 'ORAL', timing: '60 min prior' },
      { phase: 'DRUG', day: 1, medication: 'CYCLOPHOSPHAMIDE', dose: 750, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV', diluent: 'NS', timing: 'Infuse over 30-60 min' },
      { phase: 'DRUG', day: 1, medication: 'DOXORUBICIN', dose: 50, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV_PUSH', diluent: 'NS', timing: 'IV push' },
      { phase: 'DRUG', day: 1, medication: 'VINCRISTINE', dose: 1.4, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV_PUSH', diluent: 'NS', timing: 'IV push (cap 2 mg)' },
      { phase: 'SUPPORTIVE', day: 1, medication: 'DEXAMETHASONE', dose: 40, doseUnits: 'mg', doseBasis: 'FIXED', route: 'ORAL', timing: 'Days 1-5' }
    ]
  },
  {
    code: 'FOLFOX', name: 'FOLFOX (colorectal)', cycleLengthDays: 14,
    version: 'CCA-INST-1.0',
    drugs: [
      { phase: 'PREMEDICATION', day: 1, medication: 'DEXAMETHASONE', dose: 8, doseUnits: 'mg', doseBasis: 'FIXED', route: 'ORAL', timing: 'prior' },
      { phase: 'DRUG', day: 1, medication: 'OXALIPLATIN', dose: 85, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV', diluent: 'D5W', timing: '2 h infusion' },
      { phase: 'DRUG', day: 1, medication: 'LEUCOVORIN', dose: 400, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV', diluent: 'NS', timing: '2 h infusion' },
      { phase: 'DRUG', day: 1, medication: '5FU', dose: 400, doseUnits: 'mg/m2', doseBasis: 'BSA', route: 'IV_PUSH', diluent: 'NS', timing: 'bolus' }
    ]
  }
];

function listRegimens() { return REGIMENS; }
function getRegimen(code) { return REGIMENS.find(r => r.code === code) || null; }

// BSA (Mosteller)
function bsa(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  return Math.sqrt((weightKg * heightCm) / 3600);
}

function calculateDose(drug, bsaValue) {
  if (drug.doseBasis === 'BSA') return Math.round(drug.dose * (bsaValue || 0) * 100) / 100;
  return drug.dose;
}

// ---- 3.1 Treatment Order (signed; separate from care plan) ----------------
function createTreatmentOrder(actor, data) {
  const patient = store.byUuid('patients', data.patientUuid);
  gate(!patient, 'Patient not found');
  const plan = store.byUuid('carePlans', data.carePlanUuid);
  gate(!plan || plan.status !== 'SIGNED', 'STOP_GATE: treatment order requires a SIGNED care plan');
  // readiness gate
  const readiness = store.findOne('readinessChecks', r => r.patientUuid === data.patientUuid);
  gate(!readiness, 'STOP_GATE: treatment readiness must be cleared before ordering');
  const regimen = getRegimen(data.regimenCode);
  gate(!regimen, 'Unknown regimen: ' + data.regimenCode);
  gate(!data.plannedCycles || data.plannedCycles < 1 || data.plannedCycles > 12, 'plannedCycles must be 1-12');
  gate(!data.weight || !data.height, 'weight and height are required (dose calculation)');
  gate(!data.startDate, 'startDate is required');

  const bsaValue = bsa(data.weight, data.height);
  gate(!bsaValue, 'BSA could not be calculated');

  const reductions = data.reductions || []; // {medication, reductionPercent, reason}
  const cycleDays = [];
  for (let c = 1; c <= data.plannedCycles; c++) {
    const day1 = new Date(data.startDate);
    day1.setDate(day1.getDate() + (c - 1) * regimen.cycleLengthDays);
    for (const drug of regimen.drugs) {
      const d = new Date(day1);
      d.setDate(d.getDate() + (drug.day - 1));
      const stdDose = calculateDose(drug, bsaValue);
      const red = reductions.find(r => r.medication === drug.medication);
      const reductionPercent = red ? Math.min(100, Math.max(0, Number(red.reductionPercent))) : 0;
      if (red) gate(!red.reason, 'Reduction reason required for ' + drug.medication);
      const orderedDose = Math.round(stdDose * (100 - reductionPercent)) / 100;
      cycleDays.push({
        cycle: c, day: drug.day, phase: drug.phase, medication: drug.medication,
        plannedDate: d.toISOString().slice(0, 10),
        standardDose: stdDose, doseUnits: drug.doseUnits, doseBasis: drug.doseBasis,
        reductionPercent, reductionReason: red ? red.reason : null,
        orderedDose, route: drug.route, diluent: drug.diluent || 'NONE',
        volume: drug.volume || null, concentration: null,
        infusionRate: drug.infusionRate || null, duration: drug.timing,
        status: 'PROJECTED'
      });
    }
  }

  const order = {
    uuid: uuid(),
    patientUuid: data.patientUuid,
    carePlanUuid: plan.uuid,
    regimenCode: regimen.code, regimenName: regimen.name, regimenVersion: regimen.version,
    plannedCycles: data.plannedCycles,
    cycleLengthDays: regimen.cycleLengthDays,
    startDate: data.startDate,
    weight: data.weight, height: data.height, bsa: Math.round(bsaValue * 100) / 100,
    supportiveTreatment: data.supportiveTreatment || '',
    cycleDays,
    orderedBy: actor.uuid, orderedByName: actor.name,
    status: 'DRAFT',
    createdAt: nowIso(), signedAt: null
  };
  store.insert('treatmentOrders', order);
  store.audit(actor, 'TREATMENT_ORDER_DRAFTED', 'treatmentOrder', order.uuid, regimen.name);
  return order;
}

function signTreatmentOrder(actor, orderUuid) {
  const order = store.byUuid('treatmentOrders', orderUuid);
  gate(!order, 'Treatment order not found');
  assertNotSigned('treatmentOrder', order);
  order.status = 'SIGNED';
  order.signedAt = nowIso();
  order.signature = sign(actor, 'treatmentOrder', order.uuid, order.regimenName + ' x ' + order.plannedCycles + ' cycles');
  store.update('treatmentOrders', orderUuid, order);

  // Calendar projection: treatment days, labs, toxicity review, response assessment
  const events = projectEvents(order);
  for (const ev of events) store.insert('events', ev);

  // Task: order signed → pharmacy
  createTask(actor, 'PHARMACY_VERIFY', order.patientUuid, { orderUuid: order.uuid });
  store.audit(actor, 'TREATMENT_ORDER_SIGNED', 'treatmentOrder', order.uuid, order.regimenName);
  return order;
}

function projectEvents(order) {
  const events = [];
  const byKey = {};
  for (const cd of order.cycleDays) {
    const key = cd.cycle + '-' + cd.day + '-' + cd.plannedDate;
    if (!byKey[key]) {
      byKey[key] = {
        uuid: uuid(), patientUuid: order.patientUuid, type: 'CHEMOTHERAPY',
        refUuid: order.uuid, cycle: cd.cycle, day: cd.day,
        plannedDate: cd.plannedDate, actualDate: null,
        state: 'PROJECTED', title: 'Chemo C' + cd.cycle + 'D' + cd.day
      };
    }
  }
  Object.values(byKey).forEach(e => events.push(e));
  // pre-cycle labs 48h before each cycle day 1
  const cycleStarts = [...new Set(order.cycleDays.filter(c => c.day === 1).map(c => c.plannedDate))].sort();
  cycleStarts.forEach((d, i) => {
    const labDate = new Date(d); labDate.setDate(labDate.getDate() - 2);
    events.push({
      uuid: uuid(), patientUuid: order.patientUuid, type: 'LAB',
      refUuid: order.uuid, cycle: i + 1, day: 0,
      plannedDate: labDate.toISOString().slice(0, 10), actualDate: null,
      state: 'PROJECTED', title: 'Pre-cycle labs C' + (i + 1)
    });
    const toxDate = new Date(d); toxDate.setDate(toxDate.getDate() + 10);
    events.push({
      uuid: uuid(), patientUuid: order.patientUuid, type: 'TOXICITY_ASSESSMENT',
      refUuid: order.uuid, cycle: i + 1, day: 10,
      plannedDate: toxDate.toISOString().slice(0, 10), actualDate: null,
      state: 'PROJECTED', title: 'Toxicity review C' + (i + 1)
    });
  });
  // response assessment after final cycle
  const last = cycleStarts[cycleStarts.length - 1];
  if (last) {
    const respDate = new Date(last); respDate.setDate(respDate.getDate() + order.cycleLengthDays + 7);
    events.push({
      uuid: uuid(), patientUuid: order.patientUuid, type: 'RESPONSE_IMAGING',
      refUuid: order.uuid, cycle: null, day: null,
      plannedDate: respDate.toISOString().slice(0, 10), actualDate: null,
      state: 'PROJECTED', title: 'Response assessment imaging'
    });
  }
  return events;
}

// ---- Delay records: preserve original plan, revise downstream -------------
function delayCycle(actor, data) {
  const order = store.byUuid('treatmentOrders', data.orderUuid);
  gate(!order, 'Treatment order not found');
  gate(!data.reason, 'Delay reason is required');
  gate(!data.revisedDate, 'revisedDate is required');
  const affected = [];
  const cycleDays = order.cycleDays.map(cd => {
    if (cd.cycle === data.cycle && cd.status === 'PROJECTED') {
      const original = cd.plannedDate;
      const shiftDays = Math.round((new Date(data.revisedDate) - new Date(original)) / 86400000);
      const nd = new Date(original); nd.setDate(nd.getDate() + shiftDays);
      const updated = Object.assign({}, cd, { plannedDate: nd.toISOString().slice(0, 10), status: 'DELAYED' });
      affected.push({ originalPlannedDate: original, revisedDate: updated.plannedDate });
      return updated;
    }
    // downstream cycles shift by the same delta
    if (data.shiftDownstream && cd.cycle > data.cycle && cd.status === 'PROJECTED') {
      const original = cd.plannedDate;
      const nd = new Date(original); nd.setDate(nd.getDate() + data.shiftDays);
      const updated = Object.assign({}, cd, { plannedDate: nd.toISOString().slice(0, 10) });
      affected.push({ originalPlannedDate: original, revisedDate: updated.plannedDate });
      return updated;
    }
    return cd;
  });
  order.cycleDays = cycleDays;
  store.update('treatmentOrders', order.uuid, order);

  // update projected events
  for (const a of affected) {
    const ev = store.find('events', e => e.refUuid === order.uuid && e.plannedDate === a.originalPlannedDate && e.state === 'PROJECTED');
    for (const e of ev) store.update('events', e.uuid, { plannedDate: a.revisedDate, state: 'DELAYED' });
  }
  const delay = {
    uuid: uuid(), orderUuid: order.uuid, cycle: data.cycle,
    originalPlannedDate: data.originalDate || affected[0] ? (affected[0] ? affected[0].originalPlannedDate : data.originalDate) : data.originalDate,
    reason: data.reason, revisedDate: data.revisedDate,
    affectedFutureDates: affected,
    by: actor.uuid, at: nowIso()
  };
  store.insert('delayRecords', delay);
  store.audit(actor, 'CYCLE_DELAYED', 'treatmentOrder', order.uuid, 'C' + data.cycle + ': ' + data.reason);
  return delay;
}

// ---- 3.2 Pharmacy -----------------------------------------------------------
function pharmacyReceive(actor, orderUuid) {
  const order = store.byUuid('treatmentOrders', orderUuid);
  gate(!order || order.status !== 'SIGNED', 'STOP_GATE: pharmacy can only receive a SIGNED treatment order');
  const rec = store.findOne('pharmacyRecords', r => r.orderUuid === orderUuid);
  gate(rec, 'Order already in pharmacy queue');
  const record = {
    uuid: uuid(), orderUuid, patientUuid: order.patientUuid,
    regimenVerified: false, doseVerified: false, allergyCheck: false,
    interactionCheck: false, compatibilityCheck: false, stabilityCheck: false,
    stockAllocated: false, prepared: false, compounded: false,
    independentCheckBy: null, labelPrinted: false,
    status: 'IN_PHARMACY', // IN_PHARMACY → VERIFIED → PREPARED → RELEASED | REJECTED
    rejectionReason: null,
    receivedAt: nowIso(), by: actor.uuid,
    releasedAt: null
  };
  store.insert('pharmacyRecords', record);
  store.audit(actor, 'PHARMACY_RECEIVED', 'pharmacyRecord', record.uuid, order.regimenName);
  return record;
}

function pharmacyVerify(actor, recUuid, checks) {
  const rec = store.byUuid('pharmacyRecords', recUuid);
  gate(!rec, 'Pharmacy record not found');
  const order = store.byUuid('treatmentOrders', rec.orderUuid);
  const patient = store.byUuid('patients', rec.patientUuid);
  // Allergy check against patient record
  if (checks.allergyCheck) {
    const drugMeds = order.cycleDays.map(c => c.medication);
    for (const allergy of patient.allergies || []) {
      if (drugMeds.includes(allergy)) {
        rec.status = 'REJECTED';
        rec.rejectionReason = 'ALLERGY: patient allergic to ' + allergy;
        store.update('pharmacyRecords', recUuid, rec);
        createTask(actor, 'CREATE_TREATMENT_ORDER', rec.patientUuid, { pharmacyUuid: recUuid, reason: rec.rejectionReason });
        gate(true, 'STOP_GATE: ' + rec.rejectionReason);
      }
    }
  }
  rec.regimenVerified = !!checks.regimenVerified;
  rec.doseVerified = !!checks.doseVerified;
  rec.allergyCheck = !!checks.allergyCheck;
  rec.interactionCheck = !!checks.interactionCheck;
  rec.compatibilityCheck = !!checks.compatibilityCheck;
  rec.stabilityCheck = !!checks.stabilityCheck;
  rec.stockAllocated = !!checks.stockAllocated;
  if (rec.regimenVerified && rec.doseVerified && rec.allergyCheck && rec.interactionCheck && rec.compatibilityCheck && rec.stabilityCheck && rec.stockAllocated) {
    rec.status = 'VERIFIED';
  }
  store.update('pharmacyRecords', recUuid, rec);
  store.audit(actor, 'PHARMACY_VERIFIED', 'pharmacyRecord', recUuid);
  return rec;
}

function pharmacyPrepare(actor, recUuid, prep) {
  const rec = store.byUuid('pharmacyRecords', recUuid);
  gate(!rec || rec.status !== 'VERIFIED', 'STOP_GATE: preparation requires VERIFIED status');
  rec.prepared = true;
  rec.compounded = !!prep.compounded;
  rec.preparationNotes = prep.notes || '';
  rec.status = 'PREPARED';
  store.update('pharmacyRecords', recUuid, rec);
  store.audit(actor, 'PHARMACY_PREPARED', 'pharmacyRecord', recUuid);
  return rec;
}

function pharmacyRelease(actor, recUuid, independentCheckBy) {
  const rec = store.byUuid('pharmacyRecords', recUuid);
  gate(!rec || rec.status !== 'PREPARED', 'STOP_GATE: release requires PREPARED status');
  gate(!independentCheckBy, 'Independent check (second pharmacist) is required');
  rec.independentCheckBy = independentCheckBy;
  rec.labelPrinted = true;
  rec.status = 'RELEASED';
  rec.releasedAt = nowIso();
  store.update('pharmacyRecords', recUuid, rec);
  // Task: pharmacy released → Day Care (dispense then administer)
  createTask(actor, 'DISPENSE', rec.patientUuid, { pharmacyUuid: recUuid, orderUuid: rec.orderUuid });
  store.audit(actor, 'PHARMACY_RELEASED', 'pharmacyRecord', recUuid);
  return rec;
}

// ---- D3 fix: DispenseRecord (canonical §35) ---------------------------------
// Release ≠ dispense. A pharmacist (or pharmacy tech) dispenses the released
// preparation to the patient/destination with chain of custody. Day care can only
// administer against a DISPENSED record.
function dispense(actor, data) {
  rbac.assertCanWrite(actor, 'dispense');
  const rec = store.byUuid('pharmacyRecords', data.pharmacyUuid);
  gate(!rec || rec.status !== 'RELEASED', 'STOP_GATE: dispensing requires a RELEASED preparation');
  const existing = store.findOne('dispenseRecords', d => d.pharmacyUuid === rec.uuid);
  gate(existing, 'Preparation already dispensed');
  gate(!data.destination, 'destination required (DAY_CARE | INPATIENT | HOME_THERAPY)');
  gate(!data.checkedOutTo, 'checkedOutTo (receiving person) required');
  const order = store.byUuid('treatmentOrders', rec.orderUuid);
  const d = {
    uuid: uuid(),
    pharmacyUuid: rec.uuid,
    orderUuid: rec.orderUuid,
    patientUuid: rec.patientUuid,
    regimenName: order ? order.regimenName : null,
    destination: data.destination,
    checkedOutTo: data.checkedOutTo,
    dispensedBy: actor.uuid, dispensedByName: actor.name,
    dispensedAt: nowIso(),
    chainOfCustody: [
      { step: 'PREPARED', by: rec.by, at: rec.receivedAt },
      { step: 'RELEASED', by: actor.uuid, at: rec.releasedAt },
      { step: 'DISPENSED', by: actor.uuid, at: nowIso(), to: data.checkedOutTo, destination: data.destination }
    ]
  };
  store.insert('dispenseRecords', d);
  store.update('pharmacyRecords', rec.uuid, { status: 'DISPENSED' });
  createTask(actor, 'ADMINISTER', rec.patientUuid, { pharmacyUuid: rec.uuid, orderUuid: rec.orderUuid, dispenseUuid: d.uuid });
  store.audit(actor, 'DISPENSED', 'dispenseRecord', d.uuid, d.destination + ' → ' + data.checkedOutTo);
  return d;
}

// ---- 3.3 Day care administration -------------------------------------------
const ADM_STATES = ['ARRIVED', 'READY', 'IN_PROGRESS', 'COMPLETED'];

function startAdministration(actor, pharmacyUuid) {
  const rec = store.byUuid('pharmacyRecords', pharmacyUuid);
  gate(!rec || rec.status !== 'DISPENSED', 'STOP_GATE: administration requires a DISPENSED preparation (release ≠ dispense). No dispense record found.');
  const existing = store.findOne('administrationRecords', a => a.pharmacyUuid === pharmacyUuid);
  gate(existing, 'Administration already started for this release');
  const disp = store.findOne('dispenseRecords', d => d.pharmacyUuid === pharmacyUuid);
  const adm = {
    uuid: uuid(),
    patientUuid: rec.patientUuid,
    orderUuid: rec.orderUuid,
    pharmacyUuid,
    dispenseUuid: disp ? disp.uuid : null,
    arrival: nowIso(),
    readiness: { vitalsStable: false, accessConfirmed: false, premedicationsGiven: false },
    access: null,
    lines: [], // {medication, phase, start, stop, actualDose, route, rate, interruption:{reason,durationMin}, reaction:{type, grade, intervention}}
    status: 'ARRIVED',
    completedAt: null, dischargedAt: null,
    nurse: actor.uuid, nurseName: actor.name
  };
  store.insert('administrationRecords', adm);
  store.audit(actor, 'ADMINISTRATION_STARTED', 'administrationRecord', adm.uuid);
  return adm;
}

function updateAdministration(actor, admUuid, data) {
  const adm = store.byUuid('administrationRecords', admUuid);
  gate(!adm, 'Administration record not found');
  gate(adm.status === 'COMPLETED', 'Administration completed and immutable — create a new record');
  if (data.readiness) Object.assign(adm.readiness, data.readiness);
  if (data.access) adm.access = data.access; // {type, site}
  if (data.premedicationsGiven) adm.readiness.premedicationsGiven = true;
  if (data.line) adm.lines.push(data.line);
  if (data.status && ADM_STATES.includes(data.status)) adm.status = data.status;
  // D10a: patient identity verification with two independent identifiers (canonical §37)
  if (data.patientIdentityVerification) {
    const v = data.patientIdentityVerification;
    gate(v.method !== 'TWO_IDENTIFIER', 'Patient verification must use TWO independent identifiers (name + MRN)');
    gate(!v.nameConfirmation || !v.mrnConfirmation, 'Both identifiers must be confirmed verbally at the chair');
    adm.patientIdentityVerification = { method: 'TWO_IDENTIFIER', nameConfirmation: true, mrnConfirmation: true, verifiedBy: actor.uuid, at: nowIso() };
  }
  store.update('administrationRecords', admUuid, adm);
  store.audit(actor, 'ADMINISTRATION_UPDATED', 'administrationRecord', admUuid, data.status || '');
  return adm;
}

// ---- D10a: structured InfusionReaction (canonical §37) ------------------------
// Separate record — not a checkbox on the administration line.
function recordInfusionReaction(actor, data) {
  rbac.assertCanWrite(actor, 'recordInfusionReaction');
  const adm = store.byUuid('administrationRecords', data.administrationUuid);
  gate(!adm, 'Administration record not found');
  gate(adm.status === 'COMPLETED', 'Administration completed — use Toxicity assessment instead');
  gate(!data.onsetTime, 'onsetTime is required');
  gate(!data.severity || !['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'].includes(data.severity), 'severity must be MILD | MODERATE | SEVERE | LIFE_THREATENING');
  gate(!data.symptoms || !data.symptoms.length, 'at least one symptom is required');
  gate(!data.actions || !data.actions.length, 'action taken is required');
  const r = {
    uuid: uuid(),
    administrationUuid: adm.uuid,
    patientUuid: adm.patientUuid,
    orderUuid: adm.orderUuid,
    runningDrug: data.runningDrug || null,
    onsetTime: data.onsetTime,
    symptoms: data.symptoms,               // [{symptom, note}]
    severity: data.severity,
    vitals: data.vitals || null,           // {bp, hr, spo2, temp}
    actions: data.actions,                 // [STOP_INFUSION|RESUCE_MEDICATION|PHYSICIAN_NOTIFIED|IV_FLUIDS|OXYGEN|OTHER]
    physicianNotified: (data.actions || []).includes('PHYSICIAN_NOTIFIED'),
    infusionStopped: (data.actions || []).includes('STOP_INFUSION'),
    rescueMedication: data.rescueMedication || '',
    outcome: data.outcome || null,         // RESTARTED | DISCONTINUED | OBSERVATION | ADMITTED | null(ongoing)
    escalationLevel: data.escalationLevel || 'WARD',
    recordedBy: actor.uuid, recordedByName: actor.name,
    at: nowIso(), status: 'OPEN'
  };
  store.insert('infusionReactions', r);
  if (r.physicianNotified) {
    createTask(actor, 'INFUSION_REACTION_REVIEW', adm.patientUuid, { infusionReactionUuid: r.uuid, reason: 'infusion reaction ' + r.severity });
  }
  store.audit(actor, 'INFUSION_REACTION_RECORDED', 'infusionReaction', r.uuid, r.severity);
  return r;
}

function resolveInfusionReaction(actor, reactionUuid, outcome) {
  rbac.assertCanWrite(actor, 'resolveInfusionReaction');
  const r = store.byUuid('infusionReactions', reactionUuid);
  gate(!r, 'Infusion reaction not found');
  gate(!outcome || !['RESTARTED', 'DISCONTINUED', 'OBSERVATION', 'ADMITTED'].includes(outcome), 'Invalid outcome');
  r.outcome = outcome;
  r.status = 'RESOLVED';
  r.resolvedBy = actor.uuid; r.resolvedAt = nowIso();
  store.update('infusionReactions', reactionUuid, r);
  store.audit(actor, 'INFUSION_REACTION_RESOLVED', 'infusionReaction', r.uuid, outcome);
  return r;
}

function completeAdministration(actor, admUuid) {
  const adm = store.byUuid('administrationRecords', admUuid);
  gate(!adm, 'Administration not found');
  gate(adm.status === 'COMPLETED', 'Already completed');
  gate(!adm.readiness.vitalsStable || !adm.access, 'Readiness checks incomplete');
  gate(!adm.patientIdentityVerification, 'STOP_GATE: two-identifier patient verification (name + MRN) must be completed before discharge');
  adm.status = 'COMPLETED';
  adm.completedAt = nowIso();
  adm.dischargedAt = nowIso();
  store.update('administrationRecords', admUuid, adm);

  // mark delivered chemotherapy events
  const today = new Date().toISOString().slice(0, 10);
  for (const ev of store.find('events', e => e.refUuid === adm.orderUuid && e.type === 'CHEMOTHERAPY' && e.plannedDate <= today && (e.state === 'PROJECTED' || e.state === 'SCHEDULED' || e.state === 'DELAYED'))) {
    store.update('events', ev.uuid, { state: 'COMPLETED', actualDate: today });
  }
  // Tasks: toxicity review + next cycle review
  createTask(actor, 'TOXICITY_REVIEW', adm.patientUuid, { administrationUuid: adm.uuid });
  createTask(actor, 'NEXT_CYCLE_REVIEW', adm.patientUuid, { orderUuid: adm.orderUuid });
  store.audit(actor, 'ADMINISTRATION_COMPLETED', 'administrationRecord', admUuid);
  return adm;
}

// ---- D8: Next-cycle decision (canonical §40) ---------------------------------
// After each completed cycle the oncologist must make an explicit, audited decision
// with the full prior-context aggregate in view. Previous cycle stays immutable.
const NEXT_CYCLE_OPTIONS = ['PROCEED_UNCHANGED', 'PROCEED_WITH_MODIFICATION', 'DELAY', 'HOLD', 'DISCONTINUE', 'CHANGE_REGIMEN', 'COMPLETE_TREATMENT'];

function nextCycleContext(actor, patientUuid, orderUuid) {
  const order = store.byUuid('treatmentOrders', orderUuid);
  gate(!order || order.patientUuid !== patientUuid, 'Order not found for this patient');
  const adminRecords = store.find('administrationRecords', a => a.orderUuid === orderUuid);
  const toxicities = store.find('toxicityAssessments', t => t.orderUuid === orderUuid);
  const reactions = store.find('infusionReactions', r => r.orderUuid === orderUuid);
  const responses = store.find('responseAssessments', r => r.patientUuid === patientUuid);
  const priorDecision = store.find('nextCycleDecisions', d => d.orderUuid === orderUuid)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  return {
    order: {
      uuid: order.uuid, regimenName: order.regimenName, regimenVersion: order.regimenVersion,
      plannedCycles: order.plannedCycles, weight: order.weight, height: order.height, bsa: order.bsa,
      reductions: order.reductions || [],
      orderedDoses: (order.cycleDays || []).filter(c => c.cycleNumber === 1).map(c => ({ phase: c.phase, medication: c.medication, standardDose: c.standardDose, orderedDose: c.orderedDose, route: c.route }))
    },
    administrations: adminRecords.map(a => ({
      uuid: a.uuid, status: a.status, startedAt: a.arrival, completedAt: a.completedAt,
      identityVerified: !!a.patientIdentityVerification,
      lines: (a.lines || []).map(l => ({ phase: l.phase, medication: l.medication, actualDose: l.actualDose, route: l.route, interruption: l.interruption }))
    })),
    missedOrDelayed: (order.cycleDays || []).filter(c => c.plannedDate < new Date().toISOString().slice(0, 10) && (c.status === 'PROJECTED' || c.status === 'DELAYED')).map(c => ({ cycleNumber: c.cycleNumber, plannedDate: c.plannedDate, status: c.status })),
    toxicities: toxicities.map(t => ({ type: t.type, grade: t.grade, toxicityVersion: t.toxicityVersion, onset: t.onset, resolution: t.resolution, doseReduction: t.doseReduction, hospitalization: t.hospitalization, status: t.status })),
    reactions: reactions.map(r => ({ severity: r.severity, runningDrug: r.runningDrug, outcome: r.outcome, status: r.status })),
    hospitalizations: toxicities.filter(t => t.hospitalization).length,
    response: responses.length ? { category: responses[0].category, decision: responses[0].decision, signedAt: responses[0].signedAt } : null,
    priorDecisions: store.find('nextCycleDecisions', d => d.orderUuid === orderUuid).map(d => ({ decision: d.decision, at: d.createdAt, by: d.decidedByName, status: d.status }))
  };
}

function recordNextCycleDecision(actor, data) {
  rbac.assertCanWrite(actor, 'nextCycleDecision');
  const patient = store.byUuid('patients', data.patientUuid);
  gate(!patient, 'Patient not found');
  const order = store.byUuid('treatmentOrders', data.orderUuid);
  gate(!order || order.patientUuid !== patient.uuid, 'Treatment order not found for this patient');
  gate(!data.decision || !NEXT_CYCLE_OPTIONS.includes(data.decision), 'decision must be one of ' + NEXT_CYCLE_OPTIONS.join(' | '));
  if (data.decision === 'PROCEED_WITH_MODIFICATION') gate(!data.modification, 'modification details required (dose change / delay plan)');
  if (data.decision === 'CHANGE_REGIMEN') gate(!data.newRegimenCode, 'newRegimenCode required when changing regimen');
  if (data.decision === 'DELAY') gate(!data.newStartDate, 'newStartDate required when delaying');
  const dec = {
    uuid: uuid(),
    patientUuid: patient.uuid,
    orderUuid: order.uuid,
    cycleNumber: data.cycleNumber || null,
    decision: data.decision,
    modification: data.modification || null,          // {doseReductionPercent, medication, reason}
    newRegimenCode: data.newRegimenCode || null,
    newStartDate: data.newStartDate || null,
    rationale: data.rationale || '',
    contextSnapshot: nextCycleContext(actor, patient.uuid, order.uuid), // frozen at decision time
    decidedBy: actor.uuid, decidedByName: actor.name,
    createdAt: nowIso(), signedAt: null, status: 'DRAFT'
  };
  store.insert('nextCycleDecisions', dec);
  return dec;
}

function signNextCycleDecision(actor, decUuid) {
  rbac.assertCanWrite(actor, 'nextCycleDecision');
  const dec = store.byUuid('nextCycleDecisions', decUuid);
  gate(!dec, 'Next-cycle decision not found');
  assertNotSigned('nextCycleDecision', dec);
  dec.status = 'SIGNED';
  dec.signedAt = nowIso();
  dec.signature = sign(actor, 'nextCycleDecision', dec.uuid, dec.decision);
  store.update('nextCycleDecisions', dec.uuid, dec);

  // Route the next responsibility (canonical §40 decision table)
  if (dec.decision === 'PROCEED_UNCHANGED') {
    createTask(actor, 'CREATE_TREATMENT_ORDER', dec.patientUuid, { reason: 'next cycle — proceed unchanged', priorOrderUuid: dec.orderUuid });
  } else if (dec.decision === 'PROCEED_WITH_MODIFICATION' || dec.decision === 'CHANGE_REGIMEN') {
    createTask(actor, 'CREATE_TREATMENT_ORDER', dec.patientUuid, { reason: dec.modification ? 'modified: ' + JSON.stringify(dec.modification) : 'regimen change to ' + dec.newRegimenCode, priorOrderUuid: dec.orderUuid });
  } else if (dec.decision === 'DELAY' || dec.decision === 'HOLD') {
    createTask(actor, 'NEXT_CYCLE_REVIEW', dec.patientUuid, { orderUuid: dec.orderUuid, reason: 're-review after ' + dec.decision.toLowerCase() + (dec.newStartDate ? ' — revised start ' + dec.newStartDate : '') }, 72);
  } else if (dec.decision === 'DISCONTINUE') {
    createTask(actor, 'RESPONSE_ASSESS', dec.patientUuid, { reason: 'treatment discontinued at next-cycle review' });
  } else if (dec.decision === 'COMPLETE_TREATMENT') {
    createTask(actor, 'RESPONSE_ASSESS', dec.patientUuid, { reason: 'treatment course completed — end-of-treatment response assessment' });
  }
  store.audit(actor, 'NEXT_CYCLE_DECISION_SIGNED', 'nextCycleDecision', dec.uuid, dec.decision);
  return dec;
}

// ---- 3.4 Toxicity -------------------------------------------------------------
function recordToxicity(actor, data) {
  const patient = store.byUuid('patients', data.patientUuid);
  gate(!patient, 'Patient not found');
  gate(!data.type || !masters.getByCode('toxicity', data.type), 'Unknown governed toxicity type');
  gate(!data.grade || data.grade < 1 || data.grade > 5, 'Grade must be 1-5');
  gate(!data.onset, 'onset date is required');
  gate(new Date(data.onset) > new Date(), 'onset cannot be in the future');
  gate(!data.attribution || !['TREATMENT', 'DISEASE', 'OTHER', 'UNKNOWN'].includes(data.attribution), 'Invalid attribution');
  // D10b: version-aware toxicity (canonical §66) — stamp CTCAE version at creation;
  // historical records preserve the version they were graded under.
  const toxVersion = data.toxicityVersion || 'CTCAE_V6';
  gate(!masters.getByCode('toxicityVersion', toxVersion), 'Unknown governed toxicity version');
  const tox = {
    uuid: uuid(),
    patientUuid: data.patientUuid,
    orderUuid: data.orderUuid || null,
    type: data.type,
    grade: data.grade,
    toxicityVersion: toxVersion,
    onset: data.onset,
    attribution: data.attribution,
    intervention: data.intervention || '',
    hospitalization: !!data.hospitalization,
    treatmentHold: !!data.treatmentHold,
    treatmentDelay: !!data.treatmentDelay,
    doseReduction: data.doseReduction || null, // {medication, newReductionPercent}
    discontinuation: !!data.discontinuation,
    resolution: data.resolution || 'ONGOING',   // RESOLVED | IMPROVING | ONGOING | DEATH
    nextCycleImplication: data.nextCycleImplication || '',
    assessedBy: actor.uuid, assessedByName: actor.name,
    signedAt: null, at: nowIso()
  };
  store.insert('toxicityAssessments', tox);
  return tox;
}

function signToxicity(actor, toxUuid) {
  const tox = store.byUuid('toxicityAssessments', toxUuid);
  gate(!tox, 'Toxicity not found');
  assertNotSigned('toxicityAssessment', tox);
  tox.status = 'SIGNED';
  tox.signedAt = nowIso();
  tox.signature = sign(actor, 'toxicityAssessment', tox.uuid, tox.type + ' G' + tox.grade);
  store.update('toxicityAssessments', toxUuid, tox);

  if (tox.treatmentDelay && tox.orderUuid) {
    createTask(actor, 'NEXT_CYCLE_REVIEW', tox.patientUuid, { orderUuid: tox.orderUuid, reason: 'toxicity delay G' + tox.grade });
  }
  if (tox.doseReduction) {
    createTask(actor, 'CREATE_TREATMENT_ORDER', tox.patientUuid, { reason: 'dose reduction ' + tox.doseReduction.medication + ' to ' + tox.doseReduction.newReductionPercent + '%' });
  }
  if (tox.discontinuation) {
    createTask(actor, 'RESPONSE_ASSESS', tox.patientUuid, { reason: 'treatment discontinued due to toxicity' });
  }
  store.audit(actor, 'TOXICITY_SIGNED', 'toxicityAssessment', tox.uuid, tox.type + ' G' + tox.grade);
  return tox;
}

// ---- 3.5 Response ---------------------------------------------------------------
function recordResponseAssessment(actor, data) {
  const patient = store.byUuid('patients', data.patientUuid);
  gate(!patient, 'Patient not found');
  gate(!data.category || !masters.getByCode('response', data.category), 'Unknown governed response category');
  gate(!data.decision || !['CONTINUE', 'MODIFY', 'NEXT_LINE', 'SURVEILLANCE'].includes(data.decision), 'decision must route next treatment');
  const resp = {
    uuid: uuid(),
    patientUuid: data.patientUuid,
    orderUuid: data.orderUuid || null,
    category: data.category,
    evidence: data.evidence || [], // imaging result uuids
    decision: data.decision,
    notes: data.notes || '',
    assessedBy: actor.uuid, assessedByName: actor.name,
    signedAt: null, at: nowIso()
  };
  store.insert('responseAssessments', resp);
  return resp;
}

function signResponseAssessment(actor, respUuid) {
  const resp = store.byUuid('responseAssessments', respUuid);
  gate(!resp, 'Response assessment not found');
  assertNotSigned('responseAssessment', resp);
  for (const ev of resp.evidence || []) {
    const r = store.byUuid('results', ev);
    gate(!r || r.patientUuid !== resp.patientUuid, 'CROSS_PATIENT_EVIDENCE in response assessment');
  }
  resp.status = 'SIGNED';
  resp.signedAt = nowIso();
  resp.signature = sign(actor, 'responseAssessment', resp.uuid, resp.category + ' → ' + resp.decision);
  store.update('responseAssessments', respUuid, resp);

  if (resp.decision === 'NEXT_LINE') createTask(actor, 'CREATE_CARE_PLAN', resp.patientUuid, { reason: 'response PD — next line' });
  if (resp.decision === 'MODIFY') createTask(actor, 'NEXT_CYCLE_REVIEW', resp.patientUuid, { reason: 'modify current treatment' });
  if (resp.decision === 'CONTINUE') createTask(actor, 'NEXT_CYCLE_REVIEW', resp.patientUuid, { reason: 'continue current treatment' });
  if (resp.decision === 'SURVEILLANCE') createTask(actor, 'RESPONSE_ASSESS', resp.patientUuid, { reason: 'surveillance — next assessment due', surveillance: true });
  store.audit(actor, 'RESPONSE_SIGNED', 'responseAssessment', resp.uuid, resp.category + ' → ' + resp.decision);
  return resp;
}

// ---- 4.3 Radiation oncology -------------------------------------------------
function createRtPrescription(actor, data) {
  const patient = store.byUuid('patients', data.patientUuid);
  gate(!patient, 'Patient not found');
  gate(!data.intent, 'intent required (CURATIVE|PALLIATIVE|ADJUVANT)');
  gate(!data.site, 'site required');
  gate(!data.dosePerFraction || !data.fractions, 'dosePerFraction and fractions required');
  const totalDose = Number(data.dosePerFraction) * Number(data.fractions);
  const rx = {
    uuid: uuid(), patientUuid: data.patientUuid,
    intent: data.intent, site: data.site,
    technique: data.technique || '',
    dosePerFraction: Number(data.dosePerFraction), fractions: Number(data.fractions),
    totalDose,
    simulationDate: data.simulationDate || null,
    contourSet: data.contourSet || '',
    physicsCheck: null,          // physicist approval
    physicianApproval: null,
    status: 'PLANNED',           // PLANNED → APPROVED
    prescribedBy: actor.uuid, prescribedByName: actor.name,
    createdAt: nowIso(), signedAt: null
  };
  store.insert('rtPrescriptions', rx);
  createTask(actor, 'RT_PLAN_APPROVE', data.patientUuid, { rtUuid: rx.uuid });
  return rx;
}

function approveRtPlan(actor, rxUuid, physicsCheck) {
  const rx = store.byUuid('rtPrescriptions', rxUuid);
  gate(!rx || rx.status !== 'PLANNED', 'RT prescription must be PLANNED');
  gate(!physicsCheck, 'Physics check required before approval');
  rx.physicsCheck = physicsCheck;
  rx.physicianApproval = actor.uuid;
  rx.status = 'APPROVED';
  rx.signedAt = nowIso();
  rx.signature = sign(actor, 'rtPrescription', rx.uuid, rx.totalDose + ' Gy / ' + rx.fractions + ' fx');
  store.update('rtPrescriptions', rxUuid, rx);
  // create course + projected fraction events
  const course = { uuid: uuid(), rxUuid: rx.uuid, patientUuid: rx.patientUuid, status: 'IN_PROGRESS', fractions: [], startedAt: nowIso() };
  store.insert('rtCourses', course);
  for (let i = 1; i <= rx.fractions; i++) {
    const d = new Date(); d.setDate(d.getDate() + i - 1);
    store.insert('events', {
      uuid: uuid(), patientUuid: rx.patientUuid, type: 'RT_FRACTION',
      refUuid: course.uuid, fraction: i, plannedDate: d.toISOString().slice(0, 10),
      actualDate: null, state: 'PROJECTED', title: 'RT fraction ' + i + '/' + rx.fractions
    });
  }
  createTask(actor, 'ADMINISTER', rx.patientUuid, { rtCourseUuid: course.uuid, reason: 'RT fractions begin' });
  store.audit(actor, 'RT_APPROVED', 'rtPrescription', rx.uuid);
  return { rx, course };
}

function recordRtFraction(actor, data) {
  const course = store.byUuid('rtCourses', data.courseUuid);
  gate(!course, 'RT course not found');
  const rx = store.byUuid('rtPrescriptions', course.rxUuid);
  gate(!rx || rx.status !== 'APPROVED', 'STOP_GATE: delivery requires APPROVED plan');
  gate(!data.fractionNumber || data.fractionNumber < 1 || data.fractionNumber > rx.fractions, 'Invalid fraction number');
  const frac = {
    uuid: uuid(), courseUuid: course.uuid, patientUuid: rx.patientUuid,
    fractionNumber: data.fractionNumber,
    deliveredDate: data.deliveredDate || new Date().toISOString().slice(0, 10),
    deliveredDose: rx.dosePerFraction,
    interruption: data.interruption || null,
    notes: data.notes || '',
    by: actor.uuid, at: nowIso()
  };
  store.insert('rtFractions', frac);
  course.fractions.push(frac.uuid);
  store.update('rtCourses', course.uuid, course);
  const ev = store.find('events', e => e.refUuid === course.uuid && e.fraction === data.fractionNumber)[0];
  if (ev) store.update('events', ev.uuid, { state: 'COMPLETED', actualDate: frac.deliveredDate });
  if (course.fractions.length >= rx.fractions) {
    course.status = 'COMPLETED';
    store.update('rtCourses', course.uuid, course);
    createTask(actor, 'TOXICITY_REVIEW', rx.patientUuid, { rtCourseUuid: course.uuid, reason: 'RT course completed' });
  }
  store.audit(actor, 'RT_FRACTION_DELIVERED', 'rtFraction', frac.uuid, frac.fractionNumber + '/' + rx.fractions);
  return frac;
}

// ---- 4.4 Surgical oncology ----------------------------------------------------
function createSurgicalPlan(actor, data) {
  const patient = store.byUuid('patients', data.patientUuid);
  gate(!patient, 'Patient not found');
  gate(!data.procedure, 'procedure is required');
  gate(!data.plannedDate, 'plannedDate is required');
  const plan = {
    uuid: uuid(), patientUuid: data.patientUuid,
    procedure: data.procedure, laterality: data.laterality || null,
    approach: data.approach || '', anesthesiaPlan: data.anesthesiaPlan || '',
    implants: data.implants || '', consentRef: data.consentRef || null,
    plannedDate: data.plannedDate,
    surgeon: actor.uuid, surgeonName: actor.name,
    status: 'DRAFT', createdAt: nowIso(), signedAt: null
  };
  store.insert('surgicalPlans', plan);
  return plan;
}

function signSurgicalPlan(actor, planUuid) {
  const plan = store.byUuid('surgicalPlans', planUuid);
  gate(!plan, 'Surgical plan not found');
  assertNotSigned('surgicalPlan', plan);
  plan.status = 'SIGNED';
  plan.signedAt = nowIso();
  plan.signature = sign(actor, 'surgicalPlan', plan.uuid, plan.procedure);
  store.update('surgicalPlans', planUuid, plan);
  store.insert('events', {
    uuid: uuid(), patientUuid: plan.patientUuid, type: 'SURGERY',
    refUuid: plan.uuid, plannedDate: plan.plannedDate, actualDate: null,
    state: 'SCHEDULED', title: plan.procedure
  });
  createTask(actor, 'SURGERY_RECORD', plan.patientUuid, { surgicalPlanUuid: plan.uuid });
  store.audit(actor, 'SURGICAL_PLAN_SIGNED', 'surgicalPlan', plan.uuid, plan.procedure);
  return plan;
}

function recordOperativeNote(actor, data) {
  const plan = store.byUuid('surgicalPlans', data.surgicalPlanUuid);
  gate(!plan || plan.status !== 'SIGNED', 'STOP_GATE: operative record requires a SIGNED surgical plan');
  gate(!data.performedProcedure, 'performedProcedure required');
  const rec = {
    uuid: uuid(), surgicalPlanUuid: plan.uuid, patientUuid: plan.patientUuid,
    performedProcedure: data.performedProcedure,
    surgeon: actor.uuid, surgeonName: actor.name,
    anesthesia: data.anesthesia || '',
    findings: data.findings || '',
    specimens: (data.specimens || []).map(s => ({ site: s.site, laterality: s.laterality || null })), // → pathology tasks
    complications: data.complications || '',
    postOpPlan: data.postOpPlan || '',
    performedDate: data.performedDate || new Date().toISOString().slice(0, 10),
    status: 'DRAFT', createdAt: nowIso(), signedAt: null
  };
  store.insert('operativeRecords', rec);
  // D1 fix: each specimen gets a REAL pathology order so the specimen task opens
  // a recordable result form (no dead-ends in the worklist).
  for (const s of rec.specimens) {
    const ord = clinical.orderInvestigation(actor, {
      patientUuid: rec.patientUuid, category: 'PATHOLOGY',
      testCode: 'LYMPH_NODE_EXCISION', // master-test mandate: specimen histopathology is governed
      bodySite: s.site,
      clinicalIndication: 'Operative specimen from ' + rec.performedProcedure + ' (operative record ' + rec.uuid.slice(0, 8) + ')',
      notes: 'Operative specimen from ' + rec.performedProcedure + ' (operative record ' + rec.uuid.slice(0, 8) + ')',
      operativeRecordUuid: rec.uuid  // finalized specimen result → PATHOLOGICAL_STAGING task (Slice E)
    }, { internal: true });
    createTask(actor, 'SURGERY_SPECIMEN', rec.patientUuid, { operativeRecordUuid: rec.uuid, specimenSite: s.site, orderUuid: ord.uuid });
  }
  return rec;
}

function signOperativeRecord(actor, recUuid) {
  const rec = store.byUuid('operativeRecords', recUuid);
  gate(!rec, 'Operative record not found');
  assertNotSigned('operativeRecord', rec);
  rec.status = 'SIGNED';
  rec.signedAt = nowIso();
  rec.signature = sign(actor, 'operativeRecord', rec.uuid, rec.performedProcedure);
  store.update('operativeRecords', recUuid, rec);
  // surgery event completed
  const ev = store.find('events', e => e.refUuid === rec.surgicalPlanUuid && e.type === 'SURGERY')[0];
  if (ev) store.update('events', ev.uuid, { state: 'COMPLETED', actualDate: rec.performedDate });
  if (rec.complications) {
    createTask(actor, 'TOXICITY_REVIEW', rec.patientUuid, { operativeRecordUuid: rec.uuid, reason: 'post-op complications' });
  }
  createTask(actor, 'ADJUVANT_DECISION', rec.patientUuid, { operativeRecordUuid: rec.uuid, reason: 'post-op adjuvant decision' });
  // Slice E catch-up: if specimen histopathology finalized while the record was
  // still open, emit the restaging trigger now that the record is signed — via the
  // same funnel (staging.maybeCreatePathologicalRestaging) as every other path.
  for (const o of store.find('investigationOrders', x => x.operativeRecordUuid === recUuid)) {
    const fin = store.find('results', r => r.orderUuid === o.uuid && ['FINAL', 'AMENDED', 'CORRECTED'].includes(r.resultStatus))[0];
    if (fin) staging.maybeCreatePathologicalRestaging(actor, rec.patientUuid, o, fin);
  }
  store.audit(actor, 'OPERATIVE_RECORD_SIGNED', 'operativeRecord', rec.uuid, rec.performedProcedure);
  return rec;
}

module.exports = {
  listRegimens, getRegimen, bsa, calculateDose,
  createTreatmentOrder, signTreatmentOrder, delayCycle, projectEvents,
  pharmacyReceive, pharmacyVerify, pharmacyPrepare, pharmacyRelease,
  startAdministration, updateAdministration, completeAdministration,
  recordInfusionReaction,
  resolveInfusionReaction,
  dispense,
  nextCycleContext,
  recordNextCycleDecision,
  signNextCycleDecision,
  recordToxicity, signToxicity, recordResponseAssessment, signResponseAssessment,
  createRtPrescription, approveRtPlan, recordRtFraction,
  createSurgicalPlan, signSurgicalPlan, recordOperativeNote, signOperativeRecord,
  REGIMENS
};
