import {
  applyRuntimeEvent,
  createRuntimeSnapshot,
  DEFAULT_RECENT_EVENT_LIMIT,
  type AppendEventResult,
  type ExecutionStateRepository,
  type GetSnapshotOptions,
  type MaterializedExecutionState,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from "@pear-agent/core";
import { and, desc, eq } from "drizzle-orm";

import {
  parseExecutionState,
  parseRuntimeEvent,
  serializeExecutionState,
  serializeJson,
  serializeRuntimeEvent,
} from "../serialize.js";
import { createPearDatabase, type PearDatabase } from "./client.js";
import {
  executionSessions,
  materializedStates,
  normalizedInputs,
  rawInputs,
  runtimeEvents,
} from "./schema.js";

export type D1ExecutionStateRepositoryOptions = {
  /** Domain id stored on the session row for listing / provenance. */
  domainId?: string;
};

/**
 * Drizzle + D1 implementation of {@link ExecutionStateRepository}.
 * Event append and materialized state replacement use a single D1 batch.
 */
export class D1ExecutionStateRepository implements ExecutionStateRepository {
  private readonly db: PearDatabase;

  constructor(
    d1: D1Database,
    private readonly options: D1ExecutionStateRepositoryOptions = {},
  ) {
    this.db = createPearDatabase(d1);
  }

  async create(
    initialState: MaterializedExecutionState,
    createOptions: { normalizedInput?: unknown } = {},
  ): Promise<void> {
    const state = parseExecutionState(serializeExecutionState(initialState));
    const sessionId = state.session.id;
    const now = state.session.updatedAt.toISOString();
    const domainId = this.options.domainId ?? "unknown";

    const sessionInsert = this.db.insert(executionSessions).values({
      id: sessionId,
      domainId,
      status: state.session.status,
      planId: state.session.planId,
      planVersion: state.session.planVersion,
      goalId: state.session.goalId,
      actorIdsJson: serializeJson(state.session.actorIds),
      createdAt: state.session.createdAt.toISOString(),
      updatedAt: now,
    });
    const stateInsert = this.db.insert(materializedStates).values({
      sessionId,
      stateJson: serializeExecutionState(state),
      updatedAt: now,
    });

    try {
      if (createOptions.normalizedInput !== undefined) {
        await this.db.batch([
          sessionInsert,
          stateInsert,
          this.db.insert(normalizedInputs).values({
            sessionId,
            payloadJson: serializeJson(createOptions.normalizedInput),
            updatedAt: now,
          }),
        ]);
      } else {
        await this.db.batch([sessionInsert, stateInsert]);
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error(`Execution session already exists: ${sessionId}`);
      }
      throw error;
    }
  }

  async get(sessionId: string): Promise<MaterializedExecutionState | undefined> {
    const row = await this.db.query.materializedStates.findFirst({
      where: eq(materializedStates.sessionId, sessionId),
    });
    if (!row) return undefined;
    return parseExecutionState(row.stateJson);
  }

  async appendEvent(event: RuntimeEvent): Promise<AppendEventResult> {
    const parsedEvent = parseRuntimeEvent(serializeRuntimeEvent(event));
    const current = await this.get(parsedEvent.sessionId);
    if (!current) throw new Error(`Unknown execution session: ${parsedEvent.sessionId}`);

    const appliedEventIds = new Set(current.appliedEventIds);
    const appliedIdempotencyKeys = new Set(current.appliedIdempotencyKeys);
    const duplicate =
      appliedEventIds.has(parsedEvent.id) || appliedIdempotencyKeys.has(parsedEvent.idempotencyKey);
    if (duplicate) {
      return { kind: "duplicate", event: parsedEvent, state: current };
    }

    // Pure reduce first; only then touch D1 so failed applications stay atomic.
    const next = applyRuntimeEvent(current, parsedEvent);
    const updatedAt = next.session.updatedAt.toISOString();

    try {
      await this.db.batch([
        this.db.insert(runtimeEvents).values({
          id: parsedEvent.id,
          sessionId: parsedEvent.sessionId,
          idempotencyKey: parsedEvent.idempotencyKey,
          eventJson: serializeRuntimeEvent(parsedEvent),
          occurredAt: parsedEvent.occurredAt.toISOString(),
        }),
        this.db
          .update(materializedStates)
          .set({
            stateJson: serializeExecutionState(next),
            updatedAt,
          })
          .where(eq(materializedStates.sessionId, parsedEvent.sessionId)),
        this.db
          .update(executionSessions)
          .set({
            status: next.session.status,
            planId: next.session.planId,
            planVersion: next.session.planVersion,
            goalId: next.session.goalId,
            actorIdsJson: serializeJson(next.session.actorIds),
            updatedAt,
          })
          .where(eq(executionSessions.id, parsedEvent.sessionId)),
      ]);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const afterRace = await this.get(parsedEvent.sessionId);
        if (
          afterRace &&
          (afterRace.appliedEventIds.includes(parsedEvent.id) ||
            afterRace.appliedIdempotencyKeys.includes(parsedEvent.idempotencyKey))
        ) {
          return { kind: "duplicate", event: parsedEvent, state: afterRace };
        }
        throw new Error(
          `Event identity conflict for id=${parsedEvent.id} idempotencyKey=${parsedEvent.idempotencyKey}`,
        );
      }
      throw error;
    }

    return { kind: "applied", event: parsedEvent, state: next };
  }

  async getSnapshot(
    sessionId: string,
    options?: GetSnapshotOptions,
  ): Promise<RuntimeSnapshot | undefined> {
    const state = await this.get(sessionId);
    if (!state) return undefined;

    const limit = options?.recentEventLimit ?? DEFAULT_RECENT_EVENT_LIMIT;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`recentEventLimit must be a non-negative integer, got ${limit}`);
    }

    const recentEvents =
      limit === 0
        ? []
        : (
            await this.db.query.runtimeEvents.findMany({
              where: eq(runtimeEvents.sessionId, sessionId),
              orderBy: [desc(runtimeEvents.occurredAt), desc(runtimeEvents.id)],
              limit,
            })
          )
            .map((row) => parseRuntimeEvent(row.eventJson))
            .reverse();

    return createRuntimeSnapshot({
      plan: state.plan,
      state,
      recentEvents,
    });
  }

  async putNormalizedInput(sessionId: string, payload: unknown): Promise<void> {
    const session = await this.db.query.executionSessions.findFirst({
      where: eq(executionSessions.id, sessionId),
      columns: { id: true },
    });
    if (!session) throw new Error(`Unknown execution session: ${sessionId}`);

    const updatedAt = new Date().toISOString();
    await this.db
      .insert(normalizedInputs)
      .values({
        sessionId,
        payloadJson: serializeJson(payload),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: normalizedInputs.sessionId,
        set: {
          payloadJson: serializeJson(payload),
          updatedAt,
        },
      });
  }

  async getNormalizedInput(sessionId: string): Promise<unknown | undefined> {
    const row = await this.db.query.normalizedInputs.findFirst({
      where: eq(normalizedInputs.sessionId, sessionId),
    });
    if (!row) return undefined;
    return JSON.parse(row.payloadJson) as unknown;
  }
}

export type RawInputMetadata = {
  id: string;
  sessionId: string;
  objectKey: string;
  contentType: string | null;
  byteSize: number;
  checksumSha256: string;
  createdAt: Date;
  createdByActorId: string;
};

export async function insertRawInputMetadata(
  dbOrD1: PearDatabase | D1Database,
  metadata: RawInputMetadata,
): Promise<void> {
  const db = isPearDatabase(dbOrD1) ? dbOrD1 : createPearDatabase(dbOrD1);
  await db.insert(rawInputs).values({
    id: metadata.id,
    sessionId: metadata.sessionId,
    objectKey: metadata.objectKey,
    contentType: metadata.contentType,
    byteSize: metadata.byteSize,
    checksumSha256: metadata.checksumSha256,
    createdAt: metadata.createdAt.toISOString(),
    createdByActorId: metadata.createdByActorId,
  });
}

export async function getRawInputMetadata(
  dbOrD1: PearDatabase | D1Database,
  sessionId: string,
  inputId: string,
): Promise<RawInputMetadata | undefined> {
  const db = isPearDatabase(dbOrD1) ? dbOrD1 : createPearDatabase(dbOrD1);
  const row = await db.query.rawInputs.findFirst({
    where: and(eq(rawInputs.id, inputId), eq(rawInputs.sessionId, sessionId)),
  });
  if (!row) return undefined;
  return {
    id: row.id,
    sessionId: row.sessionId,
    objectKey: row.objectKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    checksumSha256: row.checksumSha256,
    createdAt: new Date(row.createdAt),
    createdByActorId: row.createdByActorId,
  };
}

export async function sessionExists(
  dbOrD1: PearDatabase | D1Database,
  sessionId: string,
): Promise<boolean> {
  const db = isPearDatabase(dbOrD1) ? dbOrD1 : createPearDatabase(dbOrD1);
  const row = await db.query.executionSessions.findFirst({
    where: eq(executionSessions.id, sessionId),
    columns: { id: true },
  });
  return row !== undefined;
}

function isPearDatabase(value: PearDatabase | D1Database): value is PearDatabase {
  return typeof value === "object" && value !== null && "query" in value && "batch" in value;
}

/** Detect SQLite/D1 unique violations only — not FK / NOT NULL / generic errors. */
export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") || /D1_ERROR:.*UNIQUE/i.test(message);
}
