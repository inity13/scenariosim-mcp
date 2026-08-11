// ScenarioSim engine — deterministic what-if / scenario simulation for AI agents.
//
// Agents hand over assumptions (growth rates, churn, pricing, costs, starting
// metrics, a time horizon, ...) and get back projected outcomes over time, plus
// sensitivity analysis and break-even solving — all with full transparency.
//
// Every number flows through decimal.js at fixed precision, so results are exact,
// reproducible, and independent of platform float behaviour. The engine is pure
// and stateless: identical inputs always produce byte-identical output. No clocks,
// no randomness, no I/O.
//
// All tools return the same agent-friendly envelope described in the README:
//   { status, scenario, key_results, projections, assumptions_used,
//     methodology, notes, explanation }
import Decimal from "decimal.js";

// 40 significant digits is far more than any projection needs; it guarantees that
// compounding / division rounds deterministically the same way on every runtime.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const D = (x) => new Decimal(String(x));

const ENGINE_VERSION = "1.0.0-edge";

// ---------------------------------------------------------------------------
// Errors — never cross the tool boundary as raw exceptions.
// ---------------------------------------------------------------------------
export class ScenarioError extends Error {
  constructor(message, { hint = null, type = "invalid_input" } = {}) {
    super(message);
    this.hint = hint;
    this.type = type;
  }
}
export function errEnvelope(message, type = "invalid_input", hint = null) {
  return { status: "error", error: { type, message, hint } };
}

// ---------------------------------------------------------------------------
// Numeric helpers.
// ---------------------------------------------------------------------------
function toDec(name, value) {
  if (value === undefined || value === null || value === "")
    throw new ScenarioError(`'${name}' is required and must be a number.`, {
      hint: `Provide a numeric value for '${name}'.`, type: "missing_parameter",
    });
  if (typeof value === "boolean")
    throw new ScenarioError(`'${name}' must be a number, got a boolean.`, { hint: "Use a numeric value, e.g. 0.05 or 1200." });
  try {
    const d = new Decimal(String(value));
    if (d.isNaN() || !d.isFinite()) throw new Error("nan");
    return d;
  } catch {
    throw new ScenarioError(`'${name}' is not a valid number: ${JSON.stringify(value)}.`, {
      hint: "Pass a finite numeric value, e.g. 0.03, 250, or -0.1.",
    });
  }
}

// Human/agent friendly rounded number (deterministic HALF_UP at 6 dp by default).
function numD(d, dp = 6) {
  if (d === null || d === undefined) return null;
  if (!(d instanceof Decimal)) d = D(d);
  if (!d.isFinite()) return null;
  return Number(d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toString());
}
// Full-precision plain string with trailing zeros trimmed (stable JSON, no float loss).
function exact(d) {
  if (d === null || d === undefined || !(d instanceof Decimal) || !d.isFinite()) return null;
  let s = d.toFixed();
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}
function pctStr(d) {
  if (d === null || d === undefined || !d.isFinite()) return null;
  return `${d.times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString()}%`;
}
function sumDec(arr) { return arr.reduce((a, x) => a.plus(x), D(0)); }

// ---------------------------------------------------------------------------
// Period labels + annualization factors.
// ---------------------------------------------------------------------------
const PERIODS_PER_YEAR = { day: 365, week: 52, month: 12, quarter: 4, year: 1 };
function normalizePeriodLabel(raw) {
  if (raw === undefined || raw === null || raw === "") return "month";
  const key = String(raw).trim().toLowerCase().replace(/s$/, "");
  if (!PERIODS_PER_YEAR[key])
    throw new ScenarioError(`Unknown period_label '${raw}'.`, {
      hint: `Use one of: ${Object.keys(PERIODS_PER_YEAR).join(", ")}.`, type: "invalid_period_label",
    });
  return key;
}

const MAX_HORIZON = 1200;

// ===========================================================================
// TEMPLATE REGISTRY
//
// Each template is a pure model. `inputs` documents every parameter (default +
// unit + description); `outputs` lists the key_result metrics the model emits
// (so break_even / sensitivity_analysis / list_templates can reference them by
// name). `simulate(P)` receives the resolved parameters (Decimals + integers)
// and returns { periods: [{period, <metric>:Decimal, ...}], results: {name:Decimal},
// notes: [] }. `explain(P, results, ctx)` returns a plain-language summary.
// ===========================================================================

// Small helper: a numeric input spec.
const inp = (def, unit, description, type = "number") => ({ default: def, unit, description, type });

const TEMPLATES = {
  // -------------------------------------------------------------------------
  saas_growth: {
    label: "SaaS Growth",
    category: "growth",
    description:
      "Project subscribers and recurring revenue (MRR/ARR) forward, given a starting base, per-period new customer additions (which can themselves grow), a churn rate, and average revenue per user.",
    primary_output: "ending_mrr",
    inputs: {
      starting_customers: inp(100, "customers", "Customer count at period 0."),
      new_customers_per_period: inp(20, "customers/period", "Gross new customers added each period (before churn)."),
      acquisition_growth_rate: inp(0, "fraction/period", "Per-period growth of the new-customer intake, e.g. 0.1 = +10%/period."),
      churn_rate: inp(0.03, "fraction/period", "Fraction of existing customers lost each period, e.g. 0.03 = 3%."),
      arpu: inp(50, "currency/customer/period", "Average revenue per user per period."),
    },
    outputs: ["ending_customers", "ending_mrr", "ending_arr", "net_new_customers", "total_new_customers", "total_churned_customers", "cumulative_revenue"],
    simulate(P) {
      const H = P.horizon, ppy = P.periodsPerYear;
      let customers = P.starting_customers;
      let intake = P.new_customers_per_period;
      const periods = [{ period: 0, customers, mrr: customers.times(P.arpu), new_customers: D(0), churned_customers: D(0) }];
      let totalNew = D(0), totalChurn = D(0), cumRev = D(0);
      for (let n = 1; n <= H; n++) {
        const churned = customers.times(P.churn_rate);
        customers = customers.minus(churned).plus(intake);
        if (customers.lt(0)) customers = D(0);
        const mrr = customers.times(P.arpu);
        totalNew = totalNew.plus(intake); totalChurn = totalChurn.plus(churned); cumRev = cumRev.plus(mrr);
        periods.push({ period: n, customers, mrr, new_customers: intake, churned_customers: churned });
        intake = intake.times(D(1).plus(P.acquisition_growth_rate));
      }
      const endMrr = periods[H].mrr;
      const results = {
        ending_customers: periods[H].customers,
        ending_mrr: endMrr,
        ending_arr: endMrr.times(ppy),
        net_new_customers: periods[H].customers.minus(P.starting_customers),
        total_new_customers: totalNew,
        total_churned_customers: totalChurn,
        cumulative_revenue: cumRev,
      };
      return { periods, results, notes: ["Churn is applied to the prior period's base before new customers are added.", "Customer counts are kept fractional for precision; round to whole customers if you need integers."] };
    },
    explain(P, R, ctx) {
      return `Starting from ${exact(P.starting_customers)} customers and adding ${exact(P.new_customers_per_period)} per ${ctx.label} (churn ${pctStr(P.churn_rate)}), after ${ctx.H} ${ctx.label}s you reach ${numD(R.ending_customers, 2)} customers and ${numD(R.ending_mrr, 2)} MRR (${numD(R.ending_arr, 2)} ARR). Cumulative revenue over the horizon is ${numD(R.cumulative_revenue, 2)}.`;
    },
  },

  // -------------------------------------------------------------------------
  pricing_change: {
    label: "Pricing Change",
    category: "pricing",
    description:
      "Estimate the revenue and profit impact of moving from a current price to a new price, using a price-elasticity assumption to adjust the quantity sold. Compares the 'before' and 'after' worlds side by side over the horizon.",
    primary_output: "cumulative_profit_after",
    inputs: {
      current_price: inp(50, "currency/unit", "Current unit price."),
      new_price: inp(60, "currency/unit", "Proposed new unit price."),
      current_units: inp(1000, "units/period", "Units sold per period at the current price."),
      price_elasticity: inp(-1.2, "ratio", "Price elasticity of demand: %change in quantity per %change in price (usually negative)."),
      unit_cost: inp(20, "currency/unit", "Variable cost per unit (used for profit)."),
      units_growth_rate: inp(0, "fraction/period", "Organic per-period growth in units, applied to both worlds."),
    },
    outputs: ["pct_price_change", "pct_quantity_change", "units_after", "revenue_before_per_period", "revenue_after_per_period", "profit_before_per_period", "profit_after_per_period", "cumulative_revenue_before", "cumulative_revenue_after", "cumulative_profit_before", "cumulative_profit_after", "cumulative_profit_delta"],
    simulate(P) {
      const H = P.horizon;
      if (P.current_price.lte(0)) throw new ScenarioError("current_price must be greater than 0.", { hint: "Elasticity is defined as a percentage change from the current price.", type: "invalid_input" });
      const pctPrice = P.new_price.minus(P.current_price).div(P.current_price);
      const pctQty = P.price_elasticity.times(pctPrice);
      const unitsAfter0 = P.current_units.times(D(1).plus(pctQty));
      const marginBefore = P.current_price.minus(P.unit_cost);
      const marginAfter = P.new_price.minus(P.unit_cost);
      const periods = [];
      let factor = D(1);
      let cumRevB = D(0), cumRevA = D(0), cumProfB = D(0), cumProfA = D(0);
      for (let n = 1; n <= H; n++) {
        const unitsB = P.current_units.times(factor);
        const unitsA = unitsAfter0.times(factor);
        const revB = P.current_price.times(unitsB);
        const revA = P.new_price.times(unitsA);
        const profB = marginBefore.times(unitsB);
        const profA = marginAfter.times(unitsA);
        cumRevB = cumRevB.plus(revB); cumRevA = cumRevA.plus(revA);
        cumProfB = cumProfB.plus(profB); cumProfA = cumProfA.plus(profA);
        periods.push({ period: n, units_before: unitsB, units_after: unitsA, revenue_before: revB, revenue_after: revA, profit_before: profB, profit_after: profA, revenue_delta: revA.minus(revB), profit_delta: profA.minus(profB) });
        factor = factor.times(D(1).plus(P.units_growth_rate));
      }
      const results = {
        pct_price_change: pctPrice,
        pct_quantity_change: pctQty,
        units_after: unitsAfter0,
        revenue_before_per_period: periods[0].revenue_before,
        revenue_after_per_period: periods[0].revenue_after,
        profit_before_per_period: periods[0].profit_before,
        profit_after_per_period: periods[0].profit_after,
        cumulative_revenue_before: cumRevB,
        cumulative_revenue_after: cumRevA,
        cumulative_profit_before: cumProfB,
        cumulative_profit_after: cumProfA,
        cumulative_profit_delta: cumProfA.minus(cumProfB),
      };
      return { periods, results, notes: ["Quantity response uses constant elasticity: new_units = current_units x (1 + elasticity x price_change).", "Elasticity is a simplification; real demand curves are non-linear."] };
    },
    explain(P, R, ctx) {
      const dir = R.cumulative_profit_delta.gte(0) ? "increases" : "decreases";
      return `Moving price from ${exact(P.current_price)} to ${exact(P.new_price)} is a ${pctStr(R.pct_price_change)} change; at elasticity ${exact(P.price_elasticity)} that shifts quantity by ${pctStr(R.pct_quantity_change)} (units ${exact(P.current_units)} -> ${numD(R.units_after, 2)}). Over ${ctx.H} ${ctx.label}s cumulative profit ${dir} by ${numD(R.cumulative_profit_delta.abs(), 2)} (from ${numD(R.cumulative_profit_before, 2)} to ${numD(R.cumulative_profit_after, 2)}).`;
    },
  },

  // -------------------------------------------------------------------------
  churn_impact: {
    label: "Churn Impact",
    category: "retention",
    description:
      "Show how a churn rate erodes a customer base and revenue over time, and how much revenue is lost relative to a no-churn baseline. Optionally add new customers per period.",
    primary_output: "cumulative_revenue_lost",
    inputs: {
      starting_customers: inp(1000, "customers", "Customer count at period 0."),
      churn_rate: inp(0.05, "fraction/period", "Fraction of customers lost each period."),
      arpu: inp(50, "currency/customer/period", "Average revenue per user per period."),
      new_customers_per_period: inp(0, "customers/period", "Gross new customers added each period (default 0 to isolate churn)."),
    },
    outputs: ["ending_customers", "total_churned_customers", "retention_pct", "ending_mrr", "cumulative_revenue", "cumulative_revenue_no_churn", "cumulative_revenue_lost"],
    simulate(P) {
      const H = P.horizon;
      let customers = P.starting_customers;
      const periods = [{ period: 0, customers, mrr: customers.times(P.arpu), churned_customers: D(0), retained_pct: D(1) }];
      let totalChurn = D(0), cumRev = D(0), cumNoChurn = D(0);
      for (let n = 1; n <= H; n++) {
        const churned = customers.times(P.churn_rate);
        customers = customers.minus(churned).plus(P.new_customers_per_period);
        if (customers.lt(0)) customers = D(0);
        const mrr = customers.times(P.arpu);
        totalChurn = totalChurn.plus(churned);
        cumRev = cumRev.plus(mrr);
        cumNoChurn = cumNoChurn.plus(P.starting_customers.plus(P.new_customers_per_period.times(n)).times(P.arpu));
        periods.push({ period: n, customers, mrr, churned_customers: churned, retained_pct: P.starting_customers.isZero() ? D(0) : customers.div(P.starting_customers) });
      }
      const retention = P.starting_customers.isZero() ? D(0) : periods[H].customers.div(P.starting_customers);
      const results = {
        ending_customers: periods[H].customers,
        total_churned_customers: totalChurn,
        retention_pct: retention,
        ending_mrr: periods[H].mrr,
        cumulative_revenue: cumRev,
        cumulative_revenue_no_churn: cumNoChurn,
        cumulative_revenue_lost: cumNoChurn.minus(cumRev),
      };
      return { periods, results, notes: ["'no_churn' baseline keeps every starting customer plus any new adds, at the same ARPU.", "retention_pct compares ending customers to the starting base."] };
    },
    explain(P, R, ctx) {
      return `At ${pctStr(P.churn_rate)} churn per ${ctx.label}, ${exact(P.starting_customers)} starting customers fall to ${numD(R.ending_customers, 2)} after ${ctx.H} ${ctx.label}s (${pctStr(R.retention_pct)} retained). That churn costs ${numD(R.cumulative_revenue_lost, 2)} in cumulative revenue versus a no-churn baseline.`;
    },
  },

  // -------------------------------------------------------------------------
  cost_reduction: {
    label: "Cost Reduction",
    category: "cost",
    description:
      "Model the profit impact of cutting costs by a percentage, with optional independent growth in revenue and in the underlying cost base. Reports per-period and cumulative savings plus margin improvement.",
    primary_output: "cumulative_savings",
    inputs: {
      current_revenue: inp(100000, "currency/period", "Revenue in period 1."),
      current_costs: inp(80000, "currency/period", "Cost base in period 1 (before the reduction)."),
      cost_reduction_pct: inp(0.1, "fraction", "Fraction of costs removed, e.g. 0.1 = 10%."),
      revenue_growth_rate: inp(0, "fraction/period", "Per-period revenue growth."),
      cost_growth_rate: inp(0, "fraction/period", "Per-period growth of the underlying (pre-reduction) cost base."),
    },
    outputs: ["new_costs_per_period", "savings_per_period", "cumulative_savings", "profit_before_total", "profit_after_total", "margin_before_pct", "margin_after_pct", "margin_improvement_pct"],
    simulate(P) {
      const H = P.horizon;
      if (P.cost_reduction_pct.gt(1)) throw new ScenarioError("cost_reduction_pct cannot exceed 1 (100%).", { hint: "Use a fraction, e.g. 0.15 for a 15% cut.", type: "invalid_input" });
      const periods = [];
      let revFactor = D(1), costFactor = D(1);
      let cumSave = D(0), profB = D(0), profA = D(0), revTotal = D(0);
      for (let n = 1; n <= H; n++) {
        const rev = P.current_revenue.times(revFactor);
        const costsBefore = P.current_costs.times(costFactor);
        const costsAfter = costsBefore.times(D(1).minus(P.cost_reduction_pct));
        const save = costsBefore.minus(costsAfter);
        const pB = rev.minus(costsBefore), pA = rev.minus(costsAfter);
        cumSave = cumSave.plus(save); profB = profB.plus(pB); profA = profA.plus(pA); revTotal = revTotal.plus(rev);
        periods.push({ period: n, revenue: rev, costs_before: costsBefore, costs_after: costsAfter, savings: save, profit_before: pB, profit_after: pA });
        revFactor = revFactor.times(D(1).plus(P.revenue_growth_rate));
        costFactor = costFactor.times(D(1).plus(P.cost_growth_rate));
      }
      const marginB = revTotal.isZero() ? D(0) : profB.div(revTotal);
      const marginA = revTotal.isZero() ? D(0) : profA.div(revTotal);
      const results = {
        new_costs_per_period: periods[0].costs_after,
        savings_per_period: periods[0].savings,
        cumulative_savings: cumSave,
        profit_before_total: profB,
        profit_after_total: profA,
        margin_before_pct: marginB,
        margin_after_pct: marginA,
        margin_improvement_pct: marginA.minus(marginB),
      };
      return { periods, results, notes: ["Savings apply to the (possibly growing) cost base each period.", "Margins are computed on cumulative revenue over the horizon."] };
    },
    explain(P, R, ctx) {
      return `Cutting costs by ${pctStr(P.cost_reduction_pct)} saves ${numD(R.savings_per_period, 2)} in period 1 and ${numD(R.cumulative_savings, 2)} cumulatively over ${ctx.H} ${ctx.label}s. Net margin improves from ${pctStr(R.margin_before_pct)} to ${pctStr(R.margin_after_pct)} (a ${pctStr(R.margin_improvement_pct)} gain).`;
    },
  },

  // -------------------------------------------------------------------------
  hiring_plan: {
    label: "Hiring Plan",
    category: "workforce",
    description:
      "Project headcount, payroll cost, and (optionally) revenue capacity as you hire a fixed number of people per period, net of attrition. Salaries are annual and converted to the chosen period.",
    primary_output: "cumulative_payroll",
    inputs: {
      starting_headcount: inp(10, "people", "Headcount at period 0."),
      hires_per_period: inp(2, "people/period", "Gross hires added each period."),
      attrition_rate: inp(0, "fraction/period", "Fraction of staff leaving each period."),
      avg_salary: inp(120000, "currency/year", "Average fully-listed base salary per year."),
      overhead_multiplier: inp(1.3, "ratio", "Fully-loaded cost multiplier (benefits, tax, tooling)."),
      revenue_per_employee: inp(0, "currency/year", "Annual revenue capacity per employee (0 to skip)."),
    },
    outputs: ["ending_headcount", "total_hires", "total_departures", "payroll_per_period_end", "cumulative_payroll", "fully_loaded_cost_per_head", "cumulative_capacity_revenue"],
    simulate(P) {
      const H = P.horizon, ppy = P.periodsPerYear;
      const perHeadCost = P.avg_salary.times(P.overhead_multiplier).div(ppy);
      const perHeadRev = P.revenue_per_employee.div(ppy);
      let headcount = P.starting_headcount;
      const periods = [{ period: 0, headcount, hires: D(0), departures: D(0), payroll: headcount.times(perHeadCost), capacity_revenue: headcount.times(perHeadRev) }];
      let totalHires = D(0), totalDep = D(0), cumPay = D(0), cumCap = D(0);
      for (let n = 1; n <= H; n++) {
        const departures = headcount.times(P.attrition_rate);
        headcount = headcount.minus(departures).plus(P.hires_per_period);
        if (headcount.lt(0)) headcount = D(0);
        const payroll = headcount.times(perHeadCost);
        const cap = headcount.times(perHeadRev);
        totalHires = totalHires.plus(P.hires_per_period); totalDep = totalDep.plus(departures);
        cumPay = cumPay.plus(payroll); cumCap = cumCap.plus(cap);
        periods.push({ period: n, headcount, hires: P.hires_per_period, departures, payroll, capacity_revenue: cap });
      }
      const results = {
        ending_headcount: periods[H].headcount,
        total_hires: totalHires,
        total_departures: totalDep,
        payroll_per_period_end: periods[H].payroll,
        cumulative_payroll: cumPay,
        fully_loaded_cost_per_head: P.avg_salary.times(P.overhead_multiplier),
        cumulative_capacity_revenue: cumCap,
      };
      return { periods, results, notes: [`Salaries are annual; per-${P.periodLabel} cost = avg_salary x overhead / ${ppy}.`, "Attrition is applied before new hires each period."] };
    },
    explain(P, R, ctx) {
      let s = `Hiring ${exact(P.hires_per_period)} per ${ctx.label} (attrition ${pctStr(P.attrition_rate)}) grows headcount from ${exact(P.starting_headcount)} to ${numD(R.ending_headcount, 2)} over ${ctx.H} ${ctx.label}s. Cumulative fully-loaded payroll is ${numD(R.cumulative_payroll, 2)} (${numD(R.fully_loaded_cost_per_head, 2)}/head/year).`;
      if (P.revenue_per_employee.gt(0)) s += ` Modeled revenue capacity over the horizon: ${numD(R.cumulative_capacity_revenue, 2)}.`;
      return s;
    },
  },

  // -------------------------------------------------------------------------
  cash_runway: {
    label: "Cash Runway",
    category: "finance",
    description:
      "Track a cash balance forward from expenses and revenue that can each grow independently, and report the runway (how many periods until cash runs out).",
    primary_output: "runway_periods",
    inputs: {
      starting_cash: inp(500000, "currency", "Cash on hand at period 0."),
      expenses_per_period: inp(80000, "currency/period", "Gross operating expenses / burn in period 1."),
      revenue_per_period: inp(20000, "currency/period", "Revenue in period 1."),
      revenue_growth_rate: inp(0.05, "fraction/period", "Per-period revenue growth."),
      expense_growth_rate: inp(0.02, "fraction/period", "Per-period expense growth."),
    },
    outputs: ["ending_cash", "runway_periods", "net_burn_period_1", "cumulative_revenue", "cumulative_expenses", "becomes_cashflow_positive_period"],
    simulate(P) {
      const H = P.horizon;
      let cash = P.starting_cash;
      let revFactor = D(1), expFactor = D(1);
      const periods = [{ period: 0, revenue: D(0), expenses: D(0), net_burn: D(0), cash }];
      let cumRev = D(0), cumExp = D(0), runway = null, cfPositive = null, prevCash = cash;
      for (let n = 1; n <= H; n++) {
        const rev = P.revenue_per_period.times(revFactor);
        const exp = P.expenses_per_period.times(expFactor);
        const netBurn = exp.minus(rev); // positive = burning cash
        prevCash = cash;
        cash = cash.minus(netBurn);
        cumRev = cumRev.plus(rev); cumExp = cumExp.plus(exp);
        if (cfPositive === null && netBurn.lte(0)) cfPositive = n;
        if (runway === null && cash.lt(0)) {
          // linear interpolation within the period for a fractional runway
          const frac = prevCash.div(netBurn); // prevCash / (prevCash - cash)
          runway = D(n - 1).plus(frac);
        }
        periods.push({ period: n, revenue: rev, expenses: exp, net_burn: netBurn, cash });
        revFactor = revFactor.times(D(1).plus(P.revenue_growth_rate));
        expFactor = expFactor.times(D(1).plus(P.expense_growth_rate));
      }
      const results = {
        ending_cash: periods[H].cash,
        runway_periods: runway, // null => solvent through the whole horizon
        net_burn_period_1: periods[1] ? periods[1].net_burn : D(0),
        cumulative_revenue: cumRev,
        cumulative_expenses: cumExp,
        becomes_cashflow_positive_period: cfPositive === null ? null : D(cfPositive),
      };
      return { periods, results, notes: ["net_burn > 0 means cash is being consumed; <= 0 means cash-flow positive.", "runway_periods is null when the balance never goes negative within the horizon.", "Runway uses linear interpolation inside the period where cash crosses zero."] };
    },
    explain(P, R, ctx) {
      const runwayTxt = R.runway_periods === null ? `cash never runs out within the ${ctx.H}-${ctx.label} horizon (ending cash ${numD(R.ending_cash, 2)})` : `cash runs out in ~${numD(R.runway_periods, 2)} ${ctx.label}s`;
      let s = `Starting from ${exact(P.starting_cash)} cash with a period-1 net burn of ${numD(R.net_burn_period_1, 2)}, ${runwayTxt}.`;
      if (R.becomes_cashflow_positive_period !== null) s += ` The business turns cash-flow positive in ${ctx.label} ${exact(R.becomes_cashflow_positive_period)}.`;
      return s;
    },
  },

  // -------------------------------------------------------------------------
  unit_economics: {
    label: "Unit Economics",
    category: "finance",
    description:
      "Compute customer-level economics — LTV, LTV:CAC, and CAC payback — from ARPU, gross margin, churn, and acquisition cost, and project cumulative contribution margin per acquired customer over their lifetime.",
    primary_output: "ltv_cac_ratio",
    inputs: {
      arpu: inp(50, "currency/customer/period", "Average revenue per user per period."),
      gross_margin: inp(0.8, "fraction", "Gross margin on that revenue, e.g. 0.8 = 80%."),
      churn_rate: inp(0.04, "fraction/period", "Fraction of customers lost each period."),
      cac: inp(300, "currency/customer", "Customer acquisition cost."),
    },
    outputs: ["contribution_per_period", "avg_lifetime_periods", "ltv", "ltv_cac_ratio", "cac_payback_periods", "cumulative_margin_at_horizon", "net_profit_per_customer_at_horizon", "break_even_period"],
    simulate(P) {
      const H = P.horizon;
      if (P.churn_rate.lte(0)) throw new ScenarioError("churn_rate must be greater than 0 for unit_economics.", { hint: "Lifetime = 1 / churn; a zero churn implies infinite lifetime. Use a small rate like 0.01.", type: "invalid_input" });
      if (P.churn_rate.gt(1)) throw new ScenarioError("churn_rate cannot exceed 1 (100%).", { hint: "Use a fraction, e.g. 0.04.", type: "invalid_input" });
      const contribution = P.arpu.times(P.gross_margin); // per period per retained customer
      const lifetime = D(1).div(P.churn_rate);
      const ltv = contribution.div(P.churn_rate);
      const ltvCac = P.cac.isZero() ? null : ltv.div(P.cac);
      const payback = contribution.isZero() ? null : P.cac.div(contribution);
      const periods = [{ period: 0, retained_fraction: D(1), period_margin: D(0), cumulative_margin: D(0), net_per_customer: P.cac.neg() }];
      let retained = D(1), cumMargin = D(0), breakEven = null;
      for (let n = 1; n <= H; n++) {
        retained = retained.times(D(1).minus(P.churn_rate)); // survivors at start of period n
        const periodMargin = contribution.times(retained);
        cumMargin = cumMargin.plus(periodMargin);
        const net = cumMargin.minus(P.cac);
        if (breakEven === null && net.gte(0)) breakEven = n;
        periods.push({ period: n, retained_fraction: retained, period_margin: periodMargin, cumulative_margin: cumMargin, net_per_customer: net });
      }
      const results = {
        contribution_per_period: contribution,
        avg_lifetime_periods: lifetime,
        ltv,
        ltv_cac_ratio: ltvCac,
        cac_payback_periods: payback,
        cumulative_margin_at_horizon: cumMargin,
        net_profit_per_customer_at_horizon: cumMargin.minus(P.cac),
        break_even_period: breakEven === null ? null : D(breakEven),
      };
      return { periods, results, notes: ["LTV = ARPU x gross_margin / churn (steady-state).", "cac_payback_periods ignores discounting and churn (gross payback).", "Projected cumulative margin discounts survivors by the retention curve (1-churn)^n."] };
    },
    explain(P, R, ctx) {
      const ratio = R.ltv_cac_ratio === null ? "n/a (CAC is 0)" : `${numD(R.ltv_cac_ratio, 2)}x`;
      const be = R.break_even_period === null ? `not within ${ctx.H} ${ctx.label}s` : `${ctx.label} ${exact(R.break_even_period)}`;
      return `Each customer contributes ${numD(R.contribution_per_period, 2)} per ${ctx.label} and lives ~${numD(R.avg_lifetime_periods, 2)} ${ctx.label}s, giving an LTV of ${numD(R.ltv, 2)} against a ${exact(P.cac)} CAC — an LTV:CAC of ${ratio} with a ${numD(R.cac_payback_periods, 2)}-${ctx.label} payback. CAC is recovered by ${be}.`;
    },
  },

  // -------------------------------------------------------------------------
  marketing_funnel: {
    label: "Marketing Funnel",
    category: "growth",
    description:
      "Flow traffic through a two-stage funnel (visitors -> leads -> customers) with per-period visitor growth, and project customers and revenue over time.",
    primary_output: "total_revenue",
    inputs: {
      visitors_per_period: inp(10000, "visitors/period", "Visitors in period 1."),
      visitor_growth_rate: inp(0.05, "fraction/period", "Per-period growth in visitors."),
      lead_conversion_rate: inp(0.1, "fraction", "Visitor -> lead conversion."),
      sales_conversion_rate: inp(0.2, "fraction", "Lead -> customer conversion."),
      arpu: inp(200, "currency/customer", "Revenue per converted customer."),
    },
    outputs: ["overall_conversion_rate", "customers_period_1", "total_leads", "total_customers", "total_revenue", "ending_customers_per_period"],
    simulate(P) {
      const H = P.horizon;
      const overall = P.lead_conversion_rate.times(P.sales_conversion_rate);
      const periods = [];
      let factor = D(1), totalLeads = D(0), totalCust = D(0), totalRev = D(0);
      for (let n = 1; n <= H; n++) {
        const visitors = P.visitors_per_period.times(factor);
        const leads = visitors.times(P.lead_conversion_rate);
        const customers = leads.times(P.sales_conversion_rate);
        const revenue = customers.times(P.arpu);
        totalLeads = totalLeads.plus(leads); totalCust = totalCust.plus(customers); totalRev = totalRev.plus(revenue);
        periods.push({ period: n, visitors, leads, customers, revenue });
        factor = factor.times(D(1).plus(P.visitor_growth_rate));
      }
      const results = {
        overall_conversion_rate: overall,
        customers_period_1: periods[0].customers,
        total_leads: totalLeads,
        total_customers: totalCust,
        total_revenue: totalRev,
        ending_customers_per_period: periods[H - 1].customers,
      };
      return { periods, results, notes: ["overall_conversion_rate = lead_conversion x sales_conversion.", "Counts are kept fractional; round if you need whole customers."] };
    },
    explain(P, R, ctx) {
      return `At ${pctStr(R.overall_conversion_rate)} overall conversion, ${exact(P.visitors_per_period)} visitors/${ctx.label} (growing ${pctStr(P.visitor_growth_rate)}) produce ${numD(R.customers_period_1, 2)} customers in period 1 and ${numD(R.total_customers, 2)} customers over ${ctx.H} ${ctx.label}s, for ${numD(R.total_revenue, 2)} in revenue.`;
    },
  },

  // -------------------------------------------------------------------------
  compound_growth: {
    label: "Compound Growth",
    category: "generic",
    description:
      "A single-metric projection: grow a starting value by a fixed rate each period, either compounding (value x (1+rate)^n) or linearly (value x (1 + rate x n)). Useful as a quick generic what-if.",
    primary_output: "ending_value",
    inputs: {
      starting_value: inp(1000, "value", "Value at period 0."),
      growth_rate: inp(0.1, "fraction/period", "Growth per period."),
      linear: inp(0, "0 or 1", "0 = compound (default), 1 = linear growth.", "integer"),
    },
    outputs: ["ending_value", "total_growth", "cumulative_value", "growth_multiple"],
    simulate(P) {
      const H = P.horizon;
      const linear = !P.linear.isZero();
      const periods = [{ period: 0, value: P.starting_value }];
      let value = P.starting_value, cum = D(0);
      for (let n = 1; n <= H; n++) {
        value = linear ? P.starting_value.times(D(1).plus(P.growth_rate.times(n))) : value.times(D(1).plus(P.growth_rate));
        cum = cum.plus(value);
        periods.push({ period: n, value });
      }
      const ending = periods[H].value;
      const results = {
        ending_value: ending,
        total_growth: ending.minus(P.starting_value),
        cumulative_value: cum,
        growth_multiple: P.starting_value.isZero() ? null : ending.div(P.starting_value),
      };
      return { periods, results, notes: [linear ? "Linear mode: value = starting_value x (1 + rate x period)." : "Compound mode: value = previous_value x (1 + rate)."] };
    },
    explain(P, R, ctx) {
      const mode = P.linear.isZero() ? "compounding" : "linear";
      return `Growing ${exact(P.starting_value)} at ${pctStr(P.growth_rate)}/${ctx.label} (${mode}) reaches ${numD(R.ending_value, 2)} after ${ctx.H} ${ctx.label}s${R.growth_multiple ? ` (a ${numD(R.growth_multiple, 4)}x multiple)` : ""}. Cumulative total across periods: ${numD(R.cumulative_value, 2)}.`;
    },
  },
};

// Resolve a template name (with a couple of friendly aliases).
const TEMPLATE_ALIASES = {
  saas: "saas_growth", subscription: "saas_growth", mrr: "saas_growth",
  pricing: "pricing_change", price_change: "pricing_change", price: "pricing_change",
  churn: "churn_impact", retention: "churn_impact",
  cost: "cost_reduction", cost_cut: "cost_reduction",
  hiring: "hiring_plan", headcount: "hiring_plan", hire: "hiring_plan",
  runway: "cash_runway", burn: "cash_runway", cash: "cash_runway",
  ltv: "unit_economics", cac: "unit_economics", unit: "unit_economics",
  funnel: "marketing_funnel", marketing: "marketing_funnel",
  compound: "compound_growth", growth: "compound_growth", generic: "compound_growth",
};
function resolveTemplateName(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (TEMPLATES[key]) return key;
  if (TEMPLATE_ALIASES[key]) return TEMPLATE_ALIASES[key];
  throw new ScenarioError(`Unknown scenario template '${name}'.`, {
    hint: `Available templates: ${Object.keys(TEMPLATES).join(", ")}. Call list_templates for details, or omit 'template' and pass a 'metrics' array for a custom free-form projection.`,
    type: "unknown_template",
  });
}

// ---------------------------------------------------------------------------
// Input resolution — fill defaults, coerce to Decimal, validate ranges.
// Accepts assumptions under `inputs`, `assumptions`, or spread at the top level.
// ---------------------------------------------------------------------------
function collectAssumptions(args) {
  const merged = {};
  // top-level scalars that are NOT reserved tool params can act as assumptions too.
  const reserved = new Set(["template", "scenario", "inputs", "assumptions", "metrics", "horizon", "periods", "period_label", "name"]);
  if (args.assumptions && typeof args.assumptions === "object") Object.assign(merged, args.assumptions);
  if (args.inputs && typeof args.inputs === "object") Object.assign(merged, args.inputs);
  for (const [k, v] of Object.entries(args)) if (!reserved.has(k) && (typeof v === "number" || typeof v === "string")) merged[k] = v;
  return merged;
}

function resolveHorizon(args, assumptions, fallback) {
  let h = args.horizon ?? args.periods ?? assumptions.horizon ?? assumptions.periods ?? fallback;
  const n = parseInt(String(h), 10);
  if (!Number.isFinite(n) || n < 1)
    throw new ScenarioError(`'horizon' must be a positive integer (got ${JSON.stringify(h)}).`, { hint: "e.g. 12 for a one-year monthly projection.", type: "invalid_horizon" });
  if (n > MAX_HORIZON)
    throw new ScenarioError(`'horizon' of ${n} exceeds the maximum of ${MAX_HORIZON} periods.`, { hint: `Use <= ${MAX_HORIZON} periods, or a coarser period_label (e.g. quarter/year).`, type: "invalid_horizon" });
  return n;
}

function resolveInputs(templateKey, args) {
  const tpl = TEMPLATES[templateKey];
  const assumptions = collectAssumptions(args);
  const periodLabel = normalizePeriodLabel(args.period_label ?? assumptions.period_label);
  const horizon = resolveHorizon(args, assumptions, tpl.defaultHorizon || 12);

  const P = { horizon, periodLabel, periodsPerYear: D(PERIODS_PER_YEAR[periodLabel]) };
  const unknown = [];
  const known = new Set(Object.keys(tpl.inputs));
  for (const k of Object.keys(assumptions)) if (!known.has(k) && !["horizon", "periods", "period_label"].includes(k)) unknown.push(k);

  for (const [name, spec] of Object.entries(tpl.inputs)) {
    const provided = assumptions[name];
    const value = provided === undefined || provided === null || provided === "" ? spec.default : provided;
    let d = toDec(name, value);
    if (spec.type === "integer") d = d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    P[name] = d;
  }
  return { P, assumptions, unknown, periodLabel, horizon };
}

// ---------------------------------------------------------------------------
// Custom (free-form) model — a list of independently-growing metrics.
// ---------------------------------------------------------------------------
function parseCustomMetrics(args) {
  const metrics = args.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0)
    throw new ScenarioError("A custom scenario needs a non-empty 'metrics' array.", {
      hint: 'Example: {"metrics":[{"name":"revenue","start":10000,"growth_rate":0.08,"mode":"compound"}]}.',
      type: "missing_parameter",
    });
  const out = [];
  const seen = new Set();
  metrics.forEach((m, i) => {
    if (!m || typeof m !== "object" || Array.isArray(m))
      throw new ScenarioError(`metrics[${i}] must be an object {name, start, growth_rate?, mode?}.`, { hint: 'Example: {"name":"users","start":500,"growth_rate":0.05}.' });
    const name = String(m.name ?? "").trim();
    if (!name) throw new ScenarioError(`metrics[${i}] is missing a 'name'.`, { hint: "Give every metric a unique non-empty name." });
    if (seen.has(name)) throw new ScenarioError(`Duplicate metric name '${name}'.`, { hint: "Metric names must be unique.", type: "duplicate_metric" });
    seen.add(name);
    const start = toDec(`metrics['${name}'].start`, m.start);
    const growth = m.growth_rate === undefined || m.growth_rate === null || m.growth_rate === "" ? D(0) : toDec(`metrics['${name}'].growth_rate`, m.growth_rate);
    const mode = String(m.mode ?? "compound").trim().toLowerCase();
    if (mode !== "compound" && mode !== "linear")
      throw new ScenarioError(`metrics['${name}'].mode must be 'compound' or 'linear' (got '${m.mode}').`, { hint: "Use 'compound' for x(1+r)^n or 'linear' for x(1+r*n).", type: "invalid_input" });
    out.push({ name, start, growth, mode });
  });
  return out;
}

function simulateCustom(metrics, horizon) {
  const periods = [];
  const running = metrics.map((m) => m.start);
  periods.push(Object.assign({ period: 0 }, Object.fromEntries(metrics.map((m) => [m.name, m.start]))));
  const cum = metrics.map(() => D(0));
  for (let n = 1; n <= horizon; n++) {
    const row = { period: n };
    metrics.forEach((m, i) => {
      running[i] = m.mode === "linear" ? m.start.times(D(1).plus(m.growth.times(n))) : running[i].times(D(1).plus(m.growth));
      row[m.name] = running[i];
      cum[i] = cum[i].plus(running[i]);
    });
    periods.push(row);
  }
  const results = {};
  metrics.forEach((m, i) => {
    results[`ending_${m.name}`] = running[i];
    results[`cumulative_${m.name}`] = cum[i];
  });
  return { periods, results, notes: ["Each metric grows independently; 'compound' = x(1+r)^n, 'linear' = x(1+r*n)."], metrics };
}

// ---------------------------------------------------------------------------
// Output formatting — shared envelope pieces.
// ---------------------------------------------------------------------------
function formatResults(results) {
  const out = {};
  for (const [k, v] of Object.entries(results)) out[k] = v === null ? null : numD(v);
  return out;
}
function formatResultsDetail(results, tpl) {
  const meta = {};
  if (tpl) for (const o of tpl.outputs) meta[o] = o;
  const unitMap = tpl ? Object.fromEntries((tpl.outputDetails || []).map((d) => [d.name, d])) : {};
  return Object.entries(results).map(([name, v]) => ({
    metric: name,
    value: v === null ? null : numD(v),
    value_exact: v === null ? null : exact(v),
    ...(unitMap[name] ? { unit: unitMap[name].unit, description: unitMap[name].description } : {}),
  }));
}
function formatProjections(periods) {
  return periods.map((row) => {
    const o = {};
    for (const [k, v] of Object.entries(row)) o[k] = k === "period" ? v : (v instanceof Decimal ? numD(v) : v);
    return o;
  });
}
function assumptionsBlock(P, tpl, periodLabel, horizon) {
  const vals = {};
  for (const name of Object.keys(tpl.inputs)) vals[name] = exact(P[name]);
  return { template: undefined, ...vals, horizon, period_label: periodLabel };
}

// ===========================================================================
// TOOL: run_scenario
// ===========================================================================
function run_scenario_impl(args = {}) {
  const templateArg = args.template ?? args.scenario;
  const wantsCustom = (templateArg && String(templateArg).trim().toLowerCase() === "custom") || (!templateArg && Array.isArray(args.metrics));

  if (wantsCustom) {
    const metrics = parseCustomMetrics(args);
    const periodLabel = normalizePeriodLabel(args.period_label);
    const horizon = resolveHorizon(args, args.inputs || {}, 12);
    const sim = simulateCustom(metrics, horizon);
    const ctx = { H: horizon, label: periodLabel };
    return {
      status: "success",
      scenario: "custom",
      period_label: periodLabel,
      horizon,
      key_results: formatResults(sim.results),
      key_results_detail: Object.entries(sim.results).map(([name, v]) => ({ metric: name, value: numD(v), value_exact: exact(v) })),
      projections: formatProjections(sim.periods),
      assumptions_used: {
        template: "custom",
        metrics: metrics.map((m) => ({ name: m.name, start: exact(m.start), growth_rate: exact(m.growth), mode: m.mode })),
        horizon,
        period_label: periodLabel,
      },
      methodology: {
        model: "custom free-form: independent per-metric compound/linear growth",
        precision: "decimal.js (40 significant digits)",
        deterministic: true,
        formulas: ["compound: value_n = value_(n-1) x (1 + rate)", "linear: value_n = start x (1 + rate x n)"],
      },
      notes: sim.notes,
      explanation: `Custom projection of ${metrics.length} metric(s) over ${horizon} ${periodLabel}(s): ${metrics.map((m) => `${m.name} ${exact(m.start)}@${pctStr(m.growth)}`).join(", ")}.`,
    };
  }

  const templateKey = resolveTemplateName(templateArg ?? "compound_growth");
  const tpl = TEMPLATES[templateKey];
  const { P, unknown, periodLabel, horizon } = resolveInputs(templateKey, args);
  const sim = tpl.simulate(P);
  const ctx = { H: horizon, label: periodLabel };

  const notes = [...sim.notes];
  if (unknown.length) notes.push(`Ignored unrecognized input(s): ${unknown.join(", ")}. Valid inputs for '${templateKey}': ${Object.keys(tpl.inputs).join(", ")}.`);

  return {
    status: "success",
    scenario: templateKey,
    template_label: tpl.label,
    period_label: periodLabel,
    horizon,
    key_results: formatResults(sim.results),
    key_results_detail: formatResultsDetail(sim.results, tpl),
    projections: formatProjections(sim.periods),
    assumptions_used: {
      template: templateKey,
      ...Object.fromEntries(Object.keys(tpl.inputs).map((k) => [k, exact(P[k])])),
      horizon,
      period_label: periodLabel,
    },
    methodology: {
      model: tpl.label,
      description: tpl.description,
      primary_output: tpl.primary_output,
      precision: "decimal.js (40 significant digits)",
      deterministic: true,
      period_convention: `Period 0 is the starting state; periods 1..${horizon} are projected. ${PERIODS_PER_YEAR[periodLabel]} ${periodLabel}(s) per year.`,
    },
    notes,
    explanation: tpl.explain(P, sim.results, ctx),
  };
}

// ---------------------------------------------------------------------------
// Evaluate a single output metric for a template under modified inputs.
// Used by sensitivity_analysis and break_even. Returns a Decimal (or null).
// ---------------------------------------------------------------------------
function evalMetric(templateKey, baseArgs, overrides, metricName) {
  const args = { ...baseArgs, inputs: { ...collectAssumptions(baseArgs), ...overrides } };
  const { P } = resolveInputs(templateKey, args);
  const sim = TEMPLATES[templateKey].simulate(P);
  if (!(metricName in sim.results))
    throw new ScenarioError(`Unknown target_metric '${metricName}' for template '${templateKey}'.`, {
      hint: `Available metrics: ${Object.keys(sim.results).join(", ")}.`, type: "unknown_metric",
    });
  return sim.results[metricName];
}

function requireTemplateForSolver(args, toolName) {
  const t = args.template ?? args.scenario;
  if (!t || String(t).trim().toLowerCase() === "custom")
    throw new ScenarioError(`${toolName} requires a named 'template' (custom free-form scenarios are not supported here).`, {
      hint: `Use one of: ${Object.keys(TEMPLATES).join(", ")}.`, type: "unsupported_for_custom",
    });
  return resolveTemplateName(t);
}

// ===========================================================================
// TOOL: sensitivity_analysis
// Vary one or more inputs (one-at-a-time) and report the impact on a target metric.
// ===========================================================================
function sensitivity_analysis_impl(args = {}) {
  const templateKey = requireTemplateForSolver(args, "sensitivity_analysis");
  const tpl = TEMPLATES[templateKey];
  const target = String(args.target_metric ?? tpl.primary_output);

  // Baseline run.
  const baseArgs = args;
  const baseMetric = evalMetric(templateKey, baseArgs, {}, target);
  const { P: baseP, periodLabel, horizon } = resolveInputs(templateKey, baseArgs);

  // Which variables to vary.
  let variables = args.variables;
  if (!variables) {
    if (args.variable) variables = [{ name: args.variable, variation: args.variation, steps: args.steps, values: args.values, min: args.min, max: args.max }];
    else throw new ScenarioError("Provide 'variable' (a single input name) or 'variables' (an array) to sweep.", {
      hint: `Valid inputs for '${templateKey}': ${Object.keys(tpl.inputs).join(", ")}.`, type: "missing_parameter",
    });
  }
  if (!Array.isArray(variables) || variables.length === 0)
    throw new ScenarioError("'variables' must be a non-empty array of {name, ...}.", { hint: 'Example: [{"name":"churn_rate","variation":0.5,"steps":5}].', type: "invalid_input" });

  const perVariable = variables.map((v) => {
    const name = typeof v === "string" ? v : String(v.name ?? "");
    if (!(name in tpl.inputs))
      throw new ScenarioError(`Unknown input '${name}' for template '${templateKey}'.`, { hint: `Valid inputs: ${Object.keys(tpl.inputs).join(", ")}.`, type: "unknown_input" });
    const baseVal = baseP[name];

    // Build the sweep values.
    let values = [];
    const cfg = typeof v === "string" ? {} : v;
    if (Array.isArray(cfg.values) && cfg.values.length) {
      values = cfg.values.map((x, i) => toDec(`values[${i}]`, x));
    } else if (cfg.min !== undefined && cfg.max !== undefined) {
      const lo = toDec("min", cfg.min), hi = toDec("max", cfg.max);
      const steps = clampInt(cfg.steps, 5, 2, 200);
      const stepSize = hi.minus(lo).div(steps - 1);
      for (let s = 0; s < steps; s++) values.push(lo.plus(stepSize.times(s)));
    } else {
      const variation = cfg.variation === undefined || cfg.variation === null ? D(0.2) : toDec("variation", cfg.variation);
      if (variation.lte(0) || variation.gt(1)) throw new ScenarioError(`'variation' must be in (0, 1] (got ${cfg.variation}).`, { hint: "0.2 sweeps +/-20% around the baseline.", type: "invalid_input" });
      const steps = clampInt(cfg.steps, 5, 2, 200);
      const lo = baseVal.times(D(1).minus(variation));
      const hi = baseVal.times(D(1).plus(variation));
      const stepSize = hi.minus(lo).div(steps - 1);
      for (let s = 0; s < steps; s++) values.push(lo.plus(stepSize.times(s)));
    }

    const rows = values.map((val) => {
      const m = evalMetric(templateKey, baseArgs, { [name]: val }, target);
      const pctChange = baseMetric === null || m === null || baseMetric.isZero() ? null : m.minus(baseMetric).div(baseMetric);
      return { input_value: numD(val), input_value_exact: exact(val), target_value: m === null ? null : numD(m), pct_change_from_baseline: pctChange === null ? null : numD(pctChange) };
    });

    // Numerical elasticity around the baseline (central-ish): use first and last sweep points.
    const finite = rows.filter((r) => r.target_value !== null);
    let range = null, minRow = null, maxRow = null, elasticity = null;
    if (finite.length) {
      minRow = finite.reduce((a, b) => (b.target_value < a.target_value ? b : a));
      maxRow = finite.reduce((a, b) => (b.target_value > a.target_value ? b : a));
      range = numD(D(maxRow.target_value).minus(minRow.target_value));
      const first = values[0], last = values[values.length - 1];
      if (!baseVal.isZero() && !baseMetric?.isZero() && !last.minus(first).isZero()) {
        const mFirst = D(rows[0].target_value ?? 0), mLast = D(rows[rows.length - 1].target_value ?? 0);
        const dInPct = last.minus(first).div(baseVal);
        const dOutPct = mLast.minus(mFirst).div(baseMetric);
        elasticity = dInPct.isZero() ? null : numD(dOutPct.div(dInPct));
      }
    }
    return {
      input: name,
      baseline_input: exact(baseVal),
      target_metric: target,
      baseline_target: baseMetric === null ? null : numD(baseMetric),
      elasticity_estimate: elasticity,
      output_range: range,
      min_case: minRow ? { input_value: minRow.input_value, target_value: minRow.target_value } : null,
      max_case: maxRow ? { input_value: maxRow.input_value, target_value: maxRow.target_value } : null,
      sweep: rows,
    };
  });

  // Rank variables by how much they move the target (largest range first).
  const ranked = [...perVariable].filter((v) => v.output_range !== null).sort((a, b) => b.output_range - a.output_range).map((v) => v.input);

  return {
    status: "success",
    scenario: templateKey,
    template_label: tpl.label,
    target_metric: target,
    baseline_target: baseMetric === null ? null : numD(baseMetric),
    period_label: periodLabel,
    horizon,
    most_influential: ranked,
    per_variable: perVariable,
    assumptions_used: {
      template: templateKey,
      ...Object.fromEntries(Object.keys(tpl.inputs).map((k) => [k, exact(baseP[k])])),
      horizon,
      period_label: periodLabel,
    },
    methodology: {
      model: tpl.label,
      procedure: "One-at-a-time sensitivity: each listed input is swept across its range while all others stay at baseline; the target metric is recomputed at every point.",
      elasticity_estimate: "Approx. (%change in target) / (%change in input) measured across the swept endpoints.",
      precision: "decimal.js (40 significant digits)",
      deterministic: true,
    },
    notes: [
      "Only one input is varied at a time; interaction effects are not captured here.",
      "'most_influential' ranks inputs by the size of the target-metric range they produce.",
    ],
    explanation: buildSensitivityExplanation(perVariable, target, tpl),
  };
}

function buildSensitivityExplanation(perVariable, target, tpl) {
  if (!perVariable.length) return `No variables were swept.`;
  const ranked = [...perVariable].filter((v) => v.output_range !== null).sort((a, b) => b.output_range - a.output_range);
  if (!ranked.length) return `Swept ${perVariable.length} input(s) against '${target}', but the metric did not change (it may be independent of these inputs).`;
  const top = ranked[0];
  let s = `Against '${target}', the most influential input is '${top.input}': sweeping it moves the metric across a range of ${top.output_range}`;
  if (top.elasticity_estimate !== null) s += ` (elasticity ~${top.elasticity_estimate})`;
  s += ".";
  if (ranked.length > 1) s += ` Ranked influence: ${ranked.map((r) => r.input).join(" > ")}.`;
  return s;
}

// ===========================================================================
// TOOL: break_even
// Solve for the input value that makes a target metric hit a target value.
// ===========================================================================
function break_even_impl(args = {}) {
  const templateKey = requireTemplateForSolver(args, "break_even");
  const tpl = TEMPLATES[templateKey];

  const solveFor = String(args.solve_for ?? args.variable ?? "");
  if (!solveFor) throw new ScenarioError("break_even needs 'solve_for' (the input to solve for).", { hint: `Valid inputs for '${templateKey}': ${Object.keys(tpl.inputs).join(", ")}.`, type: "missing_parameter" });
  if (!(solveFor in tpl.inputs)) throw new ScenarioError(`Unknown input '${solveFor}' for template '${templateKey}'.`, { hint: `Valid inputs: ${Object.keys(tpl.inputs).join(", ")}.`, type: "unknown_input" });

  const targetMetric = String(args.target_metric ?? tpl.primary_output);
  if (args.target_value === undefined || args.target_value === null || args.target_value === "")
    throw new ScenarioError("break_even needs 'target_value' (the metric value to reach).", { hint: `e.g. {"target_metric":"${tpl.primary_output}","target_value":0}.`, type: "missing_parameter" });
  const targetValue = toDec("target_value", args.target_value);

  const { P: baseP, periodLabel, horizon } = resolveInputs(templateKey, args);
  const baseVal = baseP[solveFor];

  // Objective g(x) = metric(x) - target. Guarded: an undefined/non-finite metric
  // (e.g. a division by zero at a pole) is treated as "cannot evaluate here" (null)
  // rather than throwing, so the solver degrades to a clean no_solution result.
  const f = (x) => {
    try {
      const m = evalMetric(templateKey, args, { [solveFor]: x }, targetMetric);
      return m === null || !m.isFinite() ? null : m;
    } catch {
      return null;
    }
  };
  // Validate metric exists once.
  const baselineMetric = f(baseVal);
  if (baselineMetric === null)
    throw new ScenarioError(`target_metric '${targetMetric}' is undefined (null) at the baseline; it may be infinite/non-applicable.`, { hint: "Pick a metric that produces a finite number, or adjust the assumptions.", type: "unknown_metric" });

  // Search bounds.
  let lo, hi;
  if (args.bounds && Array.isArray(args.bounds) && args.bounds.length === 2) {
    lo = toDec("bounds[0]", args.bounds[0]);
    hi = toDec("bounds[1]", args.bounds[1]);
  } else {
    const span = baseVal.abs().times(4).plus(10);
    lo = baseVal.minus(span);
    hi = baseVal.plus(span);
  }
  if (hi.lte(lo)) throw new ScenarioError("bounds must be [low, high] with high > low.", { hint: "e.g. [0, 100].", type: "invalid_input" });

  const solved = bisectSolve(f, targetValue, lo, hi);
  if (!solved.found) {
    return {
      status: "error",
      error: {
        type: "no_solution",
        message: `Could not reach ${targetMetric} = ${exact(targetValue)} by varying '${solveFor}' within the search range.`,
        hint: `Over [${numD(solved.lo)}, ${numD(solved.hi)}], '${targetMetric}' ranged about [${solved.fLo === null ? "n/a" : numD(solved.fLo)}, ${solved.fHi === null ? "n/a" : numD(solved.fHi)}]. Pass explicit 'bounds' that bracket the target, or check that the metric responds to this input.`,
      },
      scenario: templateKey,
      solve_for: solveFor,
      target_metric: targetMetric,
      target_value: numD(targetValue),
    };
  }

  const achievedMetric = f(solved.x);
  return {
    status: "success",
    scenario: templateKey,
    template_label: tpl.label,
    solve_for: solveFor,
    target_metric: targetMetric,
    target_value: numD(targetValue),
    key_results: {
      required_input: numD(solved.x),
      required_input_exact: exact(solved.x),
      baseline_input: numD(baseVal),
      change_from_baseline: numD(solved.x.minus(baseVal)),
      achieved_metric: numD(achievedMetric),
      residual: numD(achievedMetric.minus(targetValue)),
      iterations: solved.iterations,
    },
    assumptions_used: {
      template: templateKey,
      ...Object.fromEntries(Object.keys(tpl.inputs).map((k) => [k, exact(baseP[k])])),
      horizon,
      period_label: periodLabel,
    },
    methodology: {
      model: tpl.label,
      method: "bisection root-finding on the objective metric(input) - target_value",
      monotonicity: "Assumes the target metric is monotonic in the solved input over the search range; a bracket is auto-expanded up to 60x if needed.",
      tolerance: "Converged to a relative bracket width < 1e-12 or 200 iterations.",
      precision: "decimal.js (40 significant digits)",
      deterministic: true,
    },
    notes: [
      `To make '${targetMetric}' equal ${exact(targetValue)}, set '${solveFor}' to ${numD(solved.x)} (baseline was ${numD(baseVal)}).`,
      "If the metric is non-monotonic there may be other solutions; bisection returns the one inside the bracket.",
    ],
    explanation: `To reach ${targetMetric} = ${numD(targetValue)}, '${solveFor}' must be ${numD(solved.x)} (a change of ${numD(solved.x.minus(baseVal))} from the baseline ${numD(baseVal)}). At that value the model produces ${targetMetric} = ${numD(achievedMetric)}.`,
  };
}

// Deterministic bisection with automatic bracket expansion.
function bisectSolve(f, target, lo, hi) {
  const g = (x) => { const m = f(x); return m === null ? null : m.minus(target); };
  let gLo = g(lo), gHi = g(hi);
  // Expand the bracket outward until it straddles the root (fixed schedule => deterministic).
  let expansions = 0;
  while (expansions < 60 && gLo !== null && gHi !== null && sign(gLo) === sign(gHi) && !gLo.isZero() && !gHi.isZero()) {
    const span = hi.minus(lo);
    lo = lo.minus(span); hi = hi.plus(span);
    gLo = g(lo); gHi = g(hi);
    expansions++;
  }
  const fLo = f(lo), fHi = f(hi);
  if (gLo === null || gHi === null || sign(gLo) === sign(gHi))
    return { found: false, lo, hi, fLo, fHi };
  if (gLo.isZero()) return { found: true, x: lo, iterations: 0 };
  if (gHi.isZero()) return { found: true, x: hi, iterations: 0 };

  let a = lo, b = hi, ga = gLo;
  let i = 0;
  for (; i < 200; i++) {
    const mid = a.plus(b).div(2);
    const gm = g(mid);
    if (gm === null) break;
    if (gm.isZero() || b.minus(a).abs().lte(a.abs().plus(1).times("1e-12"))) return { found: true, x: mid, iterations: i + 1 };
    if (sign(gm) === sign(ga)) { a = mid; ga = gm; } else { b = mid; }
  }
  return { found: true, x: a.plus(b).div(2), iterations: i };
}
function sign(d) { return d.isZero() ? 0 : d.isNegative() ? -1 : 1; }
function clampInt(v, def, lo, hi) {
  if (v === undefined || v === null || v === "") return def;
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

// ===========================================================================
// TOOL: compare_scenarios
// Run 2-3 scenarios and compare their key results side by side.
// ===========================================================================
function compare_scenarios_impl(args = {}) {
  const scenarios = args.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length < 2)
    throw new ScenarioError("compare_scenarios needs a 'scenarios' array with 2 or 3 entries.", {
      hint: 'Example: {"scenarios":[{"name":"Base","template":"saas_growth","inputs":{...}},{"name":"Aggressive","template":"saas_growth","inputs":{"churn_rate":0.02}}]}.',
      type: "missing_parameter",
    });
  if (scenarios.length > 3)
    throw new ScenarioError(`compare_scenarios supports at most 3 scenarios (got ${scenarios.length}).`, { hint: "Compare in batches of 2-3 for a readable side-by-side.", type: "too_many_scenarios" });

  const sharedHorizon = args.horizon ?? args.periods;
  const includeProjections = args.include_projections === true;

  const runs = scenarios.map((sc, i) => {
    if (!sc || typeof sc !== "object") throw new ScenarioError(`scenarios[${i}] must be an object {name?, template, inputs}.`, { hint: 'Example: {"name":"Base","template":"saas_growth","inputs":{...}}.' });
    const name = String(sc.name ?? `Scenario ${i + 1}`);
    const sub = { ...sc };
    if (sharedHorizon !== undefined && sub.horizon === undefined && sub.periods === undefined) sub.horizon = sharedHorizon;
    const res = run_scenario_impl(sub);
    if (res.status === "error") throw new ScenarioError(`scenarios[${i}] ('${name}') failed: ${res.error.message}`, { hint: res.error.hint, type: res.error.type });
    return { name, result: res };
  });

  // Union of key_result metric names (in first-seen order).
  const metricOrder = [];
  const seen = new Set();
  for (const r of runs) for (const k of Object.keys(r.result.key_results)) if (!seen.has(k)) { seen.add(k); metricOrder.push(k); }

  const baseline = runs[0];
  const comparison = metricOrder.map((metric) => {
    const row = { metric };
    for (const r of runs) row[r.name] = r.result.key_results[metric] ?? null;
    const bv = baseline.result.key_results[metric];
    for (let i = 1; i < runs.length; i++) {
      const v = runs[i].result.key_results[metric];
      row[`${runs[i].name}_vs_${baseline.name}`] = (bv === null || bv === undefined || v === null || v === undefined) ? null : numD(D(v).minus(bv));
    }
    return row;
  });

  // Optional ranking on a chosen metric.
  let ranking = null, winner = null;
  const compareMetric = args.compare_metric;
  if (compareMetric) {
    const goal = String(args.goal ?? "max").toLowerCase();
    if (goal !== "max" && goal !== "min") throw new ScenarioError(`'goal' must be 'max' or 'min' (got '${args.goal}').`, { hint: "max = higher is better; min = lower is better.", type: "invalid_input" });
    const scored = runs
      .map((r) => ({ name: r.name, value: r.result.key_results[compareMetric] }))
      .filter((r) => r.value !== undefined && r.value !== null);
    if (!scored.length)
      throw new ScenarioError(`compare_metric '${compareMetric}' is not present in the scenario results.`, { hint: `Available metrics: ${metricOrder.join(", ")}.`, type: "unknown_metric" });
    scored.sort((a, b) => goal === "max" ? b.value - a.value : a.value - b.value);
    ranking = scored.map((s, i) => ({ rank: i + 1, name: s.name, value: s.value }));
    winner = { name: scored[0].name, metric: compareMetric, value: scored[0].value, goal };
  }

  const explanation = buildCompareExplanation(runs, winner, compareMetric, comparison);

  return {
    status: "success",
    scenario_count: runs.length,
    compare_metric: compareMetric ?? null,
    winner,
    ranking,
    scenarios: runs.map((r) => ({
      name: r.name,
      template: r.result.scenario,
      horizon: r.result.horizon,
      period_label: r.result.period_label,
      key_results: r.result.key_results,
      assumptions_used: r.result.assumptions_used,
      ...(includeProjections ? { projections: r.result.projections } : {}),
    })),
    comparison,
    methodology: {
      procedure: "Each scenario is run independently through run_scenario; key_results are aligned by metric name and differenced against the first scenario (the baseline).",
      baseline: baseline.name,
      precision: "decimal.js (40 significant digits)",
      deterministic: true,
    },
    notes: [
      `Deltas are computed relative to the first scenario ('${baseline.name}').`,
      "Only metrics that exist in a scenario are populated; comparing different templates may leave gaps.",
      includeProjections ? "Full per-period projections are included per scenario." : "Pass include_projections:true to also return per-period projections.",
    ],
    explanation,
  };
}

function buildCompareExplanation(runs, winner, compareMetric, comparison) {
  const names = runs.map((r) => `'${r.name}'`).join(", ");
  let s = `Compared ${runs.length} scenarios (${names}).`;
  if (winner) {
    s += ` On '${compareMetric}' (${winner.goal}), '${winner.name}' is best at ${winner.value}.`;
  } else if (comparison.length) {
    const first = comparison[0];
    s += ` Baseline metric '${first.metric}': ${runs.map((r) => `${r.name}=${first[r.name]}`).join(", ")}.`;
  }
  return s;
}

// ===========================================================================
// TOOL: list_templates
// ===========================================================================
function list_templates_impl() {
  const templates = Object.entries(TEMPLATES).map(([key, t]) => ({
    id: key,
    label: t.label,
    category: t.category,
    description: t.description,
    primary_output: t.primary_output,
    inputs: Object.fromEntries(Object.entries(t.inputs).map(([n, s]) => [n, { default: s.default, unit: s.unit, type: s.type || "number", description: s.description }])),
    outputs: t.outputs,
    aliases: Object.entries(TEMPLATE_ALIASES).filter(([, v]) => v === key).map(([a]) => a),
  }));
  return {
    status: "success",
    count: templates.length,
    templates,
    custom_scenario: {
      description: "Omit 'template' (or set template:'custom') and pass a 'metrics' array to project arbitrary independently-growing metrics.",
      example: { template: "custom", metrics: [{ name: "revenue", start: 10000, growth_rate: 0.08, mode: "compound" }], horizon: 12 },
    },
    period_labels: Object.keys(PERIODS_PER_YEAR),
    notes: [
      "Every template accepts 'horizon' (number of periods) and 'period_label' (day/week/month/quarter/year).",
      "Inputs not provided fall back to the documented defaults; unrecognized inputs are ignored and reported in notes.",
      "All templates are 100% deterministic and computed with 40-digit decimal precision.",
    ],
  };
}

// ===========================================================================
// TOOL: health_check
// ===========================================================================
function health_check_impl() {
  return {
    status: "ok",
    server: "ScenarioSim",
    version: ENGINE_VERSION,
    precision: "decimal.js (40 significant digits)",
    deterministic: true,
    stateless: true,
    tools: ["run_scenario", "sensitivity_analysis", "break_even", "compare_scenarios", "list_templates", "health_check"],
    templates: Object.keys(TEMPLATES),
    period_labels: Object.keys(PERIODS_PER_YEAR),
    max_horizon: MAX_HORIZON,
    runtime: "cloudflare-pages-functions",
  };
}

// ---------------------------------------------------------------------------
// Public tool entrypoints. Every tool is guarded so a validation problem comes
// back as a structured { status:"error", error:{type,message,hint} } envelope
// instead of a thrown exception — the same contract whether the engine is used
// standalone (imports/tests) or behind the MCP transport.
// ---------------------------------------------------------------------------
function guard(fn) {
  return (args) => {
    try {
      return fn(args || {});
    } catch (e) {
      if (e instanceof ScenarioError) return errEnvelope(e.message, e.type, e.hint);
      return errEnvelope(`Unexpected error: ${e.message}`, "internal_error", "Verify the shape/types of your inputs against the tool schema.");
    }
  };
}

export const run_scenario = guard(run_scenario_impl);
export const sensitivity_analysis = guard(sensitivity_analysis_impl);
export const break_even = guard(break_even_impl);
export const compare_scenarios = guard(compare_scenarios_impl);
export const list_templates = guard(list_templates_impl);
export const health_check = guard(health_check_impl);

// Exposed for tests / advanced embedding.
export const _internals = { TEMPLATES, resolveInputs, evalMetric, bisectSolve, D };
