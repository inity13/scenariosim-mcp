# ScenarioSim MCP

A transparent, **100% deterministic** [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server that gives LLM agents a reliable **what-if / scenario simulation** engine.

Agents are good at describing a plan but unreliable at *projecting* it: they drift on
multi-period arithmetic, mishandle compounding, and can't show their work. ScenarioSim
offloads the simulation to an exact, explainable engine. You provide **assumptions**
(growth rates, churn, pricing, costs, starting metrics, a time horizon); it returns
**projected outcomes over time**, **key metrics**, the exact **assumptions used**,
plus **sensitivity analysis** and **break-even** solving — each with a plain-language
explanation.

Every number flows through [`decimal.js`](https://github.com/MikeMcl/decimal.js) at
40-digit precision (**never floats**), so identical inputs always produce
**byte-identical output**. The server is **stateless** — no database, no sessions,
no clocks or randomness in the result.

This is the third product in a suite built to the same engineering standard as
**PrecisionCalc MCP** (deterministic high-precision finance/business math) and
**DecisionMatrix MCP** (transparent multi-criteria decision analysis): identical
project structure, output philosophy, and Cloudflare Pages deployment.

## 🌐 Live hosted server (free, no install)

A public remote MCP server runs on Cloudflare's edge — point any Streamable-HTTP
MCP client at it:

```
https://scenariosim-mcp.pages.dev/mcp
```

```json
{ "mcpServers": { "scenariosim": {
    "type": "http", "url": "https://scenariosim-mcp.pages.dev/mcp" } } }
```

It runs in **open mode** on the free tier (no key, 20 calls/day per IP). Paid plans
(**Starter $12/mo · 5,000/day**, **Pro $39/mo · 50,000/day**) are available via Stripe
Checkout — buy a plan, get an API key instantly, and send it as `X-API-Key`. Self-host
for unlimited calls with no keys. Landing page + pricing: <https://scenariosim-mcp.pages.dev>.

---

## What it does

Six tools, all returning a uniform, agent-parseable envelope:

| Tool | Purpose |
|------|---------|
| `run_scenario` | **Main tool.** Project a pre-built template or a free-form model over time → per-period `projections`, headline `key_results`, the `assumptions_used`, `methodology`, `notes`, and a plain-language `explanation`. |
| `sensitivity_analysis` | Vary one or more inputs (one-at-a-time) and report the impact on a target metric — with an elasticity estimate, the output range, and a ranking of the most influential inputs. |
| `break_even` | Solve for the input value required to make a target metric hit a target value (deterministic bisection). |
| `compare_scenarios` | Run 2–3 scenarios side-by-side with deltas vs a baseline and an optional winner. |
| `list_templates` | Discovery: every template with its inputs (defaults + units) and available outputs. |
| `health_check` | Version, status, and capabilities. |

### Scenario templates

| id | models | primary output |
|----|--------|----------------|
| `saas_growth` | subscribers + MRR/ARR from acquisition (with its own growth) and churn | `ending_mrr` |
| `pricing_change` | revenue/profit impact of a price change via price elasticity | `cumulative_profit_after` |
| `churn_impact` | retention erosion + revenue lost vs a no-churn baseline | `cumulative_revenue_lost` |
| `cost_reduction` | profit + margin impact of cutting costs | `cumulative_savings` |
| `hiring_plan` | headcount, fully-loaded payroll, revenue capacity | `cumulative_payroll` |
| `cash_runway` | cash balance forward + months-to-zero runway | `runway_periods` |
| `unit_economics` | LTV, LTV:CAC, CAC payback, per-customer margin curve | `ltv_cac_ratio` |
| `marketing_funnel` | visitors → leads → customers → revenue | `total_revenue` |
| `compound_growth` | generic single-metric compound/linear projection | `ending_value` |
| `custom` | free-form: any number of independently-growing metrics | *(first metric)* |

Every template accepts `horizon` (number of periods, 1–1200) and `period_label`
(`day`/`week`/`month`/`quarter`/`year`, which also sets annualization). Inputs you don't
provide fall back to documented defaults; unknown inputs are ignored and reported in `notes`.
Call `list_templates` for the full input/output catalog.

### Consistent response envelope

Every **successful** response contains: `status`, `scenario`, `period_label`, `horizon`,
`key_results` (+ `key_results_detail` with units and full-precision `value_exact`),
`projections`, `assumptions_used`, `methodology`, `notes`, and a natural-language
`explanation`.

```json
{
  "status": "success",
  "scenario": "saas_growth",
  "period_label": "month",
  "horizon": 12,
  "key_results": {
    "ending_customers": 449.7, "ending_mrr": 26982.1, "ending_arr": 323785.2,
    "total_churned_customers": 82.4, "cumulative_revenue": 232104.6
  },
  "projections": [
    { "period": 0, "customers": 200, "mrr": 12000, "new_customers": 0, "churned_customers": 0 },
    { "period": 1, "customers": 234, "mrr": 14040, "new_customers": 40, "churned_customers": 6 }
  ],
  "assumptions_used": {
    "template": "saas_growth", "starting_customers": "200", "new_customers_per_period": "40",
    "acquisition_growth_rate": "0", "churn_rate": "0.03", "arpu": "60",
    "horizon": 12, "period_label": "month"
  },
  "methodology": {
    "model": "SaaS Growth",
    "primary_output": "ending_mrr",
    "precision": "decimal.js (40 significant digits)",
    "deterministic": true,
    "period_convention": "Period 0 is the starting state; periods 1..12 are projected. 12 month(s) per year."
  },
  "notes": ["Churn is applied to the prior period's base before new customers are added."],
  "explanation": "Starting from 200 customers and adding 40 per month (churn 3%), after 12 months you reach ..."
}
```

**Errors never cross the tool boundary as exceptions** — they come back as a
structured, actionable envelope:

```json
{
  "status": "error",
  "error": {
    "type": "unknown_template",
    "message": "Unknown scenario template 'saaas'.",
    "hint": "Available templates: saas_growth, pricing_change, churn_impact, cost_reduction, hiring_plan, cash_runway, unit_economics, marketing_funnel, compound_growth. Call list_templates for details ..."
  }
}
```

> **Design note — exact numbers:** headline numbers in `key_results` are
> deterministically rounded (6 dp) for easy consumption; `key_results_detail[].value_exact`
> and `assumptions_used` carry full-precision **strings** so no precision is lost in JSON.
> All internal math is exact 40-digit decimal.

---

## Project structure

```
scenariosim-mcp/
├── worker-src/
│   ├── index.mjs        # Cloudflare Pages Function (_worker.js): MCP over Streamable HTTP + billing routes
│   ├── engine.mjs       # The deterministic simulation engine: 9 templates + 6 tools + solver + validation
│   └── billing.mjs      # Stripe Checkout + KV-backed API keys, quota metering, webhook
├── server.mjs           # Local stdio MCP server (same engine, no network/state)
├── site/
│   ├── index.html       # Static landing / pricing / docs page
│   ├── mcp.json         # Machine-readable connection manifest
│   ├── llms.txt         # LLM-friendly summary
│   └── _worker.js       # Built bundle (esbuild output; git-ignored)
├── tests/
│   └── engine.test.mjs  # 29 core simulation-logic tests (node --test)
├── examples/
│   └── agent_example.mjs # End-to-end MCP client demo over HTTP
├── package.json         # build / deploy / dev / test scripts
├── wrangler.toml        # Cloudflare Pages config
├── .env.example         # Optional auth/rate-limit env reference
├── LICENSE              # MIT
└── README.md
```

**Separation of concerns:** `engine.mjs` is pure and transport-agnostic (import it
directly in tests or any Node/Deno/edge runtime); `index.mjs` only handles the MCP
JSON-RPC wiring, HTTP, CORS, and the auth/metering seam; `server.mjs` re-uses the same
engine over stdio.

---

## Requirements

* Node **18+** (for the build, tests, and local dev). Only two dev/runtime deps:
  `decimal.js` (math) and `esbuild` (bundler).
* A Cloudflare account (free tier is fine) to deploy the hosted version.

---

## Run it locally

```bash
git clone <your-fork> scenariosim-mcp && cd scenariosim-mcp
npm install

# Run the test suite (no server needed)
npm test

# Serve the MCP endpoint locally via Wrangler (builds + runs Pages dev)
npm run dev          # -> http://127.0.0.1:8788/mcp

# Try the end-to-end client demo (hosted by default, or pass a local URL)
node examples/agent_example.mjs
node examples/agent_example.mjs http://127.0.0.1:8788

# Or run the dependency-light stdio server directly
node server.mjs
```

Quick manual call:

```bash
curl -s http://127.0.0.1:8788/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"list_templates","arguments":{}}}'
```

---

## Client configuration

### Cursor — `~/.cursor/mcp.json`
```json
{ "mcpServers": { "scenariosim": {
    "url": "https://scenariosim-mcp.pages.dev/mcp" } } }
```

### Claude Desktop — `claude_desktop_config.json`
Claude Desktop launches stdio servers, so bridge to the HTTP endpoint with `mcp-remote`:
```json
{ "mcpServers": { "scenariosim": {
    "command": "npx", "args": ["-y", "mcp-remote", "https://scenariosim-mcp.pages.dev/mcp"] } } }
```

### VS Code — `.vscode/mcp.json`
```json
{ "servers": { "scenariosim": {
    "type": "http", "url": "https://scenariosim-mcp.pages.dev/mcp" } } }
```

### Windsurf — `~/.codeium/windsurf/mcp_config.json`
```json
{ "mcpServers": { "scenariosim": {
    "serverUrl": "https://scenariosim-mcp.pages.dev/mcp" } } }
```

### Any Streamable-HTTP MCP client
Point it at `https://scenariosim-mcp.pages.dev/mcp` (or your self-hosted URL). If
you enable auth, add `X-API-Key` (or `Authorization: Bearer <key>`) in the client's
`headers`.

---

## Tools & parameters

### `run_scenario(template?, inputs?, metrics?, horizon?, period_label?)`
- **template** — one of the template ids above (aliases like `saas`, `pricing`, `runway`,
  `ltv`, `funnel` also resolve). Omit it (or pass `"custom"`) to run a free-form model.
- **inputs** — the assumptions object for the template, e.g.
  `{ "churn_rate": 0.03, "arpu": 60 }`. Also accepted as `assumptions`, or spread at the
  top level. Missing keys use documented defaults.
- **metrics** — *(custom mode)* array of `{ name, start, growth_rate?, mode? }` where
  `mode` is `"compound"` (default, `x·(1+r)ⁿ`) or `"linear"` (`x·(1+r·n)`).
- **horizon** — number of periods to project (1–1200). Default per template (usually 12).
- **period_label** — `day`/`week`/`month`/`quarter`/`year` (default `month`).

### `sensitivity_analysis(template, variable|variables, target_metric?, variation?, steps?, values?, min?, max?, inputs?, horizon?)`
Sweeps each listed input across a range (default ±`variation`=0.2 around the baseline,
`steps`=5) while all others stay at baseline, recomputing `target_metric` (defaults to the
template's primary output) at each point. Returns per-variable `sweep` rows, an
`elasticity_estimate`, the `output_range`, and a `most_influential` ranking. You can also
give explicit `values: [...]` or a `min`/`max` grid instead of `variation`.

### `break_even(template, solve_for, target_metric?, target_value, bounds?, inputs?, horizon?)`
Solves for the value of `solve_for` (an input name) that makes `target_metric` equal
`target_value`, via deterministic **bisection** with automatic bracket expansion. Returns
`required_input`, `change_from_baseline`, `achieved_metric`, and `residual`. Assumes the
metric is monotonic in the solved input over the search range; if the target can't be
bracketed it returns a clean `no_solution` error with the achievable range. Pass explicit
`bounds: [lo, hi]` to constrain (or fix) the search.

### `compare_scenarios(scenarios, compare_metric?, goal?, horizon?, include_projections?)`
Runs 2–3 `scenarios` (`{ name?, template, inputs }`, or `{ name?, metrics }` for custom)
and aligns their `key_results`, differencing each against the first (baseline). Pass
`compare_metric` + `goal` (`max` default | `min`) to rank and pick a `winner`. Set a shared
`horizon` at the top level, or per-scenario.

### `list_templates()` / `health_check()`
Discovery + status. No parameters.

---

## Example tool-call payloads

Project 12 months of SaaS growth:
```json
{ "name": "run_scenario", "arguments": {
  "template": "saas_growth",
  "inputs": { "starting_customers": 200, "new_customers_per_period": 40,
              "acquisition_growth_rate": 0.05, "churn_rate": 0.03, "arpu": 60 },
  "horizon": 12, "period_label": "month"
} }
```

Which lever moves ending MRR the most?
```json
{ "name": "sensitivity_analysis", "arguments": {
  "template": "saas_growth",
  "inputs": { "starting_customers": 200, "new_customers_per_period": 40, "churn_rate": 0.03, "arpu": 60 },
  "variables": [ { "name": "churn_rate", "variation": 0.5 },
                 { "name": "arpu", "variation": 0.3 },
                 { "name": "new_customers_per_period", "variation": 0.5 } ],
  "target_metric": "ending_mrr", "horizon": 12
} }
```

What churn keeps 90% of customers after a year?
```json
{ "name": "break_even", "arguments": {
  "template": "churn_impact",
  "inputs": { "starting_customers": 1000, "arpu": 60, "new_customers_per_period": 0 },
  "solve_for": "churn_rate", "target_metric": "retention_pct",
  "target_value": 0.9, "horizon": 12
} }
```
→ `required_input ≈ 0.008742` (about 0.87%/month).

Compare growth strategies:
```json
{ "name": "compare_scenarios", "arguments": {
  "scenarios": [
    { "name": "Base",           "template": "saas_growth", "inputs": { "churn_rate": 0.04, "new_customers_per_period": 30 } },
    { "name": "Aggressive",     "template": "saas_growth", "inputs": { "churn_rate": 0.04, "new_customers_per_period": 60 } },
    { "name": "RetentionFocus", "template": "saas_growth", "inputs": { "churn_rate": 0.015, "new_customers_per_period": 30 } }
  ],
  "compare_metric": "ending_mrr", "goal": "max", "horizon": 12
} }
```

Free-form (custom) model:
```json
{ "name": "run_scenario", "arguments": {
  "metrics": [
    { "name": "revenue", "start": 10000, "growth_rate": 0.08, "mode": "compound" },
    { "name": "headcount", "start": 12, "growth_rate": 0.05, "mode": "linear" }
  ],
  "horizon": 12
} }
```

---

## Deploy on Cloudflare Pages

Same pattern as PrecisionCalc / DecisionMatrix — one build step bundles `worker-src/`
into `site/_worker.js` (Pages "advanced mode" Function), then Wrangler deploys the `site/`
directory.

```bash
npm install
npx wrangler login          # once

# Build + deploy in one shot
npm run deploy              # esbuild -> site/_worker.js, then wrangler pages deploy
```

Or wire it to Git: create a Pages project, set the **build command** to `npm run build`
and the **output directory** to `site`. Every push deploys automatically. The
`compatibility_date` and project name live in `wrangler.toml`.

To run **fully free / private**, you need **no bindings, secrets, or env vars** — the
simulation engine is stateless and the server fails open (free tier, quota disabled).

### Enabling billing (optional)

Replicate these for a paid deployment:

1. **KV namespace** for API keys + daily usage counters, bound as `SCENARIOSIM_KV`
   in `wrangler.toml` (`wrangler kv namespace create SCENARIOSIM_KV`).
2. **Stripe products/prices** (subscription) — put the price IDs in `[vars]`
   (`PRICE_STARTER`, `PRICE_PRO`) and the daily limits (`FREE_DAILY`, `STARTER_DAILY`,
   `PRO_DAILY`).
3. **Stripe secrets** (never in the repo):
   ```bash
   wrangler pages secret put STRIPE_SECRET_KEY     --project-name scenariosim-mcp
   wrangler pages secret put STRIPE_WEBHOOK_SECRET  --project-name scenariosim-mcp
   ```
4. **Webhook** → create a Stripe webhook endpoint at `https://<your-domain>/webhook`
   for `customer.subscription.updated` + `customer.subscription.deleted`.

Routes wired up: `/checkout?plan=starter|pro` → Stripe Checkout, `/success` provisions
and shows the API key (idempotent), `/portal` opens the Stripe billing portal,
`/webhook` handles subscription lifecycle (revoke/restore), `/metrics` reports usage.

---

## Auth & rate limiting

The hosted server enforces tiered quotas in `worker-src/billing.mjs`:

* **Identity** — `identify()` reads `X-API-Key` / `Authorization: Bearer`, looks the key
  up in KV, and falls back to per-IP free tier. *(To add JWT/mTLS/per-org keys, change
  `extractKey` + `identify` only — the engine and transport are untouched.)*
* **Quota** — `consumeQuota()` is a KV daily counter (resets 00:00 UTC); the single
  gating point in `handleRpc` where `method === "tools/call"`. *(Swap for a
  sliding-window / token-bucket in a Durable Object or Redis for per-minute limits — see
  the `NOTE (rate limiting)` comment.)*
* **Paywall response** — over-quota / invalid / revoked keys get a structured `upsell`
  envelope with pricing + checkout URLs (agents can read and act on it).
* **Usage metering** — in-memory counters at `/metrics`.

ScenarioSim has **no paid-only tools** — every tool works on every tier; paid plans
only raise the daily quota. To make a tool paid-only, add its name to `PAID_ONLY_TOOLS`
in `index.mjs`. Because the engine is pure and stateless, none of this touches the
simulation logic.

---

## Design decisions & assumptions

* **Deterministic by construction.** 40-digit decimal math, `ROUND_HALF_UP` everywhere,
  period-by-period iteration (not `float**n`), and no clocks/randomness in results.
* **Period 0 is the starting state**; periods `1..horizon` are projected. `period_label`
  sets the annualization factor (`month` → 12/yr, etc.), which is used for ARR/payroll.
* **Assumptions are echoed back in full** (`assumptions_used`) with defaults filled in, so
  a caller always knows exactly what was simulated.
* **Counts stay fractional** for precision (e.g. 233.6 customers); round to integers in
  your presentation layer if needed. This is stated in `notes`.
* **Elasticity/growth models are intentionally simple and transparent** (constant
  elasticity, constant per-period rates). They're honest first-order estimates, not
  econometric forecasts — the methodology block says so.
* **break_even uses bisection** with automatic bracket expansion and a fixed iteration
  budget → deterministic. It assumes monotonicity of the metric in the solved input over
  the range; non-monotonic/ratio metrics (with poles) return a clean `no_solution` rather
  than a wrong root. `sensitivity_analysis`/`break_even` operate on named templates (not
  the free-form `custom` model) and say so if misused.
* **Errors are data, not exceptions** — every tool returns `status:"error"` with a machine
  `type` and an actionable `hint`. Validation covers unknown templates/inputs/metrics,
  non-numeric values, bad horizons/period labels, unreachable targets, and more.
* **Stateless & side-effect-free** — trivially cacheable, horizontally scalable, and safe
  to run anywhere (Cloudflare, Node, Deno, Bun).

---

## Testing

```bash
npm test          # node --test tests/*.test.mjs  (29 tests, no network)
```

The suite pins hand-verifiable arithmetic (compound growth, LTV/CAC, elasticity, runway),
checks determinism, the multiple assumption-input shapes, period-label annualization,
custom free-form models, the sensitivity sweep + influence ranking, the break-even solver
(including the unreachable-target path), scenario comparison with `goal=min`, and every
error path.

---

## Roadmap (post-MVP)

1. More templates: LBO/DCF, inventory & cash-conversion cycle, ad-spend ROAS, cohort retention.
2. Monte-Carlo mode: distributions on inputs → confidence bands on outcomes (seeded, still deterministic).
3. Multi-variable (grid) sensitivity and tornado charts alongside one-at-a-time.
4. Break-even on the free-form `custom` model and on multiple simultaneous inputs.
5. Per-key usage dashboard + Durable-Object quotas for stronger consistency.

## License

MIT — see [LICENSE](./LICENSE).
