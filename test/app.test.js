import { test } from "node:test";
import assert from "node:assert/strict";
import supertest from "supertest";
import { DateTime, Settings } from "luxon";
import { createApp } from "../server.js";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const password = "A rather strong password 123!";
async function setup(t, overrides = {}) {
  const mail = [],
    calls = [];
  const service = createApp({
    dbPath: ":memory:",
    baseUrl: "http://localhost:3000",
    production: false,
    demo: false,
    testMode: true,
    ownerEmail: "owner@example.com",
    deliverMail: async (item) => mail.push(item),
    calendarProvider: {
      busy: async () => [],
      create: async (u, e, b) => {
        calls.push(["create", b]);
        return {
          id: "google-" + b.id,
          hangoutLink: "https://meet.google.com/test-meeting",
        };
      },
      cancel: async (u, b) => calls.push(["cancel", b]),
      update: async (u, b, change) => calls.push(["update", change]),
    },
    ...overrides,
  });
  t.after(() => service.close());
  const agent = supertest.agent(service.app),
    anon = supertest(service.app);
  const registered = await agent
    .post("/api/auth/register")
    .send({ name: "Boris Test", email: "owner@example.com", password });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const verify = mail
    .find((m) => m.subject.includes("Verify"))
    .html.match(/verify\?token=([a-f0-9]+)/)[1];
  const verified = await agent
    .post("/api/auth/verify")
    .send({ token: verify });
  assert.equal(verified.status, 200);
  const user = verified.body.user;
  // Most tests use a previously onboarded host; setup enforcement is tested separately.
  service.db
    .prepare("UPDATE users SET onboarded=1 WHERE id=?")
    .run(user.id);
  await agent
    .patch("/api/me")
    .send({
      name: user.name,
      timezone: "America/New_York",
      notice: 0,
      horizon: 60,
      buffer: 15,
      windows: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
        day,
        start: "09:00",
        end: "17:00",
      })),
    })
    .expect(200);
  const events = (await agent.get("/api/events")).body.events,
    event = events[0];
  const day = DateTime.now()
    .setZone("America/New_York")
    .plus({ days: 2 })
    .toISODate();
  const path = `/api/public/${user.slug}/${event.slug}`;
  const slots = (
    await anon
      .get(`${path}/slots`)
      .query({ date: day, timezone: "America/New_York" })
  ).body.slots;
  assert.ok(slots.length > 0);
  return {
    ...service,
    mail,
    calls,
    agent,
    anon,
    user,
    event,
    day,
    path,
    slots,
    verify,
  };
}
const guest = (start, extra = {}) => ({
  name: "Taylor Guest",
  email: "taylor@example.com",
  timezone: "America/New_York",
  start,
  notes: "Planning ahead",
  ...extra,
});

test("verified owner account, secure session cookie, single-use verification and login", async (t) => {
  const s = await setup(t);
  const me = await s.agent.get("/api/me").expect(200);
  assert.equal(me.body.user.role, "admin");
  assert.equal(me.body.user.password, undefined);
  await s.anon.get("/api/me").expect(401);
  const replay = await s.anon
    .post("/api/auth/verify")
    .send({ token: s.verify })
    .expect(200);
  assert.deepEqual(replay.body, { alreadyVerified: true });
  assert.equal(replay.headers["set-cookie"], undefined);
  const untouchedBrowser = supertest.agent(s.app);
  await untouchedBrowser
    .post("/api/auth/verify")
    .send({ token: s.verify })
    .expect(200);
  await untouchedBrowser.get("/api/me").expect(401);
  await s.anon
    .post("/api/auth/verify")
    .send({ token: "invalid-token" })
    .expect(400);
  s.db
    .prepare("UPDATE tokens SET expires=? WHERE kind='verify'")
    .run(Date.now() - 1);
  await s.anon
    .post("/api/auth/verify")
    .send({ token: s.verify })
    .expect(400);
  await s.anon
    .post("/api/auth/login")
    .send({ email: "owner@example.com", password: "wrong" })
    .expect(401);
  const login = await s.anon
    .post("/api/auth/login")
    .send({ email: "owner@example.com", password })
    .expect(200);
  assert.match(login.headers["set-cookie"][0], /HttpOnly/);
  assert.match(login.headers["set-cookie"][0], /SameSite=Lax/);
  await s.agent.post("/api/auth/logout").send({}).expect(200);
  await s.agent.get("/api/me").expect(401);
});
test("uninvited users cannot register; invited members cannot invite or edit another host", async (t) => {
  const s = await setup(t);
  await s.anon
    .post("/api/auth/register")
    .send({ name: "Stranger", email: "stranger@example.com", password })
    .expect(403);
  await s.agent
    .post("/api/team/invite")
    .send({ email: "member@example.com" })
    .expect(200);
  const invite = s.mail
    .find((m) => m.subject.includes("invited"))
    .html.match(/invite=([a-f0-9]+)/)[1];
  const member = supertest.agent(s.app);
  await member
    .post("/api/auth/register")
    .send({
      name: "Member User",
      email: "member@example.com",
      password,
      invite,
    })
    .expect(201);
  const verify = s.mail
    .filter(
      (m) =>
        m.recipient === "member@example.com" &&
        m.subject.includes("Verify"),
    )[0]
    .html.match(/verify\?token=([a-f0-9]+)/)[1];
  await member.post("/api/auth/verify").send({ token: verify }).expect(200);
  s.db
    .prepare("UPDATE users SET onboarded=1 WHERE email=?")
    .run("member@example.com");
  await member
    .post("/api/team/invite")
    .send({ email: "third@example.com" })
    .expect(403);
  await member
    .patch("/api/events/" + s.event.id)
    .send({ ...s.event, active: true })
    .expect(404);
  const publicTeam = await member.get("/api/team").expect(200);
  assert.equal(publicTeam.body.users[0].email, undefined);
});
test("password reset invalidates existing sessions, expires and cannot be replayed", async (t) => {
  const s = await setup(t);
  await s.anon
    .post("/api/auth/forgot")
    .send({ email: "owner@example.com" })
    .expect(200);
  const reset = s.mail
    .find((m) => m.subject.includes("Reset"))
    .html.match(/reset\?token=([a-f0-9]+)/)[1];
  await s.anon
    .post("/api/auth/reset")
    .send({ token: reset, password: "Another strong password 123!" })
    .expect(200);
  await s.agent.get("/api/me").expect(401);
  await s.anon
    .post("/api/auth/reset")
    .send({ token: reset, password })
    .expect(400);
  await s.anon
    .post("/api/auth/login")
    .send({ email: "owner@example.com", password })
    .expect(401);
  await s.anon
    .post("/api/auth/login")
    .send({
      email: "owner@example.com",
      password: "Another strong password 123!",
    })
    .expect(200);
});
test("end-to-end booking checks availability, creates Google meeting and sends both confirmations", async (t) => {
  const s = await setup(t);
  const result = await s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(201);
  assert.equal(result.body.booking.status, "scheduled");
  assert.equal(
    result.body.booking.meet_url,
    "https://meet.google.com/test-meeting",
  );
  assert.equal(result.body.booking.manage_hash, undefined);
  assert.equal(s.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal(
    s.mail.filter((m) => m.subject.startsWith("Confirmed")).length,
    1,
  );
  assert.equal(
    s.mail.filter((m) => m.subject.startsWith("New booking")).length,
    1,
  );
  const manage = new URL(result.body.manageUrl).pathname.split("/").pop();
  const details = await s.anon.get("/api/manage/" + manage).expect(200);
  assert.equal(details.body.booking.email, "taylor@example.com");
  const slots = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  assert.ok(!slots.body.slots.includes(s.slots[0]));
  assert.ok(!slots.body.slots.includes(s.slots[1]));
  const dashboard = await s.agent.get("/api/bookings").expect(200);
  assert.equal(dashboard.body.bookings.length, 1);
  assert.equal(dashboard.body.bookings[0].manage_hash, undefined);
});
test("concurrent identical bookings admit exactly one reservation", async (t) => {
  const s = await setup(t);
  const results = await Promise.all([
    s.anon.post(s.path + "/bookings").send(guest(s.slots[0])),
    s.anon
      .post(s.path + "/bookings")
      .send(guest(s.slots[0], { email: "other@example.com" })),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(s.calls.filter((c) => c[0] === "create").length, 1);
});
test("Google busy events block slots, including buffers; timezone rendering preserves instants", async (t) => {
  const s = await setup(t);
  const start = DateTime.fromISO(s.slots[0]),
    end = start.plus({ hours: 1 });
  s.config.calendarProvider.busy = async () => [
    { start: start.toISO(), end: end.toISO() },
  ];
  const eastern = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  assert.ok(!eastern.body.slots.includes(s.slots[0]));
  assert.ok(!eastern.body.slots.includes(end.toUTC().toISO()));
  assert.ok(
    eastern.body.slots.includes(end.plus({ minutes: 15 }).toUTC().toISO()),
  );
  const pacific = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/Los_Angeles" })
    .expect(200);
  assert.deepEqual(pacific.body.slots, eastern.body.slots);
});
test("Google failure releases the local reservation without creating a confirmed booking", async (t) => {
  const s = await setup(t);
  s.config.calendarProvider.create = async () => {
    const e = new Error("Calendar unavailable");
    e.status = 503;
    e.providerStatus = 403;
    throw e;
  };
  await s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(503);
  assert.equal(
    s.db
      .prepare(
        "SELECT COUNT(*) AS n FROM bookings WHERE status='scheduled'",
      )
      .get().n,
    0,
  );
  const slots = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  assert.ok(slots.body.slots.includes(s.slots[0]));
});
test("rescheduling updates the original calendar event and preserves the manage link", async (t) => {
  const s = await setup(t);
  const booked = await s.anon
      .post(s.path + "/bookings")
      .send(guest(s.slots[0]))
      .expect(201),
    manage = new URL(booked.body.manageUrl).pathname.split("/").pop();
  const result = await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[8], timezone: "America/New_York" })
    .expect(200);
  assert.equal(result.body.booking.id, booked.body.booking.id);
  assert.equal(result.body.booking.start, s.slots[8]);
  assert.equal(s.calls.filter((c) => c[0] === "update").length, 1);
  const found = await s.anon.get("/api/manage/" + manage).expect(200);
  assert.equal(found.body.booking.start, s.slots[8]);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n,
    1,
  );
});
test("failed rescheduling retains original appointment and releases new slot", async (t) => {
  const s = await setup(t),
    booked = await s.anon
      .post(s.path + "/bookings")
      .send(guest(s.slots[0]))
      .expect(201),
    manage = new URL(booked.body.manageUrl).pathname.split("/").pop();
  s.config.calendarProvider.update = async () => {
    const err = new Error("Google failed");
    err.status = 503;
    err.providerStatus = 403;
    throw err;
  };
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[8], timezone: "America/New_York" })
    .expect(503);
  const current = await s.anon.get("/api/manage/" + manage).expect(200);
  assert.equal(current.body.booking.start, s.slots[0]);
  const slots = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  assert.ok(slots.body.slots.includes(s.slots[8]));
});
test("cancellation removes Google event, notifies both parties and frees availability", async (t) => {
  const s = await setup(t),
    b = await s.anon
      .post(s.path + "/bookings")
      .send(guest(s.slots[0]))
      .expect(201),
    manage = new URL(b.body.manageUrl).pathname.split("/").pop();
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(200);
  assert.equal(s.calls.filter((c) => c[0] === "cancel").length, 1);
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(409);
  assert.equal(
    s.mail.filter((m) => m.subject.startsWith("Cancelled")).length,
    2,
  );
  const slots = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  assert.ok(slots.body.slots.includes(s.slots[0]));
});
test("malformed, past and outside-window bookings are rejected; paused event types disappear", async (t) => {
  const s = await setup(t);
  await s.anon
    .post(s.path + "/bookings")
    .send(guest("not-a-date"))
    .expect(400);
  await s.anon
    .post(s.path + "/bookings")
    .send(guest(DateTime.now().minus({ days: 1 }).toUTC().toISO()))
    .expect(409);
  await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "bad-zone" })
    .expect(400);
  await s.agent
    .patch("/api/events/" + s.event.id)
    .send({ ...s.event, active: false })
    .expect(200);
  await s.anon.get(s.path).expect(404);
});
test("API rejects cross-origin mutations, protects private records and escapes email HTML", async (t) => {
  const s = await setup(t);
  await s.agent
    .post("/api/team/invite")
    .set("Origin", "https://evil.example")
    .send({ email: "member@example.com" })
    .expect(403);
  await s.anon
    .post("/api/auth/login")
    .type("form")
    .send("email=a")
    .expect(415);
  const b = await s.anon
    .post(s.path + "/bookings")
    .send(
      guest(s.slots[0], {
        name: "<script>alert(1)</script>",
        notes: "<img src=x onerror=alert(1)>",
      }),
    )
    .expect(201);
  const email = s.mail.find((m) => m.subject.startsWith("New booking"));
  assert.ok(!email.html.includes("<script>"));
  assert.ok(email.html.includes("&lt;script&gt;"));
  await s.anon.get("/api/bookings").expect(401);
  await s.anon.get("/api/manage/not-real").expect(404);
  await s.anon
    .post("/api/bookings/" + b.body.booking.id + "/cancel")
    .send({})
    .expect(401);
});
test("email failures stay in a retryable outbox and do not erase successful bookings", async (t) => {
  const s = await setup(t);
  s.config.deliverMail = async () => {
    throw new Error("Resend temporarily down");
  };
  await s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(201);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE sent=0").get().n,
    2,
  );
  s.config.deliverMail = async (item) => s.mail.push(item);
  s.db.prepare("UPDATE outbox SET next_try=0").run();
  await s.flushMail();
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE sent=0").get().n,
    0,
  );
});
test("weekly availability validation rejects overlaps and supports closed days", async (t) => {
  const s = await setup(t),
    body = {
      name: s.user.name,
      timezone: "America/New_York",
      notice: 0,
      horizon: 60,
      buffer: 15,
      windows: [
        { day: 1, start: "09:00", end: "12:00" },
        { day: 1, start: "11:00", end: "17:00" },
      ],
    };
  await s.agent.patch("/api/me").send(body).expect(400);
  await s.agent
    .patch("/api/me")
    .send({ ...body, windows: [] })
    .expect(200);
  const slots = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  assert.deepEqual(slots.body.slots, []);
});
test("production refuses demo, missing secrets and insecure public URLs", () => {
  assert.throws(
    () => createApp({ production: true, demo: true }),
    /DEMO_MODE/,
  );
  assert.throws(
    () =>
      createApp({
        production: true,
        demo: false,
        baseUrl: "http://localhost:3000",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createApp({
        production: true,
        demo: false,
        baseUrl: "https://calendar.example.com",
        ownerEmail: "",
      }),
    /ownerEmail/,
  );
});

test("Google OAuth uses PKCE, enforces state ownership, encrypts refresh tokens and refreshes for free/busy", async (t) => {
  const s = await setup(t, {
    googleId: "test-client-id",
    googleSecret: "test-client-secret",
    encryptionKey: "1".repeat(64),
  });
  const connected = await s.agent.get("/api/google/connect").expect(302),
    url = new URL(connected.headers.location),
    state = url.searchParams.get("state");
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope"), /calendar.events/);
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://localhost:3000/api/google/callback",
  );
  await s.agent
    .get("/api/google/callback")
    .query({ code: "test", state: "invalid" })
    .expect(400);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, opts) => {
    const u = String(input);
    requests.push([u, opts]);
    if (u === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "fake-access-token",
        refresh_token: "fake-refresh-token",
        scope:
          "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
      });
    if (u === "https://openidconnect.googleapis.com/v1/userinfo")
      return Response.json({
        email: "calendar@example.com",
        email_verified: true,
        sub: "google-account-one",
      });
    if (u === "https://www.googleapis.com/calendar/v3/freeBusy")
      return Response.json({
        calendars: { "calendar@example.com": { busy: [] } },
      });
    throw new Error("Unexpected external request");
  });
  await s.agent
    .get("/api/google/callback")
    .query({ code: "test-code", state })
    .expect(302);
  const stored = s.db
    .prepare("SELECT google_refresh FROM users WHERE id=?")
    .get(s.user.id).google_refresh;
  assert.ok(stored);
  assert.ok(!stored.includes("fake-refresh-token"));
  await s.agent
    .get("/api/google/callback")
    .query({ code: "test-code", state })
    .expect(400);
  s.config.calendarProvider = null;
  await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  const refresh = requests.find(
    ([u, o]) =>
      u.endsWith("/token") && o.body.get("grant_type") === "refresh_token",
  );
  assert.equal(refresh[1].body.get("refresh_token"), "fake-refresh-token");
  assert.equal(requests.filter(([u]) => u.endsWith("/freeBusy")).length, 1);
});
test("Resend transport uses verified sender, bearer auth and stable idempotency keys", async (t) => {
  const s = await setup(t),
    requests = [];
  s.config.deliverMail = null;
  s.config.resendKey = "test-resend-key";
  s.config.mailFrom = "BMT Calendar <scheduling@mail.borismtax.com>";
  t.mock.method(globalThis, "fetch", async (input, opts) => {
    requests.push([String(input), opts]);
    return Response.json({ id: "email-id" });
  });
  await s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(201);
  assert.equal(requests.length, 2);
  for (const [url, opts] of requests) {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(opts.headers.Authorization, "Bearer test-resend-key");
    assert.ok(opts.headers["Idempotency-Key"]);
    assert.equal(JSON.parse(opts.body).from, s.config.mailFrom);
  }
});

test("ambiguous Google timeouts retain reservations until host reconciles with the real event", async (t) => {
  const s = await setup(t);
  let attempted;
  s.config.calendarProvider.create = async (u, e, b) => {
    attempted = b;
    throw new TypeError("Network timeout after request was sent");
  };
  await s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(503);
  const pending = s.db
    .prepare("SELECT * FROM bookings WHERE status='pending'")
    .get();
  assert.ok(pending);
  const available = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  assert.ok(!available.body.slots.includes(s.slots[0]));
  await s.agent
    .post(`/api/bookings/${pending.id}/reconcile`)
    .send({})
    .expect(409);
  s.db
    .prepare("UPDATE bookings SET created=? WHERE id=?")
    .run(new Date(Date.now() - 120000).toISOString(), pending.id);
  s.config.calendarProvider.lookup = async () => ({
    id: pending.google_id,
    start: { dateTime: attempted.start },
    end: { dateTime: attempted.end },
    hangoutLink: "https://meet.google.com/recovered",
  });
  await s.agent
    .post(`/api/bookings/${pending.id}/reconcile`)
    .send({})
    .expect(200);
  const recovered = s.db
    .prepare("SELECT * FROM bookings WHERE id=?")
    .get(pending.id);
  assert.equal(recovered.status, "scheduled");
  assert.equal(recovered.meet_url, "https://meet.google.com/recovered");
  assert.ok(s.mail.some((m) => m.subject.startsWith("Confirmed")));
});
test("an ambiguous rescheduling request can be reconciled without duplicating the appointment", async (t) => {
  const s = await setup(t),
    booked = await s.anon
      .post(s.path + "/bookings")
      .send(guest(s.slots[0]))
      .expect(201),
    manage = new URL(booked.body.manageUrl).pathname.split("/").pop();
  s.config.calendarProvider.update = async () => {
    throw new TypeError("Network timeout");
  };
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[8], timezone: "America/New_York" })
    .expect(503);
  const pending = s.db
    .prepare("SELECT * FROM bookings WHERE status='pending'")
    .get();
  assert.equal(pending.parent_id, booked.body.booking.id);
  s.db
    .prepare("UPDATE bookings SET created=? WHERE id=?")
    .run(new Date(Date.now() - 120000).toISOString(), pending.id);
  s.config.calendarProvider.lookup = async () => ({
    id: pending.google_id,
    start: { dateTime: pending.start },
    end: { dateTime: pending.end },
  });
  await s.agent
    .post(`/api/bookings/${pending.id}/reconcile`)
    .send({})
    .expect(200);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n,
    1,
  );
  assert.equal(
    s.db
      .prepare("SELECT start FROM bookings WHERE id=?")
      .get(booked.body.booking.id).start,
    s.slots[8],
  );
});

test("Render production startup uses its assigned URL and retained generated secret", async () => {
  const names = [
    "APP_URL",
    "RENDER_EXTERNAL_URL",
    "TOKEN_ENCRYPTION_KEY",
    "TOKEN_ENCRYPTION_SECRET",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  let service;
  try {
    delete process.env.APP_URL;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    process.env.RENDER_EXTERNAL_URL =
      "https://assigned-calendar.onrender.com";
    process.env.TOKEN_ENCRYPTION_SECRET =
      "test-generated-secret-with-at-least-32-characters";
    const settings = {
      dbPath: ":memory:",
      production: true,
      demo: false,
      ownerEmail: "owner@example.com",
      resendKey: "test-only",
      mailFrom: "test@example.com",
      googleId: "test-id",
      googleSecret: "test-secret",
    };
    service = createApp(settings);
    assert.equal(
      service.config.baseUrl,
      "https://assigned-calendar.onrender.com",
    );
    assert.match(service.config.encryptionKey, /^[a-f0-9]{64}$/);
    const stableKey = service.config.encryptionKey;
    await supertest(service.app).get("/api/health").expect(200);
    service.close();
    service = createApp(settings);
    assert.equal(service.config.encryptionKey, stableKey);
    service.close();
    service = null;
    process.env.APP_URL = "https://calendar.example.com";
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    service = createApp(settings);
    assert.equal(service.config.baseUrl, "https://calendar.example.com");
    assert.equal(service.config.encryptionKey, "a".repeat(64));
  } finally {
    service?.close();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("profile photos are sanitized, resized, published and removable", async (t) => {
  const s = await setup(t);
  const png = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#6558df" },
  })
    .png()
    .toBuffer();
  const image = "data:image/png;base64," + png.toString("base64");
  await s.anon.put("/api/me/photo").send({ image }).expect(401);
  await s.agent
    .put("/api/me/photo")
    .send({ image: "data:image/svg+xml;base64,PHN2Zz4=" })
    .expect(400);
  await s.agent
    .put("/api/me/photo")
    .send({ image: "data:image/png;base64,YmFk" })
    .expect(400);
  const saved = await s.agent
    .put("/api/me/photo")
    .send({ image })
    .expect(200);
  assert.match(saved.body.user.photo, /^data:image\/jpeg;base64,/);
  const metadata = await sharp(
    Buffer.from(saved.body.user.photo.split(",")[1], "base64"),
  ).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 256);
  assert.equal(metadata.exif, undefined);
  const page = await s.anon.get(s.path).expect(200);
  assert.equal(page.body.host.photo, saved.body.user.photo);
  const deleted = await s.agent
    .delete("/api/me/photo")
    .send({})
    .expect(200);
  assert.equal(deleted.body.user.photo, null);
});

test("new accounts finish onboarding only after a working calendar connection", async (t) => {
  const s = await setup(t);
  s.db.prepare("UPDATE users SET onboarded=0 WHERE id=?").run(s.user.id);
  assert.equal(
    (await s.agent.get("/api/me")).body.user.onboardingComplete,
    false,
  );
  await s.agent.post("/api/me/onboarding").send({}).expect(409);
  s.db
    .prepare("UPDATE users SET google_refresh=? WHERE id=?")
    .run("test-calendar-binding", s.user.id);
  await s.agent.post("/api/me/onboarding").send({}).expect(409);
  await s.agent.get("/api/events").expect(403);
  await s.agent.get("/api/team").expect(403);
  await s.agent.get("/api/bookings/export").expect(403);
  await s.anon.get(s.path).expect(404);
  const png = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await s.agent
    .put("/api/me/photo")
    .send({ image: "data:image/png;base64," + png.toString("base64") })
    .expect(200);
  const saved = await s.agent
    .post("/api/me/onboarding")
    .send({})
    .expect(200);
  assert.equal(saved.body.user.onboardingComplete, true);
  assert.match(
    saved.body.user.photo,
    /^data:image\/jpeg;base64,/,
    "Photo is required",
  );
  assert.equal(
    (await s.agent.get("/api/me")).body.user.onboardingComplete,
    true,
  );
});

test("Zoom links are validated, included only after booking and retained on rescheduling", async (t) => {
  const s = await setup(t);
  const zoom = "https://us02web.zoom.us/j/1234567890?pwd=meeting-passcode";
  const input = {
    title: "Zoom strategy call",
    duration: 30,
    location: "Zoom",
    meetingUrl: zoom,
    color: "#6366f1",
    active: true,
  };
  for (const meetingUrl of [
    "",
    "javascript:alert(1)",
    "https://zoom.us.evil.example/j/123456",
    "https://zoom.us/signin",
  ]) {
    await s.agent
      .post("/api/events")
      .send({ ...input, meetingUrl })
      .expect(400);
  }
  const event = (await s.agent.post("/api/events").send(input).expect(201))
    .body.event;
  assert.equal(event.meeting_url, zoom);
  const path = `/api/public/${s.user.slug}/${event.slug}`;
  const page = await s.anon.get(path).expect(200);
  assert.equal(page.body.event.meeting_url, undefined);
  assert.equal(page.body.event.meetingUrl, undefined);
  const result = await s.anon
    .post(path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(201);
  assert.equal(result.body.booking.location, "Zoom");
  assert.equal(result.body.booking.meet_url, zoom);
  const message = s.mail.find(
    (m) => m.subject === "Confirmed: Zoom strategy call",
  );
  assert.ok(message.html.includes("Join Zoom"));
  assert.ok(message.html.includes("us02web.zoom.us/j/1234567890"));
  assert.ok(!message.html.includes("Join Google Meet"));
  const manage = new URL(result.body.manageUrl).pathname.split("/").pop();
  const rescheduled = await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[8], timezone: "America/New_York" })
    .expect(200);
  assert.equal(rescheduled.body.booking.meet_url, zoom);
});

async function connectGoogleWithResponses(s, t, responses) {
  const connected = await s.agent.get("/api/google/connect").expect(302);
  const state = new URL(connected.headers.location).searchParams.get(
    "state",
  );
  t.mock.method(globalThis, "fetch", async (input, opts) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        scope:
          "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
      });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo")
      return Response.json({
        email: "calendar@example.com",
        email_verified: true,
        sub: "google-account-one",
      });
    return responses(url, opts);
  });
  await s.agent
    .get("/api/google/callback")
    .query({ code: "test-code", state })
    .expect(302);
  s.config.calendarProvider = null;
}

test("disabled Google Calendar API is diagnosed and slots recover once it is enabled", async (t) => {
  const s = await setup(t, {
    googleId: "test-id",
    googleSecret: "test-secret",
    encryptionKey: "1".repeat(64),
  });
  let enabled = false;
  await connectGoogleWithResponses(s, t, async (url) => {
    assert.equal(url, "https://www.googleapis.com/calendar/v3/freeBusy");
    return enabled
      ? Response.json({
          calendars: { "calendar@example.com": { busy: [] } },
        })
      : Response.json(
          {
            error: { code: 403, details: [{ reason: "SERVICE_DISABLED" }] },
          },
          { status: 403 },
        );
  });
  const failed = await s.anon
    .get(s.path + "/slots")
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(502);
  assert.match(failed.body.error, /Google Calendar API is not enabled/);
  assert.equal(
    failed.body.slots,
    undefined,
    "Never publish unchecked availability after a Google failure",
  );
  const diagnostic = await s.agent.get("/api/google/status").expect(200);
  assert.equal(diagnostic.body.code, "API_DISABLED");
  s.db
    .prepare("UPDATE users SET onboarded=0,photo=? WHERE id=?")
    .run("test-photo", s.user.id);
  await s.agent.post("/api/me/onboarding").send({}).expect(502);
  assert.equal(
    (await s.agent.get("/api/me")).body.user.onboardingComplete,
    false,
  );
  enabled = true;
  assert.equal(
    (await s.agent.get("/api/google/status")).body.healthy,
    true,
  );
  await s.agent.post("/api/me/onboarding").send({}).expect(200);
  assert.ok(
    (
      await s.anon
        .get(s.path + "/slots")
        .query({ date: s.day, timezone: "America/New_York" })
        .expect(200)
    ).body.slots.length > 0,
  );
  await s.agent.post("/api/me/onboarding").send({}).expect(200);
});

test("Zoom calendar invitations use the Zoom URL without creating Google Meet rooms", async (t) => {
  const s = await setup(t, {
    googleId: "test-id",
    googleSecret: "test-secret",
    encryptionKey: "1".repeat(64),
  });
  let calendarEvent;
  await connectGoogleWithResponses(s, t, async (url, opts) => {
    if (url.endsWith("/freeBusy"))
      return Response.json({
        calendars: { "calendar@example.com": { busy: [] } },
      });
    assert.ok(url.includes("/calendars/calendar%40example.com/events?"));
    calendarEvent = JSON.parse(opts.body);
    return Response.json({ id: calendarEvent.id });
  });
  const zoom = "https://us02web.zoom.us/j/1234567890";
  const event = (
    await s.agent
      .post("/api/events")
      .send({
        title: "Zoom planning",
        duration: 30,
        location: "Zoom",
        meetingUrl: zoom,
        color: "#6366f1",
        active: true,
      })
      .expect(201)
  ).body.event;
  const result = await s.anon
    .post(`/api/public/${s.user.slug}/${event.slug}/bookings`)
    .send(guest(s.slots[0]))
    .expect(201);
  assert.equal(calendarEvent.location, zoom);
  assert.equal(calendarEvent.conferenceData, undefined);
  assert.equal(result.body.booking.meet_url, zoom);
});

test("upgrading a pre-profile database preserves existing users and event types", () => {
  const dir = mkdtempSync(join(tmpdir(), "bmt-legacy-"));
  const dbPath = join(dir, "calendar.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, role TEXT NOT NULL DEFAULT 'member', verified INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'America/New_York', windows TEXT NOT NULL, notice INTEGER NOT NULL DEFAULT 240, horizon INTEGER NOT NULL DEFAULT 60, buffer INTEGER NOT NULL DEFAULT 15, google_refresh TEXT, google_email TEXT, created TEXT NOT NULL);
    CREATE TABLE event_types (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, slug TEXT NOT NULL, duration INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT 'Google Meet', color TEXT NOT NULL DEFAULT '#6366f1', active INTEGER NOT NULL DEFAULT 1, UNIQUE(user_id,slug));`);
  legacy
    .prepare(
      "INSERT INTO users(id,name,email,password,slug,verified,windows,created) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      "legacy-user",
      "Existing User",
      "existing@example.com",
      "historical-password-hash",
      "existing-user",
      1,
      "[]",
      "2026-01-01T00:00:00.000Z",
    );
  legacy
    .prepare(
      "INSERT INTO event_types(id,user_id,title,slug,duration) VALUES(?,?,?,?,?)",
    )
    .run(
      "legacy-event",
      "legacy-user",
      "Existing meeting",
      "existing-meeting",
      30,
    );
  legacy.close();
  let service;
  try {
    service = createApp({ dbPath, production: false, demo: false });
    const user = service.db
      .prepare("SELECT * FROM users WHERE id=?")
      .get("legacy-user");
    assert.equal(user.email, "existing@example.com");
    assert.equal(user.password, "historical-password-hash");
    assert.equal(user.onboarded, 1);
    assert.equal(user.photo, null);
    const event = service.db
      .prepare("SELECT * FROM event_types WHERE id=?")
      .get("legacy-event");
    assert.equal(event.title, "Existing meeting");
    assert.equal(event.meeting_url, "");
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const manageToken = (result) =>
  new URL(result.body.manageUrl).pathname.split("/").pop();
const bookFirst = (s) =>
  s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(201);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test("simultaneous reschedules/cancellation are serialized and a pending reschedule survives retries", async (t) => {
  const s = await setup(t),
    result = await bookFirst(s),
    manage = manageToken(result);
  const entered = deferred(),
    release = deferred();
  let changes = 0;
  s.config.calendarProvider.update = async () => {
    changes++;
    entered.resolve();
    await release.promise;
    throw new Error("uncertain response");
  };
  const first = s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[1], timezone: "America/New_York" })
    .then((r) => r);
  await entered.promise;
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[8], timezone: "America/New_York" })
    .expect(409);
  await s.agent
    .post(`/api/bookings/${result.body.booking.id}/cancel`)
    .send({})
    .expect(409);
  release.resolve();
  assert.equal((await first).status, 503);
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(409);
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[8], timezone: "America/New_York" })
    .expect(409);
  assert.equal(changes, 1);
  assert.equal(
    s.db
      .prepare("SELECT count(*) n FROM bookings WHERE status='pending'")
      .get().n,
    1,
  );
  const pending = s.db
    .prepare("SELECT * FROM bookings WHERE status='pending'")
    .get();
  s.db
    .prepare("UPDATE bookings SET created=? WHERE id=?")
    .run(new Date(Date.now() - 120000).toISOString(), pending.id);
  const lookupEntered = deferred(),
    lookupRelease = deferred();
  s.config.calendarProvider.lookup = async () => {
    lookupEntered.resolve();
    await lookupRelease.promise;
    return {
      id: pending.google_id,
      start: { dateTime: pending.start },
      end: { dateTime: pending.end },
    };
  };
  const reconcile = s.agent
    .post(`/api/bookings/${pending.id}/reconcile`)
    .send({})
    .then((r) => r);
  await lookupEntered.promise;
  await s.agent
    .post(`/api/bookings/${pending.id}/reconcile`)
    .send({})
    .expect(409);
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(409);
  lookupRelease.resolve();
  assert.equal((await reconcile).status, 200);
  assert.equal(
    (await s.anon.get(`/api/manage/${manage}`).expect(200)).body.booking
      .start,
    pending.start,
    "Original management link survives recovery",
  );
});

test("uncertain cancellation remains reserved and reconciliation confirms it once", async (t) => {
  const s = await setup(t),
    result = await bookFirst(s),
    manage = manageToken(result),
    id = result.body.booking.id;
  s.config.calendarProvider.cancel = async () => {
    throw new Error("timeout after Google deleted the event");
  };
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(503);
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(409);
  const pending = s.db.prepare("SELECT * FROM bookings WHERE id=?").get(id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.operation, "cancel");
  s.db
    .prepare("UPDATE bookings SET operation_started=? WHERE id=?")
    .run(new Date(Date.now() - 120000).toISOString(), id);
  s.config.calendarProvider.lookup = async () => null;
  await s.agent.post(`/api/bookings/${id}/reconcile`).send({}).expect(200);
  assert.equal(
    (await s.anon.get(`/api/manage/${manage}`)).body.booking.status,
    "cancelled",
  );
  await s.agent.post(`/api/bookings/${id}/reconcile`).send({}).expect(409);
  assert.equal(
    s.mail.filter((m) => m.subject.startsWith("Cancelled")).length,
    2,
  );
});

test("pending Meet links recover asynchronously with one durable notification per recipient", async (t) => {
  const s = await setup(t);
  s.config.calendarProvider.create = async (u, e, b) => ({
    id: "google-" + b.id,
    conferenceData: {
      createRequest: { status: { statusCode: "pending" } },
    },
  });
  const result = await bookFirst(s),
    manage = manageToken(result),
    id = result.body.booking.id;
  assert.equal(result.body.booking.meet_state, "pending");
  assert.equal(result.body.booking.meet_url, null);
  const entered = deferred(),
    release = deferred();
  s.config.calendarProvider.lookup = async () => {
    entered.resolve();
    await release.promise;
    return { hangoutLink: "https://meet.google.com/abc-defg-hij" };
  };
  const recovery = s.recoverMeetLinks();
  await entered.promise;
  await s.recoverMeetLinks();
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(409);
  release.resolve();
  await recovery;
  await s.flushMail();
  await s.recoverMeetLinks();
  const b = (await s.anon.get(`/api/manage/${manage}`).expect(200)).body
    .booking;
  assert.equal(b.meet_url, "https://meet.google.com/abc-defg-hij");
  assert.equal(b.meet_state, "ready");
  assert.equal(
    s.db
      .prepare(
        "SELECT count(*) n FROM outbox WHERE subject LIKE 'Meeting link ready:%'",
      )
      .get().n,
    2,
  );
  assert.equal((await s.anon.get(`/api/manage/${manage}`)).status, 200);
});

test("failed Meet generation can be checked again after host repair", async (t) => {
  const s = await setup(t);
  s.config.calendarProvider.create = async (u, e, b) => ({ id: b.id });
  const result = await bookFirst(s),
    id = result.body.booking.id;
  s.config.calendarProvider.lookup = async () => ({
    conferenceData: {
      createRequest: { status: { statusCode: "failure" } },
    },
  });
  await s.recoverMeetLinks();
  assert.equal(
    s.db.prepare("SELECT meet_state FROM bookings WHERE id=?").get(id)
      .meet_state,
    "failed",
  );
  s.config.calendarProvider.lookup = async () => ({
    conferenceData: {
      entryPoints: [
        {
          entryPointType: "video",
          uri: "https://meet.google.com/abc-defg-hij",
        },
      ],
    },
  });
  await s.agent.post(`/api/bookings/${id}/reconcile`).send({}).expect(200);
  assert.equal(
    s.db.prepare("SELECT meet_state FROM bookings WHERE id=?").get(id)
      .meet_state,
    "ready",
  );
});

test("booking, rescheduling and cancellation responses do not wait for delayed email delivery", async (t) => {
  const s = await setup(t),
    delivery = deferred();
  s.config.deliverMail = async () => delivery.promise;
  try {
    const result = await s.anon
        .post(s.path + "/bookings")
        .send(guest(s.slots[0]))
        .timeout({ response: 1500 })
        .expect(201),
      manage = manageToken(result);
    await s.anon
      .post(`/api/manage/${manage}/reschedule`)
      .send({ start: s.slots[1], timezone: "America/New_York" })
      .timeout({ response: 1500 })
      .expect(200);
    await s.anon
      .post(`/api/manage/${manage}/cancel`)
      .send({})
      .timeout({ response: 1500 })
      .expect(200);
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM outbox WHERE sent=0").get().n,
      6,
    );
  } finally {
    delivery.resolve();
    await new Promise((r) => setImmediate(r));
  }
});

test("existing bookings stay bound to their original Google identity and calendar", async (t) => {
  const s = await setup(t);
  s.db
    .prepare(
      "UPDATE users SET google_account=?,google_calendar=? WHERE id=?",
    )
    .run("original-account", "original@example.com", s.user.id);
  const result = await bookFirst(s),
    manage = manageToken(result);
  const saved = s.db
    .prepare("SELECT * FROM bookings WHERE id=?")
    .get(result.body.booking.id);
  assert.equal(saved.google_account, "original-account");
  assert.equal(saved.google_calendar, "original@example.com");
  assert.equal(result.body.booking.google_account, undefined);
  s.db
    .prepare(
      "UPDATE users SET google_account=?,google_calendar=? WHERE id=?",
    )
    .run("other-account", "other@example.com", s.user.id);
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(409);
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[1], timezone: "America/New_York" })
    .expect(409);
  assert.equal(
    s.calls.filter((c) => ["update", "cancel"].includes(c[0])).length,
    0,
  );
  s.db
    .prepare(
      "UPDATE users SET google_account=?,google_calendar=? WHERE id=?",
    )
    .run("original-account", "original@example.com", s.user.id);
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(200);
});

test("legacy bookings require remote identity/time verification before binding; missing events fail closed", async (t) => {
  const s = await setup(t),
    result = await bookFirst(s),
    manage = manageToken(result),
    id = result.body.booking.id;
  s.db
    .prepare(
      "UPDATE bookings SET google_account=NULL,google_calendar=NULL WHERE id=?",
    )
    .run(id);
  s.config.calendarProvider.lookup = async () => {
    const e = new Error("not found");
    e.providerStatus = 404;
    throw e;
  };
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(409);
  assert.equal(
    s.db.prepare("SELECT status FROM bookings WHERE id=?").get(id).status,
    "scheduled",
  );
  s.config.calendarProvider.lookup = async () => ({
    id: result.body.booking.google_id,
    start: { dateTime: result.body.booking.start },
    end: { dateTime: result.body.booking.end },
  });
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[1], timezone: "America/New_York" })
    .expect(200);
  assert.equal(
    s.db.prepare("SELECT google_account FROM bookings WHERE id=?").get(id)
      .google_account,
    "test-provider",
  );
});

test("OAuth account switching and disconnect are blocked by scheduled and pending appointments", async (t) => {
  const s = await setup(t, {
    googleId: "test-id",
    googleSecret: "test-secret",
    encryptionKey: "1".repeat(64),
  });
  await connectGoogleWithResponses(s, t, () =>
    Response.json({ calendars: { "calendar@example.com": { busy: [] } } }),
  );
  s.config.calendarProvider = {
    busy: async () => [],
    create: async (u, e, b) => ({ id: b.id }),
  };
  const result = await bookFirst(s);
  const old = s.db
    .prepare("SELECT google_refresh FROM users WHERE id=?")
    .get(s.user.id).google_refresh;
  const state = new URL(
    (await s.agent.get("/api/google/connect")).headers.location,
  ).searchParams.get("state");
  t.mock.method(globalThis, "fetch", async (input) =>
    String(input).includes("userinfo")
      ? Response.json({
          email: "other@example.com",
          sub: "other-sub",
          email_verified: true,
        })
      : Response.json({
          refresh_token: "new-token",
          access_token: "new-access",
        }),
  );
  await s.agent
    .get("/api/google/callback")
    .query({ state, code: "fake-code" })
    .expect(409);
  assert.equal(
    s.db
      .prepare("SELECT google_refresh FROM users WHERE id=?")
      .get(s.user.id).google_refresh,
    old,
  );
  await s.agent.post("/api/google/disconnect").send({}).expect(409);
  s.db
    .prepare(
      "UPDATE bookings SET status='pending',start='2001-01-01T00:00:00.000Z' WHERE id=?",
    )
    .run(result.body.booking.id);
  await s.agent.post("/api/google/disconnect").send({}).expect(409);
});

test("small reschedules exclude only their own Google event, following every page and retaining other/all-day conflicts", async (t) => {
  const s = await setup(t, {
    googleId: "test-id",
    googleSecret: "test-secret",
    encryptionKey: "1".repeat(64),
  });
  let remote,
    conflict = false,
    pages = 0;
  await connectGoogleWithResponses(s, t, async (url, opts) => {
    if (url.endsWith("freeBusy"))
      return Response.json({
        calendars: { "calendar@example.com": { busy: [] } },
      });
    if (opts.method === "POST") {
      remote = JSON.parse(opts.body);
      return Response.json({
        ...remote,
        hangoutLink: "https://meet.google.com/abc-defg-hij",
      });
    }
    if (opts.method === "PATCH") {
      remote = { ...remote, ...JSON.parse(opts.body) };
      return Response.json(remote);
    }
    const query = new URL(url).searchParams;
    assert.equal(query.get("singleEvents"), "true");
    pages++;
    if (!query.has("pageToken"))
      return Response.json({ items: [remote], nextPageToken: "page-two" });
    assert.equal(query.get("pageToken"), "page-two");
    return Response.json({
      timeZone: "America/New_York",
      items: conflict
        ? [
            {
              id: "another-event",
              start: { date: s.day },
              end: {
                date: DateTime.fromISO(s.day).plus({ days: 1 }).toISODate(),
              },
            },
          ]
        : [],
    });
  });
  const result = await bookFirst(s),
    manage = manageToken(result);
  const available = await s.anon
    .get(`/api/manage/${manage}/slots`)
    .query({ date: s.day, timezone: "America/New_York" })
    .expect(200);
  assert.ok(available.body.slots.includes(s.slots[1]));
  assert.equal(pages, 2);
  conflict = true;
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[1], timezone: "America/New_York" })
    .expect(409);
  conflict = false;
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[1], timezone: "America/New_York" })
    .expect(200);
  assert.equal(remote.start.dateTime, s.slots[1]);
});

test("staff deactivation revokes sessions/tokens and new bookings while retaining appointments and management", async (t) => {
  const s = await setup(t),
    result = await bookFirst(s),
    manage = manageToken(result);
  // Make a second admin fixture without sending a real invitation.
  s.db
    .prepare(
      "INSERT INTO users(id,name,email,password,slug,role,verified,windows,created,onboarded) SELECT 'admin-two','Second Admin','second@example.com',password,'second-admin','admin',1,windows,created,1 FROM users WHERE id=?",
    )
    .run(s.user.id);
  const admin = supertest.agent(s.app);
  await admin
    .post("/api/auth/login")
    .send({ email: "second@example.com", password })
    .expect(200);
  await s.agent
    .patch(`/api/team/${s.user.id}`)
    .send({ active: false })
    .expect(409);
  await admin
    .post(`/api/team/${s.user.id}/revoke-sessions`)
    .send({})
    .expect(200);
  await s.agent.get("/api/me").expect(401);
  await s.agent
    .post("/api/auth/login")
    .send({ email: "owner@example.com", password })
    .expect(200);
  await admin
    .patch(`/api/team/${s.user.id}`)
    .send({ active: false })
    .expect(200);
  await s.agent.get("/api/me").expect(401);
  await s.anon
    .post("/api/auth/login")
    .send({ email: "owner@example.com", password })
    .expect(403);
  await s.anon.get(s.path).expect(404);
  await s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[8]))
    .expect(404);
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({ start: s.slots[8], timezone: "America/New_York" })
    .expect(409);
  assert.equal(
    s.db
      .prepare("SELECT status FROM bookings WHERE id=?")
      .get(result.body.booking.id).status,
    "scheduled",
  );
  assert.equal(
    s.db
      .prepare("SELECT count(*) n FROM tokens WHERE user_id=?")
      .get(s.user.id).n,
    0,
  );
  await s.anon.post(`/api/manage/${manage}/cancel`).send({}).expect(200);
  await admin
    .patch(`/api/team/${s.user.id}`)
    .send({ active: true })
    .expect(200);
  await s.agent.get("/api/me").expect(401);
  await s.agent
    .post("/api/auth/login")
    .send({ email: "owner@example.com", password })
    .expect(200);
});

test("split windows and date overrides replace weekly hours without losing settings", async (t) => {
  const s = await setup(t),
    u = (await s.agent.get("/api/me")).body.user;
  const weekday = DateTime.fromISO(s.day).weekday;
  const windows = [
    { day: weekday, start: "09:00", end: "12:00" },
    { day: weekday, start: "13:00", end: "17:00" },
  ];
  await s.agent
    .patch("/api/me")
    .send({ ...u, windows, overrides: [{ date: s.day, windows: [] }] })
    .expect(200);
  const query = { date: s.day, timezone: "America/New_York" };
  assert.deepEqual(
    (await s.anon.get(s.path + "/slots").query(query)).body.slots,
    [],
  );
  const dates = (
    await s.anon
      .get(s.path + "/dates")
      .query({ month: s.day.slice(0, 7), timezone: query.timezone })
      .expect(200)
  ).body.dates;
  assert.ok(!dates.includes(s.day));
  await s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(409);
  await s.agent
    .patch("/api/me")
    .send({
      ...u,
      windows,
      overrides: [
        { date: s.day, windows: [{ start: "18:00", end: "19:00" }] },
      ],
    })
    .expect(200);
  let slots = (await s.anon.get(s.path + "/slots").query(query)).body.slots;
  assert.equal(DateTime.fromISO(slots[0]).setZone(query.timezone).hour, 18);
  await s.agent
    .patch("/api/me")
    .send({ ...u, windows, overrides: [] })
    .expect(200);
  slots = (await s.anon.get(s.path + "/slots").query(query)).body.slots;
  assert.ok(
    !slots.some(
      (v) => DateTime.fromISO(v).setZone(query.timezone).hour === 12,
    ),
  );
  await s.agent
    .patch("/api/me")
    .send({
      ...u,
      windows,
      overrides: [
        { date: s.day, windows: [] },
        { date: s.day, windows: [] },
      ],
    })
    .expect(400);
  await s.agent
    .patch("/api/me")
    .send({
      ...u,
      windows,
      overrides: [{ date: "2026-02-30", windows: [] }],
    })
    .expect(400);
});

test("paginated listings and filtered exports include more than 1000 appointments with scope and CSV protections", async (t) => {
  const s = await setup(t),
    insert = s.db.prepare(
      "INSERT INTO bookings(id,event_id,user_id,name,email,timezone,start,end,status,manage_hash,title,location,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
  s.db.exec("BEGIN");
  for (let i = 0; i < 1205; i++)
    insert.run(
      "export-" + i,
      s.event.id,
      s.user.id,
      i === 0 ? '=HYPERLINK("bad")' : "Client " + i,
      "test@example.com",
      "UTC",
      s.slots[0],
      s.slots[1],
      i % 2 ? "cancelled" : "scheduled",
      "hash-" + i,
      "Review, tax",
      "Phone call",
      new Date().toISOString(),
    );
  s.db.exec("COMMIT");
  let offset = 0,
    ids = [];
  do {
    const page = (
      await s.agent
        .get("/api/bookings")
        .query({ offset, limit: 500 })
        .expect(200)
    ).body;
    assert.equal(page.total, 1205);
    ids.push(...page.bookings.map((b) => b.id));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, 1205);
  const full = await s.agent.get("/api/bookings/export").expect(200);
  assert.equal(full.text.split("\r\n").length, 1206);
  assert.ok(full.text.includes("'=HYPERLINK"));
  assert.ok(full.text.includes('"Review, tax"'));
  const filtered = await s.agent
    .get("/api/bookings/export")
    .query({ filter: "cancelled", search: "Client 1" })
    .expect(200);
  const listed = (
    await s.agent
      .get("/api/bookings")
      .query({ filter: "cancelled", search: "Client 1", limit: 500 })
  ).body;
  assert.equal(filtered.text.split("\r\n").length, listed.total + 1);
  s.db.prepare("UPDATE users SET role='member' WHERE id=?").run(s.user.id);
  await s.agent.get("/api/bookings/export?team=true").expect(403);
  await s.agent.get("/api/bookings?team=true").expect(403);
  await s.anon.get("/api/bookings/export").expect(401);
});

test("phone and in-person details persist on bookings, invitations and confirmations", async (t) => {
  const s = await setup(t),
    base = {
      title: "Phone planning",
      duration: 30,
      location: "Phone call",
      color: "#6366f1",
      active: true,
    };
  await s.agent.post("/api/events").send(base).expect(400);
  const event = (
    await s.agent
      .post("/api/events")
      .send({
        ...base,
        instructions: "We will call your number at the scheduled time.",
      })
      .expect(201)
  ).body.event;
  const path = `/api/public/${s.user.slug}/${event.slug}`;
  await s.anon
    .post(path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(400);
  const result = await s.anon
    .post(path + "/bookings")
    .send(guest(s.slots[0], { phone: "+1 (212) 555-0100" }))
    .expect(201);
  assert.equal(result.body.booking.phone, "+1 (212) 555-0100");
  assert.equal(result.body.booking.instructions, event.instructions);
  await s.agent
    .patch(`/api/events/${event.id}`)
    .send({
      ...base,
      instructions: "Different instructions for future clients",
    })
    .expect(200);
  const managed = (await s.anon.get(`/api/manage/${manageToken(result)}`))
    .body.booking;
  assert.equal(managed.instructions, event.instructions);
  assert.ok(
    s.mail
      .find((m) => m.subject === "Confirmed: Phone planning")
      .html.includes("We will call your number"),
  );
  await s.agent
    .post("/api/events")
    .send({ ...base, title: "Office visit", location: "In person" })
    .expect(400);
  await s.agent
    .post("/api/events")
    .send({
      ...base,
      title: "Office visit",
      location: "In person",
      instructions: "123 Example Street, suite 2. Check in at reception.",
    })
    .expect(201);
});

test("fall-back slots retain both UTC instants and spring-forward does not offer nonexistent local times", async (t) => {
  const previous = Settings.now;
  t.after(() => (Settings.now = previous));
  Settings.now = () => Date.parse("2026-10-20T12:00:00Z");
  const s = await setup(t),
    u = (await s.agent.get("/api/me")).body.user;
  await s.agent
    .patch("/api/me")
    .send({ ...u, windows: [{ day: 7, start: "00:00", end: "04:00" }] })
    .expect(200);
  const fall = (
    await s.anon
      .get(s.path + "/slots")
      .query({ date: "2026-11-01", timezone: "America/New_York" })
      .expect(200)
  ).body.slots;
  const repeated = fall.filter(
    (v) =>
      DateTime.fromISO(v).setZone("America/New_York").toFormat("HH:mm") ===
      "01:00",
  );
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0], repeated[1]);
  assert.deepEqual(
    repeated.map(
      (v) => DateTime.fromISO(v).setZone("America/New_York").offset,
    ),
    [-240, -300],
  );
  await s.agent
    .patch("/api/me")
    .send({ ...u, windows: [{ day: 7, start: "01:30", end: "01:45" }] })
    .expect(200);
  const shortWindow = (
    await s.anon
      .get(s.path + "/slots")
      .query({ date: "2026-11-01", timezone: "America/New_York" })
  ).body.slots;
  assert.deepEqual(
    shortWindow,
    [],
    "A 30 minute appointment cannot straddle the closed portion of a repeated 15 minute window",
  );
  await s.agent
    .patch("/api/me")
    .send({ ...u, windows: [{ day: 7, start: "00:00", end: "04:00" }] })
    .expect(200);
  Settings.now = () => Date.parse("2027-03-01T12:00:00Z");
  const spring = (
    await s.anon
      .get(s.path + "/slots")
      .query({ date: "2027-03-14", timezone: "America/New_York" })
      .expect(200)
  ).body.slots;
  assert.ok(spring.length > 0);
  assert.ok(
    !spring.some(
      (v) => DateTime.fromISO(v).setZone("America/New_York").hour === 2,
    ),
  );
  const tokyo = (
    await s.anon
      .get(s.path + "/slots")
      .query({ date: "2027-03-14", timezone: "Asia/Tokyo" })
      .expect(200)
  ).body.slots;
  assert.ok(
    tokyo.every(
      (v) =>
        DateTime.fromISO(v).setZone("Asia/Tokyo").toISODate() ===
        "2027-03-14",
    ),
  );
});

test("restart preserves existing appointment data, pending Meet recovery and onboarding exemptions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bmt-restart-")),
    dbPath = join(dir, "calendar.sqlite");
  let service;
  try {
    service = createApp({
      dbPath,
      demo: true,
      production: false,
      deliverMail: async () => {},
    });
    const user = service.db.prepare("SELECT * FROM users").get(),
      event = service.db
        .prepare("SELECT * FROM event_types WHERE user_id=?")
        .get(user.id);
    const start = DateTime.now().plus({ days: 1 }).toUTC().toISO(),
      end = DateTime.now().plus({ days: 1, hours: 1 }).toUTC().toISO();
    service.db
      .prepare(
        "INSERT INTO bookings(id,event_id,user_id,name,email,timezone,start,end,status,manage_hash,google_id,title,location,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "persisted-booking",
        event.id,
        user.id,
        "Existing Client",
        "client@example.com",
        "UTC",
        start,
        end,
        "scheduled",
        "private-management-hash",
        "existing-google-event",
        "Original title",
        "Google Meet",
        "2026-01-01T00:00:00.000Z",
      );
    service.close();
    service = createApp({
      dbPath,
      demo: true,
      production: false,
      deliverMail: async () => {},
      calendarProvider: {
        lookup: async () => ({
          hangoutLink: "https://meet.google.com/abc-defg-hij",
        }),
      },
    });
    const before = service.db
      .prepare("SELECT * FROM bookings WHERE id='persisted-booking'")
      .get();
    assert.equal(before.meet_state, "pending");
    assert.equal(before.manage_hash, "private-management-hash");
    assert.equal(
      before.google_account,
      null,
      "Legacy binding is not guessed during migration",
    );
    await service.recoverMeetLinks();
    await service.flushMail();
    const after = service.db
      .prepare("SELECT * FROM bookings WHERE id='persisted-booking'")
      .get();
    assert.equal(after.start, start);
    assert.equal(after.end, end);
    assert.equal(after.title, "Original title");
    assert.equal(after.created, "2026-01-01T00:00:00.000Z");
    assert.equal(after.manage_hash, "private-management-hash");
    assert.equal(after.meet_state, "ready");
    const current = service.db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(user.id);
    assert.equal(current.onboarded, 1);
    assert.equal(current.photo, null);
    service.close();
    service = null;
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session revocation during OAuth stops the in-flight callback from storing credentials", async (t) => {
  const s = await setup(t, {
    googleId: "test-id",
    googleSecret: "test-secret",
    encryptionKey: "1".repeat(64),
  });
  const state = new URL(
    (await s.agent.get("/api/google/connect")).headers.location,
  ).searchParams.get("state");
  const entered = deferred(),
    release = deferred();
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).includes("userinfo")) {
      entered.resolve();
      await release.promise;
      return Response.json({
        email: "calendar@example.com",
        sub: "one",
        email_verified: true,
      });
    }
    return Response.json({
      access_token: "fake-access",
      refresh_token: "fake-refresh",
    });
  });
  const callback = s.agent
    .get("/api/google/callback")
    .query({ state, code: "fake-code" })
    .then((r) => r);
  await entered.promise;
  await s.agent
    .post(`/api/team/${s.user.id}/revoke-sessions`)
    .send({})
    .expect(200);
  release.resolve();
  assert.equal((await callback).status, 403);
  assert.equal(
    s.db
      .prepare("SELECT google_refresh FROM users WHERE id=?")
      .get(s.user.id).google_refresh,
    null,
  );
});

test("disconnect and new bookings cannot cross while Google revocation is in flight", async (t) => {
  const s = await setup(t, {
    googleId: "test-id",
    googleSecret: "test-secret",
    encryptionKey: "1".repeat(64),
  });
  await connectGoogleWithResponses(s, t, () =>
    Response.json({ calendars: { "calendar@example.com": { busy: [] } } }),
  );
  s.config.calendarProvider = {
    busy: async () => [],
    create: async () => {
      throw new Error("Must not create an event during disconnect");
    },
  };
  const entered = deferred(),
    release = deferred();
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/revoke");
    entered.resolve();
    await release.promise;
    return Response.json({});
  });
  const disconnect = s.agent
    .post("/api/google/disconnect")
    .send({})
    .then((r) => r);
  await entered.promise;
  await s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .expect(409);
  assert.equal(s.db.prepare("SELECT count(*) n FROM bookings").get().n, 0);
  release.resolve();
  assert.equal((await disconnect).status, 200);
});

test("a legacy disconnected host can reconnect while each old booking remains unbound until verified", async (t) => {
  const s = await setup(t, {
    googleId: "test-id",
    googleSecret: "test-secret",
    encryptionKey: "1".repeat(64),
  });
  const result = await bookFirst(s);
  s.db
    .prepare(
      "UPDATE bookings SET google_account=NULL,google_calendar=NULL WHERE id=?",
    )
    .run(result.body.booking.id);
  await connectGoogleWithResponses(s, t, () =>
    Response.json({ error: { message: "not found" } }, { status: 404 }),
  );
  assert.equal(
    s.db
      .prepare("SELECT google_account FROM bookings WHERE id=?")
      .get(result.body.booking.id).google_account,
    null,
  );
  await s.anon
    .post(`/api/manage/${manageToken(result)}/cancel`)
    .send({})
    .expect(409);
  assert.equal(
    s.db
      .prepare("SELECT status FROM bookings WHERE id=?")
      .get(result.body.booking.id).status,
    "scheduled",
  );
});

test("a still-running create operation cannot be reconciled concurrently", async (t) => {
  const s = await setup(t),
    entered = deferred(),
    release = deferred();
  s.config.calendarProvider.create = async (u, e, b) => {
    entered.resolve();
    await release.promise;
    return {
      id: b.id,
      hangoutLink: "https://meet.google.com/abc-defg-hij",
    };
  };
  const request = s.anon
    .post(s.path + "/bookings")
    .send(guest(s.slots[0]))
    .then((r) => r);
  await entered.promise;
  const pending = s.db
    .prepare("SELECT * FROM bookings WHERE status='pending'")
    .get();
  s.db
    .prepare("UPDATE bookings SET created=? WHERE id=?")
    .run(new Date(Date.now() - 120000).toISOString(), pending.id);
  await s.agent
    .post(`/api/bookings/${pending.id}/reconcile`)
    .send({})
    .expect(409);
  release.resolve();
  assert.equal((await request).status, 201);
});
