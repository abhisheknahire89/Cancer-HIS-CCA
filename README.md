# CCA Oncology Clinical Operating System — runnable reference implementation

**Status: working vertical slices Phases 1–4 + multi-hospital config. AI Voice / AI documentation / NEXUS / NCCN decision support / AI recommendations: intentionally OUT OF SCOPE.**

## What is running here

A complete, testable implementation of the CCA clinical workflow — from registration to
longitudinal oncology journey — with the acceptance rule enforced end-to-end:

> Role A enters data through the UI → saves/signs → authoritative record persisted → clinical
> state changes → next role automatically gets a task → next role opens the signed source →
> completes responsibility → following role gets the next task. No manual DB editing, no manual
> task creation, no dead buttons.

## Quick start

```bash
cd cca-os
npm install
npm start            # → http://localhost:3210
npm test             # ALL suites: 56 stop-gates + 75 canonical + 30 calendar + 72 API e2e + both browser demos
npm run test:browser # just the browser demo harness (see below)
```

## Demo Flow Verification harness (`npm run test:browser`)

`test/demo-harness.js` executes the canonical **15-step demo path through the real UI** in
headless Chrome (playwright-core): every clinical action is a real click/keystroke in the SPA —
no REST shortcuts, no manual task creation. It boots its own server on an **empty database**,
screenshots every step into `test/browser-evidence/`, and writes a self-contained
**`test/browser-evidence/DEMO_EVIDENCE.md`** with a per-step check table and a final verdict
(`DEMO FLOW VERIFIED` / `NOT DEMO READY`) plus `summary.json` for machine parsing.

An auditor re-verifies the demo independently with one command:

```bash
cd cca-os
npm run test:browser                 # headless
node test/demo-harness.js --headed   # watch it live
CHROME_PATH=/path/to/chrome DEMO_PORT=3211 node test/demo-harness.js
```

### Second-disease harness (`npm run test:browser:myeloma`)

`test/demo-harness-myeloma.js` runs the same 15-step journey for a **Multiple Myeloma** patient
and proves the second-disease acceptance test: the staging UI resolves the disease-specific MM
provider, renders **ISS/R-ISS fields with no T/N/M dropdowns anywhere**, and an API-boundary
negative test confirms TNM variables are rejected at sign (`unknown staging field`). The run
records `secondDiseaseProof` in its evidence report and verdicts
`DEMO FLOW VERIFIED — SECOND DISEASE (NON-TNM STAGING) PROVEN`.

```bash
npm run test:browser:myeloma         # headless
npm run test:browser:all             # breast + myeloma back to back
```

Open http://localhost:3210 in a browser. Use the top-right role switcher to change between the
16 CCA roles; the worklist shows only that role's tasks.

## Verified by automated acceptance test (233 API/unit checks + 62 browser checks)

The **Oncology Calendar** (`test/calendar.test.js`, 30 checks) derives every event as a
read-time projection over authoritative records — 30+ event types (consultations,
investigation orders, specimen collection, lab/path/rad results, results review, diagnosis,
staging, MDT, care plan, financial counselling, authorization, consent, readiness, systemic
cycles, supportive treatment, toxicity, RT simulation/planning/QA/approval/fractions,
surgery/pre-op/admission/specimen-pathology/post-op/adjuvant decision, response,
surveillance) with the 8 governed states (ACTUAL, SCHEDULED, PROJECTED, READY, HELD,
DELAYED, CANCELLED, COMPLETED). Signed orders generate the projected future schedule;
delays preserve original date + reason + revised date + downstream shifts; completed
administrations flip delivered cycles to COMPLETED; PROJECTED never appears as delivered.
The UI offers **Journey | Calendar | Timeline | Department view**, a VIEW SOURCE modal on
every event, modality/status filters, and a department operational view filterable by
hospital/department/clinician/resource/treatment type/status/date.

Phase 1: Registration → Consultation → Investigation → Result → **Diagnosis → Staging**
- Front Desk registers → Intake Nurse auto-tasked
- Oncologist consult (ECOG) → orders generate Lab/Radiology/Pathology department tasks
- Departments record signed results → oncologist review task (with source provenance)
- Structured signed diagnosis bound to governed masters (dropdown→dropdown→dropdown),
  **T/N/M rejected inside diagnosis**, cross-patient evidence rejected, future dates rejected
- Staging schema resolved by `StagingContentProvider` (breast → TNM_BREAST with ER/PR/HER2
  prognostic factors); fabricated T values and unknown fields rejected; signed staging
  auto-tasks the MDT coordinator (or care-plan author per hospital policy)
- Restaging supersedes — history preserved, never overwritten

Phase 2: MDT → Care Plan → Finance → Readiness
- MDT case with participants/options/discussion/consensus/dissent → signed outcome → care plan task
- Signed care plan (intent, line, modality sequence) → Financial Counsellor auto-tasked
- Cost estimate, payer/TPA, authorization, biosimilar choice → clearance → Nurse Navigator
- Readiness checklist gates treatment ordering

Phase 3: Treatment Order → Pharmacy → Administration → Toxicity → Response
- Order with regimen version, planned cycles, BSA (Mosteller), per-line
  premed→drug→hydration→post→supportive structure, standard→ordered dose, reduction % + reason
- Signing projects the calendar (cycles, pre-cycle labs, toxicity reviews, response imaging) — all `PROJECTED`
- Pharmacy: verify regimen/dose → allergy (rejects on real patient allergy) → interaction →
  compatibility → stability → stock → prepare/compound → **independent second check** → release
- Day care: blocked without RELEASE; arrival → readiness → access → premed → drug lines →
  completion → discharge; delivered events flip to COMPLETED (projected ≠ delivered)
- Toxicity (CTCAE terms, grades 1–5, hold/delay/reduction/discontinuation) → delay record
  preserving original + revised dates and shifting downstream projections
- Response (CR/PR/SD/PD/Recurrence/Not evaluable) routes continue/modify/next-line/surveillance

Phase 4: Calendar + RT + Surgery
- Journey/Calendar/Timeline views with state separation (Actual, Scheduled, Projected, Held,
  Delayed, Cancelled, Completed); projected therapy is dashed/grey and never renders as delivered
- RT: prescription (PLANNED) → physics + approval (APPROVED) → fraction records (DELIVERED),
  total dose computed, fraction events projected and completed individually
- Surgery: signed SurgicalPlan ≠ signed OperativeRecord; specimens create pathology tasks;
  complications create toxicity review; adjuvant decision task returns to medical oncology

Phase 5 foundations: two hospitals configured by data (MDT policy differs per hospital) —
the same workflow routes to MDT at CCA Central and directly to care plan at CCA Coastal.

## Stop-gates (all enforced server-side, tested)

1. staging before signed diagnosis → **rejected**
2. schema mismatching diagnosis (disease routing) → **rejected**
3. another patient's evidence → **rejected**
4. cross-patient supersession → **rejected**
5. future assessment/diagnosis/onset dates → **rejected**
6. unknown governed fields/values → **rejected**
7. invalid/fabricated stage (outside provider allowed values) → **rejected**
8. treatment planning before required staging → **rejected**
9. administration without a RELEASED treatment order → **rejected**
10. signed records immutable → update attempts throw `IMMUTABLE`

## Repository layout

```
cca-os/
├── src/
│   ├── server.js             REST API (/ws/rest/v1/cca/*) + static UI host
│   ├── store.js              persistence adapter (swappable → OpenMRS/FHIR later)
│   ├── masters.js            23 governed masters + admin maintenance (audit-trailed)
│   ├── staging-providers.js  StagingContentProvider SPI + disease routing (TNM/FIGO/
│   │                         Lugano/Rai-Binet/ELN/ALL-risk/ISS) — REFERENCE-SKELETON only
│   ├── workflow.js           Task engine (28 task definitions with destinations),
│   │                         signature/immutability service, stop-gate helper
│   ├── clinical.js           Phases 1–2 domain services
│   └── treatment.js          Phases 3–4 services (incl. RT, surgery, delay projection)
├── public/                   SPA: worklists, patient header, 15-tab workspace, calendar
├── test/
│   ├── e2e-workflow.test.js  58-check acceptance chain
│   └── stop-gates.test.js    negative-path unit tests
└── data/db.json              local persistence (created on first run)
```

## Relationship to the OpenMRS foundation

This implementation is a **workflow-complete reference build** of the CCA product that runs
everywhere (no Java/Maven required), with clean seams for the OpenMRS target architecture
described in `CCA_ARCHITECTURE.md`:

| CCA OS here | OpenMRS target |
|---|---|
| `store.js` collection API | OpenMRS entities via Hibernate module (`cca-oncology-api`) |
| `workflow.js` Task engine | `cca-oncology` module service + FHIR `Task` |
| `masters.js` | Initializer CSV loads + admin UI (governed concepts) |
| `staging-providers.js` SPI | Java `StagingContentProvider` SPI; licensed packs unchanged |
| REST `/ws/rest/v1/cca/*` | same paths served by the module omod |
| `public/` SPA | O3 microfrontends (`esm-cca-*`) using identical components/logic |
| patients/encounters/results | Patient/Encounter/Obs/Order + FHIR R4 Condition/ServiceRequest/… |

Regimen cycle semantics intentionally mirror `openmrs-module-orderextension` concepts
(cyclical order sets, per-cycle groups, delay propagation) re-expressed on the CCA model.

## Content governance (critical rule)

`staging-providers.js` ships **neutral reference schemas only** — authority is stamped
`CCA-REFERENCE-SKELETON v0.1.0` and every stage result displays that stamp. No historical
AJCC/FIGO tables and no proprietary content are embedded; licensed authority plugs in later
by adding provider packs without model changes. Regimen doses in `treatment.js` are
institutional placeholders versioned `CCA-INST-1.0`, marked for replacement by the CCA
formulary/regimen library.
