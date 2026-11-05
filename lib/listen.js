/**
 * Socket Mode listener: Slack pushes the token owner's message events over a WebSocket, and the ones
 * meant for them (DMs, group DMs, @mentions, replies in their threads) are appended to the inbox file
 * as JSON lines. It only ever reads; nothing here sends a message.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, api, envValue, when, nameOfUser, replaceUserIds } = require('./slack');

const LABEL = 'com.slk.listen';

/** Where events land: SLK_INBOX, else ~/.local/state/slk/inbox.jsonl. */
const inboxFile = () => envValue('SLK_INBOX') || path.join(os.homedir(), '.local', 'state', 'slk', 'inbox.jsonl');

function appToken() {
  const token = envValue('SLACK_APP_TOKEN');
  if (!token) throw new Error('SLACK_APP_TOKEN is not set. Run: slk setup --app-token');

  return token;
}

/** Plain new messages and file shares; edits, deletes, joins and bot posts are noise here. */
const KEPT_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast']);

/** Why the owner should hear about a message event ('dm', 'group', 'mention', 'thread'), or null. Never their own. */
function reason(event, me) {
  if (event?.type !== 'message' || !KEPT_SUBTYPES.has(event.subtype) || !event.user || event.user === me) return null;
  const rules = [
    ['dm', event.channel_type === 'im'],
    ['group', event.channel_type === 'mpim'],
    ['mention', (event.text || '').includes(`<@${me}>`)],
    ['thread', event.parent_user_id === me],
  ];

  return rules.find(([, hit]) => hit)?.[0] ?? null;
}

const channelNames = new Map();

/** 'dm', 'group dm' or '#channel' for an event, looked up once per channel. */
function placeOf(event) {
  if (event.channel_type === 'im') return 'dm';
  if (event.channel_type === 'mpim') return 'group dm';
  if (!channelNames.has(event.channel)) {
    channelNames.set(event.channel, api('conversations.info', { channel: event.channel }).then((d) => `#${d.channel.name}`).catch(() => event.channel));
  }

  return channelNames.get(event.channel);
}

/** The inbox line for a message event: who, where, readable text and a permalink to open or reply to. */
async function toEntry(event, why) {
  const [from, text, where, link] = await Promise.all([
    nameOfUser(event.user),
    replaceUserIds(event.text || ''),
    placeOf(event),
    api('chat.getPermalink', { channel: event.channel, message_ts: event.ts }).catch(() => ({})),
  ]);

  return { ts: event.ts, time: when(event.ts), why, where, from, user: event.user, channel: event.channel, thread_ts: event.thread_ts ?? null, text, permalink: link.permalink ?? null };
}

/** A socket silent this long (a sleep or network change can kill it without a close) is replaced; a fresh one is cheap. */
const IDLE_MS = 10 * 60 * 1000;

/**
 * One Socket Mode connection: ack every envelope at once (Slack redelivers unacked ones), hand the
 * owner's events to onEvent, and resolve when Slack or the network closes it.
 */
function session(url, me, onEvent, log, idleMs = IDLE_MS) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let idle;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { log('no frames, reconnecting'); ws.close(); }, idleMs);
    };
    arm();
    ws.onmessage = ({ data }) => {
      arm();
      let msg;
      try { msg = JSON.parse(data); } catch { return log('unreadable frame skipped'); }
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === 'hello') log('connected');
      if (msg.type === 'disconnect') ws.close();
      const event = msg.type === 'events_api' ? msg.payload?.event : null;
      const why = reason(event, me);
      if (why) onEvent(event, why);
    };
    ws.onerror = (e) => log(`socket error: ${e.message || e.type}`);
    ws.onclose = () => { clearTimeout(idle); resolve(); };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run forever: reconnect after every close, backing off up to a minute while connections keep failing. */
async function listen({ log = (m) => console.error(`[${new Date().toISOString()}] ${m}`) } = {}) {
  const token = appToken();
  const me = (await api('auth.test')).user_id;
  const file = inboxFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seen = new Set();
  const onEvent = (event, why) => {
    const key = `${event.channel}:${event.ts}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    toEntry(event, why).then((entry) => fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)).catch((e) => log(`could not record ${key}: ${e.message}`));
  };
  log(`listening as ${me}, inbox ${file}`);
  for (let failures = 0; ; failures++) {
    try {
      const { url } = await api('apps.connections.open', {}, false, token);
      const opened = Date.now();
      await session(url, me, onEvent, log);
      if (Date.now() - opened > 60_000) failures = 0;
      log('disconnected, reconnecting');
    } catch (e) {
      log(`connect failed: ${e.message}`);
    }
    await sleep(Math.min(60, 2 ** failures) * 1000);
  }
}

const markFile = () => `${inboxFile()}.read`;

/** Inbox entries, oldest first. */
function readInbox() {
  const file = inboxFile();

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    try { return l ? [JSON.parse(l)] : []; } catch { return []; }
  }) : [];
}

/** Entries that arrived since the last call, which then become read (one marker shared by every session). */
function unread() {
  const entries = readInbox();
  const read = fs.existsSync(markFile()) ? Number(fs.readFileSync(markFile(), 'utf8')) || 0 : 0;
  fs.writeFileSync(markFile(), String(entries.length));

  return entries.slice(read > entries.length ? 0 : read);
}

const plistFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${process.getuid()}`;
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The launchd agent: `slk listen` at login, restarted if it exits, logging next to the inbox. */
function plist() {
  const logFile = path.join(path.dirname(inboxFile()), 'listen.log');
  const args = [process.execPath, path.join(ROOT, 'slk.js'), 'listen'].map((a) => `<string>${xml(a)}</string>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(logFile)}</string>
<key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>
`;
}

/** Install (or reinstall) and start the launchd agent. Refuses without an app token, so it never crash-loops. */
function installAgent() {
  appToken();
  fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
  fs.mkdirSync(path.dirname(inboxFile()), { recursive: true });
  fs.writeFileSync(plistFile(), plist());
  uninstallAgent(false);
  execFileSync('launchctl', ['bootstrap', domain(), plistFile()]);

  return plistFile();
}

/** Stop the agent; with removeFile, also delete its plist. */
function uninstallAgent(removeFile = true) {
  try { execFileSync('launchctl', ['bootout', `${domain()}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  if (removeFile && fs.existsSync(plistFile())) fs.unlinkSync(plistFile());
}

module.exports = { LABEL, reason, toEntry, session, listen, inboxFile, readInbox, unread, plist, installAgent, uninstallAgent };
