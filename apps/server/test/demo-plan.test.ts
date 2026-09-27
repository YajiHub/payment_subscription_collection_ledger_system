// Pure tests for the demo-dataset PLAN (S9-1, S9-2).
//
// These run without PostgreSQL. They pin the structural minimums the section 8
// checklist asks for and, most importantly, the determinism guarantee: the same
// seed must build a byte-identical plan, because the plan is where every count and
// every amount is decided. `demo-dataset.postgres.test.ts` proves the same seed
// reproduces identical counts and totals in the database.

import { describe, expect, it } from "vitest";

import {
  buildDemoDatasetPlan,
  DEMO_ACCOUNT_SCENARIOS,
  DEMO_BILLING_MONTHS,
  DEMO_SUBSCRIBER_COUNT,
  DEMO_SUBSCRIBERS_WITH_SECOND_ACCOUNT,
  type DemoStep,
} from "../src/db/demo/demo-plan";

/** A fixed reference day, so the plan does not depend on when the test runs. */
const REFERENCE_DATE = "2025-06-15";
const SEED = 4242;

function build(seed = SEED) {
  return buildDemoDatasetPlan({ seed, referenceDate: REFERENCE_DATE });
}

/** Every step kind present in a plan. */
function stepKinds(steps: readonly DemoStep[]): string[] {
  return steps.map((step) => step.kind);
}

describe("buildDemoDatasetPlan", () => {
  it("builds a byte-identical plan for the same seed", () => {
    const first = build();
    const second = build();

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("builds a different plan for a different seed", () => {
    const first = build();
    const other = build(SEED + 1);

    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
  });

  it("never changes the fixed structure when only the seed changes", () => {
    const first = build();
    const other = build(SEED + 1);

    expect(other.subscribers).toHaveLength(first.subscribers.length);
    expect(other.accounts).toHaveLength(first.accounts.length);
    expect(other.plans).toEqual(first.plans);
    expect(other.areas).toEqual(first.areas);
    expect(other.billingPeriods).toEqual(first.billingPeriods);
  });

  it("meets the section 8 structural minimums", () => {
    const plan = build();

    expect(plan.users).toHaveLength(7);
    expect(plan.areas).toHaveLength(3);
    expect(plan.plans).toHaveLength(7);
    expect(plan.plans.filter((item) => item.serviceType === "internet")).toHaveLength(3);
    expect(plan.plans.filter((item) => item.serviceType === "cable_tv")).toHaveLength(2);
    expect(plan.plans.filter((item) => item.serviceType === "bundle")).toHaveLength(2);

    expect(plan.subscribers).toHaveLength(DEMO_SUBSCRIBER_COUNT);
    expect(plan.accounts.length).toBeGreaterThanOrEqual(60);
    expect(plan.accounts).toHaveLength(
      DEMO_SUBSCRIBERS_WITH_SECOND_ACCOUNT * 2 +
        (DEMO_SUBSCRIBER_COUNT - DEMO_SUBSCRIBERS_WITH_SECOND_ACCOUNT)
    );

    expect(plan.billingPeriods).toHaveLength(DEMO_BILLING_MONTHS);
    expect(plan.billingPeriods.length).toBeGreaterThanOrEqual(3);

    const collectorUsers = plan.users.filter((user) => user.legacyRole === "collector");
    expect(collectorUsers).toHaveLength(2);
  });

  it("covers the required user categories", () => {
    const roles = new Set(build().users.flatMap((user) => user.systemRoles));

    expect(roles.has("owner") || roles.has("administrator")).toBe(true);
    expect(roles.has("cashier")).toBe(true);
    expect(roles.has("collection_supervisor")).toBe(true);
    expect(roles.has("accounting_auditor") || roles.has("read_only_viewer")).toBe(true);
    expect(roles.has("technician")).toBe(true);
  });

  it("spreads service accounts across all three service types", () => {
    const types = new Set(build().accounts.map((account) => account.serviceType));

    expect([...types].sort()).toEqual(["bundle", "cable_tv", "internet"]);
  });

  it("uses every account scenario, so no seed loses a required payment kind", () => {
    const scenarios = new Set(build().accounts.map((account) => account.scenario));

    for (const scenario of DEMO_ACCOUNT_SCENARIOS) {
      expect(scenarios.has(scenario), scenario).toBe(true);
    }
  });

  it("schedules the financial operations the minimums depend on", () => {
    const plan = build();
    const kinds = stepKinds(plan.steps);

    // One billing run and one post per month.
    expect(kinds.filter((kind) => kind === "run_monthly_billing")).toHaveLength(DEMO_BILLING_MONTHS);
    expect(kinds.filter((kind) => kind === "post_issued_invoices")).toHaveLength(
      DEMO_BILLING_MONTHS
    );

    expect(kinds).toContain("post_payment");
    expect(kinds).toContain("record_gcash");
    expect(kinds).toContain("reverse_payment");
    expect(kinds).toContain("suspend_and_reconnect");
    expect(kinds).toContain("collector_batch");

    // Two suspension/reconnection scenarios and two field batches.
    expect(kinds.filter((kind) => kind === "suspend_and_reconnect")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "collector_batch")).toHaveLength(2);

    // A verified, a pending and a rejected GCash claim.
    const gcashDispositions = plan.steps
      .filter((step) => step.kind === "record_gcash")
      .map((step) => (step.kind === "record_gcash" ? step.disposition : ""));
    expect(gcashDispositions).toContain("verified");
    expect(gcashDispositions).toContain("pending");
    expect(gcashDispositions).toContain("rejected");
  });

  it("anchors the billing periods to the reference date, oldest first", () => {
    const plan = build();

    expect(plan.billingPeriods[0]).toEqual({ year: 2025, month: 2 });
    expect(plan.billingPeriods[plan.billingPeriods.length - 1]).toEqual({ year: 2025, month: 6 });
  });
});
