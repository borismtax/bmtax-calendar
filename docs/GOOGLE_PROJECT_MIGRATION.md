# Separate BMT Calendar from Borka: migration requirements

Status: the client-binding safeguard is implemented in this branch and tested with synthetic credentials; it is not installed in production. No Google project, credentials, Render configuration or live grants have been changed. Boris approved separating BMT Calendar; action-time approval and authenticated access are still required for credential creation, secret configuration and user grants. Leave Borka's project, OAuth clients, consent settings, callbacks and existing grants unchanged.

## Exact Calendar configuration

| Setting                          | Required value                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| OAuth client type                | Web application, dedicated to BMT Calendar                                                                      |
| Production application origin    | `https://bmt-calendar.onrender.com`                                                                             |
| Authorized redirect URI          | `https://bmt-calendar.onrender.com/api/google/callback`                                                         |
| Calendar service                 | `calendar-json.googleapis.com` enabled in the new client-owning project                                         |
| Identity scopes                  | `openid email`                                                                                                  |
| Calendar scopes                  | `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.freebusy`       |
| OAuth flow                       | Server-side authorization code with PKCE S256, per-user expiring state, `access_type=offline`, `prompt=consent` |
| Render values eventually changed | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, together after the safeguards below                              |
| Values retained                  | Existing `APP_URL`/Render URL, `/data` database, token-encryption key/secret and all application records        |

This application does not use browser-side Google Identity Services, so an Authorized JavaScript Origin is not required for its current server-side flow. If the client configuration asks for an origin, the exact app origin above is the only production origin involved. Do not add wildcard callbacks or Borka URLs to the new client. Google requires exact redirect matching for its [web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server); the existing Calendar scope meanings are documented [here](https://developers.google.com/workspace/calendar/api/auth).

Configure the new consent application's audience according to the actual intended users. Do not assume internal-only access is appropriate or publish it externally merely to bypass verification. In Google's External/Testing mode, grants containing Calendar scopes normally expire after seven days; testing-mode setup is not a durable production connection. Confirm the necessary branding, allowed users and verification requirements before launch. [Google token-expiration documentation](https://developers.google.com/identity/protocols/oauth2)

## Required safeguard before switching clients

The deployed application at `4b95812` has no token/client binding. **Do not switch its OAuth configuration before deploying this safeguard.** This branch adds `users.google_client_hash` and `users.google_connection_version`, an encrypted `google_token_history` table, and a one-time `google_oauth_migrations` marker. It preserves all existing token ciphertext and appointment records. The client fingerprint is a SHA-256 binding to the exact OAuth client ID, not a Google Cloud project identifier.

New consent saves the issuing client fingerprint and encrypted token together. Before replacing a token, it preserves the original ciphertext, client binding and account/calendar identity in history. Provider calls select only a token bound to the active client. Unknown bindings fail locally before token exchange or revocation. Returning to a previous client can select its retained token only when the saved account and calendar still match. Tokens disabled by an explicit disconnect are never selected from history. A failed current token does not silently fall back to an older token.

Legacy tokens are **not automatically labeled with the currently configured client**. After independently verifying the original full client ID in Google Cloud and Render, an operator may set the optional non-secret `GOOGLE_LEGACY_CLIENT_ID` to that verified ID while `GOOGLE_CLIENT_ID` still equals it. On startup, an atomic one-time backfill tags only unbound primary tokens and records the marker. A mismatched pin does nothing; subsequent startups do not re-label newly unknown tokens. Leave this option unset until verified. Remove it after the first verified backfill and before switching clients. If the issuer cannot be verified, preserve the unknown token and ask that host to reconnect instead.

The safeguard covers availability, booking/create/update/cancel, background Meet recovery, diagnostics and disconnect/revocation. Cancellation checks the binding before marking an appointment pending. OAuth state stores the initiating client fingerprint and exact redirect URI with its PKCE verifier; mismatched, old-format and replayed states are rejected before exchanging the code. A second check before saving protects callbacks whose configuration changes while in flight. Users retain local login/workspace access, see a reconnect instruction instead of a Connected badge, and cannot finish first-time onboarding with an incompatible token. Public booking remains blocked until Calendar can be checked.

## Preserve accounts and appointments

Users must reconnect to the new Calendar OAuth application with the **same Google account and calendar**. Preserve the saved Google subject/calendar binding and existing booking IDs, event IDs, management tokens, meeting links, statuses and reminders. The existing reconnect checks protect established booking ownership; keep them. Do not ask users to cancel appointments, disconnect/revoke Borka, delete their profile, or register a new application account to migrate.

Store a new refresh token only after the consent callback verifies identity and required scopes. Preserve established calendar IDs on same-account email changes. Validate read-only Calendar availability after reconnect. Do not assume that reconnect alone proves invitation, reschedule or cancellation behavior for old Google events; those live actions require designated test recipients and authorization.

## Cutover and rollback sequence

1. Confirm old and new full client IDs and unique project IDs/numbers through authenticated consoles; display names are insufficient. Never infer the new client from a numeric prefix or copy secrets into chat, Git or logs.
2. Review and pass the diagnostic and client-binding PRs, including old/new/unknown bindings, in-flight OAuth callbacks, background workers, ownership checks, migration/restore and browser tests. Legacy in-flight OAuth attempts must restart after this upgrade.
3. Take a fresh verified SQLite backup and record the old deployed SHA and existing Render configuration through approved secure handling. Keep token-encryption configuration unchanged. Preserve the Borka project/client and grants.
4. After action-time approval for the configuration change, deploy the safeguard with the OLD credentials and the independently verified `GOOGLE_LEGACY_CLIENT_ID` pin. This release has additive schema migrations, so take the fresh backup immediately beforehand. Confirm the one-time marker and bindings without printing token rows; verify existing connection health. Remove the pin before cutover. If no verified pin is available, the app fails closed and hosts must reconnect.
5. After action-time approval, configure the new Calendar-only client and secret together. Mismatched users should now require reconnection without sending old tokens. Pause accepting unchecked bookings while hosts reconnect; preserve existing appointments.
6. Each user grants the new application access personally. Verify connection health and read-only availability; then perform any separately authorized invitation acceptance test.
7. For a post-cutover rollback, KEEP this binding-aware application and restore only the old client ID/secret together. It can use the preserved old-client token for the same account/calendar while retaining newer tokens and all post-backup appointments. If that old grant has expired or was revoked, reconnect; never substitute a token from another client. **Do not roll the binary back to `4b95812` or earlier after new-client consent:** those versions do not enforce bindings. Do not blindly restore the pre-cutover database after new writes. Before cutover, reverting the binary while still using the original client is possible, but review any post-backup writes first. Do not revoke Borka grants or purge retained encrypted history as cleanup without separate approval.

Current blocker: Render browser authentication expired, the exact deployed OAuth client/project identifiers are not yet verified, and no production migration/credential safeguards have been installed. The screenshot reports Calendar API Enabled under the display name "Borka Tax Planning"; that alone does not establish the cause of the current error.
