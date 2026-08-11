#!/usr/bin/env node
// ScenarioSim MCP — local stdio server (self-host / Glama-runnable).
// Dependency-light: wraps the same deterministic engine as the hosted edge
// worker (worker-src/engine.mjs) and speaks MCP over newline-delimited JSON-RPC
// on stdio. No network, no state. Run: `node server.mjs`.
import readline from "node:readline";
import * as T from "./worker-src/engine.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "ScenarioSim", version: "1.0.0" };

const str = { type: "string" };
const num = { type: "number" };
const int = { type: "integer" };
const templateSchema = { type: "string", description: "Template id: saas_growth, pricing_change, churn_impact, cost_reduction, hiring_plan, cash_runway, unit_economics, marketing_funnel, compound_growth. Omit or 'custom' for a free-form 'metrics' model." };
const assumptionsSchema = { type: "object", description: "Scenario assumptions {name:value}; valid keys depend on the template (see list_templates). Unknown keys are ignored. May also be passed at top level." };
const metricsSchema = { type: "array", description: "Custom model: [{name, start, growth_rate?, mode:'compound'|'linear'}].", items: { type: "object", properties: { name: str, start: num, growth_rate: num, mode: { type: "string", enum: ["compound", "linear"] } }, required: ["name", "start"] } };
const horizonSchema = { type: "integer", default: 12, description: "Periods to project (1..1200)." };
const periodLabelSchema = { type: "string", enum: ["day", "week", "month", "quarter", "year"], default: "month" };

const TOOLS = {
  run_scenario: {
    description: "Main simulation tool. Deterministic what-if projection from a template or a free-form 'metrics' model. Returns projections, key_results, assumptions_used, methodology, notes, and a plain-language explanation. 100% deterministic.",
    inputSchema: { type: "object", properties: { template: templateSchema, inputs: assumptionsSchema, metrics: metricsSchema, horizon: horizonSchema, period_label: periodLabelSchema } },
    handler: (a) => T.run_scenario(a),
  },
  sensitivity_analysis: {
    description: "Vary one or more inputs and show the impact on a target output metric (one-at-a-time). Returns per-variable sweeps, elasticity estimates, output ranges, and the most influential inputs.",
    inputSchema: { type: "object", properties: { template: templateSchema, inputs: assumptionsSchema, target_metric: str, variable: str, variables: { type: "array", items: { type: "object" } }, variation: num, steps: int, values: { type: "array", items: num }, min: num, max: num, horizon: horizonSchema, period_label: periodLabelSchema }, required: ["template"] },
    handler: (a) => T.sensitivity_analysis(a),
  },
  break_even: {
    description: "Solve for the input value required to make an output metric reach a target value (bisection). Returns the required input, change from baseline, achieved metric, and residual.",
    inputSchema: { type: "object", properties: { template: templateSchema, inputs: assumptionsSchema, solve_for: str, target_metric: str, target_value: num, bounds: { type: "array", items: num }, horizon: horizonSchema, period_label: periodLabelSchema }, required: ["template", "solve_for", "target_value"] },
    handler: (a) => T.break_even(a),
  },
  compare_scenarios: {
    description: "Run 2-3 scenarios and compare their key_results side by side with deltas vs the first (baseline). Optionally rank on 'compare_metric' with 'goal' (max|min).",
    inputSchema: { type: "object", properties: { scenarios: { type: "array", items: { type: "object" } }, compare_metric: str, goal: { type: "string", enum: ["max", "min"] }, horizon: int, include_projections: { type: "boolean" } }, required: ["scenarios"] },
    handler: (a) => T.compare_scenarios(a),
  },
  list_templates: { description: "List all pre-built scenario templates (inputs, defaults, outputs) plus the custom-scenario format and period labels.", inputSchema: { type: "object", properties: {} }, handler: () => T.list_templates() },
  health_check: { description: "Server health, version, and capabilities.", inputSchema: { type: "object", properties: {} }, handler: () => T.health_check() },
};

function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  if (method === "ping") return reply(id, {});
  if (method === "notifications/initialized" || (method && method.startsWith("notifications/"))) return null;
  if (method === "tools/list") return reply(id, { tools: Object.entries(TOOLS).map(([name, s]) => ({ name, description: s.description, inputSchema: s.inputSchema })) });
  if (method === "tools/call") {
    const name = params?.name; const args = params?.arguments || {};
    const spec = TOOLS[name];
    if (!spec) return rpcError(id, -32602, `Unknown tool '${name}'.`);
    let result;
    try { result = await spec.handler(args); }
    catch (e) { result = T.errEnvelope(`Unexpected error: ${e.message}`, "internal_error"); }
    return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: result?.status === "error" });
  }
  if (id === undefined || id === null) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const res = await handle(msg);
  if (res) process.stdout.write(JSON.stringify(res) + "\n");
});
process.stderr.write("ScenarioSim MCP stdio server ready\n");
