/**
 * Name → unicode glyph map for rendering `:thumbsup:` style reactions.
 *
 * This is a baseline set covering what most Slack workspaces use day-to-day.
 * A fuller set can be loaded from the server via `emoji.list` (server
 * `--emojis <file>` flag) — the client merges the server's list over this
 * default, so custom workspace aliases + the long tail of standard names
 * both resolve.
 */

export const DEFAULT_EMOJI: Record<string, string> = {
  // Smileys
  smile: "😄",
  grinning: "😀",
  joy: "😂",
  rofl: "🤣",
  wink: "😉",
  heart_eyes: "😍",
  kissing_heart: "😘",
  thinking_face: "🤔",
  neutral_face: "😐",
  expressionless: "😑",
  grimacing: "😬",
  sweat_smile: "😅",
  sleepy: "😪",
  tired_face: "😫",
  sob: "😭",
  cry: "😢",
  scream: "😱",
  angry: "😠",
  rage: "😡",
  face_with_monocle: "🧐",
  nerd_face: "🤓",
  sunglasses: "😎",
  zany_face: "🤪",
  upside_down_face: "🙃",
  shushing_face: "🤫",

  // Gestures
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  clap: "👏",
  pray: "🙏",
  raised_hands: "🙌",
  wave: "👋",
  ok_hand: "👌",
  v: "✌️",
  point_up: "☝️",
  point_down: "👇",
  muscle: "💪",
  handshake: "🤝",

  // Hearts + symbols
  heart: "❤️",
  orange_heart: "🧡",
  yellow_heart: "💛",
  green_heart: "💚",
  blue_heart: "💙",
  purple_heart: "💜",
  black_heart: "🖤",
  white_heart: "🤍",
  broken_heart: "💔",
  sparkling_heart: "💖",
  fire: "🔥",
  star: "⭐",
  star2: "🌟",
  sparkles: "✨",
  boom: "💥",
  zap: "⚡",
  rainbow: "🌈",
  sun_with_face: "🌞",

  // Office / emoji-of-approval workhorses
  tada: "🎉",
  rocket: "🚀",
  eyes: "👀",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  warning: "⚠️",
  bulb: "💡",
  pencil: "✏️",
  memo: "📝",
  mag: "🔍",
  lock: "🔒",
  unlock: "🔓",
  bell: "🔔",
  speech_balloon: "💬",
  thought_balloon: "💭",
  dart: "🎯",
  hammer_and_wrench: "🛠️",
  shipit: "🚢",
  package: "📦",
  gear: "⚙️",
  chart_with_upwards_trend: "📈",
  chart_with_downwards_trend: "📉",
  bar_chart: "📊",
  100: "💯",
  question: "❓",
  exclamation: "❗",

  // Food + misc
  coffee: "☕",
  tea: "🍵",
  beer: "🍺",
  pizza: "🍕",
  taco: "🌮",
  cake: "🎂",
  birthday: "🎂",
  doughnut: "🍩",
  popcorn: "🍿",
  fries: "🍟",

  // Animals
  cat: "🐱",
  dog: "🐶",
  parrot: "🦜",
  unicorn: "🦄",
  panda_face: "🐼",

  // Weather / nature
  snowman: "☃️",
  cloud: "☁️",
  umbrella: "☂️",
  ocean: "🌊",

  // Moon reactions
  eyes_closed: "😌",
  sleeping: "😴",
  partying_face: "🥳",
  face_palm: "🤦",
  facepalm: "🤦",
  shrug: "🤷",
}

/** The short list shown in the picker. Order-sensitive. */
export const QUICK_PICK: string[] = [
  "thumbsup",
  "heart",
  "joy",
  "tada",
  "fire",
  "eyes",
  "rocket",
  "white_check_mark",
  "100",
  "pray",
  "clap",
  "smile",
  "wink",
  "sob",
  "thinking_face",
  "shipit",
]

/** Resolve `name → glyph`, falling back to `:name:` if unknown. */
export function renderEmoji(name: string, overrides?: Record<string, string>): string {
  if (overrides && overrides[name]) return overrides[name]!
  return DEFAULT_EMOJI[name] ?? `:${name}:`
}
