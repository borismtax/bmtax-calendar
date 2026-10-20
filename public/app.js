const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const e = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l2-2"/>',
  settings:
    '<path d="m9 3-.6 3-2.8 1-2.6-.5-1 3L4 12l-2 2.5 1 3 3-.5 2.5 1 .5 3h6l.5-3 2.5-1 3 .5 1-3-2-2.5 2-2.5-1-3-3 .5-2.5-1-.5-3z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  video:
    '<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-3v10l-5-3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  external:
    '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  bulb: '<path d="M9 18h6m-5 3h4M8.1 14a6 6 0 1 1 7.8 0c-1 .8-.9 2-1.9 2h-4c-1 0-.9-1.2-1.9-2z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  shield: '<path d="m12 3 9 4v5c0 6-9 10-9 10S3 18 3 12V7zM8 12l3 3 5-6"/>',
  phone:
    '<path d="m5 3 4 1 1 5-3 2a15 15 0 0 0 6 6l2-3 5 1 1 4c0 4-8 2-13-3S1 3 5 3z"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2"/>',
};
const icon = (name, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.calendar}</svg>`;
const brand = () =>
  `<a href="/app" data-nav class="brand"><span class="brand-icon">b</span><span>BMT Calendar<small>Make time for what matters.</small></span></a>`;
const initials = (name) =>
  name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const state = {
  user: null,
  config: {},
  events: [],
  bookings: [],
  team: [],
  baseUrl: location.origin,
  tab: "upcoming",
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  public: null,
};
const zones = [
  ...new Set([
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "Europe/London",
    "Europe/Paris",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
    "UTC",
    ...(Intl.supportedValuesOf?.("timeZone") || []),
  ]),
];
const zoneOptions = (current) =>
  zones
    .map(
      (z) =>
        `<option value="${e(z)}" ${z === current ? "selected" : ""}>${e(z.replaceAll("_", " "))}</option>`,
    )
    .join("");
const fmt = (value, options = {}) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone:
      state.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...options,
  }).format(new Date(value));
const publicFmt = (value, options = {}) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: state.public?.timezone,
    ...options,
  }).format(new Date(value));
const dateKey = (value, zone) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone:
      zone ||
      state.user?.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
const localDateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const niceDate = (value) =>
  fmt(value, { month: "short", day: "numeric", year: "numeric" });
const niceTime = (value) => fmt(value, { hour: "numeric", minute: "2-digit" });
const eventClass = (color) =>
  ({
    "#10b981": "green",
    "#f59e0b": "amber",
    "#ec4899": "pink",
    "#3b82f6": "blue",
  })[color] || "";
const avatar = (user, cls = "") =>
  `<span class="avatar ${cls}">${user.photo ? `<img src="${e(user.photo)}" alt="${e(user.name)}’s profile photo">` : e(initials(user.name))}</span>`;
const locationIcon = (location) =>
  ["Google Meet", "Zoom"].includes(location)
    ? "video"
    : location === "Phone call"
      ? "phone"
      : "pin";
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The server could not complete this request. Please try again.",
    );
  }
  if (!response.ok) {
    const error = new Error(data.error || "Something went wrong.");
    error.status = response.status;
    throw error;
  }
  return data;
}
function toast(message, error = false) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied. Ready to share!");
  } catch {
    modal(
      "Your booking link",
      `<div class="form-group"><label for="copy-link">Copy this link</label><input id="copy-link" value="${e(text)}" readonly></div>`,
    );
    $("#copy-link").select();
  }
}
function navigate(path) {
  history.pushState({}, "", path);
  state.tab = "upcoming";
  renderRoute();
}
function empty(title, text, action = "") {
  return `<div class="empty">${icon("calendar")}<h3>${e(title)}</h3><p>${e(text)}</p>${action}</div>`;
}
function errorBox(message) {
  return `<div class="form-error" role="alert">${e(message)}</div>`;
}
function showFormError(form, error) {
  $(".form-error", form)?.remove();
  form.insertAdjacentHTML("afterbegin", errorBox(error.message));
}
async function submit(form, fn) {
  const button = $("button[type=submit]", form);
  const label = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.textContent = "One moment…";
  }
  try {
    await fn();
  } catch (error) {
    showFormError(form, error);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
}
let lastFocus;
function modal(title, body) {
  lastFocus = document.activeElement;
  $("#modal-root").innerHTML =
    `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-head"><h2 id="dialog-title">${e(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></div><div class="dialog-body">${body}</div></section></div>`;
  setTimeout(() => $(".dialog input,.dialog button")?.focus(), 0);
}
function closeModal() {
  $("#modal-root").innerHTML = "";
  lastFocus?.focus();
}
function confirmDialog(title, text, onConfirm) {
  modal(
    title,
    `<p class="muted">${e(text)}</p><div id="confirm-error"></div><div class="dialog-foot"><button class="btn secondary" data-action="close-modal">Keep appointment</button><button class="btn danger" id="confirm-action">Cancel appointment</button></div>`,
  );
  $("#confirm-action").onclick = async () => {
    const b = $("#confirm-action");
    b.disabled = true;
    try {
      await onConfirm();
      closeModal();
      toast("Appointment cancelled.");
    } catch (err) {
      $("#confirm-error").innerHTML = errorBox(err.message);
      b.disabled = false;
    }
  };
}
function authView(kind = "login", message = "") {
  const params = new URLSearchParams(location.search),
    signup = kind === "signup",
    forgot = kind === "forgot",
    reset = kind === "reset";
  const titles = {
    login: ["Welcome back", "Your time, your team, all in one place."],
    signup: [
      "Make room for what’s next",
      "Create your account and start scheduling.",
    ],
    forgot: ["Forgot your password?", "We’ll email you a link to reset it."],
    reset: ["A fresh start", "Choose a new password for your account."],
    verify: ["Verify your email", "Confirming your account…"],
  };
  const [title, subtitle] = titles[kind] || titles.login;
  $("#app").innerHTML =
    `<main class="auth-page"><aside class="auth-story">${brand()}<div class="story-content"><span class="eyebrow">Less back-and-forth. More possibilities.</span><h1>Great things<br>start with<br><em>a little time.</em></h1><p>A simpler way to bring people together.<br>Your calendar, your availability, your rules.</p><div class="story-booking"><div class="meeting-date"><small>Time</small><b>${icon("check")}</b></div><div><h3>One link. A confirmed meeting.</h3><p>That’s how simple scheduling should feel.</p></div><span class="check">${icon("check")}</span></div></div><footer>Thoughtfully built for the BMT team.</footer></aside><section class="auth-main"><div class="auth-form">${brand()}<h2>${title}</h2><p>${subtitle}</p>${message ? `<div class="form-success">${e(message)}</div>` : ""}${kind === "verify" ? '<div id="verify-result" class="loading">Verifying your email…</div>' : `<form id="auth-form">${signup ? `<div class="form-group"><label for="name">Full name</label><input id="name" name="name" placeholder="Alex Morgan" autocomplete="name" required minlength="2" maxlength="80"></div>` : ""}${!reset ? `<div class="form-group"><label for="email">Work email</label><input id="email" name="email" type="email" placeholder="you@company.com" autocomplete="email" value="${e(params.get("email") || "")}" required></div>` : ""}${!forgot ? `<div class="form-group"><label for="password">${reset ? "New password" : "Password"}</label><div class="password-field"><input id="password" name="password" type="password" placeholder="${signup || reset ? "At least 12 characters" : "Enter your password"}" autocomplete="${signup || reset ? "new-password" : "current-password"}" minlength="${signup || reset ? 12 : 1}" maxlength="128" required><button type="button" class="password-toggle" data-action="toggle-password" aria-controls="password" aria-label="Show password" aria-pressed="false">Show</button></div>${signup || reset ? "<small>Use at least 12 characters for a strong password.</small>" : ""}</div>` : ""}${kind === "login" ? `<div class="auth-meta"><span>${icon("shield")} Secure team access</span><a href="/forgot" data-nav>Forgot password?</a></div>` : ""}${signup && !params.get("invite") ? '<p class="small muted">Team members need an invitation. Administrators can use the configured owner email.</p>' : ""}<button class="btn full" type="submit">${signup ? "Create account" : forgot ? "Send reset link" : reset ? "Update password" : "Sign in"} ${icon("arrow")}</button></form>${kind === "login" && state.config.demo ? `<div class="divider">TAKE A LOOK AROUND</div><button class="btn secondary full" data-action="demo-login">Explore the demo ${icon("arrow")}</button>` : ""}<p class="auth-switch">${kind === "login" ? `New here? <a href="/signup" data-nav>Create an account</a>` : `<a href="/login" data-nav>Back to sign in</a>`}</p><p class="auth-note muted">By using BMT Calendar, you agree to your organization’s scheduling and data policies.</p>`}</div></section></main>`;
  if (kind === "verify") {
    api("/api/auth/verify", {
      method: "POST",
      body: { token: params.get("token") },
    })
      .then((data) => {
        if (
          location.pathname !== "/verify" ||
          new URLSearchParams(location.search).get("token") !==
            params.get("token")
        )
          return;
        if (data.alreadyVerified) {
          $(".auth-form > h2").textContent = "Email verified";
          $(".auth-form > p").textContent =
            "Your account is ready. Sign in to continue.";
          $("#verify-result").innerHTML =
            '<div class="form-success">This email has already been verified.</div><a href="/login" data-nav class="btn full">Continue to sign in</a>';
          return;
        }
        state.user = data.user;
        navigate("/app");
      })
      .catch((err) => {
        const result = $("#verify-result");
        if (
          !result ||
          new URLSearchParams(location.search).get("token") !==
            params.get("token")
        )
          return;
        result.innerHTML =
          errorBox(err.message) +
          `<p class="small muted">Already verified? <a href="/login" data-nav>Sign in</a>. Otherwise, request a fresh verification email below.</p><form id="verification-resend"><div class="form-group"><label for="verification-email">Work email</label><input id="verification-email" name="email" type="email" autocomplete="email" required></div><button type="submit" class="btn full">Send a new verification link</button></form>`;
        $("#verification-resend").onsubmit = (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          submit(form, async () => {
            const data = await api("/api/auth/resend-verification", {
              method: "POST",
              body: { email: new FormData(form).get("email") },
            });
            form.innerHTML = `<div class="form-success">${e(data.message)}</div><a href="/login" data-nav>Back to sign in</a>`;
          });
        };
      });
    return;
  }
  $("#auth-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const data = Object.fromEntries(new FormData(form));
      if (signup) data.invite = params.get("invite") || undefined;
      if (reset) data.token = params.get("token");
      const result = await api(
        `/api/auth/${signup ? "register" : forgot ? "forgot" : reset ? "reset" : "login"}`,
        { method: "POST", body: data },
      );
      if (result.user) {
        state.user = result.user;
        navigate("/app");
      } else {
        form.innerHTML = `<div class="form-success">${e(result.message)}</div><a href="/login" data-nav class="btn secondary full">Back to sign in</a>`;
      }
    });
  };
}
function shell(page, body) {
  const u = state.user,
    nav = [
      ["dashboard", "grid", "Overview", "/app"],
      ["bookings", "calendar", "Bookings", "/app/bookings"],
      ["events", "link", "Event types", "/app/events"],
      ["availability", "clock", "Availability", "/app/availability"],
      ["calendar", "calendar", "My calendar", "/app/calendar"],
      ["team", "users", "Team", "/app/team"],
    ];
  $("#app").innerHTML =
    `<aside class="sidebar">${brand()}<span class="workspace-label">WORKSPACE</span><nav class="nav" aria-label="Main navigation">${nav.map(([key, i, label, url]) => `<a href="${url}" data-nav class="${page === key ? "active" : ""}" ${page === key ? 'aria-current="page"' : ""}>${icon(i)}${label}${key === "events" ? `<span class="nav-count">${state.events.filter((v) => v.active).length}</span>` : ""}</a>`).join("")}</nav><div class="sidebar-bottom"><div class="tip-card">${icon("bulb")}<h3>Your time, well spent.</h3><p>Share your booking link and let your calendar do the coordinating.</p><a href="/book/${e(u.slug)}" target="_blank" rel="noopener">View your booking page ↗</a></div><nav class="nav"><a href="/app/settings" data-nav class="${page === "settings" ? "active" : ""}">${icon("settings")}Settings</a></nav><div class="user-card">${avatar(u)}<div><strong>${e(u.name)}</strong><small>${u.role === "admin" ? "Workspace admin" : "Team member"}</small></div><button class="btn ghost" data-action="logout" title="Sign out" aria-label="Sign out">${icon("logout")}</button></div></div></aside><div class="shell"><header class="topbar"><div class="breadcrumb"><button class="icon-btn mobile-menu" data-action="mobile-menu" aria-label="Toggle menu">${icon("menu")}</button><span>Workspace</span>${icon("right")}<b>${nav.find((n) => n[0] === page)?.[2] || "Settings"}</b></div><div class="top-actions"><span class="calendar-status small muted">${u.googleConnected ? '<span class="status-dot"></span>Calendar connected' : "Calendar not connected"}</span><a class="btn secondary" href="/book/${e(u.slug)}" target="_blank" rel="noopener">${icon("external")}Booking page</a>${avatar(u, "purple")}</div></header><main class="content">${state.config.demo ? `<div class="notice demo">${icon("bulb")}<span>Demo workspace · Appointments stay local. Google Calendar and email delivery are not connected.</span></div>` : !u.googleConnected ? `<div class="notice">${icon("calendar")}<span>Connect Google Calendar to open your booking page and prevent scheduling conflicts.</span><a class="btn secondary" href="/app/settings" data-nav>Connect calendar ${icon("arrow")}</a></div>` : ""}${state.pendingEmails ? `<div class="notice error">${icon("mail")} ${state.pendingEmails} email${state.pendingEmails === 1 ? " is" : "s are"} waiting for delivery. Check Resend settings; delivery retries automatically.</div>` : ""}${state.pendingBookings ? `<div class="notice error">${icon("calendar")}<span>${state.pendingBookings} calendar request(s) need confirmation. <a href="/app/bookings?filter=all" data-nav>Open all appointments</a>, select the pending request, and check its calendar status.</span></div>` : ""}${body}<footer class="footer"><span>© ${new Date().getFullYear()} BMT Calendar. A little less busywork.</span><span>${icon("shield")} Your schedule is in good hands.</span></footer></main></div>`;
}
function heading(title, sub, actions = "") {
  return `<div class="page-heading"><div><h1>${e(title)}</h1><p>${e(sub)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>`;
}
const newEventBtn = () =>
  `<button class="btn" data-action="new-event">${icon("plus")}Create event type</button>`;
function eventCard(v) {
  return `<article class="event-card ${eventClass(v.color)} ${v.active ? "" : "disabled"}"><div class="event-top"><span class="event-symbol">${icon(locationIcon(v.location))}</span><button class="btn ghost" data-action="edit-event" data-id="${e(v.id)}" aria-label="Edit ${e(v.title)}">${icon("edit")}</button></div><h3>${e(v.title)}</h3><p>${e(v.description || "A little time to connect and move things forward.")}</p><div class="event-meta"><span>${icon("clock")}${v.duration} min</span><span>${icon(locationIcon(v.location))}${e(v.location)}</span>${!v.active ? "<span>Paused</span>" : ""}</div><div class="event-bottom"><a href="/book/${e(state.user.slug)}/${e(v.slug)}" target="_blank" rel="noopener">View booking page ${icon("external")}</a><button data-action="copy-event" data-id="${e(v.id)}">${icon("copy")}Copy link</button></div></article>`;
}
function miniCalendar(month = state.calendarMonth) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1),
    offset = (first.getDay() + 6) % 7,
    days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push("<span></span>");
  for (let day = 1; day <= days; day++) {
    const d = new Date(month.getFullYear(), month.getMonth(), day),
      key = localDateKey(d),
      today = key === dateKey(new Date()),
      has = state.bookings.some(
        (b) => b.status === "scheduled" && dateKey(b.start) === key,
      );
    cells.push(
      `<span class="cal-day ${today ? "today" : ""} ${has ? "has-meeting" : ""}">${day}</span>`,
    );
  }
  return `<div class="panel mini-calendar"><div class="calendar-head"><span>${month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span><span><button data-action="month-prev" aria-label="Previous month">${icon("left")}</button><button data-action="month-next" aria-label="Next month">${icon("right")}</button></span></div><div class="calendar-grid">${["M", "T", "W", "T", "F", "S", "S"].map((d) => `<span class="weekday">${d}</span>`).join("")}${cells.join("")}</div><div class="calendar-note"><i></i> You have appointments on these days</div></div>`;
}
function meetingRow(b) {
  return `<div class="meeting"><div class="meeting-date"><small>${fmt(b.start, { month: "short" })}</small><b>${fmt(b.start, { day: "numeric" })}</b></div><div class="meeting-body"><h3>${e(b.title)} <span class="muted">with ${e(b.name)}</span></h3><p>${icon("clock")}${niceTime(b.start)} – ${niceTime(b.end)} <span>·</span>${icon(locationIcon(b.location))}${e(b.location)}</p></div><span class="pill ${b.status === "cancelled" ? "cancelled" : b.status === "pending" ? "pending" : ""}">${b.status === "scheduled" ? "Confirmed" : e(b.status)}</span><div class="meeting-actions">${b.meet_url && b.status === "scheduled" ? `<a href="${e(b.meet_url)}" target="_blank" rel="noopener" class="icon-btn" aria-label="Join meeting">${icon("video")}</a>` : ""}<button class="icon-btn" data-action="booking-details" data-id="${e(b.id)}" aria-label="View appointment details">${icon("right")}</button></div></div>`;
}
function dashboard() {
  const now = new Date(),
    today = dateKey(now),
    future = state.bookings
      .filter((b) => b.status === "scheduled" && new Date(b.end) > now)
      .sort((a, b) => a.start.localeCompare(b.start)),
    past = state.bookings.filter(
      (b) => new Date(b.end) <= now && b.status === "scheduled",
    ),
    weekEnd = new Date(now.getTime() + 7 * 86400000),
    week = future.filter((b) => new Date(b.start) < weekEnd);
  const first = state.user.name.split(" ")[0],
    hour = Number(fmt(now, { hour: "numeric", hour12: false })),
    greeting =
      hour < 12
        ? "Good morning"
        : hour < 17
          ? "Good afternoon"
          : "Good evening";
  const chosen =
    state.tab === "past"
      ? past.slice().reverse()
      : state.tab === "cancelled"
        ? state.bookings.filter((b) => b.status === "cancelled")
        : future;
  const stats = [
    [
      "calendar",
      "Upcoming meetings",
      future.length,
      "Your next opportunities to connect",
    ],
    ["clock", "Meetings this week", week.length, "Over the next 7 days"],
    [
      "link",
      "Active event types",
      state.events.filter((v) => v.active).length,
      "Ready to share with your clients",
    ],
    ["users", "Team members", state.team.length, "Better together, always"],
  ];
  shell(
    "dashboard",
    heading(
      `${greeting}, ${first} ☀`,
      "Here’s what’s happening with your schedule.",
      `<button class="btn secondary" data-action="copy-page">${icon("copy")}Share booking link</button>${newEventBtn()}`,
    ) +
      `<section class="stats" aria-label="Scheduling overview">${stats.map(([i, label, n, caption]) => `<article class="stat"><div class="stat-top"><span>${label}</span><div class="stat-icon">${icon(i)}</div></div><div class="stat-number">${String(n).padStart(2, "0")}</div><div class="stat-caption">${caption}</div></article>`).join("")}</section><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h2>Your appointments</h2><a href="/app/bookings" data-nav>View all ${icon("arrow")}</a></div><div class="tabs" role="tablist" aria-label="Appointment status">${[
        ["upcoming", "Upcoming", future.length],
        ["past", "Past", past.length],
        [
          "cancelled",
          "Cancelled",
          state.bookings.filter((b) => b.status === "cancelled").length,
        ],
      ]
        .map(
          ([key, label, n]) =>
            `<button class="tab ${state.tab === key ? "active" : ""}" role="tab" aria-selected="${state.tab === key}" data-action="dashboard-tab" data-tab="${key}">${label} <span>${n}</span></button>`,
        )
        .join("")}</div>${
        chosen.length
          ? `<div class="meeting-list">${chosen
              .slice(0, 4)
              .map(
                (b, i) =>
                  `${i === 0 || dateKey(chosen[i - 1].start) !== dateKey(b.start) ? `<div class="date-label">${dateKey(b.start) === today ? "Today" : fmt(b.start, { weekday: "long", month: "short", day: "numeric" })}</div>` : ""}${meetingRow(b)}`,
              )
              .join("")}</div>`
          : empty(
              state.tab === "upcoming"
                ? "Your next meeting starts here"
                : `No ${state.tab} appointments`,
              state.tab === "upcoming"
                ? "Share your booking link. Your clients choose a time, and everything falls into place."
                : "Your appointments will appear here as your schedule fills up.",
              state.tab === "upcoming"
                ? '<button class="btn secondary" data-action="copy-page">Copy booking link</button>'
                : "",
            )
      }<div class="panel-foot"><span>${chosen.length ? `Showing ${Math.min(4, chosen.length)} of ${chosen.length} appointments` : "A clear calendar. A world of possibilities."}</span><span>${e(state.user.timezone.replaceAll("_", " "))}</span></div></section><aside class="side-stack">${miniCalendar()}<div class="link-card"><span class="badge-icon">${icon("link")}</span><h3>Your next meeting is one link away.</h3><p>No email tennis. Just share your link and let people pick a time.</p><div class="link-field">${e(new URL(state.baseUrl).host)}/${e(state.user.slug)}</div><button class="btn full secondary" data-action="copy-page">${icon("copy")}Copy booking link</button></div></aside></div><div class="section-heading"><h2>Ready to meet</h2><a href="/app/events" data-nav>All event types ${icon("arrow")}</a></div><section class="event-grid">${state.events.slice(0, 3).map(eventCard).join("") || empty("Create your first event type", "Choose a duration, add a description, and you’re ready to share.", newEventBtn())}</section>`,
  );
}
function eventsView() {
  shell(
    "events",
    heading(
      "A meeting for every moment",
      "Create the ways people can book time with you.",
      newEventBtn(),
    ) +
      `<section class="event-grid">${state.events.map(eventCard).join("") || empty("What should we call your first meeting?", "Create an event type to start accepting appointments.", newEventBtn())}</section>`,
  );
}
function bookingTable(rows) {
  return rows.length
    ? `<div class="table-wrap"><table class="booking-table"><thead><tr><th>APPOINTMENT</th><th>GUEST</th><th>WHEN</th><th>STATUS</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows.map((b) => `<tr><td><strong>${e(b.title)}</strong><small>${e(b.location)}${b.host_name ? " · " + e(b.host_name) : ""}</small></td><td><strong>${e(b.name)}</strong><small>${e(b.email)}</small></td><td><strong>${niceDate(b.start)}</strong><small>${niceTime(b.start)} – ${niceTime(b.end)}</small></td><td><span class="pill ${b.status === "cancelled" ? "cancelled" : b.status === "scheduled" ? "" : "pending"}">${b.status === "scheduled" ? "Confirmed" : e(b.status)}</span></td><td><button class="icon-btn" data-action="booking-details" data-id="${e(b.id)}" aria-label="View ${e(b.title)} details">${icon("right")}</button></td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "No appointments here yet",
        "When someone books a time, you’ll find all the details here.",
      );
}
function bookingsView() {
  shell(
    "bookings",
    heading(
      "Your appointments",
      "Every conversation, in one place.",
      `<button class="btn secondary" data-action="export">${icon("external")}Export CSV</button><button class="btn" data-action="copy-page">${icon("link")}Share booking link</button>`,
    ) +
      `<div class="filter-row"><label class="search-field">${icon("search")}<span class="visually-hidden">Search appointments</span><input id="booking-search" placeholder="Search guests or appointments…" type="search"></label><div><label class="visually-hidden" for="booking-filter">Filter appointments</label><select id="booking-filter"><option value="upcoming">Upcoming appointments</option><option value="all">All appointments</option><option value="past">Past appointments</option><option value="cancelled">Cancelled appointments</option></select>${state.user.role === "admin" ? ` <label class="small muted"><input id="team-bookings" type="checkbox"> Entire team</label>` : ""}</div></div><section class="panel" id="booking-results">${bookingTable(state.bookings.filter((b) => b.status === "scheduled" && new Date(b.end) > new Date()).sort((a, b) => a.start.localeCompare(b.start)))}</section>`,
  );
  if (new URLSearchParams(location.search).get("filter") === "all") {
    $("#booking-filter").value = "all";
    filterBookings();
  }
  $("#booking-search").oninput = filterBookings;
  $("#booking-filter").onchange = filterBookings;
  if ($("#team-bookings"))
    $("#team-bookings").onchange = async (event) => {
      try {
        state.bookings = (
          await api(`/api/bookings?team=${event.target.checked}`)
        ).bookings;
        filterBookings();
      } catch (err) {
        toast(err.message, true);
      }
    };
}
function filterBookings() {
  const search = $("#booking-search").value.toLowerCase(),
    filter = $("#booking-filter").value;
  const rows = state.bookings
    .filter(
      (b) =>
        (b.name + " " + b.email + " " + b.title)
          .toLowerCase()
          .includes(search) &&
        (filter === "all" ||
          (filter === "cancelled" && b.status === "cancelled") ||
          (filter === "upcoming" &&
            b.status === "scheduled" &&
            new Date(b.end) > new Date()) ||
          (filter === "past" &&
            b.status === "scheduled" &&
            new Date(b.end) <= new Date())),
    )
    .sort((a, b) =>
      filter === "upcoming"
        ? a.start.localeCompare(b.start)
        : b.start.localeCompare(a.start),
    );
  $("#booking-results").innerHTML = bookingTable(rows);
}
function availabilityView() {
  const u = state.user;
  shell(
    "availability",
    heading(
      "Make time on your terms",
      "Set your working hours. We’ll take care of the rest.",
    ) +
      `<form id="availability-form"><div class="settings-grid"><section class="panel"><div class="panel-head"><h2>Weekly availability</h2><span class="pill">Repeats every week</span></div><div class="panel-body"><div class="form-group"><label for="timezone">Your time zone</label><select name="timezone" id="timezone">${zoneOptions(u.timezone)}</select><small>Your guests see available times in their own time zone.</small></div>${[
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ]
        .map((day, i) => {
          const w = u.windows.find((w) => w.day === i + 1);
          return `<div class="availability-row"><label><input type="checkbox" name="day-${i + 1}" ${w ? "checked" : ""}>${day}</label><input type="time" name="start-${i + 1}" aria-label="${day} start" value="${w?.start || "09:00"}"><span>to</span><input type="time" name="end-${i + 1}" aria-label="${day} end" value="${w?.end || "17:00"}"></div>`;
        })
        .join(
          "",
        )}${u.windows.some((w, i) => u.windows.findIndex((a) => a.day === w.day) !== i) ? '<div class="notice">You have split availability windows. Saving this form will use the first window shown for each day.</div>' : ""}</div></section><section class="panel"><div class="panel-head"><h2>A little breathing room</h2></div><div class="panel-body"><div class="form-group"><label for="buffer">Buffer around meetings</label><select id="buffer" name="buffer">${[0, 5, 10, 15, 20, 30, 45, 60, 90, 120].map((n) => `<option value="${n}" ${n === u.buffer ? "selected" : ""}>${n === 0 ? "No buffer" : n + " minutes"}</option>`).join("")}</select><small>Keep space before and after appointments.</small></div><div class="form-group"><label for="notice">Minimum booking notice</label><select id="notice" name="notice">${[
        [0, "No minimum"],
        [30, "30 minutes"],
        [60, "1 hour"],
        [120, "2 hours"],
        [240, "4 hours"],
        [720, "12 hours"],
        [1440, "24 hours"],
        [2880, "48 hours"],
        [10080, "7 days"],
      ]
        .map(
          ([n, label]) =>
            `<option value="${n}" ${n === u.notice ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select><small>A little time to prepare for your next conversation.</small></div><div class="form-group"><label for="horizon">Booking window</label><select name="horizon" id="horizon">${[7, 14, 30, 60, 90, 120, 180].map((n) => `<option value="${n}" ${n === u.horizon ? "selected" : ""}>${n} days into the future</option>`).join("")}</select></div><div class="notice small">${icon("calendar")}Google Calendar busy events automatically block bookings.</div></div></section></div><div class="settings-actions"><button class="btn" type="submit">${icon("check")}Save availability</button></div></form>`,
  );
  $("#availability-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const f = new FormData(form),
        windows = [];
      for (let day = 1; day <= 7; day++)
        if (f.has("day-" + day))
          windows.push({
            day,
            start: f.get("start-" + day),
            end: f.get("end-" + day),
          });
      const result = await api("/api/me", {
        method: "PATCH",
        body: {
          name: u.name,
          timezone: f.get("timezone"),
          buffer: Number(f.get("buffer")),
          notice: Number(f.get("notice")),
          horizon: Number(f.get("horizon")),
          windows,
        },
      });
      state.user = result.user;
      toast("Availability saved. Your booking page is up to date.");
    });
  };
}
function calendarView() {
  const month = state.calendarMonth,
    offset =
      (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7,
    first = new Date(month.getFullYear(), month.getMonth(), 1 - offset),
    daysInMonth = new Date(
      month.getFullYear(),
      month.getMonth() + 1,
      0,
    ).getDate(),
    count = Math.ceil((offset + daysInMonth) / 7) * 7,
    cells = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(
        first.getFullYear(),
        first.getMonth(),
        first.getDate() + i,
      ),
      key = localDateKey(d),
      bookings = state.bookings.filter(
        (b) => dateKey(b.start) === key && b.status === "scheduled",
      );
    cells.push(
      `<div class="calendar-cell ${d.getMonth() !== month.getMonth() ? "outside" : ""} ${key === dateKey(new Date()) ? "today" : ""}"><span>${d.getDate()}</span>${bookings.map((b) => `<button class="cal-event" data-action="booking-details" data-id="${e(b.id)}">${niceTime(b.start)} ${e(b.name)}</button>`).join("")}</div>`,
    );
  }
  shell(
    "calendar",
    heading(
      "A little perspective",
      "Your booked appointments, at a glance.",
      `<button class="btn secondary" data-action="month-today">Today</button>`,
    ) +
      `<section class="panel"><div class="panel-head"><h2>${month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</h2><div><button class="icon-btn" data-action="month-prev" aria-label="Previous month">${icon("left")}</button> <button class="icon-btn" data-action="month-next" aria-label="Next month">${icon("right")}</button></div></div><div class="calendar-big">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="weekday">${d}</div>`).join("")}${cells.join("")}</div><div class="panel-foot"><span>Appointments booked through BMT Calendar</span><span>${e(state.user.timezone)}</span></div></section>`,
  );
}
function teamView() {
  shell(
    "team",
    heading(
      "Good people. Better together.",
      "One workspace, a calendar for everyone.",
      state.user.role === "admin"
        ? `<button class="btn" data-action="invite">${icon("plus")}Invite teammate</button>`
        : "",
    ) +
      `<section class="team-grid">${state.team.map((u) => `<article class="team-card">${avatar(u, "purple")}<h3>${e(u.name)}${u.id === state.user.id ? ' <span class="small muted">(you)</span>' : ""}</h3><p>${e(u.email || "Team member")}</p><div><span class="pill">${u.role === "admin" ? "Workspace admin" : "Team member"}</span></div>${u.googleConnected === false ? '<p class="small muted">Calendar connection pending</p>' : ""}<a href="/book/${e(u.slug)}" target="_blank" rel="noopener" class="btn secondary">${icon("external")}Booking page</a></article>`).join("")}</section>`,
  );
}
function photoEditor(user) {
  return `<div class="photo-editor"><div class="photo-preview">${avatar(user, "purple")}</div><form id="photo-form"><div class="form-group"><label for="profile-photo">Profile picture <span class="muted">(optional)</span></label><input id="profile-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp"><small>JPG, PNG, or WebP, up to 2 MB. Your photo appears on your booking page and team profile.</small></div><button type="submit" class="btn secondary">Save photo</button>${user.photo ? '<button type="button" class="btn ghost" data-action="remove-photo">Remove photo</button>' : ""}</form></div>`;
}
function bindPhotoForm() {
  $("#photo-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const file = $("#profile-photo").files[0];
      if (!file) throw new Error("Choose a photo first.");
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 2 * 1024 * 1024
      )
        throw new Error("Choose a JPG, PNG, or WebP photo smaller than 2 MB.");
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () =>
          reject(new Error("This photo could not be read. Try another file."));
        reader.readAsDataURL(file);
      });
      state.user = (
        await api("/api/me/photo", { method: "PUT", body: { image } })
      ).user;
      toast("Profile photo saved.");
      await renderRoute();
    });
  };
}
function onboardingView() {
  const user = state.user;
  publicFrame(
    `<section class="setup-card panel"><div class="setup-heading"><span class="eyebrow">WELCOME TO YOUR CALENDAR</span><h1>Make it yours</h1><p class="muted">Hi ${e(user.name.split(" ")[0])}, let’s get your profile and calendar ready.</p></div><div class="setup-step"><span class="step-number">1</span><div><h2>Add a familiar face</h2><p class="small muted">Help clients recognize who they’re meeting. You can add or change this later.</p>${photoEditor(user)}</div></div><div class="setup-step"><span class="step-number">2</span><div><h2>Connect Google Calendar</h2><p class="small muted">Check your availability and automatically add appointments to your calendar. Zoom appointments also use Google Calendar to prevent double bookings.</p>${user.googleConnected ? `<div class="form-success">${icon("check")} Connected to ${e(user.googleEmail || "Google Calendar")}</div>` : `<a class="btn secondary" href="/api/google/connect"><span class="google-logo small-google">G</span>Connect Google Calendar</a>`}${new URLSearchParams(location.search).get("google") === "denied" ? '<div class="form-error">The connection was cancelled. Please connect your calendar to finish setup.</div>' : ""}</div></div><div class="setup-footer"><button class="btn" data-action="finish-setup" ${user.googleConnected ? "" : "disabled"}>Continue to workspace ${icon("arrow")}</button><button class="btn ghost" data-action="logout">Sign out</button><p class="small muted">${user.googleConnected ? "You’re ready to set availability and share your first booking link." : "Connect your calendar to continue. Your profile picture can be added later."}</p></div></section>`,
  );
  bindPhotoForm();
}
function settingsView() {
  const u = state.user;
  shell(
    "settings",
    heading(
      "Make yourself at home",
      "Manage your profile and calendar connections.",
    ) +
      `<div class="settings-grid"><section class="panel"><div class="panel-head"><h2>Your profile</h2></div><div class="panel-body">${photoEditor(u)}<form id="profile-form"><div class="form-group"><label for="profile-name">Full name</label><input id="profile-name" name="name" value="${e(u.name)}" required minlength="2" maxlength="80"></div><div class="form-group"><label for="profile-email">Email address</label><input id="profile-email" value="${e(u.email)}" type="email" disabled><small>Your verified email identifies your team account.</small></div><div class="form-group"><label for="profile-zone">Time zone</label><select name="timezone" id="profile-zone">${zoneOptions(u.timezone)}</select></div><div class="form-group"><label for="profile-link">Your booking page</label><input id="profile-link" value="${e(state.baseUrl + "/book/" + u.slug)}" readonly></div><button class="btn" type="submit">Save changes</button></form></div></section><div class="side-stack"><section class="panel"><div class="panel-head"><h2>Calendar connections</h2></div><div class="panel-body"><div class="connection"><span class="google-logo">G</span><div><h3>Google Calendar</h3><p>${u.googleConnected ? e(u.googleEmail) : "Keep availability in sync and add bookings to your primary calendar."}</p>${u.googleConnected ? `<span class="pill">Connected</span> <a class="btn secondary" href="/api/google/connect">Reconnect</a> <button class="btn secondary" data-action="check-calendar">Check connection</button> <button class="btn ghost" data-action="disconnect">Disconnect</button>` : `<a href="/api/google/connect" class="btn secondary">Connect Google Calendar</a>`}</div></div><div id="calendar-health" aria-live="polite"></div>${!state.config.googleConfigured ? '<p class="small muted">The administrator needs to configure Google OAuth credentials before calendars can connect.</p>' : ""}</div></section><section class="panel"><div class="panel-head"><h2>Account security</h2>${icon("shield")}</div><div class="panel-body"><p class="small muted">We’ll send a secure link to your verified email address.</p><button class="btn secondary" data-action="password-reset">Reset my password</button></div></section></div></div>`,
  );
  bindPhotoForm();
  $("#profile-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const f = new FormData(form),
        { user } = await api("/api/me", {
          method: "PATCH",
          body: {
            name: f.get("name"),
            timezone: f.get("timezone"),
            notice: u.notice,
            buffer: u.buffer,
            horizon: u.horizon,
            windows: u.windows,
          },
        });
      state.user = user;
      toast("Profile updated.");
      settingsView();
    });
  };
}
function eventModal(id) {
  const v = state.events.find((v) => v.id === id) || {
    title: "",
    duration: 30,
    description: "",
    location: "Google Meet",
    color: "#6366f1",
    active: 1,
  };
  modal(
    id ? "Edit event type" : "Create an event type",
    `<form id="event-form"><div class="form-group"><label for="event-title">What’s the occasion?</label><input name="title" id="event-title" value="${e(v.title)}" placeholder="e.g. Tax strategy call" required minlength="2" maxlength="80"></div><div class="form-row"><div class="form-group"><label for="event-duration">Duration</label><select id="event-duration" name="duration">${[15, 30, 45, 60, 75, 90, 120, 150, 180, 240].map((n) => `<option value="${n}" ${n === v.duration ? "selected" : ""}>${n} minutes</option>`).join("")}</select></div><div class="form-group"><label for="event-location">Where</label><select id="event-location" name="location">${["Google Meet", "Zoom", "Phone call", "In person"].map((l) => `<option ${l === v.location ? "selected" : ""}>${l}</option>`).join("")}</select></div></div><div id="zoom-link-field" class="form-group" ${v.location === "Zoom" ? "" : "hidden"}><label for="event-zoom-link">Zoom meeting link</label><input type="url" id="event-zoom-link" name="meetingUrl" value="${e(v.meeting_url || "")}" placeholder="https://us02web.zoom.us/j/1234567890" ${v.location === "Zoom" ? "required" : "disabled"}><small>Paste an existing Zoom meeting link. It will be included in calendar invitations and confirmation emails. A new Zoom room is not created automatically.</small></div><div class="form-group"><label for="event-description">A little about this meeting</label><textarea name="description" id="event-description" placeholder="Let guests know what to expect…" maxlength="2000">${e(v.description)}</textarea></div><div class="form-group"><label>Event color</label><div class="color-options">${[
      ["#6366f1", "purple"],
      ["#10b981", "green"],
      ["#f59e0b", "amber"],
      ["#ec4899", "pink"],
      ["#3b82f6", "blue"],
    ]
      .map(
        ([hex, name]) =>
          `<label><input type="radio" name="color" value="${hex}" ${v.color === hex ? "checked" : ""} aria-label="${name}"><span class="color-dot ${name}"></span></label>`,
      )
      .join(
        "",
      )}</div></div><div class="form-group"><label><input type="checkbox" name="active" ${v.active ? "checked" : ""}> Available for booking</label><small>Uncheck to pause new bookings. Existing appointments stay on your calendar.</small></div><div class="dialog-foot"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn">${id ? "Save changes" : "Create event type"}</button></div></form>`,
  );
  $("#event-location").onchange = (event) => {
    const zoom = event.target.value === "Zoom";
    $("#zoom-link-field").hidden = !zoom;
    $("#event-zoom-link").required = zoom;
    $("#event-zoom-link").disabled = !zoom;
  };
  $("#event-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const f = new FormData(form);
      await api("/api/events" + (id ? "/" + id : ""), {
        method: id ? "PATCH" : "POST",
        body: {
          title: f.get("title"),
          duration: Number(f.get("duration")),
          description: f.get("description"),
          location: f.get("location"),
          meetingUrl: f.get("meetingUrl") || "",
          color: f.get("color"),
          active: f.has("active"),
        },
      });
      closeModal();
      toast(id ? "Event type updated." : "Your new event type is ready.");
      await renderRoute();
    });
  };
}
function bookingDetails(id) {
  const b = state.bookings.find((b) => b.id === id);
  if (!b) return;
  modal(
    "Appointment details",
    `<h3>${e(b.title)}</h3><div class="confirmation-summary"><p class="booking-detail">${icon("users")}${e(b.name)} · ${e(b.email)}</p><p class="booking-detail">${icon("calendar")}${niceDate(b.start)}</p><p class="booking-detail">${icon("clock")}${niceTime(b.start)} – ${niceTime(b.end)}</p><p class="booking-detail">${icon(locationIcon(b.location))}${e(b.location)}</p><span class="pill ${b.status === "cancelled" ? "cancelled" : ""}">${e(b.status)}</span></div>${b.notes ? `<p class="small muted"><strong>Guest notes</strong><br>${e(b.notes)}</p>` : ""}<div class="dialog-foot">${b.meet_url ? `<a href="${e(b.meet_url)}" target="_blank" rel="noopener" class="btn">${icon("video")}Join meeting</a>` : ""}${b.status === "pending" ? `<button class="btn secondary" data-action="reconcile-booking" data-id="${e(b.id)}">Check calendar status</button>` : ""}${b.status === "scheduled" && new Date(b.start) > new Date() ? `<button class="btn danger" data-action="cancel-booking" data-id="${e(b.id)}">Cancel appointment</button>` : ""}</div>`,
  );
}
function publicFrame(body) {
  $("#app").innerHTML =
    `<main class="public-page"><header class="public-nav">${brand()}<a href="/login" data-nav>Team sign in ${icon("arrow")}</a></header>${state.config.demo ? '<div class="notice demo">Demo booking · No live Google Calendar events or emails will be sent.</div>' : ""}${state.pendingBookings ? `<div class="notice error">${icon("calendar")}<span>${state.pendingBookings} calendar request(s) need confirmation. <a href="/app/bookings?filter=all" data-nav>Open all appointments</a>, select the pending request, and check its calendar status.</span></div>` : ""}${body}<footer class="public-footer">A little less back-and-forth. Powered by BMT Calendar.</footer></main>`;
}
function publicInfo() {
  const p = state.public;
  return `<aside class="booking-info">${avatar(p.host, "purple")}<div class="muted">${e(p.host.name)}</div><h1>${e(p.event.title)}</h1><div class="booking-detail">${icon("clock")}${p.event.duration} minutes</div><div class="booking-detail">${icon(locationIcon(p.event.location))}${e(p.event.location)}</div>${p.start ? `<div class="booking-detail">${icon("calendar")}${publicFmt(p.start, { weekday: "short", month: "short", day: "numeric" })}</div><div class="booking-detail">${icon("clock")}${publicFmt(p.start, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</div>` : ""}<p>${e(p.event.description)}</p></aside>`;
}
async function hostPage(host) {
  const data = await api(`/api/public/${encodeURIComponent(host)}`);
  publicFrame(
    `<section class="public-event-list"><div class="public-host">${avatar(data.host, "purple")}<h1>A little time with ${e(data.host.name.split(" ")[0])}</h1><p>Choose a meeting below. Let’s find a time that works for you.</p></div><div class="event-grid">${data.events.map((v) => `<article class="event-card ${eventClass(v.color)}"><span class="event-symbol">${icon(locationIcon(v.location))}</span><h3>${e(v.title)}</h3><p>${e(v.description)}</p><div class="event-meta"><span>${icon("clock")}${v.duration} minutes</span><span>${icon(locationIcon(v.location))}${e(v.location)}</span></div><div class="event-bottom"><a href="/book/${e(host)}/${e(v.slug)}" data-nav>Find a time ${icon("arrow")}</a></div></article>`).join("") || empty("No meetings available", "This host has not opened any event types for booking.")}</div></section>`,
  );
}
async function publicBooking(host, slug, manage = null) {
  const data = await api(
    `/api/public/${encodeURIComponent(host)}/${encodeURIComponent(slug)}`,
  );
  state.public = {
    ...data,
    hostSlug: host,
    eventSlug: slug,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    date: null,
    start: null,
    manage,
  };
  bookingPicker();
}
function bookingPicker() {
  const p = state.public,
    m = p.month,
    first = new Date(m.getFullYear(), m.getMonth(), 1),
    offset = (first.getDay() + 6) % 7,
    days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate(),
    today = dateKey(new Date(), p.timezone),
    last = dateKey(new Date(Date.now() + p.horizon * 86400000), p.timezone),
    cells = [];
  for (let i = 0; i < offset; i++) cells.push("<span></span>");
  for (let day = 1; day <= days; day++) {
    const key = localDateKey(new Date(m.getFullYear(), m.getMonth(), day)),
      disabled = key < today || key > last;
    cells.push(
      `<button class="cal-day ${disabled ? "" : "available"} ${p.date === key ? "selected" : ""}" ${disabled ? "disabled" : ""} data-action="pick-date" data-date="${key}" aria-label="${e(new Date(m.getFullYear(), m.getMonth(), day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }))}" aria-pressed="${p.date === key}">${day}</button>`,
    );
  }
  publicFrame(
    `<section class="booking-card">${publicInfo()}<div class="booking-main"><h2>${p.manage ? "Choose your new time" : "Find your moment"}</h2><div class="booking-calendar-layout"><div><div class="calendar-head"><span>${m.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span><span><button data-action="public-prev" aria-label="Previous month">${icon("left")}</button><button data-action="public-next" aria-label="Next month">${icon("right")}</button></span></div><div class="calendar-grid">${["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => `<span class="weekday">${d}</span>`).join("")}${cells.join("")}</div><label class="timezone-field">${icon("globe")}<span class="visually-hidden">Your time zone</span><select id="guest-zone">${zoneOptions(p.timezone)}</select></label></div><div><p class="slot-date">${p.date ? e(new Date(p.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })) : "A time that works for you"}</p><div class="slots" id="slot-list"><p class="slot-empty">${p.date ? "Looking for available times…" : "Choose a date to see available times."}</p></div></div></div></div></section>`,
  );
  $("#guest-zone").onchange = (event) => {
    p.timezone = event.target.value;
    p.date = null;
    bookingPicker();
  };
  if (p.date) loadSlots();
}
let slotRequest = 0;
async function loadSlots() {
  const p = state.public,
    id = ++slotRequest,
    date = p.date;
  try {
    const result = await api(
      `/api/public/${encodeURIComponent(p.hostSlug)}/${encodeURIComponent(p.eventSlug)}/slots?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(p.timezone)}`,
    );
    if (id !== slotRequest || state.public !== p || !$("#slot-list")) return;
    $("#slot-list").innerHTML = result.slots.length
      ? result.slots
          .map(
            (start) =>
              `<button class="slot" data-action="pick-slot" data-start="${e(start)}">${publicFmt(start, { hour: "numeric", minute: "2-digit" })}</button>`,
          )
          .join("")
      : '<p class="slot-empty">No available times on this date. Please try another day.</p>';
  } catch (err) {
    if (id === slotRequest && $("#slot-list"))
      $("#slot-list").innerHTML =
        `<p class="slot-empty" role="alert">${e(err.message)}</p>`;
  }
}
function guestForm() {
  const p = state.public;
  publicFrame(
    `<section class="booking-card">${publicInfo()}<div class="booking-main"><button class="back-link" data-action="back-picker">${icon("left")}Choose another time</button><h2>${p.manage ? "Confirm your new appointment" : "A few details, and you’re all set"}</h2><form id="guest-form" class="guest-form">${p.manage ? '<p class="muted small">Your original appointment stays in place until this change is confirmed.</p>' : `<div class="form-group"><label for="guest-name">Your name</label><input id="guest-name" name="name" placeholder="Full name" autocomplete="name" required minlength="2" maxlength="80"></div><div class="form-group"><label for="guest-email">Email address</label><input id="guest-email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required></div><div class="form-group"><label for="guest-notes">Anything you’d like us to know? <span class="muted">(optional)</span></label><textarea id="guest-notes" name="notes" placeholder="Share a little context for your meeting…" maxlength="2000"></textarea><small>Please don’t include Social Security numbers, tax documents, or sensitive financial information.</small></div>`}<button class="btn full" type="submit">${p.manage ? "Confirm new time" : "Confirm appointment"} ${icon("check")}</button><p class="small muted">${p.manage ? "We’ll update your calendar invitation and email your new appointment details." : "By booking, you agree to receive emails about this appointment."}</p></form></div></section>`,
  );
  $("#guest-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, async () => {
      const body = {
          ...Object.fromEntries(new FormData(form)),
          start: p.start,
          timezone: p.timezone,
        },
        path = p.manage
          ? `/api/manage/${p.manage}/reschedule`
          : `/api/public/${encodeURIComponent(p.hostSlug)}/${encodeURIComponent(p.eventSlug)}/bookings`;
      const result = await api(path, { method: "POST", body });
      p.booking = result.booking;
      p.manageUrl = result.manageUrl || `${location.origin}/manage/${p.manage}`;
      bookingConfirmation(!!p.manage);
    });
  };
}
function bookingConfirmation(rescheduled = false) {
  const p = state.public,
    b = p.booking;
  publicFrame(
    `<section class="booking-card">${publicInfo()}<div class="booking-main"><div class="confirmation"><span class="success-icon">${icon("check")}</span><h2>${rescheduled ? "A fresh time, all set." : "You’re on the calendar."}</h2><p>${rescheduled ? "Your appointment has been updated." : "Your appointment is confirmed."} ${state.config.demo ? "This is a local demo booking." : "Look out for a confirmation in your inbox."}</p><div class="confirmation-summary"><h3>${e(b.title)}</h3><p class="booking-detail">${icon("calendar")}${publicFmt(b.start, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p><p class="booking-detail">${icon("clock")}${publicFmt(b.start, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</p><p class="booking-detail">${icon("users")}${e(p.host.name)}</p><p class="booking-detail">${icon(locationIcon(b.location))}${e(b.location)}</p></div><div class="confirmation-actions"><a href="${e(p.manageUrl)}" class="btn secondary" data-nav>Manage appointment</a>${b.meet_url ? `<a class="btn" href="${e(b.meet_url)}" target="_blank" rel="noopener">Join ${b.location === "Zoom" ? "Zoom" : "Google Meet"}</a>` : ""}</div><p class="auth-note muted">Keep your management link private. It lets you reschedule or cancel.</p></div></div></section>`,
  );
}
async function manageView(value) {
  const data = await api(`/api/manage/${encodeURIComponent(value)}`),
    b = data.booking;
  state.managed = { ...data, token: value };
  state.public = {
    host: data.host,
    event: {
      title: b.title,
      duration: Math.round((new Date(b.end) - new Date(b.start)) / 60000),
      description: "",
      location: b.location,
    },
    timezone: b.timezone,
    start: b.start,
  };
  publicFrame(
    `<section class="booking-card">${publicInfo()}<div class="booking-main"><div class="confirmation"><span class="success-icon">${icon(b.status === "cancelled" ? "close" : "check")}</span><h2>${b.status === "cancelled" ? "Appointment cancelled" : "Your appointment"}</h2><p>${b.status === "scheduled" ? "Need to make a change? You’re in the right place." : "This appointment is " + e(b.status) + "."}</p><div class="confirmation-summary"><h3>${e(b.title)}</h3><p class="booking-detail">${icon("calendar")}${publicFmt(b.start, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p><p class="booking-detail">${icon("clock")}${publicFmt(b.start, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</p><p class="booking-detail">${icon("mail")}${e(b.email)}</p></div><div class="confirmation-actions">${b.status === "scheduled" && new Date(b.start) > new Date() ? `${data.event.active ? '<button class="btn" data-action="guest-reschedule">Reschedule</button>' : ""}<button class="btn secondary" data-action="guest-cancel">Cancel appointment</button>` : `<a class="btn secondary" href="/book/${e(data.host.slug)}" data-nav>Book another time</a>`}${b.meet_url && b.status === "scheduled" ? `<a class="btn secondary" href="${e(b.meet_url)}" target="_blank" rel="noopener">Join meeting</a>` : ""}</div></div></div></section>`,
  );
}
let routeGeneration = 0;
async function renderRoute() {
  const generation = ++routeGeneration;
  closeModal();
  document.title = "BMT Calendar · Make time for what matters";
  const path = location.pathname;
  try {
    if (["/login", "/signup", "/forgot", "/reset", "/verify"].includes(path)) {
      authView(path.slice(1));
      return;
    }
    if (path.startsWith("/manage/")) {
      await manageView(path.split("/")[2]);
      return;
    }
    if (path.startsWith("/book/")) {
      const [, , host, slug] = path.split("/");
      if (slug) await publicBooking(host, slug);
      else await hostPage(host);
      return;
    }
    const me = await api("/api/me");
    if (generation !== routeGeneration) return;
    state.user = me.user;
    state.baseUrl = me.baseUrl;
    state.pendingEmails = me.pendingEmails;
    state.pendingBookings = me.pendingBookings;
    if (path === "/app/setup" || !state.user.onboardingComplete) {
      if (path !== "/app/setup") history.replaceState({}, "", "/app/setup");
      onboardingView();
      return;
    }
    const [events, bookings, team] = await Promise.all([
      api("/api/events"),
      api("/api/bookings"),
      api("/api/team"),
    ]);
    if (generation !== routeGeneration) return;
    state.events = events.events;
    state.bookings = bookings.bookings;
    state.team = team.users;
    const pages = {
      "/app": dashboard,
      "/": dashboard,
      "/app/events": eventsView,
      "/app/bookings": bookingsView,
      "/app/availability": availabilityView,
      "/app/calendar": calendarView,
      "/app/team": teamView,
      "/app/settings": settingsView,
    };
    if (!pages[path]) {
      publicFrame(
        empty(
          "This page took a different turn",
          "The page you’re looking for does not exist.",
          '<a class="btn" href="/app" data-nav>Go to your workspace</a>',
        ),
      );
      return;
    }
    pages[path]();
    if (new URLSearchParams(location.search).get("google") === "connected")
      toast("Google Calendar connected. You’re ready to accept bookings.");
    if (new URLSearchParams(location.search).get("google") === "denied")
      toast(
        "Calendar connection was cancelled. You can try again in settings.",
        true,
      );
  } catch (err) {
    if (generation !== routeGeneration) return;
    if (err.status === 401) {
      authView("login");
      return;
    }
    publicFrame(
      empty(
        "We couldn’t open this page",
        err.message,
        '<a class="btn secondary" href="/" data-nav>Back to home</a>',
      ),
    );
  }
}
const actions = {
  "check-calendar": async (button) => {
    button.disabled = true;
    const output = $("#calendar-health");
    if (output)
      output.innerHTML = '<p class="small muted">Checking Google Calendar…</p>';
    try {
      const result = await api("/api/google/status");
      if (output?.isConnected)
        output.innerHTML = `<div class="${result.healthy ? "form-success" : "form-error"}">${e(result.message)}${result.code === "API_DISABLED" ? '<p><a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Open Google Calendar API in Google Cloud</a></p>' : ""}</div>`;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  },
  "finish-setup": async () => {
    state.user = (
      await api("/api/me/onboarding", { method: "POST", body: {} })
    ).user;
    navigate("/app");
  },
  "remove-photo": async () => {
    state.user = (
      await api("/api/me/photo", { method: "DELETE", body: {} })
    ).user;
    toast("Profile photo removed.");
    await renderRoute();
  },
  "toggle-password": (button) => {
    const input = document.getElementById(button.getAttribute("aria-controls"));
    const reveal = input.type === "password";
    const start = input.selectionStart,
      end = input.selectionEnd;
    input.type = reveal ? "text" : "password";
    button.textContent = reveal ? "Hide" : "Show";
    button.setAttribute(
      "aria-label",
      reveal ? "Hide password" : "Show password",
    );
    button.setAttribute("aria-pressed", String(reveal));
    input.focus();
    if (start !== null && end !== null) input.setSelectionRange(start, end);
  },
  "close-modal": () => closeModal(),
  "mobile-menu": () => $(".sidebar").classList.toggle("open"),
  "demo-login": async () => {
    const data = await api("/api/auth/demo", { method: "POST", body: {} });
    state.user = data.user;
    navigate("/app");
  },
  logout: async () => {
    await api("/api/auth/logout", { method: "POST", body: {} });
    state.user = null;
    navigate("/login");
  },
  "copy-page": () => copy(`${state.baseUrl}/book/${state.user.slug}`),
  "copy-event": (el) => {
    const v = state.events.find((v) => v.id === el.dataset.id);
    return copy(`${state.baseUrl}/book/${state.user.slug}/${v.slug}`);
  },
  "new-event": () => eventModal(),
  "edit-event": (el) => eventModal(el.dataset.id),
  "dashboard-tab": (el) => {
    state.tab = el.dataset.tab;
    dashboard();
  },
  "month-prev": () => {
    state.calendarMonth = new Date(
      state.calendarMonth.getFullYear(),
      state.calendarMonth.getMonth() - 1,
      1,
    );
    location.pathname === "/app/calendar" ? calendarView() : dashboard();
  },
  "month-next": () => {
    state.calendarMonth = new Date(
      state.calendarMonth.getFullYear(),
      state.calendarMonth.getMonth() + 1,
      1,
    );
    location.pathname === "/app/calendar" ? calendarView() : dashboard();
  },
  "month-today": () => {
    state.calendarMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    );
    calendarView();
  },
  "booking-details": (el) => bookingDetails(el.dataset.id),
  "cancel-booking": (el) => {
    const b = state.bookings.find((b) => b.id === el.dataset.id);
    confirmDialog(
      "Cancel this appointment?",
      `We’ll notify ${b.name} and remove the appointment from Google Calendar.`,
      async () => {
        await api(`/api/bookings/${b.id}/cancel`, { method: "POST", body: {} });
        await renderRoute();
      },
    );
  },
  invite: () => {
    modal(
      "Bring your team together",
      `<form id="invite-form"><p class="small muted">Send a teammate an invitation to create their own account and booking page.</p><div class="form-group"><label for="invite-email">Work email</label><input type="email" id="invite-email" name="email" placeholder="teammate@company.com" required></div><div class="dialog-foot"><button class="btn" type="submit">${icon("mail")}Send invitation</button></div></form>`,
    );
    $("#invite-form").onsubmit = (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      submit(form, async () => {
        await api("/api/team/invite", {
          method: "POST",
          body: { email: new FormData(form).get("email") },
        });
        closeModal();
        toast("Invitation sent.");
      });
    };
  },
  disconnect: async () => {
    await api("/api/google/disconnect", { method: "POST", body: {} });
    toast("Calendar disconnected.");
    await renderRoute();
  },
  "reconcile-booking": async (el) => {
    const result = await api(`/api/bookings/${el.dataset.id}/reconcile`, {
      method: "POST",
      body: {},
    });
    closeModal();
    toast(result.message);
    await renderRoute();
  },
  "password-reset": async () => {
    await api("/api/auth/forgot", {
      method: "POST",
      body: { email: state.user.email },
    });
    toast("Password reset link sent. Check your inbox.");
  },
  export: () => {
    const fields = [
        "title",
        "name",
        "email",
        "start",
        "end",
        "timezone",
        "status",
        "location",
      ],
      csv = [
        fields.join(","),
        ...state.bookings.map((b) =>
          fields
            .map(
              (f) =>
                '"' +
                String(b[f] || "")
                  .replaceAll('"', '""')
                  .replace(/^[=+@\-\t\r]/, "'$&") +
                '"',
            )
            .join(","),
        ),
      ].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "bmt-appointments.csv";
    a.click();
    URL.revokeObjectURL(url);
  },
  "pick-date": (el) => {
    state.public.date = el.dataset.date;
    state.public.start = null;
    bookingPicker();
  },
  "public-prev": () => {
    const p = state.public;
    p.month = new Date(p.month.getFullYear(), p.month.getMonth() - 1, 1);
    bookingPicker();
  },
  "public-next": () => {
    const p = state.public;
    p.month = new Date(p.month.getFullYear(), p.month.getMonth() + 1, 1);
    bookingPicker();
  },
  "pick-slot": (el) => {
    state.public.start = el.dataset.start;
    guestForm();
  },
  "back-picker": () => {
    state.public.start = null;
    bookingPicker();
  },
  "guest-cancel": () => {
    const m = state.managed;
    confirmDialog(
      "Cancel your appointment?",
      "We’ll notify your host. You can always book a new time later.",
      async () => {
        await api(`/api/manage/${m.token}/cancel`, {
          method: "POST",
          body: {},
        });
        await manageView(m.token);
      },
    );
  },
  "guest-reschedule": () => {
    const m = state.managed;
    return publicBooking(m.host.slug, m.event.slug, m.token);
  },
};
document.addEventListener("click", async (event) => {
  const link = event.target.closest("a[data-nav]");
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    navigate(link.getAttribute("href"));
    return;
  }
  const target = event.target.closest("[data-action]");
  if (target && !target.disabled) {
    try {
      await actions[target.dataset.action]?.(target);
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (event.target.classList.contains("dialog-backdrop")) closeModal();
});
document.addEventListener("keydown", (event) => {
  const dialog = $(".dialog");
  if (!dialog) return;
  if (event.key === "Escape") closeModal();
  if (event.key === "Tab") {
    const focusable = $$(
        "button:not(:disabled),a[href],input:not(:disabled),select,textarea",
        dialog,
      ),
      first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      last.focus();
      event.preventDefault();
    } else if (!event.shiftKey && document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
  }
});
window.addEventListener("popstate", renderRoute);
try {
  state.config = await api("/api/config");
  await renderRoute();
} catch (err) {
  $("#app").innerHTML = errorBox(err.message);
}
