export type ApplicationStatus = "pending" | "approved" | "rejected";

export interface ApplicationRecord {
  id: string;
  userId: string;
  walletAddress: string;
  projectName: string;
  summary: string;
  websiteUrl: string;
  pitchDeckUrl: string;
  repoUrl: string | null;
  contact: string | null;
  kycDocsUrl: string | null;
  kycNote: string | null;
  status: ApplicationStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  kycVerifiedAt: Date | null;
  kycVerifiedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewOutcome {
  id: string;
  userId: string;
  walletAddress: string;
  previousStatus: ApplicationStatus;
  transitioned: boolean;
  roleChanged: boolean;
}
