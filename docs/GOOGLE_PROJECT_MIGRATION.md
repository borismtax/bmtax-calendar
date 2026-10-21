# Separate BMT Calendar from Borka: migration requirements

Status: preparation only. The diagnostic patch does not move projects, create credentials, change Render secrets, migrate refresh tokens, revoke grants or authorize new scopes. Boris approved separating BMT Calendar; action-time approval and authenticated access are still required for credential creation, secret configuration and user grants. Leave Borka's project, OAuth clients, consent settings, callbacks and existing grants unchanged.

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

The current application encrypts each refresh token in `users.google_refresh` but does not store which OAuth client issued it. `accessToken()` currently submits that stored token with the currently configured client ID/secret. Therefore **changing only Render's OAuth values is not a safe migration procedure**. The diagnostic patch exposes a configuration error safely; it does not implement the migration safeguard.

Before the credential cutover, implement and test an explicit client binding (a persisted client identifier/fingerprint alongside the encrypted refresh token, or a versioned encrypted token envelope). Bind existing tokens to the verified OLD client, never to whichever client happens to be configured after cutover. Unknown or mismatched token/client bindings must stop locally before any token exchange and show "Reconnect Google Calendar for the new BMT Calendar connection". Never print, export into browser output, or send an old token with the new client. Do not use `invalid_grant` responses as the mechanism for discovering mismatches.

The safeguard must cover interactive availability checks, booking/create/update/cancel, background Meet recovery, diagnostics, OAuth reconnect, and disconnect/revocation. Bind pending OAuth state to the client too so an authorization flow begun before cutover cannot exchange its code under a different client. While mismatched, show a connection-needed state rather than the existing "Connected" badge; retain local app login and appointments. Never expose unchecked booking availability when Calendar access is unavailable.

## Preserve accounts and appointments

Users must reconnect to the new Calendar OAuth application with the **same Google account and calendar**. Preserve the saved Google subject/calendar binding and existing booking IDs, event IDs, management tokens, meeting links, statuses and reminders. The existing reconnect checks protect established booking ownership; keep them. Do not ask users to cancel appointments, disconnect/revoke Borka, delete their profile, or register a new application account to migrate.

Store a new refresh token only after the consent callback verifies identity and required scopes. Preserve established calendar IDs on same-account email changes. Validate read-only Calendar availability after reconnect. Do not assume that reconnect alone proves invitation, reschedule or cancellation behavior for old Google events; those live actions require designated test recipients and authorization.

## Cutover and rollback sequence

1. Confirm old and new full client IDs and unique project IDs/numbers through authenticated consoles; display names are insufficient. Never infer the new client from a numeric prefix or copy secrets into chat, Git or logs.
2. Prepare and test the client-binding safeguard with old/new/unknown bindings, in-flight OAuth callbacks, background workers, ownership checks and rollback behavior before any production credential switch.
3. Take a fresh verified SQLite backup and record the old deployed SHA and existing Render configuration through approved secure handling. Keep token-encryption configuration unchanged. Preserve the Borka project/client and grants.
4. Deploy the safeguard with the old credentials, bind verified legacy tokens to that old client, and verify existing connections still work. If this introduces a migration, rehearse it and back up immediately beforehand.
5. After action-time approval, configure the new Calendar-only client and secret together. Mismatched users should now require reconnection without sending old tokens. Pause accepting unchecked bookings while hosts reconnect; preserve existing appointments.
6. Each user grants the new application access personally. Verify connection health and read-only availability; then perform any separately authorized invitation acceptance test.
7. For rollback, restore the previous application/client configuration and use only token records bound to that client. Never submit newly issued tokens under the old client. After reconnects or new bookings, do not blindly restore the pre-cutover database: reconcile post-backup writes or retain isolated per-client token versions for a planned rollback window. Do not revoke Borka grants as cleanup without separate approval.

Current blocker: Render browser authentication expired, the exact deployed OAuth client/project identifiers are not yet verified, and no production migration/credential safeguards have been installed. The screenshot reports Calendar API Enabled under the display name "Borka Tax Planning"; that alone does not establish the cause of the current error.
