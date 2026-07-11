export { PearClient, type CreateSessionResult, type PearClientOptions } from "./client.js";
export {
  PEAR_CONTEXT_HEADER,
  PEAR_CONTEXT_QUERY_KEY,
  serializePearClientContext,
} from "./context-wire.js";
export { PearClientError } from "./errors.js";
export {
  DEFAULT_AGENT_NAME,
  PearProvider,
  usePearContext,
  type PearContextValue,
  type PearProviderProps,
} from "./provider.js";
export { useExecutionSession, type UseExecutionSessionResult } from "./use-execution-session.js";
export {
  useRuntimeSnapshot,
  type UseRuntimeSnapshotOptions,
  type UseRuntimeSnapshotResult,
} from "./use-runtime-snapshot.js";
export { useContinuation, type UseContinuationResult } from "./use-continuation.js";
export {
  useVoiceSession,
  FakeVoiceProvider,
  GeminiLiveVoiceProvider,
  type UseVoiceSessionOptions,
  type UseVoiceSessionResult,
} from "./use-voice-session.js";
export type {
  AppendEventInput,
  AsyncStatus,
  ConnectionStatus,
  CreateSessionInput,
  DomainEventInput,
  ExecutionContinuationStub,
  ExecutionSessionSyncState,
  ParsedSyncPulse,
  PearClientContext,
  StepActionInput,
  TimerActionInput,
  TimerStartInput,
} from "./types.js";
export {
  parseAppendEventResult,
  parseExecutionContinuation,
  parseMaterializedState,
  parseRuntimeEvent,
  parseRuntimeSnapshot,
  parseSyncState,
  parseVoiceLease,
  parseVoiceLeaseOrNull,
} from "./parse.js";
