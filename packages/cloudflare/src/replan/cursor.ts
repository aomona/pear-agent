import { parseRuntimeEvent } from "../serialize.js";

export { isReplanNonOperationalEventType, lastOperationalEventId } from "@pear-agent/core";

export async function currentReplanBaseEventId(
  d1: D1Database,
  sessionId: string,
): Promise<string | null> {
  const row = await d1
    .prepare(
      `SELECT id FROM runtime_events
       WHERE session_id = ?
         AND json_extract(event_json, '$.type') NOT IN ('replan_proposed', 'replan_failed', 'plan_updated')
         AND json_extract(event_json, '$.type') NOT LIKE 'continuation_%'
       ORDER BY rowid DESC LIMIT 1`,
    )
    .bind(sessionId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** True when events after the base cursor are only pause/interruption for the proposed active steps. */
export async function hasOnlyInterruptionEventsSinceBase(
  d1: D1Database,
  sessionId: string,
  baseEventId: string | null,
  activeStepIds: readonly string[],
): Promise<boolean> {
  const rows = await d1
    .prepare("SELECT id, event_json FROM runtime_events WHERE session_id = ? ORDER BY rowid ASC")
    .bind(sessionId)
    .all<{ id: string; event_json: string }>();
  const events = rows.results;
  const baseIndex = baseEventId === null ? -1 : events.findIndex(({ id }) => id === baseEventId);
  if (baseEventId !== null && baseIndex < 0) return false;
  const allowedSteps = new Set(activeStepIds);
  return events.slice(baseIndex + 1).every(({ event_json: eventJson }) => {
    const event = parseRuntimeEvent(eventJson);
    if (event.type === "replan_proposed" || event.type === "replan_failed") return true;
    if (event.type.startsWith("continuation_")) return true;
    if (event.type === "session_paused") return true;
    if (event.type === "timer_paused" || event.type === "timer_cancelled") return true;
    return event.type === "step_paused" && allowedSteps.has(event.payload.stepId);
  });
}
