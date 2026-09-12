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

async function sendConfirmationEmail({ to, books, amountTotal, lang, recoveryUrl }) {
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
    : "Confirmation de votre commande — Éditions Perspectives";

  const lines = books.length
    ? books.map((book) => `• ${book.name}${book.quantity > 1 ? ` × ${book.quantity}` : ""}`)
    : [english ? "• Your book order" : "• Votre commande de livres"];

  const plain = english
    ? [
        "Hello,",
        "",
        "Thank you for your order from Éditions Perspectives.",
        "",
        "Your order",
        ...lines,
        "",
        `Amount paid: ${euro(amountTotal)}`,
        "",
        "Your payment has been successfully recorded.",
        "",
        "If one of the books ordered includes an Assistant, access was offered immediately after payment.",
        "",
        "Lost the access page?",
        `Retrieve your access here: ${recoveryUrl}`,
        "Enter the email address used for your order. If it matches an eligible purchase, you will receive a secure recovery link.",
        "If the message does not appear in your inbox, please check your spam or junk folder.",
        "",
        "For any question about your order, simply reply to this message.",
        "",
        "Thank you and enjoy your reading,",
        "Éditions Perspectives",
      ].join("\r\n")
    : [
        "Bonjour,",
        "",
        "Merci pour votre commande auprès des Éditions Perspectives.",
        "",
        "Votre commande",
        ...lines,
        "",
        `Montant payé : ${euro(amountTotal)}`,
        "",
        "Votre paiement a bien été enregistré.",
        "",
        "Si l’un des ouvrages commandés comprend un Assistant, son accès vous a été proposé immédiatement après le paiement.",
        "",
        "Vous avez perdu la page d’accès à votre Assistant ?",
        `Retrouvez vos accès ici : ${recoveryUrl}`,
        "Saisissez simplement l’adresse e-mail utilisée lors de votre commande. Si elle correspond à un achat éligible, vous recevrez un lien sécurisé permettant de retrouver vos accès.",
        "Si le message n’apparaît pas dans votre boîte de réception, pensez à vérifier vos courriers indésirables / spam.",
        "",
        "Pour toute question concernant votre commande, vous pouvez simplement répondre à ce message.",
        "",
        "Merci et bonne lecture,",
        "Éditions Perspectives",
      ].join("\r\n");

  const escapeHtml = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const safeRecoveryUrl = escapeHtml(recoveryUrl);
  const bookItems = books.length
    ? books.map((book) => `<li>${escapeHtml(book.name)}${book.quantity > 1 ? ` × ${book.quantity}` : ""}</li>`).join("")
    : `<li>${english ? "Your book order" : "Votre commande de livres"}</li>`;

  const html = english
    ? `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#1d1d1d">
        <p>Hello,</p>
        <p>Thank you for your order from <strong>Éditions Perspectives</strong>.</p>
        <p><strong>Your order</strong></p><ul>${bookItems}</ul>
        <p><strong>Amount paid: ${euro(amountTotal)}</strong></p>
        <p>Your payment has been successfully recorded.</p>
        <p>If one of the books ordered includes an <strong>Assistant</strong>, access was offered immediately after payment.</p>
        <p><strong>Lost the access page?</strong></p>
        <p><a href="${safeRecoveryUrl}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Retrieve my access</a></p>
        <p>Enter the email address used for your order. If it matches an eligible purchase, you will receive a secure recovery link.</p>
        <p><strong>If the message does not appear in your inbox, please check your spam or junk folder.</strong></p>
        <p>For any question about your order, simply reply to this message.</p>
        <p>Thank you and enjoy your reading,<br><strong>Éditions Perspectives</strong></p>
      </body></html>`
    : `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#1d1d1d">
        <p>Bonjour,</p>
        <p>Merci pour votre commande auprès des <strong>Éditions Perspectives</strong>.</p>
        <p><strong>Votre commande</strong></p><ul>${bookItems}</ul>
        <p><strong>Montant payé : ${euro(amountTotal)}</strong></p>
        <p>Votre paiement a bien été enregistré.</p>
        <p>Si l’un des ouvrages commandés comprend un <strong>Assistant</strong>, son accès vous a été proposé immédiatement après le paiement.</p>
        <p><strong>Vous avez perdu la page d’accès à votre Assistant ?</strong></p>
        <p><a href="${safeRecoveryUrl}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Retrouver mes accès</a></p>
        <p>Saisissez simplement l’adresse e-mail utilisée lors de votre commande. Si elle correspond à un achat éligible, vous recevrez un lien sécurisé permettant de retrouver vos accès.</p>
        <p><strong>Si le message n’apparaît pas dans votre boîte de réception, pensez à vérifier vos courriers indésirables / spam.</strong></p>
        <p>Pour toute question concernant votre commande, vous pouvez simplement répondre à ce message.</p>
        <p>Merci et bonne lecture,<br><strong>Éditions Perspectives</strong></p>
      </body></html>`;

  const boundary = `ep_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const message = [
    `From: ${encodeHeader("Éditions Perspectives")} <${user}>`,
    `To: <${to}>`,
    `Reply-To: <${user}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <order-${Date.now()}@editions-perspectives.fr>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plain,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${boundary}--`,
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

  const dotStuffed = message.replace(/(^|\r\n)\./g, "$1..");
  socket.write(dotStuffed + "\r\n.\r\n");
  await smtpExpect(socket, [250]);

  smtpSendLine(socket, "QUIT");
  try { await smtpExpect(socket, [221]); } catch {}
  socket.end();
}

async function processCheckoutSession(sessionFromEvent, siteOrigin) {
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
    lang,
    recoveryUrl: `${siteOrigin}/retrouver-mes-acces.html?lang=${lang === "en" ? "en" : "fr"}`,
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
      const siteOrigin = new URL(request.url).origin;
      const result = await processCheckoutSession(event.data?.object, siteOrigin);
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
