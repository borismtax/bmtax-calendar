import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { createHash } from "node:crypto";
import supertest from "supertest";
import { DateTime } from "luxon";
import { createApp } from "../server.js";
import { googleClientFingerprint } from "../google-credentials.js";

const password = "Synthetic client migration password!";
const scopes =
  "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "bmt-client-binding-"));
  const mail = [],
    calls = [];
  const options = {
    dbPath: join(directory, "calendar.sqlite"),
    production: false,
    demo: false,
    testMode: true,
    ownerEmail: "owner@example.test",
    baseUrl: "http://localhost:3000",
    googleId: "old-client",
    googleSecret: "old-secret",
    googleLegacyId: undefined,
    encryptionKey: "1".repeat(64),
    deliverMail: async (message) => mail.push(message),
  };
  let service = createApp(options);
  let agent = supertest.agent(service.app);
  const identity = {
    sub: "same-account",
    email: "calendar@example.test",
    email_verified: true,
  };
  let hook;
  const handler = async (input, opts = {}) => {
    const url = String(input);
    calls.push({ url, opts });
    if (hook) {
      const result = await hook(url, opts);
      if (result) return result;
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const client = opts.body.get("client_id");
      if (opts.body.get("grant_type") === "refresh_token")
        assert.equal(
          opts.body.get("refresh_token"),
          client + "-refresh",
          "Never exchange a token with a different client",
        );
      return Response.json({
        access_token: client + "-access",
        refresh_token: client + "-refresh",
        scope: scopes,
      });
    }
    if (url.includes("userinfo")) return Response.json(identity);
    if (url.endsWith("/revoke")) return Response.json({});
    if (url.endsWith("/freeBusy"))
      return Response.json({
        calendars: { "calendar@example.test": { busy: [] } },
      });
    if (url.includes("/events") && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      return Response.json({
        ...body,
        id: body.id,
        hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
      });
    }
    throw new Error("Unexpected synthetic provider request");
  };
  t.mock.method(globalThis, "fetch", handler);
  t.after(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await agent
    .post("/api/auth/register")
    .send({ name: "Migration Host", email: options.ownerEmail, password })
    .expect(201);
  const verify = mail
    .find((m) => m.subject.includes("Verify"))
    .html.match(/verify\?token=([a-f0-9]+)/)[1];
  const verified = await agent
    .post("/api/auth/verify")
    .send({ token: verify })
    .expect(200);
  const userId = verified.body.user.id;
  service.db
    .prepare("UPDATE users SET onboarded=1,notice=0,windows=? WHERE id=?")
    .run(
      JSON.stringify(
        [1, 2, 3, 4, 5, 6, 7].map((day) => ({
          day,
          start: "09:00",
          end: "17:00",
        })),
      ),
      userId,
    );
  const user = service.db
    .prepare("SELECT * FROM users WHERE id=?")
    .get(userId);
  const event = service.db
    .prepare("SELECT * FROM event_types WHERE user_id=? LIMIT 1")
    .get(userId);
  const date = DateTime.now()
    .setZone(user.timezone)
    .plus({ days: 2 })
    .toISODate();
  const path = `/api/public/${user.slug}/${event.slug}`;
  const start = DateTime.fromISO(date + "T09:00", { zone: user.timezone })
    .toUTC()
    .toISO();
  const guest = {
    name: "Synthetic Guest",
    email: "guest@example.test",
    timezone: user.timezone,
    start,
  };
  return {
    get service() {
      return service;
    },
    get agent() {
      return agent;
    },
    get anon() {
      return supertest(service.app);
    },
    userId,
    date,
    path,
    guest,
    calls,
    identity,
    setHook(value) {
      hook = value;
    },
    user() {
      return service.db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(userId);
    },
    async state() {
      return new URL(
        (
          await agent.get("/api/google/connect").expect(302)
        ).headers.location,
      ).searchParams.get("state");
    },
    async connect() {
      const state = await this.state();
      return agent
        .get("/api/google/callback")
        .query({ state, code: "synthetic-code" });
    },
    async restart(changes = {}) {
      const settings = { ...service.config, ...changes };
      service.close();
      service = createApp(settings);
      agent = supertest.agent(service.app);
      await agent
        .post("/api/auth/login")
        .send({ email: options.ownerEmail, password })
        .expect(200);
    },
  };
}

test("client mismatch blocks public mutations, slots, diagnostics, revocation and background Meet recovery before sending tokens", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  const created = await s.anon
    .post(s.path + "/bookings")
    .send(s.guest)
    .expect(201);
  const manage = new URL(created.body.manageUrl).pathname.split("/").pop();
  const id = created.body.booking.id;
  s.service.db
    .prepare(
      "UPDATE bookings SET meet_state='pending',meet_retry_at=0 WHERE id=?",
    )
    .run(id);
  const tokenBefore = s.user().google_refresh;
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  s.calls.length = 0;
  const me = await s.agent.get("/api/me").expect(200);
  assert.equal(me.body.user.googleConnected, false);
  assert.equal(me.body.user.googleReconnectRequired, true);
  for (const secret of [
    "google_client_hash",
    "google_refresh",
    tokenBefore,
    "old-client",
  ])
    assert.ok(!JSON.stringify(me.body).includes(secret));
  const diagnostic = await s.agent.get("/api/google/status").expect(200);
  assert.equal(diagnostic.body.code, "CLIENT_RECONNECT_REQUIRED");
  assert.deepEqual(diagnostic.body.diagnostics, {});
  await s.anon
    .get(s.path + "/slots")
    .query({ date: s.date, timezone: s.guest.timezone })
    .expect(503);
  await s.anon
    .post(s.path + "/bookings")
    .send(s.guest)
    .expect(503);
  await s.anon
    .post(`/api/manage/${manage}/reschedule`)
    .send({
      start: DateTime.fromISO(s.guest.start).plus({ hours: 1 }).toISO(),
      timezone: s.guest.timezone,
    })
    .expect(503);
  const cancel = await s.anon.post(`/api/manage/${manage}/cancel`).send({});
  assert.ok(cancel.status >= 400);
  await s.agent.post("/api/google/disconnect").send({}).expect(409);
  await s.service.recoverMeetLinks();
  assert.equal(
    s.calls.length,
    0,
    "No provider call on any mismatched-client path",
  );
  assert.equal(s.user().google_refresh, tokenBefore);
  const appointment = s.service.db
    .prepare("SELECT * FROM bookings WHERE id=?")
    .get(id);
  assert.equal(appointment.status, "scheduled");
  assert.equal(appointment.start, s.guest.start);
  assert.equal(appointment.google_id, created.body.booking.google_id);
  await s.agent.get("/api/bookings/export").expect(200);
});

test("same-account reconnect retains original ciphertext and safely switches both directions across restarts", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  const original = s.user();
  const created = await s.anon
    .post(s.path + "/bookings")
    .send(s.guest)
    .expect(201);
  const bookingBefore = s.service.db
    .prepare("SELECT * FROM bookings WHERE id=?")
    .get(created.body.booking.id);
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  s.identity.email = "renamed@example.test"; // Stable Google subject, unchanged calendar.
  assert.equal((await s.connect()).status, 302);
  assert.equal(
    s.user().google_client_hash,
    googleClientFingerprint("new-client"),
  );
  assert.equal(s.user().google_calendar, original.google_calendar);
  const saved = s.service.db
    .prepare("SELECT * FROM google_token_history WHERE user_id=?")
    .get(s.userId);
  assert.equal(saved.encrypted_refresh, original.google_refresh);
  assert.equal(saved.client_hash, original.google_client_hash);
  assert.ok(!saved.encrypted_refresh.includes("old-client-refresh"));
  const nextToken = s.user().google_refresh;
  for (const client of ["new-client", "old-client", "new-client"]) {
    await s.restart({ googleId: client, googleSecret: client + "-secret" });
    const me = await s.agent.get("/api/me").expect(200);
    assert.equal(me.body.user.googleConnected, true);
    assert.equal(me.body.user.googleReconnectRequired, false);
    const health = await s.agent.get("/api/google/status").expect(200);
    assert.equal(health.body.healthy, true);
    assert.equal(
      s.user().google_refresh,
      nextToken,
      "Selecting rollback credentials never overwrites newer tokens",
    );
  }
  assert.deepEqual(
    s.service.db
      .prepare("SELECT * FROM bookings WHERE id=?")
      .get(created.body.booking.id),
    bookingBefore,
  );
  const exchanges = s.calls.filter(
    ({ url, opts }) =>
      url.endsWith("/token") &&
      opts.body.get("grant_type") === "refresh_token",
  );
  assert.ok(
    exchanges.some(
      ({ opts }) => opts.body.get("client_id") === "old-client",
    ),
  );
  assert.ok(
    exchanges.some(
      ({ opts }) => opts.body.get("client_id") === "new-client",
    ),
  );
});

test("disconnect revokes only the current client's token, retains old-client rollback tokens and never revives revoked history", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  const old = s.user().google_refresh;
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  await s.agent.post("/api/google/disconnect").send({}).expect(409);
  assert.ok(!s.calls.some(({ url }) => url.endsWith("/revoke")));
  assert.equal((await s.connect()).status, 302);
  // Reconnecting twice exercises history for the active client too.
  assert.equal((await s.connect()).status, 302);
  await s.agent.post("/api/google/disconnect").send({}).expect(200);
  const revoked = s.calls.filter(({ url }) => url.endsWith("/revoke"));
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].opts.body.get("token"), "new-client-refresh");
  assert.equal(
    (await s.agent.get("/api/me")).body.user.googleConnected,
    false,
  );
  await s.restart({ googleId: "old-client", googleSecret: "old-secret" });
  assert.equal(
    (await s.agent.get("/api/google/status")).body.healthy,
    true,
  );
  assert.equal(
    s.service.db
      .prepare(
        "SELECT encrypted_refresh FROM google_token_history WHERE client_hash=?",
      )
      .get(googleClientFingerprint("old-client")).encrypted_refresh,
    old,
  );
  await s.agent.post("/api/google/disconnect").send({}).expect(200);
  assert.equal(
    (await s.agent.get("/api/me")).body.user.googleConnected,
    false,
  );
});

test("unknown legacy tokens never leave the server; verified same-client backfill is explicit and happens once", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  const original = s.user().google_refresh;
  s.service.db
    .prepare("UPDATE users SET google_client_hash=NULL WHERE id=?")
    .run(s.userId);
  await s.restart();
  s.calls.length = 0;
  assert.equal(
    (await s.agent.get("/api/google/status")).body.code,
    "CLIENT_RECONNECT_REQUIRED",
  );
  await s.agent.post("/api/google/disconnect").send({}).expect(409);
  assert.equal(s.calls.length, 0);
  // A claimed old ID that does not match the active client cannot backfill.
  await s.restart({ googleId: "new-client", googleLegacyId: "old-client" });
  assert.equal(s.user().google_client_hash, null);
  assert.equal(
    (await s.agent.get("/api/google/status")).body.code,
    "CLIENT_RECONNECT_REQUIRED",
  );
  assert.equal(s.calls.length, 0);
  await s.restart({ googleId: "old-client", googleLegacyId: "old-client" });
  assert.equal(
    s.user().google_client_hash,
    googleClientFingerprint("old-client"),
  );
  assert.equal(s.user().google_refresh, original);
  assert.equal(
    (await s.agent.get("/api/google/status")).body.healthy,
    true,
  );
  const before = s.user();
  await s.restart();
  assert.deepEqual(s.user(), before, "Verified backfill is idempotent");
  s.service.db
    .prepare("UPDATE users SET google_client_hash=NULL WHERE id=?")
    .run(s.userId);
  await s.restart();
  assert.equal(
    s.user().google_client_hash,
    null,
    "Later unbound records are not silently relabeled",
  );
  assert.equal(s.user().google_refresh, original);
});

test("new consent preserves unknown original tokens without assigning them a client or permitting a different Google account", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  const original = s.user().google_refresh;
  s.service.db
    .prepare("UPDATE users SET google_client_hash=NULL WHERE id=?")
    .run(s.userId);
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  s.identity.sub = "other-account";
  s.identity.email = "other@example.test";
  assert.equal((await s.connect()).status, 409);
  assert.equal(s.user().google_refresh, original);
  s.identity.sub = "same-account";
  s.identity.email = "calendar@example.test";
  assert.equal((await s.connect()).status, 302);
  const saved = s.service.db
    .prepare("SELECT * FROM google_token_history")
    .get();
  assert.equal(saved.encrypted_refresh, original);
  assert.equal(saved.client_hash, null);
  await s.restart({ googleId: "old-client", googleSecret: "old-secret" });
  s.calls.length = 0;
  assert.equal(
    (await s.agent.get("/api/google/status")).body.code,
    "CLIENT_RECONNECT_REQUIRED",
  );
  assert.equal(s.calls.length, 0);
});

test("pending OAuth states bind client and redirect, reject legacy states and stay single-use without exchanging mismatched codes", async (t) => {
  const s = await fixture(t);
  const state = await s.state();
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  const callback = () =>
    s.agent
      .get("/api/google/callback")
      .query({ state, code: "synthetic-code" });
  await callback().expect(409);
  await callback().expect(400);
  assert.equal(s.calls.length, 0);
  for (const stateData of [
    "a".repeat(64),
    JSON.stringify({
      version: 1,
      verifier: "a".repeat(64),
      clientHash: googleClientFingerprint("new-client"),
      redirectUri: "https://wrong.example/callback",
    }),
  ]) {
    const value = await s.state();
    s.service.db
      .prepare("UPDATE tokens SET data=? WHERE hash=?")
      .run(stateData, createHash("sha256").update(value).digest("hex"));
    await s.agent
      .get("/api/google/callback")
      .query({ state: value, code: "synthetic-code" })
      .expect(409);
  }
  assert.equal(s.calls.length, 0);
  assert.equal((await s.connect()).status, 302);
});

test("a client change during the OAuth callback cannot save a token under the new client", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  const original = s.user();
  const state = await s.state();
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  s.setHook(async (url) => {
    if (url.includes("userinfo")) {
      entered();
      await held;
    }
  });
  const callback = s.agent
    .get("/api/google/callback")
    .query({ state, code: "synthetic-code" })
    .then((r) => r);
  await started;
  s.service.config.googleId = "new-client";
  s.service.config.googleSecret = "new-secret";
  release();
  assert.equal((await callback).status, 409);
  assert.deepEqual(s.user(), original);
  assert.equal(
    s.service.db
      .prepare("SELECT count(*) AS n FROM google_token_history")
      .get().n,
    0,
  );
});

test("online backup and restore preserve both client token versions and connection bindings exactly", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  assert.equal((await s.connect()).status, 302);
  const primary = s.user();
  const history = s.service.db
    .prepare("SELECT * FROM google_token_history ORDER BY id")
    .all();
  const restored = s.service.config.dbPath + ".restored";
  await backup(s.service.db, restored);
  s.service.db
    .prepare("UPDATE users SET name='Changed after backup' WHERE id=?")
    .run(s.userId);
  await s.restart({
    dbPath: restored,
    googleId: "old-client",
    googleSecret: "old-secret",
  });
  assert.deepEqual(s.user(), primary);
  assert.deepEqual(
    s.service.db
      .prepare("SELECT * FROM google_token_history ORDER BY id")
      .all(),
    history,
  );
  assert.equal(
    s.service.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.deepEqual(
    s.service.db.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
  assert.equal(
    (await s.agent.get("/api/google/status")).body.healthy,
    true,
  );
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  assert.equal(
    (await s.agent.get("/api/google/status")).body.healthy,
    true,
  );
});

test("retained rollback credentials never cross an account or calendar binding", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  assert.equal((await s.connect()).status, 302);
  await s.restart({ googleId: "old-client", googleSecret: "old-secret" });
  const primary = s.user();
  s.calls.length = 0;
  for (const [account, calendar] of [
    ["another-account", primary.google_calendar],
    [primary.google_account, "other-calendar@example.test"],
  ]) {
    s.service.db
      .prepare(
        "UPDATE users SET google_account=?,google_calendar=? WHERE id=?",
      )
      .run(account, calendar, s.userId);
    assert.equal(
      (await s.agent.get("/api/google/status")).body.code,
      "CLIENT_RECONNECT_REQUIRED",
    );
    assert.equal(
      (await s.agent.get("/api/me")).body.user.googleConnected,
      false,
    );
  }
  assert.equal(s.calls.length, 0);
  assert.equal(s.user().google_refresh, primary.google_refresh);
});

test("rejected new-client scopes retain originals and a rejected current grant never falls back to stale history", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.connect()).status, 302);
  const old = s.user();
  await s.restart({ googleId: "new-client", googleSecret: "new-secret" });
  s.setHook(async (url) =>
    url.endsWith("/token")
      ? Response.json({
          access_token: "new-access",
          refresh_token: "new-client-refresh",
          scope: "openid email",
        })
      : undefined,
  );
  assert.equal((await s.connect()).status, 400);
  assert.deepEqual(s.user(), old);
  assert.equal(
    s.service.db
      .prepare("SELECT count(*) AS n FROM google_token_history")
      .get().n,
    0,
  );
  s.setHook(null);
  assert.equal((await s.connect()).status, 302);
  assert.equal((await s.connect()).status, 302);
  const primary = s.user();
  s.calls.length = 0;
  s.setHook(async (url) =>
    url.endsWith("/token")
      ? Response.json(
          {
            error: "invalid_grant",
            error_description: "PRIVATE_PROVIDER_DESCRIPTION",
          },
          { status: 400 },
        )
      : undefined,
  );
  const result = await s.agent.get("/api/google/status").expect(200);
  assert.equal(result.body.code, "RECONNECT_REQUIRED");
  assert.equal(
    s.calls.length,
    1,
    "Do not retry an old token after a grant rejection",
  );
  assert.equal(s.calls[0].opts.body.get("client_id"), "new-client");
  assert.equal(
    s.calls[0].opts.body.get("refresh_token"),
    "new-client-refresh",
  );
  assert.ok(
    !JSON.stringify(result.body).includes("PRIVATE_PROVIDER_DESCRIPTION"),
  );
  assert.deepEqual(s.user(), primary);
});
