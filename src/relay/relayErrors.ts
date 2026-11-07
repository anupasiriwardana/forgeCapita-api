import { AbiCoder } from "ethers";

/** Error with a stable machine code that is safe to show to clients. */
export class RelayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
  }
}

const ERROR_STRING_SELECTOR = "0x08c379a0";
const MAX_MESSAGE_LENGTH = 160;
const TRANSPORT_CODES: ReadonlySet<string> = new Set(["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT"]);

const SELF_PAY_MESSAGE =
  "Gas sponsorship is not available for this action right now. Please submit it from your own wallet.";

interface RevertRule {
  phrase: string;
  status: number;
  code: string;
  message: string;
}

/** Contract revert strings mapped to stable codes; the first matching rule wins. */
const REVERT_RULES: readonly RevertRule[] = [
  { phrase: "Gas ceiling exceeded", status: 409, code: "SELF_PAY", message: SELF_PAY_MESSAGE },
  { phrase: "Already voted", status: 409, code: "ALREADY_VOTED", message: "This wallet has already voted." },
  { phrase: "No voting power", status: 422, code: "NO_VOTING_POWER", message: "Stake tokens before voting." },
  { phrase: "Voting period ended", status: 422, code: "VOTING_ENDED", message: "The voting period has ended." },
  { phrase: "Voting is not open", status: 422, code: "VOTING_NOT_OPEN", message: "Voting is not open." },
  { phrase: "Tokens already claimed", status: 409, code: "ALREADY_CLAIMED", message: "Tokens were already claimed." },
  { phrase: "No investment found", status: 422, code: "NO_INVESTMENT", message: "No investment found for this wallet." },
  { phrase: "Funding phase is still active", status: 422, code: "FUNDING_ACTIVE", message: "Funding is still active." },
  { phrase: "Funding is still active", status: 422, code: "FUNDING_ACTIVE", message: "Funding is still active." },
  { phrase: "Vote signature expired", status: 400, code: "DEADLINE_EXPIRED", message: "The signature has expired." },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function revertData(err: unknown): string | null {
  const record = asRecord(err);
  if (record === null) return null;
  const candidates = [record["data"], asRecord(record["info"])?.["error"], asRecord(record["error"])?.["data"]];
  for (const candidate of candidates) {
    const direct = typeof candidate === "string" ? candidate : asRecord(candidate)?.["data"];
    if (typeof direct === "string" && direct.startsWith(ERROR_STRING_SELECTOR)) return direct;
  }
  return null;
}

/** The revert string of an ethers call error, or null when it carries none. */
export function revertReasonOf(err: unknown): string | null {
  const data = revertData(err);
  if (data !== null) {
    try {
      const [reason] = AbiCoder.defaultAbiCoder().decode(["string"], `0x${data.slice(10)}`);
      if (typeof reason === "string") return reason;
    } catch {
      return null;
    }
  }
  const reason = asRecord(err)?.["reason"];
  return typeof reason === "string" && reason !== "" ? reason : null;
}

/** Removes URLs, long hex blobs and non-printable characters, then caps the length. */
export function sanitizeMessage(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/0x[a-fA-F0-9]{16,}/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function isTransportError(err: unknown): boolean {
  const code = asRecord(err)?.["code"];
  return typeof code === "string" && TRANSPORT_CODES.has(code);
}

/** Maps a failed simulation (eth_call or estimateGas) to a RelayError with a stable code. */
export function mapSimulationError(err: unknown): RelayError {
  if (err instanceof RelayError) return err;
  const reason = revertReasonOf(err);
  if (reason === null) {
    if (isTransportError(err)) return new RelayError(503, "RELAY_UNAVAILABLE", "The relayer is temporarily unavailable.");
    return new RelayError(422, "SIMULATION_FAILED", "The transaction would fail.");
  }
  const rule = REVERT_RULES.find((entry) => reason.includes(entry.phrase));
  if (rule) return new RelayError(rule.status, rule.code, rule.message);
  const text = sanitizeMessage(reason);
  return new RelayError(422, "SIMULATION_FAILED", text === "" ? "The transaction would fail." : text);
}

/** Wraps an RPC read: anything that is not already a RelayError becomes RELAY_UNAVAILABLE. */
export async function withRpc<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(503, "RELAY_UNAVAILABLE", "The relayer is temporarily unavailable.");
  }
}
