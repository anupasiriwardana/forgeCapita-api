import { pool } from "../db/pool.js";
import {
  findIndexedProject,
  listDeveloperChanges,
  type DeveloperChangeRow,
  type Db,
  type TakeoverCase,
} from "./takeoverRepository.js";

/*
 * On-chain execution of a takeover is DERIVED at read time from the indexed developer_change rows;
 * the case itself stays 'closed'. The vote is advisory, so any closed result may be executed.
 */

export type ExecutionState = "none" | "proposed" | "accepted" | "unknown";

export interface ExecutionView {
  state: ExecutionState;
  proposedTxHash: string | null;
  proposedBlock: string | null;
  proposedAt: string | null;
  proposedBy: string | null;
  acceptedTxHash: string | null;
  acceptedBlock: string | null;
  acceptedAt: string | null;
  /** A nomination of the candidate is on chain and nobody replaced it or accepted it yet. */
  pendingForCandidate: boolean;
  canPropose: boolean;
  canProposeReason: string | null;
}

/** Reduced view for the candidate's own cases. */
export interface CandidateExecutionView {
  state: ExecutionState;
  proposedTxHash: string | null;
  pendingForCandidate: boolean;
}

const EMPTY: ExecutionView = {
  state: "none",
  proposedTxHash: null,
  proposedBlock: null,
  proposedAt: null,
  proposedBy: null,
  acceptedTxHash: null,
  acceptedBlock: null,
  acceptedAt: null,
  pendingForCandidate: false,
  canPropose: false,
  canProposeReason: null,
};

function isoOfSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/** Pure: execution facts of one case from the project's change rows (newest first) and the close time. */
export function deriveExecution(
  rows: DeveloperChangeRow[],
  candidateWallet: string,
  closedAt: Date | null
): ExecutionView {
  if (closedAt === null) return { ...EMPTY };
  const since = BigInt(Math.floor(closedAt.getTime() / 1000));
  const candidate = candidateWallet.toLowerCase();
  const recent = rows.filter((row) => row.timestamp >= since);
  const proposed = recent.find((row) => row.kind === "proposed" && row.newDeveloper === candidate);
  if (!proposed) return { ...EMPTY };
  const accepted = [...recent]
    .reverse()
    .find((row) => row.kind === "accepted" && row.newDeveloper === candidate && row.timestamp >= proposed.timestamp);
  const base: ExecutionView = {
    ...EMPTY,
    proposedTxHash: proposed.txHash,
    proposedBlock: proposed.blockNumber,
    proposedAt: isoOfSeconds(proposed.timestamp),
    proposedBy: proposed.txFrom,
  };
  if (accepted) {
    return {
      ...base,
      state: "accepted",
      acceptedTxHash: accepted.txHash,
      acceptedBlock: accepted.blockNumber,
      acceptedAt: isoOfSeconds(accepted.timestamp),
    };
  }
  const superseded = recent.some(
    (row) => row.kind === "proposed" && row.newDeveloper !== candidate && row.timestamp > proposed.timestamp
  );
  return { ...base, state: "proposed", pendingForCandidate: !superseded };
}

/** Pure: why a nomination cannot be sent now, or null when it can. */
export function proposeBlocker(status: TakeoverCase["status"], candidateIsDeveloper: boolean): string | null {
  if (status !== "closed") return "The case must be closed before the developer can be changed on chain";
  if (candidateIsDeveloper) return "The candidate is already the project developer";
  return null;
}

/** Staff view; an indexer or database read failure yields state 'unknown' instead of an error. */
export async function loadExecution(c: TakeoverCase, db: Db = pool): Promise<ExecutionView> {
  try {
    const project = await findIndexedProject(db, c.projectId);
    if (!project) {
      return { ...EMPTY, state: "unknown", canProposeReason: "Project not found in the indexer" };
    }
    const rows = c.status === "closed" ? await listDeveloperChanges(db, c.projectId) : [];
    const view = deriveExecution(rows, c.candidateWallet, c.closedAt);
    const reason = proposeBlocker(c.status, project.developer === c.candidateWallet.toLowerCase());
    return { ...view, canPropose: reason === null, canProposeReason: reason };
  } catch {
    return { ...EMPTY, state: "unknown", canProposeReason: "The indexer could not be read; try again shortly" };
  }
}

export async function loadCandidateExecution(c: TakeoverCase, db: Db = pool): Promise<CandidateExecutionView> {
  if (c.status !== "closed") return { state: "none", proposedTxHash: null, pendingForCandidate: false };
  try {
    const view = deriveExecution(await listDeveloperChanges(db, c.projectId), c.candidateWallet, c.closedAt);
    return { state: view.state, proposedTxHash: view.proposedTxHash, pendingForCandidate: view.pendingForCandidate };
  } catch {
    return { state: "unknown", proposedTxHash: null, pendingForCandidate: false };
  }
}
