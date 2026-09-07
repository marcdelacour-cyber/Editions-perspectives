const tls = require("node:tls");
const crypto = require("node:crypto");

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function clean(value, max) {
  return String(value || "").replace(/\r/g, " ").trim().slice(0, max);
}

function validEmail(value) {
  const email = clean(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function formatReceivedDate(value, locale = "fr-FR") {
  const raw = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || "non renseignée";
  const [y, m, d] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function readResponse(socket) {
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

async function expect(socket, codes) {
  const response = await readResponse(socket);
  const code = Number(String(response).slice(0, 3));
  if (!codes.includes(code)) throw new Error(`SMTP ${code}: ${response}`);
  return response;
}

function sendLine(socket, text) {
  socket.write(text + "\r\n");
}

function enc(text) {
  return `=?UTF-8?B?${Buffer.from(String(text), "utf8").toString("base64")}?=`;
}

async function sendMail({to, subject, body, replyTo}) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !port || !user || !password) throw new Error("Configuration SMTP incomplète.");

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

  const msg = [
    `From: ${enc("Éditions Perspectives")} <${user}>`,
    `To: <${to}>`,
    `Reply-To: <${replyTo || user}>`,
    `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <withdrawal-${Date.now()}-${crypto.randomBytes(5).toString("hex")}@editions-perspectives.fr>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body
  ].join("\r\n");

  socket.write(msg.replace(/(^|\r\n)\./g, "$1..") + "\r\n.\r\n");
  await expect(socket, [250]);

  sendLine(socket, "QUIT");
  try { await expect(socket, [221]); } catch {}
  socket.end();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ok:false,error:"Méthode non autorisée."});
  }

  const body = parseBody(req);
  if (!body) return res.status(400).json({ok:false,error:"Données invalides."});

  // Honeypot: silently accept bot submissions.
  if (clean(body.company, 200)) return res.status(200).json({ok:true});

  const lang = clean(body.lang, 5).toLowerCase() === "en" ? "en" : "fr";
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 100);
  const email = validEmail(body.email);
  const orderDetails = clean(body.orderDetails, 1000);
  const receivedDate = clean(body.receivedDate, 20);
  const receivedDateText = formatReceivedDate(receivedDate, lang === "en" ? "en-GB" : "fr-FR");
  const confirmed = body.confirm === true;

  if (!firstName || !lastName || !email || !orderDetails || !confirmed) {
    return res.status(400).json({
      ok:false,
      error: lang === "en" ? "Please complete all required fields." : "Merci de compléter les champs obligatoires."
    });
  }

  const submittedAt = new Date();
  const submittedFr = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: "Europe/Paris"
  }).format(submittedAt);
  const submittedEn = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: "Europe/Paris"
  }).format(submittedAt);

  const receiptFr = [
    `Bonjour ${firstName} ${lastName},`,
    "",
    "Nous accusons réception de votre déclaration de rétractation adressée aux Éditions Perspectives.",
    "",
    `Date et heure de l'envoi : ${submittedFr}`,
    "",
    "Contenu de votre déclaration :",
    `Nom : ${lastName}`,
    `Prénom : ${firstName}`,
    `Adresse e-mail : ${email}`,
    `Commande concernée : ${orderDetails}`,
    `Date de réception indiquée : ${receivedDateText}`,
    "Décision : je confirme ma volonté de me rétracter de la commande indiquée.",
    "",
    "Retour du livre :",
    "Éditions Perspectives — Marc DELACOUR",
    "4-6 rue des Chauffours",
    "95000 Cergy — France",
    "",
    "Le livre doit être renvoyé dans les délais légaux, correctement emballé. Les frais directs de retour restent à votre charge.",
    "",
    "Conservez ce courriel comme accusé de réception de votre déclaration.",
    "",
    "Éditions Perspectives",
    "contact@editions-perspectives.fr"
  ].join("\r\n");

  const receiptEn = [
    `Hello ${firstName} ${lastName},`,
    "",
    "We acknowledge receipt of your withdrawal declaration sent to Éditions Perspectives.",
    "",
    `Date and time submitted: ${submittedEn} (Paris time)`,
    "",
    "Your declaration:",
    `Last name: ${lastName}`,
    `First name: ${firstName}`,
    `Email address: ${email}`,
    `Order concerned: ${orderDetails}`,
    `Date of receipt stated: ${receivedDateText}`,
    "Decision: I confirm that I wish to withdraw from the order identified above.",
    "",
    "Return address:",
    "Éditions Perspectives — Marc DELACOUR",
    "4-6 rue des Chauffours",
    "95000 Cergy — France",
    "",
    "The book must be returned within the applicable statutory period and properly packaged. Direct return costs remain your responsibility.",
    "",
    "Please keep this email as acknowledgement of receipt of your declaration.",
    "",
    "Éditions Perspectives",
    "contact@editions-perspectives.fr"
  ].join("\r\n");

  const internal = [
    "NOUVELLE DÉCLARATION DE RÉTRACTATION",
    "",
    `Langue du formulaire : ${lang === "en" ? "anglais" : "français"}`,
    `Date et heure : ${submittedFr}`,
    `Nom : ${lastName}`,
    `Prénom : ${firstName}`,
    `E-mail : ${email}`,
    `Commande : ${orderDetails}`,
    `Date de réception indiquée : ${receivedDateText}`,
    "",
    "Le client a confirmé sa volonté de se rétracter.",
  ].join("\r\n");

  try {
    await sendMail({
      to: email,
      subject: lang === "en"
        ? "Acknowledgement of your withdrawal — Éditions Perspectives"
        : "Accusé de réception de votre rétractation — Éditions Perspectives",
      body: lang === "en" ? receiptEn : receiptFr
    });

    await sendMail({
      to: process.env.SMTP_USER || "contact@editions-perspectives.fr",
      subject: `Rétractation — ${firstName} ${lastName}`,
      body: internal,
      replyTo: email
    });

    return res.status(200).json({ok:true});
  } catch (error) {
    console.error("Withdrawal email error:", error?.message || error);
    return res.status(500).json({
      ok:false,
      error: lang === "en"
        ? "Unable to send the acknowledgement email."
        : "Envoi de l'accusé de réception impossible."
    });
  }
};
