import type { PlanPatch } from "@pear-agent/core";

export function causeKey(
  domainVersion: number,
  normalizedInputRevision: number | null,
  eventIds: readonly string[],
): string {
  return JSON.stringify([domainVersion, normalizedInputRevision, [...new Set(eventIds)].sort()]);
}

export function attemptKey(
  domainVersion: number,
  normalizedInputRevision: number | null,
  patch: PlanPatch,
): string {
  return JSON.stringify([
    causeKey(domainVersion, normalizedInputRevision, patch.causeEventIds),
    patch.basePlanId,
    patch.basePlanVersion,
    patch.baseLastEventId,
  ]);
}

export function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(right);
  return left.length === expected.size && left.every((id) => expected.has(id));
}
