import { useEffect, useRef } from "react";

import {
  SseAgentClient,
  type AgentSseConnectionError,
  type SseAgentCloseEvent,
  type SseAgentMessageEvent,
  type SseAgentOpenEvent,
  type SseAgentQuery,
} from "./sse-agent-client";

/**
 * `useAgent` replacement backed by SSE + POST (see sse-agent-client.ts).
 *
 * Identity rules are load-bearing: the returned client is referentially stable
 * across renders (it is an effect dep in Chat.tsx and useAgentChat, and
 * `transport.setAgent` compares by identity) and is REPLACED by a new object
 * when the address or enablement changes, which is what makes useAgentChat drop
 * its resume state for the old connection.
 *
 * Lifecycle callbacks are read through a ref at dispatch time, so re-rendering
 * with new closures never churns the connection.
 */

export interface UseSseAgentOptions<State = unknown> {
  agent: string;
  name: string;
  enabled?: boolean;
  query?: SseAgentQuery;
  defaultCallTimeout?: number;
  onOpen?: (event: SseAgentOpenEvent) => void;
  onMessage?: (event: SseAgentMessageEvent) => void;
  onClose?: (event: SseAgentCloseEvent) => void;
  onError?: (error: unknown) => void;
  onConnectionError?: (error: AgentSseConnectionError) => void;
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  onStateUpdateError?: (error: unknown) => void;
  onMcpUpdate?: (mcp: unknown) => void;
  onIdentity?: (name: string, agent: string) => void;
}

export function useSseAgent<State = unknown>(
  options: UseSseAgentOptions<State>,
): SseAgentClient<State> {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled ?? true;
  const identityKey = JSON.stringify([options.agent, options.name, enabled]);
  const clientRef = useRef<{
    key: string;
    client: SseAgentClient<State>;
  } | null>(null);

  if (!clientRef.current || clientRef.current.key !== identityKey) {
    clientRef.current = {
      key: identityKey,
      client: new SseAgentClient<State>({
        agent: options.agent,
        name: options.name,
        query: optionsRef.current.query,
        defaultCallTimeout: optionsRef.current.defaultCallTimeout,
        onOpen: (event) => optionsRef.current.onOpen?.(event),
        onMessage: (event) => optionsRef.current.onMessage?.(event),
        onClose: (event) => optionsRef.current.onClose?.(event),
        onError: (error) => optionsRef.current.onError?.(error),
        onConnectionError: (error) =>
          optionsRef.current.onConnectionError?.(error),
        onStateUpdate: (state, source) =>
          optionsRef.current.onStateUpdate?.(state, source),
        onStateUpdateError: (error) =>
          optionsRef.current.onStateUpdateError?.(error),
        onMcpUpdate: (mcp) => optionsRef.current.onMcpUpdate?.(mcp),
        onIdentity: (name, agent) => optionsRef.current.onIdentity?.(name, agent),
      }),
    };
  }

  const client = clientRef.current.client;
  // Query values can resolve after mount (workspaceId); the client reads them at
  // attach time, so keeping them current does not disturb identity.
  client.query = options.query ?? {};

  useEffect(() => {
    if (!enabled) return;
    client.start();
    return () => {
      client.close();
    };
  }, [client, enabled]);

  return client;
}
