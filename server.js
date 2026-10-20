import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { z } from "zod";

const root = dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(32).toString("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 45);
const passHash = (password) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};
const passValid = (password, stored) => {
  const [salt, key] = stored.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(key, "hex"),
  );
};
const defaults = JSON.stringify(
  [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })),
);
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zoneSchema = z
  .string()
  .refine(
    (zone) => DateTime.now().setZone(zone).isValid,
    "Choose a valid time zone.",
  );
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const need = (condition, status, message) => {
  if (!condition) throw new HttpError(status, message);
};

export function createApp(options = {}) {
  const config = {
    port: Number(process.env.PORT || 3000),
    baseUrl:
      process.env.APP_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      "http://localhost:3000",
    dbPath: process.env.DATABASE_PATH || resolve(root, "data/calendar.sqlite"),
    production: process.env.NODE_ENV === "production",
    ownerEmail: (process.env.OWNER_EMAIL || "").toLowerCase(),
    resendKey: process.env.RESEND_API_KEY,
    mailFrom: process.env.MAIL_FROM,
    googleId: process.env.GOOGLE_CLIENT_ID,
    googleSecret: process.env.GOOGLE_CLIENT_SECRET,
    encryptionKey:
      process.env.TOKEN_ENCRYPTION_KEY ||
      (process.env.TOKEN_ENCRYPTION_SECRET
        ? hash(process.env.TOKEN_ENCRYPTION_SECRET)
        : undefined),
    demo: process.env.DEMO_MODE === "true",
    ...options,
  };
  // Render generates a high-entropy secret once and retains it across deployments.
  // Preserve support for existing explicit 64-hex encryption keys.
  if (!process.env.TOKEN_ENCRYPTION_KEY && process.env.TOKEN_ENCRYPTION_SECRET)
    need(
      process.env.TOKEN_ENCRYPTION_SECRET.length >= 32,
      500,
      "TOKEN_ENCRYPTION_SECRET must contain at least 32 random characters.",
    );
  config.baseUrl = config.baseUrl.replace(/\/$/, "");
  need(
    new URL(config.baseUrl).origin === config.baseUrl,
    500,
    "APP_URL must be an origin without a path, query, or fragment.",
  );
  // Demo uses its own local database and never contacts Resend.
  if (config.demo && !config.deliverMail) config.deliverMail = async () => {};
  if (config.production) {
    need(!config.demo, 500, "DEMO_MODE must be disabled in production.");
    need(
      config.baseUrl.startsWith("https://"),
      500,
      "Production APP_URL must use HTTPS.",
    );
    for (const key of [
      "ownerEmail",
      "resendKey",
      "mailFrom",
      "googleId",
      "googleSecret",
      "encryptionKey",
    ])
      need(config[key], 500, `Missing production configuration: ${key}`);
  }
  if (config.encryptionKey)
    need(
      /^[a-fA-F0-9]{64}$/.test(config.encryptionKey),
      500,
      "TOKEN_ENCRYPTION_KEY must contain 64 hex characters.",
    );
  if (config.dbPath !== ":memory:")
    mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.dbPath);
  if (config.dbPath !== ":memory:") chmodSync(config.dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, role TEXT NOT NULL DEFAULT 'member', verified INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'America/New_York', windows TEXT NOT NULL, notice INTEGER NOT NULL DEFAULT 240, horizon INTEGER NOT NULL DEFAULT 60, buffer INTEGER NOT NULL DEFAULT 15, google_refresh TEXT, google_email TEXT, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, email TEXT, data TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS event_types (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, slug TEXT NOT NULL, duration INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT 'Google Meet', color TEXT NOT NULL DEFAULT '#6366f1', active INTEGER NOT NULL DEFAULT 1, UNIQUE(user_id,slug));
    CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES event_types(id), user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, email TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', timezone TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', manage_hash TEXT NOT NULL UNIQUE, google_id TEXT, meet_url TEXT, title TEXT NOT NULL, location TEXT NOT NULL, created TEXT NOT NULL, operation TEXT NOT NULL DEFAULT 'create', parent_id TEXT);
    CREATE INDEX IF NOT EXISTS booking_overlap ON bookings(user_id,status,start,end);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, error TEXT);
  `);
  // Additive migrations preserve appointments across application updates.
  const bookingColumns = db
    .prepare("PRAGMA table_info(bookings)")
    .all()
    .map((c) => c.name);
  if (!bookingColumns.includes("operation"))
    db.exec(
      "ALTER TABLE bookings ADD COLUMN operation TEXT NOT NULL DEFAULT 'create'",
    );
  if (!bookingColumns.includes("parent_id"))
    db.exec("ALTER TABLE bookings ADD COLUMN parent_id TEXT");
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const app = express();
  app.disable("x-powered-by");
  // Configure the exact number of trusted reverse proxies at deployment; never trust arbitrary forwarded headers.
  if (process.env.TRUST_PROXY_HOPS)
    app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "24kb" }));
  app.use(cookieParser());
  const limits = new Map();
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (
        req.headers.origin &&
        req.headers.origin !== new URL(config.baseUrl).origin
      )
        return res
          .status(403)
          .json({ error: "Request origin is not allowed." });
      if (!req.is("application/json"))
        return res
          .status(415)
          .json({ error: "Send requests as application/json." });
    }
    const sensitive =
      /\/(auth|bookings|invite)/.test(req.path) && req.method !== "GET";
    const key = `${req.ip}:${sensitive ? "sensitive" : "general"}`;
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || entry.until < now) {
      entry = { count: 0, until: now + 15 * 60_000 };
      limits.set(key, entry);
    }
    if (++entry.count > (sensitive ? (config.testMode ? 500 : 40) : 1500))
      return res
        .status(429)
        .json({ error: "Too many requests. Please try again in 15 minutes." });
    next();
  });
  const safeUser = (u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    slug: u.slug,
    role: u.role,
    timezone: u.timezone,
    windows: JSON.parse(u.windows),
    notice: u.notice,
    horizon: u.horizon,
    buffer: u.buffer,
    googleConnected: !!u.google_refresh,
    googleEmail: u.google_email,
  });
  const encrypt = (text) => {
    need(config.encryptionKey, 503, "Calendar encryption is not configured.");
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(config.encryptionKey, "hex"),
      iv,
    );
    return [
      iv,
      cipher.update(text, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]
      .map((b) => b.toString("hex"))
      .join(".");
  };
  const decrypt = (text) => {
    const [iv, part, final, tag] = text
      .split(".")
      .map((s) => Buffer.from(s, "hex"));
    const cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(config.encryptionKey, "hex"),
      iv,
    );
    cipher.setAuthTag(tag);
    return Buffer.concat([
      cipher.update(Buffer.concat([part, final])),
      cipher.final(),
    ]).toString();
  };
  const request = async (url, opts = {}) => {
    const response = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(20_000),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new HttpError(
        502,
        "An external service is unavailable. Please try again shortly.",
      );
      error.providerStatus = response.status;
      throw error;
    }
    return data;
  };
  const enqueue = (recipient, subject, html) =>
    run(
      "INSERT INTO outbox(id,recipient,subject,html) VALUES(?,?,?,?)",
      randomUUID(),
      recipient,
      subject,
      html,
    );
  let flushing = false;
  async function flushMail() {
    if (flushing) return;
    flushing = true;
    try {
      for (const item of all(
        "SELECT * FROM outbox WHERE sent=0 AND next_try<=? ORDER BY rowid LIMIT 20",
        Date.now(),
      )) {
        try {
          if (config.deliverMail) await config.deliverMail(item);
          else {
            need(
              config.resendKey && config.mailFrom,
              503,
              "Email delivery is not configured.",
            );
            await request("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${config.resendKey}`,
                "Content-Type": "application/json",
                "Idempotency-Key": item.id,
              },
              body: JSON.stringify({
                from: config.mailFrom,
                to: [item.recipient],
                subject: item.subject,
                html: item.html,
              }),
            });
          }
          run("UPDATE outbox SET sent=1,error=NULL WHERE id=?", item.id);
        } catch {
          run(
            "UPDATE outbox SET attempts=attempts+1,next_try=?,error=? WHERE id=?",
            Date.now() +
              Math.min(3600_000, 30_000 * 2 ** Math.min(item.attempts, 7)),
            "Email delivery failed; queued for retry.",
            item.id,
          );
        }
      }
    } finally {
      flushing = false;
    }
  }
  const mailReady = () =>
    need(
      config.deliverMail || (config.resendKey && config.mailFrom),
      503,
      "Email delivery is not configured yet. Please contact your administrator.",
    );
  const mailPage = (title, body) =>
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:32px auto;color:#172033"><p style="color:#635bdb;font-weight:bold">BMT Calendar</p><h1>${esc(title)}</h1>${body}<p style="color:#6b7280;margin-top:32px">Scheduling, made simple.</p></div>`;
  const mailLink = (label, url) =>
    `<p><a href="${esc(url)}" style="display:inline-block;background:#635bdb;color:white;padding:12px 20px;border-radius:8px;text-decoration:none">${esc(label)}</a></p>`;
  function createToken(userId, kind, email = null, data = null, minutes = 60) {
    const value = token();
    run(
      "INSERT INTO tokens VALUES(?,?,?,?,?,?)",
      hash(value),
      userId,
      kind,
      email,
      data,
      Date.now() + minutes * 60_000,
    );
    return value;
  }
  function readToken(value, kind) {
    need(typeof value === "string", 400, "This link is invalid or expired.");
    const found = get(
      "SELECT * FROM tokens WHERE hash=? AND kind=? AND expires>?",
      hash(value),
      kind,
      Date.now(),
    );
    need(found, 400, "This link is invalid or expired.");
    return found;
  }
  function auth(req, res, next) {
    const s =
      req.cookies.bmt_session &&
      get(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?",
        hash(req.cookies.bmt_session),
        Date.now(),
      );
    if (!s || !s.verified)
      return res.status(401).json({ error: "Please sign in to continue." });
    req.user = s;
    next();
  }
  const admin = (req, res, next) =>
    req.user.role === "admin"
      ? next()
      : res.status(403).json({ error: "Administrator access is required." });
  function session(res, user) {
    const value = token();
    run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(value),
      user.id,
      Date.now() + 7 * 86400_000,
    );
    res.cookie("bmt_session", value, {
      httpOnly: true,
      secure: config.production,
      sameSite: "lax",
      maxAge: 7 * 86400_000,
      path: "/",
    });
  }
  function addUser({ name, email, password, role = "member", verified = 0 }) {
    const id = randomUUID();
    let slug = slugify(name) || "team";
    if (get("SELECT id FROM users WHERE slug=?", slug))
      slug += "-" + randomBytes(3).toString("hex");
    run(
      "INSERT INTO users(id,name,email,password,slug,role,verified,windows,created) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      name,
      email,
      passHash(password),
      slug,
      role,
      verified,
      defaults,
      new Date().toISOString(),
    );
    run(
      "INSERT INTO event_types(id,user_id,title,slug,duration,description) VALUES(?,?,?,?,?,?)",
      randomUUID(),
      id,
      "Discovery call",
      "discovery-call",
      30,
      "A little time to connect, discuss your goals, and plan the next step.",
    );
    return get("SELECT * FROM users WHERE id=?", id);
  }
  app.get("/api/health", (req, res) =>
    res.json({ status: "ok", database: get("SELECT 1 AS ok").ok === 1 }),
  );
  app.get("/api/config", (req, res) =>
    res.json({
      demo: config.demo,
      signupEnabled: !!config.ownerEmail,
      googleConfigured: !!(
        config.googleId &&
        config.googleSecret &&
        config.encryptionKey
      ),
      emailConfigured: !!(
        (config.resendKey && config.mailFrom) ||
        config.deliverMail
      ),
    }),
  );
  app.post("/api/auth/register", async (req, res) => {
    need(
      !config.demo || config.testMode,
      409,
      "Use Explore the demo to try the app. Real account registration requires live email configuration.",
    );
    mailReady();
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: emailSchema,
        password: passwordSchema,
        invite: z.string().optional(),
      })
      .parse(req.body);
    const invited = body.invite ? readToken(body.invite, "invite") : null;
    need(
      body.email === config.ownerEmail || invited?.email === body.email,
      403,
      "Team accounts require an invitation from your administrator.",
    );
    if (get("SELECT id FROM users WHERE email=?", body.email))
      return res
        .status(409)
        .json({
          error:
            "An account already exists for this email. Sign in or reset your password.",
        });
    const user = addUser({
      ...body,
      role: body.email === config.ownerEmail ? "admin" : "member",
    });
    if (invited) run("DELETE FROM tokens WHERE hash=?", invited.hash);
    const value = createToken(user.id, "verify");
    enqueue(
      user.email,
      "Verify your BMT Calendar account",
      mailPage(
        "Welcome to your calendar",
        `<p>Hi ${esc(user.name)}, verify your email to start scheduling. This link expires in one hour.</p>${mailLink("Verify email", `${config.baseUrl}/verify?token=${value}`)}`,
      ),
    );
    await flushMail();
    res
      .status(201)
      .json({ message: "Check your email to verify your account." });
  });
  app.post("/api/auth/verify", (req, res) => {
    const t = readToken(req.body.token, "verify");
    run("UPDATE users SET verified=1 WHERE id=?", t.user_id);
    run("DELETE FROM tokens WHERE hash=?", t.hash);
    const user = get("SELECT * FROM users WHERE id=?", t.user_id);
    session(res, user);
    res.json({ user: safeUser(user) });
  });
  app.post("/api/auth/login", (req, res) => {
    const body = z
      .object({ email: emailSchema, password: z.string().min(1).max(128) })
      .parse(req.body);
    const user = get("SELECT * FROM users WHERE email=?", body.email);
    const dummy =
      "00000000000000000000000000000000:" +
      scryptSync(
        "not-a-valid-password",
        "00000000000000000000000000000000",
        64,
      ).toString("hex");
    need(
      passValid(body.password, user?.password || dummy) && user,
      401,
      "Email or password is incorrect.",
    );
    need(user.verified, 403, "Please verify your email before signing in.");
    session(res, user);
    res.json({ user: safeUser(user) });
  });
  app.post("/api/auth/logout", (req, res) => {
    if (req.cookies.bmt_session)
      run("DELETE FROM sessions WHERE hash=?", hash(req.cookies.bmt_session));
    res.clearCookie("bmt_session", { path: "/" });
    res.json({ ok: true });
  });
  app.post("/api/auth/forgot", async (req, res) => {
    mailReady();
    const email = emailSchema.parse(req.body.email);
    const user = get("SELECT * FROM users WHERE email=?", email);
    if (user) {
      const value = createToken(user.id, "reset", null, null, 30);
      enqueue(
        email,
        "Reset your BMT Calendar password",
        mailPage(
          "Reset your password",
          `<p>This link expires in 30 minutes. If you did not request it, you can ignore this email.</p>${mailLink("Reset password", `${config.baseUrl}/reset?token=${value}`)}`,
        ),
      );
      await flushMail();
    }
    res.json({ message: "If an account exists, a reset link is on its way." });
  });
  app.post("/api/auth/reset", (req, res) => {
    const password = passwordSchema.parse(req.body.password);
    const t = readToken(req.body.token, "reset");
    run(
      "UPDATE users SET password=? WHERE id=?",
      passHash(password),
      t.user_id,
    );
    run(
      "DELETE FROM tokens WHERE user_id=? AND kind IN ('reset','verify')",
      t.user_id,
    );
    run("DELETE FROM sessions WHERE user_id=?", t.user_id);
    res.json({ message: "Password updated. Please sign in." });
  });
  app.post("/api/auth/resend-verification", async (req, res) => {
    mailReady();
    const email = emailSchema.parse(req.body.email);
    const user = get("SELECT * FROM users WHERE email=? AND verified=0", email);
    if (user) {
      const value = createToken(user.id, "verify");
      enqueue(
        email,
        "Verify your BMT Calendar account",
        mailPage(
          "Verify your email",
          mailLink("Verify email", `${config.baseUrl}/verify?token=${value}`),
        ),
      );
      await flushMail();
    }
    res.json({
      message:
        "If your account needs verification, a fresh link is on its way.",
    });
  });
  app.get("/api/me", auth, (req, res) =>
    res.json({
      user: safeUser(req.user),
      baseUrl: config.baseUrl,
      pendingEmails:
        req.user.role === "admin"
          ? get("SELECT COUNT(*) AS n FROM outbox WHERE sent=0").n
          : 0,
      pendingBookings: get(
        "SELECT COUNT(*) AS n FROM bookings WHERE user_id=? AND status='pending'",
        req.user.id,
      ).n,
    }),
  );
  app.patch("/api/me", auth, (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        timezone: zoneSchema,
        notice: z.number().int().min(0).max(10080),
        horizon: z.number().int().min(1).max(180),
        buffer: z.number().int().min(0).max(120),
        windows: z
          .array(
            z
              .object({
                day: z.number().int().min(1).max(7),
                start: timeSchema,
                end: timeSchema,
              })
              .refine(
                (w) => w.start < w.end,
                "End time must follow start time.",
              ),
          )
          .max(21),
      })
      .parse(req.body);
    for (let i = 0; i < body.windows.length; i++)
      for (let j = i + 1; j < body.windows.length; j++) {
        const a = body.windows[i],
          b = body.windows[j];
        need(
          a.day !== b.day || a.end <= b.start || b.end <= a.start,
          400,
          "Availability windows must not overlap.",
        );
      }
    run(
      "UPDATE users SET name=?,timezone=?,notice=?,horizon=?,buffer=?,windows=? WHERE id=?",
      body.name,
      body.timezone,
      body.notice,
      body.horizon,
      body.buffer,
      JSON.stringify(body.windows),
      req.user.id,
    );
    res.json({
      user: safeUser(get("SELECT * FROM users WHERE id=?", req.user.id)),
    });
  });
  app.get("/api/events", auth, (req, res) =>
    res.json({
      events: all(
        "SELECT * FROM event_types WHERE user_id=? ORDER BY rowid",
        req.user.id,
      ),
    }),
  );
  const eventSchema = z.object({
    title: z.string().trim().min(2).max(80),
    duration: z.number().int().min(15).max(240).multipleOf(15),
    description: z.string().max(2000).default(""),
    location: z.enum(["Google Meet", "Phone call", "In person"]),
    color: z.enum(["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#3b82f6"]),
    active: z.boolean().default(true),
  });
  app.post("/api/events", auth, (req, res) => {
    const b = eventSchema.parse(req.body);
    const id = randomUUID();
    const slug =
      (slugify(b.title) || "meeting") + "-" + randomBytes(2).toString("hex");
    run(
      "INSERT INTO event_types VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      req.user.id,
      b.title,
      slug,
      b.duration,
      b.description,
      b.location,
      b.color,
      Number(b.active),
    );
    res
      .status(201)
      .json({ event: get("SELECT * FROM event_types WHERE id=?", id) });
  });
  app.patch("/api/events/:id", auth, (req, res) => {
    const b = eventSchema.parse(req.body);
    need(
      get(
        "SELECT id FROM event_types WHERE id=? AND user_id=?",
        req.params.id,
        req.user.id,
      ),
      404,
      "Event type not found.",
    );
    run(
      "UPDATE event_types SET title=?,duration=?,description=?,location=?,color=?,active=? WHERE id=?",
      b.title,
      b.duration,
      b.description,
      b.location,
      b.color,
      Number(b.active),
      req.params.id,
    );
    res.json({ ok: true });
  });
  app.get("/api/team", auth, (req, res) =>
    res.json({
      users: all("SELECT * FROM users WHERE verified=1 ORDER BY created").map(
        (u) => ({
          id: u.id,
          name: u.name,
          slug: u.slug,
          role: u.role,
          ...(req.user.role === "admin"
            ? { email: u.email, googleConnected: !!u.google_refresh }
            : {}),
        }),
      ),
    }),
  );
  app.post("/api/team/invite", auth, admin, async (req, res) => {
    mailReady();
    const email = emailSchema.parse(req.body.email);
    need(
      !get("SELECT id FROM users WHERE email=?", email),
      409,
      "This person already has an account.",
    );
    const value = createToken(null, "invite", email, null, 7 * 24 * 60);
    enqueue(
      email,
      "You’re invited to BMT Calendar",
      mailPage(
        "A simpler way to schedule",
        `<p>${esc(req.user.name)} invited you to join BMT Calendar. This invitation expires in seven days.</p>${mailLink("Create your account", `${config.baseUrl}/signup?invite=${value}&email=${encodeURIComponent(email)}`)}`,
      ),
    );
    await flushMail();
    res.json({ message: "Invitation sent." });
  });
  app.get("/api/bookings", auth, (req, res) => {
    const isTeam = req.query.team === "true" && req.user.role === "admin";
    const bookings = all(
      `SELECT b.*,u.name AS host_name FROM bookings b JOIN users u ON u.id=b.user_id ${isTeam ? "" : "WHERE b.user_id=?"} ORDER BY b.start DESC LIMIT 1000`,
      ...(isTeam ? [] : [req.user.id]),
    );
    res.json({ bookings: bookings.map(({ manage_hash, ...b }) => b) });
  });
  async function accessToken(user) {
    need(
      user.google_refresh,
      409,
      "This host has not connected Google Calendar yet.",
    );
    try {
      const data = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.googleId,
          client_secret: config.googleSecret,
          refresh_token: decrypt(user.google_refresh),
          grant_type: "refresh_token",
        }),
      });
      return data.access_token;
    } catch {
      throw new HttpError(
        503,
        "Google Calendar needs attention. The host should reconnect their calendar in Settings.",
      );
    }
  }
  async function google(user, path, method = "GET", body) {
    const access = await accessToken(user);
    return request(`https://www.googleapis.com/calendar/v3/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function busy(user, start, end) {
    const local = all(
      "SELECT start,end FROM bookings WHERE user_id=? AND status IN ('scheduled','pending') AND start<? AND end>?",
      user.id,
      end,
      start,
    );
    if (config.calendarProvider)
      return [
        ...local,
        ...(await config.calendarProvider.busy(user, start, end)),
      ];
    if (config.demo && user.email === "demo@bmtcalendar.local") return local;
    const data = await google(user, "freeBusy", "POST", {
      timeMin: start,
      timeMax: end,
      items: [{ id: "primary" }],
    });
    need(
      !data.calendars?.primary?.errors?.length &&
        Array.isArray(data.calendars?.primary?.busy),
      503,
      "Calendar availability could not be checked. Please try again later.",
    );
    return [...local, ...data.calendars.primary.busy];
  }
  function publicEvent(host, slug) {
    const u = get("SELECT * FROM users WHERE slug=? AND verified=1", host);
    need(u, 404, "This scheduling page was not found.");
    const e = get(
      "SELECT * FROM event_types WHERE user_id=? AND slug=? AND active=1",
      u.id,
      slug,
    );
    need(e, 404, "This event is not available for booking.");
    return { u, e };
  }
  async function slots(u, e, date, zone) {
    const day = DateTime.fromISO(date, { zone });
    need(
      day.isValid && /^\d{4}-\d{2}-\d{2}$/.test(date),
      400,
      "Choose a valid date.",
    );
    const now = DateTime.now();
    if (
      day.endOf("day") < now ||
      day.startOf("day") > now.plus({ days: u.horizon }).endOf("day")
    )
      return [];
    const from = day.startOf("day").minus({ days: 1 }).toUTC().toISO(),
      to = day.endOf("day").plus({ days: 1 }).toUTC().toISO();
    const occupied = await busy(u, from, to);
    const windows = JSON.parse(u.windows),
      result = [];
    const hostStart = day.startOf("day").setZone(u.timezone).startOf("day");
    for (let d = 0; d < 3; d++) {
      const hostDay = hostStart.plus({ days: d });
      for (const w of windows.filter((w) => w.day === hostDay.weekday)) {
        const [h, m] = w.start.split(":").map(Number),
          [eh, em] = w.end.split(":").map(Number);
        const first = hostDay.set({
            hour: h,
            minute: m,
            second: 0,
            millisecond: 0,
          }),
          last = hostDay.set({
            hour: eh,
            minute: em,
            second: 0,
            millisecond: 0,
          });
        for (
          let t = first;
          t.plus({ minutes: e.duration }) <= last;
          t = t.plus({ minutes: 15 })
        ) {
          const end = t.plus({ minutes: e.duration });
          if (
            t.setZone(zone).toISODate() !== date ||
            t < now.plus({ minutes: u.notice }) ||
            t > now.plus({ days: u.horizon })
          )
            continue;
          const paddedStart = t.minus({ minutes: u.buffer }).toMillis(),
            paddedEnd = end.plus({ minutes: u.buffer }).toMillis();
          if (
            occupied.some(
              (b) =>
                DateTime.fromISO(b.start).toMillis() < paddedEnd &&
                DateTime.fromISO(b.end).toMillis() > paddedStart,
            )
          )
            continue;
          result.push(t.toUTC().toISO());
        }
      }
    }
    return [...new Set(result)].sort();
  }
  app.get("/api/public/:host", (req, res) => {
    const u = get(
      "SELECT * FROM users WHERE slug=? AND verified=1",
      req.params.host,
    );
    need(u, 404, "This scheduling page was not found.");
    res.json({
      host: { name: u.name, slug: u.slug, timezone: u.timezone },
      events: all(
        "SELECT title,slug,duration,description,location,color FROM event_types WHERE user_id=? AND active=1",
        u.id,
      ),
    });
  });
  app.get("/api/public/:host/:event", (req, res) => {
    const { u, e } = publicEvent(req.params.host, req.params.event);
    res.json({
      host: { name: u.name, slug: u.slug, timezone: u.timezone },
      event: {
        title: e.title,
        slug: e.slug,
        duration: e.duration,
        description: e.description,
        location: e.location,
        color: e.color,
      },
      horizon: u.horizon,
    });
  });
  app.get("/api/public/:host/:event/slots", async (req, res) => {
    const { u, e } = publicEvent(req.params.host, req.params.event);
    const zone = zoneSchema.parse(req.query.timezone || u.timezone);
    res.json({ slots: await slots(u, e, String(req.query.date), zone) });
  });
  function bookingMail(b, u, manageToken, changed = false) {
    const when = DateTime.fromISO(b.start)
      .setZone(b.timezone)
      .toFormat("cccc, LLLL d, yyyy · h:mm a ZZZZ");
    const body = `<p>${esc(b.title)} with ${esc(u.name)}</p><p><strong>${esc(when)}</strong></p><p>${esc(b.location)}</p>${b.meet_url ? mailLink("Join Google Meet", b.meet_url) : ""}${manageToken ? mailLink("Manage appointment", `${config.baseUrl}/manage/${manageToken}`) : ""}`;
    enqueue(
      b.email,
      `${changed ? "Updated" : "Confirmed"}: ${b.title}`,
      mailPage("You’re on the calendar", body),
    );
    enqueue(
      u.email,
      `${changed ? "Rescheduled" : "New booking"}: ${b.name}`,
      mailPage(
        `${changed ? "Updated" : "New"} appointment`,
        `${body}<p>Guest: ${esc(b.name)} (${esc(b.email)})</p>${b.notes ? `<p>Guest notes: ${esc(b.notes)}</p>` : ""}`,
      ),
    );
  }
  async function createCalendarEvent(u, e, b) {
    if (config.calendarProvider) return config.calendarProvider.create(u, e, b);
    if (config.demo && u.email === "demo@bmtcalendar.local") return {};
    const event = {
      id: b.id.replaceAll("-", ""),
      summary: e.title,
      description: `Guest: ${b.name} (${b.email})\n${b.notes}`,
      start: { dateTime: b.start },
      end: { dateTime: b.end },
      attendees: [{ email: b.email }, { email: u.email }],
      location: e.location,
    };
    if (e.location === "Google Meet")
      event.conferenceData = {
        createRequest: {
          requestId: b.id,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    try {
      return await google(
        u,
        `calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`,
        "POST",
        event,
      );
    } catch (error) {
      if (error.providerStatus === 409)
        return google(u, `calendars/primary/events/${event.id}`);
      throw error;
    }
  }
  const guestSchema = z.object({
    name: z.string().trim().min(2).max(80),
    email: emailSchema,
    notes: z.string().max(2000).default(""),
    timezone: zoneSchema,
    start: z.iso.datetime({ offset: true }),
  });
  const cleanBooking = (b) => {
    const { manage_hash, ...clean } = b;
    return clean;
  };
  app.post("/api/public/:host/:event/bookings", async (req, res) => {
    mailReady();
    const { u, e } = publicEvent(req.params.host, req.params.event);
    const b = guestSchema.parse(req.body);
    const start = DateTime.fromISO(b.start).toUTC().toISO(),
      end = DateTime.fromISO(start)
        .plus({ minutes: e.duration })
        .toUTC()
        .toISO();
    const available = await slots(
      u,
      e,
      DateTime.fromISO(start).setZone(b.timezone).toISODate(),
      b.timezone,
    );
    need(
      available.includes(start),
      409,
      "That time is no longer available. Please choose another time.",
    );
    const id = randomUUID(),
      manage = token();
    db.exec("BEGIN IMMEDIATE");
    try {
      need(
        !get(
          "SELECT id FROM bookings WHERE user_id=? AND status IN ('scheduled','pending') AND start<? AND end>?",
          u.id,
          DateTime.fromISO(end).plus({ minutes: u.buffer }).toUTC().toISO(),
          DateTime.fromISO(start).minus({ minutes: u.buffer }).toUTC().toISO(),
        ),
        409,
        "That time was just booked. Please choose another time.",
      );
      run(
        "INSERT INTO bookings(id,event_id,user_id,name,email,notes,timezone,start,end,status,manage_hash,title,location,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        e.id,
        u.id,
        b.name,
        b.email,
        b.notes,
        b.timezone,
        start,
        end,
        "pending",
        hash(manage),
        e.title,
        e.location,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // Deterministic Google IDs allow reconciliation after a timeout or a process restart.
    run(
      "UPDATE bookings SET google_id=? WHERE id=?",
      id.replaceAll("-", ""),
      id,
    );
    let remote;
    try {
      remote = await createCalendarEvent(u, e, { ...b, id, start, end });
    } catch (error) {
      if (error.providerStatus >= 400 && error.providerStatus < 500)
        run("UPDATE bookings SET status='failed' WHERE id=?", id);
      else {
        enqueue(
          u.email,
          "Appointment needs a calendar check",
          mailPage(
            "Please check an appointment",
            `<p>A calendar request for ${esc(b.name)} could not be confirmed. The time is reserved to prevent a duplicate booking.</p>${mailLink("Check calendar status", config.baseUrl + "/app/bookings")}`,
          ),
        );
        await flushMail();
      }
      throw new HttpError(
        503,
        "The calendar did not confirm this appointment. Please contact the host before trying again.",
      );
    }
    const meet = remote.hangoutLink || null;
    run(
      "UPDATE bookings SET status='scheduled',google_id=?,meet_url=? WHERE id=?",
      remote.id || null,
      meet,
      id,
    );
    const saved = get("SELECT * FROM bookings WHERE id=?", id);
    bookingMail(saved, u, manage);
    await flushMail();
    res
      .status(201)
      .json({
        booking: cleanBooking(saved),
        manageUrl: `${config.baseUrl}/manage/${manage}`,
      });
  });
  function managed(value) {
    need(
      typeof value === "string" && value.length === 64,
      404,
      "Appointment not found.",
    );
    const b = get("SELECT * FROM bookings WHERE manage_hash=?", hash(value));
    need(b, 404, "Appointment not found.");
    return b;
  }
  app.get("/api/manage/:token", (req, res) => {
    const b = managed(req.params.token),
      u = get("SELECT * FROM users WHERE id=?", b.user_id),
      e = get("SELECT * FROM event_types WHERE id=?", b.event_id);
    res.json({
      booking: cleanBooking(b),
      host: { name: u.name, slug: u.slug },
      event: { slug: e.slug, active: !!e.active },
    });
  });
  async function cancel(b) {
    need(
      b.status === "scheduled",
      409,
      "This appointment is no longer scheduled.",
    );
    need(
      DateTime.fromISO(b.start) > DateTime.now(),
      409,
      "Past appointments cannot be cancelled.",
    );
    const u = get("SELECT * FROM users WHERE id=?", b.user_id);
    if (b.google_id) {
      if (config.calendarProvider) await config.calendarProvider.cancel(u, b);
      else {
        try {
          await google(
            u,
            `calendars/primary/events/${encodeURIComponent(b.google_id)}?sendUpdates=all`,
            "DELETE",
          );
        } catch (error) {
          if (error.providerStatus !== 404 && error.providerStatus !== 410)
            throw error;
        }
      }
    }
    run("UPDATE bookings SET status='cancelled' WHERE id=?", b.id);
    const body = `<p>${esc(b.title)} with ${esc(b.name)} on ${esc(DateTime.fromISO(b.start).setZone(u.timezone).toFormat("LLL d, yyyy, h:mm a ZZZZ"))} has been cancelled.</p>`;
    enqueue(
      b.email,
      `Cancelled: ${b.title}`,
      mailPage("Appointment cancelled", body),
    );
    enqueue(
      u.email,
      `Cancelled: ${b.title}`,
      mailPage("Appointment cancelled", body),
    );
    await flushMail();
  }
  app.post("/api/manage/:token/cancel", async (req, res) => {
    await cancel(managed(req.params.token));
    res.json({ ok: true });
  });
  app.post("/api/bookings/:id/cancel", auth, async (req, res) => {
    const b = get("SELECT * FROM bookings WHERE id=?", req.params.id);
    need(
      b && (b.user_id === req.user.id || req.user.role === "admin"),
      404,
      "Appointment not found.",
    );
    await cancel(b);
    res.json({ ok: true });
  });
  app.post("/api/manage/:token/reschedule", async (req, res) => {
    mailReady();
    const old = managed(req.params.token);
    need(
      old.status === "scheduled" &&
        DateTime.fromISO(old.start) > DateTime.now(),
      409,
      "This appointment cannot be rescheduled.",
    );
    const u = get("SELECT * FROM users WHERE id=?", old.user_id),
      e = get("SELECT * FROM event_types WHERE id=?", old.event_id);
    need(e.active, 409, "This event type is no longer accepting bookings.");
    const input = z
        .object({
          start: z.iso.datetime({ offset: true }),
          timezone: zoneSchema,
        })
        .parse(req.body),
      start = DateTime.fromISO(input.start).toUTC().toISO(),
      end = DateTime.fromISO(start)
        .plus({ minutes: e.duration })
        .toUTC()
        .toISO();
    need(start !== old.start, 400, "Choose a different appointment time.");
    const available = await slots(
      u,
      e,
      DateTime.fromISO(start).setZone(input.timezone).toISODate(),
      input.timezone,
    );
    need(
      available.includes(start),
      409,
      "That time is no longer available. Please choose another time.",
    );
    const reservation = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      need(
        !get(
          "SELECT id FROM bookings WHERE user_id=? AND status IN ('scheduled','pending') AND start<? AND end>?",
          u.id,
          DateTime.fromISO(end).plus({ minutes: u.buffer }).toUTC().toISO(),
          DateTime.fromISO(start).minus({ minutes: u.buffer }).toUTC().toISO(),
        ),
        409,
        "That time was just booked. Please choose another time.",
      );
      // Reserve the new slot while retaining the original appointment until Google confirms the update.
      run(
        "INSERT INTO bookings(id,event_id,user_id,name,email,notes,timezone,start,end,status,manage_hash,title,location,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        reservation,
        e.id,
        u.id,
        old.name,
        old.email,
        old.notes,
        input.timezone,
        start,
        end,
        "pending",
        hash(token()),
        old.title,
        old.location,
        new Date().toISOString(),
      );
      run(
        "UPDATE bookings SET operation='reschedule',parent_id=?,google_id=? WHERE id=?",
        old.id,
        old.google_id,
        reservation,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    try {
      if (old.google_id) {
        if (config.calendarProvider)
          await config.calendarProvider.update(u, old, { start, end });
        else
          await google(
            u,
            `calendars/primary/events/${encodeURIComponent(old.google_id)}?sendUpdates=all`,
            "PATCH",
            { start: { dateTime: start }, end: { dateTime: end } },
          );
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        run(
          "UPDATE bookings SET start=?,end=?,timezone=? WHERE id=?",
          start,
          end,
          input.timezone,
          old.id,
        );
        run("DELETE FROM bookings WHERE id=?", reservation);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (error.providerStatus >= 400 && error.providerStatus < 500)
        run("UPDATE bookings SET status='failed' WHERE id=?", reservation);
      else {
        enqueue(
          u.email,
          "Rescheduling needs a calendar check",
          mailPage(
            "Please check a rescheduling request",
            `<p>The calendar response was uncertain. Both times remain reserved until you check the appointment status.</p>${mailLink("Check calendar status", config.baseUrl + "/app/bookings")}`,
          ),
        );
        await flushMail();
      }
      throw new HttpError(
        503,
        "The calendar did not confirm the change. Please contact the host before trying again.",
      );
    }
    const b = get("SELECT * FROM bookings WHERE id=?", old.id);
    bookingMail(b, u, req.params.token, true);
    await flushMail();
    res.json({ booking: cleanBooking(b) });
  });
  app.post("/api/bookings/:id/reconcile", auth, async (req, res) => {
    const b = get("SELECT * FROM bookings WHERE id=?", req.params.id);
    need(
      b && (b.user_id === req.user.id || req.user.role === "admin"),
      404,
      "Appointment not found.",
    );
    need(
      b.status === "pending",
      409,
      "This appointment does not need reconciliation.",
    );
    need(
      Date.now() - Date.parse(b.created) > 60_000,
      409,
      "Please wait one minute for Google to finish processing, then check again.",
    );
    const u = get("SELECT * FROM users WHERE id=?", b.user_id);
    let remote;
    try {
      remote = config.calendarProvider
        ? await config.calendarProvider.lookup(u, b)
        : await google(
            u,
            `calendars/primary/events/${encodeURIComponent(b.google_id)}`,
          );
    } catch (error) {
      if (error.providerStatus === 404 || error.providerStatus === 410)
        remote = null;
      else throw error;
    }
    const sameTime =
      remote &&
      remote.status !== "cancelled" &&
      DateTime.fromISO(remote.start?.dateTime || "").toMillis() ===
        DateTime.fromISO(b.start).toMillis() &&
      DateTime.fromISO(remote.end?.dateTime || "").toMillis() ===
        DateTime.fromISO(b.end).toMillis();
    if (!sameTime) {
      if (
        b.operation === "reschedule" &&
        remote &&
        remote.status !== "cancelled"
      ) {
        const original = get("SELECT * FROM bookings WHERE id=?", b.parent_id);
        need(
          original &&
            DateTime.fromISO(remote.start?.dateTime || "").toMillis() ===
              DateTime.fromISO(original.start).toMillis(),
          409,
          "Google has a different appointment time. Review the event in Google Calendar before making further changes.",
        );
      } else
        need(
          !remote || remote.status === "cancelled",
          409,
          "Google has a different appointment time. Please review this event in Google Calendar.",
        );
      run("UPDATE bookings SET status='failed' WHERE id=?", b.id);
      return res.json({
        message:
          "Google did not apply this request. The extra reservation has been released.",
      });
    }
    const manage = token();
    let id = b.id;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (b.operation === "reschedule") {
        id = b.parent_id;
        run(
          "UPDATE bookings SET start=?,end=?,timezone=?,manage_hash=? WHERE id=?",
          b.start,
          b.end,
          b.timezone,
          hash(manage),
          id,
        );
        run("DELETE FROM bookings WHERE id=?", b.id);
      } else
        run(
          "UPDATE bookings SET status='scheduled',google_id=?,meet_url=?,manage_hash=? WHERE id=?",
          remote.id,
          remote.hangoutLink || null,
          hash(manage),
          b.id,
        );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    bookingMail(
      get("SELECT * FROM bookings WHERE id=?", id),
      u,
      manage,
      b.operation === "reschedule",
    );
    await flushMail();
    res.json({
      message:
        "Appointment confirmed against Google Calendar. Confirmation emails have been queued.",
    });
  });
  app.get("/api/google/connect", auth, (req, res) => {
    need(
      config.googleId && config.googleSecret && config.encryptionKey,
      503,
      "Google Calendar is not configured yet.",
    );
    const verifier = token(),
      state = createToken(req.user.id, "oauth", null, verifier, 10);
    const params = new URLSearchParams({
      client_id: config.googleId,
      redirect_uri: `${config.baseUrl}/api/google/callback`,
      response_type: "code",
      scope:
        "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });
  app.get("/api/google/callback", auth, async (req, res) => {
    if (req.query.error) return res.redirect("/app/settings?google=denied");
    const state = readToken(req.query.state, "oauth");
    need(
      state.user_id === req.user.id,
      403,
      "This calendar connection belongs to another session.",
    );
    run("DELETE FROM tokens WHERE hash=?", state.hash);
    need(
      typeof req.query.code === "string",
      400,
      "Missing Google authorization code.",
    );
    const data = await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.googleId,
        client_secret: config.googleSecret,
        code: req.query.code,
        redirect_uri: `${config.baseUrl}/api/google/callback`,
        grant_type: "authorization_code",
        code_verifier: state.data,
      }),
    });
    if (data.scope) {
      const granted = new Set(data.scope.split(" "));
      need(
        granted.has("https://www.googleapis.com/auth/calendar.events") &&
          granted.has("https://www.googleapis.com/auth/calendar.freebusy"),
        400,
        "Please grant both calendar permissions, then reconnect.",
      );
    }
    need(
      data.refresh_token,
      502,
      "Google did not grant offline access. Please reconnect and approve calendar access.",
    );
    const info = await request(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${data.access_token}` } },
    );
    need(info.email_verified, 400, "Please use a verified Google account.");
    run(
      "UPDATE users SET google_refresh=?,google_email=? WHERE id=?",
      encrypt(data.refresh_token),
      info.email,
      req.user.id,
    );
    res.redirect("/app/settings?google=connected");
  });
  app.post("/api/google/disconnect", auth, async (req, res) => {
    need(
      !get(
        "SELECT id FROM bookings WHERE user_id=? AND status='scheduled' AND start>?",
        req.user.id,
        new Date().toISOString(),
      ),
      409,
      "Cancel your upcoming appointments before disconnecting your calendar.",
    );
    if (req.user.google_refresh) {
      await request("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: decrypt(req.user.google_refresh) }),
      });
    }
    run(
      "UPDATE users SET google_refresh=NULL,google_email=NULL WHERE id=?",
      req.user.id,
    );
    res.json({ ok: true });
  });
  if (config.demo) {
    if (!get("SELECT id FROM users WHERE email=?", "demo@bmtcalendar.local")) {
      const u = addUser({
        name: "Alex Morgan",
        email: "demo@bmtcalendar.local",
        password: token(),
        role: "admin",
        verified: 1,
      });
      run("UPDATE users SET notice=0 WHERE id=?", u.id);
      run(
        "UPDATE event_types SET title='Tax strategy call',description='Let’s talk about your business, your goals, and opportunities to save on taxes.' WHERE user_id=?",
        u.id,
      );
      run(
        "INSERT INTO event_types VALUES(?,?,?,?,?,?,?,?,?)",
        randomUUID(),
        u.id,
        "Client check-in",
        "client-check-in",
        15,
        "A quick catch-up to keep everything moving.",
        "Google Meet",
        "#10b981",
        1,
      );
      run(
        "INSERT INTO event_types VALUES(?,?,?,?,?,?,?,?,?)",
        randomUUID(),
        u.id,
        "Planning session",
        "planning-session",
        60,
        "A focused working session for your next chapter.",
        "Google Meet",
        "#f59e0b",
        1,
      );
    }
    app.post("/api/auth/demo", (req, res) => {
      const u = get(
        "SELECT * FROM users WHERE email=?",
        "demo@bmtcalendar.local",
      );
      session(res, u);
      res.json({ user: safeUser(u) });
    });
  }
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "This endpoint does not exist." }),
  );
  app.use(express.static(resolve(root, "public"), { etag: true }));
  app.get("/{*path}", (req, res) =>
    res.sendFile(resolve(root, "public/index.html")),
  );
  app.use((error, req, res, next) => {
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: error.issues.map((i) => i.message).join(" ") });
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "Invalid JSON." });
    if (error.status)
      return res.status(error.status).json({ error: error.message });
    if (error.code?.startsWith("SQLITE_CONSTRAINT"))
      return res
        .status(409)
        .json({
          error: "This item already exists or conflicts with another record.",
        });
    console.error("Unhandled server error:", error.name, error.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });
  const interval = setInterval(() => {
    void flushMail();
    const now = Date.now();
    for (const [key, v] of limits) if (v.until < now) limits.delete(key);
    run("DELETE FROM sessions WHERE expires<?", now);
    run("DELETE FROM tokens WHERE expires<?", now);
  }, 15_000);
  interval.unref();
  return {
    app,
    db,
    config,
    flushMail,
    close: () => {
      clearInterval(interval);
      db.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { app, config } = createApp();
  app.listen(config.port, process.env.HOST || "0.0.0.0", () =>
    console.log(
      `BMT Calendar listening on port ${config.port}${config.demo ? " (DEMO MODE — sample account, no live Google Calendar)" : ""}`,
    ),
  );
}
