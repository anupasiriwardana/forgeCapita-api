import type { jest } from "@jest/globals";

export const SESSION_COOKIE_HEADER = `fc_session=${"a".repeat(43)}`;
export const ALLOWED_ORIGIN = "http://localhost:3000";

type MockFn = ReturnType<typeof jest.fn>;

const SESSION_SELECT = "FROM app.sessions s";
const SESSION_TOUCH = "UPDATE app.sessions";

function isSessionSql(sql: unknown): boolean {
  const text = String(sql);
  return text.includes(SESSION_SELECT) || text.includes(SESSION_TOUCH);
}

/**
 * Makes the mocked pool answer session lookups for a signed-in user, and hand out
 * `responses` (values or Errors) in order to every other query.
 * Returns a function listing the non-session query calls.
 */
export function mockSession(
  mockQuery: MockFn,
  role: string,
  address: string,
  ...responses: unknown[]
): () => unknown[][] {
  const queue = [...responses];
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (String(sql).includes(SESSION_SELECT)) {
      return {
        rows: [
          {
            user_id: "11111111-1111-1111-1111-111111111111",
            wallet_address: address.toLowerCase(),
            role,
            last_seen_at: new Date(),
            expires_at: new Date(Date.now() + 86_400_000),
          },
        ],
        rowCount: 1,
      };
    }
    if (isSessionSql(sql)) return { rows: [], rowCount: 1 };
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { rows: [], rowCount: 0 };
  });
  return () => mockQuery.mock.calls.filter((call) => !isSessionSql(call[0])) as unknown[][];
}
