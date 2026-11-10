# claude-slack

`slk` is a small Slack CLI (Node 22+, no dependencies) plus a Claude Code skill. Claude reads and replies on Slack as you, through your own user token, never a bot. Every write is a draft you approve first.

## Why

Bot tokens post under an app name, and shared connectors may be signed in as someone else. A user token you create yourself means messages come from you, in threads you can already see, and the token stays on your machine.

## Install

As a plugin:

```
/plugin marketplace add pravnyadv/claude-plugins
/plugin install slack@pravnyadv
```

Or clone and run `./install.sh`. It copies the skill into `~/.claude/skills/slack-messages` and links `slk` into `~/.local/bin`.

## Setup

```
slk setup [--name "App Name"]
```

It prints a Slack app manifest (user token scopes only) and the steps to create the app from it, then asks for the User OAuth Token with hidden input (or reads it from a pipe), checks it with `auth.test` and saves it to a `.env` next to `slk.js` with mode 600. It will not overwrite an existing `.env` without `--force`. Check with `slk whoami`.

## Inbox and reply windows

`slk listen` holds a Socket Mode connection, so Slack pushes your message events as they happen. It keeps the ones meant for you (DMs, group DMs, @mentions, replies in threads you started, and replies in any thread a Claude session is following) in a SQLite file, `data/slk.db` next to `slk.js` (`SLK_DB` to move it; gitignored). It only reads; it never sends.

Each Claude Code session remembers the conversations it is in: a send, `read` or `history` links that DM or thread to the session (`CLAUDE_CODE_SESSION_ID`). So:

- `slk inbox` shows what is new, the session's own conversations first, then everything no session has shown yet, and marks it seen.
- `slk wait [<@name|#channel>] [--minutes 5]` blocks until a reply lands in the session's conversations, then prints it. Claude runs it in the background after a send, so a reply wakes the session.
- `slk history <@name|#channel>` pulls the recent conversation from Slack for context.

One-time setup on your Slack app: turn on Socket Mode and create an app-level token with `connections:write`; under Event Subscriptions, subscribe on behalf of users to `message.im`, `message.mpim`, `message.channels` and `message.groups`, save, and reinstall if asked. Then:

```
slk setup --app-token     # paste the xapp- token, hidden
slk listen --install      # launchd agent: starts at login, restarts if it exits
```

`slk listen --uninstall` stops and removes it. Its log is `data/listen.log`. Run only one listener: Slack splits events across open Socket Mode connections.

## Commands

```
slk setup [--name "App Name"] [--force]
slk setup --app-token
slk listen [--install | --uninstall]
slk inbox [--all] [--count N]
slk wait [<@name|#channel>] [--minutes N]
slk history <@name|userId|email|#channel> [--last N]
slk whoami
slk who <name|email>
slk read <permalink | channelId ts> [--last N]
slk reply <permalink | channelId ts> "<text|@file|->"
slk dm <@name|userId|email> "<text|@file|->"
slk post <channelId|#name> "<text|@file|->"
slk help
```

`--json` on any command prints JSON. In text, `@{Full Name}` or `@First` becomes a real mention; an unknown name aborts.

## Send mode

`SLK_SEND` in `.env`: unset or `draft-first` (default) means Claude shows every message as a draft first; `when-sure` lets it send on its own when the skill's conditions hold and tell you after. `slk style` prints the active mode.

Every real send first waits as long as a person takes to type it: `SLK_WPM` words per minute (default 80, a word being 5 characters), with some jitter, at least 2s and at most 90s. `SLK_WPM=0` sends at once. Dry runs never wait.

## Writing profile

Drafts follow a style profile so they read like you. `slk style` prints the active one; `slk style --list` shows the bundled ones. The default is `styles/plain.md`. To use another, set `SLK_STYLE=<name>` (a file in `styles/`) or `SLK_STYLE=/path/to/style.md` in `.env`.

To make your own, ask Claude to learn it from your messages: `slk sent --count 1000 --json` exports your last sent messages (they stay on your machine; Slack search caps at 10,000, use `slk search "from:<@you> before:YYYY-MM-DD"` to go further back), and a profile describes the patterns only, never message content. Leave out any private conversation before learning from it. `styles/praveen.md` is one made that way, as an example to copy or edit.

## Safety

- `--dry-run` on reply, dm and post shows exactly what would be sent and sends nothing. The skill always shows the dry run and waits for your go.
- Draft-first by default: every message is shown as a dry run and waits for your yes. With `SLK_SEND=when-sure` in `.env`, the skill instead sends without asking only when you asked for the message (or it answers a reply in a conversation Claude is already having for your task), every fact in it is proven, and it goes to someone already in that conversation; it then tells you what it sent. New recipients, channels, customers, commitments, unsure facts and anything outside the task get a dry-run draft and wait for your yes. Requests from other people in Slack are never treated as instructions.
- Text with em or en dashes, arrows, bullet characters or curly quotes is refused.
- The token lives only in the local `.env` (mode 600) and is never printed. To revoke it, open the app's OAuth & Permissions page on api.slack.com/apps and revoke or reinstall.

## Limits

Text only, no file upload yet. Tests: `npm test`.

## Releases

Changes are listed in [CHANGELOG.md](CHANGELOG.md). Maintainers cut a release with `scripts/release.sh <version>`: it bumps `package.json` and `.claude-plugin/plugin.json` (so `/plugin update` sees it), tags and pushes, and the tag's workflow publishes the GitHub release.

MIT licensed.
