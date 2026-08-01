/**
 * Controls whether deployed user apps receive a working CONNECTIONS service
 * binding that can list/invoke workspace connections.
 *
 * Credentials never enter the app isolate (they stay encrypted in WorkspaceDO
 * and are applied server-side), but a live CONNECTIONS binding lets apps pull
 * connection-backed data. On-prem self-host installs can set
 * CONNECTIONS_BINDING_ENABLED=false to hard-disable that broker.
 *
 * Default is enabled (unset / anything other than an explicit falsey value).
 * Chat-agent / js_exec / Connections UI surfaces are not gated by this flag.
 */

export const CONNECTIONS_BINDING_DISABLED_MESSAGE =
  "The CONNECTIONS binding is disabled for deployed apps on this deployment. Set CONNECTIONS_BINDING_ENABLED=true to allow deployed apps to call workspace connections.";

export const CONNECTIONS_BINDING_DISABLED_CODE = "CONNECTIONS_BINDING_DISABLED";

export interface ConnectionsBindingEnv {
  CONNECTIONS_BINDING_ENABLED?: string;
}

export function connectionsBindingEnabled(
  env?: ConnectionsBindingEnv | null,
): boolean {
  const raw = env?.CONNECTIONS_BINDING_ENABLED?.trim().toLowerCase();
  if (
    raw === "false" ||
    raw === "0" ||
    raw === "off" ||
    raw === "no" ||
    raw === "disabled"
  ) {
    return false;
  }
  return true;
}

export function assertConnectionsBindingEnabled(
  env?: ConnectionsBindingEnv | null,
): void {
  if (connectionsBindingEnabled(env)) return;
  throw Object.assign(new Error(CONNECTIONS_BINDING_DISABLED_MESSAGE), {
    status: 503,
    code: CONNECTIONS_BINDING_DISABLED_CODE,
  });
}
