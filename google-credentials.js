import { createHash } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const googleClientFingerprint = (clientId) =>
  typeof clientId === "string" && clientId.length > 0
    ? digest("google-oauth-client\0" + clientId)
    : null;

// Tokens stay encrypted at rest. Client fingerprints are local bindings, not
// project identifiers and never a reason to infer a Google Cloud project.
export function googleCredentials(db, config) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_token_history (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_hash TEXT, encrypted_refresh TEXT NOT NULL,
      google_account TEXT, google_email TEXT, google_calendar TEXT,
      usable INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS google_token_client ON google_token_history(user_id,client_hash,usable);
    CREATE TABLE IF NOT EXISTS google_oauth_migrations (name TEXT PRIMARY KEY, client_hash TEXT NOT NULL);
  `);
  const currentClient = () => googleClientFingerprint(config.googleId);
  // Never infer the issuer of untagged tokens from the current configuration.
  // A verified legacy ID must be supplied explicitly while that client is still
  // active. Record this one-time backfill so future unknown tokens stay unknown.
  if (
    config.googleLegacyId &&
    config.googleLegacyId === config.googleId &&
    !db
      .prepare(
        "SELECT name FROM google_oauth_migrations WHERE name='legacy-client'",
      )
      .get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE users SET google_client_hash=? WHERE google_refresh IS NOT NULL AND google_client_hash IS NULL",
      ).run(currentClient());
      db.prepare(
        "INSERT INTO google_oauth_migrations(name,client_hash) VALUES('legacy-client',?)",
      ).run(currentClient());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const accountMatches = (old, user) =>
    old.google_account && user.google_account
      ? old.google_account === user.google_account
      : !!old.google_email &&
        old.google_email.toLowerCase() === user.google_email?.toLowerCase();
  const calendar = (user) =>
    user.google_calendar || user.google_email?.toLowerCase();
  const credential = (user) => {
    const clientHash = currentClient();
    if (!clientHash) return null;
    if (user.google_client_hash === clientHash)
      return user.google_refresh
        ? { clientHash, encryptedRefresh: user.google_refresh }
        : null;
    // Returning to an earlier client can use only that client's retained token
    // for the same account/calendar. Unknown and revoked history never qualifies.
    const saved = db
      .prepare(
        "SELECT * FROM google_token_history WHERE user_id=? AND client_hash=? AND usable=1 ORDER BY rowid DESC",
      )
      .all(user.id, clientHash)
      .find(
        (old) =>
          accountMatches(old, user) && calendar(old) === calendar(user),
      );
    return saved
      ? { clientHash, encryptedRefresh: saved.encrypted_refresh }
      : null;
  };
  const hasStored = (user) =>
    !!user.google_refresh ||
    !!db
      .prepare(
        "SELECT id FROM google_token_history WHERE user_id=? AND usable=1 LIMIT 1",
      )
      .get(user.id);
  const archive = (user) => {
    if (!user.google_refresh) return;
    db.prepare(
      "INSERT OR IGNORE INTO google_token_history(id,user_id,client_hash,encrypted_refresh,google_account,google_email,google_calendar,created) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      digest(user.id + "\0" + user.google_refresh),
      user.id,
      user.google_client_hash,
      user.google_refresh,
      user.google_account,
      user.google_email,
      user.google_calendar,
      new Date().toISOString(),
    );
  };
  const save = (
    user,
    encryptedRefresh,
    info,
    nextCalendar,
    sameAccount,
  ) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      archive(user);
      db.prepare(
        "UPDATE users SET google_refresh=?,google_client_hash=?,google_email=?,google_account=?,google_calendar=?,google_connection_version=google_connection_version+1 WHERE id=?",
      ).run(
        encryptedRefresh,
        currentClient(),
        info.email,
        info.sub,
        nextCalendar,
        user.id,
      );
      if (sameAccount && user.google_email)
        db.prepare(
          "UPDATE bookings SET google_account=? WHERE user_id=? AND google_account=?",
        ).run(info.sub, user.id, user.google_email.toLowerCase());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const disconnect = (user, selected) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Revocation is limited to the selected client; do not revoke Borka or
      // discard other clients' retained tokens during Calendar migration.
      db.prepare(
        "UPDATE google_token_history SET usable=0 WHERE user_id=? AND client_hash=?",
      ).run(user.id, selected.clientHash);
      db.prepare(
        "UPDATE users SET google_refresh=CASE WHEN google_client_hash=? THEN NULL ELSE google_refresh END,google_connection_version=google_connection_version+1 WHERE id=?",
      ).run(selected.clientHash, user.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return { currentClient, credential, hasStored, save, disconnect };
}
