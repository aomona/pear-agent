import { env, exports } from "cloudflare:workers";

import {
  initialOutingWorldState,
  outingGoal,
} from "../../../../examples/outing-domain/src/domain.js";
import type { PearEnv } from "../env.js";

export const pearEnv = env as unknown as PearEnv;

export function contextHeaders(extra?: HeadersInit): HeadersInit {
  return {
    "x-pear-context": JSON.stringify({
      actorId: "traveler",
      roles: ["owner"],
      claims: {},
    }),
    ...extra,
  };
}

export async function createSession(sessionId: string, domainId = "outing"): Promise<Response> {
  return exports.default.fetch(
    new Request("http://example.com/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...contextHeaders(),
      },
      body: JSON.stringify({
        sessionId,
        domainId,
        actorIds: ["traveler"],
        goal: outingGoal,
        normalizedInput: {
          departureAt: "2026-07-11T03:00:00Z",
          belongings: [{ id: "phone", name: "Phone", chargePercent: 20 }],
        },
        worldState: initialOutingWorldState,
      }),
    }),
  );
}
