/**
 * Éditions Perspectives — Stripe Checkout verification
 * Robust recognition of purchased books despite typographic differences
 * (apostrophes, accents, punctuation, spacing).
 */

const CATALOGUE = Object.freeze([
  { id: "feedback",      name: "Le Feedback en danse",                   assistant: null,         lang: "fr" },
  { id: "jugement",      name: "Le jugement en danse",                   assistant: "judge",      lang: "fr" },
  { id: "imprevu",       name: "Prévoir l’imprévu ?",                    assistant: "competitor", lang: "fr" },
  { id: "judging_en",    name: "Judging in Dance",                       assistant: "judge",      lang: "en" },
  { id: "unexpected_en", name: "When the Unexpected Takes the Floor",    assistant: "competitor", lang: "en" },
]);

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")      // accents
    .replace(/[’‘`´]/g, "'")              // apostrophes
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")         // punctuation
    .replace(/'/g, "")                    // ignore apostrophes entirely
    .replace(/\s+/g, " ")
    .trim();
}

const PRODUCT_BY_NORMALIZED_NAME = new Map(
  CATALOGUE.map(product => [normalizeName(product.name), product])
);

function safeSessionId(value) {
  const id = String(value || "").trim();
  return /^cs_(?:test|live)_[A-Za-z0-9]+$/.test(id) ? id : null;
}

function preferredLang(current, incoming) {
  if (!current) return incoming;
  return current === "fr" || incoming === "fr" ? "fr" : "en";
}

function identifyProduct(item) {
  const candidates = [];

  if (typeof item?.price?.product === "object") {
    candidates.push(item.price.product?.name);
  }
  candidates.push(item?.description);

  for (const candidate of candidates) {
    const product = PRODUCT_BY_NORMALIZED_NAME.get(normalizeName(candidate));
    if (product) return product;
  }

  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Payment verification is not configured."
    });
  }

  const sessionId = safeSessionId(req.query?.session_id);
  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: "Invalid Checkout Session."
    });
  }

  try {
    const qs = new URLSearchParams();
    qs.append("expand[]", "line_items.data.price.product");

    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?${qs.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        },
      }
    );

    const session = await stripeResponse.json();

    if (!stripeResponse.ok) {
      console.error("Stripe session verification error:", {
        status: stripeResponse.status,
        type: session?.error?.type,
        code: session?.error?.code,
      });
      return res.status(404).json({
        ok: false,
        error: "Checkout Session not found."
      });
    }

    const paid =
      session.payment_status === "paid" &&
      session.status === "complete";

    if (!paid) {
      return res.status(402).json({
        ok: false,
        paid: false,
        error: "Payment is not confirmed."
      });
    }

    const books = [];
    const access = { judge: null, competitor: null };

    for (const item of session.line_items?.data || []) {
      const product = identifyProduct(item);
      if (!product) continue;

      books.push({
        id: product.id,
        name: product.name,
        quantity: Number(item.quantity || 1),
        lang: product.lang,
      });

      if (product.assistant) {
        access[product.assistant] = preferredLang(
          access[product.assistant],
          product.lang
        );
      }
    }

    return res.status(200).json({
      ok: true,
      paid: true,
      books,
      access,
    });
  } catch (error) {
    console.error(
      "Order access verification error:",
      error?.message || error
    );
    return res.status(500).json({
      ok: false,
      error: "Unable to verify the payment at this time."
    });
  }
};
