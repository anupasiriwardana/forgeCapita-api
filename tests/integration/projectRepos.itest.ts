import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { findUnlinkedRepo, insertRepo, listRepos } from "../../src/repos/repoRepository.js";
import { bootstrapDatabase, closePool, createUser, pgErrorOf, pool, resetData } from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

function repo(userId: string, repoId: number): Parameters<typeof insertRepo>[1] {
  return {
    userId,
    repoId,
    repoName: `fc-app-00000${repoId}`,
    fullName: `forge-org/fc-app-00000${repoId}`,
    htmlUrl: `https://github.com/forge-org/fc-app-00000${repoId}`,
    founderLogin: "octocat",
  };
}

describe("app.project_repos", () => {
  it("allows one unlinked repo per founder until it is linked to a project", async () => {
    const user = await createUser(1, "founder");
    const id = await insertRepo(pool, repo(user.id, 1));
    const second = await pgErrorOf(insertRepo(pool, repo(user.id, 2)));
    expect(second.code).toBe("23505");
    expect(second.constraint).toBe("project_repos_unlinked_user_uidx");

    await pool.query("UPDATE app.project_repos SET project_id = '421614:0x01' WHERE id = $1", [id]);
    expect(await findUnlinkedRepo(pool, user.id)).toBeNull();
    await insertRepo(pool, repo(user.id, 2));
    expect((await listRepos(user.id, 10, 0)).total).toBe(2);
  });

  it("rejects duplicate provider repo ids and malformed values", async () => {
    const a = await createUser(1, "founder");
    const b = await createUser(2, "founder");
    await insertRepo(pool, repo(a.id, 1));
    expect((await pgErrorOf(insertRepo(pool, repo(b.id, 1)))).constraint).toBe("project_repos_repo_unique");
    const badLogin = await pgErrorOf(insertRepo(pool, { ...repo(b.id, 3), founderLogin: "-bad" }));
    expect(badLogin.constraint).toBe("project_repos_founder_login_check");
    const badUrl = await pgErrorOf(insertRepo(pool, { ...repo(b.id, 4), htmlUrl: "http://github.com/x" }));
    expect(badUrl.constraint).toBe("project_repos_html_url_check");
  });
});
