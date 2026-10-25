import * as Sentry from "@sentry/node";
export function initializeTelemetry(): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: false,
    defaultIntegrations: false,
    tracesSampleRate: 0,
    beforeSend: (event) => {
      const safe: Sentry.ErrorEvent = {
        type: undefined,
        level: "error",
        tags: { request_id: event.tags?.request_id ?? "unknown" },
      };
      if (event.event_id) safe.event_id = event.event_id;
      if (event.timestamp) safe.timestamp = event.timestamp;
      safe.exception = {
        values: (event.exception?.values ?? []).map((value) => ({
          type: value.type ?? "Error",
          value: "Service operation failed",
        })),
      };
      return safe;
    },
  });
}
export async function reportFailure(requestId: string, error: unknown): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    scope.setTag("request_id", requestId);
    Sentry.captureException(error instanceof Error ? error : new Error("Service failure"));
  });
  await Sentry.flush(1500);
}
