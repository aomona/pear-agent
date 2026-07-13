import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { PearClient } from "./client.js";
import { PEAR_CONTEXT_QUERY_KEY } from "./context-wire.js";
import type { PearClientContext } from "./types.js";

export { PEAR_CONTEXT_QUERY_KEY };

/** Default kebab-case name for `ExecutionSessionAgent`. */
export const DEFAULT_AGENT_NAME = "execution-session-agent";

export type PearProviderProps = {
  /** Worker origin for HTTP API and Agent WebSocket host. */
  baseUrl: string;
  /** Resolves host authentication into PEAR request context. */
  getContext: () => PearClientContext | Promise<PearClientContext>;
  children: ReactNode;
  /**
   * When true (default), hooks open an Agents SDK WebSocket for snapshot sync.
   * Set false in unit tests or environments without `agents` peer installed.
   */
  realtime?: boolean;
  /** Agent class path segment; default `execution-session-agent`. */
  agentName?: string;
  /**
   * Force `wss` (true) or `ws` (false). Defaults from `baseUrl` protocol
   * (`https` → secure, `http` → insecure).
   */
  agentSecure?: boolean;
  fetch?: typeof fetch;
  /** Inject a prebuilt client (tests). When set, baseUrl/getContext still used for agent host. */
  client?: PearClient;
};

export type PearContextValue = {
  client: PearClient;
  baseUrl: string;
  getContext: () => PearClientContext | Promise<PearClientContext>;
  realtime: boolean;
  agentName: string;
  /** Whether Agent WebSockets use TLS (`wss`). */
  agentSecure: boolean;
};

const PearReactContext = createContext<PearContextValue | null>(null);

function deriveAgentSecure(baseUrl: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:";
  } catch {
    return !baseUrl.startsWith("http://");
  }
}

export function PearProvider(props: PearProviderProps) {
  const {
    baseUrl,
    getContext,
    children,
    realtime = true,
    agentName = DEFAULT_AGENT_NAME,
    agentSecure: agentSecureProp,
    fetch: fetchImpl,
    client: injectedClient,
  } = props;

  const getContextRef = useRef(getContext);
  useLayoutEffect(() => {
    getContextRef.current = getContext;
  }, [getContext]);

  const stableGetContext = useCallback(() => getContextRef.current(), []);

  const ownedClient = useMemo(() => {
    if (injectedClient) return null;
    return new PearClient({
      baseUrl,
      getContext: stableGetContext,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
  }, [baseUrl, fetchImpl, injectedClient, stableGetContext]);

  useLayoutEffect(() => {
    if (!injectedClient) return;
    injectedClient.setGetContext(stableGetContext);
  }, [injectedClient, stableGetContext]);

  const agentSecure = deriveAgentSecure(baseUrl, agentSecureProp);

  const value = useMemo<PearContextValue>(() => {
    const client = injectedClient ?? ownedClient;
    if (!client) {
      throw new Error("PearProvider requires a client or enough props to create one");
    }
    return {
      client,
      baseUrl,
      getContext: stableGetContext,
      realtime,
      agentName,
      agentSecure,
    };
  }, [injectedClient, ownedClient, baseUrl, stableGetContext, realtime, agentName, agentSecure]);

  return <PearReactContext.Provider value={value}>{children}</PearReactContext.Provider>;
}

export function usePearContext(): PearContextValue {
  const value = useContext(PearReactContext);
  if (!value) {
    throw new Error("PEAR hooks must be used within <PearProvider>");
  }
  return value;
}
