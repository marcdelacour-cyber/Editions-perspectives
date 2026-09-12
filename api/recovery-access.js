const crypto = require("node:crypto");

function safeSessionId(value) {
  const id = String(value || "").trim();
  return /^cs_(?:test|live)_[A-Za-z0-9]+$/.test(id) ? id : null;
}

function safeToken(value) {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9_-]{40,100}$/.test(token) ? token : null;
}

async function stripeGet(path) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const data = await response.json();
  return response.ok ? data : null;
}

function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(String(a), "hex");
    const bb = Buffer.from(String(b), "hex");
    return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function parseAccess(value) {
  const access = {judge:null, competitor:null};
  for (const part of String(value || "").split(";")) {
    const [key, lang] = part.split("=", 2);
    if ((key === "judge" || key === "competitor") && (lang === "fr" || lang === "en")) {
      access[key] = lang;
    }
  }
  return access;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ok:false,error:"Method not allowed."});
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ok:false,error:"Configuration Stripe incomplète."});
  }

  const sessionId = safeSessionId(req.query?.session_id);
  const token = safeToken(req.query?.token);
  if (!sessionId || !token) {
    return res.status(400).json({ok:false,error:"Lien invalide."});
  }

  const session = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!session || session.payment_status !== "paid" || session.status !== "complete") {
    return res.status(403).json({ok:false,error:"Lien invalide ou expiré."});
  }

  const expected = String(session.metadata?.ep_recovery_hash || "");
  const expires = Number(session.metadata?.ep_recovery_exp || 0);
  const actual = crypto.createHash("sha256").update(token).digest("hex");

  if (!expected || !safeEqualHex(expected, actual) || !expires || Date.now()/1000 > expires) {
    return res.status(403).json({ok:false,error:"Lien invalide ou expiré."});
  }

  const access = parseAccess(session.metadata?.ep_recovery_access);
  if (!access.judge && !access.competitor) {
    return res.status(403).json({ok:false,error:"Aucun accès éligible."});
  }

  return res.status(200).json({ok:true, access, expires_at:expires});
};
