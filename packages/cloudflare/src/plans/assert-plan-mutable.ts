import { HTTPException } from "hono/http-exception";

import { D1CompileRepository } from "../d1/compile-repository.js";

/**
 * Single gate for plan-library writers while a compile job is active.
 * Prefer this over ad-hoc `getActiveJob` checks scattered across routes.
 */
export async function assertPlanMutable(
  db: D1Database,
  planId: string,
  action: string,
): Promise<void> {
  if (await new D1CompileRepository(db).getActiveJob(planId)) {
    throw new HTTPException(409, {
      message: `Cannot ${action} while a compile job is active`,
    });
  }
}
