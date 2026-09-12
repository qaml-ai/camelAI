# Chat transport

New browser views use native WebSockets at `/agents/chat-thread/:threadId` for
both RPCs and resume/output frames. `SseAgentClient` and `useSseAgent` keep their
historical names to preserve the existing chat interface. No WebSocket startup
deadline or application silence watchdog is added.

A socket error or unexpected close immediately selects HTTP polling for that
view, without another socket attempt or waiting timer. Opening then immediately
closing is a failure, including a normal 1000 close without an intentional idle
reason. A 1008 policy denial stays terminal; explicit unmount/navigation does
not start a fallback. The existing server idle park remains intentional and
wakes on activity. A newly mounted view tries WebSocket again.

Polling uses the same authenticated route as legacy SSE:
`GET /agents/chat-thread/:id/sse?transport=poll&_pk=...&cursor=...`. Each response
is completed JSON containing protocol frames and a cursor. Visible tabs poll
every 250 ms during an active turn and every second while idle; hidden tabs
poll every five seconds. A successful RPC or resume POST expedites the next
scheduled poll without overlapping an in-flight request or bypassing receive-error
backoff. Intervals begin after the preceding response finishes. The next request acknowledges the
previous batch, so a lost HTTP response can be retried without dropping frames.
The server retains one connection across polls and runs the same wrapped SDK
connect/message/close and resume chains. Polling sends use `POST /call`.
The transport does not replay dispatched socket RPCs after an ambiguous close;
they fail promptly. The chat UI's existing send-message recovery may retry with
the same clientMessageId, which the server durably deduplicates and acknowledges.
Other RPCs are not automatically retried. Unsent calls remain queued until the
fallback is open.

Poll queues share the SSE 8 MiB per-connection and 24 MiB per-object limits.
Normal response batches are at most 512 KiB, with a larger single protocol frame
kept atomic. A 90-second lease, checked on the existing 25-second sweep, expires
abandoned polls while allowing minute-long background browser timer coalescing.
An eviction, idle park, overflow or isolate reset removes the session. A poll
gets 409 and reconnects with backoff plus the SDK resume handshake. Three failed
poll requests force a new session. HTTP polling requests have a 20-second
request deadline; this is not a WebSocket connection timer.

All receive requests share Worker authorization, reserved-header stripping and
user-scoped connection keys. Socket frames share the POST callable/resume
allow-list. Old SSE clients continue to work during a rollout. Workspace status
SSE and the log-tail WebSocket are separate and unchanged.

Operational events: `chat_ws_open`, `chat_poll_open` (client), and
`chat_poll_session_started` (server). Existing error event names remain for
continuity. Polling adds HTTP authorization traffic and updates can arrive less
smoothly than socket frames.

Tests: `tests/sse-agent-client.test.ts` covers native sends, immediate fallback
before/after open, no synthetic socket deadline, RPC ambiguity, lost responses,
policy denial and cleanup. `workers/main/tests/chat-sse-transport.test.ts` covers
real native RPC/resume, polling replay, authorization scope and frame filtering;
`chat-poll-connection.test.ts` covers queue acknowledgment, budgets and expiry.
`websocket-access.test.ts` verifies the main Worker upgrade/auth route.
These tests simulate network failure; Blair's actual network needs live validation.
