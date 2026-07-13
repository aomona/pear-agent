const SESSION_KEY = "pear-outing-session:v1";
const LEGACY_SESSION_KEYS = ["pear-outing-session", "pear-outing-session-id"] as const;

export type StoredSession = {
  sessionId: string;
  /** Plan artifact this session was started from (if known). */
  planId: string | null;
};

function parseSession(raw: string): StoredSession | null {
  try {
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
  } catch {
    // ignore
  }
  return null;
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = parseSession(raw);
      if (parsed) return parsed;
    }
    // migrate legacy keys
    for (const key of LEGACY_SESSION_KEYS) {
      const legacy = localStorage.getItem(key);
      if (!legacy) continue;
      if (key === "pear-outing-session-id") {
        return { sessionId: legacy, planId: null };
      }
      const parsed = parseSession(legacy);
      if (parsed) return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function storeSession(session: StoredSession | null): void {
  try {
    if (session) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      for (const key of LEGACY_SESSION_KEYS) {
        localStorage.removeItem(key);
      }
    } else {
      localStorage.removeItem(SESSION_KEY);
      for (const key of LEGACY_SESSION_KEYS) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage may be unavailable or over quota.
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
