// Telegram bot that pushes one new English word on a fixed interval.
// Free end to end: Telegram Bot API, dictionaryapi.dev (IPA + audio), MyMemory (Vietnamese).
// Env: TELEGRAM_TOKEN (required), INTERVAL_MIN (default 30), MYMEMORY_EMAIL (optional, raises the free quota)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bot, InputFile } from "grammy";

const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const STATE_FILE = new URL("./state.json", import.meta.url);
const WORDS = JSON.parse(fs.readFileSync(new URL("./words.json", import.meta.url), "utf8"));

// One flat deck, easiest level first, so a learner walks A1 -> C2 in order.
export const DECK = LEVELS.flatMap((level) => WORDS[level].map((word) => ({ word, level })));

const INTERVAL_MS = Number(process.env.INTERVAL_MIN || 30) * 60 * 1000;

const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : { subscribers: {}, cache: {} };

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Where a level starts in the flat deck; used by /level to jump.
export function levelStart(level) {
  return DECK.findIndex((card) => card.level === level);
}

// The cards already served, oldest first, so they can be replayed.
export function recentCards(index, count) {
  const cards = [];
  for (let i = count; i >= 1; i--) cards.push(DECK[(((index - i) % DECK.length) + DECK.length) % DECK.length]);
  return cards;
}

// Advance one card and wrap around at the end of the deck.
export function nextCard(index) {
  const position = ((index % DECK.length) + DECK.length) % DECK.length;
  return { card: DECK[position], next: (position + 1) % DECK.length };
}

async function translate(word) {
  const email = process.env.MYMEMORY_EMAIL ? `&de=${encodeURIComponent(process.env.MYMEMORY_EMAIL)}` : "";
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|vi${email}`;
  const response = await fetch(url);
  const data = await response.json();
  return data?.responseData?.translatedText ?? "";
}

async function define(word) {
  const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!response.ok) return {};
  const [entry] = await response.json();
  const phonetics = entry?.phonetics ?? [];
  return {
    ipa: phonetics.find((p) => p.text)?.text || entry?.phonetic || "",
    audio: phonetics.find((p) => p.audio)?.audio || "",
    pos: entry?.meanings?.[0]?.partOfSpeech ?? "",
    en: entry?.meanings?.[0]?.definitions?.[0]?.definition ?? "",
  };
}

// Each word is looked up once, then served from state.json forever after.
async function lookup(word) {
  if (state.cache[word]) return state.cache[word];

  const entry = { word, ipa: "", audio: "", pos: "", en: "", vi: "" };
  const [definition, vietnamese] = await Promise.allSettled([define(word), translate(word)]);
  if (definition.status === "fulfilled") Object.assign(entry, definition.value);
  if (vietnamese.status === "fulfilled") entry.vi = vietnamese.value;

  state.cache[word] = entry;
  save();
  return entry;
}

// Telegram clients stop after one file, so a review is stitched into a single mp3.
// The parts are just concatenated: every source comes from the same Wiktionary
// pipeline, and players read the stream frame by frame. Telegram may show an odd
// duration for the result, but it plays straight through.
async function joinAudio(entries) {
  const parts = [];
  for (const entry of entries) {
    const response = await fetch(entry.audio).catch(() => null);
    if (!response?.ok) continue;
    parts.push(Buffer.from(await response.arrayBuffer()));
  }
  if (!parts.length) return null;

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "review-")), "review.mp3");
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

function format(card, entry) {
  const lines = [`[${card.level}] ${entry.word}`];
  if (entry.ipa) lines.push(entry.ipa);
  if (entry.pos) lines.push(`Loai tu: ${entry.pos}`);
  if (entry.vi) lines.push(`Nghia: ${entry.vi}`);
  if (entry.en) lines.push(`EN: ${entry.en}`);
  return lines.join("\n");
}

const bot = new Bot(process.env.TELEGRAM_TOKEN);

// Chats already served during the current one-shot run, so a /start or /next
// handled this run doesn't also get the scheduled word a second later.
const pushedThisRun = new Set();

async function push(chatId) {
  const subscriber = state.subscribers[chatId];
  if (!subscriber) return;
  pushedThisRun.add(chatId);

  const { card, next } = nextCard(subscriber.index);
  subscriber.index = next;
  subscriber.learned = (subscriber.learned ?? 0) + 1;
  subscriber.lastPush = Date.now();
  save();

  const entry = await lookup(card.word);
  await bot.api.sendMessage(chatId, format(card, entry));
  if (entry.audio) {
    // Telegram fetches the mp3 itself, so nothing is downloaded on this machine.
    // One performer for every file, so Telegram queues them as a single playlist
    // and keeps playing down the chat instead of stopping after one word.
    await bot.api
      .sendAudio(chatId, entry.audio, { title: entry.word, performer: "one word at a time" })
      .catch(() => {});
  }
}

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id);
  state.subscribers[chatId] ??= { index: 0, learned: 0 };
  save();
  await ctx.reply(
    `Da bat thong bao. Cu ${process.env.INTERVAL_MIN || 30} phut mot tu moi.\n` +
      "/next - lay tu tiep theo ngay\n" +
      `/level ${LEVELS.join(" | ")} - nhay den trinh do khac\n` +
      "/review 10 - nghe lai 10 tu gan nhat trong 1 file audio\n" +
      "/status - xem tien do\n" +
      "/stop - tat thong bao",
  );
  await push(chatId);
});

bot.command("stop", (ctx) => {
  delete state.subscribers[String(ctx.chat.id)];
  save();
  return ctx.reply("Da tat thong bao. Gui /start de bat lai.");
});

bot.command("next", (ctx) => push(String(ctx.chat.id)));

bot.command("level", async (ctx) => {
  const level = ctx.match.trim().toUpperCase();
  if (!LEVELS.includes(level)) return ctx.reply(`Chon mot trong: ${LEVELS.join(", ")}`);

  const chatId = String(ctx.chat.id);
  state.subscribers[chatId] ??= { index: 0, learned: 0 };
  state.subscribers[chatId].index = levelStart(level);
  save();
  await ctx.reply(`Da chuyen sang trinh do ${level}.`);
  await push(chatId);
});

// Replays the last N words as one audio file, for listening straight through.
bot.command("review", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const subscriber = state.subscribers[chatId];
  if (!subscriber) return ctx.reply("Chua bat thong bao. Gui /start.");

  // Capped at 20: a longer stitch outgrows the runner's time and the learner's patience.
  const asked = Number(ctx.match.trim()) || 10;
  const count = Math.min(Math.max(asked, 1), 20, subscriber.learned ?? 0);
  if (count < 1) return ctx.reply("Chua hoc tu nao. Gui /next.");

  const cards = recentCards(subscriber.index, count);
  const entries = [];
  for (const card of cards) entries.push(await lookup(card.word));
  await ctx.reply("On lai " + count + " tu: " + cards.map((card) => card.word).join(", "));

  const withAudio = entries.filter((entry) => entry.audio);
  const joined = withAudio.length ? await joinAudio(withAudio) : null;
  if (joined) {
    await bot.api.sendAudio(chatId, new InputFile(joined), {
      title: "On lai " + count + " tu",
      performer: "one word at a time",
    });
    return;
  }
  // Every download failed: fall back to one file per word.
  for (const entry of withAudio) {
    await bot.api
      .sendAudio(chatId, entry.audio, { title: entry.word, performer: "one word at a time" })
      .catch(() => {});
  }
});

bot.command("status", (ctx) => {
  const subscriber = state.subscribers[String(ctx.chat.id)];
  if (!subscriber) return ctx.reply("Chua bat thong bao. Gui /start.");
  const card = DECK[subscriber.index % DECK.length];
  return ctx.reply(
    `Da hoc: ${subscriber.learned ?? 0} tu\nTu ke tiep: ${card.word} (${card.level})\nTong bo tu: ${DECK.length}`,
  );
});

bot.catch((error) => console.error("Bot error:", error));

// Scheduled runs are more frequent than the word interval, so commands get answered
// quickly without burying the learner in words.
export function isDue(subscriber, now = Date.now()) {
  // A minute of slack, else a run landing just before the hour delays the word a full cycle.
  return now - (subscriber.lastPush ?? 0) >= INTERVAL_MS - 60_000;
}

async function tick({ skipAlreadyPushed = false, onlyIfDue = false } = {}) {
  for (const [chatId, subscriber] of Object.entries(state.subscribers)) {
    if (skipAlreadyPushed && pushedThisRun.has(chatId)) continue;
    if (onlyIfDue && !isDue(subscriber)) continue;
    await push(chatId).catch((error) => console.error(`push ${chatId}:`, error));
  }
}

// One-shot mode for a scheduled runner (GitHub Actions): drain any commands the
// user sent since the last run, push the next word, then exit.
async function runOnce() {
  await bot.init();
  const updates = await bot.api.getUpdates({ offset: state.offset ?? 0, timeout: 0 });
  console.log(`@${bot.botInfo.username}: ${updates.length} update(s), ${Object.keys(state.subscribers).length} subscriber(s)`);
  for (const update of updates) {
    await bot.handleUpdate(update).catch((error) => console.error("update:", error));
    state.offset = update.update_id + 1;
  }
  save();
  await tick({ skipAlreadyPushed: true, onlyIfDue: true });
}

if (import.meta.main) {
  if (process.argv.includes("--once")) {
    await runOnce();
  } else {
    setInterval(tick, INTERVAL_MS);
    bot.start();
    console.log(`Bot is running. One word every ${process.env.INTERVAL_MIN || 30} minutes. Ctrl+C to stop.`);
  }
}
