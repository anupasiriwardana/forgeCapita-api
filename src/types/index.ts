// ─── Database Row Shapes ────────────────────────────────────────────────────

export interface StartupProfileRow {
  project_id: string;
  name: string;
  description: string;
  logo_url: string | null;
  pitch_deck_url: string | null;
  founder_bio: string | null;
  website_url: string | null;
  created_at: Date;
}

/**
 * Shape of a row returned from the Ponder-managed `project` table
 * joined with `startup_profiles`. Column names are illustrative;
 * expand as the Ponder schema evolves.
 */
export interface UnifiedProjectRow extends Partial<StartupProfileRow> {
  // On-chain columns from the `project` table (Ponder-managed)
  id: string;
  total_funded?: string;
  milestone_count?: number;
  milestones_passed?: number;
  is_active?: boolean;
  created_at?: Date;
}

// ─── Request Body Shapes ─────────────────────────────────────────────────────

export interface CreateProfileBody {
  projectId: string;
  name: string;
  description: string;
  logoUrl?: string;
  pitchDeckUrl?: string;
  founderBio?: string;
  websiteUrl?: string;
}

// ─── Standard API Response ───────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
