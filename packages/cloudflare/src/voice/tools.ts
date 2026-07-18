import {
  runtimeEventSchema,
  type AppendEventResult,
  type ReplanMode,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "@pear-agent/core";
import { z } from "zod";

import { summarizeSnapshotForVoice } from "./snapshot-summary.js";

export {
  summarizeSnapshotForVoice,
  type VoiceRuntimeSummary,
  type VoiceStepSummary,
} from "./snapshot-summary.js";

/** Built-in PEAR voice tools (v0.1). */
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
  "request_replan",
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

export type VoiceToolExecuteContext = {
  sessionId: string;
  actorId: string;
  /** Gemini function call id — used as event id + idempotencyKey when present. */
  callId?: string;
  getSnapshot: () => Promise<RuntimeSnapshot>;
  appendEvent: (event: RuntimeEvent) => Promise<AppendEventResult>;
  requestReplan?: (mode: ReplanMode) => Promise<unknown>;
  now?: Date;
};

export type VoiceToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: true; message: string };

/**
 * Core RuntimeEvent.type used for authorize({ type: "session.appendEvent", eventType }).
 * Null for read-only tools that do not append events.
 */
export type VoiceToolAuthorizeEventType = string | null;

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
const requestReplanArgsSchema = z.object({
  mode: z.enum(["confirm", "suggest"]).default("confirm"),
});

type ToolDef = {
  description: string;
  parameters: VoiceToolDeclaration["parameters"];
  args: z.ZodType;
  /** Core event type for policy checks; null = read-only. */
  authorizeEventType: VoiceToolAuthorizeEventType;
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
    authorizeEventType: eventType,
    run: (args, ctx) => {
      const { stepId } = args as z.infer<typeof stepArgsSchema>;
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
    authorizeEventType: eventType,
    run: (args, ctx) => {
      const { timerId } = args as z.infer<typeof timerArgsSchema>;
      return appendCore(ctx, eventType, { timerId }, ctx.now ?? new Date());
    },
  };
}

const BUILTIN_TOOLS = {
  get_runtime_snapshot: {
    description: "Load the latest PEAR Runtime Snapshot (source of truth).",
    parameters: { type: "object" as const, properties: {} },
    args: emptyArgsSchema,
    authorizeEventType: null,
    run: async (_args, ctx) => {
      const snapshot = await ctx.getSnapshot();
      return { ok: true as const, result: summarizeSnapshotForVoice(snapshot) };
    },
  },
  start_session: {
    description: "Start the Execution Session (not_started → active).",
    parameters: { type: "object" as const, properties: {} },
    args: emptyArgsSchema,
    authorizeEventType: "session_started",
    run: (_args, ctx) => appendCore(ctx, "session_started", {}, ctx.now ?? new Date()),
  },
  pause_session: {
    description: "Pause the Execution Session. Does not release the voice lease.",
    parameters: { type: "object" as const, properties: {} },
    args: emptyArgsSchema,
    authorizeEventType: "session_paused",
    run: (_args, ctx) => appendCore(ctx, "session_paused", {}, ctx.now ?? new Date()),
  },
  start_step: stepTool("Mark a plan step as started.", "step_started"),
  complete_step: stepTool("Mark a plan step as completed.", "step_completed"),
  fail_step: stepTool("Mark a plan step as failed.", "step_failed"),
  pause_step: stepTool("Pause an active plan step.", "step_paused"),
  skip_step: stepTool("Skip a plan step.", "step_skipped"),
  start_timer: {
    description:
      "Start a plan timer by id. Prefer timerId + durationSeconds from the plan summary (steps[].timers). Do not ask the user for duration when the plan already defines it.",
    parameters: {
      type: "object" as const,
      properties: {
        timerId: {
          type: "string",
          description: "Timer id from plan step timers, e.g. charge-wait",
        },
        durationSeconds: {
          type: "number",
          description: "Duration from plan timer definition when first starting the timer",
        },
      },
      required: ["timerId"],
    },
    args: timerStartArgsSchema,
    authorizeEventType: "timer_started",
    run: (args, ctx) => {
      const parsed = args as z.infer<typeof timerStartArgsSchema>;
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
    authorizeEventType: "domain_event",
    run: async (args, ctx) => {
      const parsed = args as z.infer<typeof domainEventArgsSchema>;
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
  request_replan: {
    description:
      "Request Runtime assessment and partial replanning after relevant events have been recorded. The Runtime validates and applies or proposes the generated patch.",
    parameters: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["confirm", "suggest"],
          description: "Voice replanning never auto-applies; use confirm unless only suggesting.",
        },
      },
    },
    args: requestReplanArgsSchema,
    authorizeEventType: null,
    run: async (args, ctx) => {
      if (!ctx.requestReplan) {
        return { ok: false as const, error: true as const, message: "Replan is not configured" };
      }
      const { mode } = args as z.infer<typeof requestReplanArgsSchema>;
      return { ok: true as const, result: await ctx.requestReplan(mode) };
    },
  },
} as const satisfies Record<string, ToolDef>;

export function listVoiceToolDeclarations(): VoiceToolDeclaration[] {
  return Object.entries(BUILTIN_TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    parameters:
      def.authorizeEventType === null
        ? def.parameters
        : {
            ...def.parameters,
            properties: {
              ...def.parameters.properties,
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description:
                  "0..1 confidence that the user explicitly requested or completed this state change",
              },
            },
            required: [
              ...("required" in def.parameters ? (def.parameters.required ?? []) : []),
              "confidence",
            ],
          },
  }));
}

/** Core event type for authorize, or null if the tool is read-only. */
export function voiceToolAuthorizeEventType(
  toolName: string,
): VoiceToolAuthorizeEventType | undefined {
  const tool = BUILTIN_TOOLS[toolName as BuiltinVoiceToolName];
  if (!tool) return undefined;
  return tool.authorizeEventType;
}

export async function executeVoiceTool(
  toolName: string,
  args: Record<string, unknown>,
  context: VoiceToolExecuteContext,
): Promise<VoiceToolResult> {
  const tool = BUILTIN_TOOLS[toolName as BuiltinVoiceToolName];
  if (!tool) {
    return { ok: false, error: true, message: `Unknown voice tool: ${toolName}` };
  }

  try {
    // Parse once at the edge; run handlers receive already-validated args.
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
