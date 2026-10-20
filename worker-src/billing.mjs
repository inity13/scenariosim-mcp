// Billing + metering for the hosted ScenarioSim MCP server.
// - API keys + daily usage counters live in Cloudflare KV (env.SCENARIOSIM_KV).
// - Payments via Stripe Checkout (subscription). Keys are provisioned on the
//   success page and revoked/restored by the subscription webhook.
// Never logs or returns the Stripe secret.
//
// This mirrors DecisionMatrix / PrecisionCalc's billing model 1:1. ScenarioSim
// has no "paid-only" tools — every tool is available on every tier; paid plans
// simply raise the daily call quota. The single gating point is `consumeQuota`.
//
// ===========================================================================
// SELF-HOST / PRIVATE MODE:
//   Leave the KV binding + Stripe secrets unset and the server "fails open" —
//   every request is treated as the free tier with quota disabled. The pure
//   simulation engine needs none of this.
// ===========================================================================

const STRIPE = "https://api.stripe.com/v1";
class CheckoutValidationError extends Error {}
const SV = "2024-06-20"; // pinned Stripe API version (account requires it)

// ---- Stripe REST (form-encoded) --------------------------------------------
async function stripe(env, method, path, params) {
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": SV };
  let body;
  if (params) { body = new URLSearchParams(params).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  const r = await fetch(STRIPE + path, { method, headers, body });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${path} ${r.status}: ${j.error?.message || "error"}`);
  return j;
}

// ---- plan config ------------------------------------------------------------
// NOTE (rate limiting): quotas are enforced per-day in KV. Swap these for a
// sliding-window / token-bucket (Durable Object or Redis) if you need stronger
// consistency or per-minute limits.
export function planLimits(env) {
  return {
    free: parseInt(env.FREE_DAILY || "20", 10),
    starter: parseInt(env.STARTER_DAILY || "5000", 10),
    pro: parseInt(env.PRO_DAILY || "50000", 10),
  };
}
function priceFor(env, plan) { return plan === "pro" ? env.PRICE_PRO : env.PRICE_STARTER; }
function planForPrice(env, priceId) {
  if (!priceId) return null;
  if (priceId === env.PRICE_PRO) return "pro";
  if (priceId === env.PRICE_STARTER) return "starter";
  return null;
}

// ---- identity + quota -------------------------------------------------------
// NOTE (auth): API keys are read from the `X-API-Key` header or a
// `Authorization: Bearer <key>` header. To add a different auth scheme (JWT,
// mTLS, per-org keys) change `extractKey` + `identify` only — the engine and
// transport are untouched.
function extractKey(request) {
  let k = request.headers.get("x-api-key");
  if (!k) { const a = request.headers.get("authorization") || ""; if (a.toLowerCase().startsWith("bearer ")) k = a.slice(7).trim(); }
  return k || null;
}

export async function identify(request, env) {
  const kv = env.SCENARIOSIM_KV;
  const key = extractKey(request);
  if (key && kv) {
    const rec = await kv.get(`key:${key}`, "json");
    if (rec?.subscription && await kv.get(`revoked:${rec.subscription}`)) rec.status = "inactive";
    if (rec && rec.status === "active") {
      return { plan: rec.plan, identity: `key:${key.slice(0, 12)}`, apiKey: key, active: true, customer: rec.customer };
    }
    if (rec && rec.status !== "active") {
      return { plan: "revoked", identity: `key:${key.slice(0, 12)}`, apiKey: key, active: false };
    }
    return { plan: "invalid_key", identity: "invalid", apiKey: key, active: false };
  }
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  return { plan: "free", identity: `ip:${ip}`, apiKey: null, active: true };
}

function todayUTC() { return new Date().toISOString().slice(0, 10); }

// Read-modify-write daily counter in KV (eventually consistent; slight leniency ok).
export async function consumeQuota(env, identity, limit) {
  const kv = env.SCENARIOSIM_KV;
  if (!kv) return { allowed: true, used: 0, limit, remaining: limit }; // no KV bound -> fail open
  const k = `usage:${identity}:${todayUTC()}`;
  const used = parseInt((await kv.get(k)) || "0", 10);
  if (used >= limit) return { allowed: false, used, limit, remaining: 0 };
  await kv.put(k, String(used + 1), { expirationTtl: 172800 }); // 2 days
  return { allowed: true, used: used + 1, limit, remaining: Math.max(0, limit - used - 1) };
}

export async function peekQuota(env, identity, limit) {
  const kv = env.SCENARIOSIM_KV;
  if (!kv) return { used: 0, limit, remaining: limit };
  const used = parseInt((await kv.get(`usage:${identity}:${todayUTC()}`)) || "0", 10);
  return { used, limit, remaining: Math.max(0, limit - used) };
}

// ---- upsell envelope (what an agent sees at the paywall) --------------------
export function upsell(env, kind, ctx = {}) {
  const base = env.SCENARIOSIM_BASE_URL || "https://scenariosim-mcp.pages.dev";
  const L = planLimits(env);
  const messages = {
    quota_exceeded: `Free tier limit reached (${L.free} calls/day). Upgrade for more.`,
    revoked: "This API key is inactive (subscription canceled or unpaid). Renew to continue.",
    invalid_key: "Invalid API key. Purchase a plan to receive a working key.",
    upgrade_required: "This tool requires a paid plan.",
  };
  return {
    status: "error",
    error: {
      type: kind,
      message: messages[kind] || "Upgrade required.",
      hint: "Buy a plan, then send your key as HTTP header 'X-API-Key: <key>'.",
    },
    upgrade: {
      pricing_url: `${base}/#pricing`,
      plans: [
        { name: "Starter", price: "$12/mo", daily_calls: L.starter, checkout_url: `${base}/checkout?plan=starter` },
        { name: "Pro", price: "$39/mo", daily_calls: L.pro, checkout_url: `${base}/checkout?plan=pro` },
      ],
    },
    usage: ctx.usage || null,
  };
}

// ---- checkout + provisioning ------------------------------------------------
export async function createCheckout(env, plan) {
  const price = priceFor(env, plan);
  if (!price) throw new Error("Unknown plan");
  const base = env.SCENARIOSIM_BASE_URL;
  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    allow_promotion_codes: "true",
    success_url: `${base}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/#pricing`,
    "metadata[app]": "scenariosim",
    "metadata[plan]": plan,
    "subscription_data[metadata][app]": "scenariosim",
    "subscription_data[metadata][plan]": plan,
  });
  return session.url;
}

// Stable HMAC-derived identifier makes concurrent first-time provisioning for
// one session converge on one key, even when KV reads miss across isolates.
// Preserve stored legacy keys. Keep the webhook secret stable during rollout;
// secret rotation and legacy-key reconciliation require a separate migration.
async function newKey(env, sessionId) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error("Key derivation is not configured.");
  const enc = new TextEncoder();
  const signingKey = await crypto.subtle.importKey("raw", enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", signingKey, enc.encode(`mcp-session-key:v1:scenariosim:${sessionId}`)));
  const hex = [...bytes.slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ssim_live_${hex}`;
}

// Idempotently provision an API key for a completed checkout session.
// Coalesce concurrent checkout-return/webhook calls within this isolate only.
// Cloudflare KV remains eventually consistent across isolates; this is not a
// distributed transaction or a claim of globally exactly-once provisioning.
const provisioning = new WeakMap();
export async function provisionFromSession(env, sessionId) {
  const kv = env.SCENARIOSIM_KV;
  if (!kv) throw new Error("Billing storage is unavailable.");
  let pending = provisioning.get(kv);
  if (!pending) { pending = new Map(); provisioning.set(kv, pending); }
  if (pending.has(sessionId)) return pending.get(sessionId);
  const task = provisionSession(env, sessionId);
  pending.set(sessionId, task);
  try { return await task; } finally { pending.delete(sessionId); }
}
async function provisionSession(env, sessionId) {
  const kv = env.SCENARIOSIM_KV;
  const existing = await kv.get(`session:${sessionId}`);
  const s = await stripe(env, "GET", `/checkout/sessions/${sessionId}?expand[]=subscription&expand[]=line_items`);
  if (s.id !== sessionId || s.status !== "complete" || s.mode !== "subscription" || s.metadata?.app !== "scenariosim")
    throw new CheckoutValidationError("Checkout session does not belong to this service.");
  if (s.payment_status !== "paid") throw new CheckoutValidationError("Payment not completed for this session.");
  const priceId = s.line_items?.data?.[0]?.price?.id || (await stripe(env, "GET", `/checkout/sessions/${sessionId}/line_items`)).data?.[0]?.price?.id;
  if (!priceId || !planForPrice(env, priceId)) throw new CheckoutValidationError("Checkout price is not configured for this service.");
  const subscription = typeof s.subscription === "object" ? s.subscription
    : s.subscription ? await stripe(env, "GET", `/subscriptions/${encodeURIComponent(s.subscription)}`) : null;
  const customer = typeof s.customer === "object" ? s.customer?.id : s.customer;
  const subscriptionCustomer = typeof subscription?.customer === "object" ? subscription.customer?.id : subscription?.customer;
  if (!subscription?.id || !customer || customer !== subscriptionCustomer)
    throw new CheckoutValidationError("Checkout subscription identity does not match.");
  if (subscription.status !== "active" && subscription.status !== "trialing")
    throw new CheckoutValidationError("Checkout subscription is not active.");
  const subscriptionPrice = subscription.items?.data?.[0]?.price?.id;
  if (subscriptionPrice !== priceId) throw new CheckoutValidationError("Checkout and subscription prices do not match.");
  const plan = planForPrice(env, subscriptionPrice);
  if (!plan) throw new CheckoutValidationError("Subscription price is not configured for this service.");
  const subId = typeof s.subscription === "object" ? s.subscription?.id : s.subscription;
  if (subscription.id !== subId) throw new CheckoutValidationError("Checkout subscription identity does not match.");
  const prior = existing ? await kv.get(`key:${existing}`, "json") : null;
  if (prior && (prior.customer !== customer || prior.subscription !== subId))
    throw new CheckoutValidationError("Existing key identity does not match this checkout.");
  if (await kv.get(`revoked:${subId}`)) throw new CheckoutValidationError("Subscription was deleted.");
  const key = existing || await newKey(env, sessionId);
  const rec = { plan, status: "active", customer, subscription: subId, created: prior?.created || Date.now() };
  // Reserve the recoverable key mapping first: a later KV failure can retry the
  // same key instead of orphaning an already-written key. KV is not a global lock.
  await kv.put(`session:${sessionId}`, key);
  await kv.put(`key:${key}`, JSON.stringify(rec));
  if (subId) await kv.put(`sub:${subId}`, key);
  // Deletion may arrive after our Stripe read but before the mapping is written.
  // A terminal tombstone is never cleared; access checks consult it as well.
  if (await kv.get(`revoked:${subId}`)) {
    rec.status = "inactive";
    await kv.put(`key:${key}`, JSON.stringify(rec));
    throw new CheckoutValidationError("Subscription was deleted.");
  }
  return { key, plan, reused: Boolean(existing) };
}

// ---- webhook (subscription lifecycle -> revoke/restore) ---------------------
export async function verifyStripeSignature(env, payload, sigHeader) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return false;
  const fields = sigHeader.split(",").map((p) => p.trim().split("="));
  const timestamps = fields.filter(([name]) => name === "t").map(([, value]) => value);
  const signatures = fields.filter(([name]) => name === "v1").map(([, value]) => value);
  const t = timestamps[0];
  if (timestamps.length !== 1 || !/^\d+$/.test(t || "")) return false;
  const timestamp = Number(t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  let matched = false;
  for (const value of signatures) {
    if (!/^[0-9a-fA-F]{64}$/.test(value || "")) continue;
    let diff = 0;
    const candidate = value.toLowerCase();
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ candidate.charCodeAt(i);
    matched = matched || diff === 0;
  }
  return matched;
}

export async function handleWebhookEvent(env, event) {
  const kv = env.SCENARIOSIM_KV;
  const type = event.type;
  const obj = event.data?.object || {};
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    // Only this service's paid Checkout can create a key. Re-read current Stripe
    // state in provisionFromSession; a delayed event must not revive a canceled sub.
    if (obj.metadata?.app !== "scenariosim" || obj.payment_status !== "paid") return true;
    if (!obj.id) throw new Error("Checkout event is missing its session id.");
    try { await provisionFromSession(env, obj.id); }
    catch (error) {
      if (!(error instanceof CheckoutValidationError)) throw error;
      // A stale/canceled/unpaid or foreign checkout must never create access;
      // acknowledge permanent rejection, while transient failures still retry.
    }
    return true;
  }
  if (type === "customer.subscription.deleted" || type === "customer.subscription.updated") {
    const subId = obj.id;
    if (type === "customer.subscription.deleted" && subId) await kv.put(`revoked:${subId}`, "true");
    const subscription = type === "customer.subscription.deleted" ? obj
      : await stripe(env, "GET", `/subscriptions/${encodeURIComponent(subId)}`);
    const customer = typeof subscription.customer === "object" ? subscription.customer?.id : subscription.customer;
    const currentPlan = planForPrice(env, subscription.items?.data?.[0]?.price?.id);
    const active = type !== "customer.subscription.deleted" && subscription.id === subId
      && Boolean(currentPlan) && (subscription.status === "active" || subscription.status === "trialing")
      && !(await kv.get(`revoked:${subId}`));
    const key = subId ? await kv.get(`sub:${subId}`) : null;
    if (key) {
      const rec = await kv.get(`key:${key}`, "json");
      if (rec && rec.subscription === subId && rec.customer === customer) { rec.status = active ? "active" : "inactive"; if (active) rec.plan = currentPlan; await kv.put(`key:${key}`, JSON.stringify(rec)); }
    }
  }
  return true;
}

// ---- billing portal ---------------------------------------------------------
export async function createPortal(env, apiKey) {
  const kv = env.SCENARIOSIM_KV;
  const rec = apiKey ? await kv.get(`key:${apiKey}`, "json") : null;
  if (!rec?.customer) throw new Error("Unknown key/customer.");
  const session = await stripe(env, "POST", "/billing_portal/sessions", {
    customer: rec.customer,
    return_url: `${env.SCENARIOSIM_BASE_URL}/#pricing`,
  });
  return session.url;
}
