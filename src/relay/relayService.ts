import { createHash } from "node:crypto";
import { Signature, verifyTypedData } from "ethers";
import { config } from "../config/env.js";
import { AppError } from "../errors.js";
import type { StakeBody, VoteBody } from "../schemas/relaySchemas.js";
import type { AuthUser } from "../types/index.js";
import {
  distributorInterface,
  escrowInterface,
  getRelayChain,
  readView,
  tokenInterface,
  type RelayChain,
} from "./chains.js";
import { RelayError, mapSimulationError, withRpc } from "./relayErrors.js";
import {
  countChainSince24h,
  countUserSince24h,
  findActiveByIdemKey,
  findOwnRequest,
  findRelayProject,
  insertRelayRequest,
  listOwnRequests,
  type RelayKind,
  type RelayProject,
  type RelayRecord,
} from "./relayRepository.js";

const REQUEST_TTL_MS = 30 * 60 * 1000;
const MIN_DEADLINE_MARGIN_S = 30;
const MAX_DEADLINE_AHEAD_S = 24 * 60 * 60;

export interface IntakeResult {
  record: RelayRecord;
  /** false for an idempotent repeat of an existing request. */
  created: boolean;
}

interface Context {
  project: RelayProject;
  chain: RelayChain;
}

interface Plan {
  kind: RelayKind;
  context: Context;
  user: AuthUser;
  to: string;
  data: string;
  payload: Record<string, unknown>;
  idemKey: string;
  expiresAt: Date;
}

const disabled = (): RelayError =>
  new RelayError(503, "RELAY_DISABLED", "Gasless transactions are not available for this chain.");

/** Chain id of a validated composite project id (`<chainId>:<escrow>`). */
function chainIdOf(projectId: string): number {
  return Number(projectId.split(":")[0]);
}

async function loadContext(projectId: string): Promise<Context> {
  const chain = getRelayChain(chainIdOf(projectId));
  if (chain === undefined) throw disabled();
  const project = await findRelayProject(projectId);
  if (project === null) throw new AppError(404, "Project not found");
  return { project, chain };
}

/** Intake guards: relayer balance, per-user and per-chain daily quotas, current gas price. */
async function checkGuards(chain: RelayChain, user: AuthUser): Promise<void> {
  const balance = await withRpc(() => chain.provider.getBalance(chain.sender.address));
  if (balance < chain.minBalanceWei) {
    throw new RelayError(503, "RELAYER_LOW_BALANCE", "Gasless transactions are temporarily unavailable.");
  }
  if ((await countUserSince24h(user.id)) >= config.RELAYER_USER_DAILY_LIMIT) {
    throw new RelayError(429, "USER_DAILY_LIMIT", "Daily gasless transaction limit reached.");
  }
  if ((await countChainSince24h(chain.chainId)) >= config.RELAYER_CHAIN_DAILY_LIMIT) {
    throw new RelayError(429, "CHAIN_DAILY_LIMIT", "Daily gasless capacity for this chain is exhausted.");
  }
  const fees = await withRpc(() => chain.provider.getFeeData());
  const gasPrice = fees.gasPrice ?? fees.maxFeePerGas;
  if (gasPrice === null) throw new RelayError(503, "RELAY_UNAVAILABLE", "The relayer is temporarily unavailable.");
  if (gasPrice > chain.maxGasPriceWei) {
    throw new RelayError(503, "GAS_TOO_HIGH", "Network fees are too high right now. Please try again later.");
  }
}

/** Deadline must be in the future (with a margin) and at most one day ahead. */
function checkDeadline(deadline: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (deadline <= now + MIN_DEADLINE_MARGIN_S) {
    throw new RelayError(400, "DEADLINE_EXPIRED", "The signature deadline has passed or is too close.");
  }
  if (deadline > now + MAX_DEADLINE_AHEAD_S) {
    throw new RelayError(400, "DEADLINE_TOO_FAR", "The signature deadline is too far in the future.");
  }
}

function expiryFor(deadline?: number): Date {
  const ttl = Date.now() + REQUEST_TTL_MS;
  return new Date(deadline === undefined ? ttl : Math.min(ttl, deadline * 1000));
}

/** Dry-runs the call as the relayer (so relayer-only gas booking and ceilings apply); a revert never reaches the queue. */
export async function simulate(chain: RelayChain, to: string, data: string): Promise<bigint> {
  const tx = { from: chain.sender.address, to, data };
  try {
    await chain.provider.call(tx);
    return await chain.provider.estimateGas(tx);
  } catch (err) {
    throw mapSimulationError(err);
  }
}

async function existingRequest(idemKey: string): Promise<IntakeResult | null> {
  const record = await findActiveByIdemKey(idemKey);
  return record === null ? null : { record, created: false };
}

async function enqueue(plan: Plan): Promise<IntakeResult> {
  const { chain, project } = plan.context;
  await simulate(chain, plan.to, plan.data);
  const record = await insertRelayRequest({
    kind: plan.kind,
    chainId: chain.chainId,
    projectId: project.id,
    userId: plan.user.id,
    account: plan.user.address,
    payload: plan.payload,
    args: { to: plan.to, data: plan.data },
    idemKey: plan.idemKey,
    expiresAt: plan.expiresAt,
  });
  if (record !== null) return { record, created: true };
  const existing = await existingRequest(plan.idemKey);
  if (existing === null) throw new RelayError(409, "RELAY_CONFLICT", "Please retry the request.");
  return existing;
}

export async function submitClaim(user: AuthUser, projectId: string): Promise<IntakeResult> {
  const context = await loadContext(projectId);
  const idemKey = `claim:${context.chain.chainId}:${context.project.escrowAddress}:${user.address}`;
  const existing = await existingRequest(idemKey);
  if (existing) return existing;
  await checkGuards(context.chain, user);
  return enqueue({
    kind: "claim",
    context,
    user,
    to: context.project.escrowAddress,
    data: escrowInterface.encodeFunctionData("claimTokensFor", [user.address]),
    payload: { account: user.address },
    idemKey,
    expiresAt: expiryFor(),
  });
}

const VOTE_TYPES = {
  Vote: [
    { name: "voter", type: "address" },
    { name: "milestoneIndex", type: "uint256" },
    { name: "support", type: "bool" },
    { name: "deadline", type: "uint256" },
  ],
};

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/** Recovers the signer; a malformed signature is a 400, a different signer a 403. */
function assertSigner(recover: () => string, expected: string): void {
  let signer: string;
  try {
    signer = recover();
  } catch {
    throw new RelayError(400, "INVALID_SIGNATURE", "Invalid signature.");
  }
  if (signer.toLowerCase() !== expected) {
    throw new RelayError(403, "SIGNATURE_MISMATCH", "The signature does not belong to the signed-in wallet.");
  }
}

export async function submitVote(user: AuthUser, body: VoteBody): Promise<IntakeResult> {
  const context = await loadContext(body.projectId);
  const { chain, project } = context;
  checkDeadline(body.deadline);
  const [index] = await withRpc(() => readView(chain.provider, escrowInterface, project.escrowAddress, "currentMilestoneIndex"));
  if (typeof index !== "bigint") throw new RelayError(503, "RELAY_UNAVAILABLE", "The relayer is temporarily unavailable.");

  const idemKey = `vote:${chain.chainId}:${project.escrowAddress}:${user.address}:${index.toString()}`;
  const existing = await existingRequest(idemKey);
  if (existing) return existing;
  await checkGuards(chain, user);

  assertSigner(
    () =>
      verifyTypedData(
        { name: "ForgeCapita MilestoneEscrow", version: "1", chainId: chain.chainId, verifyingContract: project.escrowAddress },
        VOTE_TYPES,
        { voter: user.address, milestoneIndex: index, support: body.support, deadline: body.deadline },
        body.signature
      ),
    user.address
  );

  return enqueue({
    kind: "vote",
    context,
    user,
    to: project.escrowAddress,
    data: escrowInterface.encodeFunctionData("voteBySig", [user.address, body.support, body.deadline, body.signature]),
    payload: { voter: user.address, support: body.support, deadline: body.deadline, milestoneIndex: index.toString() },
    idemKey,
    expiresAt: expiryFor(body.deadline),
  });
}

export async function submitStake(user: AuthUser, body: StakeBody): Promise<IntakeResult> {
  const context = await loadContext(body.projectId);
  const { chain, project } = context;
  checkDeadline(body.deadline);

  const idemKey = createHash("sha256")
    .update([chain.chainId, project.tokenAddress, user.address, body.amount.toString(), body.deadline, body.signature.toLowerCase()].join("|"))
    .digest("hex");
  const existing = await existingRequest(idemKey);
  if (existing) return existing;
  await checkGuards(chain, user);

  const [balance, nonce, tokenName] = await withRpc(async () => [
    (await readView(chain.provider, tokenInterface, project.tokenAddress, "balanceOf", [user.address]))[0],
    (await readView(chain.provider, tokenInterface, project.tokenAddress, "nonces", [user.address]))[0],
    (await readView(chain.provider, tokenInterface, project.tokenAddress, "name"))[0],
  ]);
  if (typeof balance !== "bigint" || typeof nonce !== "bigint" || typeof tokenName !== "string") {
    throw new RelayError(503, "RELAY_UNAVAILABLE", "The relayer is temporarily unavailable.");
  }
  if (balance < body.amount) {
    throw new RelayError(422, "INSUFFICIENT_BALANCE", "Token balance is lower than the amount to stake.");
  }

  assertSigner(
    () =>
      verifyTypedData(
        { name: tokenName, version: "1", chainId: chain.chainId, verifyingContract: project.tokenAddress },
        PERMIT_TYPES,
        { owner: user.address, spender: project.distributorAddress, value: body.amount, nonce, deadline: body.deadline },
        body.signature
      ),
    user.address
  );

  const { v, r, s } = Signature.from(body.signature);
  return enqueue({
    kind: "stake",
    context,
    user,
    to: project.distributorAddress,
    data: distributorInterface.encodeFunctionData("stakeWithPermit", [user.address, body.amount, body.deadline, v, r, s]),
    payload: { owner: user.address, amount: body.amount.toString(), deadline: body.deadline },
    idemKey,
    expiresAt: expiryFor(body.deadline),
  });
}

export async function getOwnRequest(id: string, user: AuthUser): Promise<RelayRecord> {
  const record = await findOwnRequest(id, user.id);
  if (record === null) throw new AppError(404, "Not found");
  return record;
}

export function listRequests(user: AuthUser, limit: number): Promise<RelayRecord[]> {
  return listOwnRequests(user.id, limit);
}
