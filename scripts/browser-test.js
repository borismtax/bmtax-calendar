import { chromium } from "@playwright/test";
import { createApp } from "../server.js";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { DateTime, Settings } from "luxon";
import sharp from "sharp";

const testMail = [];
const service = createApp({
  dbPath: ":memory:",
  demo: true,
  baseUrl: "http://localhost:3199",
  production: false,
  testMode: true,
  ownerEmail: "owner@example.com",
  deliverMail: async (item) => testMail.push(item),
});
const server = service.app.listen(3199, "127.0.0.1");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH || existsSync("/usr/bin/chromium")
    ? { executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }
    : {}),
});
const errors = [];
let completed = 0;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  for (const route of [
    "/login",
    "/signup",
    "/reset?token=test-placeholder",
  ]) {
    await page.goto("http://localhost:3199" + route);
    const passwordInput = page.locator("#password");
    await passwordInput.fill("A strong test password 123!");
    assert.equal(await passwordInput.getAttribute("type"), "password");
    await page
      .getByRole("button", { name: "Show password", exact: true })
      .click();
    assert.equal(await passwordInput.getAttribute("type"), "text");
    assert.equal(
      await passwordInput.inputValue(),
      "A strong test password 123!",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Hide password", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await page
      .getByRole("button", { name: "Hide password", exact: true })
      .click();
    assert.equal(await passwordInput.getAttribute("type"), "password");
  }
  completed++;
  console.log(
    "PASS browser: show/hide password on sign-in, registration and reset",
  );
  await page.goto("http://localhost:3199/signup");
  await page.getByLabel("Full name").fill("Account Owner");
  await page.getByLabel("Work email").fill("owner@example.com");
  await page.locator("#password").fill("A strong test password 123!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByText("Check your email to verify your account.")
    .waitFor();
  const verificationToken = testMail
    .find((item) => item.subject.includes("Verify"))
    .html.match(/verify\?token=([a-f0-9]+)/)[1];
  const verificationUrl = `http://localhost:3199/verify?token=${verificationToken}`;
  await page.goto(verificationUrl);
  await page
    .getByRole("heading", { name: "Make it yours", exact: true })
    .waitFor();
  // Reopen the consumed link without the first browser's login cookie.
  await context.clearCookies();
  await page.goto(verificationUrl);
  await page
    .getByRole("heading", { name: "Email verified", exact: true })
    .waitFor();
  await page
    .getByText("This email has already been verified.", { exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Continue to sign in" }).click();
  await page.getByLabel("Work email").fill("owner@example.com");
  await page.locator("#password").fill("A strong test password 123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Make it yours", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Continue to workspace" })
      .isEnabled(),
    false,
  );
  await page.getByLabel("Profile picture").setInputFiles({
    name: "profile.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 80, height: 60, channels: 3, background: "#6558df" },
    })
      .png()
      .toBuffer(),
  });
  await page
    .getByRole("button", { name: "Save photo", exact: true })
    .click();
  await page.locator(".photo-preview img").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "Setup fits a phone screen",
  );
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/onboarding-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const pendingOwner = service.db
    .prepare("SELECT id FROM users WHERE email=?")
    .get("owner@example.com");
  // The OAuth handshake is exercised in API tests; simulate its saved connection here.
  service.db
    .prepare("UPDATE users SET google_refresh=?,google_email=? WHERE id=?")
    .run("browser-test-connection", "owner@example.com", pendingOwner.id);
  service.config.calendarProvider = {
    busy: async () => [],
    create: async () => ({}),
  };
  const savedPhoto = service.db
    .prepare("SELECT photo FROM users WHERE id=?")
    .get(pendingOwner.id).photo;
  service.db
    .prepare("UPDATE users SET photo=NULL WHERE id=?")
    .run(pendingOwner.id);
  await page.reload();
  assert.equal(
    await page
      .getByRole("button", { name: "Continue to workspace" })
      .isEnabled(),
    false,
    "Google alone cannot complete setup",
  );
  assert.equal(
    (
      await page.request.post("http://localhost:3199/api/me/onboarding", {
        data: {},
      })
    ).status(),
    409,
  );
  assert.equal(
    (await page.request.get("http://localhost:3199/api/bookings")).status(),
    403,
  );
  service.db
    .prepare("UPDATE users SET photo=? WHERE id=?")
    .run(savedPhoto, pendingOwner.id);
  await page.reload();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page
    .getByRole("heading", { name: /Good (morning|afternoon|evening)/ })
    .waitFor();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await page
    .getByText("Google Calendar availability is working.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  completed++;
  console.log(
    "PASS browser: first-time setup, photo upload and calendar connection gate",
  );
  completed++;
  console.log(
    "PASS browser: first verification, reopened link and normal sign-in",
  );
  await page.goto("http://localhost:3199/login");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await page
    .getByRole("heading", { name: /Good (morning|afternoon|evening)/ })
    .waitFor();
  await page
    .getByRole("button", { name: "Create event type", exact: true })
    .click();
  await page.getByLabel("What’s the occasion?").fill("Annual review");
  await page.getByLabel("Duration", { exact: true }).selectOption("45");
  await page.getByLabel("Where", { exact: true }).selectOption("Zoom");
  await page
    .getByLabel("Zoom meeting link", { exact: true })
    .fill("https://us02web.zoom.us/j/1234567890?pwd=test-only");
  await page
    .getByLabel("A little about this meeting")
    .fill("A focused review of your year.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create event type", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("link", { name: /Event types/ }).click();
  await page
    .getByRole("heading", { name: "Annual review", exact: true })
    .waitFor();
  completed++;
  console.log(
    "PASS browser: create event type and persist it across navigation",
  );
  await page
    .getByRole("button", { name: "Create event type", exact: true })
    .click();
  let eventDialog = page.getByRole("dialog");
  await eventDialog
    .getByLabel("What’s the occasion?")
    .fill("Afternoon consultation");
  await eventDialog
    .getByLabel("Event availability", { exact: true })
    .selectOption("custom");
  for (const name of [
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ])
    await eventDialog.getByLabel(name, { exact: true }).uncheck();
  await eventDialog.getByLabel("Monday", { exact: true }).check();
  await eventDialog
    .getByLabel("Event Monday start", { exact: true })
    .fill("13:00");
  await eventDialog
    .getByLabel("Event Monday end", { exact: true })
    .fill("15:00");
  await eventDialog
    .getByLabel("Buffer before", { exact: true })
    .selectOption("5");
  await eventDialog
    .getByLabel("Buffer after", { exact: true })
    .selectOption("15");
  await eventDialog
    .getByLabel("Start-time interval", { exact: true })
    .selectOption("60");
  await eventDialog
    .getByLabel("Start-time alignment", { exact: true })
    .selectOption("clock");
  await eventDialog
    .getByLabel("Maximum bookings per day", { exact: true })
    .fill("0");
  assert.equal(
    await eventDialog
      .getByLabel("Maximum bookings per day", { exact: true })
      .evaluate((el) => el.checkValidity()),
    false,
  );
  await eventDialog
    .getByLabel("Maximum bookings per day", { exact: true })
    .fill("2");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await eventDialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
    "Event scheduling fits mobile",
  );
  await eventDialog
    .getByLabel("Start-time interval", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/event-scheduling-mobile.png",
  });
  await eventDialog
    .getByRole("button", { name: "Create event type", exact: true })
    .click();
  await eventDialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload();
  await page
    .getByRole("button", {
      name: "Edit Afternoon consultation",
      exact: true,
    })
    .click();
  eventDialog = page.getByRole("dialog");
  assert.equal(
    await eventDialog
      .getByLabel("Event availability", { exact: true })
      .inputValue(),
    "custom",
  );
  assert.equal(
    await eventDialog
      .getByLabel("Event Monday start", { exact: true })
      .inputValue(),
    "13:00",
  );
  assert.equal(
    await eventDialog
      .getByLabel("Buffer before", { exact: true })
      .inputValue(),
    "5",
  );
  assert.equal(
    await eventDialog
      .getByLabel("Buffer after", { exact: true })
      .inputValue(),
    "15",
  );
  assert.equal(
    await eventDialog
      .getByLabel("Start-time interval", { exact: true })
      .inputValue(),
    "60",
  );
  assert.equal(
    await eventDialog
      .getByLabel("Start-time alignment", { exact: true })
      .inputValue(),
    "clock",
  );
  assert.equal(
    await eventDialog
      .getByLabel("Maximum bookings per day", { exact: true })
      .inputValue(),
    "2",
  );
  completed++;
  console.log(
    "PASS browser: create event scheduling controls, validation, persistence and mobile layout",
  );
  await eventDialog
    .getByRole("button", { name: "Add Monday hours", exact: true })
    .click();
  await eventDialog
    .getByLabel("Event Monday start", { exact: true })
    .last()
    .fill("15:30");
  await eventDialog
    .getByLabel("Event Monday end", { exact: true })
    .last()
    .fill("17:00");
  await eventDialog
    .getByLabel("Maximum bookings per day", { exact: true })
    .fill("1");
  await eventDialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await eventDialog.waitFor({ state: "hidden" });
  const controlsMe = (
    await (await page.request.get("http://localhost:3199/api/me")).json()
  ).user;
  const controlsEvent = (
    await (
      await page.request.get("http://localhost:3199/api/events")
    ).json()
  ).events.find((e) => e.title === "Afternoon consultation");
  let controlsDay = DateTime.now()
    .setZone(controlsMe.timezone)
    .plus({ days: 1 });
  while (controlsDay.weekday !== 1)
    controlsDay = controlsDay.plus({ days: 1 });
  const controlsPath = `http://localhost:3199/api/public/${controlsMe.slug}/${controlsEvent.slug}`;
  const controlsSlots = (
    await (
      await page.request.get(controlsPath + "/slots", {
        params: {
          date: controlsDay.toISODate(),
          timezone: controlsMe.timezone,
        },
      })
    ).json()
  ).slots;
  assert.deepEqual(
    controlsSlots.map((start) =>
      DateTime.fromISO(start)
        .setZone(controlsMe.timezone)
        .toFormat("HH:mm"),
    ),
    ["13:00", "14:00", "16:00"],
  );
  const capBooking = await page.request.post(controlsPath + "/bookings", {
    data: {
      name: "Local Cap Test",
      email: "cap@example.test",
      start: controlsSlots[0],
      timezone: controlsMe.timezone,
    },
  });
  assert.equal(capBooking.status(), 201);
  const capPage = await context.newPage();
  capPage.on("pageerror", (err) => errors.push(err.message));
  await capPage.goto(
    `http://localhost:3199/book/${controlsMe.slug}/${controlsEvent.slug}`,
  );
  await capPage
    .getByLabel("Your time zone", { exact: true })
    .selectOption(controlsMe.timezone);
  if (controlsDay.month !== DateTime.now().month)
    await capPage.getByRole("button", { name: "Next month" }).click();
  const capDateLabel = controlsDay.toFormat("LLLL d, yyyy");
  const capDayButton = capPage.getByRole("button", {
    name: capDateLabel + " — closed",
    exact: true,
  });
  await capDayButton.waitFor();
  assert.equal(await capDayButton.isDisabled(), true);
  await capPage.close();
  completed++;
  console.log(
    "PASS browser: edited split event hours, hourly public slots and capped date closure",
  );
  await page
    .getByRole("button", {
      name: "Edit Afternoon consultation",
      exact: true,
    })
    .click();
  eventDialog = page.getByRole("dialog");
  assert.equal(
    await eventDialog
      .getByLabel("Event Monday start", { exact: true })
      .count(),
    2,
  );
  await eventDialog
    .getByLabel("Event availability", { exact: true })
    .selectOption("inherit");
  assert.equal(await page.locator("#event-weekly-hours").isHidden(), true);
  await eventDialog
    .getByLabel("Buffer before", { exact: true })
    .selectOption("");
  await eventDialog
    .getByLabel("Buffer after", { exact: true })
    .selectOption("");
  await eventDialog
    .getByLabel("Maximum bookings per day", { exact: true })
    .fill("");
  await eventDialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await eventDialog.waitFor({ state: "hidden" });
  await page.reload();
  await page
    .getByRole("button", {
      name: "Edit Afternoon consultation",
      exact: true,
    })
    .click();
  eventDialog = page.getByRole("dialog");
  assert.equal(
    await eventDialog
      .getByLabel("Event availability", { exact: true })
      .inputValue(),
    "inherit",
  );
  assert.equal(
    await eventDialog
      .getByLabel("Buffer before", { exact: true })
      .inputValue(),
    "",
  );
  assert.equal(
    await eventDialog
      .getByLabel("Maximum bookings per day", { exact: true })
      .inputValue(),
    "",
  );
  await eventDialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  completed++;
  console.log(
    "PASS browser: edit resets custom schedule, buffers and daily limit to inherited/unlimited",
  );
  await page
    .getByRole("link", { name: "Availability", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Make time on your terms" })
    .waitFor();
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Minimum booking notice").selectOption("0");
  const saveAvailability = async () => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/me" &&
          response.request().method() === "PATCH",
      ),
      page
        .getByRole("button", { name: "Save availability", exact: true })
        .click(),
    ]);
    assert.equal(response.status(), 200, "Availability save succeeds");
    // Consecutive saves can leave more than one five-second toast visible.
    await page
      .getByText("Availability saved. Your booking page is up to date.", {
        exact: true,
      })
      .last()
      .waitFor();
  };
  await saveAvailability();
  completed++;
  console.log("PASS browser: save weekly availability");
  await page.getByLabel("Monday end", { exact: true }).fill("12:00");
  await page
    .getByRole("button", { name: "Add Monday hours", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add date override", exact: true })
    .click();
  const closedDate = DateTime.now().plus({ days: 10 }).toISODate();
  await page.locator("[data-override-date]").fill(closedDate);
  await saveAvailability();
  await page.reload();
  await page.getByLabel("Monday start", { exact: true }).first().waitFor();
  assert.equal(
    await page.getByLabel("Monday start", { exact: true }).count(),
    2,
  );
  assert.equal(
    await page
      .getByLabel("Monday end", { exact: true })
      .first()
      .inputValue(),
    "12:00",
  );
  assert.equal(
    await page.locator("[data-override-date]").inputValue(),
    closedDate,
  );
  completed++;
  console.log(
    "PASS browser: split working hours and holiday override persist after reload",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "Split hours and date overrides fit mobile",
  );
  await page.screenshot({
    path: "test-results/availability-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page
    .getByRole("heading", { name: "Your appointments", exact: true })
    .waitFor();
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  const me = await (
    await page.request.get("http://localhost:3199/api/me")
  ).json();
  const events = await (
    await page.request.get("http://localhost:3199/api/events")
  ).json();
  const event = events.events.find((e) => e.title === "Annual review");
  const guest = await browser.newContext({
      viewport: { width: 1280, height: 950 },
    }),
    booking = await guest.newPage();
  guest.setDefaultTimeout(10000);
  booking.on("pageerror", (err) => errors.push(err.message));
  await booking.goto(
    `http://localhost:3199/book/${me.user.slug}/${event.slug}`,
  );
  await booking
    .getByRole("heading", { name: "Find your moment" })
    .waitFor();
  // Choose a future weekday with availability, allowing month boundaries.
  let day = DateTime.now().setZone(me.user.timezone).plus({ days: 1 });
  while (day.weekday > 5) day = day.plus({ days: 1 });
  const dayName = day.toJSDate().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  if (day.month !== DateTime.now().month)
    await booking.getByRole("button", { name: "Next month" }).click();
  await booking.getByRole("button", { name: dayName, exact: true }).click();
  await booking.locator(".slot").first().click();
  await booking.getByLabel("Your name").fill("Jamie Client");
  await booking
    .getByLabel("Email address", { exact: true })
    .fill("jamie@example.com");
  await booking
    .getByLabel(/Anything you’d like us to know/)
    .fill("Looking forward to meeting.");
  await booking
    .getByRole("button", { name: "Confirm appointment" })
    .click();
  await booking
    .getByRole("heading", { name: "You’re on the calendar." })
    .waitFor();
  assert.equal(
    await booking
      .getByRole("link", { name: "Join Zoom", exact: true })
      .getAttribute("href"),
    "https://us02web.zoom.us/j/1234567890?pwd=test-only",
  );
  await booking.screenshot({
    path: "test-results/booking-confirmation.png",
    fullPage: true,
  });
  completed++;
  console.log(
    "PASS browser: public guest booking from date selection through confirmation",
  );
  await booking.getByRole("link", { name: "Manage appointment" }).click();
  await booking
    .getByRole("button", { name: "Reschedule", exact: true })
    .click();
  await booking
    .getByRole("heading", { name: "Choose your new time" })
    .waitFor();
  if (day.month !== DateTime.now().month)
    await booking.getByRole("button", { name: "Next month" }).click();
  await booking.getByRole("button", { name: dayName, exact: true }).click();
  await booking.locator(".slot").last().click();
  await booking.getByRole("button", { name: "Confirm new time" }).click();
  await booking
    .getByRole("heading", { name: "A fresh time, all set." })
    .waitFor();
  completed++;
  console.log("PASS browser: guest rescheduling preserves management link");
  await booking.getByRole("link", { name: "Manage appointment" }).click();
  await booking
    .getByRole("button", { name: "Cancel appointment", exact: true })
    .click();
  await booking
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel appointment", exact: true })
    .click();
  await booking
    .getByRole("heading", { name: "Appointment cancelled" })
    .waitFor();
  completed++;
  console.log("PASS browser: guest cancellation");
  await page.getByRole("link", { name: "Bookings", exact: true }).click();
  await page.getByLabel("Filter appointments").selectOption("cancelled");
  await page.getByText("Jamie Client", { exact: true }).waitFor();
  await page
    .getByRole("link", { name: "My calendar", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "A little perspective" })
    .waitFor();
  await page.getByRole("link", { name: "Team", exact: true }).click();
  await page
    .getByRole("heading", { name: "Good people. Better together." })
    .waitFor();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Full name").fill("Alex Morgan");
  await page
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page.getByText("Profile updated.").waitFor();
  completed++;
  console.log(
    "PASS browser: bookings, calendar, team and profile settings",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://localhost:3199/app");
  await page
    .getByRole("heading", { name: "Your appointments", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "Dashboard should fit mobile screen",
  );
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Toggle menu" }).click();
  await page.getByRole("link", { name: /Event types/ }).click();
  await page
    .getByRole("heading", { name: "Annual review", exact: true })
    .waitFor();
  await booking.setViewportSize({ width: 390, height: 844 });
  await booking.goto(
    `http://localhost:3199/book/${me.user.slug}/${event.slug}`,
  );
  await booking
    .getByRole("heading", { name: "Find your moment" })
    .waitFor();
  assert.equal(
    await booking.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "Public booking should fit mobile screen",
  );
  await booking.screenshot({
    path: "test-results/booking-mobile.png",
    fullPage: true,
  });
  completed++;
  console.log("PASS browser: mobile layout and navigation");
  // Closed dates are explicitly disabled in the guest's time zone.
  await booking
    .getByLabel("Your time zone", { exact: true })
    .selectOption(me.user.timezone);
  const closed = DateTime.fromISO(closedDate);
  if (closed.month !== DateTime.now().month)
    await booking.getByRole("button", { name: "Next month" }).click();
  await booking
    .locator(`[data-date="${closedDate}"].closed-date`)
    .waitFor();
  assert.equal(
    await booking.locator(`[data-date="${closedDate}"]`).isDisabled(),
    true,
  );
  completed++;
  console.log("PASS browser: holiday dates displayed as closed");

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("http://localhost:3199/app/events");
  await page
    .getByRole("button", { name: "Create event type", exact: true })
    .click();
  await page.getByLabel("What’s the occasion?").fill("Phone planning");
  await page
    .getByLabel("Where", { exact: true })
    .selectOption("Phone call");
  await page
    .getByLabel("Calling instructions or meeting address")
    .fill("We will call the number you provide.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create event type", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const phoneEvent = (
    await (
      await page.request.get("http://localhost:3199/api/events")
    ).json()
  ).events.find((e) => e.title === "Phone planning");
  await booking.goto(
    `http://localhost:3199/book/${me.user.slug}/${phoneEvent.slug}`,
  );
  await booking
    .getByText("We will call the number you provide.", { exact: true })
    .waitFor();
  await booking
    .getByLabel("Your time zone", { exact: true })
    .selectOption(me.user.timezone);
  if (day.month !== DateTime.now().month)
    await booking.getByRole("button", { name: "Next month" }).click();
  await booking.getByRole("button", { name: dayName, exact: true }).click();
  await booking.locator(".slot").first().click();
  await booking.getByLabel("Your name").fill("Phone Client");
  await booking
    .getByLabel("Email address", { exact: true })
    .fill("phone@example.com");
  assert.equal(
    await booking.getByLabel("Phone number").getAttribute("required"),
    "",
  );
  await booking.getByLabel("Phone number").fill("+1 212 555 0100");
  await booking
    .getByRole("button", { name: "Confirm appointment" })
    .click();
  await booking
    .getByRole("heading", { name: "You’re on the calendar." })
    .waitFor();
  await booking.getByText("Guest phone: +1 212 555 0100").waitFor();
  completed++;
  console.log(
    "PASS browser: phone instructions and required guest number survive confirmation",
  );
  const phoneManageUrl = await booking
    .getByRole("link", { name: "Manage appointment", exact: true })
    .getAttribute("href");
  service.db
    .prepare(
      "UPDATE bookings SET location='Google Meet',meet_state='pending',google_id='local-pending-meet' WHERE event_id=?",
    )
    .run(phoneEvent.id);
  await booking.goto(phoneManageUrl);
  await booking
    .getByText(/Your Google Meet link is being prepared/)
    .waitFor();
  service.db
    .prepare(
      "UPDATE bookings SET meet_state='ready',meet_url='https://meet.google.com/abc-defg-hij' WHERE event_id=?",
    )
    .run(phoneEvent.id);
  await booking.reload();
  assert.equal(
    await booking
      .getByRole("link", { name: "Join meeting", exact: true })
      .getAttribute("href"),
    "https://meet.google.com/abc-defg-hij",
  );
  completed++;
  console.log(
    "PASS browser: pending Meet message changes to join link after recovery",
  );

  const insert = service.db.prepare(
    "INSERT INTO bookings(id,event_id,user_id,name,email,timezone,start,end,status,manage_hash,title,location,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  service.db.exec("BEGIN");
  for (let i = 0; i < 1205; i++)
    insert.run(
      "browser-export-" + i,
      event.id,
      me.user.id,
      "Export Fixture " + i,
      "fixture@example.com",
      "UTC",
      day.toUTC().toISO(),
      day.plus({ minutes: 30 }).toUTC().toISO(),
      "cancelled",
      "browser-hash-" + i,
      "Export appointment",
      "Phone call",
      new Date().toISOString(),
    );
  service.db.exec("COMMIT");
  await page.goto("http://localhost:3199/app/bookings");
  await page.getByLabel("Filter appointments").selectOption("cancelled");
  await page.getByLabel("Search appointments").fill("Export Fixture");
  assert.equal(await page.locator(".booking-table tbody tr").count(), 1205);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const file = await download;
  await file.saveAs("test-results/filtered-export.csv");
  assert.equal(
    readFileSync("test-results/filtered-export.csv", "utf8").split("\r\n")
      .length,
    1206,
  );
  completed++;
  console.log(
    "PASS browser: all 1205 filtered appointments display and export",
  );

  await page.goto("http://localhost:3199/app/team");
  const ownerCard = page.locator(".team-card").filter({
    has: page.getByRole("heading", {
      name: "Account Owner",
      exact: true,
    }),
  });
  await ownerCard
    .getByRole("button", { name: "Sign out all sessions" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await page.getByText("Sessions revoked.").waitFor();
  await ownerCard
    .getByRole("button", { name: "Deactivate", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await ownerCard
    .getByRole("button", { name: "Reactivate", exact: true })
    .waitFor();
  assert.equal(
    service.db
      .prepare("SELECT active FROM users WHERE id=?")
      .get(pendingOwner.id).active,
    0,
  );
  completed++;
  console.log(
    "PASS browser: administrator session revocation and staff deactivation",
  );
  const previousNow = Settings.now;
  try {
    Settings.now = () => Date.parse("2026-10-20T12:00:00Z");
    await booking.clock.install({ time: new Date("2026-10-20T12:00:00Z") });
    service.db.prepare("UPDATE users SET overrides=? WHERE id=?").run(
      JSON.stringify([
        {
          date: "2026-11-01",
          windows: [{ start: "00:00", end: "04:00" }],
        },
      ]),
      me.user.id,
    );
    await booking.goto(
      `http://localhost:3199/book/${me.user.slug}/${event.slug}`,
    );
    await booking
      .getByLabel("Your time zone", { exact: true })
      .selectOption("America/New_York");
    await booking.getByRole("button", { name: "Next month" }).click();
    await booking
      .getByRole("button", { name: "November 1, 2026", exact: true })
      .click();
    await booking
      .getByRole("button", { name: "1:00 AM GMT-4", exact: true })
      .waitFor();
    await booking
      .getByRole("button", { name: "1:00 AM GMT-5", exact: true })
      .waitFor();
    await booking.screenshot({
      path: "test-results/daylight-saving-mobile.png",
      fullPage: true,
    });
    completed++;
    console.log(
      "PASS browser: repeated daylight-saving times show distinct UTC offsets",
    );
  } finally {
    Settings.now = previousNow;
  }
  assert.deepEqual(errors, [], "No browser errors");
  console.log(`${completed} browser workflows passed. No browser errors.`);
  await guest.close();
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  service.close();
}
