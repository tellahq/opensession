import type { MentionSuggestion } from "./mention-palette";

/**
 * Shortcode emoji for the composer. Typing ":" followed by at least two
 * characters opens the picker (":cr" → :cry:, :crown:, …); selecting a row
 * replaces the whole ":cr" token with the character itself, so what gets sent
 * is real text rather than a shortcode the other end has to understand.
 *
 * Names follow the GitHub/Slack shortcode set so muscle memory transfers. The
 * list is deliberately hand-picked rather than a full Unicode dump: a picker
 * that opens on two letters is only useful if the first rows are the ones
 * people actually mean.
 */
export interface EmojiEntry {
  /** Shortcode name, without the surrounding colons. */
  name: string;
  /** The emoji character inserted into the text. */
  char: string;
  /** Extra words that should also match this emoji. */
  alias?: string[];
}

export const EMOJI: EmojiEntry[] = [
  // Faces, positive
  { name: "smile", char: "😄", alias: ["happy"] },
  { name: "smiley", char: "😃" },
  { name: "grin", char: "😁" },
  { name: "laughing", char: "😆", alias: ["lol"] },
  { name: "joy", char: "😂", alias: ["lol", "tears"] },
  { name: "rofl", char: "🤣", alias: ["lol"] },
  { name: "slightly_smiling_face", char: "🙂" },
  { name: "upside_down_face", char: "🙃" },
  { name: "wink", char: "😉" },
  { name: "blush", char: "😊" },
  { name: "innocent", char: "😇" },
  { name: "heart_eyes", char: "😍", alias: ["love"] },
  { name: "star_struck", char: "🤩" },
  { name: "kissing_heart", char: "😘" },
  { name: "yum", char: "😋" },
  { name: "stuck_out_tongue", char: "😛" },
  { name: "stuck_out_tongue_winking_eye", char: "😜" },
  { name: "zany_face", char: "🤪" },
  { name: "sunglasses", char: "😎", alias: ["cool"] },
  { name: "nerd_face", char: "🤓" },
  { name: "partying_face", char: "🥳", alias: ["celebrate"] },
  { name: "hugs", char: "🤗" },
  { name: "relieved", char: "😌" },
  { name: "smirk", char: "😏" },
  // Faces, neutral and negative
  { name: "neutral_face", char: "😐" },
  { name: "expressionless", char: "😑" },
  { name: "no_mouth", char: "😶" },
  { name: "face_with_raised_eyebrow", char: "🤨" },
  { name: "thinking", char: "🤔" },
  { name: "shushing_face", char: "🤫" },
  { name: "zipper_mouth_face", char: "🤐" },
  { name: "unamused", char: "😒" },
  { name: "roll_eyes", char: "🙄" },
  { name: "grimacing", char: "😬" },
  { name: "lying_face", char: "🤥" },
  { name: "pensive", char: "😔" },
  { name: "sleepy", char: "😪" },
  { name: "sleeping", char: "😴" },
  { name: "drooling_face", char: "🤤" },
  { name: "mask", char: "😷" },
  { name: "face_with_thermometer", char: "🤒" },
  { name: "nauseated_face", char: "🤢" },
  { name: "sneezing_face", char: "🤧" },
  { name: "hot_face", char: "🥵" },
  { name: "cold_face", char: "🥶" },
  { name: "woozy_face", char: "🥴" },
  { name: "dizzy_face", char: "😵" },
  { name: "exploding_head", char: "🤯" },
  { name: "confused", char: "😕" },
  { name: "worried", char: "😟" },
  { name: "slightly_frowning_face", char: "🙁" },
  { name: "frowning_face", char: "☹️" },
  { name: "open_mouth", char: "😮" },
  { name: "hushed", char: "😯" },
  { name: "astonished", char: "😲" },
  { name: "flushed", char: "😳" },
  { name: "pleading_face", char: "🥺" },
  { name: "frowning", char: "😦" },
  { name: "anguished", char: "😧" },
  { name: "fearful", char: "😨" },
  { name: "cold_sweat", char: "😰" },
  { name: "disappointed_relieved", char: "😥" },
  { name: "cry", char: "😢", alias: ["sad", "tear"] },
  { name: "sob", char: "😭", alias: ["sad", "crying"] },
  { name: "scream", char: "😱" },
  { name: "confounded", char: "😖" },
  { name: "persevere", char: "😣" },
  { name: "disappointed", char: "😞" },
  { name: "sweat", char: "😓" },
  { name: "weary", char: "😩" },
  { name: "tired_face", char: "😫" },
  { name: "yawning_face", char: "🥱" },
  { name: "triumph", char: "😤" },
  { name: "rage", char: "😡" },
  { name: "angry", char: "😠" },
  { name: "cursing_face", char: "🤬" },
  { name: "skull", char: "💀" },
  { name: "poop", char: "💩" },
  { name: "clown_face", char: "🤡" },
  { name: "ghost", char: "👻" },
  { name: "alien", char: "👽" },
  { name: "robot", char: "🤖" },
  { name: "smiling_imp", char: "😈" },
  // Cats
  { name: "smiley_cat", char: "😺" },
  { name: "heart_eyes_cat", char: "😻" },
  { name: "crying_cat_face", char: "😿", alias: ["sad"] },
  { name: "pouting_cat", char: "😾" },
  // Hands and people
  { name: "wave", char: "👋", alias: ["hi", "hello"] },
  { name: "raised_hands", char: "🙌" },
  { name: "clap", char: "👏" },
  { name: "handshake", char: "🤝" },
  { name: "thumbsup", char: "👍", alias: ["+1", "yes", "lgtm"] },
  { name: "thumbsdown", char: "👎", alias: ["-1", "no"] },
  { name: "ok_hand", char: "👌" },
  { name: "crossed_fingers", char: "🤞", alias: ["luck"] },
  { name: "v", char: "✌️" },
  { name: "love_you_gesture", char: "🤟" },
  { name: "call_me_hand", char: "🤙" },
  { name: "point_up", char: "☝️" },
  { name: "point_right", char: "👉" },
  { name: "point_left", char: "👈" },
  { name: "point_down", char: "👇" },
  { name: "raised_hand", char: "✋" },
  { name: "fist", char: "✊" },
  { name: "punch", char: "👊" },
  { name: "muscle", char: "💪" },
  { name: "pray", char: "🙏", alias: ["thanks", "please"] },
  { name: "writing_hand", char: "✍️" },
  { name: "nail_care", char: "💅" },
  { name: "eyes", char: "👀", alias: ["look", "watching"] },
  { name: "brain", char: "🧠" },
  { name: "person_shrugging", char: "🤷", alias: ["shrug"] },
  { name: "facepalm", char: "🤦" },
  { name: "person_raising_hand", char: "🙋" },
  { name: "detective", char: "🕵️" },
  { name: "technologist", char: "🧑‍💻", alias: ["coding", "dev"] },
  { name: "construction_worker", char: "👷" },
  { name: "firefighter", char: "🧑‍🚒" },
  { name: "rocket_scientist", char: "🧑‍🚀", alias: ["astronaut"] },
  { name: "dancer", char: "💃" },
  { name: "man_dancing", char: "🕺" },
  { name: "walking", char: "🚶" },
  { name: "running", char: "🏃" },
  // Hearts and symbols
  { name: "heart", char: "❤️", alias: ["love"] },
  { name: "orange_heart", char: "🧡" },
  { name: "yellow_heart", char: "💛" },
  { name: "green_heart", char: "💚" },
  { name: "blue_heart", char: "💙" },
  { name: "purple_heart", char: "💜" },
  { name: "black_heart", char: "🖤" },
  { name: "white_heart", char: "🤍" },
  { name: "broken_heart", char: "💔" },
  { name: "sparkling_heart", char: "💖" },
  { name: "star", char: "⭐" },
  { name: "star2", char: "🌟" },
  { name: "sparkles", char: "✨", alias: ["magic", "shiny"] },
  { name: "zap", char: "⚡", alias: ["fast", "lightning"] },
  { name: "boom", char: "💥" },
  { name: "fire", char: "🔥", alias: ["hot", "lit"] },
  { name: "100", char: "💯" },
  { name: "tada", char: "🎉", alias: ["party", "ship", "celebrate"] },
  { name: "confetti_ball", char: "🎊" },
  { name: "balloon", char: "🎈" },
  { name: "gift", char: "🎁" },
  { name: "trophy", char: "🏆", alias: ["win"] },
  { name: "medal", char: "🏅" },
  { name: "crown", char: "👑" },
  { name: "gem", char: "💎" },
  { name: "moneybag", char: "💰" },
  { name: "dollar", char: "💵" },
  { name: "credit_card", char: "💳" },
  { name: "bell", char: "🔔" },
  { name: "no_bell", char: "🔕" },
  { name: "mag", char: "🔍", alias: ["search"] },
  { name: "lock", char: "🔒" },
  { name: "unlock", char: "🔓" },
  { name: "key", char: "🔑" },
  { name: "link", char: "🔗" },
  { name: "paperclip", char: "📎" },
  { name: "pushpin", char: "📌" },
  { name: "calendar", char: "📅" },
  { name: "clipboard", char: "📋" },
  { name: "memo", char: "📝", alias: ["note", "write"] },
  { name: "books", char: "📚" },
  { name: "chart_with_upwards_trend", char: "📈" },
  { name: "chart_with_downwards_trend", char: "📉" },
  { name: "bar_chart", char: "📊" },
  { name: "hourglass", char: "⏳", alias: ["wait"] },
  { name: "alarm_clock", char: "⏰" },
  { name: "stopwatch", char: "⏱️" },
  { name: "warning", char: "⚠️" },
  { name: "no_entry", char: "⛔" },
  { name: "x", char: "❌", alias: ["no", "fail"] },
  { name: "white_check_mark", char: "✅", alias: ["done", "yes", "pass"] },
  { name: "heavy_check_mark", char: "✔️" },
  { name: "recycle", char: "♻️" },
  { name: "question", char: "❓" },
  { name: "exclamation", char: "❗" },
  { name: "arrow_right", char: "➡️" },
  { name: "arrow_left", char: "⬅️" },
  { name: "arrows_counterclockwise", char: "🔄", alias: ["retry", "refresh"] },
  { name: "infinity", char: "♾️" },
  { name: "wastebasket", char: "🗑️", alias: ["delete", "trash"] },
  // Objects, work and code
  { name: "computer", char: "💻", alias: ["laptop"] },
  { name: "desktop_computer", char: "🖥️" },
  { name: "keyboard", char: "⌨️" },
  { name: "iphone", char: "📱", alias: ["phone", "mobile"] },
  { name: "floppy_disk", char: "💾", alias: ["save"] },
  { name: "bug", char: "🐛" },
  { name: "beetle", char: "🪲" },
  { name: "wrench", char: "🔧", alias: ["fix"] },
  { name: "hammer", char: "🔨", alias: ["build"] },
  { name: "hammer_and_wrench", char: "🛠️" },
  { name: "nut_and_bolt", char: "🔩" },
  { name: "gear", char: "⚙️", alias: ["settings", "config"] },
  { name: "test_tube", char: "🧪", alias: ["test"] },
  { name: "microscope", char: "🔬" },
  { name: "telescope", char: "🔭" },
  { name: "package", char: "📦", alias: ["release", "ship"] },
  { name: "construction", char: "🚧", alias: ["wip"] },
  { name: "bulb", char: "💡", alias: ["idea"] },
  { name: "flashlight", char: "🔦" },
  { name: "broom", char: "🧹", alias: ["clean", "cleanup"] },
  { name: "soap", char: "🧼" },
  { name: "magnet", char: "🧲" },
  { name: "shield", char: "🛡️", alias: ["security"] },
  { name: "satellite", char: "🛰️" },
  { name: "battery", char: "🔋" },
  { name: "electric_plug", char: "🔌" },
  { name: "envelope", char: "✉️", alias: ["mail", "email"] },
  { name: "inbox_tray", char: "📥" },
  { name: "outbox_tray", char: "📤" },
  { name: "speech_balloon", char: "💬", alias: ["comment", "chat"] },
  { name: "thought_balloon", char: "💭" },
  { name: "loudspeaker", char: "📢" },
  { name: "mega", char: "📣" },
  { name: "camera", char: "📷" },
  { name: "movie_camera", char: "🎥" },
  { name: "film_projector", char: "📽️" },
  { name: "art", char: "🎨", alias: ["design"] },
  { name: "musical_note", char: "🎵" },
  { name: "headphones", char: "🎧" },
  { name: "video_game", char: "🎮" },
  { name: "dart", char: "🎯", alias: ["target", "goal"] },
  { name: "game_die", char: "🎲" },
  { name: "jigsaw", char: "🧩" },
  { name: "crystal_ball", char: "🔮" },
  { name: "compass", char: "🧭" },
  { name: "world_map", char: "🗺️" },
  { name: "traffic_light", char: "🚦" },
  { name: "rocket", char: "🚀", alias: ["ship", "launch", "deploy"] },
  { name: "airplane", char: "✈️" },
  { name: "car", char: "🚗" },
  { name: "bike", char: "🚲" },
  { name: "ship", char: "🚢" },
  { name: "anchor", char: "⚓" },
  { name: "house", char: "🏠" },
  { name: "office", char: "🏢" },
  { name: "factory", char: "🏭" },
  { name: "bank", char: "🏦" },
  { name: "hospital", char: "🏥" },
  // Nature, food and drink
  { name: "sunny", char: "☀️" },
  { name: "partly_sunny", char: "⛅" },
  { name: "cloud", char: "☁️" },
  { name: "rain_cloud", char: "🌧️" },
  { name: "snowflake", char: "❄️" },
  { name: "rainbow", char: "🌈" },
  { name: "ocean", char: "🌊" },
  { name: "volcano", char: "🌋" },
  { name: "earth_americas", char: "🌍" },
  { name: "moon", char: "🌙" },
  { name: "seedling", char: "🌱" },
  { name: "herb", char: "🌿" },
  { name: "four_leaf_clover", char: "🍀" },
  { name: "maple_leaf", char: "🍁" },
  { name: "cactus", char: "🌵" },
  { name: "evergreen_tree", char: "🌲" },
  { name: "sunflower", char: "🌻" },
  { name: "rose", char: "🌹" },
  { name: "dog", char: "🐶" },
  { name: "cat", char: "🐱" },
  { name: "mouse", char: "🐭" },
  { name: "fox_face", char: "🦊" },
  { name: "bear", char: "🐻" },
  { name: "panda_face", char: "🐼" },
  { name: "penguin", char: "🐧" },
  { name: "bird", char: "🐦" },
  { name: "owl", char: "🦉" },
  { name: "unicorn", char: "🦄" },
  { name: "whale", char: "🐳" },
  { name: "dolphin", char: "🐬" },
  { name: "octopus", char: "🐙" },
  { name: "snail", char: "🐌", alias: ["slow"] },
  { name: "turtle", char: "🐢", alias: ["slow"] },
  { name: "snake", char: "🐍" },
  { name: "dragon", char: "🐉" },
  { name: "coffee", char: "☕" },
  { name: "tea", char: "🍵" },
  { name: "beer", char: "🍺" },
  { name: "champagne", char: "🍾" },
  { name: "clinking_glasses", char: "🥂" },
  { name: "cake", char: "🍰" },
  { name: "birthday", char: "🎂" },
  { name: "cookie", char: "🍪" },
  { name: "doughnut", char: "🍩" },
  { name: "croissant", char: "🥐" },
  { name: "bread", char: "🍞" },
  { name: "cheese", char: "🧀" },
  { name: "pizza", char: "🍕" },
  { name: "hamburger", char: "🍔" },
  { name: "fries", char: "🍟" },
  { name: "taco", char: "🌮" },
  { name: "sushi", char: "🍣" },
  { name: "ramen", char: "🍜" },
  { name: "popcorn", char: "🍿" },
  { name: "apple", char: "🍎" },
  { name: "banana", char: "🍌" },
  { name: "strawberry", char: "🍓" },
  { name: "watermelon", char: "🍉" },
  { name: "avocado", char: "🥑" },
  { name: "carrot", char: "🥕" },
  { name: "salt", char: "🧂" },
];

const BY_NAME = new Map(EMOJI.map((entry) => [entry.name, entry]));

/** The shortest query that opens the picker. Two characters, per the ask. */
export const EMOJI_MIN_QUERY = 2;

const LIMIT = 12;

/**
 * Rank emoji for a shortcode query. A name that starts with the query beats
 * one that merely contains it, and an alias hit sorts last, so ":cry" leads
 * with :cry: rather than a longer name that happens to contain the letters.
 */
export function emojiMatches(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase().replace(/:$/, "");
  if (q.length < EMOJI_MIN_QUERY) return [];
  const exact = BY_NAME.get(q);
  const prefix: EmojiEntry[] = [];
  const contains: EmojiEntry[] = [];
  const aliased: EmojiEntry[] = [];
  for (const entry of EMOJI) {
    if (entry === exact) continue;
    if (entry.name.startsWith(q)) prefix.push(entry);
    else if (entry.name.includes(q)) contains.push(entry);
    else if (entry.alias?.some((a) => a.includes(q))) aliased.push(entry);
  }
  return [...(exact ? [exact] : []), ...prefix, ...contains, ...aliased].slice(
    0,
    LIMIT,
  );
}

/** Emoji rows for the mention picker. Selecting one inserts the character. */
export function emojiMentionSuggestions(query: string): MentionSuggestion[] {
  return emojiMatches(query).map((entry) => ({
    display: entry.char,
    insert: entry.char,
    kind: "emoji",
    sub: `:${entry.name}:`,
  }));
}

/** Longest shortcode we will scan back over before giving up. */
const MAX_TOKEN = 34;

/**
 * Characters that make a ":" mean something other than a shortcode. Letters and
 * digits cover "https://", "10:30" and "note:"; a second ":" covers "::". An
 * emoji is a symbol rather than a letter, so it passes, and so does a surrogate
 * half of one.
 */
const PREV_BLOCKS = /[\p{L}\p{N}_:]/u;

/**
 * Find the shortcode being typed at the caret: a ":" that starts a token,
 * followed by shortcode characters. Returns the index of the ":" and the query
 * typed after it, or null when the caret isn't in one.
 *
 * The ":" may not follow a letter, a digit or another ":", so "https://" never
 * opens the picker, and neither does a time like "10:30" or a label like
 * "note:". Everything else may precede it, which matters most right after an
 * emoji: picking one inserts no trailing space, so the very next ":cr" would
 * otherwise be dead. A trailing ":" stays inside the token, so finishing
 * ":cry:" keeps the row selectable instead of leaving the shortcode as raw
 * text.
 */
export function emojiContextAt(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  // A closing ":" is part of the token, not the end of the query: typing the
  // last colon of ":cry:" should still match `cry` rather than search for a
  // name containing a colon.
  const end = caret > 0 && value[caret - 1] === ":" ? caret - 1 : caret;
  let i = end - 1;
  while (i >= 0 && caret - i <= MAX_TOKEN) {
    const ch = value[i];
    if (ch === ":") {
      const prev = i > 0 ? value[i - 1] : undefined;
      if (!prev || !PREV_BLOCKS.test(prev)) {
        return { start: i, query: value.slice(i + 1, end) };
      }
      return null;
    }
    if (!/[a-z0-9_+-]/i.test(ch)) return null;
    i--;
  }
  return null;
}
