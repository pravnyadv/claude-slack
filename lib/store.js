/**
 * The local SQLite store (node:sqlite, no dependency): messages the listener received, which Claude
 * session is talking in which conversation, and what each has already seen. One owner for the file.
 */
const fs = require('fs');
const path = require('path');
const { ROOT, envValue } = require('./slack');

const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...rest));
const { DatabaseSync } = require('node:sqlite');

/** A conversation link older than this no longer pulls messages into a session. */
const LINK_TTL_SECONDS = 7 * 86400;

/** Next to slk.js, like .env: Claude's sandbox can write there, and it stays out of git. */
const dbFile = () => envValue('SLK_DB') || path.join(ROOT, 'data', 'slk.db');

/** The Claude Code session running this command, or null outside one. */
const sessionId = () => process.env.CLAUDE_CODE_SESSION_ID || null;

let db;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
  db = new DatabaseSync(dbFile());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL, ts TEXT NOT NULL, thread_ts TEXT,
      user TEXT, sender TEXT, place TEXT, why TEXT, text TEXT, permalink TEXT,
      received_at INTEGER NOT NULL, shown INTEGER NOT NULL DEFAULT 0,
      UNIQUE (channel, ts)
    );
    CREATE TABLE IF NOT EXISTS links (
      session TEXT NOT NULL, channel TEXT NOT NULL, thread_ts TEXT NOT NULL DEFAULT '',
      seen_id INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY (session, channel, thread_ts)
    );
  `);

  return db;
}

/** Close the handle (tests point SLK_DB at a fresh file between cases). */
function close() {
  db?.close();
  db = undefined;
}

const now = () => Math.floor(Date.now() / 1000);
const maxId = () => open().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get().id;

/** Store one received message; a redelivery of the same channel and ts is ignored. */
function addMessage(m) {
  open().prepare(`INSERT OR IGNORE INTO messages (channel, ts, thread_ts, user, sender, place, why, text, permalink, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.channel, m.ts, m.thread_ts ?? null, m.user, m.from, m.where, m.why, m.text, m.permalink ?? null, now());
}

/**
 * Remember that this session is talking in a conversation (a DM or channel, or one thread of it), so
 * its messages count as this session's. Starts unseen-tracking from now. No-op outside a session.
 */
function link(channel, threadTs = '') {
  const session = sessionId();
  if (!session) return;
  open().prepare(`INSERT INTO links (session, channel, thread_ts, seen_id, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (session, channel, thread_ts) DO UPDATE SET updated_at = excluded.updated_at`).run(session, channel, threadTs || '', maxId(), now());
}

/** Whether any live session is following this channel thread, so the listener keeps replies that do not mention the owner. */
function isFollowed(channel, threadTs) {
  if (!threadTs) return false;

  return Boolean(open().prepare('SELECT 1 FROM links WHERE channel = ? AND thread_ts = ? AND updated_at > ? LIMIT 1').get(channel, threadTs, now() - LINK_TTL_SECONDS));
}

const rowToEntry = (r) => ({ id: r.id, channel: r.channel, ts: r.ts, thread_ts: r.thread_ts, user: r.user, from: r.sender, where: r.place, why: r.why, text: r.text, permalink: r.permalink });

/** This session's live links, as SQL matching a message row `m`. */
const MINE = `EXISTS (SELECT 1 FROM links l WHERE l.session = ? AND l.updated_at > ? AND l.channel = m.channel
  AND (l.thread_ts = '' OR l.thread_ts = m.thread_ts OR l.thread_ts = m.ts) AND m.id > l.seen_id)`;

/** Mark this session's links seen up to `upTo`. */
function markLinksSeen(session, upTo, channels = null) {
  const rows = open().prepare('SELECT channel, thread_ts FROM links WHERE session = ?').all(session);
  const mark = open().prepare('UPDATE links SET seen_id = MAX(seen_id, ?) WHERE session = ? AND channel = ? AND thread_ts = ?');
  for (const r of rows) if (!channels || channels.includes(r.channel)) mark.run(upTo, session, r.channel, r.thread_ts);
}

const markShown = (ids) => ids.length && open().prepare(`UPDATE messages SET shown = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);

/**
 * What to show for "check Slack": new messages in this session's own conversations (mine: true) first,
 * then everything no session has shown yet. Both become seen.
 */
function unread() {
  const session = sessionId();
  const mine = session ? MINE : '0';
  const args = session ? [session, now() - LINK_TTL_SECONDS] : [];
  const rows = open().prepare(`SELECT m.*, ${mine} AS mine FROM messages m WHERE m.shown = 0 OR ${mine} ORDER BY mine DESC, m.id`).all(...args, ...args);
  markShown(rows.map((r) => r.id));
  if (session) markLinksSeen(session, maxId());

  return rows.map((r) => ({ ...rowToEntry(r), mine: Boolean(r.mine) }));
}

/** The last `count` stored messages, oldest first, without marking anything. */
function recent(count) {
  return open().prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(count).reverse().map(rowToEntry);
}

/** New messages in this session's conversations (or only `channel`), not yet seen; marks them seen. */
function takeMine(channel = null) {
  const session = sessionId();
  if (!session) return [];
  const rows = open().prepare(`SELECT m.* FROM messages m WHERE ${MINE} ${channel ? 'AND m.channel = ?' : ''} ORDER BY m.id`)
    .all(session, now() - LINK_TTL_SECONDS, ...(channel ? [channel] : []));
  if (rows.length) markLinksSeen(session, rows.at(-1).id, channel ? [channel] : null);
  markShown(rows.map((r) => r.id));

  return rows.map(rowToEntry);
}

module.exports = { dbFile, sessionId, addMessage, link, isFollowed, unread, recent, takeMine, close };
