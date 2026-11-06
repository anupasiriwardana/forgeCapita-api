// ─── Database Row Shapes ────────────────────────────────────────────────────

/** Public profile columns of app.startup_profiles (never kyc_verified or shadow_wallet). */
export interface ProfileRow {
  name: string;
  description: string;
  logo_url: string | null;
  pitch_deck_url: string | null;
  founder_bio: string | null;
  website_url: string | null;
  category: string | null;
  updated_at: Date;
}

/**
 * Selected columns of the Ponder `project` table joined with the profile.
 * Ponder bigint columns are numeric, which pg returns as decimal strings.
 */
export interface ProjectRow {
  id: string;
  chain_id: number;
  escrow_address: string;
  token_address: string;
  distributor_address: string;
  developer: string;
  funding_goal: string;
  total_raised: string;
  funding_deadline: string;
  close_grace: string;
  refund_window: string;
  voting_period: string;
  funding_closed_at: string | null;
  platform_fee: string | null;
  cancelled_at: string | null;
  shutdown_at: string | null;
  total_staked: string;
  created_at: string;
  is_funding_active: boolean;
  state: string;
  failed_milestone_index: number | null;
  is_invalidated: boolean;
  current_milestone_index: number;
  token_name: string;
  token_symbol: string;
  /** null when the LEFT JOIN found no profile. */
  profile_project_id: string | null;
  profile_name: string | null;
  profile_description: string | null;
  profile_logo_url: string | null;
  profile_pitch_deck_url: string | null;
  profile_founder_bio: string | null;
  profile_website_url: string | null;
  profile_category: string | null;
  profile_updated_at: Date | null;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export type Role = "investor" | "founder" | "staff" | "admin";

export interface AuthUser {
  id: string;
  /** Lowercase wallet address. */
  address: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ─── Request Body Shapes ─────────────────────────────────────────────────────

export interface CreateProfileBody {
  /** Composite id `<chainId>:<escrow lowercase>`. */
  projectId: string;
  name: string;
  description: string;
  logoUrl?: string | undefined;
  pitchDeckUrl?: string | undefined;
  founderBio?: string | undefined;
  websiteUrl?: string | undefined;
  category?: string | undefined;
  shadowWallet?: string | undefined;
}

// ─── Public Response Shapes ──────────────────────────────────────────────────

export interface ProfileDto {
  name: string;
  description: string;
  logoUrl: string | null;
  pitchDeckUrl: string | null;
  founderBio: string | null;
  websiteUrl: string | null;
  category: string | null;
  updatedAt: string;
}

export interface ProjectDto {
  id: string;
  chainId: number;
  escrowAddress: string;
  tokenAddress: string;
  distributorAddress: string;
  developer: string;
  fundingGoal: string;
  totalRaised: string;
  fundingDeadline: string;
  closeGrace: string;
  refundWindow: string;
  votingPeriod: string;
  fundingClosedAt: string | null;
  platformFee: string | null;
  cancelledAt: string | null;
  shutdownAt: string | null;
  totalStaked: string;
  createdAt: string;
  isFundingActive: boolean;
  state: string;
  failedMilestoneIndex: number | null;
  isInvalidated: boolean;
  currentMilestoneIndex: number;
  tokenName: string;
  tokenSymbol: string;
  profile: ProfileDto | null;
}

export interface ProjectListDto {
  items: ProjectDto[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Standard API Response ───────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
