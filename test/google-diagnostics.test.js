import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarDiagnostic,
  oauthDiagnostic,
  safeOAuthReason,
} from "../google-diagnostics.js";

const info = (reason, metadata = {}, extra = {}) => ({
  error: {
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        domain: "googleapis.com",
        reason,
        metadata,
        ...extra,
      },
    ],
  },
});
const mapped = {
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
for (const [code, reasons] of Object.entries(mapped)) {
  test(`Google diagnostic distinguishes ${code}`, () => {
    for (const reason of reasons) {
      const result = calendarDiagnostic(403, info(reason));
      assert.equal(result.code, code, reason);
      assert.equal(result.diagnostics.reason, reason);
      assert.ok(result.message);
      assert.equal(result.enablementUrl, undefined);
    }
  });
}

test("structured reasons outrank legacy reasons and disabled text never controls classification", () => {
  for (const reason of [
    "CONSUMER_SUSPENDED",
    "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    "SOME_UNKNOWN_REASON",
  ]) {
    const payload = info(reason);
    payload.error.message =
      "Google Calendar API has not been used in project 123 before or it is disabled. SECRET";
    payload.error.errors = [
      { domain: "usageLimits", reason: "accessNotConfigured" },
    ];
    assert.notEqual(calendarDiagnostic(403, payload).code, "API_DISABLED");
  }
  for (const message of [
    "Google Calendar API is disabled.",
    "The consumer project is disabled.",
    "The billing account is disabled.",
    "API has not been used",
  ]) {
    assert.equal(
      calendarDiagnostic(403, { error: { message } }).code,
      "ACCESS_DENIED",
    );
  }
  const legacy = calendarDiagnostic(403, {
    error: {
      errors: [{ domain: "usageLimits", reason: "accessNotConfigured" }],
    },
  });
  assert.equal(legacy.code, "API_DISABLED");
  assert.deepEqual(legacy.diagnostics, {
    reason: "accessNotConfigured",
    domain: "usageLimits",
  });
});

test("diagnostics disclose only validated allowlisted values and construct links from reported Calendar projects", () => {
  for (const consumer of [
    "projects/123456789",
    "projects/bmt-calendar-123",
  ]) {
    const payload = info("SERVICE_DISABLED", {
      service: "calendar-json.googleapis.com",
      consumer,
      access_token: "SECRET",
      client_secret: "SECRET",
      activationUrl: "https://evil.example/SECRET",
      calendar: "person@example.com",
    });
    payload.error.message = "SECRET person@example.com";
    payload.error.details.push({
      "@type": "type.googleapis.com/google.rpc.Help",
      links: [{ url: "https://evil.example/SECRET" }],
    });
    const result = calendarDiagnostic(403, payload);
    assert.deepEqual(Object.keys(result.diagnostics).sort(), [
      "consumer",
      "domain",
      "reason",
      "service",
    ]);
    assert.equal(
      result.enablementUrl,
      `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${consumer.slice(9)}`,
    );
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    assert.ok(!JSON.stringify(result).includes("person@example.com"));
  }
  for (const consumer of [
    "projects/123?redirect=evil",
    "projects/123/secret",
    "projects/<script>",
    "organizations/123",
    "projects/123\n",
    "projects/" + "a".repeat(64),
    { id: 123 },
  ]) {
    const result = calendarDiagnostic(
      403,
      info("SERVICE_DISABLED", {
        consumer,
        service: "calendar-json.googleapis.com",
      }),
    );
    assert.equal(result.diagnostics.consumer, undefined);
    assert.equal(result.enablementUrl, undefined);
  }
  const otherService = calendarDiagnostic(
    403,
    info("SERVICE_DISABLED", {
      consumer: "projects/123",
      service: "storage.googleapis.com",
    }),
  );
  assert.equal(otherService.code, "PROJECT_RESTRICTED");
  assert.equal(otherService.diagnostics.service, undefined);
  assert.equal(otherService.enablementUrl, undefined);
  const unknown = calendarDiagnostic(
    403,
    info("SECRET_REASON", {}, { domain: "evil.example" }),
  );
  assert.deepEqual(unknown.diagnostics, {});
  assert.equal(unknown.code, "ACCESS_DENIED");
  const untyped = calendarDiagnostic(403, {
    error: {
      details: [
        {
          reason: "SERVICE_DISABLED",
          domain: "googleapis.com",
          metadata: {
            consumer: "projects/123",
            service: "calendar-json.googleapis.com",
          },
        },
      ],
    },
  });
  assert.equal(untyped.code, "ACCESS_DENIED");
  assert.deepEqual(untyped.diagnostics, {});
});

test("status fallbacks and malformed errors stay safe without prescribing unnecessary reconnects", () => {
  for (const [status, code] of [
    [401, "RECONNECT_REQUIRED"],
    [403, "ACCESS_DENIED"],
    [404, "CALENDAR_UNAVAILABLE"],
    [429, "RATE_LIMITED"],
    [500, "GOOGLE_UNAVAILABLE"],
    [503, "GOOGLE_UNAVAILABLE"],
  ]) {
    for (const payload of [
      null,
      {},
      { error: "SECRET" },
      {
        error: {
          details: { reason: "SERVICE_DISABLED" },
          errors: "SECRET",
        },
      },
    ]) {
      assert.equal(calendarDiagnostic(status, payload).code, code);
      assert.deepEqual(calendarDiagnostic(status, payload).diagnostics, {});
    }
  }
});

test("OAuth failures distinguish expired authorization, application configuration, quota and transient errors", () => {
  for (const reason of [
    "invalid_client",
    "unauthorized_client",
    "invalid_request",
    "invalid_scope",
  ])
    assert.equal(oauthDiagnostic(400, reason).code, "OAUTH_CONFIGURATION");
  assert.equal(
    oauthDiagnostic(400, "invalid_grant").code,
    "RECONNECT_REQUIRED",
  );
  assert.equal(oauthDiagnostic(403, "access_denied").code, "ACCESS_DENIED");
  assert.equal(oauthDiagnostic(429).code, "RATE_LIMITED");
  for (const reason of [
    "temporarily_unavailable",
    "server_error",
    undefined,
    "SECRET",
  ])
    assert.equal(oauthDiagnostic(503, reason).code, "GOOGLE_UNAVAILABLE");
  assert.equal(safeOAuthReason("SECRET"), undefined);
  assert.deepEqual(oauthDiagnostic(500, "SECRET").diagnostics, {});
  assert.deepEqual(oauthDiagnostic(400, "invalid_grant").diagnostics, {
    reason: "invalid_grant",
    domain: "oauth2.googleapis.com",
  });
});
