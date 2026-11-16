import { Router, type RequestHandler } from "express";
import { requireAuth, requireRole, requireSameOrigin } from "../auth/middleware.js";
import {
  getAuditLog,
  getCompliance,
  getInflows,
  getLaunchDrafts,
  getRelayRequests,
  getUsers,
  patchUserRole,
  postComplianceResolve,
  postComplianceShutdown,
} from "../controllers/adminController.js";
import { getAdminRepos, postRevokeRepo } from "../controllers/repoController.js";
import {
  getCaseDetail,
  getCaseVotes,
  getCases,
  postCancelCase,
  postCloseCase,
  postOpenCase,
  postPrepareCase,
} from "../controllers/takeoverController.js";
import {
  caseDetailQuerySchema,
  caseIdParamsSchema,
  emptyBodySchema,
  listCasesQuerySchema,
  prepareCaseBodySchema,
} from "../takeover/takeoverSchemas.js";
import { getUserProfileForStaff } from "../controllers/profileController.js";
import { getAdminComplaints, patchAdminComplaint } from "../controllers/complaintController.js";
import { validate } from "../middlewares/validate.js";
import {
  auditLogQuerySchema,
  complianceActionBodySchema,
  complianceActionParamsSchema,
  complianceQuerySchema,
  inflowsQuerySchema,
  launchDraftsQuerySchema,
  listUsersQuerySchema,
  relayRequestsQuerySchema,
  roleBodySchema,
  roleParamsSchema,
} from "../schemas/adminSchemas.js";
import { adminReposQuerySchema, revokeRepoBodySchema, revokeRepoParamsSchema } from "../schemas/repoSchemas.js";
import { complaintIdParamsSchema, complaintsQuerySchema, complaintStatusBodySchema } from "../schemas/complaintSchemas.js";

/** Builds the admin router; ONE limiter instance guards the role-change write route. */
export function createAdminRoutes(writeLimiter: RequestHandler): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get(
    "/users",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: listUsersQuerySchema }),
    getUsers
  );
  router.get(
    "/users/:address/profile",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: roleParamsSchema }),
    getUserProfileForStaff
  );
  router.get(
    "/audit-log",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: auditLogQuerySchema }),
    getAuditLog
  );
  router.get(
    "/launch-drafts",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: launchDraftsQuerySchema }),
    getLaunchDrafts
  );
  router.get(
    "/relay-requests",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: relayRequestsQuerySchema }),
    getRelayRequests
  );
  router.get(
    "/inflows",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: inflowsQuerySchema }),
    getInflows
  );
  router.get(
    "/compliance",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: complianceQuerySchema }),
    getCompliance
  );
  router.get(
    "/repos",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: adminReposQuerySchema }),
    getAdminRepos
  );
  router.get(
    "/complaints",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: complaintsQuerySchema }),
    getAdminComplaints
  );
  router.patch(
    "/complaints/:id",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: complaintIdParamsSchema, body: complaintStatusBodySchema }),
    patchAdminComplaint
  );
  router.patch(
    "/users/:address/role",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin"),
    validate({ params: roleParamsSchema, body: roleBodySchema }),
    patchUserRole
  );

  router.post(
    "/repos/:id/revoke",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin"),
    validate({ params: revokeRepoParamsSchema, body: revokeRepoBodySchema }),
    postRevokeRepo
  );
  router.post(
    "/compliance/:projectId/resolve",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: complianceActionParamsSchema, body: complianceActionBodySchema }),
    postComplianceResolve
  );
  router.post(
    "/compliance/:projectId/shutdown",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: complianceActionParamsSchema, body: complianceActionBodySchema }),
    postComplianceShutdown
  );

  router.get(
    "/takeover-cases",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ query: listCasesQuerySchema }),
    getCases
  );
  router.get(
    "/takeover-cases/:id",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: caseIdParamsSchema, query: caseDetailQuerySchema }),
    getCaseDetail
  );
  router.post(
    "/takeover-cases",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin", "staff"),
    validate({ body: prepareCaseBodySchema }),
    postPrepareCase
  );
  // Opening (snapshot) and cancelling are ADMIN ONLY; staff may only prepare.
  router.post(
    "/takeover-cases/:id/open",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin"),
    validate({ params: caseIdParamsSchema, body: emptyBodySchema }),
    postOpenCase
  );
  router.get(
    "/takeover-cases/:id/votes",
    requireAuth,
    requireRole("admin", "staff"),
    validate({ params: caseIdParamsSchema, query: caseDetailQuerySchema }),
    getCaseVotes
  );
  // Closing after the window has elapsed is ADMIN ONLY (idempotent; early termination is cancel).
  router.post(
    "/takeover-cases/:id/close",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin"),
    validate({ params: caseIdParamsSchema, body: emptyBodySchema }),
    postCloseCase
  );
  router.post(
    "/takeover-cases/:id/cancel",
    writeLimiter,
    requireSameOrigin,
    requireAuth,
    requireRole("admin"),
    validate({ params: caseIdParamsSchema, body: emptyBodySchema }),
    postCancelCase
  );

  return router;
}
