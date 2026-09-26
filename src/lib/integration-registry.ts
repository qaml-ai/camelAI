import type { IntegrationCategory, IntegrationAuthMethod } from '@/types';
import { REMOTE_MCP_AUTH_TYPES, validateRemoteMcpUrl } from '@/lib/remote-mcp';

/**
 * Dynamic field definition for custom "other" integrations.
 * Allows AI agents to define custom credential fields at runtime.
 */
export interface DynamicField {
  name: string;           // Field name for env var suffix (e.g., "api_key" -> "_API_KEY")
  label: string;          // Display label shown in UI
  type: 'password' | 'text' | 'url' | 'number';
  required: boolean;
  placeholder?: string;
  description?: string;   // Help text displayed below input
}

/**
 * Dynamic integration schema for custom "other" integrations.
 * Passed from MCP tool to UI to render custom form fields.
 */
export interface DynamicIntegrationSchema {
  displayName: string;
  description?: string;
  instructions?: string;  // Setup instructions shown above form
  fields: DynamicField[];
}

export interface ConfigField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  placeholder?: string;
  description?: string;
}

export interface CredentialField {
  name: string;
  label: string;
  type: 'password' | 'text' | 'textarea';
  required: boolean;
  placeholder?: string;
  description?: string;
}

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface IntegrationDefinition {
  type: string;
  displayName: string;
  description: string;
  category: IntegrationCategory;
  authMethod: IntegrationAuthMethod;
  configSchema: ConfigField[];
  credentialSchema: CredentialField[];
  oauthConfig?: OAuthConfig;
  featureGate?: 'discord_channel';
  requiresOutboundIpAllowlist?: boolean;
  deprecated?: {
    hiddenFromCreate: boolean;
    replacementType?: string;
    message: string;
  };
}

export const INTEGRATION_REGISTRY: Record<string, IntegrationDefinition> = {
  // ============================================
  // DATABASE INTEGRATIONS (container execution)
  // ============================================

  postgres: {
    type: 'postgres',
    displayName: 'PostgreSQL',
    description: 'Connect to a PostgreSQL database',
    category: 'databases',
    authMethod: 'api_key',
    requiresOutboundIpAllowlist: true,
    configSchema: [
      { name: 'host', label: 'Host', type: 'string', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, default: 5432 },
      { name: 'database', label: 'Database', type: 'string', required: true },
      { name: 'schema', label: 'Schema', type: 'string', required: false, default: 'public' },
      {
        name: 'ssl_mode',
        label: 'SSL Mode',
        type: 'select',
        required: false,
        default: 'require',
        options: [
          { value: 'disable', label: 'Disable' },
          { value: 'require', label: 'Require' },
          { value: 'verify-ca', label: 'Verify CA' },
          { value: 'verify-full', label: 'Verify Full' },
        ],
      },
    ],
    credentialSchema: [
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
    ],
    // Requires container execution.
  },

  mysql: {
    type: 'mysql',
    displayName: 'MySQL',
    description: 'Connect to a MySQL database',
    category: 'databases',
    authMethod: 'api_key',
    requiresOutboundIpAllowlist: true,
    configSchema: [
      { name: 'host', label: 'Host', type: 'string', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, default: 3306 },
      { name: 'database', label: 'Database', type: 'string', required: true },
    ],
    credentialSchema: [
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
    ],
    // Requires container execution.
  },

  supabase: {
    type: 'supabase',
    displayName: 'Supabase',
    description: 'Connect to a Supabase project',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'project_url',
        label: 'Project URL',
        type: 'string',
        required: true,
        placeholder: 'https://your-project.supabase.co',
      },
      {
        name: 'key_type',
        label: 'Key Type',
        type: 'select',
        required: true,
        default: 'anon',
        options: [
          { value: 'anon', label: 'Anon Key (respects RLS)' },
          { value: 'service_role', label: 'Service Role Key (bypasses RLS)' },
        ],
        description:
          'Service role keys bypass Row Level Security and have full access. Prefer anon keys for client-facing apps.',
      },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'eyJ...' },
    ],
  },

  databricks: {
    type: 'databricks',
    displayName: 'Databricks',
    description: 'Connect to a Databricks workspace',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'workspace_url',
        label: 'Workspace URL',
        type: 'string',
        required: true,
        placeholder: 'https://dbc-abc123.cloud.databricks.com',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'dapi...',
      },
    ],
  },

  // ============================================
  // API KEY / OAUTH INTEGRATIONS (env vars only)
  // ============================================

  stripe: {
    type: 'stripe',
    displayName: 'Stripe',
    description: 'Accept payments with Stripe',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'Secret Key', type: 'password', required: true, placeholder: 'sk_...' },
    ],
  },

  notion: {
    type: 'notion',
    displayName: 'Notion',
    description: 'Connect to Notion workspaces and databases',
    category: 'saas',
    authMethod: 'oauth2',
    configSchema: [],
    credentialSchema: [],
    oauthConfig: {
      authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      scopes: [], // Notion doesn't use traditional scopes - capabilities are set in integration settings
    },
  },

  slack: {
    type: 'slack',
    displayName: 'Slack',
    description: 'Send messages and notifications to Slack',
    category: 'communication',
    authMethod: 'oauth2',
    configSchema: [],
    credentialSchema: [],
    oauthConfig: {
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: [
        // Messaging
        'chat:write',
        'chat:write.public',
        'chat:write.customize',
        'im:write',
        'im:read',
        'im:history',
        'mpim:write',
        'mpim:read',
        'mpim:history',
        // Channels
        'channels:read',
        'channels:history',
        'channels:join',
        'channels:manage',
        'groups:read',
        'groups:history',
        'groups:write',
        // Users & Team
        'users:read',
        'users:read.email',
        'users.profile:read',
        'team:read',
        // Files
        'files:read',
        'files:write',
        // Reactions & Pins
        'reactions:read',
        'reactions:write',
        'pins:read',
        'pins:write',
        // Bookmarks
        'bookmarks:read',
        'bookmarks:write',
        // Reminders
        'reminders:read',
        'reminders:write',
        // User Groups
        'usergroups:read',
        'usergroups:write',
        // Calls
        'calls:read',
        'calls:write',
        // Canvas
        'canvases:read',
        'canvases:write',
        // App management
        'commands',
        'app_mentions:read',
        // Metadata & Links
        'metadata.message:read',
        'links:read',
        'links:write',
        // DND
        'dnd:read',
      ],
    },
  },

  telegram: {
    type: 'telegram',
    displayName: 'Telegram',
    description: 'Connect a Telegram chat through the camelAI bot',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [],
  },

  discord_channel: {
    type: 'discord_channel',
    displayName: 'Discord',
    description: 'Connect a Discord server channel through the shared Camel bot',
    category: 'communication',
    authMethod: 'oauth2',
    featureGate: 'discord_channel',
    configSchema: [],
    credentialSchema: [],
    oauthConfig: {
      authorizationUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/v10/oauth2/token',
      scopes: ['bot'],
    },
  },

  openai: {
    type: 'openai',
    displayName: 'OpenAI',
    description: 'Access OpenAI GPT models',
    category: 'ai_services',
    authMethod: 'api_key',
    configSchema: [
      { name: 'organization_id', label: 'Organization ID', type: 'string', required: false },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' },
    ],
  },

  anthropic: {
    type: 'anthropic',
    displayName: 'Anthropic',
    description: 'Access Claude AI models',
    category: 'ai_services',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-ant-...' },
    ],
  },

  openrouter: {
    type: 'openrouter',
    displayName: 'OpenRouter',
    description: 'Access LLMs via OpenRouter',
    category: 'ai_services',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-or-...' },
    ],
  },

  github: {
    type: 'github',
    displayName: 'GitHub',
    description: 'Access GitHub repositories and APIs',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'ghp_... or github_pat_...',
        description: 'Create at github.com/settings/tokens (classic or fine-grained)',
      },
    ],
  },

  linear: {
    type: 'linear',
    displayName: 'Linear',
    description: 'Project management and issue tracking',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'lin_api_...',
        description: 'Create at linear.app/settings/api',
      },
    ],
  },

  sentry: {
    type: 'sentry',
    displayName: 'Sentry',
    description: 'Error monitoring with Sentry',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      { name: 'organization', label: 'Organization Slug', type: 'string', required: false, placeholder: 'my-org' },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Auth Token',
        type: 'password',
        required: true,
        placeholder: 'sntrys_...',
        description:
          'Create an Organization Auth Token at Settings > Auth Tokens. Recommended scopes: project:read, org:read, event:read.',
      },
    ],
  },

  mailchimp: {
    type: 'mailchimp',
    displayName: 'Mailchimp',
    description: 'Email marketing with Mailchimp',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'data_center',
        label: 'Data Center',
        type: 'string',
        required: true,
        placeholder: 'us21',
        description: 'The suffix after the dash in your API key (e.g., us21 from key-us21)',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'xxxxxxxx-us21',
        description: 'Create at mailchimp.com/account/api',
      },
    ],
  },

  posthog: {
    type: 'posthog',
    displayName: 'PostHog',
    description: 'Product analytics with PostHog',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'host',
        label: 'Host URL',
        type: 'string',
        required: true,
        placeholder: 'https://us.posthog.com',
        description:
          'US Cloud: https://us.posthog.com | EU Cloud: https://eu.posthog.com | Self-hosted: your instance URL',
      },
      { name: 'project_id', label: 'Project ID', type: 'string', required: false, placeholder: '12345' },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'Personal API Key', type: 'password', required: true, placeholder: 'phx_...' },
    ],
  },

  google_analytics: {
    type: 'google_analytics',
    displayName: 'Google Analytics 4',
    description: 'Read GA4 properties, metadata, reports, realtime data, and pivots',
    category: 'saas',
    authMethod: 'oauth2',
    oauthConfig: {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    },
    configSchema: [
      {
        name: 'property_id',
        label: 'Default GA4 Property ID',
        type: 'string',
        required: false,
        placeholder: '123456789',
        description: 'Selected automatically during OAuth when possible; it can be changed later.',
      },
    ],
    credentialSchema: [],
  },

  mixpanel: {
    type: 'mixpanel',
    displayName: 'Mixpanel',
    description: 'Product analytics with Mixpanel',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      { name: 'project_id', label: 'Project ID', type: 'string', required: true, placeholder: '1234567' },
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        required: true,
        default: 'us',
        options: [
          { value: 'us', label: 'US (mixpanel.com)' },
          { value: 'eu', label: 'EU (eu.mixpanel.com)' },
        ],
      },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'Service Account Username', type: 'text', required: true },
      {
        name: 'api_secret',
        label: 'Service Account Secret',
        type: 'password',
        required: true,
        description:
          'Create a Service Account in Organization Settings > Service Accounts. The secret is shown only once at creation time.',
      },
    ],
  },

  typeform: {
    type: 'typeform',
    displayName: 'Typeform',
    description: 'Forms and surveys with Typeform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'tfp_...',
        description: 'Create at typeform.com/developers/get-started/personal-access-token',
      },
    ],
  },

  sendgrid: {
    type: 'sendgrid',
    displayName: 'SendGrid',
    description: 'Send transactional emails',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'SG...' },
    ],
  },

  resend: {
    type: 'resend',
    displayName: 'Resend',
    description: 'Send transactional emails with Resend',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 're_...',
        description:
          'Create in Resend API Keys. Sending Access is enough for sending email; Full Access may be required when app code calls read/admin endpoints.',
      },
    ],
  },

  twilio: {
    type: 'twilio',
    displayName: 'Twilio',
    description: 'Send SMS and make calls',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'account_sid', label: 'Account SID', type: 'text', required: true },
      { name: 'auth_token', label: 'Auth Token', type: 'password', required: true },
    ],
  },

  salesforce: {
    type: 'salesforce',
    displayName: 'Salesforce',
    description: 'Connect to Salesforce CRM',
    category: 'saas',
    authMethod: 'oauth2',
    configSchema: [
      { name: 'instance_url', label: 'Instance URL', type: 'string', required: true, placeholder: 'https://yourorg.salesforce.com' },
    ],
    credentialSchema: [],
    oauthConfig: {
      authorizationUrl: 'https://login.salesforce.com/services/oauth2/authorize',
      tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
      scopes: ['api', 'refresh_token'],
    },
  },

  airtable: {
    type: 'airtable',
    displayName: 'Airtable',
    description: 'Access Airtable bases and records',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'pat...',
        description: 'Create at airtable.com/create/tokens',
      },
    ],
  },

  hubspot: {
    type: 'hubspot',
    displayName: 'HubSpot',
    description: 'CRM and marketing automation',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Private App Access Token',
        type: 'password',
        required: true,
        placeholder: 'pat-...',
        description: 'Create a private app at app.hubspot.com/private-apps',
      },
    ],
  },

  // ============================================
  // SPECIAL HANDLING REQUIRED
  // ============================================

  aws: {
    type: 'aws',
    displayName: 'Amazon Web Services',
    description: 'Connect to AWS services (requires SigV4 signing)',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        required: true,
        options: [
          { value: 'us-east-1', label: 'US East (N. Virginia)' },
          { value: 'us-east-2', label: 'US East (Ohio)' },
          { value: 'us-west-1', label: 'US West (N. California)' },
          { value: 'us-west-2', label: 'US West (Oregon)' },
          { value: 'eu-west-1', label: 'EU (Ireland)' },
          { value: 'eu-west-2', label: 'EU (London)' },
          { value: 'eu-central-1', label: 'EU (Frankfurt)' },
          { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
          { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
        ],
      },
      { name: 'role_arn', label: 'IAM Role ARN', type: 'string', required: false },
    ],
    credentialSchema: [
      { name: 'access_key_id', label: 'Access Key ID', type: 'text', required: true },
      { name: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
    ],
    // Requires SigV4 signing (special handler).
  },

  bigquery: {
    type: 'bigquery',
    displayName: 'Google BigQuery',
    description: 'Query data in Google BigQuery',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      { name: 'project_id', label: 'Project ID', type: 'string', required: true },
      { name: 'dataset', label: 'Default Dataset', type: 'string', required: false },
    ],
    credentialSchema: [
      {
        name: 'service_account_json',
        label: 'Service Account JSON',
        type: 'textarea',
        required: true,
        placeholder: '{\n  "type": "service_account",\n  "project_id": "..."\n}',
        description: 'Paste the full Google Cloud service account key JSON.',
      },
    ],
    // Requires Google auth.
  },

  neon: {
    type: 'neon',
    displayName: 'Neon',
    description: 'Serverless Postgres with branching',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'project_id',
        label: 'Project ID',
        type: 'string',
        required: false,
        placeholder: 'project-abc123',
        description: 'Found in your Neon project dashboard',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'neon_...',
        description: 'Create at Account Settings > API Keys',
      },
      {
        name: 'connection_string',
        label: 'Connection String',
        type: 'password',
        required: false,
        placeholder: 'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb',
        description: 'Direct database connection string (optional)',
      },
    ],
  },

  snowflake: {
    type: 'snowflake',
    displayName: 'Snowflake',
    description: 'Cloud data warehouse',
    category: 'databases',
    authMethod: 'api_key',
    requiresOutboundIpAllowlist: true,
    configSchema: [
      {
        name: 'account',
        label: 'Account Identifier',
        type: 'string',
        required: true,
        placeholder: 'xy12345.us-east-1',
        description: 'Your Snowflake account identifier (e.g., xy12345.us-east-1)',
      },
      { name: 'warehouse', label: 'Warehouse', type: 'string', required: false, placeholder: 'COMPUTE_WH' },
      { name: 'database', label: 'Database', type: 'string', required: false },
      { name: 'schema', label: 'Schema', type: 'string', required: false, default: 'PUBLIC' },
    ],
    credentialSchema: [
      { name: 'username', label: 'Username', type: 'text', required: true },
      {
        name: 'private_key',
        label: 'Private Key (PEM)',
        type: 'textarea',
        required: true,
        placeholder: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
        description: 'RSA private key in PEM format for key pair authentication',
      },
      {
        name: 'private_key_passphrase',
        label: 'Private Key Passphrase',
        type: 'password',
        required: false,
        description: 'Passphrase if your private key is encrypted (optional)',
      },
      {
        name: 'private_key_fingerprint',
        label: 'Public Key Fingerprint',
        type: 'text',
        required: false,
        placeholder: 'SHA256:...',
        description: 'Snowflake public key fingerprint for SQL API JWT authentication. Required for MCP tools.',
      },
    ],
  },

  clickhouse: {
    type: 'clickhouse',
    displayName: 'ClickHouse',
    description: 'Fast analytics database',
    category: 'databases',
    authMethod: 'api_key',
    requiresOutboundIpAllowlist: true,
    configSchema: [
      {
        name: 'host',
        label: 'Host',
        type: 'string',
        required: true,
        placeholder: 'abc123.clickhouse.cloud',
        description: 'ClickHouse Cloud host or self-hosted URL',
      },
      { name: 'port', label: 'Port', type: 'number', required: false, default: 8443 },
      { name: 'database', label: 'Database', type: 'string', required: false, default: 'default' },
    ],
    credentialSchema: [
      { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'default' },
      { name: 'password', label: 'Password', type: 'password', required: true },
    ],
  },

  planetscale: {
    type: 'planetscale',
    displayName: 'PlanetScale',
    description: 'Serverless MySQL platform',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'organization',
        label: 'Organization',
        type: 'string',
        required: false,
        placeholder: 'my-org',
      },
      {
        name: 'database',
        label: 'Database',
        type: 'string',
        required: false,
        placeholder: 'my-database',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Service Token ID',
        type: 'text',
        required: true,
        placeholder: 'pscale_tkn_...',
        description: 'Create at Organization Settings > Service Tokens',
      },
      {
        name: 'api_secret',
        label: 'Service Token Secret',
        type: 'password',
        required: true,
      },
      {
        name: 'connection_string',
        label: 'Connection String',
        type: 'password',
        required: false,
        placeholder: 'mysql://user:pass@aws.connect.psdb.cloud/db?sslaccept=strict',
        description: 'Direct database connection string (optional)',
      },
    ],
  },

  turso: {
    type: 'turso',
    displayName: 'Turso',
    description: 'Edge SQLite database',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'database_url',
        label: 'Database URL',
        type: 'string',
        required: true,
        placeholder: 'libsql://db-org.turso.io',
        description: 'Your Turso database URL',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Auth Token',
        type: 'password',
        required: true,
        description: 'Create with: turso db tokens create <db-name>',
      },
    ],
  },

  mongodb: {
    type: 'mongodb',
    displayName: 'MongoDB',
    description: 'Document database',
    category: 'databases',
    authMethod: 'api_key',
    requiresOutboundIpAllowlist: true,
    configSchema: [
      {
        name: 'cluster_url',
        label: 'Cluster URL',
        type: 'string',
        required: false,
        placeholder: 'cluster0.abc123.mongodb.net',
        description: 'MongoDB Atlas cluster URL (without protocol)',
      },
      { name: 'database', label: 'Database', type: 'string', required: false },
    ],
    credentialSchema: [
      {
        name: 'connection_string',
        label: 'Connection String',
        type: 'password',
        required: true,
        placeholder: 'mongodb+srv://user:pass@cluster0.abc123.mongodb.net/mydb',
        description: 'Full MongoDB connection string',
      },
      {
        name: 'data_api_key',
        label: 'Atlas Data API Key',
        type: 'password',
        required: false,
        description: 'Required for MCP tools. Enable Atlas Data API and create an API key.',
      },
      {
        name: 'data_api_url',
        label: 'Atlas Data API URL',
        type: 'text',
        required: false,
        placeholder: 'https://data.mongodb-api.com/app/<app-id>/endpoint/data/v1',
        description: 'Required for MCP tools. Atlas Data API endpoint URL.',
      },
    ],
  },

  redis: {
    type: 'redis',
    displayName: 'Redis',
    description: 'In-memory data store',
    category: 'databases',
    authMethod: 'api_key',
    requiresOutboundIpAllowlist: true,
    configSchema: [
      {
        name: 'host',
        label: 'Host',
        type: 'string',
        required: false,
        placeholder: 'redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com',
      },
      { name: 'port', label: 'Port', type: 'number', required: false, default: 6379 },
      { name: 'database', label: 'Database Number', type: 'number', required: false, default: 0 },
    ],
    credentialSchema: [
      {
        name: 'connection_string',
        label: 'Connection String',
        type: 'password',
        required: true,
        placeholder: 'redis://user:pass@host:6379/0',
        description: 'Redis connection URL (redis:// or rediss:// for TLS)',
      },
      {
        name: 'rest_url',
        label: 'Redis REST URL',
        type: 'text',
        required: false,
        placeholder: 'https://your-redis.upstash.io',
        description: 'Required for MCP tools. Upstash-compatible Redis REST endpoint.',
      },
      {
        name: 'rest_token',
        label: 'Redis REST Token',
        type: 'password',
        required: false,
        description: 'Required for MCP tools. Token for the Redis REST endpoint.',
      },
    ],
  },

  // ============================================
  // ADDITIONAL SAAS INTEGRATIONS
  // ============================================

  jira: {
    type: 'jira',
    displayName: 'Jira',
    description: 'Issue tracking and project management',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'domain',
        label: 'Atlassian Domain',
        type: 'string',
        required: true,
        placeholder: 'your-company.atlassian.net',
        description: 'Your Atlassian cloud domain',
      },
    ],
    credentialSchema: [
      {
        name: 'email',
        label: 'Email',
        type: 'text',
        required: true,
        description: 'Email address for your Atlassian account',
      },
      {
        name: 'api_key',
        label: 'API Token',
        type: 'password',
        required: true,
        description: 'Create at id.atlassian.com/manage-profile/security/api-tokens',
      },
    ],
  },

  asana: {
    type: 'asana',
    displayName: 'Asana',
    description: 'Project and task management',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        description: 'Create at app.asana.com/0/my-apps',
      },
    ],
  },

  figma: {
    type: 'figma',
    displayName: 'Figma',
    description: 'Design files and collaboration',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        description: 'Create at figma.com/developers/api#access-tokens',
      },
    ],
  },

  intercom: {
    type: 'intercom',
    displayName: 'Intercom',
    description: 'Customer messaging platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Access Token',
        type: 'password',
        required: true,
        description: 'Create in Developer Hub > Your App > Authentication',
      },
    ],
  },

  zendesk: {
    type: 'zendesk',
    displayName: 'Zendesk',
    description: 'Customer support platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'subdomain',
        label: 'Subdomain',
        type: 'string',
        required: true,
        placeholder: 'your-company',
        description: 'Your Zendesk subdomain (from your-company.zendesk.com)',
      },
    ],
    credentialSchema: [
      {
        name: 'email',
        label: 'Email',
        type: 'text',
        required: true,
        description: 'Email address for your Zendesk account',
      },
      {
        name: 'api_key',
        label: 'API Token',
        type: 'password',
        required: true,
        description: 'Create at Admin Center > Apps and integrations > Zendesk API',
      },
    ],
  },

  segment: {
    type: 'segment',
    displayName: 'Segment',
    description: 'Customer data platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Public API Token',
        type: 'password',
        required: true,
        description: 'Segment Public API token for read-oriented MCP tools.',
      },
    ],
  },

  amplitude: {
    type: 'amplitude',
    displayName: 'Amplitude',
    description: 'Product analytics platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        required: true,
        default: 'us',
        options: [
          { value: 'us', label: 'US (amplitude.com)' },
          { value: 'eu', label: 'EU (eu.amplitude.com)' },
        ],
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        description: 'Project API key from Settings > Projects',
      },
      {
        name: 'api_secret',
        label: 'Secret Key',
        type: 'password',
        required: true,
        description: 'Project secret key for server-side API access',
      },
    ],
  },

  // ============================================
  // ADDITIONAL COMMUNICATION INTEGRATIONS
  // ============================================

  discord: {
    type: 'discord',
    displayName: 'Discord bot token (legacy)',
    description: 'Legacy credential-only Discord bot connection',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'application_id',
        label: 'Application ID',
        type: 'string',
        required: false,
        description: 'Discord application ID (optional, for bot commands)',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Bot Token',
        type: 'password',
        required: true,
        description: 'Bot token from discord.com/developers/applications',
      },
    ],
    deprecated: {
      hiddenFromCreate: true,
      replacementType: 'discord_channel',
      message: 'Install the shared Camel Discord app for native channel support.',
    },
  },

  teams: {
    type: 'teams',
    displayName: 'Microsoft Teams',
    description: 'Microsoft Teams messaging',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'tenant_id',
        label: 'Tenant ID',
        type: 'string',
        required: true,
        description: 'Azure AD tenant ID',
      },
    ],
    credentialSchema: [
      {
        name: 'client_id',
        label: 'Client ID',
        type: 'text',
        required: true,
        description: 'Azure AD app registration client ID',
      },
      {
        name: 'client_secret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        description: 'Azure AD app registration client secret',
      },
    ],
  },

  // ============================================
  // ADDITIONAL CLOUD PROVIDER INTEGRATIONS
  // ============================================

  gcp: {
    type: 'gcp',
    displayName: 'Google Cloud Platform',
    description: 'Connect to GCP services',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'project_id',
        label: 'Project ID',
        type: 'string',
        required: true,
        placeholder: 'my-project-123',
      },
    ],
    credentialSchema: [
      {
        name: 'service_account_json',
        label: 'Service Account JSON',
        type: 'password',
        required: true,
        description: 'Full JSON contents of your service account key file',
      },
    ],
  },

  azure: {
    type: 'azure',
    displayName: 'Microsoft Azure',
    description: 'Connect to Azure services',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'tenant_id',
        label: 'Tenant ID',
        type: 'string',
        required: true,
        description: 'Azure AD tenant ID',
      },
      {
        name: 'subscription_id',
        label: 'Subscription ID',
        type: 'string',
        required: false,
        description: 'Azure subscription ID (optional)',
      },
    ],
    credentialSchema: [
      {
        name: 'client_id',
        label: 'Client ID',
        type: 'text',
        required: true,
        description: 'Azure AD app registration client ID',
      },
      {
        name: 'client_secret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        description: 'Azure AD app registration client secret',
      },
    ],
  },

  vercel: {
    type: 'vercel',
    displayName: 'Vercel',
    description: 'Vercel deployment platform',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'team_id',
        label: 'Team ID',
        type: 'string',
        required: false,
        placeholder: 'team_xxx',
        description: 'Vercel team ID (leave empty for personal account)',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Access Token',
        type: 'password',
        required: true,
        description: 'Create at vercel.com/account/tokens',
      },
    ],
  },

  netlify: {
    type: 'netlify',
    displayName: 'Netlify',
    description: 'Netlify deployment platform',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        description: 'Create at app.netlify.com/user/applications#personal-access-tokens',
      },
    ],
  },

  cloudflare: {
    type: 'cloudflare',
    displayName: 'Cloudflare',
    description: 'Cloudflare API access',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'account_id',
        label: 'Account ID',
        type: 'string',
        required: false,
        description: 'Cloudflare account ID (found in dashboard URL)',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Token',
        type: 'password',
        required: true,
        description: 'Create at dash.cloudflare.com/profile/api-tokens',
      },
    ],
  },

  // ============================================
  // PAYMENTS / COMMERCE INTEGRATIONS
  // ============================================

  shopify: {
    type: 'shopify',
    displayName: 'Shopify',
    description: 'E-commerce platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'shop_domain',
        label: 'Shop Domain',
        type: 'string',
        required: true,
        placeholder: 'your-store.myshopify.com',
        description: 'Your Shopify store domain',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Admin API Access Token',
        type: 'password',
        required: true,
        description: 'Create a custom app at Settings > Apps and sales channels > Develop apps',
      },
    ],
  },

  square: {
    type: 'square',
    displayName: 'Square',
    description: 'Payments and commerce',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'environment',
        label: 'Environment',
        type: 'select',
        required: true,
        default: 'production',
        options: [
          { value: 'sandbox', label: 'Sandbox' },
          { value: 'production', label: 'Production' },
        ],
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Access Token',
        type: 'password',
        required: true,
        description: 'Create at developer.squareup.com/apps',
      },
    ],
  },

  // ============================================
  // GENERIC / CUSTOM INTEGRATION
  // ============================================

  remote_mcp: {
    type: 'remote_mcp',
    displayName: 'Remote MCP Server',
    description: 'Connect to a remote MCP server over HTTPS. Local command and localhost MCP servers are not supported.',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'server_url',
        label: 'Server URL',
        type: 'string',
        required: true,
        placeholder: 'https://mcp.example.com/mcp',
        description: 'Must be a remote HTTPS MCP endpoint. Localhost, private IPs, and local command servers are blocked.',
      },
      {
        name: 'auth_type',
        label: 'Authentication',
        type: 'select',
        required: true,
        default: 'none',
        options: [
          { value: 'none', label: 'None' },
          { value: 'bearer', label: 'Bearer Token' },
          { value: 'custom_header', label: 'Custom Header' },
          { value: 'oauth', label: 'OAuth (Dynamic Client Registration)' },
        ],
      },
      {
        name: 'auth_header',
        label: 'Custom Auth Header Name',
        type: 'string',
        required: false,
        placeholder: 'X-API-Key',
        description: 'Only used when Authentication is Custom Header.',
      },
    ],
    credentialSchema: [
      {
        name: 'token',
        label: 'Token',
        type: 'password',
        required: false,
        description: 'Required for Bearer Token or Custom Header authentication.',
      },
    ],
  },

  other: {
    type: 'other',
    displayName: 'Other',
    description: 'Connect to any HTTP API with custom authentication',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      { name: 'display_name', label: 'Display Name', type: 'string', required: true, placeholder: 'My Custom API' },
      { name: 'description', label: 'Description', type: 'string', required: false, placeholder: 'What this integration does' },
      { name: 'base_url', label: 'Base URL', type: 'string', required: true, placeholder: 'https://api.example.com' },
      {
        name: 'auth_type',
        label: 'Authentication Type',
        type: 'select',
        required: false,
        default: 'bearer',
        options: [
          { value: 'none', label: 'None' },
          { value: 'bearer', label: 'Bearer Token' },
          { value: 'basic', label: 'Basic Auth' },
          { value: 'header', label: 'Custom Header' },
        ],
      },
      { name: 'auth_header', label: 'Custom Auth Header Name', type: 'string', required: false, placeholder: 'X-API-Key' },
      {
        name: 'operation_policy',
        label: 'Imported Operation Policy',
        type: 'select',
        required: false,
        default: 'read_only',
        options: [
          { value: 'read_only', label: 'Read operations only' },
          { value: 'all', label: 'Allow read and write operations' },
        ],
        description: 'Applies to discovered typed operations. Generic fetch remains available as a fallback.',
      },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'API Key / Token', type: 'password', required: false },
      { name: 'api_secret', label: 'API Secret / Password', type: 'password', required: false },
      { name: 'client_id', label: 'Client ID', type: 'text', required: false },
      { name: 'client_secret', label: 'Client Secret', type: 'password', required: false },
    ],
    // Exposes config/credential fields for custom API connections.
  },
};

export function getIntegrationDefinition(type: string): IntegrationDefinition | undefined {
  return INTEGRATION_REGISTRY[type];
}

export function hasManagedOAuthFlow(
  definition: IntegrationDefinition | undefined
): boolean {
  return definition?.authMethod === 'oauth2' && Boolean(definition.oauthConfig);
}

export interface IntegrationCatalogOptions {
  includeFeatureGated?: boolean;
}

function isVisibleInCatalog(
  definition: IntegrationDefinition,
  options: IntegrationCatalogOptions,
): boolean {
  return !definition.deprecated?.hiddenFromCreate &&
    (options.includeFeatureGated === true || !definition.featureGate);
}

export function getIntegrationsByCategory(
  category: IntegrationCategory,
  options: IntegrationCatalogOptions = {},
): IntegrationDefinition[] {
  return Object.values(INTEGRATION_REGISTRY).filter(
    (definition) => definition.category === category && isVisibleInCatalog(definition, options),
  );
}

export function getAllIntegrations(
  options: IntegrationCatalogOptions = {},
): IntegrationDefinition[] {
  return Object.values(INTEGRATION_REGISTRY).filter((definition) =>
    isVisibleInCatalog(definition, options)
  );
}

export function validateConfig(type: string, config: Record<string, unknown>): string[] {
  const definition = INTEGRATION_REGISTRY[type];
  if (!definition) {
    return [`Unknown integration type: ${type}`];
  }

  const errors: string[] = [];
  for (const field of definition.configSchema) {
    const value = config[field.name];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label} is required`);
    }
  }
  if (type === 'remote_mcp') {
    errors.push(...validateRemoteMcpUrl(config.server_url));
    const authType = typeof config.auth_type === 'string' ? config.auth_type : 'none';
    if (!REMOTE_MCP_AUTH_TYPES.includes(authType as (typeof REMOTE_MCP_AUTH_TYPES)[number])) {
      errors.push('Authentication type is invalid');
    }
    if (authType === 'custom_header') {
      const header = typeof config.auth_header === 'string' ? config.auth_header.trim() : '';
      if (!header) {
        errors.push('Custom auth header name is required');
      }
    }
  }
  return errors;
}

export function validateCredentials(type: string, credentials: Record<string, unknown>): string[] {
  const definition = INTEGRATION_REGISTRY[type];
  if (!definition) {
    return [`Unknown integration type: ${type}`];
  }

  const errors: string[] = [];
  for (const field of definition.credentialSchema) {
    const value = credentials[field.name];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label} is required`);
    }
  }
  return errors;
}

export function shouldStoreIntegrationCredentials(
  type: string,
  credentials: Record<string, unknown>
): boolean {
  const definition = INTEGRATION_REGISTRY[type];
  if (!definition) return true;
  if (definition.credentialSchema.length > 0) return true;

  return Object.values(credentials).some((value) => {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
}

// Normalized auth_type for an "other" (custom HTTP API) connection. Mirrors the
// default used at request time in applyOtherAuth (connections-runtime.ts).
function otherAuthType(config: Record<string, unknown>): string {
  return typeof config.auth_type === 'string' && config.auth_type.trim()
    ? config.auth_type.trim().toLowerCase()
    : 'bearer';
}

// Which credential fields an "other" connection actually uses, keyed by auth_type.
// Must stay in sync with the credential lookups in applyOtherAuth.
const OTHER_CREDENTIAL_FIELDS_BY_AUTH: Record<string, string[]> = {
  none: [],
  bearer: ['api_key'],
  header: ['api_key'],
  basic: ['client_id', 'client_secret'],
};

// Whether a config field should be shown for the given connection type/state.
// Centralized so the Add and Edit dialogs stay in sync.
export function shouldShowConfigField(
  type: string,
  fieldName: string,
  config: Record<string, unknown>
): boolean {
  if (type === 'remote_mcp' && fieldName === 'auth_header') {
    return config.auth_type === 'custom_header';
  }
  // Only relevant when authenticating via a custom header.
  if (type === 'other' && fieldName === 'auth_header') {
    return otherAuthType(config) === 'header';
  }
  if (type === 'other' && fieldName === 'operation_policy') {
    return config.generic_fetch_enabled === true;
  }
  return true;
}

// Whether a credential field should be shown for the given connection type/state.
export function shouldShowCredentialField(
  type: string,
  fieldName: string,
  config: Record<string, unknown>
): boolean {
  if (type === 'remote_mcp' && fieldName === 'token') {
    return config.auth_type === 'bearer' || config.auth_type === 'custom_header';
  }
  if (type === 'other') {
    const fields = OTHER_CREDENTIAL_FIELDS_BY_AUTH[otherAuthType(config)] ?? OTHER_CREDENTIAL_FIELDS_BY_AUTH.bearer;
    return fields.includes(fieldName);
  }
  return true;
}

// Whether a credential field is required given the current type/state. Falls back
// to the schema's declared requirement for types without conditional auth.
export function isCredentialFieldRequired(
  type: string,
  fieldName: string,
  config: Record<string, unknown>,
  schemaRequired: boolean
): boolean {
  if (type === 'remote_mcp' && fieldName === 'token') {
    return config.auth_type === 'bearer' || config.auth_type === 'custom_header';
  }
  // For "other", every credential field that is shown for the chosen auth_type is
  // required — otherwise the connection silently fails its first request.
  if (type === 'other') {
    return shouldShowCredentialField('other', fieldName, config);
  }
  return schemaRequired;
}

// Credential field names required for a given connection type/config.
function requiredCredentialKeys(
  definition: IntegrationDefinition,
  config: Record<string, unknown>
): string[] {
  return definition.credentialSchema
    .filter((field) => isCredentialFieldRequired(definition.type, field.name, config, field.required))
    .map((field) => field.name);
}

// When editing an existing connection, decide whether the user must supply
// credentials now (rather than reusing the stored secret). This is true when the
// selected config requires a credential the stored credentials would not contain:
// either nothing is stored yet, or the auth mode change introduced a newly-required
// credential key (e.g. switching an "other" connection from basic to bearer, where
// the stored client_id/client_secret cannot satisfy the new api_key requirement).
// Without this, a config-only save would persist an auth mode whose secret is
// missing and the next request would fail with AUTH_SETUP_INCOMPLETE.
export function requiresCredentialEntryOnEdit(
  definition: IntegrationDefinition,
  currentConfig: Record<string, unknown>,
  storedConfig: Record<string, unknown>,
  hasStoredCredentials: boolean
): boolean {
  const requiredNow = requiredCredentialKeys(definition, currentConfig);
  if (requiredNow.length === 0) return false;
  if (!hasStoredCredentials) return true;
  const requiredBefore = new Set(requiredCredentialKeys(definition, storedConfig));
  return requiredNow.some((key) => !requiredBefore.has(key));
}

// Returns true when the newly-selected auth mode hides a credential field that
// the stored config exposed, so the edit must submit a filtered payload to
// overwrite the orphaned (now-invisible) secret instead of letting the server
// keep it. No-op for connection types without conditional credential visibility
// (shouldShowCredentialField returns true for every key there, so the visible
// sets match).
export function shouldClearHiddenCredentials(
  definition: IntegrationDefinition,
  currentConfig: Record<string, unknown>,
  storedConfig: Record<string, unknown>,
  hasStoredCredentials: boolean
): boolean {
  if (!hasStoredCredentials) return false;
  const visibleNow = new Set(
    definition.credentialSchema
      .filter((field) => shouldShowCredentialField(definition.type, field.name, currentConfig))
      .map((field) => field.name)
  );
  return definition.credentialSchema
    .filter((field) => shouldShowCredentialField(definition.type, field.name, storedConfig))
    .map((field) => field.name)
    .some((name) => !visibleNow.has(name));
}

// Drop credential values for fields hidden by the current auth mode so secrets a
// user can no longer see/clear in the UI are never silently persisted (e.g. an
// "other" connection where api_key was typed under bearer then auth_type switched
// to none/basic). For types without conditional auth, shouldShowCredentialField
// returns true for every key, so this is a no-op (snowflake etc. unaffected).
export function filterVisibleCredentials(
  type: string,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(credentials).filter(([key]) => shouldShowCredentialField(type, key, config))
  );
}
