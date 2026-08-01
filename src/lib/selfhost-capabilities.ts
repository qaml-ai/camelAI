import {
  CONNECTIONS_BINDING_DISABLED_MESSAGE,
  connectionsBindingEnabled,
  type ConnectionsBindingEnv,
} from "./connections-binding";

export const SELFHOST_CAPABILITY_CONTRACT_VERSION = 3;

export const SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE =
  "Outbound email is disabled in self-host mode. No SMTP transport is implemented.";

export const SELFHOST_PASSWORD_SIGNUP_DISABLED_MESSAGE =
  "Password signup is disabled in self-host mode because email verification cannot be delivered. Use the configured enterprise identity provider.";

export const SELFHOST_EMAIL_VERIFICATION_DISABLED_MESSAGE =
  "Email verification delivery is disabled in self-host mode. Use the configured enterprise identity provider.";

export const SELFHOST_HELP_EMAIL_DISABLED_MESSAGE =
  "Email-based support requests are disabled in self-host mode. Contact your deployment administrator.";

export { CONNECTIONS_BINDING_DISABLED_MESSAGE };
export type SelfhostCapabilityState =
  | "configured"
  | "disabled"
  | "unavailable";

export interface SelfhostCapabilityVerification {
  status: "not_checked";
  command: string;
  message: string;
}

export interface SelfhostCapability {
  state: SelfhostCapabilityState;
  /**
   * null means the feature is configured but runtime execution has not been
   * exercised by the lightweight readiness probe.
   */
  available: boolean | null;
  configured?: boolean;
  implementation?: string;
  reason?: string;
  verification?: SelfhostCapabilityVerification;
}

export interface SelfhostCapabilityContract {
  version: typeof SELFHOST_CAPABILITY_CONTRACT_VERSION;
  features: {
    project_builds: SelfhostCapability;
    project_deploys: SelfhostCapability;
    notebooks: SelfhostCapability;
    sql: SelfhostCapability;
    connections_binding: SelfhostCapability;
    outbound_email: SelfhostCapability;
    smtp: SelfhostCapability;
  };
}

export interface SelfhostComputeBindings {
  projectBuild: boolean;
  analysis: boolean;
  databaseQuery: boolean;
}

export interface SelfhostCapabilityOptions extends ConnectionsBindingEnv {
  projectBuild: boolean;
  analysis: boolean;
  databaseQuery: boolean;
}
function localDockerCapability(
  bindingAvailable: boolean,
  bindingName: string,
  verificationCommand: string,
): SelfhostCapability {
  return bindingAvailable
    ? {
        state: "configured",
        available: null,
        configured: true,
        implementation: "workerd-local-docker",
        verification: {
          status: "not_checked",
          command: verificationCommand,
          message:
            "Readiness confirms the namespace is configured; run the deep smoke command to verify Docker execution.",
        },
      }
    : {
        state: "unavailable",
        available: false,
        configured: false,
        implementation: "workerd-local-docker",
        reason: `${bindingName} is not configured.`,
      };
}

export function getSelfhostCapabilityContract(
  bindings: SelfhostComputeBindings | SelfhostCapabilityOptions,
): SelfhostCapabilityContract {
  const connectionsEnabled = connectionsBindingEnabled(bindings);
  return {
    version: SELFHOST_CAPABILITY_CONTRACT_VERSION,
    features: {
      project_builds: localDockerCapability(
        bindings.projectBuild,
        "PROJECT_BUILD_SANDBOX",
        "bun run selfhost:container:smoke:project",
      ),
      project_deploys: localDockerCapability(
        bindings.projectBuild,
        "PROJECT_BUILD_SANDBOX",
        "bun run selfhost:container:smoke:project",
      ),
      notebooks: localDockerCapability(
        bindings.analysis,
        "ANALYSIS_SANDBOX",
        "bun run selfhost:container:smoke:analysis",
      ),
      sql: localDockerCapability(
        bindings.databaseQuery,
        "DB_QUERY_SANDBOX",
        "bun run selfhost:container:smoke:db-query",
      ),
      connections_binding: connectionsEnabled
        ? {
            state: "configured",
            available: true,
            configured: true,
            implementation: "ConnectionsService",
          }
        : {
            state: "disabled",
            available: false,
            configured: false,
            reason: CONNECTIONS_BINDING_DISABLED_MESSAGE,
          },
      outbound_email: {
        state: "disabled",
        available: false,
        reason: SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE,
      },
      smtp: {
        state: "disabled",
        available: false,
        reason:
          "SMTP is reserved as a future self-host transport and is not implemented.",
      },
    },
  };
}
