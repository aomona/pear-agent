import {
  applyRuntimeEvent,
  materializedExecutionStateSchema,
  type MaterializedExecutionState,
} from "./execution-state.js";
import { runtimeEventSchema, type RuntimeEvent } from "./event.js";
import { createRuntimeSnapshot, type RuntimeSnapshot } from "./snapshot.js";

export type AppendEventResult =
  | {
      kind: "applied";
      event: RuntimeEvent;
      state: MaterializedExecutionState;
    }
  | {
      kind: "duplicate";
      event: RuntimeEvent;
      state: MaterializedExecutionState;
    };

/** Persistence boundary for the event log and its materialized execution state. */
export interface ExecutionStateRepository {
  create(initialState: MaterializedExecutionState): void;
  get(sessionId: string): MaterializedExecutionState | undefined;
  appendEvent(event: RuntimeEvent): AppendEventResult;
  getSnapshot(sessionId: string): RuntimeSnapshot | undefined;
}

/**
 * Small deterministic repository used by core tests and as an adapter
 * contract fixture. The state replacement and event append occur only after
 * reduction succeeds, making a failed event application all-or-nothing.
 */
export class InMemoryExecutionStateRepository implements ExecutionStateRepository {
  private readonly states = new Map<string, MaterializedExecutionState>();

  private readonly events = new Map<string, RuntimeEvent[]>();

  constructor(initialStates: readonly MaterializedExecutionState[] = []) {
    for (const state of initialStates) this.create(state);
  }

  create(initialState: MaterializedExecutionState): void {
    const parsed = materializedExecutionStateSchema.parse(initialState);
    const sessionId = parsed.session.id;
    if (this.states.has(sessionId)) {
      throw new Error(`Execution session already exists: ${sessionId}`);
    }
    this.states.set(sessionId, parsed);
    this.events.set(sessionId, []);
  }

  get(sessionId: string): MaterializedExecutionState | undefined {
    return this.states.get(sessionId);
  }

  appendEvent(event: RuntimeEvent): AppendEventResult {
    const parsedEvent = runtimeEventSchema.parse(event);
    const current = this.states.get(parsedEvent.sessionId);
    if (!current) throw new Error(`Unknown execution session: ${parsedEvent.sessionId}`);

    const duplicate =
      current.appliedEventIds.includes(parsedEvent.id) ||
      current.appliedIdempotencyKeys.includes(parsedEvent.idempotencyKey);
    if (duplicate) return { kind: "duplicate", event: parsedEvent, state: current };

    // applyRuntimeEvent is pure; no repository collections are touched until
    // this call succeeds, preserving transaction semantics on errors.
    const next = applyRuntimeEvent(current, parsedEvent);
    const sessionEvents = this.events.get(parsedEvent.sessionId);
    if (!sessionEvents) throw new Error(`Unknown execution session: ${parsedEvent.sessionId}`);
    sessionEvents.push(parsedEvent);
    this.states.set(parsedEvent.sessionId, next);
    return { kind: "applied", event: parsedEvent, state: next };
  }

  getSnapshot(sessionId: string): RuntimeSnapshot | undefined {
    const state = this.states.get(sessionId);
    if (!state) return undefined;
    return createRuntimeSnapshot({
      plan: state.plan,
      state,
      recentEvents: this.events.get(sessionId) ?? [],
    });
  }
}
