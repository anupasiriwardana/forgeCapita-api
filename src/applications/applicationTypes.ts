export type ApplicationStatus = "pending" | "approved" | "rejected";

export interface ApplicationRecord {
  id: string;
  userId: string;
  walletAddress: string;
  resumeUrl: string | null;
  about: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  otherLinks: string[] | null;
  /** Legacy project fields: only present on applications submitted before migration 024. */
  projectName: string | null;
  summary: string | null;
  websiteUrl: string | null;
  pitchDeckUrl: string | null;
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
  /** Approved by the server without review (FOUNDER_APPROVAL=AUTO); reviewer fields are null. */
  autoApproved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubmitOutcome {
  application: ApplicationRecord;
  /** True when an auto-approval promoted the applicant from investor to founder. */
  roleChanged: boolean;
}

export interface ReviewOutcome {
  id: string;
  userId: string;
  walletAddress: string;
  previousStatus: ApplicationStatus;
  transitioned: boolean;
  roleChanged: boolean;
}
