const ALLOWED_ORIGINS = [
  "https://disabled-comics-site.pages.dev",
  "https://disabledcomics.com",
  "https://www.disabledcomics.com"
];

const PRODUCTS = {
  "issue-2": {
    name: "Whirl Wheel Issue #2",
    unit_amount: 800,
    currency: "usd",
    physical: true
  },

  "starter-bundle": {
    name: "Whirl Wheel Comic Starter Bundle – Issues #1–2",
    unit_amount: 1400,
    currency: "usd",
    physical: true
  },

  "shield-sticker": {
    name: "Bubble-Free Vinyl Sticker – Shield Design",
    unit_amount: 400,
    currency: "usd",
    physical: true
  },

  "issue-1-hostage": {
    name: "WHIRL WHEEL ISSUE #1: Hostage",
    unit_amount: 800,
    currency: "usd",
    physical: true
  },

  "poster": {
    name: "Poster",
    unit_amount: 1500,
    currency: "usd",
    physical: true
  },

  "black-shield-mug": {
    name: "Black shield Mug",
    unit_amount: 1000,
    currency: "usd",
    physical: true
  },

  "whirl-wheel-sticker": {
    name: "Vinyl Whirl Wheel Bubble-free stickers",
    unit_amount: 400,
    currency: "usd",
    physical: true
  },

  "snapback-hat": {
    name: "Shield flat bill Snapback Hat",
    unit_amount: 2200,
    currency: "usd",
    physical: true
  },

  "white-shield-mug": {
    name: "White shield mug",
    unit_amount: 850,
    currency: "usd",
    physical: true
  },

  "shield-shirt": {
    name: "Shield Unisex T-Shirt",
    unit_amount: 1700,
    currency: "usd",
    physical: true
  },

  "shield-hat": {
    name: "Shield Hat",
    unit_amount: 2000,
    currency: "usd",
    physical: true
  },

  "issue-1-digital": {
    name: "Whirl Wheel #1: Hostage Digital Comic",
    unit_amount: 800,
    currency: "usd",
    physical: false
  },

  "iron-on-patch": {
    name: "Whirl Wheel 3x3 Iron-On Patch",
    unit_amount: 300,
    currency: "usd",
    physical: true
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return handleOptions(origin);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "disabled-comics-checkout"
      });
    }

    if (url.pathname === "/checkout" && request.method === "POST") {
      return handleCheckout(request, env, origin);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    return json(
      {
        error: "Not found"
      },
      404
    );
  }
};

async function handleCheckout(request, env, origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return json(
      {
        error: "Origin not allowed"
      },
      403
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        error: "Invalid JSON"
      },
      400,
      origin
    );
  }

  const items = Array.isArray(body.items) ? body.items : [];

  if (!items.length) {
    return json(
      {
        error: "Cart is empty"
      },
      400,
      origin
    );
  }

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

    if (!product) {
      throw new Error(`Unknown product: ${item.id}`);
    }

    const quantity = Math.max(
      1,
      Math.min(
        20,
        parseInt(item.quantity || 1, 10)
      )
    );

    stripeParams.set(
      `line_items[${index}][quantity]`,
      String(quantity)
    );

    stripeParams.set(
      `line_items[${index}][price_data][currency]`,
      product.currency
    );

    stripeParams.set(
      `line_items[${index}][price_data][unit_amount]`,
      String(product.unit_amount)
    );

    stripeParams.set(
      `line_items[${index}][price_data][product_data][name]`,
      product.name
    );

    if (product.physical) {
      needsShipping = true;
    }
  });

  if (needsShipping) {
    stripeParams.set(
      "shipping_address_collection[allowed_countries][0]",
      "US"
    );
  }

  if (body.customerEmail) {
    stripeParams.set(
      "customer_email",
      body.customerEmail
    );
  }

  stripeParams.set(
    "metadata[source]",
    "disabled-comics-cloudflare"
  );

  const stripeResponse = await fetch(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: stripeParams.toString()
    }
  );

  const stripeData = await stripeResponse.json();

if (!stripeResponse.ok) {
  console.error("Stripe error:", stripeData);

  return json(
    {
      error: "Unable to create checkout session",
      stripeError: stripeData
    },
    502,
    origin
  );
}

  return json(
    {
      checkoutUrl: stripeData.url,
      sessionId: stripeData.id
    },
    200,
    origin
  );
}

async function handleWebhook(request, env) {
  const rawBody = await request.text();

  const signatureHeader = request.headers.get(
    "Stripe-Signature"
  );

  if (!signatureHeader) {
    return new Response(
      "Missing Stripe-Signature",
      {
        status: 400
      }
    );
  }

  const valid = await verifyStripeSignature(
    rawBody,
    signatureHeader,
    env.STRIPE_WEBHOOK_SECRET
  );

  if (!valid) {
    return new Response(
      "Invalid signature",
      {
        status: 400
      }
    );
  }

  const event = JSON.parse(rawBody);

  switch (event.type) {
    case "checkout.session.completed":
      console.log(
        "Checkout completed:",
        event.data.object.id
      );
      break;

    case "checkout.session.async_payment_succeeded":
      console.log(
        "Async payment succeeded:",
        event.data.object.id
      );
      break;

    case "checkout.session.async_payment_failed":
      console.log(
        "Async payment failed:",
        event.data.object.id
      );
      break;

    default:
      console.log(
        "Unhandled Stripe event:",
        event.type
      );
  }

  return new Response(
    "ok",
    {
      status: 200
    }
  );
}

async function verifyStripeSignature(
  payload,
  header,
  secret
) {
  const parts = header.split(",");

  const timestamp = parts
    .find(part => part.startsWith("t="))
    ?.substring(2);

  const signatures = parts
    .filter(part => part.startsWith("v1="))
    .map(part => part.substring(3));

  if (!timestamp || !signatures.length) {
    return false;
  }

  const timestampNumber = Number(timestamp);

  if (
    Math.abs(
      Math.floor(Date.now() / 1000) -
      timestampNumber
    ) > 300
  ) {
    return false;
  }

  const signedPayload =
    `${timestamp}.${payload}`;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  const expectedSignature =
    Array.from(new Uint8Array(signature))
      .map(byte =>
        byte
          .toString(16)
          .padStart(2, "0")
      )
      .join("");

  return signatures.some(
    signatureValue =>
      timingSafeEqual(
        signatureValue,
        expectedSignature
      )
  );
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return result === 0;
}

function handleOptions(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, {
      status: 403
    });
  }

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  });
}

function json(
  data,
  status = 200,
  origin = null
) {
  const headers = {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (
    origin &&
    ALLOWED_ORIGINS.includes(origin)
  ) {
    headers["Access-Control-Allow-Origin"] =
      origin;

    headers["Vary"] =
      "Origin";
  }

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers
    }
  );
}
