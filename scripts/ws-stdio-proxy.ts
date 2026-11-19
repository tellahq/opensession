#!/usr/bin/env bun
/**
 * stdio ⇄ WebSocket bridge, used as an `ssh -o ProxyCommand` when a
 * sandbox's sshd is reachable only through a provider's WebSocket proxy
 * (use.computer). Bytes from stdin become binary frames; frames become
 * stdout. The URL is the one argument; the Authorization header value, if
 * the endpoint needs one, arrives in OPENSESSION_WS_AUTHORIZATION so it is
 * never in argv.
 */

const url = process.argv[2];
if (!url) {
  process.stderr.write("usage: ws-stdio-proxy.ts <ws-url>\n");
  process.exit(2);
}
const authorization = process.env.OPENSESSION_WS_AUTHORIZATION;
const socket = new WebSocket(url, {
  headers: authorization ? { Authorization: authorization } : {},
} as unknown as string[]);
socket.binaryType = "arraybuffer";

const pending: Uint8Array<ArrayBuffer>[] = [];
let connected = false;
socket.onopen = () => {
  connected = true;
  for (const chunk of pending) socket.send(chunk);
  pending.length = 0;
};
socket.onmessage = (event) => {
  const data = event.data;
  process.stdout.write(
    typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer),
  );
};
socket.onclose = () => process.exit(0);
socket.onerror = (event) => {
  const message = (event as { message?: string }).message || "socket error";
  process.stderr.write(`ws-stdio-proxy: ${message}\n`);
  process.exit(1);
};
process.stdin.on("data", (chunk: Buffer) => {
  const bytes = new Uint8Array(chunk);
  if (connected) socket.send(bytes);
  else pending.push(bytes);
});
process.stdin.on("end", () => {
  try {
    socket.close();
  } catch {}
});

export {};
