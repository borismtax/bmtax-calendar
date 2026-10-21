// Only these provider identifiers may reach an authenticated host. Never return
// provider messages, arbitrary metadata, Help links, tokens or calendar contents.
const groups = {
  API_DISABLED: ["SERVICE_DISABLED", "API_DISABLED", "accessNotConfigured"],
  RATE_LIMITED: [
    "RATE_LIMIT_EXCEEDED",
    "QUOTA_EXCEEDED",
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "quotaExceeded",
    "dailyLimitExceeded",
  ],
  MISSING_PERMISSIONS: [
    "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    "insufficientPermissions",
  ],
  RECONNECT_REQUIRED: [
    "ACCESS_TOKEN_EXPIRED",
    "ACCESS_TOKEN_INVALID",
    "authError",
    "invalidCredentials",
  ],
  PROJECT_RESTRICTED: [
    "CONSUMER_SUSPENDED",
    "CONSUMER_INVALID",
    "BILLING_DISABLED",
  ],
  POLICY_RESTRICTED: [
    "SECURITY_POLICY_VIOLATED",
    "RESOURCE_USAGE_RESTRICTION_VIOLATED",
    "ORG_RESTRICTION_VIOLATION",
    "SERVICE_BLOCKED",
    "domainPolicy",
  ],
  ACCESS_DENIED: [
    "forbidden",
    "forbiddenForNonOrganizer",
    "PERMISSION_DENIED",
  ],
  CALENDAR_UNAVAILABLE: ["notFound", "NOT_FOUND"],
  GOOGLE_UNAVAILABLE: [
    "backendError",
    "internalError",
    "INTERNAL",
    "UNAVAILABLE",
  ],
};
const reasonCodes = new Map(
  Object.entries(groups).flatMap(([code, reasons]) =>
    reasons.map((reason) => [reason, code]),
  ),
);
const domains = new Set([
  "googleapis.com",
  "calendar-json.googleapis.com",
  "calendar",
  "global",
  "usageLimits",
]);
const consumerPattern =
  /^projects\/(?:[0-9]{1,20}|[a-z][a-z0-9-]{4,28}[a-z0-9])$/;
const messages = {
  API_DISABLED:
    "Google reports that Calendar API is disabled for the requesting project. Check the reported project before enabling the API. If it was just enabled, allow a few minutes and check again.",
  RATE_LIMITED:
    "Google Calendar's request or usage limit was reached. Wait and try again; the project administrator can review quotas if it continues. Reconnecting is not required for a quota error.",
  MISSING_PERMISSIONS:
    "Google reports missing Calendar permissions. Reconnect the same Google account in Settings and approve both Calendar permissions.",
  RECONNECT_REQUIRED:
    "Google could not validate the calendar authorization. Reconnect the same Google account in Settings.",
  PROJECT_RESTRICTED:
    "Google reports a restriction on the requesting Cloud project. Ask its administrator to review the project's status and restrictions; enabling Calendar API alone may not resolve this.",
  POLICY_RESTRICTED:
    "Google policy blocks this calendar request. Ask your Google Workspace or Cloud administrator to review the access policy.",
  ACCESS_DENIED:
    "Google denied access to this calendar. Check the connected account and its calendar permissions. This response does not establish that Calendar API is disabled.",
  CALENDAR_UNAVAILABLE:
    "The connected calendar was not found or is not accessible. Check the connected account and calendar access.",
  GOOGLE_UNAVAILABLE:
    "Google Calendar could not complete the check. Try again shortly; this response does not establish that reconnecting is needed.",
  OAUTH_CONFIGURATION:
    "Google rejected the application's OAuth configuration. The administrator should check the deployed OAuth client configuration before asking users to reconnect.",
};
export const publicCalendarError =
  "Google Calendar could not confirm availability. Please try again later or contact the host.";

export function calendarDiagnostic(status, payload) {
  const error = payload?.error;
  const details = Array.isArray(error?.details) ? error.details : [];
  const structured = details.filter(
    (d) => d?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
  );
  // A structured reason takes precedence even when unknown. A legacy reason or
  // free-text message must not override a different structured failure.
  const source =
    structured.find((d) => domains.has(d.domain)) ||
    (structured.length
      ? null
      : Array.isArray(error?.errors)
        ? error.errors.find((d) => domains.has(d?.domain))
        : null);
  const reason = source?.reason;
  let code =
    reasonCodes.get(reason) ||
    (status === 429
      ? "RATE_LIMITED"
      : status === 401
        ? "RECONNECT_REQUIRED"
        : status === 403
          ? "ACCESS_DENIED"
          : status === 404
            ? "CALENDAR_UNAVAILABLE"
            : "GOOGLE_UNAVAILABLE");
  const diagnostics = {};
  if (reasonCodes.has(reason)) diagnostics.reason = reason;
  if (domains.has(source?.domain)) diagnostics.domain = source.domain;
  // Metadata is only meaningful on a typed, trusted ErrorInfo, not a legacy
  // error entry or arbitrary object that happens to contain a reason.
  if (structured.includes(source)) {
    if (source.metadata?.service === "calendar-json.googleapis.com")
      diagnostics.service = source.metadata.service;
    if (
      typeof source.metadata?.consumer === "string" &&
      consumerPattern.test(source.metadata.consumer)
    )
      diagnostics.consumer = source.metadata.consumer;
    if (
      code === "API_DISABLED" &&
      source.metadata?.service &&
      !diagnostics.service
    )
      code = "PROJECT_RESTRICTED";
  }
  const enablementUrl =
    code === "API_DISABLED" && diagnostics.service && diagnostics.consumer
      ? `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${encodeURIComponent(diagnostics.consumer.slice("projects/".length))}`
      : undefined;
  return {
    code,
    message: messages[code],
    diagnostics,
    ...(enablementUrl ? { enablementUrl } : {}),
  };
}

const oauthReasons = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
  "invalid_scope",
  "access_denied",
  "temporarily_unavailable",
  "server_error",
]);
export const safeOAuthReason = (reason) =>
  oauthReasons.has(reason) ? reason : undefined;
export function oauthDiagnostic(status, reason) {
  const code =
    reason === "invalid_grant"
      ? "RECONNECT_REQUIRED"
      : [
            "invalid_client",
            "unauthorized_client",
            "invalid_request",
            "invalid_scope",
          ].includes(reason)
        ? "OAUTH_CONFIGURATION"
        : reason === "access_denied"
          ? "ACCESS_DENIED"
          : status === 429
            ? "RATE_LIMITED"
            : "GOOGLE_UNAVAILABLE";
  return {
    code,
    message: messages[code],
    diagnostics: safeOAuthReason(reason)
      ? { reason, domain: "oauth2.googleapis.com" }
      : {},
  };
}
