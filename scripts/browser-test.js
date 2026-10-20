import { chromium } from "@playwright/test";
import { createApp } from "../server.js";
import assert from "node:assert/strict";
import { mkdirSync, existsSync } from "node:fs";
import { DateTime } from "luxon";
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
  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  for (const route of ["/login", "/signup", "/reset?token=test-placeholder"]) {
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
  await page.getByText("Check your email to verify your account.").waitFor();
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
  await page.getByRole("button", { name: "Save photo", exact: true }).click();
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
  await page.getByRole("link", { name: "Availability", exact: true }).click();
  await page
    .getByRole("heading", { name: "Make time on your terms" })
    .waitFor();
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Minimum booking notice").selectOption("0");
  await page.getByRole("button", { name: "Save availability" }).click();
  await page
    .getByText("Availability saved. Your booking page is up to date.")
    .waitFor();
  completed++;
  console.log("PASS browser: save weekly availability");
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
  booking.on("pageerror", (err) => errors.push(err.message));
  await booking.goto(
    `http://localhost:3199/book/${me.user.slug}/${event.slug}`,
  );
  await booking.getByRole("heading", { name: "Find your moment" }).waitFor();
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
  await booking.getByRole("button", { name: "Confirm appointment" }).click();
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
  await page.getByRole("link", { name: "My calendar", exact: true }).click();
  await page.getByRole("heading", { name: "A little perspective" }).waitFor();
  await page.getByRole("link", { name: "Team", exact: true }).click();
  await page
    .getByRole("heading", { name: "Good people. Better together." })
    .waitFor();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Full name").fill("Alex Morgan");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("Profile updated.").waitFor();
  completed++;
  console.log("PASS browser: bookings, calendar, team and profile settings");
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
  await booking.getByRole("heading", { name: "Find your moment" }).waitFor();
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
  assert.deepEqual(errors, [], "No browser errors");
  console.log(`${completed} browser workflows passed. No browser errors.`);
  await guest.close();
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  service.close();
}
