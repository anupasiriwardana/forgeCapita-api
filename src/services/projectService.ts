import {
  findProfileWalletId,
  findProjectById,
  findProjects,
  upsertProfile as saveProfile,
  type WalletBinding,
  type ProjectFilters,
  type ProjectSort,
  type SortOrder,
} from "../repositories/projectRepository.js";
import { AppError } from "../errors.js";
import { AGREEMENT_VERSION } from "../founders/agreement.js";
import { findApprovedWallet, readLaunchChecks } from "../founders/founderRepository.js";
import type { WalletReference } from "../founders/founderRepository.js";
import type {
  AuthUser,
  CreateProfileBody,
  ProfileDto,
  ProfileRow,
  ProjectDto,
  ProjectListDto,
  ProjectRow,
} from "../types/index.js";

export const MAX_LIMIT = 100;
export const MAX_OFFSET = 10000;

export interface ListProjectsParams extends ProjectFilters {
  limit: number;
  offset: number;
  sort: ProjectSort;
  order: SortOrder;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toProfileDto(row: ProfileRow): ProfileDto {
  return {
    name: row.name,
    description: row.description,
    logoUrl: row.logo_url,
    pitchDeckUrl: row.pitch_deck_url,
    founderBio: row.founder_bio,
    websiteUrl: row.website_url,
    category: row.category,
    updatedAt: row.updated_at.toISOString(),
  };
}

function profileOf(row: ProjectRow): ProfileDto | null {
  if (
    row.profile_project_id === null ||
    row.profile_name === null ||
    row.profile_description === null ||
    row.profile_updated_at === null
  ) {
    return null;
  }
  return toProfileDto({
    name: row.profile_name,
    description: row.profile_description,
    logo_url: row.profile_logo_url,
    pitch_deck_url: row.profile_pitch_deck_url,
    founder_bio: row.profile_founder_bio,
    website_url: row.profile_website_url,
    category: row.profile_category,
    updated_at: row.profile_updated_at,
  });
}

/** Explicit mapping: bigint-backed columns stay decimal strings, nothing is spread. */
export function toProjectDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    chainId: row.chain_id,
    escrowAddress: row.escrow_address,
    tokenAddress: row.token_address,
    distributorAddress: row.distributor_address,
    developer: row.developer,
    fundingGoal: row.funding_goal,
    totalRaised: row.total_raised,
    fundingDeadline: row.funding_deadline,
    closeGrace: row.close_grace,
    refundWindow: row.refund_window,
    votingPeriod: row.voting_period,
    fundingClosedAt: row.funding_closed_at,
    platformFee: row.platform_fee,
    cancelledAt: row.cancelled_at,
    shutdownAt: row.shutdown_at,
    totalStaked: row.total_staked,
    createdAt: row.created_at,
    isFundingActive: row.is_funding_active,
    state: row.state,
    failedMilestoneIndex: row.failed_milestone_index,
    isInvalidated: row.is_invalidated,
    currentMilestoneIndex: row.current_milestone_index,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    profile: profileOf(row),
  };
}

export async function listProjects(params: ListProjectsParams): Promise<ProjectListDto> {
  const { limit, offset, sort, order, ...filters } = params;
  const safeLimit = clamp(limit, 1, MAX_LIMIT);
  const safeOffset = clamp(offset, 0, MAX_OFFSET);

  const { rows, total } = await findProjects(filters, sort, order, safeLimit, safeOffset);
  return { items: rows.map(toProjectDto), total, limit: safeLimit, offset: safeOffset };
}

export async function getProjectById(id: string): Promise<ProjectDto | null> {
  const row = await findProjectById(id);
  return row ? toProjectDto(row) : null;
}

const PG_UNIQUE_VIOLATION = "23505";
const PG_FK_VIOLATION = "23503";
const WALLET_BINDING_INDEX = "startup_profiles_founder_wallet_uidx";

function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

function pgConstraint(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "constraint" in err && typeof err.constraint === "string"
    ? err.constraint
    : undefined;
}

function isStaff(user: AuthUser): boolean {
  return user.role === "staff" || user.role === "admin";
}

function walletReferenceOf(body: CreateProfileBody): WalletReference | null {
  if (body.shadowWalletId !== undefined) return { id: body.shadowWalletId };
  if (body.shadowWallet !== undefined) return { address: body.shadowWallet.toLowerCase() };
  return null;
}

/** One generic error for unknown, unapproved and foreign wallets so nothing leaks. */
async function resolveWallet(ref: WalletReference, user: AuthUser): Promise<WalletBinding> {
  const wallet = await findApprovedWallet(ref);
  if (!wallet || (!isStaff(user) && wallet.userId !== user.id)) {
    throw new AppError(400, "Shadow wallet not available");
  }
  return { walletId: wallet.id, address: wallet.address };
}

/** Application and agreement are always required; a free approved wallet only for a first binding. */
async function assertFounderEligible(user: AuthUser, hasBinding: boolean): Promise<void> {
  const checks = await readLaunchChecks(user.id, AGREEMENT_VERSION);
  if (!checks.applicationApproved) throw new AppError(403, "Founder application is not approved");
  if (!checks.agreementAccepted) throw new AppError(403, "Founder agreement is not accepted");
  if (!hasBinding && !checks.shadowWalletAvailable) {
    throw new AppError(403, "No approved shadow wallet is available");
  }
}

/** Resolves the wallet to bind (or null to keep the current binding) and enforces the founder rules. */
async function prepareBinding(body: CreateProfileBody, user: AuthUser): Promise<WalletBinding | null> {
  const ref = walletReferenceOf(body);
  if (isStaff(user)) return ref ? resolveWallet(ref, user) : null;

  const currentWalletId = await findProfileWalletId(body.projectId);
  await assertFounderEligible(user, currentWalletId !== null);
  if (!ref) {
    if (currentWalletId === null) throw new AppError(400, "shadowWalletId or shadowWallet is required");
    return null;
  }
  const binding = await resolveWallet(ref, user);
  if (currentWalletId !== null && currentWalletId !== binding.walletId) {
    throw new AppError(409, "Project already has a shadow wallet");
  }
  return binding;
}

/**
 * Staff and admin may write any profile and change its wallet binding; anyone else must be the
 * indexed project's developer, eligible, and may bind one of their own approved wallets once.
 * The wallet is never returned.
 */
export async function upsertProfile(
  body: CreateProfileBody,
  user: AuthUser,
  ip: string | null = null
): Promise<ProfileDto> {
  if (!isStaff(user)) {
    const project = await findProjectById(body.projectId);
    if (!project) throw new AppError(404, "Project not found.");
    if (project.developer.toLowerCase() !== user.address.toLowerCase()) {
      throw new AppError(403, "Forbidden");
    }
  }
  const binding = await prepareBinding(body, user);
  try {
    return toProfileDto(await saveProfile(body, binding, { userId: user.id, ip }));
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === WALLET_BINDING_INDEX) {
      throw new AppError(409, "Shadow wallet is already bound to a project");
    }
    if (pgCode(err) === PG_FK_VIOLATION) throw new AppError(400, "Shadow wallet not available");
    throw err;
  }
}
