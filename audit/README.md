# Audit — BCIS Subscription Billing and Collection System

Compliance audit of this repository against
`BCIS_Subscription_Billing_and_Collection_Laboratory_Activity (1).pdf`.

## Why

The laboratory activity is graded out of 100 points across ten rubric criteria and
carries hard "critical failure conditions" (section 10.1) that can cap or void the
score. This audit answers one question: **which stated requirements are actually
met by the code that exists today, and what must change?**

## Method

Six parallel evidence-gathering passes, each reading real source, migrations and
tests — never filenames alone:

| Pass | Scope | PDF sections |
| --- | --- | --- |
| 1 | Architecture, stack, data model, reliability | 2.1–2.3, 4.5, 5, 5.2, 9 |
| 2 | Auth, RBAC, audit trail, attachment safety | 3.1, 4.4, 7 (AT-10), 10 (F) |
| 3 | Billing, ledger, payments, allocation, receipts | 3.3–3.7, 7 (AT-01…06, 11), 10 (C) |
| 4 | Subscribers, collections, receivables, service control | 3.2, 3.8–3.10, 7 (AT-07…09), 10 (D) |
| 5 | Reports, dashboard, PDF/XLSX, UI/UX, print | 3.11, 4.1–4.3, 8, 10 (E, G) |
| 6 | Tests, acceptance evidence, seed data, deliverables, process | 6–9.1, 10.1, 11–14 |

## Files

- `part1-audit-findings.md` — requirement-by-requirement verdicts with file evidence.
- `part2-spec.md` — the tight specification for every change to be made.
- `part3-implementation-plan.md` — ordered work packages for implementation agents.

## Scope rule

Only requirements stated in the PDF are in scope. Anything recommended beyond the PDF
is explicitly labelled `BEYOND-SPEC` in `part2-spec.md`.
