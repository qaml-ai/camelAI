import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, Bot, Check, ChevronRight, Circle, Clipboard, Code2, ExternalLink, FlaskConical, Layers3, Mic, Radio, Square, Terminal, ThumbsDown, ThumbsUp, Volume2, VolumeX, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import type { AgentView, Run, Trace } from '../types';
import './style.css';

async function api(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const duration = (run: Run) => `${(((run.ended ?? Date.now()) - run.started) / 1000).toFixed(1)}s`;
function App() {
  const path = location.pathname.split('/');
  const inspect = path[1] === 'studio';
  const id = (inspect ? path[3] : path[2])!;
  const runsUrl = `/studio/agents/${id}/runs`;
  const selected = inspect && path[4] === 'runs' ? path[5] : undefined;
  const [config, setConfig] = useState<any>();
  const [agent, setAgent] = useState<AgentView>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const tab = inspect ? (path[4] === 'runs' ? 'traces' : path[4] === 'configuration' ? 'application' : 'chat') : 'chat';
  function setTab(value: string) { location.assign(`/studio/agents/${id}/${value === 'application' ? 'configuration' : value === 'traces' ? 'runs' : 'chat'}`); }
  const [submitting, setSubmitting] = useState(false);
  const [online, setOnline] = useState(false);
  const [copied, setCopied] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recognition = useRef<any>(null);
  const spoken = useRef(new Set<string>());
  const bottom = useRef<HTMLDivElement>(null);
  const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const owner = inspect && config?.owner;
  const active = selected ? agent?.runs.find(r => r.id === selected) : agent?.runs.at(-1);
  const busy = agent?.busy || submitting;
  async function refresh() {
    if (!inspect) {
      const shared = await api(`/api/agents/${id}`);
      setAgent(shared); setConfig({ live: shared.chatEnabled });
      return;
    }
    const next = await api('/api/agents'); setConfig(next);
    if (id) setAgent(await api(`/api/inspect/${id}`));
  }
  useEffect(() => {
    let disposed = false; let stream: EventSource | undefined;
    (async () => {
      const token = new URLSearchParams(location.hash.slice(1)).get('token');
      if (inspect && token) { history.replaceState(null, '', location.pathname); await api('/api/unlock', { token }); }
      if (disposed) return;
      await refresh();
      stream = new EventSource('/api/events');
      stream.onopen = () => setOnline(true);
      stream.onerror = () => setOnline(false);
      stream.onmessage = () => { refresh().catch(e => setError(e.message)); };
    })().catch(e => setError(e.message));
    return () => { disposed = true; stream?.close(); recognition.current?.abort(); window.speechSynthesis?.cancel(); };
  }, []);
  useEffect(() => { document.title = inspect ? `${agent?.name ?? 'Agents'} · Studio` : agent?.name ?? 'Chat'; }, [agent?.name, inspect]);
  const latest = agent?.runs.at(-1);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [latest?.answer, agent?.runs.length, tab]);
  useEffect(() => {
    if (!latest || latest.status !== 'completed' || !latest.answer || spoken.current.has(latest.id)) return;
    spoken.current.add(latest.id);
    if (speak && window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance(latest.answer.replace(/[*#`]/g, '').slice(0, 5000));
      utterance.onstart = () => setSpeaking(true); utterance.onend = utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    }
  }, [latest?.status, latest?.id, speak]);
  async function send(text = draft, mode = 'live') {
    if (!text.trim() || busy) return;
    setError(''); setSubmitting(true); window.speechSynthesis?.cancel(); setSpeaking(false);
    try { await api(`/api/agents/${id}/run`, { prompt: text, mode }); setDraft(''); await refresh(); }
    catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  }
  async function stop() {
    recognition.current?.abort(); window.speechSynthesis?.cancel(); setSpeaking(false);
    try { await api(`/api/agents/${id}/abort`, {}); await refresh(); } catch (e: any) { setError(e.message); }
  }
  function microphone() {
    if (listening) { recognition.current?.stop(); return; }
    if (!Recognition) { setError('Speech input is unavailable in this browser. Open this URL in Chrome or use text.'); return; }
    window.speechSynthesis?.cancel(); setSpeaking(false); setSpeak(true); setError('');
    const r = new Recognition(); recognition.current = r; r.lang = 'en-US'; r.interimResults = true;
    r.onstart = () => setListening(true);
    r.onend = () => setListening(false);
    r.onerror = (e: any) => { setListening(false); setError(`Microphone: ${e.error}. You can always type your message.`); };
    r.onresult = (e: any) => {
      let text = ''; for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setDraft(text);
      // Keep the transcript editable; Send is the explicit action in both text and voice modes.
    };
    try { r.start(); } catch (e: any) { setError(e.message); }
  }
  async function copy() { try { await navigator.clipboard.writeText(`${location.origin}/a/${id}`); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError('Could not copy the link. Copy the URL from your address bar.'); } }
  return <div className={`shell ${inspect ? 'studio-shell' : 'shared-shell'}`}>
    {inspect && <aside className="sidebar">
      <a className="brand" href="/studio/agents"><span className="brand-icon"><Layers3 size={21}/></span>camelAI<span className="brand-sub">studio</span></a>
      <div className="workspace-label">LOCAL WORKSPACE <Badge variant="outline">DEV</Badge></div>
      <div className="nav-label">YOUR AGENTS <span>{config?.agents.length ?? 0}</span></div>
      <nav>{Array.from(new Set<string>((config?.agents ?? []).map((a: any) => a.type))).sort().map(type => <div key={type}><div className="nav-label">{type}</div>{config.agents.filter((a: any) => a.type === type).map((a: any) => <Button key={a.id} asChild variant="ghost" className={`agent-link ${a.id === id ? 'selected' : ''}`}><a href={`/studio/agents/${a.id}/chat`}><span className="agent-avatar"><Bot size={18}/></span><span><strong>{a.name}</strong><small>{a.connected ? 'Tools connected' : 'Tools offline'}</small></span><span className={`dot ${a.connected ? '' : 'offline'}`}/></a></Button>)}</div>)}</nav>
      <div className="side-note"><Code2 size={17}/><strong>Your functions. Your stack.</strong><p>Agents appear here when your application registers them through the SDK.</p></div>
      <div className="sidebar-bottom"><span className={`dot ${online ? '' : 'offline'}`}/>{online ? 'Local runtime connected' : 'Reconnecting…'}<small>QuickJS / WebAssembly</small></div>
    </aside>}
    <main className="main">
      {inspect && <header className="topbar"><span>Workspace <ChevronRight size={14}/> Agents <ChevronRight size={14}/> <strong>{id ? agent?.name ?? 'Loading…' : 'All agents'}</strong></span><Badge variant="outline">LOCAL PREVIEW</Badge></header>}
      {inspect && !config && error && <div className="notice" role="alert">{error}</div>}
      {!id ? <section className="catalog"><h1>Your agents</h1><p>Organized by type. Each agent has its own name, conversation, and URL.</p>{config && !config.agents.length && <div className="notice">Create an agent with the TypeScript or Python SDK to see it here. Set <code>name</code> and <code>type</code> when creating it.</div>}{Array.from(new Set<string>((config?.agents ?? []).map((a: any) => a.type))).sort().map(type => <section key={type}><h2>{type}</h2><div className="agent-cards">{config.agents.filter((a: any) => a.type === type).map((a: any) => <a key={a.id} className="agent-card-link" href={`/studio/agents/${a.id}/chat`} aria-label={`Open ${a.name}`}><Card><CardContent><Bot/><h3>{a.name}</h3><p><span className={`dot ${a.connected ? '' : 'offline'}`}/>{a.connected ? 'Tools connected' : 'Tools offline'}</p><span className="card-action">Open agent <ChevronRight size={15}/></span></CardContent></Card></a>)}</div></section>)}</section> : <>
      <section className="agent-heading"><div className="hero-avatar"><Bot/></div><div><div className="title-row"><h1>{agent?.name ?? 'Your agent'}</h1>{inspect && <Badge variant="secondary">{agent?.type}</Badge>}</div><p>{inspect ? agent?.description : 'Chat with your assistant'}</p></div>{inspect ? <div className="heading-actions"><Button variant="outline" onClick={copy}>{copied ? <Check/> : <Clipboard/>}{copied ? 'Link copied' : 'Share chat'}</Button></div> : <span className="shared-status"><span className={`dot ${online && agent?.connected ? '' : 'offline'}`}/>{online && agent?.connected ? 'Connected' : online ? 'Unavailable' : 'Connecting…'}</span>}</section>
      {error && <div className="error" role="alert">{error}<Button variant="ghost" size="icon" aria-label="Dismiss error" onClick={() => setError('')}><X/></Button></div>}
      {inspect && config && !config.owner && <div className="notice">Developer access is locked. Open the developer URL printed by <code>bun run agent:studio</code>. Chat remains available.</div>}
      <Tabs value={tab} onValueChange={setTab} className="workspace-tabs">
        {inspect && <div className="tabbar"><TabsList aria-label="Agent navigation"><TabsTrigger value="chat"><Bot size={14}/> Chat</TabsTrigger>{owner && <TabsTrigger value="traces"><Activity size={14}/> Runs <span className="count">{agent?.runs.length ?? 0}</span></TabsTrigger>}{owner && <TabsTrigger value="application"><Layers3 size={14}/> Configuration</TabsTrigger>}</TabsList><span className="model-label"><span className={`dot ${config?.live ? '' : 'offline'}`}/>{config?.live ? 'Live model' : 'No model configured'}<span title={config?.model}>{config?.model?.split('/').at(-1)}</span></span></div>}

        <TabsContent value="chat" className="chat-layout">
          <section className="conversation">
            <div className="messages">
              {!agent?.runs.length && <div className="welcome"><span className="welcome-icon"><Bot size={28}/></span><h2>{agent?.name ?? "Your agent"}</h2><p>{config?.live ? 'Ask a question. Your agent will use your application’s tools to find an answer and take action.' : !inspect ? 'Chat is currently unavailable. Please try again later.' : agent?.scripted ? 'Try the scripted example to watch sandboxed code call your application’s functions. Add a model key for chat.' : 'Configure a model key to start chatting. Your application can also run code through the SDK.'}</p><div className="suggestions">{agent?.suggestions.map(s => <Button key={s} variant="outline" disabled={busy || !config?.live} onClick={() => setDraft(s)}>{s}<ArrowUpRight size={14}/></Button>)}</div></div>}
              {agent?.runs.map(run => <div key={run.id} className="turn"><div className="user-message">{run.prompt}{inspect && run.mode === 'scripted' && <small>Scripted example · no model inference</small>}</div><div className="assistant-message"><span className="message-avatar"><Bot size={17}/></span><div><div className="message-label">{agent.name}<span>{run.status === 'running' ? 'Working…' : duration(run)}</span></div>{run.answer ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.answer}</ReactMarkdown></div> : run.status === 'running' ? <div className="thinking"><span/><span/><span/> Checking your application</div> : <p>{run.status === 'failed' ? (inspect ? 'This run failed. Check Runs for details.' : 'Something went wrong. Please try again.') : 'Run stopped.'}</p>}{run.status === 'running' && run.answer && <span className="stream-cursor"/>}{owner && <Button asChild variant="ghost" className="trace-link"><a href={`${runsUrl}/${run.id}`}><Activity size={13}/>View run · {run.status}<ChevronRight size={13}/></a></Button>}</div></div></div>)}
              <div ref={bottom}/>
            </div>
            <div className="composer-area">{listening && <div className="voice-status"><Radio size={15}/> Listening… speak, then review and send.</div>}{speaking && <div className="voice-status"><Volume2 size={15}/> Speaking<Button variant="ghost" onClick={() => { window.speechSynthesis.cancel(); setSpeaking(false); }}>Stop audio</Button></div>}<form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}><Textarea aria-label="Message your agent" value={draft} onChange={e => setDraft(e.target.value)} placeholder={config?.live ? `Ask ${agent?.name ?? 'your agent'} anything…` : inspect ? 'Configure a model key to chat freely' : 'Chat is currently unavailable'} disabled={busy || !config?.live} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-controls"><div><Button type="button" variant={listening ? 'default' : 'ghost'} size="icon" aria-label={listening ? 'Stop listening' : 'Dictate message'} title={Recognition ? 'Dictate, then review and send' : 'Speech recognition unavailable in this browser'} disabled={!Recognition || busy || !config?.live} onClick={microphone}><Mic size={17}/></Button><Button type="button" variant={speak ? 'secondary' : 'ghost'} size="icon" aria-label={speak ? 'Disable spoken replies' : 'Enable spoken replies'} onClick={() => { setSpeak(!speak); if (speak) { window.speechSynthesis?.cancel(); setSpeaking(false); } }}>{speak ? <Volume2/> : <VolumeX/>}</Button><span className="composer-hint">{listening ? 'Microphone on' : 'Enter to send'}</span></div>{busy ? <Button type="button" variant="outline" onClick={stop}><Square size={12}/> Stop</Button> : <Button type="submit" disabled={!draft.trim() || !config?.live || !agent?.connected}><ArrowUp size={17}/> Send</Button>}</div></form>{inspect && <div className="composer-footer"><Button variant="ghost" hidden={!agent?.scripted} disabled={busy || !agent?.connected} onClick={() => send('Run the scripted example', 'scripted')}><FlaskConical size={13}/> Try scripted example</Button><span>Your application controls the available tools.</span></div>}<small className="voice-note">Voice uses your browser’s speech service, which may process audio remotely. Review the transcript before sending.</small></div>
          </section>
        </TabsContent>
        {owner && <TabsContent value="application" className="state-tab"><ApplicationState agent={agent}/></TabsContent>}
        {owner && <TabsContent value="traces" className="trace-layout"><div className="run-list"><div className="panel-title">RUN HISTORY <Badge variant="outline">{agent?.runs.length ?? 0}</Badge></div>{!agent?.runs.length && <p className="empty">Start a conversation to see what happens behind the answer.</p>}{agent?.runs.slice().reverse().map(run => <Button variant="ghost" key={run.id} className={`run-button ${active?.id === run.id ? 'active' : ''}`} onClick={() => location.assign(`${runsUrl}/${run.id}`)}><span className={`status-icon ${run.status}`}><Activity size={15}/></span><span><strong>{run.prompt}</strong><small>{new Date(run.started).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {duration(run)} · {run.status}</small></span>{run.review?.verdict === 'good' && <Check size={14}/>}</Button>)}</div><div className="run-detail">{active ? <RunDetail key={active.id} run={active} agentId={id} onReview={refresh} onError={setError}/> : <div className="welcome"><Activity size={32}/><h2>{selected ? "Run not found" : "Every action, in view."}</h2><p>{selected ? "This run is unavailable for this agent or has aged out of the local history." : "Inspect generated code, tool arguments, results and errors. Add a review to keep track of what worked."}</p>{selected && <Button asChild variant="outline"><a href={runsUrl}>Back to run history</a></Button>}</div>}</div></TabsContent>}
      </Tabs></> }
    </main>
  </div>;
}
function ApplicationState({ agent }: { agent?: AgentView }) {
  return <aside className="app-panel"><div className="panel-title"><span>AGENT CONFIGURATION</span></div><h3>Type</h3><p>{agent?.type}</p><h3>Name</h3><p>{agent?.name}</p><h3>Application system prompt</h3><div className="saved-note">{agent?.systemPrompt || 'No custom system prompt.'}</div><p className="muted">The runtime adds sandbox and tool instructions automatically.</p><div className="tools-list"><h3>Available tools</h3>{agent?.toolDefinitions?.map(t => <div key={t.name}><code><Terminal size={12}/>{t.name}</code><p>{t.description}</p><details><summary>Input schema</summary><pre>{pretty(t.parameters)}</pre></details></div>)}</div></aside>;
}
function RunDetail({ run, agentId, onReview, onError }: { run: Run; agentId: string; onReview(): Promise<void>; onError(e: string): void }) {
  const [note, setNote] = useState(run.review?.note ?? '');
  const [filter, setFilter] = useState('');
  const [expanded, expand] = useState<number | null>(null);
  const calls = run.traces.filter(t => t.kind === 'tool');
  async function review(verdict: string) { try { await api(`/api/inspect/${agentId}/review`, { id: run.id, verdict, note }); await onReview(); } catch (e: any) { onError(e.message); } }
  return <><div className="run-heading"><Button asChild variant="link" className="run-permalink"><a href={`/studio/agents/${agentId}/runs/${run.id}`}>Link to this run <ExternalLink size={12}/></a></Button><Badge variant="outline">{run.mode === 'live' ? 'MODEL RUN' : 'CODE EXECUTION'}</Badge><Badge variant={run.status === 'failed' ? 'destructive' : 'secondary'}>{run.status}</Badge><h2>{run.prompt}</h2><code>{run.id.slice(0, 8)}</code></div><div className="metrics"><div><small>DURATION</small><strong>{duration(run)}</strong></div><div><small>APP TOOL CALLS</small><strong>{calls.length}</strong></div><div><small>TOKENS</small><strong>{run.tokens.toLocaleString()}</strong></div><div><small>MODEL COST EST.</small><strong>${run.cost.toFixed(4)}</strong></div></div>{run.error && <div className="error">{run.error}</div>}<div className="timeline-heading"><h3>Execution trace</h3><Input aria-label="Filter trace" placeholder="Filter tools, code, errors…" value={filter} onChange={e => setFilter(e.target.value)}/></div><div className="timeline">{run.traces.map((t, i) => ({ t, i })).filter(({ t }) => pretty(t).toLowerCase().includes(filter.toLowerCase())).map(({ t, i }) => <TraceRow key={i} trace={t} start={run.started} open={expanded === i} toggle={() => expand(expanded === i ? null : i)}/>)}{!run.traces.length && <p className="empty">{run.status === 'running' ? 'Waiting for the first action…' : 'The agent answered without calling tools.'}</p>}</div><div className="review"><h3>Review this run</h3><p>Capture what worked, or what should improve next time.</p><Textarea aria-label="Review note" placeholder="What would make this response better?" value={note} onChange={e => setNote(e.target.value)}/><div><Button variant={run.review?.verdict === 'good' ? 'default' : 'outline'} onClick={() => review('good')}><ThumbsUp/> Looks good</Button><Button variant={run.review?.verdict === 'needs-work' ? 'default' : 'outline'} onClick={() => review('needs-work')}><ThumbsDown/> Needs work</Button>{run.review && <span className="muted">Review saved locally</span>}<Button variant="ghost" asChild><a download={`run-${run.id}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(pretty(run))}`}><ArrowDown/> Export JSON</a></Button></div></div></>;
}
function TraceRow({ trace: t, start, open, toggle }: { trace: Trace; start: number; open: boolean; toggle(): void }) {
  return <div className={`trace-row ${open ? 'expanded' : ''}`}><Button variant="ghost" className="trace-toggle" onClick={toggle} aria-expanded={open}><span className={`trace-icon ${t.error ? 'bad' : ''}`}>{t.kind === 'code' ? <Code2 size={16}/> : t.kind === 'tool' ? <Terminal size={16}/> : <Circle size={13}/>}</span><span><strong>{t.name ?? (t.kind === 'sandbox' ? 'Sandbox output' : 'Execution result')}</strong><small>{t.error ?? (t.kind === 'code' ? 'Generated JavaScript · QuickJS/WASM' : t.kind === 'tool' ? 'Executed in your application' : t.kind)}</small></span><code>+{((t.at - start) / 1000).toFixed(2)}s</code><ChevronRight size={15} className={open ? 'rotate' : ''}/></Button>{open && <div className="trace-body">{t.code && <><label>CODE</label><pre>{t.code}</pre></>}{t.args && !t.code ? <><label>ARGUMENTS</label><pre>{pretty(t.args)}</pre></> : null}{t.result !== undefined && <><label>RESULT</label><pre>{pretty(t.result)}</pre></>}{t.error && <pre className="bad">{t.error}</pre>}{t.event !== undefined && <pre>{pretty(t.event)}</pre>}</div>}</div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
