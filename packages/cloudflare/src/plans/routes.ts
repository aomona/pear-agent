import type { PearApp } from "../http/app.js";
import { createPlanLibraryHostPorts, type PlanLibraryOptions } from "./host-ports.js";
import { registerPlanCrudRoutes } from "./routes/crud.js";
import { registerPlanGenerateRoutes } from "./routes/generate.js";
import { registerPlanImproveRoutes } from "./routes/improve.js";
import { registerPlanNormalizeRoutes } from "./routes/normalize.js";

export type { PlanLibraryOptions } from "./host-ports.js";

/** Session-independent plan library HTTP API (CE-11). */
export function registerPlanRoutes(app: PearApp, options: PlanLibraryOptions): void {
  const routeContext = {
    authorize: options.authorize,
    ports: createPlanLibraryHostPorts(options),
  };
  registerPlanCrudRoutes(app, routeContext);
  registerPlanGenerateRoutes(app, routeContext);
  registerPlanNormalizeRoutes(app, routeContext);
  registerPlanImproveRoutes(app, routeContext);
}
