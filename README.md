# BMT Calendar

Simple scheduling for the Boris M Tax team: individual booking pages, event types, Google Calendar availability, Google Meet appointments, and email through Resend.

## What is implemented

- First-time setup after email verification requires staff to upload a profile photo and verify a working Google Calendar connection before continuing in the UI or protected API. Existing accounts retain dashboard access; photos can be updated in Settings. Images are decoded, cropped to 256×256, and re-encoded without original metadata.
- Verified email/password accounts, secure cookies, password reset, invitation-only team registration, and an administrator account for `accounting@borismtax.com`.
- A responsive dashboard, paginated appointment search, team view, monthly calendar, and complete filtered CSV exports beyond 1,000 appointments. Administrators can deactivate staff and revoke app sessions while retaining their appointments.
- Zoom event types accept an existing HTTPS Zoom meeting link. Confirmations and Google Calendar invitations include that link; this app does not create new Zoom rooms or require Zoom API credentials.
- Per-user appointment types, durations, descriptions, colors, and shareable links. Pausing an event type stops new bookings without cancelling existing ones.
- Split weekly working hours, holiday/date overrides, IANA time zones, minimum notice, booking horizon, buffers, closed-date display and distinct daylight-saving offsets.
- Public booking without a client account, confirmation emails, private management links, cancellation, and rescheduling.
- Per-user Google OAuth with PKCE, encrypted refresh tokens, primary-calendar free/busy checks, event creation, Google Meet, and updated/cancelled Google invitations.
- Local overlap reservations prevent concurrent bookings within this app. Uncertain Google responses retain reservations for host reconciliation instead of freeing a potentially booked slot.
- A persistent email outbox retries failed deliveries with Resend idempotency keys without blocking booking responses. Pending Google Meet links recover asynchronously from the existing event and notify both parties when ready.

## Run locally

Requires Node.js 24+ (uses built-in SQLite). No separate database service or frontend build is required.

```sh
npm ci
cp .env.example .env
npm start
```

To explore without Google credentials, set `DEMO_MODE=true` and `DATABASE_PATH=./data/demo.sqlite` in your local `.env`. Open the app and choose **Explore the demo**. Demo bookings use only SQLite; mail is recorded in the local outbox and never sent. Use a separate database for production. The server refuses to start with demo mode enabled in production.

`npm run dev` restarts the server when files change. The app listens on port 3000 by default. `/api/health` checks the server and database.

## Production configuration

Set values in the hosting provider’s secure environment settings. Never commit `.env`, keys, databases, mail contents, or Google tokens.

| Variable               | Purpose                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `production` enables secure cookies and startup checks.                                                                             |
| `APP_URL`              | The exact public HTTPS origin, without a trailing path. All email links and OAuth callbacks use it.                                 |
| `OWNER_EMAIL`          | `accounting@borismtax.com`; this email can register the administrator account and must verify mailbox ownership.                    |
| `RESEND_API_KEY`       | A Resend API key authorized to send from your verified domain.                                                                      |
| `MAIL_FROM`            | `BMT Calendar <scheduling@mail.borismtax.com>`. The domain must be verified in Resend.                                              |
| `GOOGLE_CLIENT_ID`     | The web application OAuth client ID from your Google Cloud project.                                                                 |
| `GOOGLE_CLIENT_SECRET` | The corresponding client secret.                                                                                                    |
| `TOKEN_ENCRYPTION_KEY` | A new, stable, 64-character hex secret for AES-256-GCM. Keep a secure backup. Losing it requires reconnecting every Google account. |
| `DATABASE_PATH`        | A persistent, writable SQLite file, e.g. `/data/calendar.sqlite`.                                                                   |
| `DEMO_MODE`            | `false`. Never deploy the shared demo as a production workspace.                                                                    |
| `PORT`                 | Defaults to `3000`.                                                                                                                 |
| `TRUST_PROXY_HOPS`     | Set to the exact trusted reverse-proxy count for the host, e.g. `1` on the supplied Render configuration.                           |

Generate the encryption key privately in your own terminal or your host’s secure console:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste it directly into the host’s secret setting. Do not send it in chat. This key is read locally by the application and must be a real runtime secret, not a network proxy placeholder.

Outbound HTTPS is needed for `accounts.google.com`, `oauth2.googleapis.com`, `openidconnect.googleapis.com`, `www.googleapis.com`, and `api.resend.com`. No Borka credentials or user records are copied into this app.

## Reuse the Borka Google project

The `borismtax/TaxSmartPlanner` repository uses `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for Gmail OAuth. You can use the same Google Cloud project. A separate OAuth web client for Calendar is preferable so the applications can be managed independently; if reusing the existing client, add the callback without removing Borka’s callback.

1. Open **Google Cloud Console → APIs & Services** in the existing project.
2. Enable the **Google Calendar API**.
3. In **Google Auth Platform → Clients**, create a **Web application** client or edit the existing one.
4. Add the authorized redirect URI **`https://YOUR-CALENDAR-HOST/api/google/callback`**, exactly matching `APP_URL`. For local development, optionally add `http://localhost:3000/api/google/callback`.
5. Configure the audience/consent screen. The app requests `openid`, `email`, `https://www.googleapis.com/auth/calendar.events`, and `https://www.googleapis.com/auth/calendar.freebusy`. Gmail permissions alone are insufficient.
6. For a Workspace-only team, use an Internal audience if your organization permits it. For an External app in Testing, add each staff member as a test user. Google may expire testing refresh tokens after seven days. Use the appropriate production publishing/verification process before relying on the app day to day.
7. Put the client ID and secret into the calendar app’s secure settings.
8. Register and verify `accounting@borismtax.com`, sign in, and open **Settings → Connect Google Calendar**. Each invited teammate connects their own Google account.

Only the connected account’s **primary calendar** is checked and updated in this version. New bookings retain the account and calendar binding; legacy bookings must be verified against their original organizer event before mutation. Reconnecting a different account is blocked while scheduled future or pending appointments have an established binding. If all open legacy appointments are still unbound, a mistaken reconnect can be corrected; ownership still requires verification. Disconnecting is blocked while scheduled future or pending appointments exist. Secondary calendars, pooled/round-robin booking, payments, SMS, recurring appointments, and calendar webhooks are not implemented. Changes made directly in Google affect Google free/busy, but do not rewrite this app’s appointment records. Make cancellations and rescheduling through this app to keep its records and email notifications aligned.

## Connect Resend

Borka uses Resend through the Replit connector. That connector’s authentication is scoped to Borka’s Replit environment. In this standalone app, add a Resend sending API key as `RESEND_API_KEY`, with `MAIL_FROM` above. No new domain verification is needed if `mail.borismtax.com` remains verified in the same Resend account. Adding the key here does not change Borka.

The first administrator signs up at `/signup`; other team accounts must use an emailed administrator invitation. All accounts require verification before sign-in. Forgotten passwords can be reset from `/forgot`.

## Deployment

This repository includes a Dockerfile and a Render Blueprint (`render.yaml`) for one always-on web instance with a persistent disk. There is no production deployment created by merely adding these files.

On Render, connect this GitHub repository, use its Blueprint, and supply `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in Render’s secure settings. The app automatically uses Render’s assigned `RENDER_EXTERNAL_URL`; you do not need to guess an address or set `APP_URL` for the initial deployment. Render generates and retains a private `TOKEN_ENCRYPTION_SECRET`, from which the app derives its encryption key. Do not rotate or remove that secret during routine deployments. Explicit `TOKEN_ENCRYPTION_KEY` values remain supported for other hosts. If a custom domain is added later, update `APP_URL` and the Google callback URI together. The service uses a paid persistent disk; confirm current hosting pricing in the provider before provisioning.

For another Docker-capable host:

```sh
docker build -t bmt-calendar .
docker volume create bmt-calendar-data
docker run --detach --name bmt-calendar --restart unless-stopped \
  --env-file /secure/path/calendar-production.env \
  --mount source=bmt-calendar-data,target=/data \
  --publish 3000:3000 bmt-calendar
```

In environments with a platform HTTPS inspection proxy, pass its public CA to the optional BuildKit secret `proxy_ca`, along with the host’s proxy build arguments. This preserves certificate verification without baking the environment CA into the image. Standard hosts do not need this optional secret.

Put the service behind an HTTPS reverse proxy and set its trust count correctly. Run **one application instance per database**. SQLite is suitable for this small-team deployment; multiple replicas need a shared transactional database and distributed coordination before scaling.

`.replit` is included for development/import convenience. Do not deploy this SQLite app on an ephemeral or autoscaling filesystem. A Replit production deployment requires confirmed persistent storage; otherwise use the included persistent-disk deployment.

Back up the database with SQLite’s online backup API or after stopping the app. Do not copy only the `.sqlite` file while the app is writing in WAL mode. Back up the encryption key securely and keep database backups private. Test a restore before using a backup policy for real client appointments.

### Pending calendar requests

If Google times out, the appointment may exist even though the request did not complete. The app keeps a pending reservation and notifies the host. Open **Bookings → All appointments → appointment details → Check calendar status** after at least one minute. It compares the deterministic event ID and appointment times against Google, confirms the request and sends updated links if it succeeded, or releases the extra reservation if it did not. A mismatched Google event requires manual review rather than silently changing times.

## Validation

```sh
npm run check
npm test
npx playwright install --with-deps chromium
npm run test:browser
npm run test:migrations # focused isolated backup/restore rehearsal; also included in npm test
```

If Chromium is already installed, browser tests use `/usr/bin/chromium`, or set `CHROMIUM_PATH` to its executable. Browser screenshots are generated in `test-results/`. GitHub Actions runs the syntax checks, integration tests, and desktop/mobile browser workflows on every push and pull request.

Integration tests exercise a real SQLite database with controlled Google/Resend responses. They cover accounts, invitations, password reset, authorization, booking races, time zones, availability, buffers, calendar failures/recovery, Google OAuth/refresh encryption, Resend transport, and cancellation/rescheduling. Browser tests exercise the real local server and UI in explicit demo mode. They do **not** establish that a real Google account is connected or a real Resend message has been delivered. Live end-to-end verification requires configured credentials, a deployed HTTPS origin, and an authorized team calendar.

### Google Calendar availability errors

In **Settings → Google Calendar → Check connection**, the app verifies the connected account’s availability access. If the Google Calendar API is disabled, enable **Google Calendar API** in the same Google Cloud project as the OAuth client. If permissions are denied, reconnect and approve both Calendar permissions. Do not change appointment durations or buffers to work around a provider failure: unchecked slots are never offered for booking.

Follow [the Google setup repair steps](docs/GOOGLE_SETUP.md) to identify the exact project, enable the API and recheck connection/availability without submitting an appointment.

## Launch readiness and migrations

See [the launch checklist](docs/LAUNCH_CHECKLIST.md) for the recovered baseline, migration/rollback implications, single-process requirement, configuration blockers, acceptance checks and approval boundary. Existing users/appointments are preserved; legacy account bindings are never guessed. The October 27 target requires Google Calendar API enablement, verified deployment configuration and separately authorized live acceptance testing.
