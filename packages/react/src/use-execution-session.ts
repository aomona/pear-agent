import { useCallback, useMemo, useState } from "react";

import type { AppendEventResult, RuntimeEvent } from "@pear-agent/core";

import type { CreateSessionResult, PearClient } from "./client.js";
import { usePearContext } from "./provider.js";
import type {
  AsyncStatus,
  CreateSessionInput,
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
 *
 * - **Unbound** (default): call `useExecutionSession()` with no argument, then
 *   `create()` / `setSessionId()`. Passing `null` is also unbound and does not
 *   wipe a session created via `create()`.
 * - **Controlled**: pass a `string` session id; the bound id tracks the prop.
 *
 * Concurrent actions share a single `status` / `error` (last write wins). Prefer
 * not overlapping mutations from the same hook instance.
 */
export function useExecutionSession(sessionId?: string | null): UseExecutionSessionResult {
  const { client } = usePearContext();
  const controlled = typeof sessionId === "string";
  const [unboundSessionId, setUnboundSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<AsyncStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const boundSessionId = controlled ? sessionId : unboundSessionId;

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

  const setSessionId = useCallback(
    (next: string | null) => {
      if (controlled) {
        throw new Error(
          "useExecutionSession is controlled by a string sessionId prop; change the prop instead of setSessionId()",
        );
      }
      setUnboundSessionId(next);
    },
    [controlled],
  );

  const create = useCallback(
    async (input: CreateSessionInput) => {
      return run(async () => {
        const result = await client.createSession(input);
        if (!controlled) {
          setUnboundSessionId(result.sessionId);
        }
        return result;
      });
    },
    [client, controlled, run],
  );

  const actions = useMemo(() => {
    const withSession =
      <A extends unknown[], R>(fn: (sessionId: string, ...args: A) => Promise<R>) =>
      (...args: A): Promise<R> => {
        const id = requireSessionId();
        return run(() => fn(id, ...args));
      };

    return {
      appendEvent: async (event: RuntimeEvent) => {
        const id = event.sessionId || requireSessionId();
        return run(() => client.appendEvent(id, event));
      },
      startSession: withSession((id, input?: Parameters<PearClient["startSession"]>[1]) =>
        client.startSession(id, input ?? {}),
      ),
      pauseSession: withSession((id, input?: Parameters<PearClient["pauseSession"]>[1]) =>
        client.pauseSession(id, input ?? {}),
      ),
      cancelSession: withSession((id, input?: Parameters<PearClient["cancelSession"]>[1]) =>
        client.cancelSession(id, input ?? {}),
      ),
      startStep: withSession((id, input: StepActionInput) => client.startStep(id, input)),
      completeStep: withSession((id, input: StepActionInput) => client.completeStep(id, input)),
      failStep: withSession((id, input: StepActionInput) => client.failStep(id, input)),
      pauseStep: withSession((id, input: StepActionInput) => client.pauseStep(id, input)),
      skipStep: withSession((id, input: StepActionInput) => client.skipStep(id, input)),
      startTimer: withSession((id, input: TimerStartInput) => client.startTimer(id, input)),
      pauseTimer: withSession((id, input: TimerActionInput) => client.pauseTimer(id, input)),
      completeTimer: withSession((id, input: TimerActionInput) => client.completeTimer(id, input)),
      cancelTimer: withSession((id, input: TimerActionInput) => client.cancelTimer(id, input)),
      reportDomainEvent: withSession((id, input: DomainEventInput) =>
        client.reportDomainEvent(id, input),
      ),
    };
  }, [client, requireSessionId, run]);

  return {
    sessionId: boundSessionId,
    status,
    error,
    client,
    create,
    setSessionId,
    ...actions,
    clearError: () => setError(null),
  };
}
