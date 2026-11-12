#!/usr/bin/env node
/** slk: Slack CLI. Reads and posts as the owner of SLACK_USER_TOKEN. See README.md. */
const fs = require('fs');
const readline = require('readline');
const { ROOT, api, envFile, envValue, stylePath, parseTarget, checkStyle, expandMentions, when, nameOfUser, replaceUserIds } = require('./lib/slack');
const listener = require('./lib/listen');
const store = require('./lib/store');


function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') flags.name = argv[++i];
    else if (a === '--count' || a === '--last' || a === '--minutes') flags[a.slice(2)] = Number(argv[++i]);
    else if (a.startsWith('--') && a.length > 2) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  return { flags, pos };
}

const out = (flags, human, data) => console.log(flags.json ? JSON.stringify(data) : human);

const describe = (u) => ({ id: u.id, name: u.name, real_name: u.real_name, display_name: u.profile?.display_name, title: u.profile?.title, email: u.profile?.email });

async function allUsers() {
  const users = [];
  let cursor;
  do {
    const d = await api('users.list', { limit: 200, cursor });
    users.push(...d.members.filter((u) => !u.deleted));
    cursor = d.response_metadata?.next_cursor;
  } while (cursor);

  return users;
}

/** Users matching a name (case-insensitive substring on real/display/handle) or an email. */
async function findUsers(query) {
  if (query.includes('@') && query.includes('.')) return [(await api('users.lookupByEmail', { email: query })).user];
  const q = query.toLowerCase();

  return (await allUsers()).filter((u) => [u.real_name, u.profile?.display_name, u.name].some((s) => s && s.toLowerCase().includes(q)));
}

/** One user id: a raw id passes through, a name must match exactly one person. */
async function resolveUserId(query) {
  const q = query.replace(/^@/, '');
  if (/^[UW][A-Z0-9]{6,}$/.test(q)) return q;
  const found = await findUsers(q);
  const exact = found.filter((u) => [u.real_name, u.profile?.display_name, u.name].some((s) => s && s.toLowerCase() === q.toLowerCase()));
  const pick = exact.length === 1 ? exact : found;
  if (pick.length !== 1) throw new Error(pick.length ? `"${q}" is ambiguous: ${pick.map((u) => u.real_name || u.name).join(', ')}` : `No Slack user found for "${q}".`);

  return pick[0].id;
}

/** Group entries by conversation, keeping arrival order. */
const byConversation = (rows) => [...Map.groupBy(rows, (r) => r.channel).values()].map((list) => ({
  channel: list[0].channel,
  where: list[0].where === 'dm' ? `dm with ${list[0].from}` : list[0].where,
  entries: list,
}));

const showConversation = (c) => `${c.where} (${c.entries.length})\n${c.entries.map((r) => `  [${when(r.ts)}] ${r.from}${r.why === 'thread' ? ' (thread)' : ''}: ${r.text}\n    ${r.permalink || `${r.channel} ${r.ts}`}`).join('\n')}`;

/** A warning line when the listener agent is not running, since nothing new can arrive without it. */
const listenerNote = () => (listener.running() ? '' : '\n(listener not running: slk listen --install)');

/** Channel id for a person (opens or finds the DM, no message sent), a #name or a raw channel id. */
async function conversationOf(ref) {
  if (ref.startsWith('#') || /^[CGD][A-Z0-9]{6,}$/.test(ref)) return resolveChannel(ref);
  const id = ref.includes('@') && ref.includes('.') ? (await api('users.lookupByEmail', { email: ref })).user.id : await resolveUserId(ref);

  return (await api('conversations.open', { users: id })).channel.id;
}

async function resolveChannel(ref) {
  if (!ref.startsWith('#')) return ref;
  const name = ref.slice(1).toLowerCase();
  let cursor;
  do {
    const d = await api('conversations.list', { types: 'public_channel,private_channel', limit: 200, exclude_archived: true, cursor });
    const hit = d.channels.find((c) => c.name === name);
    if (hit) return hit.id;
    cursor = d.response_metadata?.next_cursor;
  } while (cursor);
  throw new Error(`Channel ${ref} not found.`);
}

/** Message text from a literal, `@file` or `-` (stdin). */
function readText(src) {
  if (src === '-') return fs.readFileSync(0, 'utf8').trim();
  if (src?.startsWith('@') && fs.existsSync(src.slice(1))) return fs.readFileSync(src.slice(1), 'utf8').trim();
  if (!src) throw new Error('Message text is required.');

  return src;
}

/**
 * How long a person typing at SLK_WPM (default 80, 0 turns it off) takes to write `text`, with
 * 20% jitter so replies never land at a fixed rhythm. A word is 5 characters, the WPM convention.
 */
function typingMs(text, wpm = Number(envValue('SLK_WPM') ?? 80), jitter = Math.random()) {
  if (!(wpm > 0)) return 0;
  const ms = (text.length / 5 / wpm) * 60_000 * (0.9 + 0.2 * jitter);

  return Math.round(Math.min(90_000, Math.max(2_000, ms)));
}

/** Check the writing rules, expand mentions, then show (dry run) or send a chat.postMessage after a human typing pause. */
async function send(flags, label, channel, rawText, extra = {}) {
  checkStyle(rawText);
  const text = await expandMentions(rawText, resolveUserId);
  if (flags['dry-run']) {
    out(flags, `[dry run] ${label}\n  channel: ${channel}${extra.thread_ts ? `\n  thread_ts: ${extra.thread_ts}` : ''}\n  text: ${text}`, { dryRun: true, label, channel, ...extra, text });
    return;
  }
  await new Promise((r) => setTimeout(r, typingMs(rawText)));
  const d = await api('chat.postMessage', { channel, text, ...extra });
  const { permalink } = await api('chat.getPermalink', { channel: d.channel, message_ts: d.ts });
  // A DM is one conversation; elsewhere this session follows the thread the message lives in.
  store.link(d.channel, d.channel.startsWith('D') ? '' : (extra.thread_ts || d.ts));
  out(flags, `${permalink}\nWatch for the reply: slk wait ${d.channel}`, { channel: d.channel, ts: d.ts, permalink });
}

/** Message events Slack pushes on the owner's behalf; the listener keeps only the ones meant for them. */
const USER_EVENTS = ['message.im', 'message.mpim', 'message.channels', 'message.groups'];

const SCOPES = ['chat:write', 'channels:history', 'groups:history', 'im:history', 'mpim:history', 'im:write', 'users:read', 'users:read.email', 'search:read', 'channels:read', 'groups:read', 'files:read'];

/** Slack app manifest asking for user token scopes only. */
const manifest = (name) => ({
  display_information: { name },
  oauth_config: { scopes: { user: SCOPES } },
  settings: { event_subscriptions: { user_events: USER_EVENTS }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false },
});

/** Ask for the app-level token (xapp-, scope connections:write), check it opens a socket, and add it to .env. */
async function saveAppToken() {
  console.log(`The inbox needs Socket Mode on your Slack app:
  1. https://api.slack.com/apps, open your slk app.
  2. Socket Mode: turn it on and create an app-level token with connections:write.
  3. Event Subscriptions: turn on, and under "Subscribe to events on behalf of users" add
     ${USER_EVENTS.join(', ')}. Save, and reinstall the app if Slack asks.
  4. Paste the app-level token below (it starts with xapp-).
`);
  const token = process.stdin.isTTY ? await promptHidden('Paste the app-level token (hidden): ') : await io.readStdin();
  if (!token.startsWith('xapp-')) throw new Error('That is not an app-level token: it must start with xapp-.');
  await api('apps.connections.open', {}, false, token);
  const file = envFile();
  const kept = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !/^\s*SLACK_APP_TOKEN\s*=/.test(l)) : [];
  fs.writeFileSync(file, `${[...kept, `SLACK_APP_TOKEN=${token}`].join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log(`Saved to ${file} (mode 600). Start the listener: slk listen --install`);
}

/** SLK_SEND: "when-sure" lets Claude send without a draft when the skill's conditions hold; anything else is draft-first. */
const sendMode = () => (envValue('SLK_SEND') === 'when-sure' ? 'when-sure' : 'draft-first');

/** Process input, swappable in tests. readStdin is async: a synchronous read of a pipe can fail with EAGAIN. */
const io = {
  async readStdin() {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;

    return data.trim();
  },
};

/** Read a line from stdin. On a TTY the typed characters are not echoed. */
function promptHidden(question) {
  return new Promise((resolve) => {
    let muted = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: new (require('stream').Writable)({ write(chunk, _e, cb) { if (!muted) process.stdout.write(chunk); cb(); } }),
      terminal: true,
    });
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
    muted = true;
  });
}

const commands = {
  async setup(_pos, flags) {
    if (flags['app-token']) return saveAppToken();
    const name = typeof flags.name === 'string' && flags.name ? flags.name : 'slk';
    const file = envFile();
    if (fs.existsSync(file) && !flags.force) throw new Error(`${file} already exists. Use --force to overwrite it.`);
    console.log(`Slack app manifest (JSON):\n\n${JSON.stringify(manifest(name), null, 2)}\n
Steps:
  1. Open https://api.slack.com/apps and click Create New App.
  2. Choose From a manifest, pick your workspace, paste the JSON above.
  3. Click Create, then Install to Workspace and allow it.
  4. Open OAuth & Permissions and copy the User OAuth Token (starts with xoxp-).
`);
    const token = process.stdin.isTTY ? await promptHidden('Paste the User OAuth Token (hidden): ') : await io.readStdin();
    if (!token.startsWith('xoxp-')) throw new Error('That is not a user token: it must start with xoxp-.');
    const d = await api('auth.test', {}, false, token);
    fs.writeFileSync(file, `SLACK_USER_TOKEN=${token}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    console.log(`Saved to ${file} (mode 600). Connected as ${d.user} in ${d.team}.\nFor the inbox, also run: slk setup --app-token`);
  },

  /** Run the Socket Mode listener in the foreground, or install/remove it as a launchd agent. */
  async listen(_pos, flags) {
    if (flags.uninstall) {
      listener.uninstallAgent();
      return console.log(`Stopped and removed ${listener.LABEL}.`);
    }
    if (flags.install) return console.log(`Installed and started ${listener.installAgent()}. Store: ${store.dbFile()}`);
    await listener.listen();
  },

  /**
   * "Check Slack": what is new, this session's own conversations first, grouped by conversation.
   * --all shows the last --count stored messages instead and marks nothing.
   */
  async inbox(_pos, flags) {
    const rows = flags.all ? store.recent(flags.count || 20) : store.unread();
    const sections = flags.all ? [['Recent', rows]] : [['In this session\'s conversations', rows.filter((r) => r.mine)], ['Other new messages', rows.filter((r) => !r.mine)]];
    const shaped = sections.filter(([, list]) => list.length).map(([title, list]) => ({ title, conversations: byConversation(list) }));
    const human = shaped.map((s) => `${s.title}\n${s.conversations.map(showConversation).join('\n')}`).join('\n\n');
    out(flags, `${human || (flags.all ? 'Nothing stored yet.' : 'Nothing new.')}${listenerNote()}`, shaped);
  },

  /** Block until a reply arrives in this session's conversations (or only `target`), or --minutes (default 5) pass. */
  async wait([target], flags) {
    const minutes = flags.minutes || 5;
    const channel = target ? await conversationOf(target) : null;
    if (channel) store.link(channel);
    for (const deadline = Date.now() + minutes * 60_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 3000))) {
      const rows = store.takeMine(channel);
      if (rows.length) return out(flags, byConversation(rows).map(showConversation).join('\n'), rows);
    }
    out(flags, `No reply in ${minutes} min.${listenerNote()}`, []);
  },

  /** The recent conversation with a person (their DM) or in a channel, oldest first: context before drafting. */
  async history([who], flags) {
    if (!who) throw new Error('Usage: slk history <@name|userId|email|#channel|channelId> [--last N]');
    const channel = await conversationOf(who);
    const { messages } = await api('conversations.history', { channel, limit: flags.last || 20 });
    store.link(channel);
    const rows = [];
    for (const m of messages.reverse()) {
      rows.push({ ts: m.ts, time: when(m.ts), name: m.user ? await nameOfUser(m.user) : (m.username || 'bot'), text: await replaceUserIds(m.text || ''), replies: m.reply_count || 0 });
    }
    out(flags, rows.map((r) => `[${r.time}] ${r.name}: ${r.text}${r.replies ? ` (${r.replies} replies, slk read ${channel} ${r.ts})` : ''}`).join('\n') || 'No messages.', rows);
  },

  async whoami(_pos, flags) {
    const d = await api('auth.test');
    out(flags, `${d.user} (${d.user_id}) in ${d.team}`, { user: d.user, user_id: d.user_id, team: d.team });
  },

  async who([query], flags) {
    if (!query) throw new Error('Usage: slk who <name|email>');
    const found = (await findUsers(query)).map(describe);
    out(flags, found.map((u) => `${u.id}  ${u.name}  ${u.display_name || u.real_name || ''}  ${u.title || ''}`.trimEnd()).join('\n') || 'No matches.', found);
  },

  async read(pos, flags) {
    const { channel, threadTs } = parseTarget(pos);
    const { messages } = await api('conversations.replies', { channel, ts: threadTs, limit: 200 });
    store.link(channel, channel.startsWith('D') ? '' : threadTs);
    const hidden = flags.last ? Math.max(0, messages.length - 1 - flags.last) : 0;
    const rows = [];
    for (const m of [messages[0], ...messages.slice(1 + hidden)]) {
      const name = m.user ? await nameOfUser(m.user) : (m.username || m.bot_id || 'bot');
      const text = await replaceUserIds(m.text || '');
      rows.push({ ts: m.ts, user: m.user, name, text, time: when(m.ts) });
    }
    const lines = rows.map((r) => `[${r.time}] ${r.name}: ${r.text}`);
    if (hidden) lines.splice(1, 0, `(${hidden} earlier replies hidden)`);
    out(flags, lines.join('\n'), rows);
  },

  async reply(pos, flags) {
    const { channel, threadTs } = parseTarget(pos.slice(0, -1));
    await send(flags, 'reply', channel, readText(pos.at(-1)), { thread_ts: threadTs });
  },

  async dm([who, text], flags) {
    if (!who) throw new Error('Usage: slk dm <@name|userId|email> "<text>"');
    const body = readText(text);
    const id = who.includes('@') && who.includes('.') ? (await api('users.lookupByEmail', { email: who })).user.id : await resolveUserId(who);
    if (flags['dry-run']) return send(flags, `dm to ${id}`, `(dm with ${id})`, body);
    const { channel } = await api('conversations.open', { users: id });
    await send(flags, 'dm', channel.id, body);
  },

  async post([channel, text], flags) {
    if (!channel) throw new Error('Usage: slk post <channelId|#name> "<text>"');
    await send(flags, 'post', await resolveChannel(channel), readText(text));
  },

  async search([query], flags) {
    if (!query) throw new Error('Usage: slk search "<query>" [--count N]');
    const rows = await searchMessages(query, flags.count || 20);
    out(flags, rows.map((r) => `[${r.time}] ${r.where}: ${r.text}`).join('\n') || 'No matches.', rows);
  },

  /** Your own sent messages, newest first: the input for learning how you write. */
  async sent(_pos, flags) {
    const me = await api('auth.test');
    await commands.search([`from:<@${me.user_id}>`], flags);
  },

  /** Print the active writing profile, so drafts can follow it. --list shows the bundled ones. */
  async style(_pos, flags) {
    if (flags.list) {
      const dir = require('path').join(ROOT, 'styles');
      return console.log(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).join('\n'));
    }
    const file = stylePath();
    if (!fs.existsSync(file)) throw new Error(`Style profile not found: ${file}. Set SLK_STYLE in .env to a name from "slk style --list" or a path.`);
    console.log(`Send mode: ${sendMode()}\n\n# ${file}\n\n${fs.readFileSync(file, 'utf8')}`);
  },

  help() {
    console.log(HELP);
  },
};

/** search.messages, newest first, paged at 100 (Slack's max) until `count` rows. */
async function searchMessages(query, count) {
  const rows = [];
  // Slack serves at most 100 pages; a later page silently returns page 1 again.
  for (let page = 1; rows.length < count && page <= 100; page++) {
    const d = await api('search.messages', { query, count: Math.min(100, count), page, sort: 'timestamp', sort_dir: 'desc' });
    for (const m of d.messages.matches) {
      rows.push({ ts: m.ts, where: m.channel?.is_im ? 'dm' : `#${m.channel?.name || m.channel?.id}`, channel: m.channel?.id, im_with: m.channel?.is_im ? m.channel.user : null, text: m.text || '', permalink: m.permalink, time: when(m.ts) });
    }
    if (page >= (d.messages.paging?.pages || 1)) break;
  }

  return rows.slice(0, count);
}

const HELP = `slk <command> [args] [--json] [--dry-run]

  setup [--name "App Name"] [--force]      print the app manifest, then save your token
  setup --app-token                         save the app-level token the inbox listener needs
  listen [--install | --uninstall]          receive your DMs, mentions and thread replies (launchd agent)
  inbox [--all] [--count N]                 what is new for you, this session's conversations first
  wait [<@name|#channel>] [--minutes N]     block until a reply arrives in this session's conversations
  history <@name|#channel> [--last N]       the recent conversation with a person or in a channel
  whoami                                    who the token belongs to
  search "<query>" [--count N]               search messages (Slack search syntax), newest first
  sent [--count N]                          your own sent messages, newest first
  style [--list]                            print the send mode (SLK_SEND) and writing profile (SLK_STYLE)
  who <name|email>                          find users (id, handle, name, title)
  read <permalink | channelId ts> [--last N]  print a thread (root plus the last N replies)
  reply <permalink | channelId ts> <text>   reply in the thread
  dm <@name|userId|email> <text>            direct message
  post <channelId|#name> <text>             post in a channel

<text> is a literal, @file or - (stdin). A send waits as long as typing it takes at SLK_WPM
(default 80, max 90s, 0 = instant). Writes accept --dry-run and refuse em/en dashes,
arrows, bullet characters and curly quotes. In text, @{Full Name} or @First becomes a mention.
First run: slk setup`;

async function main(argv) {
  const { flags, pos } = parseArgs(argv);
  const [cmd = 'help', ...rest] = pos;
  if (!commands[cmd]) throw new Error(`Unknown command "${cmd}". Run: slk help`);
  await commands[cmd](rest, flags);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { main, commands, io, typingMs };
