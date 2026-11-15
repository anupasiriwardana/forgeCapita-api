import { config } from "../config/env.js";
import { logger } from "../logger.js";
import { GithubProvider } from "./githubProvider.js";
import type { RepoProvider } from "./repoProvider.js";

let provider: RepoProvider | null | undefined;

/** The configured provider, or null when GitHub provisioning is not (fully) configured. */
export function getRepoProvider(): RepoProvider | null {
  if (provider !== undefined) return provider;
  const { GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_BASE64, GITHUB_ORG } = config;
  provider =
    GITHUB_APP_ID !== undefined &&
    GITHUB_APP_INSTALLATION_ID !== undefined &&
    GITHUB_APP_PRIVATE_KEY_BASE64 !== undefined &&
    GITHUB_ORG !== undefined
      ? new GithubProvider({
          appId: GITHUB_APP_ID,
          installationId: GITHUB_APP_INSTALLATION_ID,
          privateKeyBase64: GITHUB_APP_PRIVATE_KEY_BASE64,
          org: GITHUB_ORG,
        })
      : null;
  return provider;
}

/** Startup log lines; variable names only, never values. */
export function logGithubProvisioning(): void {
  if (config.githubConfigured) {
    logger.info(`github provisioning enabled org ${config.GITHUB_ORG ?? ""}`);
    return;
  }
  logger.info("github provisioning disabled");
  if (config.githubMissing.length < 4) {
    logger.warn({ missing: config.githubMissing }, "github provisioning is partly configured; set the missing variables");
  }
}
