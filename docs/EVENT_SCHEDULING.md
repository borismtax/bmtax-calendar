# Event scheduling controls

Availability in the sidebar is the host's overall schedule. Each event type can inherit it or define its own weekly hours, including split hours and closed weekdays. The public calendar uses the intersection of the event hours with the overall hours for that date. Overall holidays/date overrides still apply. An event cannot reopen a closed holiday or offer times outside the host's date-specific availability.

For example, overall hours of 09:00–18:00 and event hours of 13:00–15:00 produce appointments only within 13:00–15:00, with the complete appointment duration fitting. All schedule rules use the host's time zone; guests see the equivalent instants in their selected zone.

## Buffers and start times

- **Buffer before / after:** independently inherit the overall buffer or specify 0–120 minutes. These are gaps between appointments, including Google busy events. They do not require the preparation/cleanup time itself to fit inside working hours. A gap can satisfy both neighboring appointments' buffers: use the larger applicable gap, not their sum. This preserves the original shared-buffer behavior.
- **Start-time interval:** offer starts every 5, 10, 15, 20, 30, 60, 90, or 120 minutes.
- **Start-time alignment:** start the interval at each intersected available window, or align it to the host's clock counting from local midnight. **Every 60 minutes + Align to the clock** means on-the-hour starts. Every 30 minutes with clock alignment means :00 and :30. For an available window beginning at 09:10, window alignment with a 60-minute interval gives 09:10, 10:10, etc.; clock alignment gives 10:00, 11:00, etc.

Nonexistent daylight-saving starts are omitted. Both offsets of a repeated hour remain distinct. Appointment duration is elapsed time, and every occupied wall minute must lie inside an available window.

New bookings snapshot their effective buffers. Editing an event does not silently change its existing appointments' buffers. Rescheduling applies the current event rules and stores the resulting buffers after confirmation (including recovery of an uncertain update). Legacy bookings retain the existing overall-buffer behavior until rescheduled.

## Daily maximum

Leave **Maximum bookings per day** blank for unlimited, or enter a positive integer (1–1000). The limit applies separately to this event type, using the appointment start date in the host's time zone, including 23- and 25-hour daylight-saving days. A guest time-zone change cannot reset the limit.

Scheduled and pending bookings count; canceled and failed bookings do not. Uncertain cancellations still count until resolved. A pending same-day reschedule and its original booking count once. A pending move to a different day holds capacity on both days until the provider outcome is known. Rescheduling excludes the appointment being moved from its own capacity check. Lowering a limit never cancels existing bookings; additional reservations wait until capacity is available.

The slot API and public dates apply these rules. Booking and rescheduling repeat the capacity/conflict checks inside the same SQLite `BEGIN IMMEDIATE` transaction that inserts the pending reservation. This prevents concurrent distinct-time requests from exceeding a daily limit. Requests made while scheduling settings change are rejected for refresh rather than mixing old and new rules. Google busy data remains a provider snapshot; no external calendar can offer a cross-system atomic transaction.

## API and migration

Event create/edit accepts `windows` (weekly `{day,start,end}` array or `null` to inherit), `bufferBefore`/`bufferAfter` (integer or `null`), `slotInterval`, `slotAlignment` (`window` or `clock`), and `dailyLimit` (positive integer or `null`). Omitting these fields on edit preserves saved settings. An empty weekly array closes every day for that event. Weekly ranges must be valid, nonoverlapping, and on days 1–7.

Additive SQLite columns on `event_types`: `windows`, `buffer_before`, `buffer_after`, `slot_interval`, `slot_alignment`, `daily_limit`. Additive columns on `bookings`: `buffer_before`, `buffer_after`; add a daily-limit lookup index. No users, appointments, sessions, Google credentials, photos, Zoom links or management tokens are replaced.

Defaults preserve existing events: overall availability, inherited before/after buffer, a 15-minute interval aligned to each window, and unlimited bookings. Startup migrations are idempotent. All new controls appear in both create and edit dialogs with accessible labels, help and validation.

Before production migration, take a fresh native SQLite backup on the existing `/data` disk and verify integrity, foreign keys and exact isolated restoration. Preserve token-encryption configuration. Record the current application commit with the backup. Restoring an older database must account for writes after that backup; a Render code rollback alone does not restore data.

## Acceptance

Regression tests cover intersections, split hours, holiday/date overrides, buffer direction and cross-event conflicts, clock alignment, repeated/missing hours, host/guest/UTC day boundaries, daily-limit races, pending recovery reservations, self-exclusion, and settings changes during provider I/O. Browser checks cover create/edit persistence, native validation, mobile layout, split event hours, public hourly slots and capped dates. Migration rehearsals cover the 61741fc, c978424 and deployed 49cf519 schemas, plus restore of newly configured scheduling settings.

All automated booking/email/calendar tests run against isolated local databases and stubbed providers. Production acceptance must not submit real client invitations without designated test recipients and authorization. The separately reported Google Calendar API-disabled configuration issue is not changed by this release.
