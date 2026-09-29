const ALLOWED_ORIGINS = [
  "https://disabled-comics-site.pages.dev",
  "https://disabledcomics.com",
  "https://www.disabledcomics.com",
  "https://app.macknified.com"
];

const PRODUCTS = {
  "issue-2": { name: "Whirl Wheel Issue #2", unit_amount: 800, currency: "usd", physical: true },
  "starter-bundle": { name: "Whirl Wheel Comic Starter Bundle – Issues #1–2", unit_amount: 1400, currency: "usd", physical: true },
  "shield-sticker": { name: "Bubble-Free Vinyl Sticker – Shield Design", unit_amount: 400, currency: "usd", physical: true },
  "issue-1-hostage": { name: "WHIRL WHEEL ISSUE #1: Hostage", unit_amount: 800, currency: "usd", physical: true },
  "poster": { name: "Poster", unit_amount: 1500, currency: "usd", physical: true },
  "black-shield-mug": { name: "Black shield Mug", unit_amount: 1000, currency: "usd", physical: true },
  "whirl-wheel-sticker": { name: "Vinyl Whirl Wheel Bubble-free stickers", unit_amount: 400, currency: "usd", physical: true },
  "snapback-hat": { name: "Shield flat bill Snapback Hat", unit_amount: 2200, currency: "usd", physical: true },
  "white-shield-mug": { name: "White shield mug", unit_amount: 850, currency: "usd", physical: true },
  "shield-shirt": { name: "Shield Unisex T-Shirt", unit_amount: 1700, currency: "usd", physical: true },
  "shield-hat": { name: "Shield Hat", unit_amount: 2000, currency: "usd", physical: true },
  "issue-1-digital": { name: "Whirl Wheel #1: Hostage Digital Comic", unit_amount: 800, currency: "usd", physical: false },
  "iron-on-patch": { name: "Whirl Wheel 3x3 Iron-On Patch", unit_amount: 300, currency: "usd", physical: true }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") return handleOptions(origin);

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, service: "disabled-comics-checkout" });
      }
      if (url.pathname === "/checkout" && request.method === "POST") return handleCheckout(request, env, origin);
      if (url.pathname === "/webhook" && request.method === "POST") return handleWebhook(request, env);
      if (url.pathname === "/admin/orders" && request.method === "POST") return handleAdminOrders(request, env, origin);
      if (url.pathname === "/admin/ship" && request.method === "POST") return handleMarkShipped(request, env, origin);
      if (url.pathname === "/admin/refund" && request.method === "POST") return handleRefund(request, env, origin);
      return json({ error: "Not found" }, 404, origin);
    } catch (err) {
      console.error(err);
      return json({ error: err?.message || "Server error" }, err?.status || 500, origin);
    }
  }
};

async function handleCheckout(request, env, origin) {
  enforceOrigin(origin);
  const body = await request.json();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: "Cart is empty" }, 400, origin);

  const stripeParams = new URLSearchParams();
  stripeParams.set("mode", "payment");
  stripeParams.set("managed_payments[enabled]", "false");
  stripeParams.set("success_url", env.SUCCESS_URL);
  stripeParams.set("cancel_url", env.CANCEL_URL);
  stripeParams.set("billing_address_collection", "auto");
  stripeParams.set("allow_promotion_codes", "true");

  let needsShipping = false;
  items.forEach((item, index) => {
    const product = PRODUCTS[item.id];
    if (!product) throw new Error(`Unknown product: ${item.id}`);
    const quantity = Math.max(1, Math.min(20, parseInt(item.quantity || 1, 10)));
    stripeParams.set(`line_items[${index}][quantity]`, String(quantity));
    stripeParams.set(`line_items[${index}][price_data][currency]`, product.currency);
    stripeParams.set(`line_items[${index}][price_data][unit_amount]`, String(product.unit_amount));
    stripeParams.set(`line_items[${index}][price_data][product_data][name]`, product.name);
    if (product.physical) needsShipping = true;
  });

  if (needsShipping) stripeParams.set("shipping_address_collection[allowed_countries][0]", "US");
  if (body.customerEmail) stripeParams.set("customer_email", body.customerEmail);
  stripeParams.set("metadata[source]", "disabled-comics-cloudflare");
  stripeParams.set("metadata[fulfillment_status]", "Paid");

  const stripeResponse = await stripePost("/v1/checkout/sessions", stripeParams, env);
  if (!stripeResponse.ok) return json({ error: "Unable to create checkout session", stripeError: stripeResponse.data }, 502, origin);
  return json({ checkoutUrl: stripeResponse.data.url, sessionId: stripeResponse.data.id }, 200, origin);
}

async function handleAdminOrders(request, env, origin) {
  enforceOrigin(origin);
  requireAdmin(request, env);
  const body = await safeJson(request);
  const limit = Math.max(1, Math.min(50, Number(body.limit || 25)));
  const list = await stripeGet(`/v1/checkout/sessions?limit=${limit}`, env);
  if (!list.ok) return json({ error: "Unable to load orders", stripeError: list.data }, 502, origin);

  const orders = [];
  for (const session of list.data.data || []) {
    if (session.payment_status !== "paid") continue;

    const lines = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100`, env);
    const items = (lines.ok ? lines.data.data : []).map(li => ({
      description: li.description,
      quantity: li.quantity,
      amountTotal: li.amount_total,
      currency: li.currency
    }));

    const paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id || "";

    let refundInfo = null;
    if (paymentIntentId) {
      const refundRes = await stripeGet(`/v1/refunds?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=100`, env);
      if (refundRes.ok) {
        const successfulRefunds = (refundRes.data.data || []).filter(r => r.status === "succeeded");
        const refundedAmount = successfulRefunds.reduce((sum, r) => sum + Number(r.amount || 0), 0);
        const latestRefund = successfulRefunds.sort((a, b) => (b.created || 0) - (a.created || 0))[0] || null;

        if (refundedAmount > 0) {
          refundInfo = {
            status: refundedAmount >= Number(session.amount_total || 0) ? "Refunded" : "Partially Refunded",
            amount: refundedAmount,
            id: latestRefund?.id || "",
            refundedAt: latestRefund?.created ? new Date(latestRefund.created * 1000).toISOString() : ""
          };
        }
      }
    }

    orders.push(normalizeOrder(session, items, refundInfo));
  }
  return json({ orders }, 200, origin);
}

async function handleMarkShipped(request, env, origin) {
  enforceOrigin(origin);
  requireAdmin(request, env);
  const body = await safeJson(request);
  const sessionId = String(body.sessionId || "").trim();
  const trackingNumber = String(body.trackingNumber || "").trim();
  if (!sessionId.startsWith("cs_")) return json({ error: "Invalid sessionId" }, 400, origin);

  const now = new Date().toISOString();
  const params = new URLSearchParams();
  params.set("metadata[fulfillment_status]", "Shipped");
  params.set("metadata[shipped_at]", now);
  params.set("metadata[tracking_number]", trackingNumber);

  const updated = await stripePost(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, params, env);
  if (!updated.ok) return json({ error: "Unable to mark shipped", stripeError: updated.data }, 502, origin);

  await appendLedger(updated.data, env, { fulfillmentStatus: "Shipped", trackingNumber, shippedAt: now });
  return json({ ok: true, fulfillmentStatus: "Shipped", trackingNumber, shippedAt: now }, 200, origin);
}

async function handleRefund(request, env, origin) {
  enforceOrigin(origin);
  requireAdmin(request, env);
  const body = await safeJson(request);
  const sessionId = String(body.sessionId || "").trim();
  if (!sessionId.startsWith("cs_")) return json({ error: "Invalid sessionId" }, 400, origin);

  const sessionRes = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, env);
  if (!sessionRes.ok) return json({ error: "Unable to load Stripe session", stripeError: sessionRes.data }, 502, origin);

  const session = sessionRes.data;
  const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!paymentIntent) return json({ error: "No payment intent found for this order" }, 400, origin);

  const refundParams = new URLSearchParams();
  refundParams.set("payment_intent", paymentIntent);
  refundParams.set("metadata[source]", "disabled-comics-admin");
  refundParams.set("metadata[checkout_session]", sessionId);

  const refund = await stripePost("/v1/refunds", refundParams, env, `disabled-comics-refund-${sessionId}`);
  if (!refund.ok) return json({ error: "Refund failed", stripeError: refund.data }, 502, origin);

  const now = new Date().toISOString();
  const meta = new URLSearchParams();
  meta.set("metadata[refund_status]", refund.data.status || "succeeded");
  meta.set("metadata[refund_id]", refund.data.id);
  meta.set("metadata[refunded_at]", now);
  await stripePost(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, meta, env);

  session.metadata = {
    ...(session.metadata || {}),
    refund_status: refund.data.status || "succeeded",
    refund_id: refund.data.id,
    refunded_at: now
  };

  await appendLedger(session, env, {
    refundStatus: refund.data.status || "succeeded",
    refundId: refund.data.id,
    refundedAt: now
  });

  return json({
    ok: true,
    refundId: refund.data.id,
    status: refund.data.status,
    amount: refund.data.amount,
    currency: refund.data.currency
  }, 200, origin);
}

async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("Stripe-Signature");
  if (!signatureHeader) return new Response("Missing Stripe-Signature", { status: 400 });

  const valid = await verifyStripeSignature(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(rawBody);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object;
    const lines = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100`, env);
    await appendLedger(session, env, {
      items: lines.ok ? formatItems(lines.data.data || []) : "",
      paymentStatus: session.payment_status || "paid",
      fulfillmentStatus: session.metadata?.fulfillment_status || "Paid"
    });
  }

  if (event.type === "checkout.session.async_payment_failed") {
    await appendLedger(event.data.object, env, {
      paymentStatus: "failed",
      fulfillmentStatus: "Payment Failed"
    });
  }

  return new Response("ok", { status: 200 });
}

function normalizeOrder(session, items, refundInfo = null) {
  const c = session.customer_details || {};
  const a = session.shipping_details?.address || c.address || {};
  const name = session.shipping_details?.name || c.name || "";

  return {
    orderId: session.metadata?.order_id || session.id,
    sessionId: session.id,
    paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || "",
    created: session.created,
    customerName: name,
    email: c.email || session.customer_email || "",
    phone: c.phone || "",
    address: {
      line1: a.line1 || "",
      line2: a.line2 || "",
      city: a.city || "",
      state: a.state || "",
      postalCode: a.postal_code || "",
      country: a.country || ""
    },
    amountTotal: session.amount_total || 0,
    currency: session.currency || "usd",
    paymentStatus: session.payment_status || "",
    fulfillmentStatus: session.metadata?.fulfillment_status || (session.payment_status === "paid" ? "Paid" : "Pending"),
    trackingNumber: session.metadata?.tracking_number || "",
    shippedAt: session.metadata?.shipped_at || "",
    refundStatus: refundInfo?.status || session.metadata?.refund_status || "Not Refunded",
    refundAmount: refundInfo?.amount || 0,
    refundId: refundInfo?.id || session.metadata?.refund_id || "",
    refundedAt: refundInfo?.refundedAt || session.metadata?.refunded_at || "",
    items
  };
}

async function appendLedger(session, env, overrides = {}) {
  if (!env.ORDER_LEDGER_WEBHOOK_URL) return;

  try {
    const c = session.customer_details || {};
    const a = session.shipping_details?.address || c.address || {};
    const name = session.shipping_details?.name || c.name || "Unknown Customer";
    const email = c.email || session.customer_email || "unknown@disabledcomics.local";
    const phone = c.phone || "0000000000";
    const meta = session.metadata || {};

    const data = {
      OrderID: meta.order_id || session.id,
      SessionID: session.id,
      PaymentIntentID: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || "",
      CustomerName: name,
      Email: email,
      Phone: phone,
      Address1: a.line1 || "",
      Address2: a.line2 || "",
      City: a.city || "",
      State: a.state || "",
      PostalCode: a.postal_code || "",
      Country: a.country || "",
      Items: overrides.items || "",
      Amount: ((session.amount_total || 0) / 100).toFixed(2),
      Currency: String(session.currency || "usd").toUpperCase(),
      PaymentStatus: overrides.paymentStatus || session.payment_status || "",
      FulfillmentStatus: overrides.fulfillmentStatus || meta.fulfillment_status || "Paid",
      TrackingNumber: overrides.trackingNumber ?? meta.tracking_number ?? "",
      ShippedAt: overrides.shippedAt ?? meta.shipped_at ?? "",
      RefundStatus: overrides.refundStatus ?? meta.refund_status ?? "Not Refunded",
      RefundID: overrides.refundId ?? meta.refund_id ?? "",
      RefundedAt: overrides.refundedAt ?? meta.refunded_at ?? "",
      Notes: "",
      RowID: session.id,
      UpdatedAt: new Date().toISOString()
    };

    const payload = { contactName: name, contactEmail: email, contactPhone: phone, data };
    const res = await fetch(env.ORDER_LEDGER_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) console.error("Order ledger webhook failed", res.status, await res.text());
  } catch (err) {
    console.error("Order ledger error", err);
  }
}

function formatItems(lines) {
  return lines.map(li => `${li.description || "Item"} x${li.quantity || 1}`).join(" | ");
}

async function stripeGet(path, env) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function stripePost(path, params, env, idempotencyKey = null) {
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded"
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers,
    body: params.toString()
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

function requireAdmin(request, env) {
  if (!env.REFUND_ADMIN_KEY) {
    const err = new Error("REFUND_ADMIN_KEY is not configured");
    err.status = 500;
    throw err;
  }

  const supplied = request.headers.get("X-Admin-Key") || "";
  if (!timingSafeEqual(supplied, env.REFUND_ADMIN_KEY)) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
}

function enforceOrigin(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) {
    const err = new Error("Origin not allowed");
    err.status = 403;
    throw err;
  }
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function verifyStripeSignature(payload, header, secret) {
  const parts = header.split(",");
  const timestamp = parts.find(part => part.startsWith("t="))?.substring(2);
  const signatures = parts.filter(part => part.startsWith("v1=")).map(part => part.substring(3));
  if (!timestamp || !signatures.length) return false;

  const timestampNumber = Number(timestamp);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`)
  );

  const expectedSignature = Array.from(new Uint8Array(signature))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some(value => timingSafeEqual(value, expectedSignature));
}

function timingSafeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  const len = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

function handleOptions(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) return new Response(null, { status: 403 });

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key",
      "Access-Control-Max-Age": "86400"
    }
  });
}

function json(data, status = 200, origin = null) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }

  return new Response(JSON.stringify(data), { status, headers });
}
