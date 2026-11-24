import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, objectArg, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface ShopifyMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface ShopifyClient {
  shopDomain: string;
  token: string;
}

const SHOPIFY_API_VERSION = '2026-04';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function isShopifyMcpIntegration(integrationType: string): boolean {
  return integrationType === 'shopify';
}

export function listShopifyMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'get_shop',
      description: 'Get basic Shopify shop metadata.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_products',
      description: 'List Shopify products.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional Shopify product search query.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_product',
      description: 'Get a Shopify product by GraphQL id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    },
    {
      name: 'list_orders',
      description: 'List Shopify orders.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional Shopify order search query.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_order',
      description: 'Get a Shopify order by GraphQL id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    },
  ];
}

export async function shopifyMcpRpc(
  env: ShopifyMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isShopifyMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Shopify.`), { status: 404 });
  }
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'camelai-shopify', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listShopifyMcpTools() };
    case 'tools/call':
      return callShopifyTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callShopifyTool(
  env: ShopifyMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = objectArg(params.arguments);
  const client = await createShopifyClient(env, record);
  const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');

  switch (name) {
    case 'get_shop':
      return textToolResult(await shopifyGraphql(client, `query { shop { id name myshopifyDomain email primaryDomain { url } plan { displayName } } }`));
    case 'list_products':
      return textToolResult(await shopifyGraphql(client, `
        query Products($first: Int!, $query: String) {
          products(first: $first, query: $query) {
            nodes { id title handle status vendor productType totalInventory updatedAt }
          }
        }
      `, { first: limit, query: optionalString(args.query) || null }));
    case 'get_product':
      return textToolResult(await shopifyGraphql(client, `
        query Product($id: ID!) {
          product(id: $id) {
            id title handle status vendor productType description totalInventory updatedAt
            variants(first: 25) { nodes { id title sku price inventoryQuantity } }
          }
        }
      `, { id: requireString(args.id, 'id') }));
    case 'list_orders':
      return textToolResult(await shopifyGraphql(client, `
        query Orders($first: Int!, $query: String) {
          orders(first: $first, query: $query, reverse: true) {
            nodes { id name displayFinancialStatus displayFulfillmentStatus createdAt totalPriceSet { shopMoney { amount currencyCode } } }
          }
        }
      `, { first: limit, query: optionalString(args.query) || null }));
    case 'get_order':
      return textToolResult(await shopifyGraphql(client, `
        query Order($id: ID!) {
          order(id: $id) {
            id name email createdAt displayFinancialStatus displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 50) { nodes { name quantity sku originalTotalSet { shopMoney { amount currencyCode } } } }
          }
        }
      `, { id: requireString(args.id, 'id') }));
    default:
      throw Object.assign(new Error(`Unknown Shopify tool: ${name}`), { status: 404 });
  }
}

async function createShopifyClient(env: ShopifyMcpEnv, record: WorkspaceIntegrationRecord): Promise<ShopifyClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  return {
    shopDomain: normalizeShopDomain(requireString(config.shop_domain, 'shop_domain')),
    token: requireString(credentials.api_key, 'api_key'),
  };
}

async function shopifyGraphql(client: ShopifyClient, query: string, variables: Record<string, unknown> = {}): Promise<JsonValue> {
  const response = await fetchMcpHttp(`https://${client.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'x-shopify-access-token': client.token,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as JsonValue & { errors?: Array<{ message?: string }> } : {} as JsonValue;
  if (!response.ok || Array.isArray((payload as { errors?: unknown }).errors)) {
    const message = Array.isArray((payload as { errors?: Array<{ message?: string }> }).errors)
      ? (payload as { errors: Array<{ message?: string }> }).errors[0]?.message
      : '';
    throw Object.assign(new Error(message || `Shopify API request failed with HTTP ${response.status}`), { status: response.status || 502 });
  }
  return payload;
}

function normalizeShopDomain(rawDomain: string): string {
  const hostname = rawDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(hostname)) {
    throw Object.assign(new Error('shop_domain must be a myshopify.com hostname.'), { status: 400 });
  }
  return hostname;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
