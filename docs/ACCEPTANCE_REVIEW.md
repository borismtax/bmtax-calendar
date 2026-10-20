# Local acceptance follow-up

Reviewed implementation: `29cae3018b415a996bbc721cb48d5f1d88031122`, based on `c97842486574712c15982d6ccdcacfe2d185dd6e`. All work remains on `fix/calendar-launch-readiness-20261020`. No network request to Render was repeated.

## Independent review and fixes

A separate reviewer inspected concurrency recovery, Google account-binding migration, first-time onboarding gates and authorization. The review reproduced three account-binding defects in the initial implementation:

1. A matching legacy Google event ID/time could be an attendee copy on the wrong calendar. Binding now additionally requires `organizer.self === true` and the organizer email to match the connected primary calendar. Missing/mismatched organizers leave the appointment unbound and block mutation.
2. A wrong first reconnect for completely unbound legacy appointments could prevent a corrective reconnect. Corrections are now allowed while no open appointment has an established binding. Existing appointment rows remain unbound until verified; established bindings still block an account switch.
3. A Google account's email could change while its stable subject remained the same. Reconnecting then replaced the user's calendar identifier and stranded existing bindings. A proven same-account reconnect now retains the existing concrete calendar identifier, falling back to the prior email for migrated users. The displayed email and credentials update normally. The regression verifies cancellation's actual Google URL still targets the original calendar.

The related concurrency case is also guarded: if OAuth changes the connected account/calendar/refresh token while legacy verification awaits Google, the stale lookup cannot establish a binding. An existing partial binding or a pending reschedule parent's binding cannot be overwritten with another identity. Regression tests reproduce all four scenarios, including the unauthenticated management-slot endpoint.

The independent reviewer rechecked all fixes and found no remaining concrete defect, direct onboarding bypass or permission regression in the reviewed routes. Their full run before the final rename fix passed 51 tests; their focused run after it passed nine legacy/OAuth/migration cases. Its scope is focused code and local behavior review, not a guarantee about every deployment or external Google configuration. If Google removes the original calendar identifier after an account rename, provider access must be checked and any migration explicitly reviewed; the app does not silently rebind appointments.

## Backup, restore and migration rehearsal

`npm run test:migrations` uses isolated temporary databases and a frozen schema from `61741fc`; its second case adds the profile/onboarding/Zoom fields present in `c978424`. The tests never open the repository's local data files or a production database. Global network fetch is blocked, and mail/calendar providers are explicit local fixtures.

Each case includes four representative accounts (administrator, member, setup pending, and unverified), three event types, six appointments (scheduled Meet, scheduled Zoom, cancelled, failed, pending create, pending reschedule), an existing session, a reset token and sent/retryable outbox records.

Both cases passed:

- Online SQLite backup from an open database with uncheckpointed WAL contents; later source changes do not alter the backup.
- Restore of all original rows and schema; migrated copies retain every pre-existing column value, including password/token strings, appointment IDs/times/notes, management hashes and Zoom URLs.
- Additive migration and second-startup idempotence, with no guessed legacy calendar identities.
- Preservation of existing account access and setup requirements, along with member/admin permission boundaries.
- Verified binding of a legacy organizer event, pending reschedule reconciliation, and preservation of the original management link and Zoom URL.
- A second online backup/restore after migration and fixture-only appointment changes.
- Exact rollback to the pre-upgrade schema and records from the untouched backup.
- `PRAGMA integrity_check` returned `ok`; `PRAGMA foreign_key_check` returned no violations; each backup copied 18 pages; external network calls remained zero.

## Validation and limits

The final full regression run contains 52 passing tests, including the two database rehearsals. Syntax checks pass. The 17 Chromium browser workflows pass with no browser errors.

The production backup/restore rehearsal, deployed SHA, Render settings, Google Calendar API enablement and real Google/Resend acceptance remain pending. Synthetic fixtures cannot certify the unknown production database. Follow `docs/LAUNCH_CHECKLIST.md` before an approved release; use one application process per SQLite database.
