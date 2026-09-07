/**
 * Éditions Perspectives — verifies a Stripe Checkout Session
 * and returns only the book-derived Assistant entitlements.
 *
 * No Assistant URL is hard-coded here: the API returns only
 * entitlement type + preferred language. The thank-you pages
 * link to site-owned intermediary pages.
 */

const PRODUCT_BY_NAME = Object.freeze({
  "Le jugement en danse": { id: "jugement", assistant: "judge", lang: "fr" },
  "Judging in Dance": { id: "judging_en", assistant: "judge", lang: "en" },
  "Prévoir l’imprévu ?": { id: "imprevu", assistant: "competitor", lang: "fr" },
  "When the Unexpected Takes the Floor": { id: "unexpected_en", assistant: "competitor", lang: "en" },
  "Le Feedback en danse": { id: "feedback", assistant: null, lang: "fr" },
});

function safeSessionId(value) {
  const id = String(value || "").trim();
  return /^cs_(?:test|live)_[A-Za-z0-9]+$/.test(id) ? id : null;
}

function preferredLang(current, incoming) {
  if (!current) return incoming;
  // If both editions of the same family were bought, prefer French on
  // the French thank-you page logic; the page can still switch language.
  return current === "fr" || incoming === "fr" ? "fr" : "en";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ ok: false, error: "Payment verification is not configured." });
  }

  const sessionId = safeSessionId(req.query?.session_id);
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "Invalid Checkout Session." });
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
      return res.status(404).json({ ok: false, error: "Checkout Session not found." });
    }

    const paid = session.payment_status === "paid" && session.status === "complete";
    if (!paid) {
      return res.status(402).json({
        ok: false,
        paid: false,
        error: "Payment is not confirmed.",
      });
    }

    const books = [];
    const access = { judge: null, competitor: null };

    for (const item of session.line_items?.data || []) {
      const productName =
        (typeof item?.price?.product === "object" && item.price.product?.name) ||
        item?.description ||
        "";

      const product = PRODUCT_BY_NAME[productName];
      if (!product) continue;

      books.push({
        id: product.id,
        name: productName,
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
    console.error("Order access verification error:", error?.message || error);
    return res.status(500).json({
      ok: false,
      error: "Unable to verify the payment at this time.",
    });
  }
};
