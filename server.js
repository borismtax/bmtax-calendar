import express from "express";
import sharp from "sharp";
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
import { googleCredentials } from "./google-credentials.js";
import {
  calendarDiagnostic,
  oauthDiagnostic,
  publicCalendarError,
  safeOAuthReason,
} from "./google-diagnostics.js";

const root = dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(32).toString("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
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
    dbPath:
      process.env.DATABASE_PATH || resolve(root, "data/calendar.sqlite"),
    production: process.env.NODE_ENV === "production",
    ownerEmail: (process.env.OWNER_EMAIL || "").toLowerCase(),
    resendKey: process.env.RESEND_API_KEY,
    mailFrom: process.env.MAIL_FROM,
    googleId: process.env.GOOGLE_CLIENT_ID,
    googleSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleLegacyId: process.env.GOOGLE_LEGACY_CLIENT_ID,
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
  if (
    !process.env.TOKEN_ENCRYPTION_KEY &&
    process.env.TOKEN_ENCRYPTION_SECRET
  )
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
  if (config.demo && !config.deliverMail)
    config.deliverMail = async () => {};
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
  const userColumns = db
    .prepare("PRAGMA table_info(users)")
    .all()
    .map((c) => c.name);
  if (!userColumns.includes("photo"))
    db.exec("ALTER TABLE users ADD COLUMN photo TEXT");
  // Existing accounts keep dashboard access; newly created accounts start setup.
  if (!userColumns.includes("onboarded"))
    db.exec(
      "ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 1",
    );
  const eventColumns = db
    .prepare("PRAGMA table_info(event_types)")
    .all()
    .map((c) => c.name);
  if (!eventColumns.includes("meeting_url"))
    db.exec(
      "ALTER TABLE event_types ADD COLUMN meeting_url TEXT NOT NULL DEFAULT ''",
    );
  const migrate = (table, columns) => {
    const existing = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    for (const [name, type] of Object.entries(columns))
      if (!existing.has(name))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  migrate("users", {
    active: "INTEGER NOT NULL DEFAULT 1",
    overrides: "TEXT NOT NULL DEFAULT '[]'",
    google_account: "TEXT",
    google_calendar: "TEXT",
    google_client_hash: "TEXT",
    google_connection_version: "INTEGER NOT NULL DEFAULT 0",
  });
  migrate("event_types", {
    instructions: "TEXT NOT NULL DEFAULT ''",
    windows: "TEXT",
    buffer_before: "INTEGER",
    buffer_after: "INTEGER",
    slot_interval: "INTEGER NOT NULL DEFAULT 15",
    slot_alignment: "TEXT NOT NULL DEFAULT 'window'",
    daily_limit: "INTEGER",
  });
  migrate("bookings", {
    google_account: "TEXT",
    google_calendar: "TEXT",
    operation_started: "TEXT",
    instructions: "TEXT NOT NULL DEFAULT ''",
    phone: "TEXT NOT NULL DEFAULT ''",
    meet_state: "TEXT NOT NULL DEFAULT 'none'",
    meet_retry_at: "INTEGER NOT NULL DEFAULT 0",
    meet_attempts: "INTEGER NOT NULL DEFAULT 0",
    buffer_before: "INTEGER",
    buffer_after: "INTEGER",
  });
  db.exec(
    "CREATE INDEX IF NOT EXISTS booking_daily_limit ON bookings(user_id,event_id,status,start)",
  );
  // Previously scheduled Meet events without a link also enter the durable recovery queue.
  db.exec(
    "UPDATE bookings SET meet_state='pending' WHERE status='scheduled' AND location='Google Meet' AND meet_url IS NULL AND google_id IS NOT NULL AND meet_state='none'",
  );
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const credentials = googleCredentials(db, config);
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
  app.use("/api/me/photo", express.json({ limit: "3mb" }));
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
      return res.status(429).json({
        error: "Too many requests. Please try again in 15 minutes.",
      });
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
    overrides: JSON.parse(u.overrides),
    active: !!u.active,
    notice: u.notice,
    horizon: u.horizon,
    buffer: u.buffer,
    googleConnected: !!credentials.credential(u),
    googleReconnectRequired:
      credentials.hasStored(u) && !credentials.credential(u),
    googleEmail: u.google_email,
    photo: u.photo || null,
    onboardingComplete: !!u.onboarded,
  });
  const encrypt = (text) => {
    need(
      config.encryptionKey,
      503,
      "Calendar encryption is not configured.",
    );
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
      if (url.startsWith("https://www.googleapis.com/calendar/")) {
        error.message = publicCalendarError;
        error.calendarDiagnostic = calendarDiagnostic(
          response.status,
          data,
        );
        console.warn("Google Calendar request failed", {
          status: response.status,
          code: error.calendarDiagnostic.code,
        });
      }
      if (url === "https://oauth2.googleapis.com/token")
        error.oauthReason = safeOAuthReason(data.error);
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
    if (flushing || closed) return;
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
          if (closed) return;
          run("UPDATE outbox SET sent=1,error=NULL WHERE id=?", item.id);
        } catch {
          if (closed) return;
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
  function createToken(
    userId,
    kind,
    email = null,
    data = null,
    minutes = 60,
  ) {
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
    need(
      typeof value === "string",
      400,
      "This link is invalid or expired.",
    );
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
    if (!s || !s.verified || !s.active)
      return res.status(401).json({ error: "Please sign in to continue." });
    req.user = s;
    if (
      !s.onboarded &&
      !/^\/api\/(?:me(?:\/photo|\/onboarding)?|google\/(?:connect|callback|status|disconnect))$/.test(
        req.path,
      )
    )
      return res.status(403).json({
        error:
          "Upload a profile picture and connect Google Calendar to finish setup.",
        code: "SETUP_REQUIRED",
      });
    next();
  }
  const admin = (req, res, next) =>
    req.user.role === "admin"
      ? next()
      : res
          .status(403)
          .json({ error: "Administrator access is required." });
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
  function addUser({
    name,
    email,
    password,
    role = "member",
    verified = 0,
  }) {
    const id = randomUUID();
    let slug = slugify(name) || "team";
    if (get("SELECT id FROM users WHERE slug=?", slug))
      slug += "-" + randomBytes(3).toString("hex");
    run(
      "INSERT INTO users(id,name,email,password,slug,role,verified,windows,created,onboarded) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      name,
      email,
      passHash(password),
      slug,
      role,
      verified,
      defaults,
      new Date().toISOString(),
      0,
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
      return res.status(409).json({
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
    const user = get("SELECT * FROM users WHERE id=?", t.user_id);
    need(user && user.active, 400, "This link is invalid or expired.");
    // Keep the token until its original expiry so reopened links can show success.
    // A repeated verification must never issue another authenticated session.
    if (user.verified) return res.json({ alreadyVerified: true });
    run("UPDATE users SET verified=1 WHERE id=?", t.user_id);
    run(
      "UPDATE tokens SET data='verified' WHERE user_id=? AND kind='verify'",
      user.id,
    );
    session(res, user);
    res.json({ user: safeUser({ ...user, verified: 1 }) });
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
    need(
      user.active,
      403,
      "This account has been deactivated. Contact your administrator.",
    );
    need(user.verified, 403, "Please verify your email before signing in.");
    session(res, user);
    res.json({ user: safeUser(user) });
  });
  app.post("/api/auth/logout", (req, res) => {
    if (req.cookies.bmt_session)
      run(
        "DELETE FROM sessions WHERE hash=?",
        hash(req.cookies.bmt_session),
      );
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
    res.json({
      message: "If an account exists, a reset link is on its way.",
    });
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
    const user = get(
      "SELECT * FROM users WHERE email=? AND verified=0",
      email,
    );
    if (user) {
      const value = createToken(user.id, "verify");
      enqueue(
        email,
        "Verify your BMT Calendar account",
        mailPage(
          "Verify your email",
          mailLink(
            "Verify email",
            `${config.baseUrl}/verify?token=${value}`,
          ),
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
  const rangeSchema = z
    .object({ start: timeSchema, end: timeSchema })
    .refine((w) => w.start < w.end, "End time must follow start time.");
  const weeklySchema = z
    .array(
      z
        .object({
          day: z.number().int().min(1).max(7),
          start: timeSchema,
          end: timeSchema,
        })
        .refine((w) => w.start < w.end, "End time must follow start time."),
    )
    .max(42);
  const dateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((d) => DateTime.fromISO(d).isValid, "Choose a valid date.");
  function validateRanges(ranges) {
    const sorted = [...ranges].sort((a, b) =>
      a.start.localeCompare(b.start),
    );
    for (let i = 1; i < sorted.length; i++)
      need(
        sorted[i - 1].end <= sorted[i].start,
        400,
        "Availability windows must not overlap.",
      );
  }
  app.patch("/api/me", auth, (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        timezone: zoneSchema,
        notice: z.number().int().min(0).max(10080),
        horizon: z.number().int().min(1).max(180),
        buffer: z.number().int().min(0).max(120),
        overrides: z
          .array(
            z.object({
              date: dateSchema,
              windows: z.array(rangeSchema).max(6),
            }),
          )
          .max(366)
          .optional(),
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
          .max(42),
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
    if (body.overrides) {
      need(
        new Set(body.overrides.map((o) => o.date)).size ===
          body.overrides.length,
        400,
        "Use one override per date.",
      );
      body.overrides.forEach((o) => validateRanges(o.windows));
    }
    run(
      "UPDATE users SET name=?,timezone=?,notice=?,horizon=?,buffer=?,windows=?,overrides=? WHERE id=?",
      body.name,
      body.timezone,
      body.notice,
      body.horizon,
      body.buffer,
      JSON.stringify(body.windows),
      body.overrides ? JSON.stringify(body.overrides) : req.user.overrides,
      req.user.id,
    );
    res.json({
      user: safeUser(get("SELECT * FROM users WHERE id=?", req.user.id)),
    });
  });
  app.put("/api/me/photo", auth, async (req, res) => {
    const image = z
      .string()
      .max(2_800_000)
      .regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
      .parse(req.body.image);
    const bytes = Buffer.from(
      image.slice(image.indexOf(",") + 1),
      "base64",
    );
    need(
      bytes.length <= 2 * 1024 * 1024,
      400,
      "Choose a photo smaller than 2 MB.",
    );
    let encoded;
    try {
      // Decode and re-encode to discard metadata and active or non-image content.
      encoded = await sharp(bytes, {
        limitInputPixels: 20_000_000,
        animated: false,
      })
        .rotate()
        .resize(256, 256, { fit: "cover" })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      throw new HttpError(
        400,
        "Choose a valid JPG, PNG, or WebP photo smaller than 20 megapixels.",
      );
    }
    run(
      "UPDATE users SET photo=? WHERE id=?",
      "data:image/jpeg;base64," + encoded.toString("base64"),
      req.user.id,
    );
    res.json({
      user: safeUser(get("SELECT * FROM users WHERE id=?", req.user.id)),
    });
  });
  app.delete("/api/me/photo", auth, (req, res) => {
    run("UPDATE users SET photo=NULL WHERE id=?", req.user.id);
    res.json({
      user: safeUser(get("SELECT * FROM users WHERE id=?", req.user.id)),
    });
  });
  app.post("/api/me/onboarding", auth, async (req, res) => {
    need(
      req.user.photo,
      409,
      "Upload a profile picture before finishing setup.",
    );
    need(
      credentials.credential(req.user),
      409,
      "Connect Google Calendar before finishing setup.",
    );
    const now = DateTime.now().toUTC();
    await busy(req.user, now.toISO(), now.plus({ days: 1 }).toISO());
    const fresh = get("SELECT * FROM users WHERE id=?", req.user.id);
    need(
      fresh.active &&
        fresh.photo &&
        fresh.google_refresh === req.user.google_refresh &&
        fresh.google_connection_version ===
          req.user.google_connection_version,
      409,
      "Your profile or connection changed. Please finish setup again.",
    );
    run("UPDATE users SET onboarded=1 WHERE id=?", req.user.id);
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
  const eventSchema = z
    .object({
      title: z.string().trim().min(2).max(80),
      duration: z.number().int().min(15).max(240).multipleOf(15),
      description: z.string().max(2000).default(""),
      location: z.enum(["Google Meet", "Zoom", "Phone call", "In person"]),
      meetingUrl: z.string().trim().max(2048).default(""),
      instructions: z.string().trim().max(1000).default(""),
      color: z.enum([
        "#6366f1",
        "#10b981",
        "#f59e0b",
        "#ec4899",
        "#3b82f6",
      ]),
      active: z.boolean().default(true),
      windows: weeklySchema.nullable().optional(),
      bufferBefore: z.number().int().min(0).max(120).nullable().optional(),
      bufferAfter: z.number().int().min(0).max(120).nullable().optional(),
      slotInterval: z
        .union([5, 10, 15, 20, 30, 60, 90, 120].map((n) => z.literal(n)))
        .optional(),
      slotAlignment: z.enum(["window", "clock"]).optional(),
      dailyLimit: z.number().int().min(1).max(1000).nullable().optional(),
    })
    .superRefine((event, ctx) => {
      if (event.windows) {
        for (let day = 1; day <= 7; day++) {
          const ranges = event.windows
            .filter((w) => w.day === day)
            .sort((a, b) => a.start.localeCompare(b.start));
          if (ranges.some((w, i) => i && ranges[i - 1].end > w.start))
            ctx.addIssue({
              code: "custom",
              path: ["windows"],
              message: "Availability windows must not overlap.",
            });
        }
      }
      if (
        ["Phone call", "In person"].includes(event.location) &&
        !event.instructions
      )
        ctx.addIssue({
          code: "custom",
          path: ["instructions"],
          message:
            "Add calling instructions or the meeting address before saving.",
        });
      if (event.location !== "Zoom") return;
      let valid = false;
      try {
        const url = new URL(event.meetingUrl);
        valid =
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          (!url.port || url.port === "443") &&
          ["zoom.us", "zoom.com", "zoomgov.com"].some(
            (domain) =>
              url.hostname === domain ||
              url.hostname.endsWith("." + domain),
          ) &&
          /^\/(?:j\/\d+|s\/\d+|my\/[^/]+)(?:\/|$)/.test(url.pathname);
      } catch {}
      if (!valid)
        ctx.addIssue({
          code: "custom",
          path: ["meetingUrl"],
          message:
            "Add a valid HTTPS Zoom meeting link (for example, https://us02web.zoom.us/j/1234567890).",
        });
    });
  app.post("/api/events", auth, (req, res) => {
    const b = eventSchema.parse(req.body);
    const id = randomUUID();
    const slug =
      (slugify(b.title) || "meeting") +
      "-" +
      randomBytes(2).toString("hex");
    run(
      "INSERT INTO event_types(id,user_id,title,slug,duration,description,location,color,active,meeting_url,instructions,windows,buffer_before,buffer_after,slot_interval,slot_alignment,daily_limit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      req.user.id,
      b.title,
      slug,
      b.duration,
      b.description,
      b.location,
      b.color,
      Number(b.active),
      b.location === "Zoom" ? b.meetingUrl : "",
      b.instructions,
      b.windows == null ? null : JSON.stringify(b.windows),
      b.bufferBefore ?? null,
      b.bufferAfter ?? null,
      b.slotInterval ?? 15,
      b.slotAlignment ?? "window",
      b.dailyLimit ?? null,
    );
    res
      .status(201)
      .json({ event: get("SELECT * FROM event_types WHERE id=?", id) });
  });
  app.patch("/api/events/:id", auth, (req, res) => {
    const b = eventSchema.parse(req.body);
    const existing = get(
      "SELECT * FROM event_types WHERE id=? AND user_id=?",
      req.params.id,
      req.user.id,
    );
    need(existing, 404, "Event type not found.");
    run(
      "UPDATE event_types SET title=?,duration=?,description=?,location=?,color=?,active=?,meeting_url=?,instructions=?,windows=?,buffer_before=?,buffer_after=?,slot_interval=?,slot_alignment=?,daily_limit=? WHERE id=?",
      b.title,
      b.duration,
      b.description,
      b.location,
      b.color,
      Number(b.active),
      b.location === "Zoom" ? b.meetingUrl : "",
      b.instructions,
      b.windows === undefined
        ? existing.windows
        : b.windows === null
          ? null
          : JSON.stringify(b.windows),
      b.bufferBefore === undefined
        ? existing.buffer_before
        : b.bufferBefore,
      b.bufferAfter === undefined ? existing.buffer_after : b.bufferAfter,
      b.slotInterval ?? existing.slot_interval,
      b.slotAlignment ?? existing.slot_alignment,
      b.dailyLimit === undefined ? existing.daily_limit : b.dailyLimit,
      req.params.id,
    );
    res.json({ ok: true });
  });
  app.get("/api/team", auth, (req, res) =>
    res.json({
      users: all(
        `SELECT * FROM users WHERE verified=1 ${req.user.role === "admin" ? "" : "AND active=1"} ORDER BY created`,
      ).map((u) => ({
        id: u.id,
        name: u.name,
        photo: u.photo,
        slug: u.slug,
        role: u.role,
        active: !!u.active,
        ...(req.user.role === "admin"
          ? { email: u.email, googleConnected: !!credentials.credential(u) }
          : {}),
      })),
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
  app.patch("/api/team/:id", auth, admin, (req, res) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const member = get("SELECT * FROM users WHERE id=?", req.params.id);
    need(member, 404, "Team member not found.");
    need(
      member.id !== req.user.id,
      409,
      "You cannot deactivate your own account.",
    );
    need(
      member.role !== "admin" ||
        active ||
        get("SELECT count(*) n FROM users WHERE role='admin' AND active=1")
          .n > 1,
      409,
      "Keep at least one active administrator.",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      run(
        "UPDATE users SET active=? WHERE id=?",
        Number(active),
        member.id,
      );
      if (!active) {
        run("DELETE FROM sessions WHERE user_id=?", member.id);
        run("DELETE FROM tokens WHERE user_id=?", member.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    res.json({ ok: true });
  });
  app.post("/api/team/:id/revoke-sessions", auth, admin, (req, res) => {
    need(
      get("SELECT id FROM users WHERE id=?", req.params.id),
      404,
      "Team member not found.",
    );
    run("DELETE FROM sessions WHERE user_id=?", req.params.id);
    run("DELETE FROM tokens WHERE user_id=?", req.params.id);
    res.json({ ok: true });
  });
  function bookingQuery(req) {
    const q = z
      .object({
        team: z.enum(["true", "false"]).default("false"),
        filter: z
          .enum(["all", "upcoming", "past", "cancelled", "pending"])
          .default("all"),
        search: z.string().max(200).default(""),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(req.query);
    need(
      q.team !== "true" || req.user.role === "admin",
      403,
      "Administrator access is required.",
    );
    const clauses = ["1=1"],
      params = [];
    if (q.team !== "true") {
      clauses.push("b.user_id=?");
      params.push(req.user.id);
    }
    if (q.filter === "upcoming" || q.filter === "past") {
      clauses.push(
        `b.status='scheduled' AND b.end${q.filter === "upcoming" ? ">" : "<="}?`,
      );
      params.push(new Date().toISOString());
    } else if (q.filter !== "all") {
      clauses.push("b.status=?");
      params.push(q.filter);
    }
    if (q.search) {
      clauses.push(
        "instr(lower(b.name || ' ' || b.email || ' ' || b.title), lower(?)) > 0",
      );
      params.push(q.search);
    }
    if (q.from) {
      clauses.push("b.start>=?");
      params.push(DateTime.fromISO(q.from).toUTC().toISO());
    }
    if (q.to) {
      clauses.push("b.start<?");
      params.push(DateTime.fromISO(q.to).toUTC().toISO());
    }
    return { where: clauses.join(" AND "), params };
  }
  app.get("/api/bookings", auth, (req, res) => {
    const { where, params } = bookingQuery(req);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .default(250)
      .parse(req.query.limit);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse(req.query.offset);
    const total = get(
      `SELECT count(*) n FROM bookings b WHERE ${where}`,
      ...params,
    ).n;
    const bookings = all(
      `SELECT b.*,u.name AS host_name FROM bookings b JOIN users u ON u.id=b.user_id WHERE ${where} ORDER BY b.start DESC,b.id LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    res.json({
      bookings: bookings.map(cleanBooking),
      total,
      nextOffset:
        offset + bookings.length < total ? offset + bookings.length : null,
    });
  });
  app.get("/api/bookings/export", auth, (req, res) => {
    const { where, params } = bookingQuery(req);
    const fields = [
      "title",
      "name",
      "email",
      "phone",
      "start",
      "end",
      "timezone",
      "status",
      "location",
      "instructions",
      "host_name",
    ];
    const cell = (value) =>
      '"' +
      String(value ?? "")
        .replace(/^[\s]*[=+@\-]/, "'$&")
        .replaceAll('"', '""') +
      '"';
    const rows = db
      .prepare(
        `SELECT b.*,u.name AS host_name FROM bookings b JOIN users u ON u.id=b.user_id WHERE ${where} ORDER BY b.start DESC,b.id`,
      )
      .iterate(...params);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="bmt-appointments.csv"',
    });
    // SQLite iteration gives this export one consistent read; no page-size truncation.
    res.send(
      [
        fields.join(","),
        ...Array.from(rows, (b) => fields.map((f) => cell(b[f])).join(",")),
      ].join("\r\n"),
    );
  });
  function requireGoogleCredential(user) {
    need(
      credentials.hasStored(user),
      409,
      "This host has not connected Google Calendar yet.",
    );
    const selected = credentials.credential(user);
    if (!selected) {
      const error = new HttpError(503, publicCalendarError);
      error.calendarDiagnostic = {
        code: "CLIENT_RECONNECT_REQUIRED",
        message:
          "Reconnect Google Calendar for the new BMT Calendar connection. Use the same Google account and calendar. Your existing appointments are preserved.",
        diagnostics: {},
      };
      throw error;
    }
    return selected;
  }
  async function accessToken(user) {
    const selected = requireGoogleCredential(user);
    try {
      const data = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.googleId,
          client_secret: config.googleSecret,
          refresh_token: decrypt(selected.encryptedRefresh),
          grant_type: "refresh_token",
        }),
      });
      return data.access_token;
    } catch (cause) {
      const error = new HttpError(503, publicCalendarError);
      error.calendarDiagnostic = oauthDiagnostic(
        cause.providerStatus,
        cause.oauthReason,
      );
      throw error;
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
  const accountId = (u) =>
    u.google_account ||
    u.google_email?.toLowerCase() ||
    (config.calendarProvider ? "test-provider" : null);
  const calendarId = (u) =>
    u.google_calendar || u.google_email?.toLowerCase() || "primary";
  const calendarPath = (u, b) =>
    `calendars/${encodeURIComponent(b?.google_calendar || calendarId(u))}/events`;
  const appointmentLocks = new Set();
  const connectionChanges = new Set();
  async function withBookingLock(b, fn) {
    const key = b.parent_id || b.id;
    need(
      !appointmentLocks.has(key),
      409,
      "Another change to this appointment is in progress. Please try again shortly.",
    );
    appointmentLocks.add(key);
    try {
      return await fn();
    } finally {
      appointmentLocks.delete(key);
    }
  }
  const hasOpenBookings = (id) =>
    get(
      "SELECT id FROM bookings WHERE user_id=? AND (status='pending' OR (status='scheduled' AND end>?))",
      id,
      new Date().toISOString(),
    );
  async function lookupEvent(u, b) {
    return config.calendarProvider
      ? config.calendarProvider.lookup(u, b)
      : google(
          u,
          `${calendarPath(u, b)}/${encodeURIComponent(b.google_id)}`,
        );
  }
  async function boundUser(b) {
    const u = get("SELECT * FROM users WHERE id=?", b.user_id);
    if (!b.google_id) return u;
    if (config.demo && u.email === "demo@bmtcalendar.local") return u;
    if (!config.calendarProvider) requireGoogleCredential(u);
    need(
      accountId(u),
      409,
      "Reconnect the original Google account before changing this appointment.",
    );
    const bindingMatches = (record) =>
      record &&
      (!record.google_account || record.google_account === accountId(u)) &&
      (!record.google_calendar || record.google_calendar === calendarId(u));
    need(
      bindingMatches(b),
      409,
      "Reconnect this appointment's original Google account and calendar before changing it.",
    );
    if (!b.google_account || !b.google_calendar) {
      // Never assume a legacy booking belongs to whichever account is connected now.
      let remote;
      try {
        remote = await lookupEvent(u, b);
      } catch {}
      const expected = b.parent_id
        ? get("SELECT * FROM bookings WHERE id=?", b.parent_id)
        : b;
      need(
        bindingMatches(expected),
        409,
        "The original appointment belongs to a different Google account or calendar.",
      );
      const matches = (candidate) =>
        candidate &&
        remote &&
        remote.status !== "cancelled" &&
        remote.id === b.google_id &&
        remote.organizer?.self === true &&
        remote.organizer.email?.toLowerCase() ===
          calendarId(u).toLowerCase() &&
        DateTime.fromISO(remote.start?.dateTime || "").toMillis() ===
          DateTime.fromISO(candidate.start).toMillis() &&
        DateTime.fromISO(remote.end?.dateTime || "").toMillis() ===
          DateTime.fromISO(candidate.end).toMillis();
      need(
        matches(b) || matches(expected),
        409,
        "This older appointment's original calendar is unverified. Reconnect its original Google account and check the event before changing it.",
      );
      // OAuth may have completed while the legacy event lookup was in flight.
      // Do not establish a binding from stale credentials and strand the booking.
      const current = get("SELECT * FROM users WHERE id=?", u.id);
      need(
        accountId(current) === accountId(u) &&
          calendarId(current) === calendarId(u) &&
          current.google_refresh === u.google_refresh &&
          current.google_connection_version === u.google_connection_version,
        409,
        "The calendar connection changed during verification. Please try again.",
      );
      run(
        "UPDATE bookings SET google_account=?,google_calendar=? WHERE id=? OR id=?",
        accountId(u),
        calendarId(u),
        b.id,
        expected.id,
      );
      b.google_account = accountId(u);
      b.google_calendar = calendarId(u);
    }
    need(
      b.google_account === accountId(u) &&
        b.google_calendar === calendarId(u),
      409,
      "Reconnect this appointment's original Google account and calendar before changing it.",
    );
    return u;
  }
  async function busy(user, start, end, exclude = null) {
    const local = all(
      "SELECT start,end,buffer_before,buffer_after FROM bookings WHERE user_id=? AND status IN ('scheduled','pending') AND id<>? AND start<? AND end>?",
      user.id,
      exclude?.id || "",
      end,
      start,
    ).map((b) => ({ ...b, ...bookingBuffers(user, b) }));
    if (config.calendarProvider)
      return [
        ...local,
        ...(await config.calendarProvider.busy(user, start, end, exclude)),
      ];
    if (config.demo && user.email === "demo@bmtcalendar.local")
      return local;
    if (exclude?.google_id) {
      // Free/busy merges overlapping events. Subtracting the old interval could hide
      // another event, so enumerate every page and exclude only the exact event ID.
      let pageToken,
        occupied = [];
      do {
        const query = new URLSearchParams({
          timeMin: start,
          timeMax: end,
          singleEvents: "true",
          maxResults: "2500",
          ...(pageToken ? { pageToken } : {}),
        });
        const data = await google(
          user,
          `${calendarPath(user, exclude)}?${query}`,
        );
        need(
          Array.isArray(data.items),
          503,
          "Calendar availability could not be checked.",
        );
        for (const event of data.items) {
          if (
            event.id === exclude.google_id ||
            event.status === "cancelled" ||
            event.transparency === "transparent" ||
            event.attendees?.some(
              (a) => a.self && a.responseStatus === "declined",
            )
          )
            continue;
          const zone = data.timeZone || user.timezone;
          const from =
            event.start?.dateTime ||
            DateTime.fromISO(event.start?.date || "", { zone })
              .toUTC()
              .toISO();
          const to =
            event.end?.dateTime ||
            DateTime.fromISO(event.end?.date || "", { zone })
              .toUTC()
              .toISO();
          need(
            from && to,
            503,
            "Calendar availability could not be checked.",
          );
          occupied.push({ start: from, end: to });
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
      return [...local, ...occupied];
    }
    const id = calendarId(user);
    const data = await google(user, "freeBusy", "POST", {
      timeMin: start,
      timeMax: end,
      items: [{ id }],
    });
    if (
      data.calendars?.[id]?.errors?.length ||
      !Array.isArray(data.calendars?.[id]?.busy)
    ) {
      const error = new HttpError(503, publicCalendarError);
      error.calendarDiagnostic = calendarDiagnostic(200, {
        error: { errors: data.calendars?.[id]?.errors },
      });
      throw error;
    }
    return [...local, ...data.calendars[id].busy];
  }
  app.get("/api/google/status", auth, async (req, res) => {
    if (!credentials.hasStored(req.user))
      return res.json({
        healthy: false,
        code: "NOT_CONNECTED",
        message: "Connect your Google Calendar first.",
      });
    try {
      const start = DateTime.now().toUTC(),
        end = start.plus({ days: 1 });
      await busy(req.user, start.toISO(), end.toISO());
      res.json({
        healthy: true,
        message: "Google Calendar availability is working.",
      });
    } catch (error) {
      const diagnostic =
        error.calendarDiagnostic || calendarDiagnostic(503, {});
      res.json({
        healthy: false,
        ...diagnostic,
      });
    }
  });
  function publicEvent(host, slug) {
    const u = get(
      "SELECT * FROM users WHERE slug=? AND verified=1 AND active=1 AND onboarded=1",
      host,
    );
    need(u, 404, "This scheduling page was not found.");
    const e = get(
      "SELECT * FROM event_types WHERE user_id=? AND slug=? AND active=1",
      u.id,
      slug,
    );
    need(e, 404, "This event is not available for booking.");
    return { u, e };
  }
  const eventBuffers = (u, e) => ({
    before: e.buffer_before ?? u.buffer,
    after: e.buffer_after ?? u.buffer,
  });
  const bookingBuffers = (u, b) => ({
    before: b.buffer_before ?? u.buffer,
    after: b.buffer_after ?? u.buffer,
  });
  // A gap can satisfy both appointments' buffers. Taking the larger required
  // gap preserves the existing shared-buffer behavior instead of doubling it.
  function overlaps(start, end, buffers, occupied) {
    const from = Date.parse(start),
      to = Date.parse(end);
    return occupied.some(
      (b) =>
        Date.parse(b.start) <
          to + Math.max(buffers.after, b.before || 0) * 60_000 &&
        Date.parse(b.end) >
          from - Math.max(buffers.before, b.after || 0) * 60_000,
    );
  }
  function dayCount(u, e, start, exclude = null) {
    const day = DateTime.fromISO(start).setZone(u.timezone).startOf("day");
    // A pending reschedule occupies both days until its outcome is known, but
    // the original and reservation count only once when they share a day.
    return get(
      "SELECT COUNT(DISTINCT COALESCE(parent_id,id)) AS n FROM bookings WHERE user_id=? AND event_id=? AND status IN ('scheduled','pending') AND id<>? AND COALESCE(parent_id,id)<>? AND start>=? AND start<?",
      u.id,
      e.id,
      exclude?.id || "",
      exclude?.id || "",
      day.toUTC().toISO(),
      day.plus({ days: 1 }).toUTC().toISO(),
    ).n;
  }
  function underDailyLimit(u, e, start, exclude = null) {
    return (
      e.daily_limit === null ||
      dayCount(u, e, start, exclude) < e.daily_limit
    );
  }
  function assertReservationAvailable(u, e, start, end, exclude = null) {
    // Called inside BEGIN IMMEDIATE, after provider I/O and before reserving.
    // Reject stale settings rather than booking with a mixture of old/new rules.
    const freshUser = get("SELECT * FROM users WHERE id=?", u.id),
      freshEvent = get("SELECT * FROM event_types WHERE id=?", e.id);
    need(
      JSON.stringify(freshEvent) === JSON.stringify(e) &&
        [
          "windows",
          "overrides",
          "timezone",
          "buffer",
          "notice",
          "horizon",
          "active",
          "onboarded",
          "google_refresh",
          "google_connection_version",
        ].every((key) => freshUser[key] === u[key]),
      409,
      "The host's scheduling settings changed. Please refresh and choose a time.",
    );
    need(
      candidateSlots(
        u,
        e,
        DateTime.fromISO(start).setZone(u.timezone).toISODate(),
        u.timezone,
      ).includes(start),
      409,
      "That time is no longer available. Please choose another time.",
    );
    need(
      underDailyLimit(u, e, start, exclude),
      409,
      "This event's daily booking limit has been reached. Please choose another day.",
    );
    const occupied = all(
      "SELECT start,end,buffer_before,buffer_after FROM bookings WHERE user_id=? AND status IN ('scheduled','pending') AND id<>? AND start<? AND end>?",
      u.id,
      exclude?.id || "",
      DateTime.fromISO(end).plus({ minutes: 120 }).toUTC().toISO(),
      DateTime.fromISO(start).minus({ minutes: 120 }).toUTC().toISO(),
    ).map((b) => ({ ...b, ...bookingBuffers(u, b) }));
    need(
      !overlaps(start, end, eventBuffers(u, e), occupied),
      409,
      "That time was just booked. Please choose another time.",
    );
  }
  function candidateSlots(u, e, date, zone) {
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

    const windows = JSON.parse(u.windows),
      result = [];
    const hostStart = day.startOf("day").setZone(u.timezone).startOf("day");
    for (let d = 0; d < 3; d++) {
      const hostDay = hostStart.plus({ days: d });
      const override = JSON.parse(u.overrides).find(
        (o) => o.date === hostDay.toISODate(),
      );
      const overall = override
        ? override.windows
        : windows.filter((w) => w.day === hostDay.weekday);
      const eventWindows =
        e.windows === null ? null : JSON.parse(e.windows);
      const effective =
        eventWindows === null
          ? overall
          : overall.flatMap((a) =>
              eventWindows
                .filter((b) => b.day === hostDay.weekday)
                .map((b) => ({
                  start: a.start > b.start ? a.start : b.start,
                  end: a.end < b.end ? a.end : b.end,
                }))
                .filter((w) => w.start < w.end),
            );
      for (const w of effective) {
        const [h, m] = w.start.split(":").map(Number),
          [eh, em] = w.end.split(":").map(Number);
        const startMinute = h * 60 + m,
          endMinute = eh * 60 + em;
        const firstMinute =
          e.slot_alignment === "clock"
            ? Math.ceil(startMinute / e.slot_interval) * e.slot_interval
            : startMinute;
        // Enumerate host wall-clock starts, then resolve both offsets of a repeated
        // hour. Nonexistent spring-forward starts must never be normalized forward.
        for (
          let minute = firstMinute;
          minute < endMinute;
          minute += e.slot_interval
        ) {
          const wall = hostDay.set({
            hour: Math.floor(minute / 60),
            minute: minute % 60,
            second: 0,
            millisecond: 0,
          });
          if (wall.hour * 60 + wall.minute !== minute) continue;
          for (const t of wall.getPossibleOffsets()) {
            const end = t.plus({ minutes: e.duration });
            if (
              end.toISODate() !== hostDay.toISODate() ||
              (t.offset === end.offset && end.toFormat("HH:mm") > w.end) ||
              t.setZone(zone).toISODate() !== date ||
              t < now.plus({ minutes: u.notice }) ||
              t > now.plus({ days: u.horizon })
            )
              continue;
            // On a repeated clock hour, endpoints alone can straddle a closed
            // part of a short working window. Check the intervening wall minutes.
            if (t.offset !== end.offset) {
              let fits = true;
              for (
                let cursor = t;
                cursor < end;
                cursor = cursor.plus({ minutes: 1 })
              ) {
                const wall = cursor.toFormat("HH:mm");
                if (wall < w.start || wall >= w.end) {
                  fits = false;
                  break;
                }
              }
              if (!fits) continue;
            }
            result.push(t.toUTC().toISO());
          }
        }
      }
    }
    return [...new Set(result)].sort();
  }
  async function slots(u, e, date, zone, exclude = null) {
    const counts = new Map();
    const hasCapacity = (start) => {
      if (e.daily_limit === null) return true;
      const day = DateTime.fromISO(start).setZone(u.timezone).toISODate();
      if (!counts.has(day))
        counts.set(day, underDailyLimit(u, e, start, exclude));
      return counts.get(day);
    };
    const candidates = candidateSlots(u, e, date, zone).filter(hasCapacity);
    if (!candidates.length) return [];
    const day = DateTime.fromISO(date, { zone });
    const occupied = await busy(
      u,
      day.startOf("day").minus({ days: 1 }).toUTC().toISO(),
      day.endOf("day").plus({ days: 1 }).toUTC().toISO(),
      exclude,
    );
    counts.clear();
    return candidates.filter(
      (start) =>
        hasCapacity(start) &&
        !overlaps(
          start,
          DateTime.fromISO(start)
            .plus({ minutes: e.duration })
            .toUTC()
            .toISO(),
          eventBuffers(u, e),
          occupied,
        ),
    );
  }
  app.get("/api/public/:host/:event/dates", (req, res) => {
    const { u, e } = publicEvent(req.params.host, req.params.event),
      zone = zoneSchema.parse(req.query.timezone || u.timezone);
    const month = z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .parse(req.query.month);
    const first = DateTime.fromISO(month + "-01", { zone });
    need(first.isValid, 400, "Choose a valid month.");
    const dates = [],
      capacity = new Map();
    const hasCapacity = (start) => {
      const hostDate = DateTime.fromISO(start)
        .setZone(u.timezone)
        .toISODate();
      if (!capacity.has(hostDate))
        capacity.set(hostDate, underDailyLimit(u, e, start));
      return capacity.get(hostDate);
    };
    for (let i = 0; i < first.daysInMonth; i++) {
      const date = first.plus({ days: i }).toISODate();
      if (candidateSlots(u, e, date, zone).some(hasCapacity))
        dates.push(date);
    }
    res.json({ dates });
  });
  app.get("/api/public/:host", (req, res) => {
    const u = get(
      "SELECT * FROM users WHERE slug=? AND verified=1 AND active=1 AND onboarded=1",
      req.params.host,
    );
    need(u, 404, "This scheduling page was not found.");
    res.json({
      host: {
        name: u.name,
        slug: u.slug,
        timezone: u.timezone,
        photo: u.photo,
      },
      events: all(
        "SELECT title,slug,duration,description,location,color,instructions FROM event_types WHERE user_id=? AND active=1",
        u.id,
      ),
    });
  });
  app.get("/api/public/:host/:event", (req, res) => {
    const { u, e } = publicEvent(req.params.host, req.params.event);
    res.json({
      host: {
        name: u.name,
        slug: u.slug,
        timezone: u.timezone,
        photo: u.photo,
      },
      event: {
        title: e.title,
        slug: e.slug,
        duration: e.duration,
        description: e.description,
        location: e.location,
        instructions: e.instructions,
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
  app.get("/api/manage/:token/slots", async (req, res) => {
    const b = managed(req.params.token);
    need(
      b.status === "scheduled",
      409,
      "This appointment cannot be rescheduled.",
    );
    const u = await boundUser(b),
      e = get("SELECT * FROM event_types WHERE id=?", b.event_id);
    need(
      u.active && e.active,
      409,
      "This host is not accepting rescheduling. Contact the host.",
    );
    res.json({
      slots: await slots(
        u,
        e,
        String(req.query.date),
        zoneSchema.parse(req.query.timezone || b.timezone),
        b,
      ),
    });
  });
  function bookingMail(b, u, manageToken, changed = false) {
    const when = DateTime.fromISO(b.start)
      .setZone(b.timezone)
      .toFormat("cccc, LLLL d, yyyy · h:mm a ZZZZ");
    const body = `<p>${esc(b.title)} with ${esc(u.name)}</p><p><strong>${esc(when)}</strong></p><p>${esc(b.location)}</p>${b.instructions ? `<p>${esc(b.instructions)}</p>` : ""}${b.phone ? `<p>Guest phone: ${esc(b.phone)}</p>` : ""}${b.meet_state === "pending" ? "<p>Your Google Meet link is being prepared. We will email it when ready.</p>" : ""}${b.meet_url ? mailLink(b.location === "Zoom" ? "Join Zoom" : "Join Google Meet", b.meet_url) : ""}${manageToken ? mailLink("Manage appointment", `${config.baseUrl}/manage/${manageToken}`) : ""}`;
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
    if (config.calendarProvider)
      return config.calendarProvider.create(u, e, b);
    if (config.demo && u.email === "demo@bmtcalendar.local") return {};
    const event = {
      id: b.id.replaceAll("-", ""),
      summary: e.title,
      description: `Guest: ${b.name} (${b.email})\n${b.phone ? "Phone: " + b.phone + "\n" : ""}${e.instructions || ""}\n${b.notes}`,
      start: { dateTime: b.start },
      end: { dateTime: b.end },
      attendees: [{ email: b.email }, { email: u.email }],
      location:
        e.location === "Zoom"
          ? e.meeting_url
          : e.instructions || e.location,
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
        `${calendarPath(u, b)}?conferenceDataVersion=1&sendUpdates=all`,
        "POST",
        event,
      );
    } catch (error) {
      if (error.providerStatus === 409)
        return google(u, `${calendarPath(u, b)}/${event.id}`);
      throw error;
    }
  }
  const guestSchema = z.object({
    name: z.string().trim().min(2).max(80),
    email: emailSchema,
    notes: z.string().max(2000).default(""),
    phone: z.string().trim().max(40).default(""),
    timezone: zoneSchema,
    start: z.iso.datetime({ offset: true }),
  });
  const cleanBooking = (b) => {
    const { manage_hash, google_account, google_calendar, ...clean } = b;
    return clean;
  };
  app.post("/api/public/:host/:event/bookings", async (req, res) => {
    mailReady();
    const { u, e } = publicEvent(req.params.host, req.params.event);
    const b = guestSchema.parse(req.body);
    need(
      e.location !== "Phone call" ||
        (/^[+()\d .-]{7,40}$/.test(b.phone) &&
          b.phone.replace(/\D/g, "").length >= 7),
      400,
      "Enter a phone number where the host can reach you.",
    );
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
    const currentHost = get("SELECT * FROM users WHERE id=?", u.id);
    need(
      !connectionChanges.has(u.id) &&
        currentHost.active &&
        currentHost.onboarded &&
        currentHost.google_refresh === u.google_refresh &&
        currentHost.google_connection_version ===
          u.google_connection_version,
      409,
      "The host's calendar connection changed. Please try again.",
    );
    const id = randomUUID(),
      manage = token();
    db.exec("BEGIN IMMEDIATE");
    try {
      assertReservationAvailable(u, e, start, end);
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
      // Deterministic Google IDs allow reconciliation after a timeout or a process restart.
      run(
        "UPDATE bookings SET google_id=?,meet_url=?,google_account=?,google_calendar=?,instructions=?,phone=?,buffer_before=?,buffer_after=? WHERE id=?",
        id.replaceAll("-", ""),
        e.location === "Zoom" ? e.meeting_url : null,
        accountId(u),
        calendarId(u),
        e.instructions,
        b.phone,
        eventBuffers(u, e).before,
        eventBuffers(u, e).after,
        id,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return withBookingLock({ id }, async () => {
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
          void flushMail();
        }
        throw new HttpError(
          503,
          "The calendar did not confirm this appointment. Please contact the host before trying again.",
        );
      }
      let saved;
      db.exec("BEGIN IMMEDIATE");
      try {
        const meet =
          e.location === "Zoom"
            ? e.meeting_url
            : remote.hangoutLink || null;
        run(
          "UPDATE bookings SET status='scheduled',google_id=?,meet_url=?,meet_state=? WHERE id=?",
          remote.id || null,
          meet,
          e.location === "Google Meet" && !meet && remote.id
            ? "pending"
            : "none",
          id,
        );
        saved = get("SELECT * FROM bookings WHERE id=?", id);
        bookingMail(saved, u, manage);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      void flushMail();
      res.status(201).json({
        booking: cleanBooking(saved),
        manageUrl: `${config.baseUrl}/manage/${manage}`,
      });
    });
  });
  function managed(value) {
    need(
      typeof value === "string" && value.length === 64,
      404,
      "Appointment not found.",
    );
    const b = get(
      "SELECT * FROM bookings WHERE manage_hash=?",
      hash(value),
    );
    need(b, 404, "Appointment not found.");
    return b;
  }
  app.get("/api/manage/:token", (req, res) => {
    const b = managed(req.params.token),
      u = get("SELECT * FROM users WHERE id=?", b.user_id),
      e = get("SELECT * FROM event_types WHERE id=?", b.event_id);
    res.json({
      booking: cleanBooking(b),
      host: { name: u.name, slug: u.slug, photo: u.photo },
      event: { slug: e.slug, active: !!e.active && !!u.active },
    });
  });
  async function cancel(b) {
    return withBookingLock(b, async () => {
      b = get("SELECT * FROM bookings WHERE id=?", b.id);
      need(
        !get(
          "SELECT id FROM bookings WHERE parent_id=? AND status='pending'",
          b.id,
        ),
        409,
        "Resolve the pending change before cancelling this appointment.",
      );
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
      const u = await boundUser(b);
      run(
        "UPDATE bookings SET status='pending',operation='cancel',operation_started=? WHERE id=?",
        new Date().toISOString(),
        b.id,
      );
      try {
        if (b.google_id) {
          if (config.calendarProvider)
            await config.calendarProvider.cancel(u, b);
          else {
            try {
              await google(
                u,
                `${calendarPath(u, b)}/${encodeURIComponent(b.google_id)}?sendUpdates=all`,
                "DELETE",
              );
            } catch (error) {
              if (
                error.providerStatus !== 404 &&
                error.providerStatus !== 410
              )
                throw error;
            }
          }
        }
      } catch (error) {
        if (error.providerStatus >= 400 && error.providerStatus < 500)
          run(
            "UPDATE bookings SET status='scheduled',operation='create' WHERE id=?",
            b.id,
          );
        throw new HttpError(
          503,
          "The calendar did not confirm the cancellation. Check calendar status before trying again.",
        );
      }
      finishCancellation(b, u);
    });
  }
  function finishCancellation(b, u) {
    db.exec("BEGIN IMMEDIATE");
    try {
      run(
        "UPDATE bookings SET status='cancelled',operation='create' WHERE id=?",
        b.id,
      );
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
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    void flushMail();
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
    return withBookingLock(managed(req.params.token), async () => {
      const old = managed(req.params.token);
      need(
        !get(
          "SELECT id FROM bookings WHERE parent_id=? AND status='pending'",
          old.id,
        ),
        409,
        "Resolve the pending reschedule before making another change.",
      );
      need(
        old.status === "scheduled" &&
          DateTime.fromISO(old.start) > DateTime.now(),
        409,
        "This appointment cannot be rescheduled.",
      );
      const u = await boundUser(old),
        e = get("SELECT * FROM event_types WHERE id=?", old.event_id);
      need(
        u.active && e.active,
        409,
        "This event type is no longer accepting bookings.",
      );
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
      need(
        start !== old.start,
        400,
        "Choose a different appointment time.",
      );
      const available = await slots(
        u,
        e,
        DateTime.fromISO(start).setZone(input.timezone).toISODate(),
        input.timezone,
        old,
      );
      need(
        available.includes(start),
        409,
        "That time is no longer available. Please choose another time.",
      );
      const currentHost = get("SELECT * FROM users WHERE id=?", u.id);
      need(
        currentHost.active &&
          currentHost.google_refresh === u.google_refresh &&
          currentHost.google_connection_version ===
            u.google_connection_version &&
          !connectionChanges.has(u.id),
        409,
        "The host connection changed. Please try again.",
      );
      const reservation = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        assertReservationAvailable(u, e, start, end, old);
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
          "UPDATE bookings SET operation='reschedule',parent_id=?,google_id=?,google_account=?,google_calendar=?,buffer_before=?,buffer_after=? WHERE id=?",
          old.id,
          old.google_id,
          old.google_account,
          old.google_calendar,
          eventBuffers(u, e).before,
          eventBuffers(u, e).after,
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
              `${calendarPath(u, old)}/${encodeURIComponent(old.google_id)}?sendUpdates=all`,
              "PATCH",
              { start: { dateTime: start }, end: { dateTime: end } },
            );
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          run(
            "UPDATE bookings SET start=?,end=?,timezone=?,buffer_before=?,buffer_after=? WHERE id=?",
            start,
            end,
            input.timezone,
            eventBuffers(u, e).before,
            eventBuffers(u, e).after,
            old.id,
          );
          run("DELETE FROM bookings WHERE id=?", reservation);
          bookingMail(
            get("SELECT * FROM bookings WHERE id=?", old.id),
            u,
            req.params.token,
            true,
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        if (error.providerStatus >= 400 && error.providerStatus < 500)
          run(
            "UPDATE bookings SET status='failed' WHERE id=?",
            reservation,
          );
        else {
          enqueue(
            u.email,
            "Rescheduling needs a calendar check",
            mailPage(
              "Please check a rescheduling request",
              `<p>The calendar response was uncertain. Both times remain reserved until you check the appointment status.</p>${mailLink("Check calendar status", config.baseUrl + "/app/bookings")}`,
            ),
          );
          void flushMail();
        }
        throw new HttpError(
          503,
          "The calendar did not confirm the change. Please contact the host before trying again.",
        );
      }
      const b = get("SELECT * FROM bookings WHERE id=?", old.id);
      void flushMail();
      res.json({ booking: cleanBooking(b) });
    });
  });
  app.post("/api/bookings/:id/reconcile", auth, async (req, res) => {
    const b = get("SELECT * FROM bookings WHERE id=?", req.params.id);
    need(
      b && (b.user_id === req.user.id || req.user.role === "admin"),
      404,
      "Appointment not found.",
    );
    return withBookingLock(b, async () => {
      if (
        b.status === "scheduled" &&
        ["pending", "failed"].includes(b.meet_state)
      ) {
        await recoverMeet(b);
        return res.json({
          message:
            "Meeting link checked. Refresh the appointment for its latest status.",
        });
      }
      need(
        b.status === "pending",
        409,
        "This appointment does not need reconciliation.",
      );
      need(
        Date.now() - Date.parse(b.operation_started || b.created) > 60_000,
        409,
        "Please wait one minute for Google to finish processing, then check again.",
      );
      const u = await boundUser(b);
      let remote;
      try {
        remote = await lookupEvent(u, b);
      } catch (error) {
        if (error.providerStatus === 404 || error.providerStatus === 410)
          remote = null;
        else throw error;
      }
      if (b.operation === "cancel") {
        if (!remote || remote.status === "cancelled")
          finishCancellation(b, u);
        else
          run(
            "UPDATE bookings SET status='scheduled',operation='create' WHERE id=?",
            b.id,
          );
        return res.json({
          message:
            !remote || remote.status === "cancelled"
              ? "Cancellation confirmed. Emails queued."
              : "Google still has this appointment. You can retry cancellation.",
        });
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
          const original = get(
            "SELECT * FROM bookings WHERE id=?",
            b.parent_id,
          );
          need(
            original &&
              DateTime.fromISO(remote.start?.dateTime || "").toMillis() ===
                DateTime.fromISO(original.start).toMillis() &&
              DateTime.fromISO(remote.end?.dateTime || "").toMillis() ===
                DateTime.fromISO(original.end).toMillis(),
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
            "UPDATE bookings SET start=?,end=?,timezone=?,buffer_before=?,buffer_after=? WHERE id=?",
            b.start,
            b.end,
            b.timezone,
            b.buffer_before,
            b.buffer_after,
            id,
          );
          run("DELETE FROM bookings WHERE id=?", b.id);
        } else
          run(
            "UPDATE bookings SET status='scheduled',google_id=?,meet_url=?,manage_hash=?,meet_state=? WHERE id=?",
            remote.id,
            b.location === "Zoom" ? b.meet_url : remote.hangoutLink || null,
            hash(manage),
            b.location === "Google Meet" && !remote.hangoutLink
              ? "pending"
              : "none",
            b.id,
          );
        bookingMail(
          get("SELECT * FROM bookings WHERE id=?", id),
          u,
          b.operation === "reschedule" ? null : manage,
          b.operation === "reschedule",
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      void flushMail();
      res.json({
        message:
          "Appointment confirmed against Google Calendar. Confirmation emails have been queued.",
      });
    });
  });
  let closed = false,
    recovering = false;
  async function recoverMeet(b) {
    try {
      const u = await boundUser(b),
        remote = await lookupEvent(u, b);
      const link =
        remote.hangoutLink ||
        remote.conferenceData?.entryPoints?.find(
          (p) => p.entryPointType === "video",
        )?.uri;
      if (closed) return;
      const fresh = get("SELECT * FROM bookings WHERE id=?", b.id);
      if (fresh?.status !== "scheduled" || fresh.meet_url) return;
      if (link && /^https:\/\/meet\.google\.com\//.test(link)) {
        db.exec("BEGIN IMMEDIATE");
        try {
          run(
            "UPDATE bookings SET meet_url=?,meet_state='ready' WHERE id=?",
            link,
            b.id,
          );
          const body = `<p>${esc(b.title)}</p>${mailLink("Join Google Meet", link)}`;
          enqueue(
            b.email,
            `Meeting link ready: ${b.title}`,
            mailPage("Your Google Meet link", body),
          );
          enqueue(
            u.email,
            `Meeting link ready: ${b.title}`,
            mailPage("Your Google Meet link", body),
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        void flushMail();
        return;
      }
      if (
        remote.status === "cancelled" ||
        remote.conferenceData?.createRequest?.status?.statusCode ===
          "failure"
      ) {
        run("UPDATE bookings SET meet_state='failed' WHERE id=?", b.id);
        enqueue(
          u.email,
          "Google Meet link needs attention",
          mailPage(
            "Check the meeting link",
            `<p>${esc(b.title)} has no usable meeting link. Review it in Google Calendar and check its status again in Bookings.</p>`,
          ),
        );
        return;
      }
    } catch {
      /* Retain the appointment and retry without creating another event. */
    }
    if (!closed)
      run(
        "UPDATE bookings SET meet_attempts=meet_attempts+1,meet_retry_at=? WHERE id=?",
        Date.now() +
          Math.min(3600000, 15000 * 2 ** Math.min(b.meet_attempts, 8)),
        b.id,
      );
  }
  async function recoverMeetLinks() {
    if (recovering || closed) return;
    recovering = true;
    try {
      for (const b of all(
        "SELECT * FROM bookings WHERE status='scheduled' AND meet_state='pending' AND meet_retry_at<=? AND end>? ORDER BY meet_retry_at LIMIT 5",
        Date.now(),
        new Date().toISOString(),
      )) {
        if (closed) return;
        if (
          appointmentLocks.has(b.id) ||
          get(
            "SELECT id FROM bookings WHERE parent_id=? AND status='pending'",
            b.id,
          )
        )
          continue;
        await withBookingLock(b, () => recoverMeet(b));
      }
    } finally {
      recovering = false;
    }
  }

  app.get("/api/google/connect", auth, (req, res) => {
    need(
      config.googleId && config.googleSecret && config.encryptionKey,
      503,
      "Google Calendar is not configured yet.",
    );
    const verifier = token(),
      state = createToken(
        req.user.id,
        "oauth",
        null,
        JSON.stringify({
          version: 1,
          verifier,
          clientHash: credentials.currentClient(),
          redirectUri: `${config.baseUrl}/api/google/callback`,
        }),
        10,
      );
    const params = new URLSearchParams({
      client_id: config.googleId,
      redirect_uri: `${config.baseUrl}/api/google/callback`,
      response_type: "code",
      scope:
        "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: createHash("sha256")
        .update(verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });
  app.get("/api/google/callback", auth, async (req, res) => {
    if (req.query.error)
      return res.redirect(
        (req.user.onboarded ? "/app/settings" : "/app/setup") +
          "?google=denied",
      );
    const state = readToken(req.query.state, "oauth");
    need(
      state.user_id === req.user.id,
      403,
      "This calendar connection belongs to another session.",
    );
    run("DELETE FROM tokens WHERE hash=?", state.hash);
    let binding;
    try {
      binding = JSON.parse(state.data);
    } catch {}
    const clientHash = credentials.currentClient();
    need(
      binding?.version === 1 &&
        clientHash &&
        binding.clientHash === clientHash &&
        typeof binding.verifier === "string" &&
        /^[a-f0-9]{64}$/.test(binding.verifier) &&
        binding.redirectUri === `${config.baseUrl}/api/google/callback`,
      409,
      "The Google connection configuration changed. Start Connect Google Calendar again.",
    );
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
        code_verifier: binding.verifier,
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
    need(
      info.email_verified &&
        typeof info.email === "string" &&
        typeof info.sub === "string",
      400,
      "Please use a verified Google account.",
    );
    const fresh = get("SELECT * FROM users WHERE id=?", req.user.id);
    need(
      credentials.currentClient() === clientHash &&
        binding.redirectUri === `${config.baseUrl}/api/google/callback`,
      409,
      "The Google connection configuration changed. Start Connect Google Calendar again.",
    );
    need(
      fresh.active &&
        get(
          "SELECT hash FROM sessions WHERE hash=? AND expires>?",
          hash(req.cookies.bmt_session),
          Date.now(),
        ),
      403,
      "Your session is no longer active. Please sign in again.",
    );
    need(
      !connectionChanges.has(fresh.id),
      409,
      "Another calendar connection change is in progress.",
    );
    const sameAccount = fresh.google_account
      ? fresh.google_account === info.sub
      : fresh.google_email?.toLowerCase() === info.email.toLowerCase();
    need(
      !credentials.hasStored(fresh) ||
        fresh.google_client_hash === clientHash ||
        sameAccount,
      409,
      "Reconnect the same Google account when moving to the new BMT Calendar connection. Your original connection and appointments are preserved.",
    );
    // Unbound legacy records do not prove which account owns them. Permit a
    // corrective reconnect, but preserve every established appointment binding.
    need(
      sameAccount ||
        !get(
          "SELECT id FROM bookings WHERE user_id=? AND (google_account IS NOT NULL OR google_calendar IS NOT NULL) AND (status='pending' OR (status='scheduled' AND end>?))",
          fresh.id,
          new Date().toISOString(),
        ),
      409,
      "Existing appointments belong to your original Google account. Reconnect that account before switching calendars.",
    );
    // A stable Google subject can acquire a new email address. Keep the
    // established calendar identifier so existing appointments stay aligned.
    const nextCalendar = sameAccount
      ? fresh.google_calendar ||
        fresh.google_email?.toLowerCase() ||
        info.email.toLowerCase()
      : info.email.toLowerCase();
    credentials.save(
      fresh,
      encrypt(data.refresh_token),
      info,
      nextCalendar,
      sameAccount,
    );
    res.redirect(
      (req.user.onboarded ? "/app/settings" : "/app/setup") +
        "?google=connected",
    );
  });
  app.post("/api/google/disconnect", auth, async (req, res) => {
    need(
      !hasOpenBookings(req.user.id),
      409,
      "Resolve pending requests and cancel upcoming appointments before disconnecting your calendar.",
    );
    need(
      !connectionChanges.has(req.user.id),
      409,
      "Another calendar connection change is in progress.",
    );
    connectionChanges.add(req.user.id);
    try {
      const selected = credentials.credential(req.user);
      need(
        selected || !credentials.hasStored(req.user),
        409,
        "The saved connection belongs to another or unverified OAuth client. Reconnect the current BMT Calendar connection before disconnecting it. Other project grants are preserved.",
      );
      if (selected) {
        await request("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: decrypt(selected.encryptedRefresh),
          }),
        });
        credentials.disconnect(req.user, selected);
      }
      res.json({ ok: true });
    } finally {
      connectionChanges.delete(req.user.id);
    }
  });
  if (config.demo) {
    if (
      !get("SELECT id FROM users WHERE email=?", "demo@bmtcalendar.local")
    ) {
      const u = addUser({
        name: "Alex Morgan",
        email: "demo@bmtcalendar.local",
        password: token(),
        role: "admin",
        verified: 1,
      });
      run("UPDATE users SET notice=0,onboarded=1 WHERE id=?", u.id);
      run(
        "UPDATE event_types SET title='Tax strategy call',description='Let’s talk about your business, your goals, and opportunities to save on taxes.' WHERE user_id=?",
        u.id,
      );
      run(
        "INSERT INTO event_types(id,user_id,title,slug,duration,description,location,color,active) VALUES(?,?,?,?,?,?,?,?,?)",
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
        "INSERT INTO event_types(id,user_id,title,slug,duration,description,location,color,active) VALUES(?,?,?,?,?,?,?,?,?)",
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
      return res.status(409).json({
        error: "This item already exists or conflicts with another record.",
      });
    console.error("Unhandled server error:", error.name, error.message);
    res
      .status(500)
      .json({ error: "Something went wrong. Please try again." });
  });
  const interval = setInterval(() => {
    void flushMail();
    void recoverMeetLinks();
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
    recoverMeetLinks,
    close: () => {
      closed = true;
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
