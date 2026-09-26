import { isAppCustomDomainReady } from './app-url';

export const CUSTOM_DOMAIN_REFRESH_INTERVAL_MS = 60 * 1000;
export const CUSTOM_DOMAIN_PENDING_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

interface AppCustomDomainBaseState {
  script_name: string;
  custom_domain_hostname: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
}

export interface AppCustomDomainRefreshState extends AppCustomDomainBaseState {
  custom_domain_updated_at: number | null;
}

export interface AppCustomDomainProvisioningState extends AppCustomDomainRefreshState {
  custom_domain_cf_hostname_id: string | null;
  custom_domain_error: string | null;
}

export function shouldRefreshAppCustomDomainState(
  app: AppCustomDomainRefreshState,
  orgCustomDomain: string | null | undefined,
  now: number,
  refreshIntervalMs = CUSTOM_DOMAIN_REFRESH_INTERVAL_MS
): boolean {
  void orgCustomDomain;
  if (!app.custom_domain_hostname || isAppCustomDomainReady(app)) {
    return false;
  }

  if (!app.custom_domain_updated_at) {
    return true;
  }

  return now - app.custom_domain_updated_at >= refreshIntervalMs;
}

export function shouldRetryAppCustomDomainProvisioning(
  app: AppCustomDomainProvisioningState,
  orgCustomDomain: string | null | undefined,
  now = Date.now(),
  pendingRetryAfterMs = CUSTOM_DOMAIN_PENDING_RETRY_AFTER_MS
): boolean {
  void orgCustomDomain;
  if (!app.custom_domain_hostname || isAppCustomDomainReady(app)) {
    return false;
  }

  return (
    !app.custom_domain_cf_hostname_id ||
    !!app.custom_domain_error ||
    !app.custom_domain_status ||
    !app.custom_domain_ssl_status ||
    (app.custom_domain_status === 'active' &&
      app.custom_domain_ssl_status !== 'active') ||
    app.custom_domain_status === 'deleted' ||
    app.custom_domain_status === 'failed' ||
    app.custom_domain_status === 'moved' ||
    app.custom_domain_ssl_status === 'expired' ||
    app.custom_domain_ssl_status === 'failed' ||
    (!!app.custom_domain_updated_at &&
      now - app.custom_domain_updated_at >= pendingRetryAfterMs)
  );
}

export function getAppCustomDomainDiagnosticState(
  app: AppCustomDomainProvisioningState,
  orgCustomDomain: string | null | undefined
): {
  hostname: string | null;
  cf_hostname_id: string | null;
  status: string | null;
  ssl_status: string | null;
  error: string | null;
  updated_at: number | null;
} {
  void orgCustomDomain;
  if (!app.custom_domain_hostname) {
    return {
      hostname: app.custom_domain_hostname ?? null,
      cf_hostname_id: app.custom_domain_cf_hostname_id ?? null,
      status: app.custom_domain_status ?? null,
      ssl_status: app.custom_domain_ssl_status ?? null,
      error: app.custom_domain_error ?? null,
      updated_at: app.custom_domain_updated_at ?? null,
    };
  }

  return {
    hostname: app.custom_domain_hostname,
    cf_hostname_id: app.custom_domain_cf_hostname_id ?? null,
    status: app.custom_domain_status ?? null,
    ssl_status: app.custom_domain_ssl_status ?? null,
    error: app.custom_domain_error ?? null,
    updated_at: app.custom_domain_updated_at ?? null,
  };
}
