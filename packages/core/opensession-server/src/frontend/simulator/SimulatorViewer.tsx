import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  viewerMessageSchema,
  viewerInputSchema,
  type ViewerInput,
  type ViewerState,
} from "../../simulator-portal/protocol";
import { simulatorGesture, simulatorPointer } from "../lib/simulator-viewer";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export function SimulatorViewer() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const gesture = useRef<{ x: number; y: number; time: number } | null>(null);
  const [state, setState] = useState<ViewerState>({ phase: "starting" });
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let disposed = false;
    let ws: WebSocket | undefined;
    let decoding = false;
    async function connect() {
      const response = await fetch("/api/bootstrap", { signal: abort.signal });
      if (!response.ok)
        throw new Error("Could not connect to the simulator Portal");
      const bootstrap = z
        .object({ token: z.string() })
        .parse(await response.json());
      if (disposed) return;
      const url = new URL("/socket", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", bootstrap.token);
      ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setError("");
      };
      ws.onclose = () => {
        if (!disposed) {
          setConnected(false);
          setHasFrame(false);
          setError("Viewer disconnected. Reconnect to continue.");
        }
      };
      ws.onerror = () => {
        if (!disposed) setError("Could not connect to the simulator Portal");
      };
      ws.onmessage = async (event: MessageEvent<unknown>) => {
        if (event.data instanceof Blob) {
          // Never queue frame decoding behind a slow or backgrounded browser.
          if (decoding || !canvas.current) return;
          decoding = true;
          try {
            const image = await createImageBitmap(event.data);
            const target = canvas.current;
            if (!disposed && target) {
              if (target.width !== image.width) target.width = image.width;
              if (target.height !== image.height) target.height = image.height;
              target.getContext("2d")?.drawImage(image, 0, 0);
              setHasFrame(true);
            }
            image.close();
          } catch {
            if (!disposed) setError("Could not decode the simulator screen");
          }
          decoding = false;
          return;
        }
        const textMessage = z.string().safeParse(event.data);
        if (!textMessage.success) return;
        try {
          const message = viewerMessageSchema.parse(
            JSON.parse(textMessage.data),
          );
          if (message.type === "state") setState(message.state);
          else setError(message.message);
        } catch {
          setError("The simulator sent an invalid response");
        }
      };
    }
    void connect().catch((cause) => {
      if (!disposed)
        setError(
          cause instanceof Error ? cause.message : "Viewer connection failed",
        );
    });
    return () => {
      disposed = true;
      abort.abort();
      ws?.close();
      socket.current = null;
    };
  }, [attempt]);

  const ready = state.phase === "ready" && connected && hasFrame;
  function send(input: ViewerInput) {
    if (!ready || socket.current?.readyState !== WebSocket.OPEN) return;
    setError("");
    socket.current.send(JSON.stringify(input));
  }
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    if (state.phase !== "ready") return null;
    return simulatorPointer({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: event.currentTarget.getBoundingClientRect(),
      width: state.width,
      height: state.height,
    });
  }

  return (
    <main className="flex h-dvh min-h-0 flex-col gap-2 bg-panel p-3 text-fg [box-sizing:border-box]">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="m-0 truncate text-sm font-medium">
            {state.phase === "ready" ? state.deviceName : "iOS simulator"}
          </h1>
          <p className="m-0 text-xs text-dim">
            {ready ? "Live simulator" : "Simulator Portal"}
          </p>
        </div>
        <Button
          className="min-h-11 shrink-0"
          variant="ghost"
          disabled={!ready}
          onClick={() => send({ type: "home" })}
        >
          Home
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-surface">
        <canvas
          ref={canvas}
          role="application"
          aria-label="Simulator screen. Click or swipe to interact. Type when focused."
          tabIndex={ready ? 0 : -1}
          className="block h-full w-full touch-none object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          onPointerDown={(event) => {
            if (!ready || event.button !== 0 || !event.isPrimary) return;
            const start = point(event);
            if (!start) return;
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = { ...start, time: performance.now() };
          }}
          onPointerUp={(event) => {
            const start = gesture.current;
            gesture.current = null;
            const end = point(event);
            if (start && end)
              send(simulatorGesture(start, end, performance.now()));
          }}
          onPointerCancel={() => {
            gesture.current = null;
          }}
          onKeyDown={(event) => {
            if (
              !ready ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.key === "Tab"
            )
              return;
            const special = viewerInputSchema.safeParse({
              type: "key",
              key: event.key,
            });
            if (special.success) {
              event.preventDefault();
              send(special.data);
            } else if (event.key.length === 1) {
              event.preventDefault();
              send({ type: "text", text: event.key });
            }
          }}
        />
        {!ready ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface p-4 text-center text-sm text-dim"
            role="status"
          >
            {state.phase === "error" ? (
              <p className="m-0">{state.message}</p>
            ) : (
              <>
                <Spinner />
                <p className="m-0">
                  {state.phase === "starting"
                    ? "Starting simulator…"
                    : connected
                      ? "Waiting for the screen…"
                      : "Viewer disconnected"}
                </p>
              </>
            )}
            {state.phase === "error" ? (
              <p className="m-0 text-xs">
                Fix the setup, then restart this Portal.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="shrink-0 text-sm text-dim">
          {error}
        </div>
      ) : null}
      {!connected && error ? (
        <Button
          className="min-h-11 shrink-0"
          onClick={() => {
            setError("");
            setAttempt((value) => value + 1);
          }}
        >
          Reconnect
        </Button>
      ) : null}
      <form
        className="flex shrink-0 items-center gap-2 pb-[env(safe-area-inset-bottom)]"
        onSubmit={(event) => {
          event.preventDefault();
          if (text) {
            send({ type: "text", text });
            setText("");
          }
        }}
      >
        <Input
          className="min-h-11 min-w-0 flex-1 text-base"
          aria-label="Text to type in the simulator"
          placeholder="Type in simulator"
          disabled={!ready}
          maxLength={1_000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button className="min-h-11" type="submit" disabled={!ready || !text}>
          Send
        </Button>
      </form>
    </main>
  );
}
