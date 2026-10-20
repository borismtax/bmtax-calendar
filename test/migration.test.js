import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { createHash, scryptSync } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { createApp } from "../server.js";

const tables = [
  "users",
  "event_types",
  "bookings",
  "sessions",
  "tokens",
  "outbox",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixturePassword = "Isolated migration fixture password!";
const handles = {
  meet: "a".repeat(64),
  zoom: "b".repeat(64),
  cancelled: "c".repeat(64),
  pending: "d".repeat(64),
  failed: "e".repeat(64),
  reschedule: "f".repeat(64),
};
const snapshot = (db) =>
  Object.fromEntries(
    tables.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
const schema = (db) =>
  db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all()
    .map((row) => ({ ...row }));
const checks = (db) => {
  assert.equal(
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
};
function seedLegacy(path, profiles) {
  const db = new DatabaseSync(path);
  db.exec(
    readFileSync(
      new URL("./fixtures/pre-profile-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec("PRAGMA wal_autocheckpoint=0");
  if (profiles)
    db.exec(
      "ALTER TABLE users ADD COLUMN photo TEXT; ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 1; ALTER TABLE event_types ADD COLUMN meeting_url TEXT NOT NULL DEFAULT '';",
    );
  const password =
    "fixture-salt:" +
    scryptSync(fixturePassword, "fixture-salt", 64).toString("hex");
  const windows = JSON.stringify([
    { day: 1, start: "09:00", end: "12:00" },
    { day: 1, start: "13:00", end: "17:00" },
  ]);
  const userInsert = db.prepare(
    "INSERT INTO users(id,name,email,password,slug,role,verified,windows,google_email,google_refresh,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  userInsert.run(
    "owner",
    "Legacy Owner",
    "owner@example.test",
    password,
    "legacy-owner",
    "admin",
    1,
    windows,
    "owner@calendar.example.test",
    "synthetic-encrypted-token-record",
    "2025-01-01T00:00:00.000Z",
  );
  userInsert.run(
    "member",
    "Legacy Member",
    "member@example.test",
    password,
    "legacy-member",
    "member",
    1,
    windows,
    "member@calendar.example.test",
    "synthetic-member-token-record",
    "2025-02-01T00:00:00.000Z",
  );
  userInsert.run(
    "setup",
    "Setup Pending",
    "setup@example.test",
    password,
    "setup-pending",
    "member",
    1,
    windows,
    null,
    null,
    "2026-10-01T00:00:00.000Z",
  );
  userInsert.run(
    "unverified",
    "Unverified User",
    "unverified@example.test",
    password,
    "unverified",
    "member",
    0,
    windows,
    null,
    null,
    "2026-10-01T00:00:00.000Z",
  );
  if (profiles) {
    db.prepare("UPDATE users SET onboarded=0 WHERE id='setup'").run();
    db.prepare("UPDATE users SET photo=? WHERE id='member'").run(
      "data:image/jpeg;base64,c3ludGhldGlj",
    );
  }
  const eventInsert = db.prepare(
    "INSERT INTO event_types(id,user_id,title,slug,duration,description,location,color,active) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  eventInsert.run(
    "meet-event",
    "owner",
    "Legacy Meet",
    "legacy-meet",
    30,
    "Original description",
    "Google Meet",
    "#6366f1",
    1,
  );
  eventInsert.run(
    "zoom-event",
    "owner",
    "Legacy Zoom",
    "legacy-zoom",
    45,
    "Zoom remains private",
    "Zoom",
    "#10b981",
    1,
  );
  eventInsert.run(
    "phone-event",
    "member",
    "Legacy Phone",
    "legacy-phone",
    30,
    "Calling details from the old description",
    "Phone call",
    "#f59e0b",
    0,
  );
  if (profiles)
    db.prepare(
      "UPDATE event_types SET meeting_url=? WHERE id='zoom-event'",
    ).run("https://us02web.zoom.us/j/1234567890?pwd=synthetic");
  const base = Date.now() + 7 * 86400_000;
  const bookingInsert = db.prepare(
    "INSERT INTO bookings(id,event_id,user_id,name,email,notes,timezone,start,end,status,manage_hash,google_id,meet_url,title,location,created,operation,parent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const [index, [id, status, event, parent, operation]] of [
    ["meet", "scheduled", "meet-event", null, "create"],
    ["zoom", "scheduled", "zoom-event", null, "create"],
    ["cancelled", "cancelled", "meet-event", null, "create"],
    ["pending", "pending", "meet-event", null, "create"],
    ["failed", "failed", "meet-event", null, "create"],
    ["reschedule", "pending", "zoom-event", "zoom", "reschedule"],
  ].entries()) {
    bookingInsert.run(
      id,
      event,
      "owner",
      `Synthetic Guest ${id}`,
      `${id}@example.test`,
      "Preserve these original notes",
      "America/New_York",
      new Date(base + index * 86400_000).toISOString(),
      new Date(
        base +
          index * 86400_000 +
          (event === "zoom-event" ? 45 : 30) * 60_000,
      ).toISOString(),
      status,
      hash(handles[id]),
      id === "reschedule" ? "remote-zoom" : `remote-${id}`,
      event === "zoom-event" && id !== "reschedule"
        ? "https://us02web.zoom.us/j/1234567890?pwd=synthetic"
        : null,
      event === "zoom-event" ? "Legacy Zoom" : "Legacy Meet",
      event === "zoom-event" ? "Zoom" : "Google Meet",
      "2025-05-01T00:00:00.000Z",
      operation,
      parent,
    );
  }
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    hash("synthetic-existing-session"),
    "owner",
    Date.now() + 86400_000,
  );
  db.prepare("INSERT INTO tokens VALUES(?,?,?,?,?,?)").run(
    hash("synthetic-existing-token"),
    "member",
    "reset",
    null,
    null,
    Date.now() + 86400_000,
  );
  db.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?)").run(
    "retry-mail",
    "meet@example.test",
    "Synthetic queued confirmation",
    "<p>Fixture only</p>",
    3,
    Date.now() + 86400_000,
    0,
    "Retry fixture",
  );
  db.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?)").run(
    "sent-mail",
    "zoom@example.test",
    "Synthetic sent confirmation",
    "<p>Fixture only</p>",
    0,
    0,
    1,
    null,
  );
  checks(db);
  return db;
}

for (const profiles of [false, true])
  test(`online backup, restore and additive migration preserve ${profiles ? "c978424 profile/Zoom" : "61741fc pre-profile"} accounts and appointments`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bmt-backup-rehearsal-"));
    const paths = Object.fromEntries(
      [
        "source",
        "backup",
        "restored",
        "rollback",
        "upgradedBackup",
        "upgradedRestore",
      ].map((key) => [key, join(directory, key + ".sqlite")]),
    );
    let source,
      backupDb,
      rollback,
      service,
      reopened,
      upgradedDb,
      postRestore;
    let externalCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      externalCalls++;
      throw new Error("External network is forbidden in this rehearsal");
    });
    try {
      source = seedLegacy(paths.source, profiles);
      const original = snapshot(source),
        originalSchema = schema(source);
      assert.ok(
        statSync(paths.source + "-wal").size > 0,
        "Exercise a database with uncheckpointed WAL contents",
      );
      const copiedPages = await backup(source, paths.backup);
      assert.ok(copiedPages > 0);
      source
        .prepare(
          "UPDATE users SET name='Changed only after backup' WHERE id='owner'",
        )
        .run();
      backupDb = new DatabaseSync(paths.backup);
      checks(backupDb);
      assert.deepEqual(
        snapshot(backupDb),
        original,
        "Online backup includes all committed WAL records and isolates later changes",
      );
      assert.deepEqual(schema(backupDb), originalSchema);
      await backup(backupDb, paths.restored);
      await backup(backupDb, paths.rollback);
      const mail = [];
      const options = {
        dbPath: paths.restored,
        production: false,
        demo: false,
        testMode: true,
        baseUrl: "http://localhost:3000",
        deliverMail: async (item) => mail.push(item),
        calendarProvider: {
          busy: async () => [],
          lookup: async (u, b) => ({
            id: b.google_id,
            organizer: { self: true, email: u.google_email },
            start: { dateTime: b.start },
            end: { dateTime: b.end },
          }),
          cancel: async () => {},
        },
      };
      service = createApp(options);
      checks(service.db);
      const migrated = snapshot(service.db);
      for (const table of tables) {
        assert.equal(
          migrated[table].length,
          original[table].length,
          `${table} count preserved`,
        );
        for (let i = 0; i < original[table].length; i++) {
          for (const [column, value] of Object.entries(original[table][i]))
            assert.deepEqual(
              migrated[table][i][column],
              value,
              `${table}[${i}].${column} preserved`,
            );
        }
      }
      for (const user of migrated.users) {
        assert.equal(user.active, 1);
        assert.equal(user.google_account, null);
        assert.equal(user.google_calendar, null);
        assert.equal(user.overrides, "[]");
        assert.equal(
          user.onboarded,
          profiles && user.id === "setup" ? 0 : 1,
        );
      }
      assert.equal(
        migrated.bookings.find((b) => b.id === "meet").meet_state,
        "pending",
      );
      assert.ok(
        migrated.bookings.every(
          (b) => b.google_account === null && b.google_calendar === null,
        ),
        "Migration never guesses old calendar ownership",
      );
      const afterSchema = schema(service.db);
      service.close();
      service = null;
      reopened = createApp(options);
      checks(reopened.db);
      assert.deepEqual(
        snapshot(reopened.db),
        migrated,
        "Second startup is data-idempotent",
      );
      assert.deepEqual(
        schema(reopened.db),
        afterSchema,
        "Second startup is schema-idempotent",
      );
      const anon = supertest(reopened.app);
      for (const [id, value] of Object.entries(handles)) {
        const response = await anon.get(`/api/manage/${value}`).expect(200);
        assert.equal(response.body.booking.id, id);
        assert.equal(
          response.body.booking.start,
          original.bookings.find((b) => b.id === id).start,
        );
      }
      const owner = supertest.agent(reopened.app),
        member = supertest.agent(reopened.app),
        setup = supertest.agent(reopened.app);
      for (const [agent, email] of [
        [owner, "owner@example.test"],
        [member, "member@example.test"],
        [setup, "setup@example.test"],
      ])
        await agent
          .post("/api/auth/login")
          .send({ email, password: fixturePassword })
          .expect(200);
      await owner.get("/api/bookings").expect(200);
      await member
        .patch("/api/team/owner")
        .send({ active: false })
        .expect(403);
      await member.get("/api/bookings?team=true").expect(403);
      await member
        .post("/api/bookings/meet/reconcile")
        .send({})
        .expect(404);
      await setup.get("/api/events").expect(profiles ? 403 : 200);
      await anon
        .post("/api/auth/login")
        .send({
          email: "unverified@example.test",
          password: fixturePassword,
        })
        .expect(403);
      // Verify an old event against its own calendar before a local cancellation.
      await anon
        .post(`/api/manage/${handles.meet}/cancel`)
        .send({})
        .expect(200);
      const bound = reopened.db
        .prepare("SELECT * FROM bookings WHERE id='meet'")
        .get();
      assert.equal(bound.google_account, "owner@calendar.example.test");
      assert.equal(bound.google_calendar, "owner@calendar.example.test");
      assert.equal(bound.status, "cancelled");
      // A legacy pending reschedule must bind its parent too and retain its link/Zoom URL.
      await owner
        .post("/api/bookings/reschedule/reconcile")
        .send({})
        .expect(200);
      const zoom = reopened.db
        .prepare("SELECT * FROM bookings WHERE id='zoom'")
        .get();
      assert.equal(
        zoom.start,
        original.bookings.find((b) => b.id === "reschedule").start,
      );
      assert.equal(zoom.manage_hash, hash(handles.zoom));
      assert.equal(
        zoom.meet_url,
        original.bookings.find((b) => b.id === "zoom").meet_url,
      );
      assert.equal(zoom.google_account, "owner@calendar.example.test");
      assert.equal(
        reopened.db
          .prepare("SELECT count(*) n FROM bookings WHERE id='reschedule'")
          .get().n,
        0,
      );
      await reopened.flushMail();
      // Also rehearse backup/restore after migration and local state changes.
      const postMigration = snapshot(reopened.db);
      await backup(reopened.db, paths.upgradedBackup);
      upgradedDb = new DatabaseSync(paths.upgradedBackup);
      await backup(upgradedDb, paths.upgradedRestore);
      upgradedDb.close();
      upgradedDb = null;
      postRestore = createApp({
        ...options,
        dbPath: paths.upgradedRestore,
      });
      checks(postRestore.db);
      assert.deepEqual(snapshot(postRestore.db), postMigration);
      // Rollback restores the exact pre-upgrade schema and records, not the changed source.
      rollback = new DatabaseSync(paths.rollback);
      checks(rollback);
      assert.deepEqual(snapshot(rollback), original);
      assert.deepEqual(schema(rollback), originalSchema);
      assert.deepEqual(
        snapshot(backupDb),
        original,
        "Pre-upgrade backup remains untouched by migration/management tests",
      );
      assert.equal(externalCalls, 0);
      t.diagnostic(
        JSON.stringify({
          baseline: profiles ? "c978424" : "61741fc",
          users: 4,
          eventTypes: 3,
          appointments: 6,
          sessions: 1,
          tokens: 1,
          outbox: 2,
          onlineBackupPages: copiedPages,
          integrity: "ok",
          foreignKeys: "ok",
          idempotent: true,
          rollbackExact: true,
          externalCalls,
        }),
      );
    } finally {
      service?.close();
      reopened?.close();
      postRestore?.close();
      source?.close();
      backupDb?.close();
      rollback?.close();
      upgradedDb?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
