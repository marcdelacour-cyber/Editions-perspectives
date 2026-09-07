const tls = require("tls");

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let lines = [];

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

        // SMTP multiline replies use "250-" and end with "250 "
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

async function expect(socket, expectedCodes) {
  const response = await readResponse(socket);
  const code = Number(response.slice(0, 3));
  if (!expectedCodes.includes(code)) {
    throw new Error(`SMTP error ${code}: ${response}`);
  }
  return response;
}

function sendLine(socket, text) {
  socket.write(text + "\r\n");
}

function encodeHeader(text) {
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

async function sendTestEmail() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;

  if (!host || !port || !user || !password) {
    throw new Error("Configuration SMTP incomplète.");
  }

  const socket = tls.connect({
    host,
    port,
    servername: host,
    rejectUnauthorized: true,
  });

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

  sendLine(socket, `RCPT TO:<${user}>`);
  await expect(socket, [250, 251]);

  sendLine(socket, "DATA");
  await expect(socket, [354]);

  const now = new Date();
  const messageId = `<test-${Date.now()}@editions-perspectives.fr>`;
  const body = [
    `From: ${encodeHeader("Éditions Perspectives")} <${user}>`,
    `To: <${user}>`,
    `Subject: ${encodeHeader("Test d’envoi — Éditions Perspectives")}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    `Ceci est un test d’envoi automatique depuis le site Éditions Perspectives.`,
    ``,
    `Si vous recevez ce message, la connexion SMTP IONOS depuis Vercel fonctionne.`,
  ].join("\r\n");

  // Escape any line beginning with "." as required by SMTP DATA.
  const dotStuffed = body.replace(/(^|\r\n)\./g, "$1..");
  socket.write(dotStuffed + "\r\n.\r\n");
  await expect(socket, [250]);

  sendLine(socket, "QUIT");
  try { await expect(socket, [221]); } catch {}
  socket.end();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (process.env.VERCEL_ENV !== "preview") {
    return res.status(403).json({
      ok: false,
      error: "Ce test est autorisé uniquement en environnement Preview."
    });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Méthode non autorisée." });
  }

  try {
    await sendTestEmail();
    return res.status(200).json({
      ok: true,
      message: "E-mail de test envoyé à la boîte contact."
    });
  } catch (error) {
    console.error("SMTP test error:", error?.message || error);
    return res.status(500).json({
      ok: false,
      error: "Échec de l’envoi SMTP.",
      detail: error?.message || "Erreur inconnue"
    });
  }
};
