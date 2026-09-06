/**
 * Éditions Perspectives — secure Stripe Checkout session creation (v3)
 *
 * The browser sends only internal product references and quantities.
 * Stripe Price IDs, prices and delivery rules remain server-side.
 * This version uses the five Stripe TEST catalogue prices created on 2026-09-06.
 */

const CATALOGUE = Object.freeze({
  feedback: {
    name: "Le Feedback en danse",
    unitAmount: 1800,
    priceId: "price_1UCkEGBLF5IwE45QVtpCbnpI",
    lang: "fr",
    assistant: null,
  },
  jugement: {
    name: "Le jugement en danse",
    unitAmount: 2400,
    priceId: "price_1UCjzvBLF5IwE45Q5BQnFxkU",
    lang: "fr",
    assistant: "judge",
  },
  imprevu: {
    name: "Prévoir l’imprévu ?",
    unitAmount: 3000,
    priceId: "price_1UCk31BLF5IwE45QYxID469w",
    lang: "fr",
    assistant: "competitor",
  },
  judging_en: {
    name: "Judging in Dance",
    unitAmount: 2400,
    priceId: "price_1UCkHJBLF5IwE45Qb0cDXtTZ",
    lang: "en",
    assistant: "judge",
  },
  unexpected_en: {
    name: "When the Unexpected Takes the Floor",
    unitAmount: 3000,
    priceId: "price_1UCkHzBLF5IwE45QMKcA8kI6",
    lang: "en",
    assistant: "competitor",
  },
});

const FREEISH_SHIPPING_THRESHOLD = 3500; // €35.00 of books
const SHIPPING_BELOW_THRESHOLD = 300;    // €3.00
const SHIPPING_FROM_THRESHOLD = 1;       // €0.01
const MAX_QTY_PER_TITLE = 20;
const MAX_TOTAL_BOOKS = 50;

function requestOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return origin.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}`.replace(/\/+$/, "") : null;
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const ownOrigin = host ? `${proto}://${host}` : null;
  return Boolean(ownOrigin && origin === ownOrigin);
}

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function normalizeCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("Panier vide / Empty cart.");
  const quantities = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") throw new Error("Article invalide / Invalid item.");
    const id = String(item.id || "");
    const quantity = Number(item.quantity);
    if (!Object.prototype.hasOwnProperty.call(CATALOGUE, id)) throw new Error("Référence inconnue / Unknown product.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_TITLE) throw new Error("Quantité invalide / Invalid quantity.");
    const newQty = (quantities.get(id) || 0) + quantity;
    if (newQty > MAX_QTY_PER_TITLE) throw new Error("Quantité maximale dépassée / Maximum quantity exceeded.");
    quantities.set(id, newQty);
  }
  const totalBooks = [...quantities.values()].reduce((sum, q) => sum + q, 0);
  if (totalBooks > MAX_TOTAL_BOOKS) throw new Error("Quantité totale maximale dépassée / Maximum total quantity exceeded.");
  return [...quantities.entries()].map(([id, quantity]) => ({ id, quantity }));
}

function addStripeLineItem(params, index, product, quantity) {
  // Use the Stripe catalogue Price ID so Checkout gets the Stripe product name,
  // description and image rather than rebuilding a temporary product via price_data.
  params.append(`line_items[${index}][price]`, product.priceId);
  params.append(`line_items[${index}][quantity]`, String(quantity));
}

function assistantEntitlements(cart) {
  const entitlements = new Set();
  for (const { id } of cart) {
    const assistant = CATALOGUE[id].assistant;
    if (assistant) entitlements.add(assistant);
  }
  return [...entitlements].sort().join(",");
}

module.exports = async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée / Method not allowed." });
  }

  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Origine non autorisée / Origin not allowed." });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Configuration de paiement incomplète / Payment configuration incomplete." });

  try {
    const body = parseBody(req);
    if (!body) return res.status(400).json({ error: "Corps JSON invalide / Invalid JSON body." });
    const cart = normalizeCart(body.items);

    let booksSubtotal = 0;
    for (const { id, quantity } of cart) booksSubtotal += CATALOGUE[id].unitAmount * quantity;
    const shippingAmount = booksSubtotal >= FREEISH_SHIPPING_THRESHOLD ? SHIPPING_FROM_THRESHOLD : SHIPPING_BELOW_THRESHOLD;

    const allEnglish = cart.every(({ id }) => CATALOGUE[id].lang === "en");
    const siteUrl = requestOrigin(req) || (process.env.SITE_URL || "https://editions-perspectives.fr").replace(/\/+$/, "");
    const successUrl = process.env.SUCCESS_URL || `${siteUrl}/${allEnglish ? "merci-en.html" : "merci.html"}?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = process.env.CANCEL_URL || `${siteUrl}/${allEnglish ? "index-en.html?payment=cancelled" : "?paiement=annule"}`;

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("locale", allEnglish ? "en" : "fr");
    params.append("success_url", successUrl);
    params.append("cancel_url", cancelUrl);
    params.append("billing_address_collection", "required");
    params.append("phone_number_collection[enabled]", "true");
    params.append("submit_type", "pay");
    params.append("shipping_address_collection[allowed_countries][0]", "FR");

    cart.forEach(({ id, quantity }, index) => addStripeLineItem(params, index, CATALOGUE[id], quantity));

    params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
    params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(shippingAmount));
    params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "eur");
    params.append("shipping_options[0][shipping_rate_data][display_name]", booksSubtotal >= FREEISH_SHIPPING_THRESHOLD
      ? (allEnglish ? "Delivery — €35 threshold reached" : "Livraison — seuil de 35 € atteint")
      : (allEnglish ? "Delivery" : "Livraison"));

    params.append("metadata[source]", "editions-perspectives.fr");
    params.append("metadata[books_subtotal_cents]", String(booksSubtotal));
    params.append("metadata[shipping_cents]", String(shippingAmount));
    params.append("metadata[language]", allEnglish ? "en" : "fr");
    params.append("metadata[cart]", cart.map(({ id, quantity }) => `${id}:${quantity}`).join("|"));
    params.append("metadata[assistant_entitlements]", assistantEntitlements(cart));

    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const stripeData = await stripeResponse.json();
    if (!stripeResponse.ok) {
      console.error("Stripe error:", {
        status: stripeResponse.status,
        type: stripeData?.error?.type,
        code: stripeData?.error?.code,
        message: stripeData?.error?.message,
      });
      return res.status(502).json({ error: "Impossible de créer la page de paiement / Unable to create payment page." });
    }
    if (!stripeData.url) return res.status(502).json({ error: "Réponse de paiement incomplète / Incomplete payment response." });
    return res.status(200).json({ url: stripeData.url });
  } catch (error) {
    console.error("Checkout error:", error?.message || error);
    return res.status(400).json({ error: error?.message || "Commande invalide / Invalid order." });
  }
};
