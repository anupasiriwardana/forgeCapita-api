/** A repository as created by a provider. */
export interface CreatedRepo {
  id: number;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
}

/** "invited" = invitation sent; "active" = already a collaborator. */
export interface CollaboratorResult {
  status: "invited" | "active";
  /** Invitation id, null when the user was already a collaborator. */
  collaboratorId: number | null;
}

/** Source-hosting provider used to provision a founder's repository. */
export interface RepoProvider {
  userExists(login: string): Promise<boolean>;
  createRepo(name: string): Promise<CreatedRepo>;
  addCollaborator(repoName: string, login: string): Promise<CollaboratorResult>;
  /** Removes the collaborator and cancels a pending invitation; an already absent user counts as success. */
  removeCollaborator(repoName: string, login: string): Promise<void>;
  protectDefaultBranch?(repoName: string, branch: string): Promise<void>;
}
