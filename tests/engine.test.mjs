// Core simulation-logic tests for ScenarioSim.
// Run:  node --test tests/   (Node 18+, only dependency is decimal.js)
import test from "node:test";
import assert from "node:assert/strict";
import {
  run_scenario,
  sensitivity_analysis,
  break_even,
  compare_scenarios,
  list_templates,
  health_check,
} from "../worker-src/engine.mjs";

// ---------------------------------------------------------------------------
// run_scenario — envelope shape + hand-verifiable math
// ---------------------------------------------------------------------------

test("run_scenario returns a well-formed envelope", () => {
  const r = run_scenario({ template: "saas_growth", horizon: 12 });
  assert.equal(r.status, "success");
  assert.equal(r.scenario, "saas_growth");
  assert.equal(r.horizon, 12);
  assert.ok(r.key_results && typeof r.key_results.ending_mrr === "number");
  assert.equal(r.projections.length, 13); // period 0..12
  assert.equal(r.projections[0].period, 0);
  assert.ok(r.assumptions_used && r.assumptions_used.template === "saas_growth");
  assert.ok(r.methodology && r.methodology.deterministic === true);
  assert.ok(Array.isArray(r.notes));
  assert.equal(typeof r.explanation, "string");
});

test("compound_growth math is exact and hand-verifiable", () => {
  // 1000 * 1.1^3 = 1331 (compound); linear 1000*(1+0.1*3)=1300
  const c = run_scenario({ template: "compound_growth", inputs: { starting_value: 1000, growth_rate: 0.1 }, horizon: 3 });
  assert.equal(c.key_results.ending_value, 1331);
  assert.equal(c.key_results.growth_multiple, 1.331);
  const lin = run_scenario({ template: "compound_growth", inputs: { starting_value: 1000, growth_rate: 0.1, linear: 1 }, horizon: 3 });
  assert.equal(lin.key_results.ending_value, 1300);
});

test("unit_economics LTV/CAC math is exact", () => {
  // LTV = arpu(50)*gm(0.8)/churn(0.04) = 40/0.04 = 1000; LTV:CAC = 1000/300 = 3.333333
  // payback = cac/(arpu*gm) = 300/40 = 7.5
  const u = run_scenario({ template: "unit_economics", horizon: 24 });
  assert.equal(u.key_results.ltv, 1000);
  assert.equal(u.key_results.ltv_cac_ratio, 3.333333);
  assert.equal(u.key_results.cac_payback_periods, 7.5);
  assert.equal(u.key_results.avg_lifetime_periods, 25);
});

test("pricing_change applies constant elasticity correctly", () => {
  // price 50->60 = +20%; elasticity -1.2 -> quantity -24%; units 1000 -> 760
  const p = run_scenario({ template: "pricing_change", horizon: 12 });
  assert.equal(p.key_results.pct_price_change, 0.2);
  assert.equal(p.key_results.pct_quantity_change, -0.24);
  assert.equal(p.key_results.units_after, 760);
  // profit/period after = (60-20)*760 = 30400
  assert.equal(p.key_results.profit_after_per_period, 30400);
});

test("cash_runway reports runway and cash-flow-positive crossover", () => {
  // flat: 100k cash, burn 30k, no revenue -> runway ~3.333 periods (100/30)
  const r = run_scenario({ template: "cash_runway", inputs: { starting_cash: 100000, expenses_per_period: 30000, revenue_per_period: 0, revenue_growth_rate: 0, expense_growth_rate: 0 }, horizon: 12 });
  assert.ok(Math.abs(r.key_results.runway_periods - 3.333333) < 1e-5);
  // solvent case -> runway null
  const solvent = run_scenario({ template: "cash_runway", inputs: { starting_cash: 100000, expenses_per_period: 10000, revenue_per_period: 20000, revenue_growth_rate: 0, expense_growth_rate: 0 }, horizon: 6 });
  assert.equal(solvent.key_results.runway_periods, null);
  assert.equal(solvent.key_results.becomes_cashflow_positive_period, 1);
});

test("period_label changes annualization (ARR = MRR x periods/year)", () => {
  const m = run_scenario({ template: "saas_growth", period_label: "month", horizon: 6 });
  assert.ok(Math.abs(m.key_results.ending_arr - m.key_results.ending_mrr * 12) < 1e-4);
  const q = run_scenario({ template: "saas_growth", period_label: "quarter", horizon: 6 });
  assert.ok(Math.abs(q.key_results.ending_arr - q.key_results.ending_mrr * 4) < 1e-4);
});

test("determinism: identical inputs -> byte-identical output", () => {
  const a = JSON.stringify(run_scenario({ template: "saas_growth", horizon: 24 }));
  const b = JSON.stringify(run_scenario({ template: "saas_growth", horizon: 24 }));
  assert.equal(a, b);
});

test("assumptions can be passed via inputs, assumptions, or top-level", () => {
  const viaInputs = run_scenario({ template: "compound_growth", inputs: { starting_value: 500 }, horizon: 2 });
  const viaAssump = run_scenario({ template: "compound_growth", assumptions: { starting_value: 500 }, horizon: 2 });
  const viaTop = run_scenario({ template: "compound_growth", starting_value: 500, horizon: 2 });
  assert.equal(viaInputs.key_results.ending_value, viaAssump.key_results.ending_value);
  assert.equal(viaInputs.key_results.ending_value, viaTop.key_results.ending_value);
});

test("template aliases resolve (saas -> saas_growth)", () => {
  const r = run_scenario({ template: "saas", horizon: 3 });
  assert.equal(r.status, "success");
  assert.equal(r.scenario, "saas_growth");
});

test("custom free-form scenario projects independent metrics", () => {
  const r = run_scenario({ metrics: [{ name: "revenue", start: 1000, growth_rate: 0.1 }, { name: "users", start: 100, growth_rate: 0.05, mode: "linear" }], horizon: 2 });
  assert.equal(r.status, "success");
  assert.equal(r.scenario, "custom");
  assert.equal(r.key_results.ending_revenue, 1210); // 1000*1.1^2
  assert.equal(r.key_results.ending_users, 110);    // 100*(1+0.05*2)
});

// ---------------------------------------------------------------------------
// sensitivity_analysis
// ---------------------------------------------------------------------------

test("sensitivity_analysis sweeps a single variable and ranks influence", () => {
  const s = sensitivity_analysis({ template: "saas_growth", variable: "churn_rate", variation: 0.5, steps: 5, target_metric: "ending_mrr" });
  assert.equal(s.status, "success");
  assert.equal(s.per_variable.length, 1);
  assert.equal(s.per_variable[0].sweep.length, 5);
  assert.ok(s.per_variable[0].output_range > 0);
  assert.deepEqual(s.most_influential, ["churn_rate"]);
});

test("sensitivity_analysis handles multiple variables (one-at-a-time)", () => {
  const s = sensitivity_analysis({
    template: "saas_growth",
    variables: [{ name: "churn_rate", variation: 0.5 }, { name: "arpu", variation: 0.5 }],
    target_metric: "ending_mrr",
  });
  assert.equal(s.status, "success");
  assert.equal(s.per_variable.length, 2);
  assert.equal(s.most_influential.length, 2);
});

test("sensitivity_analysis supports explicit values and min/max grids", () => {
  const vals = sensitivity_analysis({ template: "compound_growth", variable: "growth_rate", values: [0, 0.1, 0.2], target_metric: "ending_value", horizon: 5 });
  assert.equal(vals.per_variable[0].sweep.length, 3);
  const grid = sensitivity_analysis({ template: "compound_growth", variable: "growth_rate", min: 0, max: 0.2, steps: 3, target_metric: "ending_value", horizon: 5 });
  assert.equal(grid.per_variable[0].sweep.length, 3);
  assert.equal(grid.per_variable[0].sweep[0].input_value, 0);
});

test("sensitivity_analysis rejects custom scenarios with an actionable error", () => {
  const s = sensitivity_analysis({ template: "custom", variable: "x" });
  assert.equal(s.status, "error");
  assert.equal(s.error.type, "unsupported_for_custom");
});

// ---------------------------------------------------------------------------
// break_even
// ---------------------------------------------------------------------------

test("break_even solves a monotonic input to hit a target metric", () => {
  // Flat runway: cash 120k, revenue 0, want ending_cash exactly 0 after 12 -> expenses = 10000
  const b = break_even({ template: "cash_runway", solve_for: "expenses_per_period", target_metric: "ending_cash", target_value: 0, horizon: 12, inputs: { starting_cash: 120000, revenue_per_period: 0, revenue_growth_rate: 0, expense_growth_rate: 0 } });
  assert.equal(b.status, "success");
  assert.ok(Math.abs(b.key_results.required_input - 10000) < 1e-3);
  assert.ok(Math.abs(b.key_results.residual) < 1e-3);
});

test("break_even reports how far the input moved from baseline", () => {
  const b = break_even({ template: "saas_growth", solve_for: "new_customers_per_period", target_metric: "ending_mrr", target_value: 20000, horizon: 12 });
  assert.equal(b.status, "success");
  assert.equal(typeof b.key_results.change_from_baseline, "number");
  assert.equal(b.solve_for, "new_customers_per_period");
});

test("break_even returns a clean no_solution when the target is unreachable", () => {
  // ending_customers can never be negative -> target -100 is unreachable
  const b = break_even({ template: "saas_growth", solve_for: "churn_rate", target_metric: "ending_customers", target_value: -100, horizon: 12 });
  assert.equal(b.status, "error");
  assert.equal(b.error.type, "no_solution");
  assert.match(b.error.hint, /range|bounds|bracket/i);
});

test("break_even validates inputs", () => {
  assert.equal(break_even({ template: "saas_growth", target_metric: "ending_mrr", target_value: 1 }).error.type, "missing_parameter"); // no solve_for
  assert.equal(break_even({ template: "saas_growth", solve_for: "nope", target_metric: "ending_mrr", target_value: 1 }).error.type, "unknown_input");
  assert.equal(break_even({ template: "saas_growth", solve_for: "arpu", target_metric: "not_a_metric", target_value: 1 }).error.type, "unknown_metric");
});

// ---------------------------------------------------------------------------
// compare_scenarios
// ---------------------------------------------------------------------------

test("compare_scenarios runs 2-3 scenarios side by side with deltas", () => {
  const c = compare_scenarios({
    scenarios: [
      { name: "Base", template: "saas_growth", inputs: { churn_rate: 0.05 } },
      { name: "LowChurn", template: "saas_growth", inputs: { churn_rate: 0.01 } },
    ],
    compare_metric: "ending_mrr",
    horizon: 12,
  });
  assert.equal(c.status, "success");
  assert.equal(c.scenario_count, 2);
  assert.equal(c.winner.name, "LowChurn"); // lower churn -> more MRR
  assert.ok(c.comparison.length > 0);
  // every comparison row has a delta column vs the baseline
  const mrrRow = c.comparison.find((r) => r.metric === "ending_mrr");
  assert.equal(typeof mrrRow["LowChurn_vs_Base"], "number");
});

test("compare_scenarios respects goal=min", () => {
  const c = compare_scenarios({
    scenarios: [
      { name: "Aggressive", template: "hiring_plan", inputs: { hires_per_period: 5 } },
      { name: "Lean", template: "hiring_plan", inputs: { hires_per_period: 1 } },
    ],
    compare_metric: "cumulative_payroll",
    goal: "min",
    horizon: 12,
  });
  assert.equal(c.winner.name, "Lean");
});

test("compare_scenarios rejects <2 or >3 scenarios", () => {
  assert.equal(compare_scenarios({ scenarios: [{ template: "saas_growth" }] }).error.type, "missing_parameter");
  assert.equal(compare_scenarios({ scenarios: [1, 2, 3, 4].map(() => ({ template: "saas_growth" })) }).error.type, "too_many_scenarios");
});

// ---------------------------------------------------------------------------
// discovery + validation
// ---------------------------------------------------------------------------

test("list_templates enumerates every template with inputs and outputs", () => {
  const t = list_templates();
  assert.equal(t.status, "success");
  assert.equal(t.count, 9);
  const saas = t.templates.find((x) => x.id === "saas_growth");
  assert.ok(saas && saas.inputs.churn_rate && Array.isArray(saas.outputs));
  assert.ok(t.custom_scenario && t.period_labels.includes("month"));
});

test("health_check reports version, tools, and templates", () => {
  const h = health_check();
  assert.equal(h.status, "ok");
  assert.equal(h.server, "ScenarioSim");
  assert.equal(h.tools.length, 6);
  assert.equal(h.templates.length, 9);
  assert.equal(h.deterministic, true);
});

test("unknown template -> actionable error listing the options", () => {
  const r = run_scenario({ template: "does_not_exist" });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "unknown_template");
  assert.match(r.error.hint, /saas_growth/);
});

test("non-numeric assumption -> actionable error", () => {
  const r = run_scenario({ template: "compound_growth", inputs: { starting_value: "lots" }, horizon: 3 });
  assert.equal(r.status, "error");
  assert.match(r.error.message, /not a valid number/);
});

test("invalid horizon -> actionable error", () => {
  assert.equal(run_scenario({ template: "saas_growth", horizon: 0 }).error.type, "invalid_horizon");
  assert.equal(run_scenario({ template: "saas_growth", horizon: 99999 }).error.type, "invalid_horizon");
});

test("unrecognized inputs are ignored and reported in notes", () => {
  const r = run_scenario({ template: "compound_growth", inputs: { starting_value: 100, wibble: 5 }, horizon: 2 });
  assert.equal(r.status, "success");
  assert.ok(r.notes.some((n) => /wibble/.test(n)));
});

test("custom scenario rejects an empty metrics array", () => {
  const r = run_scenario({ template: "custom", metrics: [] });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "missing_parameter");
});

test("unit_economics rejects zero churn (infinite lifetime) with a hint", () => {
  const r = run_scenario({ template: "unit_economics", inputs: { churn_rate: 0 }, horizon: 12 });
  assert.equal(r.status, "error");
  assert.match(r.error.hint, /lifetime|churn/i);
});
