import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { changeUserRole } from "../../src/auth/adminService.js";
import { insertRoleChange, listAuditEntries } from "../../src/auth/auditRepository.js";
import { addr, auditRows, bootstrapDatabase, closePool, createSession, createUser, pgErrorOf, pool, resetData } from "./db.js";

beforeAll(bootstrapDatabase);
beforeEach(resetData);
afterAll(closePool);

async function sessionCount(userId: string): Promise<number> {
  const r = await pool.query("SELECT 1 FROM app.sessions WHERE user_id = $1", [userId]);
  return r.rowCount ?? 0;
}

describe("admin role change CTE", () => {
  it("updates the role, revokes only the target sessions and writes exactly one audit row", async () => {
    const admin = await createUser(1, "admin");
    const target = await createUser(2, "investor");
    const bystander = await createUser(3, "investor");
    await createSession(target.id, "t1");
    await createSession(target.id, "t2");
    await createSession(bystander.id, "b1");

    const result = await changeUserRole(admin, target.address, "staff", "9.9.9.9");
    expect(result).toEqual({ id: target.id, address: target.address, role: "staff" });

    const role = await pool.query<{ role: string }>("SELECT role FROM app.users WHERE id = $1", [target.id]);
    expect(role.rows[0]?.role).toBe("staff");
    expect(await sessionCount(target.id)).toBe(0);
    expect(await sessionCount(bystander.id)).toBe(1);

    const audit = await auditRows();
    expect(audit).toEqual([
      { action: "role.change", target: target.address, before_value: "investor", after_value: "staff", actor_user_id: admin.id },
    ]);
    const entries = await listAuditEntries(10, 0);
    expect(entries[0]).toMatchObject({ action: "role.change", ip: "9.9.9.9" });
  });

  it("an unchanged role writes no audit row and keeps sessions", async () => {
    const admin = await createUser(1, "admin");
    const target = await createUser(2, "staff");
    await createSession(target.id, "t1");
    const result = await insertRoleChange({ actorUserId: admin.id, targetAddress: target.address, newRole: "staff", ip: null });
    expect(result).toMatchObject({ changed: false, previousRole: "staff" });
    expect(await auditRows()).toEqual([]);
    expect(await sessionCount(target.id)).toBe(1);
  });

  it("never touches an admin target", async () => {
    const admin = await createUser(1, "admin");
    const otherAdmin = await createUser(2, "admin");
    await createSession(otherAdmin.id, "a1");
    const result = await insertRoleChange({ actorUserId: admin.id, targetAddress: otherAdmin.address, newRole: "investor", ip: null });
    expect(result).toMatchObject({ changed: false, previousRole: "admin" });
    await expect(changeUserRole(admin, otherAdmin.address, "investor", null)).rejects.toMatchObject({ status: 403 });
    const role = await pool.query<{ role: string }>("SELECT role FROM app.users WHERE id = $1", [otherAdmin.id]);
    expect(role.rows[0]?.role).toBe("admin");
    expect(await auditRows()).toEqual([]);
    expect(await sessionCount(otherAdmin.id)).toBe(1);
  });

  it("unknown user returns null and 404 through the service", async () => {
    const admin = await createUser(1, "admin");
    expect(await insertRoleChange({ actorUserId: admin.id, targetAddress: addr(77), newRole: "staff", ip: null })).toBeNull();
    await expect(changeUserRole(admin, addr(77), "staff", null)).rejects.toMatchObject({ status: 404 });
    expect(await auditRows()).toEqual([]);
  });

  it("an invalid role is rejected by the CHECK constraint", async () => {
    const admin = await createUser(1, "admin");
    const target = await createUser(2);
    const err = await pgErrorOf(
      insertRoleChange({ actorUserId: admin.id, targetAddress: target.address, newRole: "root" as never, ip: null })
    );
    expect(err.code).toBe("23514");
  });
});

describe("audit_log is append-only", () => {
  it("rejects UPDATE, DELETE and TRUNCATE", async () => {
    const admin = await createUser(1, "admin");
    const target = await createUser(2);
    await insertRoleChange({ actorUserId: admin.id, targetAddress: target.address, newRole: "staff", ip: null });
    expect(await auditRows()).toHaveLength(1);

    expect((await pgErrorOf(pool.query("UPDATE app.audit_log SET action = 'x'"))).message).toMatch(/append-only/);
    expect((await pgErrorOf(pool.query("DELETE FROM app.audit_log"))).message).toMatch(/append-only/);
    expect((await pgErrorOf(pool.query("TRUNCATE app.audit_log"))).message).toMatch(/append-only/);
    expect(await auditRows()).toHaveLength(1);
  });

  it("survives deletion of the actor user (no foreign key)", async () => {
    const admin = await createUser(1, "admin");
    const target = await createUser(2);
    await insertRoleChange({ actorUserId: admin.id, targetAddress: target.address, newRole: "staff", ip: null });
    await pool.query("DELETE FROM app.users WHERE id = $1", [admin.id]);
    expect(await auditRows()).toHaveLength(1);
  });

  it("the test reset helper really leaves the triggers enabled afterwards", async () => {
    const triggers = await pool.query<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'app.audit_log'::regclass"
    );
    expect(triggers.rows.every((t) => t.tgenabled === "O")).toBe(true);
  });
});
