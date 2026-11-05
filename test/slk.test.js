const test = require('node:test');
const assert = require('node:assert');
process.env.SLACK_USER_TOKEN = 'xoxp-test';
const { SlackApiError, api, parseTarget, checkStyle, expandMentions } = require('../lib/slack');
const { main } = require('../slk');
const fs = require('fs');
const os = require('os');
const path = require('path');

const res = (body, status = 200, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body });
const mockFetch = (handler) => {
  const calls = [];
  global.fetch = async (url, opts) => {
    const method = url.split('/api/')[1];
    calls.push({ method, opts });
    return handler(method, opts, calls.length);
  };
  return calls;
};

test('permalink root and thread reply', () => {
  assert.deepStrictEqual(parseTarget(['https://example.slack.com/archives/C0123ABC/p1730000000123456']),
    { channel: 'C0123ABC', ts: '1730000000.123456', threadTs: '1730000000.123456' });
  const r = parseTarget(['https://example.slack.com/archives/C0123ABC/p1730000500123456?thread_ts=1730000000.123456&cid=C0123ABC']);
  assert.strictEqual(r.ts, '1730000500.123456');
  assert.strictEqual(r.threadTs, '1730000000.123456');
  assert.strictEqual(parseTarget(['C0123ABC', '1730000000.123456']).channel, 'C0123ABC');
});

test('writing rules refuse banned characters', () => {
  for (const [s, what] of [['a — b', 'em or en dash'], ['a – b', 'dash'], ['go → there', 'arrow'], ['• item', 'bullet'], ['it’s', 'curly quote']]) {
    assert.throws(() => checkStyle(s), new RegExp(what));
  }
  assert.doesNotThrow(() => checkStyle('plain text, 10-11 July'));
});

test('mentions convert known names and abort on unknown', async () => {
  const resolve = async (n) => {
    if (n === 'Jane Doe' || n === 'Sam') return n === 'Sam' ? 'U2' : 'U1';
    throw new Error(`No Slack user found for "${n}".`);
  };
  assert.strictEqual(await expandMentions('hi @{Jane Doe} and @Sam, ok', resolve), 'hi <@U1> and <@U2>, ok');
  await assert.rejects(expandMentions('hi @Nobody', resolve), /No Slack user/);
});

test('dry-run sends nothing', async () => {
  const calls = mockFetch(async (m) => res({ ok: true, user: { id: 'U9', name: 'bob', real_name: 'Bob' }, members: [] }));
  const log = console.log;
  console.log = () => {};
  try {
    await main(['reply', 'https://x.slack.com/archives/C1ABC/p1730000000123456', 'hello', '--dry-run']);
    await main(['post', 'C1ABC', 'hello', '--dry-run']);
    await main(['dm', 'U1234567', 'hello', '--dry-run']);
  } finally { console.log = log; }
  assert.strictEqual(calls.filter((c) => c.method.startsWith('chat.') || c.method === 'conversations.open').length, 0);
});

test('write refuses style before any network call', async () => {
  const calls = mockFetch(async () => res({ ok: true }));
  await assert.rejects(main(['post', 'C1ABC', 'a — b']), /em or en dash/);
  assert.strictEqual(calls.length, 0);
});

test('429 waits and retries once', async () => {
  const calls = mockFetch(async (m, o, n) => (n === 1 ? res({}, 429, { 'retry-after': '0' }) : res({ ok: true, user: 'p' })));
  assert.strictEqual((await api('auth.test')).user, 'p');
  assert.strictEqual(calls.length, 2);
});

test('ok:false raises SlackApiError', async () => {
  mockFetch(async () => res({ ok: false, error: 'channel_not_found' }));
  await assert.rejects(api('conversations.replies'), (e) => e instanceof SlackApiError && e.code === 'channel_not_found' && e.name === 'SlackApiError');
});

test('setup validates, saves a 600 env file, refuses overwrite, never prints the token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-'));
  const file = path.join(dir, '.env');
  process.env.SLK_ENV_FILE = file;
  const calls = mockFetch(async () => res({ ok: true, user: 'jane', team: 'Acme' }));
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  const stdin = fs.readFileSync;
  fs.readFileSync = (p, ...r) => (p === 0 ? 'xoxp-secret-1\n' : stdin(p, ...r));
  try {
    await main(['setup', '--name', 'My App']);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'SLACK_USER_TOKEN=xoxp-secret-1\n');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(calls[0].method, 'auth.test');
    assert.ok(calls[0].opts.headers.Authorization.endsWith('xoxp-secret-1'));
    assert.ok(lines.join('\n').includes('"name": "My App"'));
    assert.ok(!lines.join('\n').includes('xoxp-secret-1'));
    await assert.rejects(main(['setup']), /already exists/);
    fs.readFileSync = (p, ...r) => (p === 0 ? 'xoxb-bot' : stdin(p, ...r));
    await assert.rejects(main(['setup', '--force']), /xoxp-/);
  } finally {
    fs.readFileSync = stdin;
    console.log = log;
    delete process.env.SLK_ENV_FILE;
    fs.rmSync(dir, { recursive: true });
  }
});

test('style profile: default plain, a name in styles/, or a path', () => {
  const { stylePath, ROOT } = require('../lib/slack');
  delete process.env.SLK_STYLE;
  const saved = process.env.SLK_ENV_FILE;
  process.env.SLK_ENV_FILE = path.join(os.tmpdir(), 'slk-none.env');
  assert.strictEqual(stylePath(), path.join(ROOT, 'styles', 'plain.md'));
  process.env.SLK_STYLE = 'someone';
  assert.strictEqual(stylePath(), path.join(ROOT, 'styles', 'someone.md'));
  process.env.SLK_STYLE = '/tmp/mine.md';
  assert.strictEqual(stylePath(), '/tmp/mine.md');
  delete process.env.SLK_STYLE;
  if (saved) process.env.SLK_ENV_FILE = saved; else delete process.env.SLK_ENV_FILE;
  assert.ok(fs.existsSync(path.join(ROOT, 'styles', 'plain.md')));
});

test('sent pages search.messages newest first and stops at count', async () => {
  const match = (i) => ({ ts: `${1700000000 + i}.000100`, text: `m${i}`, channel: { is_im: true }, permalink: 'p' });
  const calls = mockFetch(async (m, o) => {
    if (m === 'auth.test') return res({ ok: true, user_id: 'U1' });
    const page = Number(new URLSearchParams(o.body).get('page'));
    return res({ ok: true, messages: { matches: Array.from({ length: 100 }, (_, i) => match(page * 100 + i)), paging: { pages: 5 } } });
  });
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try { await main(['sent', '--count', '150', '--json']); } finally { console.log = orig; }
  const rows = JSON.parse(logs[0]);
  assert.strictEqual(rows.length, 150);
  const searches = calls.filter((c) => c.method === 'search.messages');
  assert.strictEqual(searches.length, 2);
  assert.match(new URLSearchParams(searches[0].opts.body).get('query'), /from:<@U1>/);
});

test('read --last keeps the root and the last N replies, in short time format', async () => {
  const msg = (i) => ({ ts: `${1700000000 + i * 60}.000100`, user: 'U1', text: `m${i}` });
  mockFetch(async (m) => res(m === 'users.info'
    ? { ok: true, user: { profile: { display_name: 'Ann' } } }
    : { ok: true, messages: Array.from({ length: 6 }, (_, i) => msg(i)) }));
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    await main(['read', 'C0123ABC', '1700000000.000100', '--last', '2']);
    await main(['read', 'C0123ABC', '1700000000.000100', '--last', '2', '--json']);
  } finally { console.log = orig; }
  const lines = logs[0].split('\n');
  assert.deepStrictEqual(lines.map((l) => l.replace(/^\[[^\]]+\] /, '')), ['Ann: m0', '(3 earlier replies hidden)', 'Ann: m4', 'Ann: m5']);
  assert.match(lines[0], /^\[\d{2} [A-Z][a-z]+ \d{2}:\d{2}\] /);
  assert.ok(!logs[1].includes('\n'), 'JSON output is compact');
  assert.deepStrictEqual(JSON.parse(logs[1]).map((r) => r.text), ['m0', 'm4', 'm5']);
});

const listener = require('../lib/listen');

test('reason keeps DMs, group DMs, mentions and replies in my threads, never my own or edits', () => {
  const me = 'UME';
  const cases = [
    [{ type: 'message', user: 'U1', channel_type: 'im', text: 'hi' }, 'dm'],
    [{ type: 'message', user: 'U1', channel_type: 'mpim', text: 'hi' }, 'group'],
    [{ type: 'message', user: 'U1', channel_type: 'channel', text: 'ping <@UME>' }, 'mention'],
    [{ type: 'message', user: 'U1', channel_type: 'channel', text: 'ok', thread_ts: '1.1', parent_user_id: 'UME' }, 'thread'],
    [{ type: 'message', user: 'U1', channel_type: 'channel', text: 'chatter' }, null],
    [{ type: 'message', user: 'UME', channel_type: 'im', text: 'mine' }, null],
    [{ type: 'message', subtype: 'message_changed', channel_type: 'im' }, null],
    [{ type: 'message', subtype: 'bot_message', bot_id: 'B1', channel_type: 'im', text: 'bot' }, null],
    [{ type: 'message', subtype: 'file_share', user: 'U1', channel_type: 'im', text: '' }, 'dm'],
    [{ type: 'reaction_added', user: 'U1' }, null],
  ];
  for (const [event, want] of cases) assert.strictEqual(listener.reason(event, me), want, JSON.stringify(event));
});

test('session acks every envelope, passes only events for me, and ends on disconnect', async () => {
  const sent = [];
  let sock;
  global.WebSocket = class { constructor(url) { this.url = url; sock = this; } send(d) { sent.push(JSON.parse(d)); } close() { this.onclose(); } };
  const got = [];
  const done = listener.session('wss://x', 'UME', (e, why) => got.push([e.ts, why]), () => {});
  const push = (m) => sock.onmessage({ data: JSON.stringify(m) });
  push({ type: 'hello' });
  push({ type: 'events_api', envelope_id: 'e1', payload: { event: { type: 'message', user: 'U1', channel_type: 'im', ts: '1.0', text: 'hi' } } });
  push({ type: 'events_api', envelope_id: 'e2', payload: { event: { type: 'message', user: 'U1', channel_type: 'channel', ts: '2.0', text: 'noise' } } });
  push({ type: 'disconnect', reason: 'refresh_requested' });
  await done;
  assert.deepStrictEqual(sent, [{ envelope_id: 'e1' }, { envelope_id: 'e2' }]);
  assert.deepStrictEqual(got, [['1.0', 'dm']]);
});

test('inbox shows only what arrived since the last check, across calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-inbox-'));
  process.env.SLK_INBOX = path.join(dir, 'inbox.jsonl');
  const add = (ts) => fs.appendFileSync(process.env.SLK_INBOX, `${JSON.stringify({ ts, text: `m${ts}` })}\n`);
  try {
    assert.deepStrictEqual(listener.unread(), []);
    add('1'); add('2');
    assert.deepStrictEqual(listener.unread().map((r) => r.ts), ['1', '2']);
    assert.deepStrictEqual(listener.unread(), []);
    add('3');
    assert.deepStrictEqual(listener.unread().map((r) => r.ts), ['3']);
    assert.strictEqual(listener.readInbox().length, 3);
  } finally {
    delete process.env.SLK_INBOX;
    fs.rmSync(dir, { recursive: true });
  }
});

test('launchd plist runs this checkout\'s listen with no extra flags', () => {
  const xml = listener.plist();
  assert.match(xml, /<string>com\.slk\.listen<\/string>/);
  assert.match(xml, /slk\.js<\/string><string>listen<\/string><\/array>/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
});

test('inbox groups new messages by conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-inbox-'));
  process.env.SLK_INBOX = path.join(dir, 'inbox.jsonl');
  const add = (e) => fs.appendFileSync(process.env.SLK_INBOX, `${JSON.stringify(e)}\n`);
  add({ ts: '1', time: 't1', channel: 'D1', where: 'dm', from: 'Sam', why: 'dm', text: 'a', permalink: 'p1' });
  add({ ts: '2', time: 't2', channel: 'C1', where: '#dev', from: 'Ann', why: 'mention', text: 'b', permalink: 'p2' });
  add({ ts: '3', time: 't3', channel: 'D1', where: 'dm', from: 'Sam', why: 'dm', text: 'c', permalink: 'p3' });
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    await main(['inbox', '--json']);
  } finally {
    console.log = orig;
    delete process.env.SLK_INBOX;
    fs.rmSync(dir, { recursive: true });
  }
  const groups = JSON.parse(logs[0]);
  assert.deepStrictEqual(groups.map((g) => [g.where, g.entries.map((e) => e.ts)]), [['dm with Sam', ['1', '3']], ['#dev', ['2']]]);
});

test('history of a person opens their DM and prints oldest first', async () => {
  const calls = mockFetch((method) => res({
    'conversations.open': { ok: true, channel: { id: 'D9' } },
    'conversations.history': { ok: true, messages: [{ ts: '2.0', user: 'UHIST1', text: 'second' }, { ts: '1.0', user: 'UHIST1', text: 'first', reply_count: 2 }] },
    'users.info': { ok: true, user: { profile: { display_name: 'Sam' } } },
  }[method]));
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    await main(['history', 'U1ABCDEFG', '--last', '5']);
  } finally {
    console.log = orig;
  }
  assert.deepStrictEqual(calls.map((c) => c.method).filter((m) => m !== 'users.info'), ['conversations.open', 'conversations.history']);
  assert.match(logs[0], /Sam: first \(2 replies, slk read D9 1\.0\)\n.*Sam: second/);
});

test('session closes a silent socket so listen reconnects, and skips unreadable frames', async () => {
  let sock;
  global.WebSocket = class { constructor() { sock = this; } send() {} close() { this.onclose(); } };
  const logs = [];
  const done = listener.session('wss://x', 'UME', () => {}, (m) => logs.push(m), 20);
  sock.onmessage({ data: 'not json' });
  await done;
  assert.deepStrictEqual(logs, ['unreadable frame skipped', 'no frames, reconnecting']);
});

test('a truncated inbox line is skipped, not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-inbox-'));
  process.env.SLK_INBOX = path.join(dir, 'inbox.jsonl');
  try {
    fs.writeFileSync(process.env.SLK_INBOX, `${JSON.stringify({ ts: '1' })}\n{"ts":"2","te\n`);
    assert.deepStrictEqual(listener.readInbox().map((r) => r.ts), ['1']);
  } finally {
    delete process.env.SLK_INBOX;
    fs.rmSync(dir, { recursive: true });
  }
});
