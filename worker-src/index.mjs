// ScenarioSim MCP — Cloudflare Pages Function (_worker.js advanced mode).
//
// Serves a live remote MCP server over Streamable HTTP at /mcp with tiered
// metering + Stripe billing, a /checkout + /success + /portal + /webhook flow,
// a usage endpoint at /metrics, and the static landing site for all other paths.
//
// The simulation engine itself is 100% stateless and deterministic. Billing/quota
// state lives only in Cloudflare KV (env.SCENARIOSIM_KV) and never affects the
// simulation math — identical inputs always produce identical results.
//
// If no KV namespace is bound (self-host / local dev), the server "fails open":
// every request is treated as the free tier with quota disabled. To run a fully
// private self-hosted copy, simply don't bind KV and don't set Stripe secrets.
import * as T from "./engine.mjs";
import { ScenarioError, errEnvelope } from "./engine.mjs";
import * as B from "./billing.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "ScenarioSim", version: "1.0.0-edge" };

// Reusable JSON-schema fragments.
const str = { type: "string" };
const num = { type: "number" };
const int = { type: "integer" };
const assumptionsSchema = {
  type: "object",
  description:
    "Scenario assumptions as {name: value}. Which keys are valid depends on the template (call list_templates). Unlisted keys fall back to documented defaults; unknown keys are ignored and reported in notes. You may also pass assumptions at the top level.",
};
const metricsSchema = {
  type: "array",
  description:
    "For a CUSTOM free-form scenario (template omitted or 'custom'): a list of independently-growing metrics. Each: {name, start, growth_rate (per period, default 0), mode: 'compound' (default) | 'linear'}.",
  items: {
    type: "object",
    properties: { name: str, start: num, growth_rate: num, mode: { type: "string", enum: ["compound", "linear"], default: "compound" } },
    required: ["name", "start"],
  },
};
const horizonSchema = { type: "integer", description: "Number of periods to project forward (1..1200). Default depends on template (usually 12).", default: 12 };
const periodLabelSchema = { type: "string", enum: ["day", "week", "month", "quarter", "year"], default: "month", description: "Label for each period; also sets annualization (periods/year)." };
const templateSchema = {
  type: "string",
  description:
    "Pre-built scenario template id: saas_growth, pricing_change, churn_impact, cost_reduction, hiring_plan, cash_runway, unit_economics, marketing_funnel, compound_growth (aliases like 'saas','pricing','runway','ltv' also resolve). Omit (or use 'custom') to run a free-form 'metrics' projection.",
};

const TOOLS = {
  run_scenario: {
    description:
      "Main simulation tool. Run a deterministic what-if projection from a pre-built template (saas_growth, pricing_change, churn_impact, cost_reduction, hiring_plan, cash_runway, unit_economics, marketing_funnel, compound_growth) OR a free-form 'metrics' model. Returns period-by-period projections, headline key_results, the exact assumptions used (with defaults filled in), the methodology, notes, and a plain-language explanation. Pass 'template' + 'inputs' (assumptions), plus optional 'horizon' and 'period_label'. 100% deterministic (40-digit decimal math).",
    inputSchema: {
      type: "object",
      properties: { template: templateSchema, inputs: assumptionsSchema, metrics: metricsSchema, horizon: horizonSchema, period_label: periodLabelSchema },
    },
    handler: (a) => T.run_scenario(a),
  },
  sensitivity_analysis: {
    description:
      "Vary one or more input assumptions and show the impact on a target output metric (one-at-a-time sensitivity). Provide 'template', the input to sweep via 'variable' (or 'variables' array), and 'target_metric' (defaults to the template's primary output). Control the sweep with 'variation' (fractional +/- around the baseline, default 0.2), 'steps' (default 5), or explicit 'values' / 'min'+'max'. Returns per-variable sweeps, an elasticity estimate, the output range, and a ranking of the most influential inputs.",
    inputSchema: {
      type: "object",
      properties: {
        template: templateSchema,
        inputs: assumptionsSchema,
        target_metric: { type: "string", description: "Output metric to track (see a template's 'outputs' via list_templates). Defaults to the template's primary output." },
        variable: { type: "string", description: "A single input name to sweep." },
        variables: {
          type: "array",
          description: "Multiple inputs to sweep (one at a time). Each: {name, variation?|values?|min?+max?, steps?}.",
          items: { type: "object", properties: { name: str, variation: num, steps: int, values: { type: "array", items: num }, min: num, max: num }, required: ["name"] },
        },
        variation: { type: "number", default: 0.2, description: "Fractional sweep around the baseline (0<v<=1). 0.2 = +/-20%." },
        steps: { type: "integer", default: 5, description: "Number of sweep points per variable (2-200)." },
        values: { type: "array", items: num, description: "Explicit sweep values for a single 'variable'." },
        min: { type: "number", description: "Sweep lower bound (with 'max')." },
        max: { type: "number", description: "Sweep upper bound (with 'min')." },
        horizon: horizonSchema,
        period_label: periodLabelSchema,
      },
      required: ["template"],
    },
    handler: (a) => T.sensitivity_analysis(a),
  },
  break_even: {
    description:
      "Solve for the input value required to make an output metric hit a target value (deterministic bisection root-finding). Provide 'template', 'solve_for' (the input to solve), 'target_metric' (defaults to the primary output), and 'target_value'. Optionally pass 'bounds' [low, high] to constrain the search. Returns the required input value, the change from baseline, the achieved metric, and the residual. Assumes the metric is monotonic in the solved input over the range.",
    inputSchema: {
      type: "object",
      properties: {
        template: templateSchema,
        inputs: assumptionsSchema,
        solve_for: { type: "string", description: "Name of the input variable to solve for." },
        target_metric: { type: "string", description: "Output metric to hit (defaults to the template's primary output)." },
        target_value: { type: "number", description: "The value the target_metric should reach." },
        bounds: { type: "array", items: num, description: "Optional [low, high] search range for the solved input. Auto-derived + expanded if omitted." },
        horizon: horizonSchema,
        period_label: periodLabelSchema,
      },
      required: ["template", "solve_for", "target_value"],
    },
    handler: (a) => T.break_even(a),
  },
  compare_scenarios: {
    description:
      "Run 2-3 scenarios and compare their key_results side by side, with deltas against the first (baseline) scenario. Provide a 'scenarios' array where each entry is {name?, template, inputs} (each may set its own horizon, or pass a shared top-level 'horizon'). Optionally rank on 'compare_metric' with 'goal' ('max' default | 'min') to pick a winner, and set include_projections:true to also return per-period series.",
    inputSchema: {
      type: "object",
      properties: {
        scenarios: {
          type: "array",
          description: "2-3 scenarios to compare. Each: {name?, template, inputs, horizon?, period_label?} or {name?, metrics:[...]} for a custom model.",
          items: { type: "object", properties: { name: str, template: templateSchema, inputs: assumptionsSchema, metrics: metricsSchema, horizon: horizonSchema, period_label: periodLabelSchema } },
        },
        compare_metric: { type: "string", description: "Metric to rank scenarios on (optional)." },
        goal: { type: "string", enum: ["max", "min"], default: "max", description: "Whether higher (max) or lower (min) is better for compare_metric." },
        horizon: { type: "integer", description: "Optional shared horizon applied to scenarios that don't set their own." },
        include_projections: { type: "boolean", default: false, description: "Include each scenario's full per-period projections." },
      },
      required: ["scenarios"],
    },
    handler: (a) => T.compare_scenarios(a),
  },
  list_templates: {
    description:
      "Discovery tool: list every pre-built scenario template (id, label, category, description, primary output, documented inputs with defaults/units, and available output metrics), plus how to run a custom free-form scenario and the supported period labels. No required parameters.",
    inputSchema: { type: "object", properties: {} },
    handler: () => T.list_templates(),
  },
  health_check: {
    description: "Server health, version, and capabilities (tools, templates, period labels, max horizon). No parameters.",
    inputSchema: { type: "object", properties: {} },
    handler: () => T.health_check(),
  },
};

// ScenarioSim has no paid-only tools; paid plans only raise the daily quota.
// To make a tool paid-only, add its name here and gate on ctx.plan === "free".
const PAID_ONLY_TOOLS = new Set();

// Dispatch one tool with uniform error handling — exceptions never escape.
async function runTool(name, args) {
  const spec = TOOLS[name];
  if (!spec) return errEnvelope(`Unknown tool '${name}'.`, "unknown_tool", `Available: ${Object.keys(TOOLS).join(", ")}.`);
  try { return await spec.handler(args || {}); }
  catch (e) {
    if (e instanceof ScenarioError) return errEnvelope(e.message, e.type, e.hint);
    return errEnvelope(`Unexpected error: ${e.message}`, "internal_error", "Verify the shape/types of your inputs against the tool schema.");
  }
}

const meter = { total: 0, rejected: 0, byTool: {}, started: 0 };

// ---- JSON-RPC with metering/gating context ---------------------------------
async function handleRpc(msg, ctx, env) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  if (method === "notifications/initialized") return null;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list")
    return reply(id, { tools: Object.entries(TOOLS).map(([name, s]) => ({ name, description: s.description, inputSchema: s.inputSchema })) });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!TOOLS[name]) return rpcError(id, -32602, `Unknown tool '${name}'.`);

    // Auth-state gating (revoked / invalid keys).
    if (ctx.plan === "revoked" || ctx.plan === "invalid_key") {
      meter.rejected++;
      return toolResult(id, B.upsell(env, ctx.plan, { tool: name }));
    }
    // Paid-only tool gating on the free tier (none by default).
    if (ctx.plan === "free" && PAID_ONLY_TOOLS.has(name)) {
      meter.rejected++;
      return toolResult(id, B.upsell(env, "upgrade_required", { tool: name }));
    }
    // Quota.
    const q = await B.consumeQuota(env, ctx.identity, ctx.limit);
    if (!q.allowed) {
      meter.rejected++;
      return toolResult(id, B.upsell(env, "quota_exceeded", { tool: name, usage: { plan: ctx.plan, used: q.used, limit: q.limit, remaining: 0, resets: "daily 00:00 UTC" } }));
    }
    meter.total++; meter.byTool[name] = (meter.byTool[name] || 0) + 1;
    const result = await runTool(name, args);
    if (result && typeof result === "object") result.quota = { plan: ctx.plan, used: q.used, limit: q.limit, remaining: q.remaining };
    return toolResult(id, result);
  }
  if (typeof id === "undefined" || id === null) return null; // notification
  return rpcError(id, -32601, `Method not found: ${method}`);
}
function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolResult(id, obj) {
  return reply(id, { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError: obj?.status === "error" });
}

// ---- HTTP ------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, x-api-key, mcp-session-id, mcp-protocol-version, accept",
  "Access-Control-Expose-Headers": "mcp-session-id",
};
function sse(obj, extra = {}) {
  return new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "mcp-session-id": "scenariosim-stateless", ...CORS, ...extra },
  });
}
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
function redirect(url) { return new Response(null, { status: 302, headers: { Location: url, ...CORS } }); }
function html(body, status = 200) { return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } }); }

function successPage(key, plan, reused) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScenarioSim — your API key</title><style>
body{margin:0;background:#0b0f1a;color:#e7ecf5;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial;line-height:1.6}
.wrap{max-width:680px;margin:0 auto;padding:56px 20px}a{color:#63a4ff}
.k{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0e1424;border:1px solid #20293f;border-radius:12px;padding:16px;font-size:16px;word-break:break-all;color:#7ae0c6}
.btn{cursor:pointer;background:#7ae0c6;color:#06231a;font-weight:700;border:0;border-radius:9px;padding:9px 14px;margin-top:12px}
pre{background:#0e1424;border:1px solid #20293f;border-radius:12px;padding:14px;overflow:auto;font-size:13px;color:#d7e2ff}
.badge{display:inline-block;color:#7ae0c6;border:1px solid #20293f;border-radius:999px;padding:4px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.1em}
</style></head><body><div class="wrap">
<span class="badge">Payment successful · ${plan} plan</span>
<h1>🎉 Your ScenarioSim API key</h1>
<p>Save this now — it's shown once. Send it as the <code>X-API-Key</code> header (or <code>Authorization: Bearer</code>).</p>
<div class="k" id="key">${key}</div>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('key').innerText);this.textContent='Copied ✓'">Copy key</button>
${reused ? '<p style="color:#ffcf6b">(This session was already provisioned; same key returned.)</p>' : ""}
<h3>Use it</h3>
<pre>{
  "mcpServers": {
    "scenariosim": {
      "url": "https://scenariosim-mcp.pages.dev/mcp",
      "headers": { "X-API-Key": "${key}" }
    }
  }
}</pre>
<p><a href="/#pricing">← Back to ScenarioSim</a> · <a href="/portal?key=${key}">Manage billing</a></p>
</div></body></html>`;
}

export default {
  async fetch(request, env) {
    if (!meter.started) meter.started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Google Search Console site verification (served directly, HTTP 200).
    if (path === "/googledce1e0dc1be5381e.html")
      return new Response("google-site-verification: googledce1e0dc1be5381e.html", {
        status: 200, headers: { "Content-Type": "text/html; charset=utf-8" },
      });

    // ---- Billing routes ----
    if (path === "/checkout") {
      const plan = (url.searchParams.get("plan") || "starter").toLowerCase();
      if (plan !== "starter" && plan !== "pro") return html("<p>Unknown plan. <a href='/#pricing'>See pricing</a>.</p>", 400);
      try { return redirect(await B.createCheckout(env, plan)); }
      catch (e) { return html(`<p>Checkout error: ${e.message}. <a href="/#pricing">Back</a></p>`, 500); }
    }
    if (path === "/success") {
      const sid = url.searchParams.get("session_id");
      if (!sid) return html("<p>Missing session id. <a href='/#pricing'>Back</a></p>", 400);
      try { const p = await B.provisionFromSession(env, sid); return html(successPage(p.key, p.plan, p.reused)); }
      catch (e) { return html(`<p>Could not verify payment yet: ${e.message}. If you just paid, refresh in a moment. <a href="/#pricing">Back</a></p>`, 402); }
    }
    if (path === "/portal") {
      const key = url.searchParams.get("key") || request.headers.get("x-api-key");
      try { return redirect(await B.createPortal(env, key)); }
      catch (e) { return html(`<p>${e.message} <a href="/#pricing">Back</a></p>`, 400); }
    }
    if (path === "/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const payload = await request.text();
      const ok = await B.verifyStripeSignature(env, payload, request.headers.get("stripe-signature"));
      if (!ok) return json({ error: "invalid signature" }, 400);
      try { await B.handleWebhookEvent(env, JSON.parse(payload)); } catch (_) {}
      return json({ received: true });
    }

    if (path === "/metrics")
      return json({ status: "success", server: SERVER_INFO, usage: { uptime_seconds: Math.round((Date.now() - meter.started) / 1000), total_calls: meter.total, rejected: meter.rejected, by_tool: meter.byTool } });

    // ---- MCP over Streamable HTTP ----
    if (path === "/mcp" || path === "/mcp/") {
      if (request.method === "GET") return new Response("Method Not Allowed (no server-initiated stream)", { status: 405, headers: CORS });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
      let payload;
      try { payload = await request.json(); }
      catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: body must be valid JSON-RPC." } }, 400); }

      const who = await B.identify(request, env);
      const limits = B.planLimits(env);
      who.limit = who.plan === "pro" ? limits.pro : who.plan === "starter" ? limits.starter : limits.free;

      if (Array.isArray(payload)) {
        const out = [];
        for (const m of payload) { const r = await handleRpc(m, who, env); if (r) out.push(r); }
        return out.length ? sse(out) : new Response(null, { status: 202, headers: CORS });
      }
      const resp = await handleRpc(payload, who, env);
      if (resp === null) return new Response(null, { status: 202, headers: CORS });
      return sse(resp);
    }

    // Static landing page + assets.
    return env.ASSETS.fetch(request);
  },
};
