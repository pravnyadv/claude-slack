/** Slack plumbing: the one HTTP owner (api), permalink parsing, the writing rules and mention expansion. */
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(fs.realpathSync(path.join(__dirname, '..', 'slk.js')));

class SlackApiError extends Error {
  constructor(method, code) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'SlackApiError';
    this.method = method;
    this.code = code;
  }
}

/** The .env path: SLK_ENV_FILE if set (tests), else next to slk.js. */
const envFile = () => process.env.SLK_ENV_FILE || path.join(ROOT, '.env');

/** A setting from the environment, else from the .env file, else null. */
function envValue(key) {
  if (process.env[key]) return process.env[key].trim();
  try {
    const m = fs.readFileSync(envFile(), 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
    if (m) return m[1].replace(/^["']|["']$/g, '');
  } catch { /* no .env yet */ }

  return null;
}

/** SLACK_USER_TOKEN from the environment or .env. Never logged. */
function getToken() {
  const token = envValue('SLACK_USER_TOKEN');
  if (!token) throw new Error('SLACK_USER_TOKEN is not set. Run: slk setup');

  return token;
}

/** The writing profile drafts follow: SLK_STYLE is a name in styles/ or a path to a .md file; default "plain". */
function stylePath() {
  const style = envValue('SLK_STYLE') || 'plain';

  return style.includes('/') || style.endsWith('.md') ? path.resolve(style) : path.join(ROOT, 'styles', `${style}.md`);
}

const JSON_METHODS = new Set(['chat.postMessage']);

/** Call a Slack Web API method. Retries once on HTTP 429 after Retry-After seconds. */
async function api(method, params = {}, retried = false, token = null) {
  const headers = { Authorization: `Bearer ${token || getToken()}` };
  let body;
  if (JSON_METHODS.has(method)) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(params);
  } else {
    body = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  }
  const res = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers, body });
  if (res.status === 429 && !retried) {
    await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 1) * 1000));
    return api(method, params, true, token);
  }
  const data = await res.json();
  if (!data.ok) throw new SlackApiError(method, data.error || `http_${res.status}`);
  return data;
}

/** Slack ts "1730000000.123456" from the p-form "p1730000000123456". */
const tsFromP = (p) => `${p.slice(0, -6)}.${p.slice(-6)}`;

/** `{channel, ts, threadTs}` from a permalink, or from a `channelId ts` pair. threadTs is the thread root. */
function parseTarget(args) {
  const [first, second] = args;
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{7,})/.exec(first || '');
  if (m) {
    const ts = tsFromP(`p${m[2]}`.slice(1));
    const t = /[?&]thread_ts=(\d+\.\d+)/.exec(first);
    return { channel: m[1], ts, threadTs: t ? t[1] : ts };
  }
  if (/^[CGD][A-Z0-9]+$/.test(first || '') && /^\d+\.\d+$/.test(second || '')) {
    return { channel: first, ts: second, threadTs: second };
  }
  throw new Error('Expected a Slack permalink or "<channelId> <ts>".');
}

const STYLE_RULES = [
  [/[—–]/, 'em or en dash'],
  [/[←-⇿]|(?:^|\s)(?:->|=>|<-)(?:\s|$)/, 'arrow'],
  [/[·•]/, 'middle dot or bullet character'],
  [/[‘’“”]/, 'curly quote'],
];

/** Throw naming each writing-rule violation (same rules as the monday CLI). */
function checkStyle(text) {
  const issues = [];
  for (const [re, what] of STYLE_RULES) {
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      issues.push(`${what} ${JSON.stringify(m[0].trim())}: "...${text.slice(Math.max(0, m.index - 20), m.index + 20).trim()}..."`);
    }
  }
  if (issues.length) throw new Error(`Writing rule violation, fix and retry:\n  ${issues.join('\n  ')}`);
}

const MENTION = /(^|[^\w.@\\/:<])@(?:\{([^}]+)\}|([A-Za-z][\w-]*))/g;

/** Replace `@{Full Name}` / `@First` with `<@USERID>` using `resolve(name) -> id`; throws on an unknown name. */
async function expandMentions(text, resolve) {
  const found = [...text.matchAll(MENTION)];
  let out = '';
  let last = 0;
  for (const m of found) {
    const id = await resolve(m[2] || m[3]);
    out += text.slice(last, m.index) + m[1] + `<@${id}>`;
    last = m.index + m[0].length;
  }

  return out + text.slice(last);
}

module.exports = { SlackApiError, api, getToken, envValue, stylePath, envFile, parseTarget, checkStyle, expandMentions, ROOT };
