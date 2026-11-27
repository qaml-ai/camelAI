import { describe, expect, it } from "vitest";
import {
  buildIntegrationEnvVars,
  getEnvVarSuffixesForType,
  normalizeEnvVarName,
  type LegacyIntegrationEnvInput,
} from "../workers/main/src/legacy-integration-env";

describe("buildIntegrationEnvVars", () => {
  it.each<{ integration: LegacyIntegrationEnvInput; expected: Record<string, string> }>([
    {
      integration: {
        name: " Reporting / Production ",
        integration_type: "clickhouse",
        credentials: { username: "reader", password: "report-password" },
        config: { host: "clickhouse.example", port: 8443, database: "analytics" },
      },
      expected: {
        INT_CLICKHOUSE_REPORTING_PRODUCTION_USERNAME: "reader",
        INT_CLICKHOUSE_REPORTING_PRODUCTION_PASSWORD: "report-password",
        INT_CLICKHOUSE_REPORTING_PRODUCTION_HOST: "clickhouse.example",
        INT_CLICKHOUSE_REPORTING_PRODUCTION_PORT: "8443",
        INT_CLICKHOUSE_REPORTING_PRODUCTION_DATABASE: "analytics",
      },
    },
    {
      integration: {
        name: "Production",
        integration_type: "stripe",
        credentials: { api_key: "stripe-key", secret_key: "unused-field" },
        config: {},
      },
      expected: {
        INT_STRIPE_PRODUCTION_API_KEY: "stripe-key",
        INT_STRIPE_PRODUCTION_SECRET_KEY: "stripe-key",
      },
    },
    {
      integration: {
        name: "Workspace OAuth",
        integration_type: "slack",
        credentials: {
          access_token: "slack-access",
          api_key: "manual-key",
          refresh_token: "slack-refresh",
          team_id: "team-1",
          team_name: "Example Team",
        },
        config: {},
      },
      expected: {
        INT_SLACK_WORKSPACE_OAUTH_BOT_TOKEN: "slack-access",
        INT_SLACK_WORKSPACE_OAUTH_TEAM_ID: "team-1",
        INT_SLACK_WORKSPACE_OAUTH_TEAM_NAME: "Example Team",
      },
    },
    {
      integration: {
        name: "Manual",
        integration_type: "slack",
        credentials: { access_token: "", api_key: "slack-manual" },
        config: {},
      },
      expected: { INT_SLACK_MANUAL_BOT_TOKEN: "slack-manual" },
    },
    {
      integration: {
        name: "Workspace OAuth",
        integration_type: "notion",
        credentials: {
          access_token: "notion-access",
          api_key: "manual-key",
          refresh_token: "notion-refresh",
          expires_at: 1000,
          notion_workspace_id: "workspace-1",
          notion_workspace_name: "Example Workspace",
        },
        config: {},
      },
      expected: {
        INT_NOTION_WORKSPACE_OAUTH_API_KEY: "notion-access",
        INT_NOTION_WORKSPACE_OAUTH_WORKSPACE_ID: "workspace-1",
        INT_NOTION_WORKSPACE_OAUTH_WORKSPACE_NAME: "Example Workspace",
      },
    },
    {
      integration: {
        name: "Manual",
        integration_type: "notion",
        credentials: { api_key: "notion-manual" },
        config: {},
      },
      expected: { INT_NOTION_MANUAL_API_KEY: "notion-manual" },
    },
    {
      integration: {
        name: "Warehouse",
        integration_type: "bigquery",
        credentials: { access_token: "bigquery-access", service_account_json: "{}" },
        config: { project_id: "example-project" },
      },
      expected: {
        INT_BIGQUERY_WAREHOUSE_ACCESS_TOKEN: "bigquery-access",
        INT_BIGQUERY_WAREHOUSE_PROJECT_ID: "example-project",
      },
    },
    {
      integration: {
        name: "Warehouse",
        integration_type: "bigquery",
        credentials: { service_account_json: "{}" },
        config: { project_id: "example-project" },
      },
      expected: { INT_BIGQUERY_WAREHOUSE_PROJECT_ID: "example-project" },
    },
    {
      integration: {
        name: "Orders",
        integration_type: "mysql",
        credentials: { username: "reader", password: "p@ss:/word" },
        config: { host: "mysql.example", database: "orders" },
      },
      expected: {
        INT_MYSQL_ORDERS_URL: "mysql://reader:p%40ss%3A%2Fword@mysql.example:3306/orders",
        INT_MYSQL_ORDERS_DATABASE_URL: "mysql://reader:p%40ss%3A%2Fword@mysql.example:3306/orders",
      },
    },
    {
      integration: {
        name: "Orders",
        integration_type: "postgres",
        credentials: { username: "reader", password: "p@ss:/word" },
        config: { host: "postgres.example", database: "orders" },
      },
      expected: {
        INT_POSTGRES_ORDERS_DATABASE_URL: "postgresql://reader:p%40ss%3A%2Fword@postgres.example:5432/orders?sslmode=require",
        INT_POSTGRES_ORDERS_URL: "postgresql://reader:p%40ss%3A%2Fword@postgres.example:5432/orders?sslmode=require",
      },
    },
    {
      integration: {
        name: "Support",
        integration_type: "intercom",
        credentials: { api_key: "intercom-key" },
        config: {},
      },
      expected: { INT_INTERCOM_SUPPORT_API_KEY: "intercom-key" },
    },
    {
      integration: {
        name: "Email",
        integration_type: "resend",
        credentials: { api_key: "resend-key" },
        config: {},
      },
      expected: { INT_RESEND_EMAIL_API_KEY: "resend-key" },
    },
    {
      integration: {
        name: "CamelAI Admin API",
        integration_type: "other",
        credentials: {
          api_key: "admin-key",
          api_secret: "admin-secret",
          client_id: "admin-client",
          client_secret: "admin-client-secret",
          extra: "unused-field",
        },
        config: { base_url: "https://admin.example", dynamic_fields: [] },
      },
      expected: {
        INT_OTHER_CAMELAI_ADMIN_API_API_KEY: "admin-key",
        INT_OTHER_CAMELAI_ADMIN_API_API_SECRET: "admin-secret",
        INT_OTHER_CAMELAI_ADMIN_API_CLIENT_ID: "admin-client",
        INT_OTHER_CAMELAI_ADMIN_API_CLIENT_SECRET: "admin-client-secret",
        INT_OTHER_CAMELAI_ADMIN_API_BASE_URL: "https://admin.example",
      },
    },
    {
      integration: {
        name: "Custom source",
        integration_type: "other",
        credentials: { "webhook-secret": "webhook-key", store_id: 0, optional: "", api_key: "unused-key" },
        config: {
          base_url: "https://unused.example",
          dynamic_fields: [
            { name: "webhook-secret", label: "Webhook secret", type: "password", required: true },
            { name: "store_id", label: "Store", type: "number", required: true },
            { name: "optional", label: "Optional", type: "text", required: false },
          ],
        },
      },
      expected: {
        INT_OTHER_CUSTOM_SOURCE_WEBHOOK_SECRET: "webhook-key",
        INT_OTHER_CUSTOM_SOURCE_STORE_ID: "0",
      },
    },
  ])("maps $integration.integration_type $integration.name", ({ integration, expected }) => {
    expect(buildIntegrationEnvVars([integration])).toEqual(expected);
  });

  it("combines integrations in input order, including names that normalize to the same prefix", () => {
    expect(buildIntegrationEnvVars([
      { name: "Team's API", integration_type: "other", credentials: { api_key: "first" }, config: {} },
      { name: "Team S API", integration_type: "stripe", credentials: { api_key: "stripe" }, config: {} },
      { name: "Team_s-api", integration_type: "other", credentials: { api_key: "last" }, config: {} },
    ])).toEqual({
      INT_OTHER_TEAM_S_API_API_KEY: "last",
      INT_STRIPE_TEAM_S_API_API_KEY: "stripe",
      INT_STRIPE_TEAM_S_API_SECRET_KEY: "stripe",
    });
  });

  it("omits bindings for remote MCP and incomplete database connections", () => {
    expect(buildIntegrationEnvVars([
      { name: "MCP", integration_type: "remote_mcp", credentials: { api_key: "mcp-key" }, config: {} },
      {
        name: "Missing Password",
        integration_type: "postgres",
        credentials: { username: "reader" },
        config: { host: "postgres.example", database: "orders" },
      },
    ])).toEqual({});
  });
});

describe("legacy integration env naming", () => {
  it("normalizes punctuation, whitespace, and repeated separators", () => {
    expect(normalizeEnvVarName(" ..CamelAI / Admin___API 2- ")).toBe("CAMELAI_ADMIN_API_2");
  });

  it("keeps the legacy dynamic and standard field suffixes", () => {
    expect(getEnvVarSuffixesForType("other", [
      { name: "webhook-secret", label: "Webhook secret", type: "password", required: true },
    ])).toEqual(["WEBHOOK_SECRET"]);
    expect(getEnvVarSuffixesForType("other")).toEqual(["API_KEY", "API_SECRET", "CLIENT_ID", "CLIENT_SECRET", "BASE_URL"]);
  });
});
