/**
 * Zero-drift forwarding WorkerEntrypoint proxies exported by `chiridion-dispatcher`
 * for hosted Dynamic Workers.
 *
 * Each proxy carries tenant-isolated `props` (`orgId`, `workspaceId`, `userId`)
 * attached by the dispatcher when constructing the Dynamic Worker's `env`, and
 * delegates RPC calls straight to `chiridion-app`'s `DynamicServiceBroker` via
 * the `MAIN_APP_BROKER` service binding.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  BrokeredVirtualServiceName,
  DynamicServiceBroker,
} from '../../../main/src/dynamic-service-broker';

export interface ServiceProxyEnv {
  MAIN_APP_BROKER?: Service<DynamicServiceBroker>;
}

export interface TenantServiceProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

abstract class BrokeredServiceProxy extends WorkerEntrypoint<
  ServiceProxyEnv,
  TenantServiceProps
> {
  protected abstract readonly serviceName: BrokeredVirtualServiceName;

  protected callBroker(method: string, ...args: unknown[]): Promise<unknown> {
    if (!this.env.MAIN_APP_BROKER) {
      throw new Error(
        `MAIN_APP_BROKER service binding is not configured on chiridion-dispatcher (required for ${this.serviceName})`,
      );
    }
    const props: Record<string, unknown> = {
      orgId: this.ctx.props.orgId,
      workspaceId: this.ctx.props.workspaceId,
      ...(this.ctx.props.userId ? { userId: this.ctx.props.userId } : {}),
    };
    return this.env.MAIN_APP_BROKER.invoke(this.serviceName, props, method, args);
  }
}

export class DynamicAIVirtualBinding extends BrokeredServiceProxy {
  protected readonly serviceName = 'AIVirtualBinding';

  run(model: string, input: unknown, options?: unknown): Promise<unknown> {
    return this.callBroker('run', model, input, options);
  }
}

export class DynamicCamelAiService extends BrokeredServiceProxy {
  protected readonly serviceName = 'CamelAiService';

  generateImage(input: unknown): Promise<unknown> {
    return this.callBroker('generateImage', input);
  }

  transcribeAudio(input: unknown): Promise<unknown> {
    return this.callBroker('transcribeAudio', input);
  }
}

export class DynamicConnectionsService extends BrokeredServiceProxy {
  protected readonly serviceName = 'ConnectionsService';

  list(): Promise<unknown> {
    return this.callBroker('list');
  }

  get(connection: string): Promise<unknown> {
    return this.callBroker('get', connection);
  }

  tools(connection: string): Promise<unknown> {
    return this.callBroker('tools', connection);
  }

  methods(): Promise<unknown> {
    return this.callBroker('methods');
  }

  find(query: unknown): Promise<unknown> {
    return this.callBroker('find', query);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WorkerEntrypoint reserves optional `test(controller)` in @cloudflare/workers-types
  test(query: any): Promise<any> {
    return this.callBroker('test', query);
  }

  verify(query: unknown): Promise<unknown> {
    return this.callBroker('verify', query);
  }

  invoke(request: unknown): Promise<unknown> {
    return this.callBroker('invoke', request);
  }

  __invoke(request: unknown): Promise<unknown> {
    return this.callBroker('__invoke', request);
  }
}

export class DynamicDataProxyService extends BrokeredServiceProxy {
  protected readonly serviceName = 'DataProxyService';

  mssqlQuery(request: unknown): Promise<unknown> {
    return this.callBroker('mssqlQuery', request);
  }

  postgresQuery(request: unknown): Promise<unknown> {
    return this.callBroker('postgresQuery', request);
  }

  mysqlQuery(request: unknown): Promise<unknown> {
    return this.callBroker('mysqlQuery', request);
  }
}

export class DynamicAnalysisAppService extends BrokeredServiceProxy {
  protected readonly serviceName = 'AnalysisAppService';

  runCode(request: unknown): Promise<unknown> {
    return this.callBroker('runCode', request);
  }

  listConnections(): Promise<unknown> {
    return this.callBroker('listConnections');
  }
}

export class DynamicWarehouseService extends BrokeredServiceProxy {
  protected readonly serviceName = 'WarehouseService';

  runCode(request: unknown): Promise<unknown> {
    return this.callBroker('runCode', request);
  }

  listConnections(): Promise<unknown> {
    return this.callBroker('listConnections');
  }
}
