const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "08006", // connection_failure
  "08003", // connection_does_not_exist
]);

const TRANSIENT_MESSAGES: readonly string[] = [
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
];

function isTransientSingle(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_MESSAGES.some((m) => err.message.includes(m));
}

/**
 * True only for transient network / database-connection failures that the process can
 * outlive (the pool reconnects on the next query). Everything else is a real bug.
 * Dual-stack connect failures arrive as an AggregateError, so one level is inspected.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (isTransientSingle(err)) return true;
  if (err instanceof AggregateError) return err.errors.some(isTransientSingle);
  return false;
}
