# Hosted billing fulfilment review

This source change provisions a persisted API key from a signed paid Checkout event even when the buyer closes before the success-page return. It does not send email: the existing /success?session_id=... route is still the buyer's key-recovery page. Do not advertise automatic key email delivery.

## Review and rollout preconditions

- Keep this change unmerged/undeployed until offline fixtures, existing engine tests, scoped workflow and independent review pass. Account-level CI billing blocks are not a passing check and must not be bypassed.
- No Stripe destination or secret setting is changed here. After a separately reviewed release, preserve customer.subscription.updated/deleted and subscribe this same signed /webhook handler to checkout.session.completed and checkout.session.async_payment_succeeded. PrecisionCalc already subscribed to completed at the audit checkpoint; the other three did not. Verify current settings before any later change.
- Current Stripe session ID/status/mode/app, customer/subscription identity, paid state and configured checkout/subscription prices must agree for fresh provisioning. Existing stored keys with the same current customer/subscription may recover after a legitimate change to another configured plan; the key identifier is preserved. Completed-but-unpaid events do not grant access; delayed success uses the same path. Stale/deleted/foreign permanent rejections are acknowledged without provisioning; upstream/storage failures return500 for retry.
- A stored legacy key is reused only after current authority validation. New keys use HMAC-SHA256 with domain-separated service/session identity and the existing server-only STRIPE_WEBHOOK_SECRET, truncated to160 bits. Concurrent new workers with the same unchanged secret converge on one key identifier. Never publish the secret or derive keys client-side.
- Keep that secret stable during rollout. Rotation/legacy random-key reconciliation requires a separate reviewed migration, especially across overlapping old/new deployments; this PR neither rotates secrets nor claims existing duplicate keys are repaired.
- Cloudflare KV is eventually consistent, not a distributed transaction. Terminal subscription deletion writes a never-cleared revocation tombstone; provisioning and access checks consult it. This provides eventual revocation convergence, not globally immediate consistency. Cross-location lag, secret rotation and deployment overlap need a controlled release check.
- Fixtures use synthetic Stripe sessions/subscriptions, signatures, clock offsets and in-memory KV. Every fetch is intercepted and onlyGET is permitted. They do not prove production webhook-secret agreement, actual paid delivery or email receipt.

Run npm test, python -m pytest tests/test_billing_webhook.py -q, and npm run build in an isolated fresh source snapshot. No production build directory or live account is needed.
