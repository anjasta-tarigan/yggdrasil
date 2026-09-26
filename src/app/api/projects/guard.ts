/**
 * The guard was moved to `src/lib/security/api-guard.ts` so the projects and
 * system API surfaces share one implementation. Re-exported here so the
 * existing project routes keep importing from `./guard` unchanged.
 */
export { validateProjectApiRequest } from "@/lib/security/api-guard";
