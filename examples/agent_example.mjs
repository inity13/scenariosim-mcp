// End-to-end ScenarioSim MCP client demo (Streamable HTTP).
//
// Usage:
//   node examples/agent_example.mjs                       # hits the live hosted server
//   node examples/agent_example.mjs http://127.0.0.1:8788 # hits a local `npm run dev`
//
// It performs the MCP handshake, lists tools, then calls run_scenario,
// sensitivity_analysis, break_even, and compare_scenarios and prints the
// structured, agent-friendly results.
const BASE = (process.argv[2] || "https://scenariosim-mcp.pages.dev").replace(/\/$/, "");
const ENDPOINT = `${BASE}/mcp`;

let idc = 0;
async function call(method, params) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params }),
  });
  const text = await res.text();
  // The server replies with a single SSE `data:` frame (or plain JSON).
  const line = text.includes("data: ") ? text.split("data: ")[1].trim() : text.trim();
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(`RPC error: ${msg.error.message}`);
  return msg.result;
}
async function tool(name, args) {
  const r = await call("tools/call", { name, arguments: args });
  return r.structuredContent; // the agent-friendly envelope
}

const rule = (t) => console.log(`\n\x1b[1m== ${t} ==\x1b[0m`);

async function main() {
  console.log(`ScenarioSim MCP demo → ${ENDPOINT}`);

  rule("initialize");
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  console.log(init.serverInfo);

  rule("tools/list");
  const list = await call("tools/list", {});
  for (const t of list.tools) console.log(`• ${t.name}`);

  rule("run_scenario — 12-month SaaS growth");
  const sim = await tool("run_scenario", {
    template: "saas_growth",
    inputs: { starting_customers: 200, new_customers_per_period: 40, acquisition_growth_rate: 0.05, churn_rate: 0.03, arpu: 60 },
    horizon: 12,
    period_label: "month",
  });
  console.log(sim.explanation);
  console.log("Key results:", sim.key_results);
  console.table(sim.projections.filter((p) => p.period % 3 === 0).map((p) => ({ month: p.period, customers: Math.round(p.customers), mrr: Math.round(p.mrr) })));

  rule("sensitivity_analysis — which lever moves ending MRR most?");
  const sa = await tool("sensitivity_analysis", {
    template: "saas_growth",
    inputs: { starting_customers: 200, new_customers_per_period: 40, churn_rate: 0.03, arpu: 60 },
    variables: [{ name: "churn_rate", variation: 0.5 }, { name: "arpu", variation: 0.3 }, { name: "new_customers_per_period", variation: 0.5 }],
    target_metric: "ending_mrr",
    horizon: 12,
  });
  console.log(`Most influential → ${sa.most_influential.join(" > ")}`);
  console.log(sa.explanation);

  rule("break_even — churn needed to keep 90% of customers");
  const be = await tool("break_even", {
    template: "churn_impact",
    inputs: { starting_customers: 1000, arpu: 60, new_customers_per_period: 0 },
    solve_for: "churn_rate",
    target_metric: "retention_pct",
    target_value: 0.9,
    horizon: 12,
  });
  console.log(be.explanation || be.error?.message);

  rule("compare_scenarios — base vs aggressive vs conservative");
  const cmp = await tool("compare_scenarios", {
    scenarios: [
      { name: "Base", template: "saas_growth", inputs: { churn_rate: 0.04, new_customers_per_period: 30 } },
      { name: "Aggressive", template: "saas_growth", inputs: { churn_rate: 0.04, new_customers_per_period: 60 } },
      { name: "RetentionFocus", template: "saas_growth", inputs: { churn_rate: 0.015, new_customers_per_period: 30 } },
    ],
    compare_metric: "ending_mrr",
    goal: "max",
    horizon: 12,
  });
  console.log(`Winner on ending_mrr → ${cmp.winner.name} (${cmp.winner.value})`);
  console.table(cmp.ranking);
}

main().catch((e) => {
  console.error("Demo failed:", e.message);
  process.exit(1);
});
