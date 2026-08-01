import { describe, it, expect } from 'vitest';
import { mapVirtualizedBindings, validateBindings, type WorkerBinding } from '../src/cf-api-proxy.js';

describe('Worker Binding Validation', () => {
  describe('validateBindings', () => {
    it('allows empty bindings array', () => {
      const result = validateBindings([]);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows plain_text environment variables', () => {
      const bindings: WorkerBinding[] = [
        { type: 'plain_text', name: 'MY_VAR' },
        { type: 'plain_text', name: 'ANOTHER_VAR' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows secret_text environment variables', () => {
      const bindings: WorkerBinding[] = [
        { type: 'secret_text', name: 'API_KEY' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows json environment variables', () => {
      const bindings: WorkerBinding[] = [
        { type: 'json', name: 'CONFIG' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows local Durable Objects (no script_name)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'durable_object_namespace', name: 'MY_DO', class_name: 'MyDurableObject' },
        { type: 'durable_object_namespace', name: 'ANOTHER_DO', class_name: 'AnotherDO' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows wasm_module bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'wasm_module', name: 'WASM' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows text_blob and data_blob bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'text_blob', name: 'TEXT_DATA' },
        { type: 'data_blob', name: 'BINARY_DATA' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows assets bindings (static assets bundled with worker)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'assets', name: 'ASSETS' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('blocks external Durable Objects (with script_name)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'durable_object_namespace', name: 'EXTERNAL_DO', class_name: 'SomeClass', script_name: 'other-worker' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('EXTERNAL_DO');
      expect(result.forbiddenBindings[0]?.type).toBe('durable_object_namespace');
      expect(result.forbiddenBindings[0]?.reason).toContain('External Durable Object');
    });

    it('allows KV namespace bindings (transformed to virtual KV at deploy time)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'kv_namespace', name: 'MY_KV', namespace_id: 'some-id' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('blocks D1 database bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'd1', name: 'MY_DB', database_id: 'some-id' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('MY_DB');
      expect(result.forbiddenBindings[0]?.type).toBe('d1');
    });

    it('allows R2 bucket bindings (transformed to virtual R2 at deploy time)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'r2_bucket', name: 'MY_BUCKET', bucket_name: 'some-bucket' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows multiple R2 bucket bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'r2_bucket', name: 'UPLOADS', bucket_name: 'user-uploads' },
        { type: 'r2_bucket', name: 'CACHE', bucket_name: 'app-cache' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('blocks queue bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'queue', name: 'MY_QUEUE' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('MY_QUEUE');
      expect(result.forbiddenBindings[0]?.type).toBe('queue');
    });

    it('allows virtual DATA_PROXY service binding (rewritten at deploy time)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'service', name: 'DATA_PROXY', service: 'placeholder' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows virtual CONNECTIONS service binding (rewritten at deploy time)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'service', name: 'CONNECTIONS', service: 'placeholder' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows virtual WAREHOUSE service binding (rewritten at deploy time)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'service', name: 'WAREHOUSE', service: 'placeholder' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('blocks SELF service binding', () => {
      const bindings: WorkerBinding[] = [
        { type: 'service', name: 'SELF', service: 'starter', entrypoint: 'InternetProxy' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('SELF');
      expect(result.forbiddenBindings[0]?.type).toBe('service');
    });

    it('allows worker_loader bindings (codemode DynamicWorkerExecutor)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'worker_loader', name: 'LOADER' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('blocks other service bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'service', name: 'OTHER_WORKER' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('OTHER_WORKER');
      expect(result.forbiddenBindings[0]?.type).toBe('service');
    });

    it('blocks analytics_engine bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'analytics_engine', name: 'ANALYTICS' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('ANALYTICS');
      expect(result.forbiddenBindings[0]?.type).toBe('analytics_engine');
    });

    it('allows ai bindings (transformed to virtual AI binding at deploy time)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'ai', name: 'AI' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('blocks AI service binding (native ai binding must be used)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'service', name: 'AI', service: 'placeholder' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('AI');
      expect(result.forbiddenBindings[0]?.type).toBe('service');
    });

    it('blocks browser rendering bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'browser', name: 'BROWSER' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('BROWSER');
      expect(result.forbiddenBindings[0]?.type).toBe('browser');
    });

    it('blocks vectorize bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'vectorize', name: 'VECTORS' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('VECTORS');
      expect(result.forbiddenBindings[0]?.type).toBe('vectorize');
    });

    it('blocks hyperdrive bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'hyperdrive', name: 'HYPERDRIVE' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('HYPERDRIVE');
      expect(result.forbiddenBindings[0]?.type).toBe('hyperdrive');
    });

    it('blocks dispatch_namespace bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'dispatch_namespace', name: 'DISPATCH' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('DISPATCH');
      expect(result.forbiddenBindings[0]?.type).toBe('dispatch_namespace');
    });

    it('blocks mtls_certificate bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'mtls_certificate', name: 'CERT' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('CERT');
      expect(result.forbiddenBindings[0]?.type).toBe('mtls_certificate');
    });

    it('blocks send_email bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'send_email', name: 'EMAIL' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('EMAIL');
      expect(result.forbiddenBindings[0]?.type).toBe('send_email');
    });

    it('blocks unknown binding types', () => {
      const bindings: WorkerBinding[] = [
        { type: 'some_future_binding', name: 'UNKNOWN' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('UNKNOWN');
      expect(result.forbiddenBindings[0]?.type).toBe('some_future_binding');
      expect(result.forbiddenBindings[0]?.reason).toContain('Unknown binding type');
    });

    it('reports all forbidden bindings in a mixed set', () => {
      const bindings: WorkerBinding[] = [
        // Allowed
        { type: 'plain_text', name: 'ENV_VAR' },
        { type: 'kv_namespace', name: 'KV1', namespace_id: 'id1' },
        { type: 'durable_object_namespace', name: 'LOCAL_DO', class_name: 'MyClass' },
        // Forbidden
        { type: 'd1', name: 'DB1', database_id: 'id2' },
        { type: 'durable_object_namespace', name: 'EXTERNAL_DO', class_name: 'Class', script_name: 'other' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(2);

      const forbiddenNames = result.forbiddenBindings.map(b => b.name);
      expect(forbiddenNames).toContain('DB1');
      expect(forbiddenNames).toContain('EXTERNAL_DO');
    });

    it('allows a realistic worker with only valid bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'plain_text', name: 'APP_NAME' },
        { type: 'secret_text', name: 'API_KEY' },
        { type: 'json', name: 'CONFIG' },
        { type: 'durable_object_namespace', name: 'COUNTER', class_name: 'Counter' },
        { type: 'durable_object_namespace', name: 'SESSION', class_name: 'Session' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows a full-stack app with assets, Durable Objects, and R2', () => {
      const bindings: WorkerBinding[] = [
        { type: 'assets', name: 'ASSETS' },
        { type: 'durable_object_namespace', name: 'ROOMS', class_name: 'ChatRoom' },
        { type: 'r2_bucket', name: 'STORAGE', bucket_name: 'my-app-storage' },
        { type: 'plain_text', name: 'PUBLIC_URL' },
        { type: 'secret_text', name: 'JWT_SECRET' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });
  });

  describe('mapVirtualizedBindings', () => {
    it('rewrites declared virtual bindings and injects CAMELAI', () => {
      const bindings: WorkerBinding[] = [
        { type: 'kv_namespace', name: 'KV', namespace_id: 'messages' },
        { type: 'r2_bucket', name: 'FILES', bucket_name: 'workspace-files' },
        { type: 'assets', name: 'ASSETS' },
        { type: 'service', name: 'DATA_PROXY', service: 'placeholder' },
        { type: 'service', name: 'CONNECTIONS', service: 'placeholder' },
        { type: 'ai', name: 'AI' },
        { type: 'plain_text', name: 'APP_ENV', text: 'prod' },
      ];

      const transformed = mapVirtualizedBindings(bindings, 'ws_123', 'org_456', 'user_789', 'chiridion-app', 'demo--acme');

      expect(transformed).toEqual([
        {
          type: 'service',
          name: 'KV',
          service: 'chiridion-app',
          entrypoint: 'KVVirtualNamespace',
          props: { workspaceId: 'ws_123', appId: 'demo--acme', namespaceId: 'messages' },
        },
        {
          type: 'service',
          name: 'FILES',
          service: 'chiridion-app',
          entrypoint: 'R2VirtualBucket',
          props: { workspaceId: 'ws_123', bucketName: 'workspace-files' },
        },
        {
          type: 'service',
          name: 'ASSETS',
          service: 'chiridion-app',
          entrypoint: 'AssetsVirtualBinding',
          props: { appId: 'demo--acme' },
        },
        {
          type: 'service',
          name: 'DATA_PROXY',
          service: 'chiridion-app',
          entrypoint: 'DataProxyService',
          props: { workspaceId: 'ws_123', orgId: 'org_456' },
        },
        {
          type: 'service',
          name: 'CONNECTIONS',
          service: 'chiridion-app',
          entrypoint: 'ConnectionsService',
          props: { workspaceId: 'ws_123', orgId: 'org_456', userId: 'user_789' },
        },
        {
          type: 'service',
          name: 'AI',
          service: 'chiridion-app',
          entrypoint: 'AIVirtualBinding',
          props: { workspaceId: 'ws_123', orgId: 'org_456', userId: 'user_789' },
        },
        { type: 'plain_text', name: 'APP_ENV', text: 'prod' },
        {
          type: 'service',
          name: 'CAMELAI',
          service: 'chiridion-app',
          entrypoint: 'CamelAiService',
          props: { workspaceId: 'ws_123', orgId: 'org_456', userId: 'user_789' },
        },
      ]);
    });

    it('rewrites a WAREHOUSE service binding to the WarehouseService entrypoint with tenant props', () => {
      const bindings: WorkerBinding[] = [
        { type: 'service', name: 'WAREHOUSE', service: 'placeholder' },
      ];

      const transformed = mapVirtualizedBindings(bindings, 'ws_123', 'org_456', 'user_789', 'chiridion-app', 'demo--acme');

      // WAREHOUSE rewrites to WarehouseService; a default CONNECTIONS binding is
      // always appended by mapVirtualizedBindings.
      expect(transformed).toEqual([
        {
          type: 'service',
          name: 'WAREHOUSE',
          service: 'chiridion-app',
          entrypoint: 'WarehouseService',
          props: { workspaceId: 'ws_123', orgId: 'org_456' },
        },
        {
          type: 'service',
          name: 'CONNECTIONS',
          service: 'chiridion-app',
          entrypoint: 'ConnectionsService',
          props: { workspaceId: 'ws_123', orgId: 'org_456', userId: 'user_789' },
        },
        {
          type: 'service',
          name: 'CAMELAI',
          service: 'chiridion-app',
          entrypoint: 'CamelAiService',
          props: { workspaceId: 'ws_123', orgId: 'org_456', userId: 'user_789' },
        },
      ]);
    });

    it('rewrites starter local DATA_PROXY, CONNECTIONS, and CAMELAI shim bindings to internal services', () => {
      const bindings: WorkerBinding[] = [
        {
          type: 'service',
          name: 'DATA_PROXY',
          service: 'starter',
          entrypoint: 'LocalDataProxyService',
        },
        {
          type: 'service',
          name: 'CONNECTIONS',
          service: 'starter',
          entrypoint: 'LocalConnectionsService',
        },
        {
          type: 'service',
          name: 'CAMELAI',
          service: 'starter',
          entrypoint: 'LocalCamelAiService',
        },
      ];

      const transformed = mapVirtualizedBindings(bindings, 'ws_abc', 'org_xyz', undefined, 'chiridion-app', 'demo--acme');

      expect(transformed).toEqual([
        {
          type: 'service',
          name: 'DATA_PROXY',
          service: 'chiridion-app',
          entrypoint: 'DataProxyService',
          props: { workspaceId: 'ws_abc', orgId: 'org_xyz' },
        },
        {
          type: 'service',
          name: 'CONNECTIONS',
          service: 'chiridion-app',
          entrypoint: 'ConnectionsService',
          props: { workspaceId: 'ws_abc', orgId: 'org_xyz' },
        },
        {
          type: 'service',
          name: 'CAMELAI',
          service: 'chiridion-app',
          entrypoint: 'CamelAiService',
          props: { workspaceId: 'ws_abc', orgId: 'org_xyz' },
        },
      ]);
    });

    it('injects CONNECTIONS and CAMELAI when user metadata does not declare them', () => {
      const bindings: WorkerBinding[] = [
        { type: 'plain_text', name: 'APP_ENV', text: 'prod' },
      ];

      const transformed = mapVirtualizedBindings(bindings, 'ws_auto', 'org_auto', 'user_auto', 'chiridion-app');

      expect(transformed).toEqual([
        { type: 'plain_text', name: 'APP_ENV', text: 'prod' },
        {
          type: 'service',
          name: 'CONNECTIONS',
          service: 'chiridion-app',
          entrypoint: 'ConnectionsService',
          props: { workspaceId: 'ws_auto', orgId: 'org_auto', userId: 'user_auto' },
        },
        {
          type: 'service',
          name: 'CAMELAI',
          service: 'chiridion-app',
          entrypoint: 'CamelAiService',
          props: { workspaceId: 'ws_auto', orgId: 'org_auto', userId: 'user_auto' },
        },
      ]);
    });

    it('strips and does not inject CONNECTIONS when the binding is disabled', () => {
      const bindings: WorkerBinding[] = [
        { type: 'plain_text', name: 'APP_ENV', text: 'prod' },
        { type: 'service', name: 'CONNECTIONS', service: 'placeholder' },
        { type: 'service', name: 'CAMELAI', service: 'placeholder' },
      ];

      const transformed = mapVirtualizedBindings(
        bindings,
        'ws_locked',
        'org_locked',
        'user_locked',
        'chiridion-app',
        'app_locked',
        { connectionsBindingEnabled: false },
      );

      expect(transformed.find((binding) => binding.name === 'CONNECTIONS')).toBeUndefined();
      expect(transformed).toEqual([
        { type: 'plain_text', name: 'APP_ENV', text: 'prod' },
        {
          type: 'service',
          name: 'CAMELAI',
          service: 'chiridion-app',
          entrypoint: 'CamelAiService',
          props: { workspaceId: 'ws_locked', orgId: 'org_locked', userId: 'user_locked' },
        },
      ]);
    });

  });
});
