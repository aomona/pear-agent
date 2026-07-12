const SESSION_KEY = "pear-outing-session";

export type StoredSession = {
  sessionId: string;
  /** Plan artifact this session was started from (if known). */
  planId: string | null;
};

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "sessionId" in parsed &&
      typeof (parsed as StoredSession).sessionId === "string" &&
      (parsed as StoredSession).sessionId.length > 0
    ) {
      const planId = (parsed as StoredSession).planId;
      return {
        sessionId: (parsed as StoredSession).sessionId,
        planId: typeof planId === "string" && planId.length > 0 ? planId : null,
      };
    }
    return null;
  } catch {
    // migrate legacy plain session id string
    try {
      const legacy = localStorage.getItem("pear-outing-session-id");
      if (legacy) {
        return { sessionId: legacy, planId: null };
      }
    } catch {
      // ignore
    }
    return null;
  }
}

export function storeSession(session: StoredSession | null): void {
  try {
    if (session) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.removeItem("pear-outing-session-id");
    } else {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem("pear-outing-session-id");
    }
  } catch {
    // ignore quota / private mode
  }
}

/** @deprecated Prefer {@link loadStoredSession} */
export function loadStoredSessionId(): string | null {
  return loadStoredSession()?.sessionId ?? null;
}

/** @deprecated Prefer {@link storeSession} */
export function storeSessionId(sessionId: string | null): void {
  if (!sessionId) {
    storeSession(null);
    return;
  }
  const existing = loadStoredSession();
  storeSession({ sessionId, planId: existing?.planId ?? null });
}
