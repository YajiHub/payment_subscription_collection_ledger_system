# BCIS System — AI Development Instructions

## Project context
Subscription Billing and Collection System for a cable/internet ISP.
3-PC office environment. Electron + React frontend, Fastify API, PostgreSQL.

## Non-negotiable rules
1. NEVER put database queries in the React renderer or Electron main process.
   All data access goes through the Fastify API only.
2. NEVER delete financial records destructively. Use soft-delete or reversal patterns.
3. NEVER store passwords in plaintext. Always bcrypt with >= 12 rounds.
4. NEVER hardcode secrets. All config comes from environment variables via config.ts.
5. ALL monetary amounts stored as integers (centavos). Never use JavaScript floats for money.
   Example: PHP 150.50 = 15050 centavos in the database.

## Code readability principles
- Name things for what they DO: calculateMonthlyInvoice() not calcInv()
- One responsibility per function. Two responsibilities = split into two functions.
- If a business rule needs explaining, add a comment — don't be clever
- Prefer explicit over implicit: status === "active" not !!status
- Avoid abbreviations in variable names unless they are universally understood (e.g., id, url)

## File organization
- One domain feature per folder under modules/
- Schema files match domain: billing.ts contains billing tables only
- Never mix two domain's logic in the same file

## When implementing a feature, do it in this order:
1. Read the spec for that phase
2. Check existing schema in db/schema/ and types in packages/shared
3. Write or update the Drizzle schema
4. Run db:generate and review the migration SQL
5. Write the Zod validation schema
6. Write the Fastify route handler
7. Write the React page/component
8. Write at least one test for any financial calculation
9. Run typecheck + lint + test before committing

## Phase status
- Phase 1 (Project Foundation) — DONE. Skeleton, config, health routes, Electron shell.
- Phase 2+ — not started. Do not add auth, billing, or collection logic without a spec.

## Repository layout reminders
- `apps/server/src/config.ts` is the ONLY place `process.env` is read.
- `apps/client/src/lib/api-client.ts` is the ONLY place the renderer performs HTTP.
- `packages/shared` holds types and constants only — never runtime business logic.