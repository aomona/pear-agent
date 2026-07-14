import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import type { AuthorizeFn } from "../authorize.js";
import type { PearRequestContext } from "../context.js";
import type { PearEnv } from "../env.js";
import { registerReplanRoutes } from "./routes.js";

type TestApp = Hono<{
  Bindings: PearEnv;
  Variables: { pearContext: PearRequestContext };
}>;

function deniedApp(onCreateRuntime: () => void): TestApp {
  const app = new Hono<{
    Bindings: PearEnv;
    Variables: { pearContext: PearRequestContext };
  }>();
  app.use("*", async (c, next) => {
    c.set("pearContext", { actorId: "denied", roles: [], claims: {} });
    await next();
  });
  const authorize: AuthorizeFn = async () => {
    throw new HTTPException(403, { message: "Denied before runtime resolution" });
  };
  registerReplanRoutes(app, authorize, undefined, () => {
    onCreateRuntime();
    throw new Error("Runtime factory must not run before authorization");
  });
  return app;
}

describe("replan route authorization order", () => {
  it.each([
    ["request", "/sessions/session-1/replans", {}],
    ["confirm", "/sessions/session-1/plan-patches/patch-1/confirm", { confirmed: true }],
  ])("authorizes %s before resolving the env-backed runtime", async (_name, path, body) => {
    let factoryCalls = 0;
    const response = await deniedApp(() => factoryCalls++).request(
      `http://example.com${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      {} as PearEnv,
    );

    expect(response.status).toBe(403);
    expect(factoryCalls).toBe(0);
  });
});
