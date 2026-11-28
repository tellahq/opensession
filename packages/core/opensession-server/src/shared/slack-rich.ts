/**
 * What a Slack app or bot message carries beyond its text, in the shape the
 * Channels place renders: Block Kit blocks and message attachments (legacy
 * app cards, link unfurls, shared messages). Text fields hold Slack markup
 * already rendered to the web's tokens (agents/slack/message-view.ts), and
 * every URL is http(s).
 */

export interface RichImage {
  url: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface RichButton {
  text: string;
  /** Opens a page. A button without one talks to its app, which only
   *  Slack's own client can do, so it shows disabled. */
  url?: string;
  primary?: boolean;
}

export type RichContextItem =
  | { kind: "text"; text: string }
  | { kind: "image"; image: RichImage };

export type RichBlock =
  | { type: "header"; text: string }
  | {
      type: "section";
      text?: string;
      fields?: string[];
      /** A thumbnail beside the text. */
      image?: RichImage;
      /** A link button beside the text. */
      button?: RichButton;
    }
  | { type: "context"; items: RichContextItem[] }
  | { type: "divider" }
  | { type: "image"; image: RichImage; title?: string }
  | { type: "actions"; buttons: RichButton[] }
  | {
      type: "video";
      title: string;
      url?: string;
      thumb?: RichImage;
      provider?: string;
    };

export interface RichField {
  title: string;
  value: string;
  short: boolean;
}

export interface RichAttachment {
  /** The bar down the left edge, as a 6-digit hex without "#". */
  color?: string;
  pretext?: string;
  author?: { name: string; icon?: string; link?: string };
  /** The site a link preview came from. */
  service?: { name: string; icon?: string };
  title?: string;
  titleLink?: string;
  text?: string;
  fields?: RichField[];
  image?: RichImage;
  thumb?: RichImage;
  footer?: string;
  footerIcon?: string;
  /** An app card's own blocks, shown in place of its text. */
  blocks?: RichBlock[];
}
