/**
 * Generates the hardened `__chiridion_wrapper.mjs` module injected around every
 * hosted Dynamic Worker and Durable Object Facet.
 *
 * Non-negotiable runtime invariants (verified on live Cloudflare edge):
 * 1. ZERO top-level I/O (no crypto.randomUUID(), fetch(), or storage calls at module eval).
 * 2. NEVER wrap `ctx` in a Proxy — workerd C++ brand checks reject Proxy(ctx).
 *    Instead, patch native `ctx.storage.sql.exec` and `ctx.storage.{setAlarm,getAlarm,deleteAlarm}`
 *    via `Object.defineProperty`.
 * 3. Direct WebSocket pass-through via `TenantDoRouter` RPC (`fetchObject`), never an HTTP loopback.
 * 4. Native structured-clone RPC for DO methods (`rpcObject`), never URL query serialization.
 */

import {
  extractCodemodeLoaderBindingNames,
  type DynamicWorkerBundleRecord,
} from '../../../main/src/dynamic-worker-registry';

function quotedModuleSpecifier(moduleName: string): string {
  return JSON.stringify(moduleName.startsWith('.') ? moduleName : `./${moduleName}`);
}

function assertValidClassIdentifier(className: string): void {
  if (!/^[$A-Z_a-z][$\w]*$/.test(className) || className === 'default') {
    throw new Error(`Invalid Durable Object class name: ${className}`);
  }
}

export function generateDynamicWorkerWrapperSource(
  record: DynamicWorkerBundleRecord,
): string {
  const classNames = [...new Set(Object.values(record.doBindings))];
  for (const className of classNames) {
    assertValidClassIdentifier(className);
  }
  const codemodeBindingNames = extractCodemodeLoaderBindingNames(record.bindings);

  const durableObjectExports = classNames
    .map(
      (className) =>
        `export class ${className} extends ChiridionMeteredDurableObject {\n` +
        `  static __chiridionClassName = ${JSON.stringify(className)};\n` +
        `}`,
    )
    .join('\n\n');

  return `
import { DurableObject } from "cloudflare:workers";

const USER_MAIN_MODULE = ${quotedModuleSpecifier(record.mainModule)};
const CODEMODE_BINDING_NAMES = ${JSON.stringify(codemodeBindingNames)};

class QuotaExceededError extends Error {
  constructor(reason, limit, observed) {
    super("Quota exceeded (" + reason + "): observed=" + observed + " limit=" + limit);
    this.name = "QuotaExceededError";
    this.code = "CHIRIDION_QUOTA_EXCEEDED";
    this.reason = reason;
    this.limit = limit;
    this.observed = observed;
  }
}

class DynamicDurableObjectId {
  constructor(value, name) {
    this.value = String(value);
    if (name !== undefined) this.name = name;
  }
  toString() {
    return this.value;
  }
  equals(other) {
    return Boolean(other) && String(other) === this.value;
  }
}

class DynamicDurableObjectStub {
  constructor(router, appId, className, id, name) {
    this.__router = router;
    this.__appId = appId;
    this.__className = className;
    this.id = id;
    if (name !== undefined) this.name = name;
  }
  fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    return this.__router.fetchObject(
      this.__appId,
      this.__className,
      this.id.toString(),
      request,
    );
  }
  __rpc(method, args) {
    return this.__router.rpcObject(
      this.__appId,
      this.__className,
      this.id.toString(),
      method,
      args,
    );
  }
}

class DynamicDurableObjectNamespace {
  constructor(router, appId, className) {
    this.__router = router;
    this.__appId = appId;
    this.__className = className;
  }
  idFromName(name) {
    const str = String(name);
    return new DynamicDurableObjectId("name:" + str, str);
  }
  idFromString(id) {
    return new DynamicDurableObjectId(String(id));
  }
  newUniqueId() {
    return new DynamicDurableObjectId("unique:" + crypto.randomUUID());
  }
  get(id) {
    const stub = new DynamicDurableObjectStub(
      this.__router,
      this.__appId,
      this.__className,
      id,
      id?.name,
    );
    return new Proxy(stub, {
      get(target, property, receiver) {
        if (typeof property !== "string") {
          return Reflect.get(target, property, receiver);
        }
        if (property in target || property === "then") {
          return Reflect.get(target, property, receiver);
        }
        return (...args) => target.__rpc(property, args);
      },
    });
  }
  getByName(name) {
    return this.get(this.idFromName(name));
  }
  jurisdiction() {
    return this;
  }
}

function createCodemodeLoaderShim(proxy) {
  const wrap = (id, getSpec) => {
    let specPromise;
    const resolveSpec = () => {
      if (!specPromise) {
        specPromise = Promise.resolve().then(() => getSpec());
      }
      return specPromise;
    };
    return {
      getEntrypoint(entrypointName) {
        return new Proxy(
          { [Symbol.dispose]() {} },
          {
            get(target, prop) {
              if (prop === Symbol.dispose || prop === "then") {
                return target[prop];
              }
              if (prop === "fetch") {
                return async (input, init) => {
                  const spec = await resolveSpec();
                  const request = input instanceof Request ? input : new Request(input, init);
                  return proxy.fetchEntrypoint(id, spec, entrypointName, request);
                };
              }
              return async (...args) => {
                const spec = await resolveSpec();
                return proxy.invokeEntrypoint(id, spec, entrypointName, String(prop), args);
              };
            },
          },
        );
      },
      [Symbol.dispose]() {},
    };
  };

  return {
    load(spec) {
      return wrap(null, () => spec);
    },
    get(id, getCode) {
      return wrap(id == null ? null : String(id), getCode);
    },
  };
}

function buildTenantEnv(env) {
  const nextEnv = Object.create(env);
  const doBindings = env.__CHIRIDION_DO_BINDINGS || {};
  const router = env.__CHIRIDION_DO_ROUTER;
  const appId = env.__CHIRIDION_APP_ID;
  if (router && appId) {
    for (const [bindingName, className] of Object.entries(doBindings)) {
      nextEnv[bindingName] = new DynamicDurableObjectNamespace(router, appId, className);
    }
  }
  if (env.__CHIRIDION_CODEMODE_PROXY && CODEMODE_BINDING_NAMES.length > 0) {
    const loaderShim = createCodemodeLoaderShim(env.__CHIRIDION_CODEMODE_PROXY);
    for (const bindingName of CODEMODE_BINDING_NAMES) {
      nextEnv[bindingName] = loaderShim;
    }
  }
  return nextEnv;
}

let userModulePromise;
function getUserModule() {
  userModulePromise ||= import(USER_MAIN_MODULE);
  return userModulePromise;
}

function createMeteredSqlCursor(rawCursor, meter) {
  let lastRead = 0;
  let lastWritten = 0;

  const syncDelta = () => {
    const curRead = Number(rawCursor.rowsRead) || 0;
    const curWritten = Number(rawCursor.rowsWritten) || 0;
    const dRead = curRead - lastRead;
    const dWritten = curWritten - lastWritten;
    if (dRead > 0 || dWritten > 0) {
      lastRead = curRead;
      lastWritten = curWritten;
      meter.record(dRead, dWritten);
    }
  };

  // Capture any rows read/written eagerly during exec() preparation.
  syncDelta();

  const cursor = {
    get columnNames() {
      return rawCursor.columnNames;
    },
    get rowsRead() {
      syncDelta();
      return rawCursor.rowsRead;
    },
    get rowsWritten() {
      syncDelta();
      return rawCursor.rowsWritten;
    },
    next() {
      const result = rawCursor.next();
      syncDelta();
      return result;
    },
    toArray() {
      const rows = [];
      for (const row of rawCursor) {
        syncDelta();
        rows.push(row);
      }
      syncDelta();
      return rows;
    },
    one() {
      const result = rawCursor.one();
      syncDelta();
      return result;
    },
    raw() {
      const rawIter = rawCursor.raw();
      return {
        next() {
          const result = rawIter.next();
          syncDelta();
          return result;
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    },
    [Symbol.iterator]() {
      return {
        next() {
          const result = rawCursor.next();
          syncDelta();
          return result;
        },
      };
    },
  };
  return cursor;
}

function installNativeStoragePatches(ctx, env, meter) {
  const storage = ctx.storage;
  if (!storage) return;

  // 1. Patch ctx.storage.sql.exec via Object.defineProperty (never Proxy(ctx)!).
  try {
    const sql = storage.sql;
    if (sql && typeof sql.exec === "function") {
      const origExec = sql.exec.bind(sql);
      Object.defineProperty(sql, "exec", {
        configurable: true,
        writable: true,
        value: function meteredExec(query, ...bindings) {
          meter.checkDbSize(sql);
          const rawCursor = origExec(query, ...bindings);
          return createMeteredSqlCursor(rawCursor, meter);
        },
      });
    }
  } catch {
    // Non-SQLite storage or unsupported in local mock.
  }

  // 2. Patch ctx.storage.{setAlarm, getAlarm, deleteAlarm} via AlarmMediator RPC
  //    to work around workerd #6810 ("Facets currently cannot set alarms.").
  const alarmMediator = env.__CHIRIDION_ALARM_MEDIATOR;
  if (alarmMediator) {
    Object.defineProperty(storage, "setAlarm", {
      configurable: true,
      writable: true,
      value: function bridgedSetAlarm(scheduledTime, options) {
        const ts = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
        return alarmMediator.setAlarm(ts, options);
      },
    });
    Object.defineProperty(storage, "getAlarm", {
      configurable: true,
      writable: true,
      value: function bridgedGetAlarm(options) {
        return alarmMediator.getAlarm(options);
      },
    });
    Object.defineProperty(storage, "deleteAlarm", {
      configurable: true,
      writable: true,
      value: function bridgedDeleteAlarm(options) {
        return alarmMediator.deleteAlarm(options);
      },
    });
  }
}

class ChiridionMeteredDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.__rawCtx = ctx;
    this.__rawEnv = env;
    this.__tenantEnv = buildTenantEnv(env);
    this.__userInstancePromise = undefined;
    this.__limits = env.__CHIRIDION_QUOTA_LIMITS || null;
    this.__dailyRowsRead = Number(env.__CHIRIDION_DAILY_ROWS_READ) || 0;
    this.__dailyRowsWritten = Number(env.__CHIRIDION_DAILY_ROWS_WRITTEN) || 0;
    this.__eventRowsRead = 0;
    this.__eventRowsWritten = 0;
    this.__totalDeltaRead = 0;
    this.__totalDeltaWritten = 0;
    this.__quotaTrips = 0;
    this.__lastTripReason = null;

    const self = this;
    this.__meter = {
      checkDbSize(sql) {
        const limits = self.__limits;
        if (!limits || !limits.maxDbSizeBytes) return;
        const size = Number(sql.databaseSize) || 0;
        if (size > limits.maxDbSizeBytes) {
          self.__trip("db_size_bytes", limits.maxDbSizeBytes, size);
        }
      },
      record(dRead, dWritten) {
        self.__eventRowsRead += dRead;
        self.__eventRowsWritten += dWritten;
        self.__totalDeltaRead += dRead;
        self.__totalDeltaWritten += dWritten;
        const limits = self.__limits;
        if (!limits) return;
        if (limits.maxRowsWrittenPerEvent > 0 && self.__eventRowsWritten > limits.maxRowsWrittenPerEvent) {
          self.__trip("event_rows_written", limits.maxRowsWrittenPerEvent, self.__eventRowsWritten);
        }
        if (limits.maxRowsReadPerEvent > 0 && self.__eventRowsRead > limits.maxRowsReadPerEvent) {
          self.__trip("event_rows_read", limits.maxRowsReadPerEvent, self.__eventRowsRead);
        }
        const projectedWritten = self.__dailyRowsWritten + self.__totalDeltaWritten;
        if (limits.maxRowsWrittenPerDay > 0 && projectedWritten > limits.maxRowsWrittenPerDay) {
          self.__trip("daily_rows_written", limits.maxRowsWrittenPerDay, projectedWritten);
        }
        const projectedRead = self.__dailyRowsRead + self.__totalDeltaRead;
        if (limits.maxRowsReadPerDay > 0 && projectedRead > limits.maxRowsReadPerDay) {
          self.__trip("daily_rows_read", limits.maxRowsReadPerDay, projectedRead);
        }
      },
    };

    installNativeStoragePatches(ctx, env, this.__meter);
  }

  __trip(reason, limit, observed) {
    this.__quotaTrips += 1;
    this.__lastTripReason = reason;
    const reporter = this.__rawEnv.__CHIRIDION_QUOTA_REPORTER;
    if (reporter && typeof reporter.reportQuotaTrip === "function") {
      try {
        const promise = reporter.reportQuotaTrip(reason, limit, observed, this.__quotaTrips);
        if (promise && typeof promise.catch === "function") promise.catch(() => {});
      } catch {}
    }
    throw new QuotaExceededError(reason, limit, observed);
  }

  __beginEvent() {
    this.__eventRowsRead = 0;
    this.__eventRowsWritten = 0;
  }

  __chiridionFlushMetrics() {
    const deltaRead = this.__totalDeltaRead;
    const deltaWritten = this.__totalDeltaWritten;
    this.__dailyRowsRead += deltaRead;
    this.__dailyRowsWritten += deltaWritten;
    this.__totalDeltaRead = 0;
    this.__totalDeltaWritten = 0;
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = Number(this.__rawCtx.storage.sql.databaseSize) || 0;
    } catch {}
    const trips = this.__quotaTrips;
    const lastTripReason = this.__lastTripReason;
    this.__quotaTrips = 0;
    this.__lastTripReason = null;
    return {
      rowsRead: deltaRead,
      rowsWritten: deltaWritten,
      dbSizeBytes,
      trips,
      lastTripReason,
    };
  }

  async __getUserInstance() {
    if (!this.__userInstancePromise) {
      this.__userInstancePromise = getUserModule().then((mod) => {
        const className = this.constructor.__chiridionClassName;
        const UserClass = mod[className];
        if (typeof UserClass !== "function") {
          throw new Error("Durable Object class not found in user bundle: " + className);
        }
        return new UserClass(this.__rawCtx, this.__tenantEnv);
      });
    }
    return this.__userInstancePromise;
  }

  async fetch(request) {
    this.__beginEvent();
    const instance = await this.__getUserInstance();
    if (typeof instance.fetch !== "function") {
      return new Response("Durable Object fetch handler not found", { status: 404 });
    }
    return instance.fetch(request);
  }

  async __chiridionRunAlarm(alarmInfo) {
    this.__beginEvent();
    const instance = await this.__getUserInstance();
    if (typeof instance.alarm === "function") {
      return instance.alarm(alarmInfo);
    }
  }

  async alarm(alarmInfo) {
    return this.__chiridionRunAlarm(alarmInfo);
  }

  async webSocketMessage(ws, message) {
    this.__beginEvent();
    const instance = await this.__getUserInstance();
    if (typeof instance.webSocketMessage === "function") {
      return instance.webSocketMessage(ws, message);
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.__beginEvent();
    const instance = await this.__getUserInstance();
    if (typeof instance.webSocketClose === "function") {
      return instance.webSocketClose(ws, code, reason, wasClean);
    }
  }

  async webSocketError(ws, error) {
    this.__beginEvent();
    const instance = await this.__getUserInstance();
    if (typeof instance.webSocketError === "function") {
      return instance.webSocketError(ws, error);
    }
  }

  async __chiridionCallMethod(method, args) {
    this.__beginEvent();
    const instance = await this.__getUserInstance();
    const fn = instance?.[method];
    if (typeof fn !== "function") {
      throw new Error("Durable Object method not found: " + method);
    }
    return fn.apply(instance, args);
  }
}

${durableObjectExports}

export default {
  async fetch(request, env, ctx) {
    const tenantEnv = buildTenantEnv(env);
    const mod = await getUserModule();
    const handler = mod.default;
    if (!handler || typeof handler.fetch !== "function") {
      return new Response("User worker default fetch handler not found", { status: 500 });
    }
    return handler.fetch(request, tenantEnv, ctx);
  },
};
`;
}
