const SESSION_KEY = "pear-outing-session-id";

export function loadStoredSessionId(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function storeSessionId(sessionId: string | null): void {
  try {
    if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage may be unavailable or over quota.
  }
}
