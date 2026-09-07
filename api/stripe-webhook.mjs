import crypto from "node:crypto";
import tls from "node:tls";

const CATALOGUE = Object.freeze([
  { id: "feedback",      name: "Le Feedback en danse",                assistant: null,         lang: "fr" },
  { id: "jugement",      name: "Le jugement en danse",                assistant: "judge",      lang: "fr" },
  { id: "imprevu",       name: "Prévoir l’imprévu ?",                 assistant: "competitor", lang: "fr" },
  { id: "judging_en",    name: "Judging in Dance",                    assistant: "judge",      lang: "en" },
  { id: "unexpected_en", name: "When the Unexpected Takes the Floor", assistant: "competitor", lang: "en" },
]);

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const PRODUCT_BY_NAME = new Map(
  CATALOGUE.map((product) => [normalizeName(product.name), product])
);

function identifyProduct(item) {
  const candidates = [];
  if (typeof item?.price?.product === "object") candidates.push(item.price.product?.name);
  candidates.push(item?.description);

  for (const candidate of candidates) {
    const product = PRODUCT_BY_NAME.get(normalizeName(candidate));
    if (product) return product;
  }
  return null;
}

function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader || !secret) return false;

  const parts = String(signatureHeader).split(",");
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }

  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > toleranceSeconds) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");

  return signatures.some((signature) => {
    try {
      const actualBuffer = Buffer.from(signature, "utf8");
      return actualBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(actualBuffer, expectedBuffer);
    } catch {
      return false;
    }
  });
}

async function stripeGet(path) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Stripe GET ${response.status}: ${data?.error?.message || "unknown error"}`);
  }
  return data;
}

async function stripePost(path, params) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Stripe POST ${response.status}: ${data?.error?.message || "unknown error"}`);
  }
  return data;
}

function smtpReadResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines = [];

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error("SMTP timeout"));
    };

    const onData = (chunk) => {
      buffer += chunk.toString("utf8");

      let idx;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        lines.push(line);

        if (/^\d{3} /.test(line)) {
          cleanup();
          resolve(lines.join("\n"));
          return;
        }
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

async function smtpExpect(socket, allowedCodes) {
  const response = await smtpReadResponse(socket);
  const code = Number(String(response).slice(0, 3));
  if (!allowedCodes.includes(code)) {
    throw new Error(`SMTP ${code}: ${response}`);
  }
  return response;
}

function smtpSendLine(socket, text) {
  socket.write(text + "\r\n");
}

function encodeHeader(text) {
  return `=?UTF-8?B?${Buffer.from(String(text), "utf8").toString("base64")}?=`;
}

function euro(cents) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format((Number(cents) || 0) / 100);
}

async function sendConfirmationEmail({ to, books, amountTotal, sessionId, lang }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;

  if (!host || !port || !user || !password) {
    throw new Error("Configuration SMTP incomplète.");
  }

  const english = lang === "en";
  const subject = english
    ? "Order confirmation — Éditions Perspectives"
    : "Confirmation de commande — Éditions Perspectives";

  const lines = books.length
    ? books.map((book) => `• ${book.name}${book.quantity > 1 ? ` × ${book.quantity}` : ""}`)
    : [english ? "• Your book order" : "• Votre commande de livres"];

  const textBody = english
    ? [
        "Thank you for your order from Éditions Perspectives.",
        "",
        "Books ordered:",
        ...lines,
        "",
        `Amount paid: ${euro(amountTotal)}`,
        `Order reference: ${sessionId}`,
        "",
        "If your order includes an Assistant, access was displayed on the confirmation page after payment.",
        "This email deliberately contains no direct Assistant link.",
        "",
        "Éditions Perspectives",
      ].join("\r\n")
    : [
        "Merci pour votre commande auprès des Éditions Perspectives.",
        "",
        "Livres commandés :",
        ...lines,
        "",
        `Montant payé : ${euro(amountTotal)}`,
        `Référence de commande : ${sessionId}`,
        "",
        "Si votre commande comprend un Assistant, son accès a été affiché sur la page de confirmation après paiement.",
        "Ce courriel ne contient volontairement aucun lien direct vers les Assistants.",
        "",
        "Éditions Perspectives",
      ].join("\r\n");

  const socket = tls.connect({
    host,
    port,
    servername: host,
    rejectUnauthorized: true,
  });

  socket.setTimeout(15000);

  await smtpExpect(socket, [220]);
  smtpSendLine(socket, "EHLO editions-perspectives.fr");
  await smtpExpect(socket, [250]);

  smtpSendLine(socket, "AUTH LOGIN");
  await smtpExpect(socket, [334]);
  smtpSendLine(socket, Buffer.from(user, "utf8").toString("base64"));
  await smtpExpect(socket, [334]);
  smtpSendLine(socket, Buffer.from(password, "utf8").toString("base64"));
  await smtpExpect(socket, [235]);

  smtpSendLine(socket, `MAIL FROM:<${user}>`);
  await smtpExpect(socket, [250]);
  smtpSendLine(socket, `RCPT TO:<${to}>`);
  await smtpExpect(socket, [250, 251]);
  smtpSendLine(socket, "DATA");
  await smtpExpect(socket, [354]);

  const headersAndBody = [
    `From: ${encodeHeader("Éditions Perspectives")} <${user}>`,
    `To: <${to}>`,
    `Reply-To: <${user}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <order-${Date.now()}@editions-perspectives.fr>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    textBody,
  ].join("\r\n");

  const dotStuffed = headersAndBody.replace(/(^|\r\n)\./g, "$1..");
  socket.write(dotStuffed + "\r\n.\r\n");
  await smtpExpect(socket, [250]);

  smtpSendLine(socket, "QUIT");
  try { await smtpExpect(socket, [221]); } catch {}
  socket.end();
}

async function processCheckoutSession(sessionFromEvent) {
  const sessionId = sessionFromEvent?.id;
  if (!sessionId) throw new Error("Checkout Session absente.");

  const session = await stripeGet(
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`
  );

  if (session.payment_status !== "paid" || session.status !== "complete") {
    return { skipped: "payment_not_complete" };
  }

  if (session.metadata?.ep_confirmation_email_sent === "1") {
    return { skipped: "already_sent" };
  }

  const email =
    session.customer_details?.email ||
    session.customer_email;

  if (!email) {
    throw new Error("Aucune adresse e-mail client disponible.");
  }

  const query = new URLSearchParams();
  query.set("limit", "100");
  query.append("expand[]", "data.price.product");

  const lineItems = await stripeGet(
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?${query.toString()}`
  );

  const books = [];
  for (const item of lineItems.data || []) {
    const product = identifyProduct(item);
    if (!product) continue;
    books.push({
      id: product.id,
      name: product.name,
      quantity: Number(item.quantity || 1),
      lang: product.lang,
      assistant: product.assistant,
    });
  }

  const lang =
    session.metadata?.language === "en" ||
    (books.length > 0 && books.every((book) => book.lang === "en"))
      ? "en"
      : "fr";

  await sendConfirmationEmail({
    to: email,
    books,
    amountTotal: session.amount_total,
    sessionId,
    lang,
  });

  const params = new URLSearchParams();
  params.append("metadata[ep_confirmation_email_sent]", "1");
  params.append("metadata[ep_confirmation_email_sent_at]", new Date().toISOString());

  await stripePost(
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    params
  );

  return { sent: true, email };
}

export async function POST(request) {
  if (
    !process.env.STRIPE_SECRET_KEY ||
    !process.env.STRIPE_WEBHOOK_SECRET
  ) {
    return Response.json(
      { ok: false, error: "Configuration Stripe incomplète." },
      { status: 500 }
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (
    !verifyStripeSignature(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  ) {
    return Response.json(
      { ok: false, error: "Signature Stripe invalide." },
      { status: 400 }
    );
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json(
      { ok: false, error: "Payload JSON invalide." },
      { status: 400 }
    );
  }

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const result = await processCheckoutSession(event.data?.object);
      return Response.json({ ok: true, result });
    }

    return Response.json({ ok: true, ignored: event.type });
  } catch (error) {
    console.error("Stripe webhook error:", error?.message || error);
    return Response.json(
      { ok: false, error: "Traitement du webhook impossible." },
      { status: 500 }
    );
  }
}

export function GET() {
  return Response.json(
    { ok: false, error: "POST only." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
