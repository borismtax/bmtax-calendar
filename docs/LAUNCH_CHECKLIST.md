# BMT Calendar launch checklist

Target: October 27, 2026. Readiness depends on the configuration and acceptance checks below; this is not a launch guarantee.

## Local implementation completed

Recovered from remote commit `c97842486574712c15982d6ccdcacfe2d185dd6e`, which includes Zoom links, profile setup and connection diagnostics. Password visibility from `02d984d8` remains intact. Changes are on local branch `fix/calendar-launch-readiness-20261020`. No push or deployment was performed.

- Appointment operations share a lock across guest cancellation/rescheduling, staff cancellation/reconciliation and Meet recovery. Overlapping requests get HTTP 409; unresolved durable reservations prevent another mutation after a restart. Uncertain cancellations also stay reserved until checked against Google.
- New appointments record their Google account identity and concrete primary-calendar identifier. Subsequent mutations use that binding. Switching accounts is blocked while future scheduled or pending appointments have an established binding; disconnecting is blocked while any open appointment exists. Completely unbound legacy appointments allow corrective reconnects, with remote organizer verification required before use.
- Meet links have a durable recovery queue, with backoff and a 15-second worker tick. Recovery looks up the existing event; it does not create another invitation. Guests and hosts receive a link email once ready. Explicit conference failures surface for host attention, with a manual check after repair.
- Booking, rescheduling, cancellation and reconciliation queue email without waiting for delivery. Retry/idempotency behavior remains in the persistent outbox.
- Administrators can deactivate/reactivate staff and revoke app sessions. Deactivation removes sessions and outstanding tokens, blocks login and new bookings, and retains appointments and Google credentials so existing appointments can still be managed. It does not revoke Google OAuth grants or delete Google events. Reactivation requires a fresh login.
- Small reschedules exclude only their own local appointment and exact Google event ID. Google events are read through every page, including all-day/recurring instances; unrelated overlapping busy events remain blocking.
- Split weekly hours and date-specific closed/custom-hour overrides are editable without dropping extra windows. Dates use the host time zone; guest views convert actual instants. Closed/out-of-window dates are disabled. Repeated daylight-saving times display explicit GMT offsets.
- Appointment listings paginate; the UI reads every page. CSV export applies the selected search, status and team scope across every matching row, including more than 1,000 records. Exports guard spreadsheet formulas. The export endpoint also accepts RFC3339 `from`/`to` start-time bounds (inclusive/exclusive).
- Phone events require a reachable guest number and host calling instructions; in-person events require an address/arrival instructions. Instructions are snapshotted on booking and appear in public details, Google invitations, confirmations and management views.
- New accounts cannot enter the workspace or publish a booking page until both a sanitized uploaded image and a working Google connection have passed setup. UI and protected API routes enforce setup. Existing onboarded accounts retain access.

## Recovery evidence

The saved checkout `/workspace/bmtax-calendar` was clean on `work` at `61741fc`. There were no stashes or other worktrees. Remote inspection returned only `main` at `c97842486574712c15982d6ccdcacfe2d185dd6e`. Reflog/object inspection found only an older initial-build commit and old source objects, not a later launch-fix implementation. The old checkout, ignored files and local databases were not modified. A separate worktree was created at `/workspace/bmt-calendar-recovery`; its branch has no upstream configured.

## Migration and rollback

Before any approved deployment:

- [ ] Back up production SQLite using the online backup API or stop the app before copying. Retain the encryption key securely. Test restoring the backup into an isolated environment with no outbound invitations or email.
- [ ] Record the actual deployed SHA, Render service settings, persistent disk path and the release being replaced. These have not been verified in this task.
- [ ] Run exactly one application process/instance per SQLite database. The mutation locks are process-local; persisted pending reservations complement them after restart. This release does not support multiple replicas.
- [ ] Rehearse migration against a private copy of the database, checking user and appointment counts, management links, event-type settings and pending operations before/after.

Migrations are additive and idempotent. They add active-status, date overrides and Google identity/calendar fields to users; instructions to event types; and calendar binding, instructions, phone, operation timestamp and Meet recovery fields to bookings. Existing users default to active. Earlier `onboarded` values are retained, including the existing-user exemption from pre-profile migrations. Only newly created accounts must complete both setup steps. Existing accounts that had already completed the previous optional-photo setup are not locked out.

Existing appointments retain their IDs, original creation timestamps, times, names, private management hashes and Zoom links. Existing Meet appointments with a Google event ID but no link enter recovery at startup. When all open legacy appointments are unbound, a mistaken Google reconnect can be corrected without changing those appointment records. Once an open appointment has an established binding, switching away is blocked. Legacy calendar bindings remain unknown until an authenticated lookup finds the same Google event ID and expected start/end times, with Google explicitly identifying the connected primary calendar as the organizer. Attendee copies do not establish ownership. Connection identity and credentials are checked again after the lookup; stale results and conflicting partial/parent bindings are rejected. No historical account is guessed from the currently connected account. If the event is missing, cancelled, moved elsewhere or has different times, the application refuses an unsafe mutation; a human must verify the original account/event. Do not bulk-bind or bulk-release such records without review. Pending legacy reschedules verify either the original or requested time. Normal and recovered reschedules preserve the existing management link.

Existing phone/in-person events and appointments remain unchanged; their newly added instruction fields start empty. Review and fill instructions for active legacy event types before sharing their links. Editing an event does not retroactively overwrite existing booking instructions. Review any pending records or multiple pending children left by older versions before launch.

A proven same-account reconnect retains its existing concrete calendar identifier even if Google changes the account's email. If Google no longer accepts the original calendar identifier, verify provider access and review a calendar migration explicitly; do not rewrite appointment bindings in bulk.

Rollback should restore the prior application **and its corresponding database backup during a maintenance window** after accounting for appointments made since the backup. Do not run an older app concurrently with this release: it does not understand binding checks, cancellation reservations, deactivation or mandatory setup. The code does not run a destructive down migration.

## External configuration blockers — not resolved here

- [ ] Enable **Google Calendar API** in the Google Cloud project that owns the exact OAuth client used by the Render service. The user supplied an explicit API-disabled screenshot. The client was reportedly configured in “Borka Tax Planning App” / “My First Project”; the actual project/client/API state remains unverified. Do not replace the Borka app's existing redirect URIs.
- [ ] Follow [the Google setup repair steps](GOOGLE_SETUP.md), matching the full OAuth client ID and unique project ID/number before enabling the API. Reconnect only if permissions or authorization still fail after enablement.
- [ ] Verify the Calendar callback is exactly `https://bmt-calendar.onrender.com/api/google/callback`, matching `APP_URL`, and the existing Calendar event/free-busy scopes are granted. Confirm the consent audience/testing limits are suitable for the team.
- [ ] Verify Render's deployed SHA and auto-deploy settings before any push. Never push `main` as part of this preparation. Review the local commit and obtain approval for publishing a feature branch/deploying the chosen release.
- [ ] Confirm persistent disk/backups, stable token-encryption secret, HTTPS/proxy settings, Resend sender/API configuration and monitoring. Do not paste secrets in chat or source control.

Read-only public requests to `/api/health`, the discovery-call event API and its availability endpoint were attempted on October 20, 2026. The execution environment's proxy rejected all three HTTPS tunnels with HTTP 403 before the app was reached. This is a local network access blocker, **not evidence that Render itself returned 403**. No booking was submitted. Live health, availability, deployed code and Google API state remain unverified.

## Acceptance checks requiring separate approval

- [ ] After API enablement, perform read-only public availability and Settings → Check connection checks for each host. A successful OAuth callback alone does not prove Calendar API access.
- [ ] With authorized test accounts/calendars and explicit consent for invitations/email: complete mandatory photo + Google setup, create one Meet appointment and one appointment using an existing Zoom link, verify calendar ownership, link recovery and both emails, reschedule 15 minutes, cancel, and confirm no duplicate events.
- [ ] Verify phone/in-person instructions, split hours, holidays, guest time zones and both repeated daylight-saving times with the team's intended availability.
- [ ] Test staff deactivation/session revocation on a designated test account only, then restore it as agreed. Confirm existing appointments remain manageable.
- [ ] Confirm retries and pending-operation procedures, backup restore, operational owner, rollback window and launch sign-off.

No production data changes, real invitations, OAuth grants, credentials changes or live session/access revocation were performed. Approval for those actions is still required.

## Local validation

Validated locally on Node.js 24.19.0: syntax checks pass, **52 regression and migration tests pass**, and **17 Chromium browser workflows pass with no browser errors**.

The isolated backup/restore rehearsal passed for both the frozen `61741fc` schema and the `c978424` profile/Zoom schema. Each fixture contains four accounts, three event types, six appointments across scheduled/cancelled/failed/pending states, one session, one reset token and two outbox messages. It exercises online backup while WAL data is present, exact pre-upgrade restore, additive migrations, repeated-startup idempotence, management-link/Zoom preservation, permissions, verified legacy binding, pending-reschedule recovery and post-migration backup/restore. SQLite integrity and foreign-key checks passed, with zero external network calls. This is synthetic-data evidence; it does not replace backing up and rehearsing the actual production database.

All integration fixtures use temporary or in-memory SQLite databases and controlled Google/Resend responses. Browser tests run a local demo server with fake identities and local outbox delivery; they do not prove live Google/Resend connectivity.

Run:

```sh
npm ci
npm run check
npm test
npm run test:browser
# Optional focused rehearsal (also included in npm test):
npm run test:migrations
```

The regression suite covers existing authentication/authorization and preserved baseline features, mutation races, uncertainty/reconciliation, identity binding, async Meet recovery, delayed mail, staff lifecycle, split/date schedules, daylight-saving transitions, legacy/restart preservation and full filtered exports. Browser workflows cover desktop/mobile layouts, password visibility, mandatory photo/calendar setup, Zoom, booking changes, split schedules/holidays, phone instructions, pending/ready Meet display, 1,205-row filtered export, staff controls and distinct daylight-saving labels. Screenshots and a synthetic CSV are written to ignored `test-results/`.

Implementation references: [Google event resources and conference request states](https://developers.google.com/workspace/calendar/api/v3/reference/events), [paginated event listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [stable OpenID account identifiers](https://developers.google.com/identity/openid-connect/openid-connect).
