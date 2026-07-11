import {
  runtimeEventSchema,
  type AppendEventResult,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "@pear-agent/core";
import { z } from "zod";

/** Built-in PEAR voice tools (v0.1). Domain capabilities are deferred. */
export const BUILTIN_VOICE_TOOL_NAMES = [
  "get_runtime_snapshot",
  "start_session",
  "pause_session",
  "start_step",
  "complete_step",
  "fail_step",
  "pause_step",
  "skip_step",
  "start_timer",
  "pause_timer",
  "complete_timer",
  "cancel_timer",
  "report_domain_event",
] as const;

export type BuiltinVoiceToolName = (typeof BUILTIN_VOICE_TOOL_NAMES)[number];

export type VoiceToolDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

/** Optional host extension point reserved for later Domain capabilities. */
export type VoiceToolRegistry = {
  /** @deprecated Prefer built-ins in v0.1; reserved for Issue follow-ups. */
  capabilities?: readonly never[];
};

export type VoiceToolExecuteContext = {
  sessionId: string;
  actorId: string;
  /** Gemini function call id — used as event id + idempotencyKey when present. */
  callId?: string;
  getSnapshot: () => Promise<RuntimeSnapshot>;
  appendEvent: (event: RuntimeEvent) => Promise<AppendEventResult>;
  now?: Date;
};

export type VoiceToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: true; message: string };

const emptyArgsSchema = z.object({}).passthrough();
const stepArgsSchema = z.object({ stepId: z.string().min(1) });
const timerStartArgsSchema = z.object({
  timerId: z.string().min(1),
  durationSeconds: z.number().nonnegative().optional(),
});
const timerArgsSchema = z.object({ timerId: z.string().min(1) });
const domainEventArgsSchema = z.object({
  domainType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

type ToolDef = {
  description: string;
  parameters: VoiceToolDeclaration["parameters"];
  args: z.ZodType;
  run: (args: unknown, ctx: VoiceToolExecuteContext) => Promise<VoiceToolResult>;
};

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function envelope(
  ctx: VoiceToolExecuteContext,
  now: Date,
): {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  actorId: string;
  origin: string;
  occurredAt: Date;
} {
  // Prefer stable callId so model retries / double-fires collapse via Core idempotency.
  const key = ctx.callId ?? newId("voice-idem");
  return {
    id: ctx.callId ? `voice-${ctx.callId}` : newId("voice-evt"),
    sessionId: ctx.sessionId,
    idempotencyKey: key,
    actorId: ctx.actorId,
    origin: "voice",
    occurredAt: now,
  };
}

async function appendCore(
  ctx: VoiceToolExecuteContext,
  type: Exclude<RuntimeEvent["type"], "domain_event">,
  payload: Record<string, unknown>,
  now: Date,
): Promise<VoiceToolResult> {
  const env = envelope(ctx, now);
  const event = runtimeEventSchema.parse({ ...env, type, payload });
  const result = await ctx.appendEvent(event);
  return {
    ok: true,
    result: {
      kind: result.kind,
      eventType: result.event.type,
      sessionStatus: result.state.session.status,
    },
  };
}

const stepParams = {
  type: "object" as const,
  properties: { stepId: { type: "string" } },
  required: ["stepId"],
};

const timerIdParams = {
  type: "object" as const,
  properties: { timerId: { type: "string" } },
  required: ["timerId"],
};

function stepTool(
  description: string,
  eventType: "step_started" | "step_completed" | "step_failed" | "step_paused" | "step_skipped",
): ToolDef {
  return {
    description,
    parameters: stepParams,
    args: stepArgsSchema,
    run: (args, ctx) => {
      const { stepId } = stepArgsSchema.parse(args);
      return appendCore(ctx, eventType, { stepId }, ctx.now ?? new Date());
    },
  };
}

function timerTool(
  description: string,
  eventType: "timer_paused" | "timer_completed" | "timer_cancelled",
): ToolDef {
  return {
    description,
    parameters: timerIdParams,
    args: timerArgsSchema,
    run: (args, ctx) => {
      const { timerId } = timerArgsSchema.parse(args);
      return appendCore(ctx, eventType, { timerId }, ctx.now ?? new Date());
    },
  };
}

const BUILTIN_TOOLS = {
  get_runtime_snapshot: {
    description: "Load the latest PEAR Runtime Snapshot (source of truth).",
    parameters: { type: "object" as const, properties: {} },
    args: emptyArgsSchema,
    run: async (_args, ctx) => {
      const snapshot = await ctx.getSnapshot();
      return { ok: true as const, result: summarizeSnapshotForVoice(snapshot) };
    },
  },
  start_session: {
    description: "Start the Execution Session (not_started → active).",
    parameters: { type: "object" as const, properties: {} },
    args: emptyArgsSchema,
    run: (_args, ctx) => appendCore(ctx, "session_started", {}, ctx.now ?? new Date()),
  },
  pause_session: {
    description: "Pause the Execution Session. Does not release the voice lease.",
    parameters: { type: "object" as const, properties: {} },
    args: emptyArgsSchema,
    run: (_args, ctx) => appendCore(ctx, "session_paused", {}, ctx.now ?? new Date()),
  },
  start_step: stepTool("Mark a plan step as started.", "step_started"),
  complete_step: stepTool("Mark a plan step as completed.", "step_completed"),
  fail_step: stepTool("Mark a plan step as failed.", "step_failed"),
  pause_step: stepTool("Pause an active plan step.", "step_paused"),
  skip_step: stepTool("Skip a plan step.", "step_skipped"),
  start_timer: {
    description: "Start a timer by id.",
    parameters: {
      type: "object" as const,
      properties: {
        timerId: { type: "string" },
        durationSeconds: { type: "number" },
      },
      required: ["timerId"],
    },
    args: timerStartArgsSchema,
    run: (args, ctx) => {
      const parsed = timerStartArgsSchema.parse(args);
      const payload: { timerId: string; durationSeconds?: number } = { timerId: parsed.timerId };
      if (parsed.durationSeconds !== undefined) {
        payload.durationSeconds = parsed.durationSeconds;
      }
      return appendCore(ctx, "timer_started", payload, ctx.now ?? new Date());
    },
  },
  pause_timer: timerTool("Pause a running timer.", "timer_paused"),
  complete_timer: timerTool("Complete a timer.", "timer_completed"),
  cancel_timer: timerTool("Cancel a timer.", "timer_cancelled"),
  report_domain_event: {
    description: "Record a domain-specific event.",
    parameters: {
      type: "object" as const,
      properties: {
        domainType: { type: "string" },
        payload: { type: "object" },
      },
      required: ["domainType"],
    },
    args: domainEventArgsSchema,
    run: async (args, ctx) => {
      const parsed = domainEventArgsSchema.parse(args);
      const now = ctx.now ?? new Date();
      const env = envelope(ctx, now);
      const event = runtimeEventSchema.parse({
        ...env,
        type: "domain_event",
        domainType: parsed.domainType,
        payload: parsed.payload,
      });
      const result = await ctx.appendEvent(event);
      return {
        ok: true as const,
        result: {
          kind: result.kind,
          eventType: result.event.type,
          sessionStatus: result.state.session.status,
        },
      };
    },
  },
} as const satisfies Record<string, ToolDef>;

export function listVoiceToolDeclarations(_registry?: VoiceToolRegistry): VoiceToolDeclaration[] {
  void _registry;
  return Object.entries(BUILTIN_TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    parameters: def.parameters,
  }));
}

export function summarizeSnapshotForVoice(snapshot: RuntimeSnapshot): Record<string, unknown> {
  return {
    sessionId: snapshot.session.id,
    sessionStatus: snapshot.session.status,
    planId: snapshot.plan.id,
    planVersion: snapshot.plan.version,
    stepStates: Object.fromEntries(
      Object.entries(snapshot.stepStates).map(([id, state]) => [id, state.status]),
    ),
    activeTimers: snapshot.activeTimers.map((t) => ({
      id: t.id,
      status: t.status,
      remainingSeconds: t.remainingSeconds,
    })),
    recentEventTypes: snapshot.recentEvents.slice(-6).map((e) => e.type),
    generatedAt: snapshot.generatedAt.toISOString(),
  };
}

export async function executeVoiceTool(
  toolName: string,
  args: Record<string, unknown>,
  context: VoiceToolExecuteContext,
  _registry?: VoiceToolRegistry,
): Promise<VoiceToolResult> {
  void _registry;
  const tool = BUILTIN_TOOLS[toolName as BuiltinVoiceToolName];
  if (!tool) {
    return { ok: false, error: true, message: `Unknown voice tool: ${toolName}` };
  }

  try {
    const parsed = tool.args.parse(args);
    return await tool.run(parsed, {
      ...context,
      now: context.now ?? new Date(),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { ok: false, error: true, message };
  }
}
