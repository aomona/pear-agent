import {
  createVoiceLease,
  expireVoiceLease,
  isVoiceLeaseActive,
  releaseVoiceLease,
  voiceLeaseSchema,
  type VoiceLease,
  DEFAULT_VOICE_LEASE_TTL_MS,
} from "@pear-agent/core";
import { eq } from "drizzle-orm";

import { createPearDatabase } from "../d1/client.js";
import { sessionExists } from "../d1/repository.js";
import { voiceLeases } from "../d1/schema.js";
import type { VoiceLeaseResult } from "./results.js";

function rowToLease(row: {
  id: string;
  sessionId: string;
  actorId: string;
  status: string;
  acquiredAt: string;
  expiresAt: string;
  providerResumeHandle: string | null;
}): VoiceLease {
  return voiceLeaseSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    actorId: row.actorId,
    status: row.status,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
    providerResumeHandle: row.providerResumeHandle,
  });
}

export type AcquireVoiceLeaseInput = {
  sessionId: string;
  actorId: string;
  leaseId?: string;
  ttlMs?: number;
  now?: Date;
};

export type VoiceLeaseStore = {
  acquire(input: AcquireVoiceLeaseInput): Promise<VoiceLeaseResult>;
  release(sessionId: string, actorId: string): Promise<VoiceLeaseResult>;
  getActive(sessionId: string): Promise<VoiceLease | null>;
  setResumeHandle(
    sessionId: string,
    actorId: string,
    handle: string | null,
  ): Promise<VoiceLeaseResult>;
};

/**
 * D1-backed exclusive lease: one row per session_id (PRIMARY KEY).
 * Concurrent acquires serialize via Agent runExclusive + upsert.
 */
export function createVoiceLeaseStore(d1: D1Database): VoiceLeaseStore {
  const db = createPearDatabase(d1);

  async function loadRow(sessionId: string): Promise<VoiceLease | null> {
    const row = await db.query.voiceLeases.findFirst({
      where: eq(voiceLeases.sessionId, sessionId),
    });
    if (!row) return null;
    return rowToLease(row);
  }

  async function upsert(lease: VoiceLease, now: Date): Promise<void> {
    await db
      .insert(voiceLeases)
      .values({
        sessionId: lease.sessionId,
        id: lease.id,
        actorId: lease.actorId,
        status: lease.status,
        acquiredAt: lease.acquiredAt.toISOString(),
        expiresAt: lease.expiresAt.toISOString(),
        providerResumeHandle: lease.providerResumeHandle,
        updatedAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: voiceLeases.sessionId,
        set: {
          id: lease.id,
          actorId: lease.actorId,
          status: lease.status,
          acquiredAt: lease.acquiredAt.toISOString(),
          expiresAt: lease.expiresAt.toISOString(),
          providerResumeHandle: lease.providerResumeHandle,
          updatedAt: now.toISOString(),
        },
      });
  }

  async function requireActiveHolder(
    sessionId: string,
    actorId: string,
    now: Date,
  ): Promise<VoiceLeaseResult> {
    const current = await loadRow(sessionId);
    if (!current || !isVoiceLeaseActive(current, now)) {
      return {
        ok: false,
        code: "not_found",
        message: `No active voice lease for session ${sessionId}`,
      };
    }
    if (current.actorId !== actorId) {
      return {
        ok: false,
        code: "conflict",
        holderActorId: current.actorId,
        message: `Voice lease already active for session ${sessionId} (held by ${current.actorId})`,
      };
    }
    return { ok: true, lease: current };
  }

  return {
    async acquire(input) {
      const exists = await sessionExists(d1, input.sessionId);
      if (!exists) {
        return {
          ok: false,
          code: "session_not_found",
          message: `Unknown execution session: ${input.sessionId}`,
        };
      }

      const now = input.now ?? new Date();
      const current = await loadRow(input.sessionId);

      if (current) {
        const live = isVoiceLeaseActive(current, now) ? current : expireVoiceLease(current, now);

        if (live.status === "active") {
          if (live.actorId === input.actorId) {
            // Same actor re-acquire: keep lease id/handle, refresh TTL from now.
            const extended: VoiceLease = {
              ...live,
              expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_VOICE_LEASE_TTL_MS)),
            };
            await upsert(extended, now);
            return { ok: true, lease: extended };
          }
          return {
            ok: false,
            code: "conflict",
            holderActorId: live.actorId,
            message: `Voice lease already active for session ${input.sessionId} (held by ${live.actorId})`,
          };
        }

        if (live.status === "expired" && current.status === "active") {
          await upsert(live, now);
        }
      }

      const lease = createVoiceLease({
        id: input.leaseId ?? crypto.randomUUID(),
        sessionId: input.sessionId,
        actorId: input.actorId,
        acquiredAt: now,
        ttlMs: input.ttlMs ?? DEFAULT_VOICE_LEASE_TTL_MS,
        providerResumeHandle: current?.providerResumeHandle ?? null,
      });

      await upsert(lease, now);
      return { ok: true, lease };
    },

    async release(sessionId, actorId) {
      const now = new Date();
      const held = await requireActiveHolder(sessionId, actorId, now);
      if (!held.ok) return held;

      const released = releaseVoiceLease(held.lease);
      await upsert(released, now);
      return { ok: true, lease: released };
    },

    async getActive(sessionId) {
      const now = new Date();
      const current = await loadRow(sessionId);
      if (!current) return null;
      if (isVoiceLeaseActive(current, now)) return current;
      if (current.status === "active") {
        const expired = expireVoiceLease(current, now);
        await upsert(expired, now);
      }
      return null;
    },

    async setResumeHandle(sessionId, actorId, handle) {
      const now = new Date();
      const held = await requireActiveHolder(sessionId, actorId, now);
      if (!held.ok) return held;

      const next: VoiceLease = { ...held.lease, providerResumeHandle: handle };
      await upsert(next, now);
      return { ok: true, lease: next };
    },
  };
}
