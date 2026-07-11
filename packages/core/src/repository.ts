import {
  applyRuntimeEvent,
  materializedExecutionStateSchema,
  type MaterializedExecutionState,
} from "./execution-state.js";
import { runtimeEventSchema, type RuntimeEvent } from "./event.js";
import { createRuntimeSnapshot, type RuntimeSnapshot } from "./snapshot.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Default window size for snapshot `recentEvents` (full log remains internal). */
export const DEFAULT_RECENT_EVENT_LIMIT = 100;

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

export type GetSnapshotOptions = {
  /** Max events to include in the snapshot (most recent). Defaults to 100. */
  recentEventLimit?: number;
};

/** Persistence boundary for the event log and its materialized execution state. */
export interface ExecutionStateRepository {
  create(initialState: MaterializedExecutionState): Promise<void>;
  get(sessionId: string): Promise<MaterializedExecutionState | undefined>;
  appendEvent(event: RuntimeEvent): Promise<AppendEventResult>;
  getSnapshot(
    sessionId: string,
    options?: GetSnapshotOptions,
  ): Promise<RuntimeSnapshot | undefined>;
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
    for (const state of initialStates) {
      const parsed = materializedExecutionStateSchema.parse(state);
      const sessionId = parsed.session.id;
      if (this.states.has(sessionId)) {
        throw new Error(`Execution session already exists: ${sessionId}`);
      }
      this.states.set(sessionId, clone(parsed));
      this.events.set(sessionId, []);
    }
  }

  async create(initialState: MaterializedExecutionState): Promise<void> {
    const parsed = materializedExecutionStateSchema.parse(initialState);
    const sessionId = parsed.session.id;
    if (this.states.has(sessionId)) {
      throw new Error(`Execution session already exists: ${sessionId}`);
    }
    this.states.set(sessionId, clone(parsed));
    this.events.set(sessionId, []);
  }

  async get(sessionId: string): Promise<MaterializedExecutionState | undefined> {
    const state = this.states.get(sessionId);
    return state ? clone(state) : undefined;
  }

  async appendEvent(event: RuntimeEvent): Promise<AppendEventResult> {
    const parsedEvent = clone(runtimeEventSchema.parse(event));
    const current = this.states.get(parsedEvent.sessionId);
    if (!current) throw new Error(`Unknown execution session: ${parsedEvent.sessionId}`);

    const appliedEventIds = new Set(current.appliedEventIds);
    const appliedIdempotencyKeys = new Set(current.appliedIdempotencyKeys);
    const duplicate =
      appliedEventIds.has(parsedEvent.id) || appliedIdempotencyKeys.has(parsedEvent.idempotencyKey);
    if (duplicate) {
      return { kind: "duplicate", event: clone(parsedEvent), state: clone(current) };
    }

    // applyRuntimeEvent is pure; no repository collections are touched until
    // this call succeeds, preserving transaction semantics on errors.
    const next = applyRuntimeEvent(current, parsedEvent);
    const sessionEvents = this.events.get(parsedEvent.sessionId);
    if (!sessionEvents) throw new Error(`Unknown execution session: ${parsedEvent.sessionId}`);
    sessionEvents.push(clone(parsedEvent));
    this.states.set(parsedEvent.sessionId, next);
    return { kind: "applied", event: clone(parsedEvent), state: clone(next) };
  }

  async getSnapshot(
    sessionId: string,
    options?: GetSnapshotOptions,
  ): Promise<RuntimeSnapshot | undefined> {
    const state = this.states.get(sessionId);
    if (!state) return undefined;
    const limit = options?.recentEventLimit ?? DEFAULT_RECENT_EVENT_LIMIT;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`recentEventLimit must be a non-negative integer, got ${limit}`);
    }
    const sessionEvents = this.events.get(sessionId) ?? [];
    const recentEvents = limit === 0 ? [] : sessionEvents.slice(-limit);
    return clone(
      createRuntimeSnapshot({
        plan: state.plan,
        state,
        recentEvents,
      }),
    );
  }
}
