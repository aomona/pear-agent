import { useCallback, useState } from "react";

import type { AppendEventResult, RuntimeEvent } from "@pear-agent/core";

import type { PearClient } from "./client.js";
import { usePearContext } from "./provider.js";
import type {
  AsyncStatus,
  CreateSessionInput,
  CreateSessionResult,
  DomainEventInput,
  StepActionInput,
  TimerActionInput,
  TimerStartInput,
} from "./types.js";

export type UseExecutionSessionResult = {
  sessionId: string | null;
  status: AsyncStatus;
  error: Error | null;
  client: PearClient;
  create: (input: CreateSessionInput) => Promise<CreateSessionResult>;
  setSessionId: (sessionId: string | null) => void;
  appendEvent: (event: RuntimeEvent) => Promise<AppendEventResult>;
  startSession: (input?: Parameters<PearClient["startSession"]>[1]) => Promise<AppendEventResult>;
  pauseSession: (input?: Parameters<PearClient["pauseSession"]>[1]) => Promise<AppendEventResult>;
  cancelSession: (input?: Parameters<PearClient["cancelSession"]>[1]) => Promise<AppendEventResult>;
  startStep: (input: StepActionInput) => Promise<AppendEventResult>;
  completeStep: (input: StepActionInput) => Promise<AppendEventResult>;
  failStep: (input: StepActionInput) => Promise<AppendEventResult>;
  pauseStep: (input: StepActionInput) => Promise<AppendEventResult>;
  skipStep: (input: StepActionInput) => Promise<AppendEventResult>;
  startTimer: (input: TimerStartInput) => Promise<AppendEventResult>;
  pauseTimer: (input: TimerActionInput) => Promise<AppendEventResult>;
  completeTimer: (input: TimerActionInput) => Promise<AppendEventResult>;
  cancelTimer: (input: TimerActionInput) => Promise<AppendEventResult>;
  reportDomainEvent: (input: DomainEventInput) => Promise<AppendEventResult>;
  clearError: () => void;
};

/**
 * Session-scoped actions against the typed Worker client.
 * Pass `sessionId` to bind, or call `create` / `setSessionId` later.
 */
export function useExecutionSession(sessionId?: string | null): UseExecutionSessionResult {
  const { client } = usePearContext();
  const [boundSessionId, setBoundSessionId] = useState<string | null>(sessionId ?? null);
  const [status, setStatus] = useState<AsyncStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  // Keep bound id in sync when the caller-controlled prop changes.
  if (sessionId !== undefined && sessionId !== boundSessionId) {
    setBoundSessionId(sessionId);
  }

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    setStatus("loading");
    setError(null);
    try {
      const result = await fn();
      setStatus("success");
      return result;
    } catch (caught) {
      const next = caught instanceof Error ? caught : new Error(String(caught));
      setError(next);
      setStatus("error");
      throw next;
    }
  }, []);

  const requireSessionId = useCallback((): string => {
    if (!boundSessionId) {
      throw new Error("No sessionId bound. Call create() or setSessionId() first.");
    }
    return boundSessionId;
  }, [boundSessionId]);

  const create = useCallback(
    async (input: CreateSessionInput) => {
      return run(async () => {
        const result = await client.createSession(input);
        setBoundSessionId(result.sessionId);
        return result;
      });
    },
    [client, run],
  );

  const appendEvent = useCallback(
    async (event: RuntimeEvent) => {
      const id = event.sessionId || requireSessionId();
      return run(() => client.appendEvent(id, event));
    },
    [client, requireSessionId, run],
  );

  const startSession = useCallback(
    async (input?: Parameters<PearClient["startSession"]>[1]) => {
      const id = requireSessionId();
      return run(() => client.startSession(id, input ?? {}));
    },
    [client, requireSessionId, run],
  );

  const pauseSession = useCallback(
    async (input?: Parameters<PearClient["pauseSession"]>[1]) => {
      const id = requireSessionId();
      return run(() => client.pauseSession(id, input ?? {}));
    },
    [client, requireSessionId, run],
  );

  const cancelSession = useCallback(
    async (input?: Parameters<PearClient["cancelSession"]>[1]) => {
      const id = requireSessionId();
      return run(() => client.cancelSession(id, input ?? {}));
    },
    [client, requireSessionId, run],
  );

  const startStep = useCallback(
    async (input: StepActionInput) => {
      const id = requireSessionId();
      return run(() => client.startStep(id, input));
    },
    [client, requireSessionId, run],
  );

  const completeStep = useCallback(
    async (input: StepActionInput) => {
      const id = requireSessionId();
      return run(() => client.completeStep(id, input));
    },
    [client, requireSessionId, run],
  );

  const failStep = useCallback(
    async (input: StepActionInput) => {
      const id = requireSessionId();
      return run(() => client.failStep(id, input));
    },
    [client, requireSessionId, run],
  );

  const pauseStep = useCallback(
    async (input: StepActionInput) => {
      const id = requireSessionId();
      return run(() => client.pauseStep(id, input));
    },
    [client, requireSessionId, run],
  );

  const skipStep = useCallback(
    async (input: StepActionInput) => {
      const id = requireSessionId();
      return run(() => client.skipStep(id, input));
    },
    [client, requireSessionId, run],
  );

  const startTimer = useCallback(
    async (input: TimerStartInput) => {
      const id = requireSessionId();
      return run(() => client.startTimer(id, input));
    },
    [client, requireSessionId, run],
  );

  const pauseTimer = useCallback(
    async (input: TimerActionInput) => {
      const id = requireSessionId();
      return run(() => client.pauseTimer(id, input));
    },
    [client, requireSessionId, run],
  );

  const completeTimer = useCallback(
    async (input: TimerActionInput) => {
      const id = requireSessionId();
      return run(() => client.completeTimer(id, input));
    },
    [client, requireSessionId, run],
  );

  const cancelTimer = useCallback(
    async (input: TimerActionInput) => {
      const id = requireSessionId();
      return run(() => client.cancelTimer(id, input));
    },
    [client, requireSessionId, run],
  );

  const reportDomainEvent = useCallback(
    async (input: DomainEventInput) => {
      const id = requireSessionId();
      return run(() => client.reportDomainEvent(id, input));
    },
    [client, requireSessionId, run],
  );

  return {
    sessionId: boundSessionId,
    status,
    error,
    client,
    create,
    setSessionId: setBoundSessionId,
    appendEvent,
    startSession,
    pauseSession,
    cancelSession,
    startStep,
    completeStep,
    failStep,
    pauseStep,
    skipStep,
    startTimer,
    pauseTimer,
    completeTimer,
    cancelTimer,
    reportDomainEvent,
    clearError: () => setError(null),
  };
}
