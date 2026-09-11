import type { SseConnectionSink } from "./sse-connection";

/** Native socket delivery behind the same SDK connection used by polling. */
export function createWebSocketSink(socket: WebSocket): SseConnectionSink {
  let code = 1012;
  let reason = "retry";
  return {
    send(payload) {
      try { socket.send(payload); return true; } catch { return false; }
    },
    comment() { return socket.readyState === 1; },
    stalledFor() { return 0; }, // Native WebSocket lifecycle owns failure detection.
    bye(why) {
      reason = why;
      code = why === "forbidden" ? 1008 : why === "idle" ? 1000 : 1012;
    },
    close() {
      try { socket.close(code, reason); } catch { /* Already closed. */ }
    },
  };
}
