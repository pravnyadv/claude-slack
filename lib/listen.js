/**
 * Socket Mode listener: Slack pushes the token owner's message events over a WebSocket, and the ones
 * meant for them (DMs, group DMs, @mentions, replies in their threads or in threads a Claude session
 * follows) go into the store. It only ever reads; nothing here sends a message.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, api, envValue, when, nameOfUser, replaceUserIds } = require('./slack');
const store = require('./store');

const LABEL = 'com.slk.listen';

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

/** Why to keep an event: reason() for the owner, else 'thread' when a session follows its thread. */
const picker = (me) => (event) => reason(event, me)
  ?? (event?.type === 'message' && KEPT_SUBTYPES.has(event.subtype) && event.user && event.user !== me && store.isFollowed(event.channel, event.thread_ts) ? 'thread' : null);

/**
 * One Socket Mode connection: ack every envelope at once (Slack redelivers unacked ones), hand the
 * events pick() keeps to onEvent, and resolve when Slack or the network closes it.
 */
function session(url, pick, onEvent, log, idleMs = IDLE_MS) {
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
      const why = event ? pick(event) : null;
      if (event && envValue('SLK_DEBUG')) log(`event ${event.type}/${event.channel_type || '-'} in ${event.channel} kept=${why || 'no'}`);
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
  const onEvent = (event, why) => toEntry(event, why).then(store.addMessage).catch((e) => log(`could not record ${event.channel}:${event.ts}: ${e.message}`));
  log(`listening as ${me}, store ${store.dbFile()}`);
  for (let failures = 0; ; failures++) {
    try {
      const { url } = await api('apps.connections.open', {}, false, token);
      const opened = Date.now();
      await session(url, picker(me), onEvent, log);
      if (Date.now() - opened > 60_000) failures = 0;
      log('disconnected, reconnecting');
    } catch (e) {
      log(`connect failed: ${e.message}`);
    }
    await sleep(Math.min(60, 2 ** failures) * 1000);
  }
}

const plistFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${process.getuid()}`;
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The launchd agent: `slk listen` at login, restarted if it exits, logging next to the inbox. */
function plist() {
  const logFile = path.join(path.dirname(store.dbFile()), 'listen.log');
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
  fs.mkdirSync(path.dirname(store.dbFile()), { recursive: true });
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

/** Whether the launchd agent is loaded. */
function running() {
  try {
    execFileSync('launchctl', ['print', `${domain()}/${LABEL}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = { running, LABEL, reason, picker, toEntry, session, listen, plist, installAgent, uninstallAgent };
