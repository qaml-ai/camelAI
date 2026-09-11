export class FakeChatSocket {
  static instances: FakeChatSocket[] = [];
  static autoOpen = false;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeChatSocket.instances.push(this);
    if (FakeChatSocket.autoOpen) queueMicrotask(() => this.open());
  }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('Socket closed');
    this.sent.push(data);
  }
  frame(frame: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  fail() { this.onerror?.(new Event('error')); }
  peerClose(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
  close() { this.readyState = 3; }
}
