import type { VoiceLease } from "@pear-agent/core";

/**
 * Structured Agent/HTTP results for voice lease ops.
 * Prefer these over throwing across DO RPC (custom Error subclasses strip).
 */
export type VoiceLeaseOk = { ok: true; lease: VoiceLease };

export type VoiceLeaseErr =
  | { ok: false; code: "conflict"; message: string; holderActorId: string }
  | { ok: false; code: "not_found"; message: string }
  | { ok: false; code: "session_not_found"; message: string };

export type VoiceLeaseResult = VoiceLeaseOk | VoiceLeaseErr;
