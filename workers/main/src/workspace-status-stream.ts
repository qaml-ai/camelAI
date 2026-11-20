const HEARTBEAT_MS = 25 * 1000;
const STREAM_STALL_MS = 30 * 1000;
const encoder = new TextEncoder();

/** Keep the public SSE response alive without keeping WorkspaceDO awake. */
export async function bridgeWorkspaceStatusStream(
  stub: Pick<DurableObjectStub, 'fetch'>,
  signal: AbortSignal,
): Promise<Response> {
  const upstream = await stub.fetch('https://workspace/status/stream?transport=socket', {
    headers: { Upgrade: 'websocket' },
  });
  const socket = upstream.webSocket;
  // An active DO can keep the previous code during a deferred/gradual update.
  // That version ignores Upgrade and serves its existing SSE response. Return
  // it intact rather than failing or opening a second long-lived request.
  if (upstream.status === 200 && upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
    return upstream;
  }
  if (upstream.status !== 101 || !socket) {
    await upstream.body?.cancel();
    throw new Error('Workspace status WebSocket upgrade failed');
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let ended = false;
  let pending = 0;
  let pendingSince = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const finish = (error?: unknown) => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    signal.removeEventListener('abort', abort);
    void (error ? writer.abort(error) : writer.close()).catch(() => {});
    try { socket.close(1000, 'Status stream closed'); } catch {}
  };
  const abort = () => finish(signal.reason);
  const write = (frame: string) => {
    if (ended) return;
    pending += 1;
    if (pending === 1) pendingSince = Date.now();
    // The DO queues the snapshot before accepting subsequent status writes.
    // Writer ordering preserves that snapshot-before-incremental contract.
    void writer.write(encoder.encode(frame)).then(() => {
      pending -= 1;
      if (pending === 0) pendingSince = 0;
    }, finish);
  };

  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return finish(new Error('Invalid workspace status frame'));
    write(data);
  });
  socket.addEventListener('close', () => finish());
  socket.addEventListener('error', () => finish(new Error('Workspace status WebSocket failed')));
  void writer.closed.catch(finish);
  socket.accept();

  heartbeat = setInterval(() => {
    if (pending > 0 && Date.now() - pendingSince >= STREAM_STALL_MS) {
      finish(new Error('Workspace status subscriber stopped reading'));
    } else if (pending === 0) {
      // This never sends a message to the DO, so an idle sidebar can hibernate.
      write(':hb\n\n');
    }
  }, HEARTBEAT_MS);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
