import React from "react";
import { cn } from "../ui/cn";

/**
 * Brand marks for the file-type badge — a different family from the interface
 * glyphs in icons.tsx (those are a 24-grid stroke set; these are filled
 * silhouettes drawn in `currentColor`, so they take the language's own hue).
 *
 * A language only gets a mark if its logo still reads at badge size. At 14px,
 * Go's wordmark, Java's duke, the Sass swirl, the SVG flower and MySQL's
 * dolphin all collapse into a smudge. Those keep their letters, which is no
 * loss: "GO", "MD" and "SVG" are already the whole name, and TypeScript,
 * JavaScript and CSS have never been anything but letters either.
 *
 * Paths from simple-icons (CC0), except ReScript's, which is from
 * rescript-lang.org's own brandmark. Each is cropped to its ink (see Mark), so
 * they all fill the same box however much padding their source drew.
 */

interface MarkProps {
  /** The ink's longer side, in px. */
  size: number;
}

/**
 * Every mark's viewBox is cropped to its own ink (measured with getBBox), so
 * `size` is the ink's longer side rather than a box it floats inside. The
 * source logos pad themselves by different amounts, which is what left the
 * badges with uneven side air. Width and height are derived from the crop's
 * aspect, so the ink fills the element exactly in both axes.
 *
 * That exact fit is why the mark must not clip. An SVG's default
 * `overflow: hidden` cuts at the viewport, and a crop-to-ink viewBox puts the
 * drawing ON that edge, so the rasterizer drops whatever falls in the
 * boundary's own fraction of a device pixel. On a curve that runs nearly
 * parallel to the edge that is not a hairline, it is the whole tip: React's
 * atom lost the bottom of both diagonals at 12px, sliced flat. Nothing paints
 * outside the box anyway (the ink's rect measures the element's rect), so
 * `overflow-visible` costs no layout and hands the tips back.
 */
function Mark({
  size,
  viewBox,
  children,
}: MarkProps & { viewBox: string; children: React.ReactNode }) {
  const [, , w, h] = viewBox.split(" ").map(Number);
  const px = size / Math.max(w, h);
  return (
    <svg
      width={w * px}
      height={h * px}
      viewBox={viewBox}
      fill="currentColor"
      className="overflow-visible"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * ReScript's bar-and-dot "R", cropped to its own bounds: the logo draws it on a
 * red rounded square, which is exactly what the badge already is.
 */
export function ReScriptMark({ size }: MarkProps) {
  return (
    <Mark size={size} viewBox="65.318 60.647 133.775 134.642">
      <path d="M65.318 87.582c0-9.422 0-14.135 1.84-17.74a16.802 16.802 0 0 1 7.355-7.364c3.6-1.831 8.313-1.831 17.74-1.831h23.564v109.398c0 7.842 0 11.765-1.282 14.854a16.823 16.823 0 0 1-9.11 9.108c-3.091 1.282-7.014 1.282-14.853 1.282-7.842 0-11.765 0-14.854-1.282a16.817 16.817 0 0 1-9.11-9.108c-1.282-3.091-1.282-7.014-1.282-14.854l-.008-82.463Z" />
      <circle cx="169.41" cy="91.333" r="29.683" />
    </Mark>
  );
}

/** Swift's bird, lifted out of the rounded tile it ships in — same reason. */
export function SwiftMark({ size }: MarkProps) {
  return (
    <Mark size={size} viewBox="2.411 3.409 18.117 16.213">
      <path d="M13.543 3.41c4.114 2.47 6.545 7.162 5.549 11.131-.024.093-.05.181-.076.272l.002.001c2.062 2.538 1.5 5.258 1.236 4.745-1.072-2.086-3.066-1.568-4.088-1.043a6.803 6.803 0 0 1-.281.158l-.02.012-.002.002c-2.115 1.123-4.957 1.205-7.812-.022a12.568 12.568 0 0 1-5.64-4.838c.649.48 1.35.902 2.097 1.252 3.019 1.414 6.051 1.311 8.197-.002C9.651 12.73 7.101 9.67 5.146 7.191a10.628 10.628 0 0 1-1.005-1.384c2.34 2.142 6.038 4.83 7.365 5.576C8.69 8.408 6.208 4.743 6.324 4.86c4.436 4.47 8.528 6.996 8.528 6.996.154.085.27.154.36.213.085-.215.16-.437.224-.668.708-2.588-.09-5.548-1.893-7.992z" />
    </Mark>
  );
}

/** HTML5's shield, cropped to the shield (the logo has no outer box). */
export function Html5Mark({ size }: MarkProps) {
  return (
    <Mark size={size} viewBox="1.5 0 21 24">
      <path d="M1.5 0h21l-1.91 21.563L11.977 24l-8.564-2.438L1.5 0zm7.031 9.75l-.232-2.718 10.059.003.23-2.622L5.412 4.41l.698 8.01h9.126l-.326 3.426-2.91.804-2.955-.81-.188-2.11H6.248l.33 4.171L12 19.351l5.379-1.443.744-8.157H8.531z" />
    </Mark>
  );
}

/** React's atom, for .tsx/.jsx — thin rings, so it needs the most box. */
export function ReactMark({ size }: MarkProps) {
  return (
    <Mark size={size} viewBox="0 1.314 24 21.375">
      <path d="M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z" />
    </Mark>
  );
}

/** Rust's gear-R. */
export function RustMark({ size }: MarkProps) {
  return (
    <Mark size={size} viewBox="0 0.004 24 23.992">
      <path d="M23.8346 11.7033l-1.0073-.6236a13.7268 13.7268 0 00-.0283-.2936l.8656-.8069a.3483.3483 0 00-.1154-.578l-1.1066-.414a8.4958 8.4958 0 00-.087-.2856l.6904-.9587a.3462.3462 0 00-.2257-.5446l-1.1663-.1894a9.3574 9.3574 0 00-.1407-.2622l.49-1.0761a.3437.3437 0 00-.0274-.3361.3486.3486 0 00-.3006-.154l-1.1845.0416a6.7444 6.7444 0 00-.1873-.2268l.2723-1.153a.3472.3472 0 00-.417-.4172l-1.1532.2724a14.0183 14.0183 0 00-.2278-.1873l.0415-1.1845a.3442.3442 0 00-.49-.328l-1.076.491c-.0872-.0476-.1742-.0952-.2623-.1407l-.1903-1.1673A.3483.3483 0 0016.256.955l-.9597.6905a8.4867 8.4867 0 00-.2855-.086l-.414-1.1066a.3483.3483 0 00-.5781-.1154l-.8069.8666a9.2936 9.2936 0 00-.2936-.0284L12.2946.1683a.3462.3462 0 00-.5892 0l-.6236 1.0073a13.7383 13.7383 0 00-.2936.0284L9.9803.3374a.3462.3462 0 00-.578.1154l-.4141 1.1065c-.0962.0274-.1903.0567-.2855.086L7.744.955a.3483.3483 0 00-.5447.2258L7.009 2.348a9.3574 9.3574 0 00-.2622.1407l-1.0762-.491a.3462.3462 0 00-.49.328l.0416 1.1845a7.9826 7.9826 0 00-.2278.1873L3.8413 3.425a.3472.3472 0 00-.4171.4171l.2713 1.1531c-.0628.075-.1255.1509-.1863.2268l-1.1845-.0415a.3462.3462 0 00-.328.49l.491 1.0761a9.167 9.167 0 00-.1407.2622l-1.1662.1894a.3483.3483 0 00-.2258.5446l.6904.9587a13.303 13.303 0 00-.087.2855l-1.1065.414a.3483.3483 0 00-.1155.5781l.8656.807a9.2936 9.2936 0 00-.0283.2935l-1.0073.6236a.3442.3442 0 000 .5892l1.0073.6236c.008.0982.0182.1964.0283.2936l-.8656.8079a.3462.3462 0 00.1155.578l1.1065.4141c.0273.0962.0567.1914.087.2855l-.6904.9587a.3452.3452 0 00.2268.5447l1.1662.1893c.0456.088.0922.1751.1408.2622l-.491 1.0762a.3462.3462 0 00.328.49l1.1834-.0415c.0618.0769.1235.1528.1873.2277l-.2713 1.1541a.3462.3462 0 00.4171.4161l1.153-.2713c.075.0638.151.1255.2279.1863l-.0415 1.1845a.3442.3442 0 00.49.327l1.0761-.49c.087.0486.1741.0951.2622.1407l.1903 1.1662a.3483.3483 0 00.5447.2268l.9587-.6904a9.299 9.299 0 00.2855.087l.414 1.1066a.3452.3452 0 00.5781.1154l.8079-.8656c.0972.0111.1954.0203.2936.0294l.6236 1.0073a.3472.3472 0 00.5892 0l.6236-1.0073c.0982-.0091.1964-.0183.2936-.0294l.8069.8656a.3483.3483 0 00.578-.1154l.4141-1.1066a8.4626 8.4626 0 00.2855-.087l.9587.6904a.3452.3452 0 00.5447-.2268l.1903-1.1662c.088-.0456.1751-.0931.2622-.1407l1.0762.49a.3472.3472 0 00.49-.327l-.0415-1.1845a6.7267 6.7267 0 00.2267-.1863l1.1531.2713a.3472.3472 0 00.4171-.416l-.2713-1.1542c.0628-.0749.1255-.1508.1863-.2278l1.1845.0415a.3442.3442 0 00.328-.49l-.49-1.076c.0475-.0872.0951-.1742.1407-.2623l1.1662-.1893a.3483.3483 0 00.2258-.5447l-.6904-.9587.087-.2855 1.1066-.414a.3462.3462 0 00.1154-.5781l-.8656-.8079c.0101-.0972.0202-.1954.0283-.2936l1.0073-.6236a.3442.3442 0 000-.5892zm-6.7413 8.3551a.7138.7138 0 01.2986-1.396.714.714 0 11-.2997 1.396zm-.3422-2.3142a.649.649 0 00-.7715.5l-.3573 1.6685c-1.1035.501-2.3285.7795-3.6193.7795a8.7368 8.7368 0 01-3.6951-.814l-.3574-1.6684a.648.648 0 00-.7714-.499l-1.473.3158a8.7216 8.7216 0 01-.7613-.898h7.1676c.081 0 .1356-.0141.1356-.088v-2.536c0-.074-.0536-.0881-.1356-.0881h-2.0966v-1.6077h2.2677c.2065 0 1.1065.0587 1.394 1.2088.0901.3533.2875 1.5044.4232 1.8729.1346.413.6833 1.2381 1.2685 1.2381h3.5716a.7492.7492 0 00.1296-.0131 8.7874 8.7874 0 01-.8119.9526zM6.8369 20.024a.714.714 0 11-.2997-1.396.714.714 0 01.2997 1.396zM4.1177 8.9972a.7137.7137 0 11-1.304.5791.7137.7137 0 011.304-.579zm-.8352 1.9813l1.5347-.6824a.65.65 0 00.33-.8585l-.3158-.7147h1.2432v5.6025H3.5669a8.7753 8.7753 0 01-.2834-3.348zm6.7343-.5437V8.7836h2.9601c.153 0 1.0792.1772 1.0792.8697 0 .575-.7107.7815-1.2948.7815zm10.7574 1.4862c0 .2187-.008.4363-.0243.651h-.9c-.09 0-.1265.0586-.1265.1477v.413c0 .973-.5487 1.1846-1.0296 1.2382-.4576.0517-.9648-.1913-1.0275-.4717-.2704-1.5186-.7198-1.8436-1.4305-2.4034.8817-.5599 1.799-1.386 1.799-2.4915 0-1.1936-.819-1.9458-1.3769-2.3153-.7825-.5163-1.6491-.6195-1.883-.6195H5.4682a8.7651 8.7651 0 014.907-2.7699l1.0974 1.151a.648.648 0 00.9182.0213l1.227-1.1743a8.7753 8.7753 0 016.0044 4.2762l-.8403 1.8982a.652.652 0 00.33.8585l1.6178.7188c.0283.2875.0425.577.0425.8717zm-9.3006-9.5993a.7128.7128 0 11.984 1.0316.7137.7137 0 01-.984-1.0316zm8.3389 6.71a.7107.7107 0 01.9395-.3625.7137.7137 0 11-.9405.3635z" />
    </Mark>
  );
}

/** TOML's bracketed T. */
export function TomlMark({ size }: MarkProps) {
  return (
    <Mark size={size} viewBox="0.014 0 23.972 24">
      <path d="M.014 0h5.34v2.652H2.888v18.681h2.468V24H.015V0Zm17.622 5.049v2.78h-4.274v12.935h-3.008V7.83H6.059V5.05h11.577ZM23.986 24h-5.34v-2.652h2.467V2.667h-2.468V0h5.34v24Z" />
    </Mark>
  );
}

/** Ruby's cut gem. */
export function RubyMark({ size }: MarkProps) {
  return (
    <Mark size={size} viewBox="0 0.073 24 23.853">
      <path d="M20.156.083c3.033.525 3.893 2.598 3.829 4.77L24 4.822 22.635 22.71 4.89 23.926h.016C3.433 23.864.15 23.729 0 19.139l1.645-3 2.819 6.586.503 1.172 2.805-9.144-.03.007.016-.03 9.255 2.956-1.396-5.431-.99-3.9 8.82-.569-.615-.51L16.5 2.114 20.159.073l-.003.01zM0 19.089zM5.13 5.073c3.561-3.533 8.157-5.621 9.922-3.84 1.762 1.777-.105 6.105-3.673 9.636-3.563 3.532-8.103 5.734-9.864 3.957-1.766-1.777.045-6.217 3.612-9.75l.003-.003z" />
    </Mark>
  );
}

/** Python's two snakes. */
export function PythonMark({ size }: MarkProps) {
  return (
    <Mark size={size} viewBox="-0.06 0 24.12 24">
      <path d="M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z" />
    </Mark>
  );
}

/** Extension → mark. Anything absent falls back to the badge's letters. */
export const LANG_MARKS = {
  res: ReScriptMark,
  resi: ReScriptMark,
  swift: SwiftMark,
  html: Html5Mark,
  tsx: ReactMark,
  jsx: ReactMark,
  rs: RustMark,
  toml: TomlMark,
  rb: RubyMark,
  py: PythonMark,
};

const LANG_MARKS_BY_EXTENSION = new Map(Object.entries(LANG_MARKS));

/**
 * The file's language mark: the brand glyph where one reads at this size, its
 * letters otherwise. Worn by the turn footer's file chips and by the work
 * fold's file rows, so one file looks the same wherever a turn mentions it.
 *
 * The badge carries no fill of its own: a chip's faint background belongs to
 * the whole chip, so the mark, the name and the counts read as one object.
 *
 * Mixing a quarter of the theme's own text colour into the ink lifts the dark
 * ones (Ruby's #701516, JSON's #953800) off `--bg` in dark mode and settles the
 * bright ones in light mode, from one expression and without a second palette
 * to keep in sync. The ink sits 1px low inside the centred tint: its optical
 * baseline then meets the filename beside it instead of floating above it.
 */
export function ExtBadge({
  name,
  size = 12,
  className,
}: {
  name: string;
  /** The mark's ink, in px. The letters ride along at the badge's own size. */
  size?: number;
  className?: string;
}) {
  const ext = fileExt(name);
  const color = EXT_COLORS_BY_EXTENSION.get(ext) || "#6e7681";
  const Glyph = LANG_MARKS_BY_EXTENSION.get(ext);
  return (
    <span
      className={cn(
        "flex h-4 min-w-4 flex-shrink-0 items-center justify-center px-0.5 text-meta font-bold leading-none",
        className,
      )}
      style={{ color: `color-mix(in oklab, ${color} 75%, var(--text))` }}
    >
      <span className="flex translate-y-px items-center justify-center">
        {Glyph ? <Glyph size={size} /> : extLabel(ext)}
      </span>
    </span>
  );
}

/** A filename's extension, lowercased, or "" when it has none. */
export function fileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1).toLowerCase()
    : "";
}

/**
 * An extension keeps its real name up to four characters and is cut to three
 * beyond that. A blind three-letter cut spelled "JSO", "YAM", "SCS" and "JAV",
 * word-shaped enough to read as a typo rather than an abbreviation, and the
 * badge is elastic, so the fourth character costs a few pixels.
 */
function extLabel(ext: string): string {
  if (!ext) return "?";
  return (ext.length <= 4 ? ext : ext.slice(0, 3)).toUpperCase();
}

const EXT_COLORS = {
  ts: "#3178c6",
  tsx: "#3178c6",
  js: "#a38319",
  jsx: "#a38319",
  mjs: "#a38319",
  cjs: "#a38319",
  css: "#663399",
  scss: "#c6538c",
  html: "#e34c26",
  md: "#0969da",
  mdx: "#0969da",
  json: "#953800",
  yaml: "#cb171e",
  yml: "#cb171e",
  toml: "#9c4221",
  sh: "#459721",
  bash: "#459721",
  py: "#3572a5",
  rs: "#b7410e",
  go: "#0091b5",
  rb: "#701516",
  swift: "#f05138",
  java: "#b07219",
  sql: "#bf7600",
  svg: "#ca6f06",
  // Linguist's ReScript red (#ed5051) is the loudest hue in this map and only
  // clears 3.6:1 against the white label, so it is darkened to sit with its
  // neighbours.
  res: "#c93a3c",
  resi: "#c93a3c",
};

const EXT_COLORS_BY_EXTENSION = new Map(Object.entries(EXT_COLORS));
