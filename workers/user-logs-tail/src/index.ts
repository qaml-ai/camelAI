/**
 * User Logs Tail Worker
 *
 * Captures tail events from user-deployed workers and forwards them to
 * the persistent logs DO for storage and retrieval.
 */

import type { WorkerLogsDO } from '../../main/src/worker-logs-do.js';

export interface Env {
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
}

export interface LogEvent {
  timestamp: number;
  level: string;
  message: string | null;
  exception: string | null;
  scriptVersion: string | null;
}

/**
 * Extract a readable message from a console log.
 */
function extractMessage(log: TraceLog): string | null {
  if (!log.message || log.message.length === 0) {
    return null;
  }
  // Join all parts of the message
  return log.message.map((part: unknown) => {
    if (typeof part === 'string') return part;
    if (typeof part === 'object') {
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    }
    return String(part);
  }).join(' ');
}

/**
 * Convert a TraceItem into normalized log events for storage.
 */
function traceItemToLogEvents(item: TraceItem): LogEvent[] {
  const events: LogEvent[] = [];
  const timestamp = item.eventTimestamp ?? Date.now();
  const scriptVersion = item.scriptVersion ? String(item.scriptVersion) : null;

  // Process console logs
  if (item.logs && item.logs.length > 0) {
    for (const log of item.logs) {
      events.push({
        timestamp: log.timestamp ?? timestamp,
        level: log.level ?? 'log',
        message: extractMessage(log),
        exception: null,
        scriptVersion,
      });
    }
  }

  // Process exceptions
  if (item.exceptions && item.exceptions.length > 0) {
    for (const exception of item.exceptions) {
      events.push({
        timestamp: exception.timestamp ?? timestamp,
        level: 'error',
        message: exception.message ?? null,
        exception: exception.name ? `${exception.name}: ${exception.message ?? ''}` : (exception.message ?? null),
        scriptVersion,
      });
    }
  }

  // Skip empty requests with no console logs and no exceptions to avoid waking WorkerLogsDO
  // on every clean HTTP request.
  return events;
}

export default {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    // Group events by script name
    const eventsByScript = new Map<string, LogEvent[]>();

    for (const item of events) {
      const scriptName = item.scriptName;
      if (!scriptName) continue;
      // Never ingest platform main worker traffic into WorkerLogsDO (nothing reads it;
      // chiridion-app uses native Cloudflare Workers Observability).
      if (scriptName === 'chiridion-app' || scriptName.startsWith('chiridion-app-')) continue;

      const logEvents = traceItemToLogEvents(item);
      if (logEvents.length === 0) continue;

      const existing = eventsByScript.get(scriptName) ?? [];
      existing.push(...logEvents);
      eventsByScript.set(scriptName, existing);
    }

    // Forward to the persistent logs DO for each script.
    await Promise.all(
      Array.from(eventsByScript.entries()).map(async ([scriptName, scriptEvents]) => {
        try {
          const doId = env.WORKER_LOGS.idFromName(scriptName);
          const stub = env.WORKER_LOGS.get(doId);
          await stub.ingestLogs(scriptEvents);
        } catch (err) {
          console.error(`[user-logs-tail] failed to forward logs for ${scriptName}:`, err);
        }
      })
    );
  },
} satisfies ExportedHandler<Env>;
