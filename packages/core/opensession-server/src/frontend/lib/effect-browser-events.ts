import * as BrowserStream from "@effect/platform-browser/BrowserStream";
import * as Stream from "effect/Stream";

export type BrowserSignal =
  | { readonly type: "visibilitychange" }
  | { readonly type: "focus" }
  | { readonly type: "blur" }
  | { readonly type: "online" }
  | { readonly type: "pageshow" };

const BUFFER_SIZE = 16;

export interface BrowserSignalStreams {
  readonly visibility: () => Stream.Stream<BrowserSignal>;
  readonly focus: () => Stream.Stream<BrowserSignal>;
  readonly blur: () => Stream.Stream<BrowserSignal>;
  readonly online: () => Stream.Stream<BrowserSignal>;
  readonly pageShow: () => Stream.Stream<BrowserSignal>;
}

/** Lazy factories keep browser globals untouched until a mounted scope runs. */
export const browserSignalStreams: BrowserSignalStreams = {
  visibility: () =>
    BrowserStream.fromEventListenerDocument("visibilitychange", {
      bufferSize: BUFFER_SIZE,
    }).pipe(Stream.map(() => ({ type: "visibilitychange" }) as const)),
  focus: () =>
    BrowserStream.fromEventListenerWindow("focus", {
      bufferSize: BUFFER_SIZE,
    }).pipe(Stream.map(() => ({ type: "focus" }) as const)),
  blur: () =>
    BrowserStream.fromEventListenerWindow("blur", {
      bufferSize: BUFFER_SIZE,
    }).pipe(Stream.map(() => ({ type: "blur" }) as const)),
  online: () =>
    BrowserStream.fromEventListenerWindow("online", {
      bufferSize: BUFFER_SIZE,
    }).pipe(Stream.map(() => ({ type: "online" }) as const)),
  pageShow: () =>
    BrowserStream.fromEventListenerWindow("pageshow", {
      bufferSize: BUFFER_SIZE,
    }).pipe(Stream.map(() => ({ type: "pageshow" }) as const)),
};
