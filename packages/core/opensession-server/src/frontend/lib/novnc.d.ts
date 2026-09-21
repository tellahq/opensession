/** The slice of noVNC's RFB client the Desktop tab uses. noVNC ships no
 * types; see node_modules/@novnc/novnc/docs/API.md for the full surface. The
 * package exports only its RFB entry (core/rfb.js) under the bare name. */
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }
  export interface RfbOptions {
    shared?: boolean;
    credentials?: RfbCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }
  /** Event payloads as documented in docs/API.md of the package. */
  export interface RfbEventMap {
    connect: CustomEvent<undefined>;
    disconnect: CustomEvent<{ clean: boolean }>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
    securityfailure: CustomEvent<{ status: number; reason: string }>;
    desktopname: CustomEvent<{ name: string }>;
    clipboard: CustomEvent<{ text: string }>;
    bell: CustomEvent<undefined>;
    capabilities: CustomEvent<{ capabilities: { power: boolean } }>;
    clippingviewport: CustomEvent<boolean>;
  }
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: RfbOptions,
    );
    addEventListener<K extends keyof RfbEventMap>(
      type: K,
      listener: (event: RfbEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void;
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    readonly capabilities: { power: boolean };
    disconnect(): void;
    sendCredentials(credentials: RfbCredentials): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
  }
}
