// Accounts, question balance, Stripe checkout and admin stats.
// Product: one package (PACKAGE_QUESTIONS questions valid PACKAGE_DAYS days) bought once via Stripe
// Checkout, plus FREE_QUESTIONS on signup. Every student message spends one question.
import express from "express";
import Stripe from "stripe";
import { db, sha256, newToken, hashPassword, checkPassword } from "./db.js";

const env = (k, d) => process.env[k] ?? d;
export const FREE_QUESTIONS = Number(env("FREE_QUESTIONS", 5));
export const PACKAGE_QUESTIONS = Number(env("PACKAGE_QUESTIONS", 1000));
export const PACKAGE_DAYS = Number(env("PACKAGE_DAYS", 120));
export const PACKAGE_PRICE = Number(env("PACKAGE_PRICE_AGOROT", 39900)); // 399.00 ₪
const CURRENCY = "ils";
const PUBLIC_URL = env("PUBLIC_URL", "http://localhost:3000");
const ADMIN_EMAILS = env("ADMIN_EMAILS", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
// Demo invites for employers/portfolio: signing up with INVITE_CODE bypasses the allowlist and
// grants INVITE_QUESTIONS, for at most INVITE_MAX accounts (caps what the demo can cost).
const INVITE_CODE = env("INVITE_CODE", "");
const INVITE_QUESTIONS = Number(env("INVITE_QUESTIONS", 20));
const INVITE_MAX = Number(env("INVITE_MAX", 30));
db.exec("CREATE TABLE IF NOT EXISTS invites_used (user_id INTEGER PRIMARY KEY)");

// Before public launch, only these emails may sign up (comma-separated). Empty = open to everyone.
const SIGNUP_ALLOWLIST = env("SIGNUP_ALLOWLIST", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const DAY = 24 * 60 * 60 * 1000;
const SESSION_DAYS = 30;
const COOKIE = "sid";
const SECURE_COOKIE = PUBLIC_URL.startsWith("https://");

// ---------- Sessions ----------
function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function startSession(res, userId) {
  const token = newToken();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    sha256(token), userId, Date.now() + SESSION_DAYS * DAY,
  );
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: SECURE_COOKIE, maxAge: SESSION_DAYS * DAY, path: "/" });
}

// Sets req.user (or leaves it undefined) from the session cookie.
export function loadUser(req, _res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    req.user = db
      .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
      .get(sha256(token), Date.now());
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "يجب تسجيل الدخول أولًا.", code: "login" });
  next();
}

export const isAdmin = (user) => !!user && ADMIN_EMAILS.includes(user.email.toLowerCase());

// ---------- Question balance ----------
// Paid questions expire with access_until; free-trial users have access_until = NULL.
function balance(user) {
  if (isAdmin(user)) return { questionsLeft: Infinity, accessUntil: null, unlimited: true };
  const expired = user.access_until && user.access_until < Date.now();
  return { questionsLeft: expired ? 0 : user.questions_left, accessUntil: user.access_until };
}

// Atomically take one question before answering; false if none left.
export function reserveQuestion(userId) {
  return (
    db
      .prepare("UPDATE users SET questions_left = questions_left - 1 WHERE id = ? AND questions_left > 0 AND (access_until IS NULL OR access_until > ?)")
      .run(userId, Date.now()).changes === 1
  );
}

// Give the question back when the answer failed.
export function refundQuestion(userId) {
  db.prepare("UPDATE users SET questions_left = questions_left + 1 WHERE id = ?").run(userId);
}

export function recordUsage(userId, costUsd) {
  db.prepare("INSERT INTO usage (user_id, cost_usd, created_at) VALUES (?, ?, ?)").run(userId, costUsd, Date.now());
}

// ---------- Email (password reset) ----------
async function sendMail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[mail to ${to}] ${subject}\n${html}`); // development: print instead of sending
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env("MAIL_FROM", "onboarding@resend.dev"), to, subject, html }),
  });
  if (!res.ok) console.error("Resend error", res.status, await res.text());
}

// ---------- Rate limiting for login-type endpoints ----------
const attempts = new Map(); // ip -> [timestamps]
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (attempts.get(req.ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (list.length >= 20) return res.status(429).json({ error: "محاولات كثيرة. حاول بعد ربع ساعة." });
  list.push(now);
  attempts.set(req.ip, list);
  next();
}

const validEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const validPassword = (p) => typeof p === "string" && p.length >= 8 && p.length <= 200;

// ---------- Routes (mounted after express.json) ----------
export const accountRoutes = express.Router();

accountRoutes.post("/api/register", rateLimit, (req, res) => {
  const { email, password, acceptTerms, invite } = req.body || {};
  const invited = !!INVITE_CODE && invite === INVITE_CODE;
  if (!validEmail(email)) return res.status(400).json({ error: "البريد الإلكتروني غير صحيح." });
  if (!validPassword(password)) return res.status(400).json({ error: "كلمة المرور يجب أن تكون ٨ أحرف على الأقل." });
  if (!acceptTerms) return res.status(400).json({ error: "يجب الموافقة على شروط الاستخدام." });
  if (invited && db.prepare("SELECT COUNT(*) n FROM invites_used").get().n >= INVITE_MAX) {
    return res.status(403).json({ error: "انتهت أماكن التجربة المتاحة. تواصل مع صاحب الموقع." });
  }
  if (!invited && SIGNUP_ALLOWLIST.length && !SIGNUP_ALLOWLIST.includes(email.trim().toLowerCase())) {
    return res.status(403).json({ error: "التسجيل غير متاح بعد. الموقع في مرحلة تجربة، وسيُفتح قريبًا." });
  }
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    return res.status(409).json({ error: "هذا البريد مسجّل. سجّل الدخول بدلًا من ذلك." });
  }
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (email, password_hash, questions_left, created_at) VALUES (?, ?, ?, ?)")
    .run(email.trim(), hashPassword(password), invited ? INVITE_QUESTIONS : FREE_QUESTIONS, Date.now());
  if (invited) db.prepare("INSERT INTO invites_used (user_id) VALUES (?)").run(lastInsertRowid);
  startSession(res, lastInsertRowid);
  res.json({ ok: true });
});

accountRoutes.post("/api/login", rateLimit, (req, res) => {
  const { email, password } = req.body || {};
  const user = validEmail(email) && typeof password === "string" ? db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim()) : null;
  if (!user || !checkPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "البريد أو كلمة المرور غير صحيحة." });
  }
  startSession(res, user.id);
  res.json({ ok: true });
});

accountRoutes.post("/api/logout", (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

accountRoutes.get("/api/offer", (_req, res) => {
  res.json({ free: FREE_QUESTIONS, questions: PACKAGE_QUESTIONS, days: PACKAGE_DAYS, price: PACKAGE_PRICE / 100 });
});

accountRoutes.get("/api/me", requireUser, (req, res) => {
  res.json({
    email: req.user.email,
    ...balance(req.user),
    isAdmin: isAdmin(req.user),
    package: { questions: PACKAGE_QUESTIONS, days: PACKAGE_DAYS, price: PACKAGE_PRICE / 100 },
    paymentsEnabled: !!stripe,
  });
});

// Always answers "sent" so the form can't be used to discover which emails have accounts.
accountRoutes.post("/api/forgot", rateLimit, async (req, res) => {
  try {
  const { email } = req.body || {};
  const user = validEmail(email) ? db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim()) : null;
  if (user) {
    const token = newToken();
    db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), user.id, Date.now() + 60 * 60 * 1000);
    const link = `${PUBLIC_URL}/reset.html?token=${token}`;
    await sendMail(user.email, "إعادة تعيين كلمة المرور",
      `<div dir="rtl">لإعادة تعيين كلمة المرور اضغط على الرابط التالي (صالح لمدة ساعة):<br><a href="${link}">${link}</a><br>إذا لم تطلب ذلك، تجاهل هذه الرسالة.</div>`);
    }
  } catch (err) {
    console.error("Password reset email failed:", err.message);
  }
  res.json({ ok: true });
});

accountRoutes.post("/api/reset", rateLimit, (req, res) => {
  const { token, password } = req.body || {};
  if (!validPassword(password)) return res.status(400).json({ error: "كلمة المرور يجب أن تكون ٨ أحرف على الأقل." });
  const row = typeof token === "string"
    ? db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?").get(sha256(token), Date.now())
    : null;
  if (!row) return res.status(400).json({ error: "الرابط غير صالح أو انتهت صلاحيته." });
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), row.user_id);
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").run(row.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id); // log out other devices
  })();
  startSession(res, row.user_id);
  res.json({ ok: true });
});

// Stripe Checkout for the package. The webhook (below) grants the questions.
accountRoutes.post("/api/checkout", requireUser, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "الدفع غير متاح حاليًا." });
  let session;
  try {
    session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY,
        unit_amount: PACKAGE_PRICE,
        product_data: { name: `باقة البسيخومتري — ${PACKAGE_QUESTIONS} سؤال لمدة ${Math.round(PACKAGE_DAYS / 30)} أشهر` },
      },
    }],
    customer_email: req.user.email,
    client_reference_id: String(req.user.id),
    metadata: { user_id: String(req.user.id) },
    success_url: `${PUBLIC_URL}/?paid=1`,
    cancel_url: `${PUBLIC_URL}/?paid=0`,
    });
  } catch (err) {
    console.error("Stripe checkout failed:", err.message);
    return res.status(502).json({ error: "تعذّر فتح صفحة الدفع. حاول بعد قليل." });
  }
  res.json({ url: session.url });
});

accountRoutes.get("/api/admin/stats", requireUser, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "غير مسموح." });
  const since = Date.now() - 30 * DAY;
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  res.json({
    users: one("SELECT COUNT(*) n FROM users").n,
    payingUsers: one("SELECT COUNT(DISTINCT user_id) n FROM purchases").n,
    revenue: (one("SELECT COALESCE(SUM(amount),0) s FROM purchases").s || 0) / 100,
    revenue30d: (one("SELECT COALESCE(SUM(amount),0) s FROM purchases WHERE created_at > ?", since).s || 0) / 100,
    questions: one("SELECT COUNT(*) n FROM usage").n,
    questions30d: one("SELECT COUNT(*) n FROM usage WHERE created_at > ?", since).n,
    apiCostUsd: one("SELECT COALESCE(SUM(cost_usd),0) s FROM usage").s,
    apiCostUsd30d: one("SELECT COALESCE(SUM(cost_usd),0) s FROM usage WHERE created_at > ?", since).s,
    recentPurchases: db.prepare("SELECT u.email, p.amount / 100.0 AS amount, p.created_at FROM purchases p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 20").all(),
  });
});

// ---------- Stripe webhook (mounted with a raw body, before express.json) ----------
export function stripeWebhook(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature failed:", err.message);
    return res.status(400).end();
  }
  if (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid") {
    const s = event.data.object;
    const userId = Number(s.metadata?.user_id || s.client_reference_id);
    const grant = db.transaction(() => {
      // UNIQUE(stripe_session_id) makes a retried webhook a no-op.
      const inserted = db
        .prepare("INSERT OR IGNORE INTO purchases (user_id, stripe_session_id, amount, currency, questions, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(userId, s.id, s.amount_total, s.currency, PACKAGE_QUESTIONS, Date.now()).changes;
      if (!inserted) return;
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
      const left = balance(user).questionsLeft;
      const from = Math.max(Date.now(), user.access_until || 0);
      db.prepare("UPDATE users SET questions_left = ?, access_until = ? WHERE id = ?").run(left + PACKAGE_QUESTIONS, from + PACKAGE_DAYS * DAY, userId);
    });
    grant();
    console.log(`Package granted to user ${userId} (session ${s.id})`);
  }
  res.json({ received: true });
}
