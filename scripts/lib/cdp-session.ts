/**
 * One CDP page target on a private, resource-bounded browser.
 *
 * Every visual script needs the same preamble before it can do anything: lease
 * a browser, open a target, connect to its debugger socket, and wrap the
 * id-keyed request/response protocol in a promise. Copying that preamble is
 * what made people copy the whole of capture-ui.ts into /tmp, so it lives here
 * where a throwaway script can import it.
 */
import {
  acquireCdpBrowser,
  closeCdpTarget,
  releaseCdpBrowser,
} from "./cdp-browser";

export type CdpSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<any>;

export type CdpSession = {
  port: number;
  targetId?: string;
  send: CdpSend;
  /** Evaluate source in the page, awaiting a promise it returns. */
  evaluate: (source: string) => Promise<any>;
  close: () => Promise<void>;
};

export async function openCdpSession(
  url = "about:blank",
): Promise<CdpSession> {
  const lease = await acquireCdpBrowser();
  let target: { id?: string; webSocketDebuggerUrl?: string } | undefined;
  let socket: WebSocket | undefined;

  try {
    target = await fetch(
      `http://127.0.0.1:${lease.port}/json/new?url=${encodeURIComponent(url)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    const debuggerUrl = target?.webSocketDebuggerUrl;
    if (!debuggerUrl) throw new Error("CDP target has no debugger URL");
    socket = new WebSocket(debuggerUrl);
    await new Promise<void>((resolveOpen, reject) => {
      socket!.onopen = () => resolveOpen();
      socket!.onerror = () => reject(new Error("CDP connection failed"));
    });

    let commandId = 0;
    const pending = new Map<
      number,
      { method: string; resolve: (result: any) => void; reject: (error: Error) => void }
    >();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      // A dropped error reads as a command that silently did nothing, which is
      // then blamed on whatever asserts the page state next.
      if (message.error)
        entry.reject(
          new Error(
            `${entry.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`,
          ),
        );
      else entry.resolve(message.result);
    };
    socket.onclose = () => {
      for (const entry of pending.values())
        entry.reject(new Error(`${entry.method} failed: CDP socket closed`));
      pending.clear();
    };

    const send: CdpSend = (method, params = {}) =>
      new Promise<any>((resolveResult, reject) => {
        const id = ++commandId;
        pending.set(id, { method, resolve: resolveResult, reject });
        socket!.send(JSON.stringify({ id, method, params }));
      });

    const evaluate = async (source: string) => {
      const result = await send("Runtime.evaluate", {
        expression: source,
        awaitPromise: true,
        returnByValue: true,
      });
      const details = result?.exceptionDetails;
      if (details)
        throw new Error(
          details.exception?.description ?? details.text ?? "page evaluation failed",
        );
      return result?.result?.value;
    };

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      socket?.close();
      await closeCdpTarget(lease.port, target?.id);
      await releaseCdpBrowser(lease);
    };

    return { port: lease.port, targetId: target?.id, send, evaluate, close };
  } catch (error) {
    socket?.close();
    await closeCdpTarget(lease.port, target?.id);
    await releaseCdpBrowser(lease);
    throw error;
  }
}
