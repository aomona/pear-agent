import type { VoiceTranscriptEntry } from "@pear-agent/core";

export type TranscriptTurn = {
  role: VoiceTranscriptEntry["role"];
  text: string;
};

/**
 * Live partials arrive as many short entries (「し」「たい」「時は、」…).
 * Merge same-role runs into readable turns:
 * - cumulative (new starts with prev) → take longer
 * - otherwise append as delta
 */
export function coalesceTranscript(entries: readonly VoiceTranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const entry of entries) {
    if (!entry.text) continue;
    if (entry.role === "status") {
      turns.push({ role: entry.role, text: entry.text });
      continue;
    }

    const last = turns[turns.length - 1];
    if (!last || last.role !== entry.role) {
      turns.push({ role: entry.role, text: entry.text });
      continue;
    }

    const prev = last.text;
    const next = entry.text;
    if (next === prev) continue;
    if (next.startsWith(prev)) {
      last.text = next;
      continue;
    }
    if (prev.startsWith(next) && next.length < prev.length) {
      continue;
    }
    if (prev.endsWith(next)) continue;
    last.text = prev + next;
  }
  return turns;
}
