/**
 * Historical Workers for Platforms integration environment variable mapping.
 * Used to hydrate the redacted bindings in migrated app bundles.
 *
 * Env vars are namespaced with INT_<TYPE>_<NAME>_ to support multiple connections
 * of the same type and prevent collisions between different types.
 *
 * Example: Stripe integration named "Production" → INT_STRIPE_PRODUCTION_API_KEY
 * Example: Notion integration named "Production" → INT_NOTION_PRODUCTION_API_KEY
 */

/**
 * Dynamic field definition used by legacy `other` integrations.
 */
export interface DynamicFieldForEnv {
  name: string;
  label: string;
  type: 'password' | 'text' | 'url' | 'number';
  required: boolean;
  placeholder?: string;
  description?: string;
}

/**
 * Get the env var suffixes that will be generated for a given integration type.
 * Used to inform users/agents what env vars will be available.
 *
 * @param integrationType - The integration type (e.g., "stripe", "other")
 * @param dynamicFields - Optional: For "other" type, the dynamic field definitions
 */
export function getEnvVarSuffixesForType(integrationType: string, dynamicFields?: DynamicFieldForEnv[]): string[] {
  // For "other" type with dynamic fields, generate suffixes from field names
  if (integrationType === 'other' && dynamicFields && dynamicFields.length > 0) {
    return dynamicFields.map(f => normalizeEnvVarName(f.name));
  }

  switch (integrationType) {
    case 'stripe':
      return ['API_KEY', 'SECRET_KEY'];
    case 'openai':
      return ['API_KEY', 'ORGANIZATION_ID'];
    case 'anthropic':
      return ['API_KEY'];
    case 'supabase':
      return ['API_KEY', 'PROJECT_URL', 'KEY_TYPE'];
    case 'databricks':
      return ['API_KEY', 'WORKSPACE_URL'];
    case 'sentry':
      return ['API_KEY', 'ORGANIZATION'];
    case 'mailchimp':
      return ['API_KEY', 'DATA_CENTER'];
    case 'posthog':
      return ['API_KEY', 'HOST', 'PROJECT_ID'];
    case 'mixpanel':
      return ['USERNAME', 'SECRET', 'PROJECT_ID', 'REGION'];
    case 'linear':
    case 'sendgrid':
    case 'airtable':
    case 'hubspot':
      return ['API_KEY'];
    case 'github':
      return ['TOKEN'];
    case 'notion':
      return ['API_KEY', 'WORKSPACE_ID', 'WORKSPACE_NAME'];
    case 'slack':
      return ['BOT_TOKEN', 'TEAM_ID', 'TEAM_NAME'];
    case 'twilio':
      return ['ACCOUNT_SID', 'AUTH_TOKEN'];
    case 'salesforce':
      return ['ACCESS_TOKEN', 'INSTANCE_URL'];
    case 'aws':
      return ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION'];
    case 'postgres':
      return ['DATABASE_URL', 'URL'];
    case 'mysql':
      return ['URL', 'DATABASE_URL'];
    case 'mongodb':
      return ['URL', 'URI', 'DATA_API_URL', 'DATA_API_KEY'];
    case 'redis':
      return ['URL', 'REST_URL', 'REST_TOKEN'];
    case 'bigquery':
      return ['ACCESS_TOKEN', 'PROJECT_ID'];
    // Database integrations
    case 'neon':
      return ['API_KEY', 'CONNECTION_STRING', 'PROJECT_ID'];
    case 'snowflake':
      return ['ACCOUNT', 'WAREHOUSE', 'DATABASE', 'SCHEMA', 'USERNAME', 'PRIVATE_KEY', 'PRIVATE_KEY_PASSPHRASE', 'PRIVATE_KEY_FINGERPRINT'];
    case 'clickhouse':
      return ['HOST', 'PORT', 'DATABASE', 'USERNAME', 'PASSWORD'];
    case 'planetscale':
      return ['TOKEN_ID', 'TOKEN_SECRET', 'CONNECTION_STRING', 'ORGANIZATION', 'DATABASE'];
    case 'turso':
      return ['DATABASE_URL', 'AUTH_TOKEN'];
    // SaaS integrations
    case 'openrouter':
    case 'typeform':
    case 'asana':
    case 'figma':
    case 'intercom':
    case 'netlify':
      return ['API_KEY'];
    case 'jira':
      return ['API_TOKEN', 'EMAIL', 'DOMAIN'];
    case 'zendesk':
      return ['API_TOKEN', 'EMAIL', 'SUBDOMAIN'];
    case 'segment':
      return ['WRITE_KEY'];
    case 'amplitude':
      return ['API_KEY', 'SECRET_KEY', 'REGION'];
    case 'discord':
      return ['BOT_TOKEN', 'APPLICATION_ID'];
    case 'teams':
      return ['TENANT_ID', 'CLIENT_ID', 'CLIENT_SECRET'];
    // Cloud providers
    case 'gcp':
      return ['SERVICE_ACCOUNT_JSON', 'PROJECT_ID'];
    case 'azure':
      return ['TENANT_ID', 'SUBSCRIPTION_ID', 'CLIENT_ID', 'CLIENT_SECRET'];
    case 'vercel':
      return ['API_KEY', 'TEAM_ID'];
    case 'cloudflare':
      return ['API_TOKEN', 'ACCOUNT_ID'];
    // Commerce
    case 'shopify':
      return ['ACCESS_TOKEN', 'SHOP_DOMAIN'];
    case 'square':
      return ['ACCESS_TOKEN', 'ENVIRONMENT'];
    case 'other':
      return ['API_KEY', 'API_SECRET', 'CLIENT_ID', 'CLIENT_SECRET', 'BASE_URL'];
    case 'remote_mcp':
      return [];
    default:
      return ['API_KEY'];
  }
}

/**
 * Normalize an integration name to a valid env var prefix.
 * - Converts to uppercase
 * - Replaces non-alphanumeric chars with underscores
 * - Collapses multiple underscores
 * - Trims leading/trailing underscores
 */
export function normalizeEnvVarName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export function getIntegrationEnvVarPrefix(integrationName: string, integrationType: string): string {
  return `INT_${normalizeEnvVarName(integrationType)}_${normalizeEnvVarName(integrationName)}_`;
}

/**
 * Map integration credentials and config to environment variables.
 * Returns vars prefixed with INT_<TYPE>_<NORMALIZED_NAME>_ for namespacing.
 *
 * Including the type in the prefix prevents collisions when different
 * integration types have the same name (e.g., "Production" for both
 * Stripe and Notion would otherwise both create INT_PRODUCTION_API_KEY).
 *
 * @param integrationName - User-provided name for the integration (e.g., "My Stripe Account")
 * @param integrationType - Integration type (e.g., "stripe", "postgres")
 * @param credentials - Decrypted credentials
 * @param config - Integration config (may include dynamic_fields for "other" type)
 */
export function mapCredentialsToEnvVars(
  integrationName: string,
  integrationType: string,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>
): Record<string, string> {
  const env: Record<string, string> = {};
  const prefix = getIntegrationEnvVarPrefix(integrationName, integrationType);

  // Helper to safely get string value
  const str = (val: unknown): string | null => {
    if (val === undefined || val === null || val === '') return null;
    return String(val);
  };

  // Helper to set env var with INT_<TYPE>_<NAME>_ namespace
  const set = (suffix: string, value: string) => {
    env[`${prefix}${suffix}`] = value;
  };

  switch (integrationType) {
    case 'stripe':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(credentials.api_key)) set('SECRET_KEY', str(credentials.api_key)!);
      break;

    case 'openai':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.organization_id)) set('ORGANIZATION_ID', str(config.organization_id)!);
      break;

    case 'anthropic':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'supabase':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.project_url)) set('PROJECT_URL', str(config.project_url)!);
      if (str(config.key_type)) set('KEY_TYPE', str(config.key_type)!);
      break;

    case 'databricks':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.workspace_url)) set('WORKSPACE_URL', str(config.workspace_url)!);
      break;

    case 'sentry':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.organization)) set('ORGANIZATION', str(config.organization)!);
      break;

    case 'mailchimp':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.data_center)) set('DATA_CENTER', str(config.data_center)!);
      break;

    case 'posthog':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.host)) set('HOST', str(config.host)!);
      if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
      break;

    case 'mixpanel':
      if (str(credentials.api_key)) set('USERNAME', str(credentials.api_key)!);
      if (str(credentials.api_secret)) set('SECRET', str(credentials.api_secret)!);
      if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
      if (str(config.region)) set('REGION', str(config.region)!);
      break;

    case 'github':
      if (str(credentials.api_key)) set('TOKEN', str(credentials.api_key)!);
      break;

    case 'notion':
      // OAuth flow stores access_token, fall back to api_key for manual entry
      if (str(credentials.access_token)) set('API_KEY', str(credentials.access_token)!);
      else if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      // Expose workspace info if available (from OAuth)
      if (str(credentials.notion_workspace_id)) set('WORKSPACE_ID', str(credentials.notion_workspace_id)!);
      if (str(credentials.notion_workspace_name)) set('WORKSPACE_NAME', str(credentials.notion_workspace_name)!);
      // Note: refresh_token and expires_at are intentionally NOT exposed to containers
      break;

    case 'slack':
      // OAuth flow stores access_token, fall back to api_key for manual entry
      if (str(credentials.access_token)) set('BOT_TOKEN', str(credentials.access_token)!);
      else if (str(credentials.api_key)) set('BOT_TOKEN', str(credentials.api_key)!);
      // Also expose team info if available
      if (str(credentials.team_id)) set('TEAM_ID', str(credentials.team_id)!);
      if (str(credentials.team_name)) set('TEAM_NAME', str(credentials.team_name)!);
      break;

    case 'linear':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'sendgrid':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'twilio':
      if (str(credentials.account_sid)) set('ACCOUNT_SID', str(credentials.account_sid)!);
      if (str(credentials.auth_token)) set('AUTH_TOKEN', str(credentials.auth_token)!);
      break;

    case 'salesforce':
      if (str(credentials.access_token)) set('ACCESS_TOKEN', str(credentials.access_token)!);
      if (str(config.instance_url)) set('INSTANCE_URL', str(config.instance_url)!);
      break;

    case 'airtable':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'hubspot':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'aws':
      if (str(credentials.access_key_id)) set('ACCESS_KEY_ID', str(credentials.access_key_id)!);
      if (str(credentials.secret_access_key)) set('SECRET_ACCESS_KEY', str(credentials.secret_access_key)!);
      if (str(config.region)) set('REGION', str(config.region)!);
      break;

    case 'postgres': {
      // Build DATABASE_URL from config + credentials
      const host = str(config.host);
      const port = str(config.port) || '5432';
      const database = str(config.database);
      const user = str(credentials.username);
      const password = str(credentials.password);
      const sslMode = str(config.ssl_mode) || 'require';
      if (host && database && user && password) {
        const url = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslMode}`;
        set('DATABASE_URL', url);
        set('URL', url);
      }
      break;
    }

    case 'mysql': {
      // Build MYSQL_URL from config + credentials
      const host = str(config.host);
      const port = str(config.port) || '3306';
      const database = str(config.database);
      const user = str(credentials.username);
      const password = str(credentials.password);
      if (host && database && user && password) {
        const url = `mysql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
        set('URL', url);
        set('DATABASE_URL', url);
      }
      break;
    }

    case 'mongodb': {
      // Prefer connection_string from credentials (current registry schema)
      const connStr = str(credentials.connection_string);
      if (connStr) {
        set('URL', connStr);
        set('URI', connStr);
      } else {
        // Fallback: build URL from individual fields (legacy schema)
        const host = str(config.host) || str(config.cluster_url);
        const port = str(config.port) || '27017';
        const database = str(config.database);
        const user = str(credentials.username);
        const password = str(credentials.password);
        if (host && database && user && password) {
          const url = `mongodb://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
          set('URL', url);
          set('URI', url);
        }
      }
      if (str(credentials.data_api_url)) set('DATA_API_URL', str(credentials.data_api_url)!);
      if (str(credentials.data_api_key)) set('DATA_API_KEY', str(credentials.data_api_key)!);
      break;
    }

    case 'redis': {
      // Prefer connection_string from credentials (current registry schema)
      const connStr = str(credentials.connection_string);
      if (connStr) {
        set('URL', connStr);
      } else {
        // Fallback: build URL from individual fields (legacy schema)
        const host = str(config.host);
        const port = str(config.port) || '6379';
        const password = str(credentials.password);
        if (host) {
          const url = password
            ? `redis://:${encodeURIComponent(password)}@${host}:${port}`
            : `redis://${host}:${port}`;
          set('URL', url);
        }
      }
      if (str(credentials.rest_url)) set('REST_URL', str(credentials.rest_url)!);
      if (str(credentials.rest_token)) set('REST_TOKEN', str(credentials.rest_token)!);
      break;
    }

    case 'bigquery':
      // BigQuery uses short-lived access tokens minted from service account JSON.
      if (str(credentials.access_token)) set('ACCESS_TOKEN', str(credentials.access_token)!);
      if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
      break;

    // --- Database integrations ---

    case 'neon': {
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(credentials.connection_string)) set('CONNECTION_STRING', str(credentials.connection_string)!);
      if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
      break;
    }

    case 'snowflake': {
      if (str(credentials.username)) set('USERNAME', str(credentials.username)!);
      if (str(credentials.private_key)) set('PRIVATE_KEY', str(credentials.private_key)!);
      if (str(credentials.private_key_passphrase)) set('PRIVATE_KEY_PASSPHRASE', str(credentials.private_key_passphrase)!);
      if (str(credentials.private_key_fingerprint)) set('PRIVATE_KEY_FINGERPRINT', str(credentials.private_key_fingerprint)!);
      if (str(config.account)) set('ACCOUNT', str(config.account)!);
      if (str(config.warehouse)) set('WAREHOUSE', str(config.warehouse)!);
      if (str(config.database)) set('DATABASE', str(config.database)!);
      if (str(config.schema)) set('SCHEMA', str(config.schema)!);
      break;
    }

    case 'clickhouse': {
      if (str(credentials.username)) set('USERNAME', str(credentials.username)!);
      if (str(credentials.password)) set('PASSWORD', str(credentials.password)!);
      if (str(config.host)) set('HOST', str(config.host)!);
      if (str(config.port)) set('PORT', str(config.port)!);
      if (str(config.database)) set('DATABASE', str(config.database)!);
      break;
    }

    case 'planetscale': {
      if (str(credentials.api_key)) set('TOKEN_ID', str(credentials.api_key)!);
      if (str(credentials.api_secret)) set('TOKEN_SECRET', str(credentials.api_secret)!);
      if (str(credentials.connection_string)) set('CONNECTION_STRING', str(credentials.connection_string)!);
      if (str(config.organization)) set('ORGANIZATION', str(config.organization)!);
      if (str(config.database)) set('DATABASE', str(config.database)!);
      break;
    }

    case 'turso':
      if (str(credentials.api_key)) set('AUTH_TOKEN', str(credentials.api_key)!);
      if (str(config.database_url)) set('DATABASE_URL', str(config.database_url)!);
      break;

    // --- SaaS integrations ---

    case 'openrouter':
    case 'typeform':
    case 'asana':
    case 'figma':
    case 'intercom':
    case 'netlify':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'jira':
      if (str(credentials.api_key)) set('API_TOKEN', str(credentials.api_key)!);
      if (str(credentials.email)) set('EMAIL', str(credentials.email)!);
      if (str(config.domain)) set('DOMAIN', str(config.domain)!);
      break;

    case 'zendesk':
      if (str(credentials.api_key)) set('API_TOKEN', str(credentials.api_key)!);
      if (str(credentials.email)) set('EMAIL', str(credentials.email)!);
      if (str(config.subdomain)) set('SUBDOMAIN', str(config.subdomain)!);
      break;

    case 'segment':
      if (str(credentials.api_key)) set('WRITE_KEY', str(credentials.api_key)!);
      break;

    case 'amplitude':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(credentials.api_secret)) set('SECRET_KEY', str(credentials.api_secret)!);
      if (str(config.region)) set('REGION', str(config.region)!);
      break;

    case 'discord':
      if (str(credentials.api_key)) set('BOT_TOKEN', str(credentials.api_key)!);
      if (str(config.application_id)) set('APPLICATION_ID', str(config.application_id)!);
      break;

    case 'teams':
      if (str(credentials.client_id)) set('CLIENT_ID', str(credentials.client_id)!);
      if (str(credentials.client_secret)) set('CLIENT_SECRET', str(credentials.client_secret)!);
      if (str(config.tenant_id)) set('TENANT_ID', str(config.tenant_id)!);
      break;

    // --- Cloud providers ---

    case 'gcp':
      if (str(credentials.service_account_json)) set('SERVICE_ACCOUNT_JSON', str(credentials.service_account_json)!);
      if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
      break;

    case 'azure':
      if (str(credentials.client_id)) set('CLIENT_ID', str(credentials.client_id)!);
      if (str(credentials.client_secret)) set('CLIENT_SECRET', str(credentials.client_secret)!);
      if (str(config.tenant_id)) set('TENANT_ID', str(config.tenant_id)!);
      if (str(config.subscription_id)) set('SUBSCRIPTION_ID', str(config.subscription_id)!);
      break;

    case 'vercel':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.team_id)) set('TEAM_ID', str(config.team_id)!);
      break;

    case 'cloudflare':
      if (str(credentials.api_key)) set('API_TOKEN', str(credentials.api_key)!);
      if (str(config.account_id)) set('ACCOUNT_ID', str(config.account_id)!);
      break;

    // --- Commerce ---

    case 'shopify':
      if (str(credentials.api_key)) set('ACCESS_TOKEN', str(credentials.api_key)!);
      if (str(config.shop_domain)) set('SHOP_DOMAIN', str(config.shop_domain)!);
      break;

    case 'square':
      if (str(credentials.api_key)) set('ACCESS_TOKEN', str(credentials.api_key)!);
      if (str(config.environment)) set('ENVIRONMENT', str(config.environment)!);
      break;

    case 'other': {
      // Check for dynamic fields in config (set during dynamic integration creation)
      const dynamicFields = config.dynamic_fields as DynamicFieldForEnv[] | undefined;

      if (dynamicFields && Array.isArray(dynamicFields) && dynamicFields.length > 0) {
        // Dynamic "other" integration - map each dynamic field to an env var
        for (const field of dynamicFields) {
          const value = str(credentials[field.name]);
          if (value) {
            set(normalizeEnvVarName(field.name), value);
          }
        }
      } else {
        // Legacy "other" integration - expose standard credential fields
        if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
        if (str(credentials.api_secret)) set('API_SECRET', str(credentials.api_secret)!);
        if (str(credentials.client_id)) set('CLIENT_ID', str(credentials.client_id)!);
        if (str(credentials.client_secret)) set('CLIENT_SECRET', str(credentials.client_secret)!);
        if (str(config.base_url)) set('BASE_URL', str(config.base_url)!);
      }
      break;
    }

    case 'remote_mcp':
      // Remote MCP connections are exposed through the CONNECTIONS binding and
      // CAMELAI_CONNECTIONS_URL proxy, not raw environment variables.
      break;

    // Default: expose api_key if present
    default: {
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;
    }
  }

  return env;
}

export interface LegacyIntegrationEnvInput {
  name: string;
  integration_type: string;
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

export function buildIntegrationEnvVars(
  integrations: readonly LegacyIntegrationEnvInput[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { name, integration_type, credentials, config } of integrations) {
    Object.assign(env, mapCredentialsToEnvVars(name, integration_type, credentials, config));
  }
  return env;
}
