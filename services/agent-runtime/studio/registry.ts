import type { CallRecord, ClientEvent, RequestRecord } from '../shared/client-protocol.ts';
import type { AgentView, Run, Trace } from './types.ts';
export interface RegistrySnapshot {
  id: string; name: string; type: string; connected: boolean; systemPrompt: string;
  tools: { name: string; description: string; parameters: unknown }[];
  cursor: number; events: { id: number; at?: number; data: ClientEvent }[];
  requests: RequestRecord[]; calls: CallRecord[];
}
/** Fold the passive runtime journal; never connect a second tool receiver. */
export function snapshotAgent(snapshot: RegistrySnapshot, previous: Run[]): AgentView {
  const runs = new Map(previous.map(r => [r.id, structuredClone(r)]));
  for (const run of runs.values()) if (run.status === 'running' && !snapshot.requests.some(r => r.id === run.id)) {
    run.status = 'interrupted'; run.ended ??= Date.now(); run.error = 'This legacy run was interrupted. Inspect effects before continuing.';
  }
  for (const request of snapshot.requests) {
    if (!request.startedAt || !['prompt', 'execute'].includes(request.method)) continue;
    const run: Run = runs.get(request.id) ?? { id: request.id, prompt: request.prompt ?? 'Code execution', mode: request.method === 'prompt' ? 'live' : 'scripted', started: request.startedAt, status: 'running', answer: '', traces: [], tokens: 0, cost: 0, cursor: 0 };
    if (request.code && !run.traces.some(t => t.kind === 'code')) run.traces.push({ at: run.started, kind: 'code', name: 'js_exec', code: request.code });
    const first = snapshot.events[0]?.id ?? 0;
    if (first > (run.cursor ?? 0) + 1 && !run.traces.some(t => t.kind === 'gap')) run.traces.push({ at: run.started, kind: 'gap', error: 'Some earlier events are no longer in the runtime replay window.' });
    for (const entry of snapshot.events) {
      if (entry.id <= (run.cursor ?? 0) || entry.data.type !== 'event' || entry.data.requestId !== request.id) continue;
      const ev = entry.data.event, at = entry.at ?? run.started;
      const add = (trace: Omit<Trace, 'at'>) => { if (run.traces.length < 300) run.traces.push({ at, ...trace }); };
      if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') run.answer += ev.assistantMessageEvent.delta;
      if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
        const text = ev.message.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
        if (text) run.answer = text;
        const usage = ev.message.usage;
        if (usage) { run.tokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0); run.cost += usage.cost?.total ?? 0; }
      }
      if (ev.type === 'tool_execution_start') add({ kind: 'code', name: ev.toolName, code: ev.args?.code, args: ev.args });
      if (ev.type === 'tool_execution_end') add({ kind: 'execution', name: ev.toolName, result: ev.result, ...(ev.isError ? { error: 'Execution returned an error' } : {}) });
      if (ev.type === 'codemode') add({ kind: 'sandbox', event: ev.event });
    }
    run.cursor = snapshot.cursor;
    for (const call of snapshot.calls.filter(c => c.requestId === request.id)) {
      const trace: Trace = { at: call.createdAt ?? run.started, kind: 'tool', callId: call.id, name: call.name, args: call.args, result: call.outcome?.result, error: call.outcome?.error };
      const index = run.traces.findIndex(t => t.callId === call.id);
      if (index >= 0) run.traces[index] = trace; else if (run.traces.length < 300) run.traces.push(trace);
    }
    run.traces.sort((a, b) => a.at - b.at);
    if (request.state !== 'running') {
      const outcome = request.outcome;
      const result = outcome?.result as any;
      run.error = outcome?.error ?? result?.error;
      if (run.status !== 'cancelled') run.status = request.state === 'uncertain' ? 'interrupted' : run.error ? 'failed' : 'completed';
      run.ended = request.endedAt ?? run.ended ?? Date.now();
      if (!run.answer && request.method === 'execute') run.answer = JSON.stringify(result ?? outcome ?? {}, null, 2);
    }
    runs.set(run.id, run);
  }
  for (const run of runs.values()) run.traces = run.traces.map(trace => JSON.stringify(trace).length <= 100000 ? trace : { at: trace.at, kind: trace.kind, name: trace.name, callId: trace.callId, result: 'Trace payload omitted: exceeds the local display limit.' });
  const history = [...runs.values()].sort((a, b) => a.started - b.started).slice(-50);
  return { id: snapshot.id, name: snapshot.name, type: snapshot.type, connected: snapshot.connected,
    description: 'One agent. One persistent conversation.', suggestions: ['What can you help me with?'],
    tools: snapshot.tools.map(t => t.name), toolDefinitions: snapshot.tools, systemPrompt: snapshot.systemPrompt,
    runs: history, busy: history.some(r => r.status === 'running'), scripted: false };
}
