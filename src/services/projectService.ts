import {
  findProjectById,
  findProjects,
  upsertProfile as saveProfile,
  type ProjectFilters,
  type ProjectSort,
  type SortOrder,
} from "../repositories/projectRepository.js";
import { AppError } from "../errors.js";
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

/**
 * Staff and admin may write any profile; anyone else must be the indexed project's
 * developer. shadowWallet is stored but never returned (TODO API-38).
 */
export async function upsertProfile(
  body: CreateProfileBody,
  user: AuthUser
): Promise<ProfileDto> {
  if (user.role !== "staff" && user.role !== "admin") {
    const project = await findProjectById(body.projectId);
    if (!project) throw new AppError(404, "Project not found.");
    if (project.developer.toLowerCase() !== user.address.toLowerCase()) {
      throw new AppError(403, "Forbidden");
    }
  }
  return toProfileDto(await saveProfile(body));
}
