import { createContext, useContext, useMemo, type ReactNode } from "react";

import { PearClient, type PearClientOptions } from "./client.js";
import type { PearClientContext } from "./types.js";

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
};

const PearReactContext = createContext<PearContextValue | null>(null);

export function PearProvider(props: PearProviderProps) {
  const {
    baseUrl,
    getContext,
    children,
    realtime = true,
    agentName = DEFAULT_AGENT_NAME,
    fetch: fetchImpl,
    client: injectedClient,
  } = props;

  const value = useMemo<PearContextValue>(() => {
    const clientOptions: PearClientOptions = {
      baseUrl,
      getContext,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    };
    return {
      client: injectedClient ?? new PearClient(clientOptions),
      baseUrl,
      getContext,
      realtime,
      agentName,
    };
  }, [baseUrl, getContext, realtime, agentName, fetchImpl, injectedClient]);

  return <PearReactContext.Provider value={value}>{children}</PearReactContext.Provider>;
}

export function usePearContext(): PearContextValue {
  const value = useContext(PearReactContext);
  if (!value) {
    throw new Error("PEAR hooks must be used within <PearProvider>");
  }
  return value;
}
