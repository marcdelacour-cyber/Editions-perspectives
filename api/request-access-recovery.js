const crypto = require("node:crypto");
const tls = require("node:tls");


const CATALOGUE = Object.freeze([
  { name: "Le jugement en danse",                 assistant: "judge",      lang: "fr" },
  { name: "Prévoir l’imprévu ?",                  assistant: "competitor", lang: "fr" },
  { name: "Judging in Dance",                     assistant: "judge",      lang: "en" },
  { name: "When the Unexpected Takes the Floor",  assistant: "competitor", lang: "en" },
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

function preferredLang(current, incoming) {
  if (!current) return incoming;
  return current === "fr" || incoming === "fr" ? "fr" : "en";
}


function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function validEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

async function stripeGet(path) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Stripe ${response.status}`);
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
  if (!response.ok) throw new Error(data?.error?.message || `Stripe ${response.status}`);
  return data;
}

function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines = [];

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onTimeout = () => { cleanup(); reject(new Error("SMTP timeout")); };
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

async function expect(socket, allowed) {
  const response = await smtpRead(socket);
  const code = Number(String(response).slice(0, 3));
  if (!allowed.includes(code)) throw new Error(`SMTP ${code}: ${response}`);
  return response;
}

function sendLine(socket, value) {
  socket.write(value + "\r\n");
}

function encodeHeader(text) {
  return `=?UTF-8?B?${Buffer.from(String(text), "utf8").toString("base64")}?=`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendRecoveryEmail(to, url, lang) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !port || !user || !password) throw new Error("Configuration SMTP incomplète.");

  const english = lang === "en";
  const subject = english
    ? "Retrieve your access — Éditions Perspectives"
    : "Retrouver vos accès — Éditions Perspectives";

  const plain = english
    ? [
        "You asked to retrieve the access included with your Éditions Perspectives purchase.",
        "",
        "Open this secure link:",
        url,
        "",
        "This link is valid for 30 minutes.",
        "If you did not request this message, you can ignore it.",
        "",
        "Éditions Perspectives",
      ].join("\r\n")
    : [
        "Vous avez demandé à retrouver les accès inclus avec votre achat auprès des Éditions Perspectives.",
        "",
        "Ouvrez ce lien sécurisé :",
        url,
        "",
        "Ce lien est valable pendant 30 minutes.",
        "Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer ce message.",
        "",
        "Éditions Perspectives",
      ].join("\r\n");

  const safeUrl = escapeHtml(url);
  const html = english
    ? `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#1d1d1d">
         <p>You asked to retrieve the access included with your Éditions Perspectives purchase.</p>
         <p><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Retrieve my access</a></p>
         <p>This secure link is valid for 30 minutes.</p>
         <p>If you did not request this message, you can ignore it.</p>
         <p>Éditions Perspectives</p>
       </body></html>`
    : `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#1d1d1d">
         <p>Vous avez demandé à retrouver les accès inclus avec votre achat auprès des Éditions Perspectives.</p>
         <p><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Retrouver mes accès</a></p>
         <p>Ce lien sécurisé est valable pendant 30 minutes.</p>
         <p>Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer ce message.</p>
         <p>Éditions Perspectives</p>
       </body></html>`;

  const boundary = `ep_${crypto.randomBytes(12).toString("hex")}`;
  const message = [
    `From: ${encodeHeader("Éditions Perspectives")} <${user}>`,
    `To: <${to}>`,
    `Reply-To: <${user}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <recovery-${Date.now()}@editions-perspectives.fr>`,
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

  const socket = tls.connect({host, port, servername: host, rejectUnauthorized: true});
  socket.setTimeout(15000);

  await expect(socket, [220]);
  sendLine(socket, "EHLO editions-perspectives.fr");
  await expect(socket, [250]);

  sendLine(socket, "AUTH LOGIN");
  await expect(socket, [334]);
  sendLine(socket, Buffer.from(user, "utf8").toString("base64"));
  await expect(socket, [334]);
  sendLine(socket, Buffer.from(password, "utf8").toString("base64"));
  await expect(socket, [235]);

  sendLine(socket, `MAIL FROM:<${user}>`);
  await expect(socket, [250]);
  sendLine(socket, `RCPT TO:<${to}>`);
  await expect(socket, [250, 251]);
  sendLine(socket, "DATA");
  await expect(socket, [354]);

  const dotStuffed = message.replace(/(^|\r\n)\./g, "$1..");
  socket.write(dotStuffed + "\r\n.\r\n");
  await expect(socket, [250]);

  sendLine(socket, "QUIT");
  try { await expect(socket, [221]); } catch {}
  socket.end();
}

function baseUrl(req) {
  const configured = String(process.env.SITE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  if (!host) throw new Error("Host indisponible.");
  return `${proto}://${host}`;
}

async function sessionsForEmail(email) {
  const sessions = [];
  let startingAfter = null;

  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams();
    qs.set("limit", "100");
    qs.set("status", "complete");
    qs.set("customer_details[email]", email);
    if (startingAfter) qs.set("starting_after", startingAfter);

    const result = await stripeGet(`/v1/checkout/sessions?${qs.toString()}`);
    sessions.push(...(result.data || []));

    if (!result.has_more || !result.data?.length) break;
    startingAfter = result.data[result.data.length - 1].id;
  }

  return sessions;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ok:false,error:"Method not allowed."});
  }

  const neutral = {
    ok: true,
    message: "Si cette adresse correspond à une commande éligible, un e-mail sera envoyé dans quelques instants."
  };

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ok:false,error:"Configuration Stripe incomplète."});
  }

  const body = parseBody(req) || {};
  const email = validEmail(body.email);
  const requestedLang = body.lang === "en" ? "en" : "fr";
  if (!email) return res.status(200).json(neutral);

  try {
    const sessions = (await sessionsForEmail(email))
      .filter((s) => s.payment_status === "paid" && s.status === "complete")
      .sort((a,b) => Number(b.created || 0) - Number(a.created || 0));

    let anchor = null;
    const access = {judge:null, competitor:null};

    for (const session of sessions) {
      if (access.judge && access.competitor) break;

      const qs = new URLSearchParams();
      qs.set("limit", "100");
      qs.append("expand[]", "data.price.product");

      const items = await stripeGet(
        `/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items?${qs.toString()}`
      );

      let eligible = false;
      for (const item of items.data || []) {
        const product = identifyProduct(item);
        if (!product?.assistant) continue;
        eligible = true;
        access[product.assistant] = preferredLang(access[product.assistant], product.lang);
      }
      if (!anchor && eligible) anchor = session;
    }

    if (!anchor || (!access.judge && !access.competitor)) {
      return res.status(200).json(neutral);
    }

    const now = Math.floor(Date.now()/1000);
    const last = Number(anchor.metadata?.ep_recovery_requested_at || 0);
    if (last && now - last < 60) return res.status(200).json(neutral);

    const token = crypto.randomBytes(32).toString("base64url");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const expires = now + 30*60;

    const accessValue = [
      access.judge ? `judge=${access.judge}` : null,
      access.competitor ? `competitor=${access.competitor}` : null
    ].filter(Boolean).join(";");

    // The language of the recovery email/page follows the language selected
    // by the visitor, not the mix of FR/EN books found in purchase history.
    const uiLang = requestedLang;

    const update = new URLSearchParams();
    update.append("metadata[ep_recovery_hash]", hash);
    update.append("metadata[ep_recovery_exp]", String(expires));
    update.append("metadata[ep_recovery_access]", accessValue);
    update.append("metadata[ep_recovery_requested_at]", String(now));

    await stripePost(`/v1/checkout/sessions/${encodeURIComponent(anchor.id)}`, update);

    const url = new URL("/retrouver-mes-acces.html", baseUrl(req));
    url.searchParams.set("session_id", anchor.id);
    url.searchParams.set("token", token);
    url.searchParams.set("lang", uiLang);

    await sendRecoveryEmail(email, url.toString(), uiLang);
    return res.status(200).json(neutral);
  } catch (error) {
    console.error("Recovery request error:", error?.message || error);
    return res.status(200).json(neutral);
  }
};
