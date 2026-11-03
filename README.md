# slack-claude

`slk` is a small Slack CLI (Node 22+, no dependencies) plus a Claude Code skill. Claude reads and replies on Slack as you, through your own user token, never a bot. Every write is a draft you approve first.

## Why

Bot tokens post under an app name, and shared connectors may be signed in as someone else. A user token you create yourself means messages come from you, in threads you can already see, and the token stays on your machine.

## Install

As a plugin:

```
/plugin marketplace add pravnyadv/claude-plugins
/plugin install slack-messages@pravnyadv
```

Or clone and run `./install.sh`. It copies the skill into `~/.claude/skills/slack-messages` and links `slk` into `~/.local/bin`.

## Setup

```
slk setup [--name "App Name"]
```

It prints a Slack app manifest (user token scopes only) and the steps to create the app from it, then asks for the User OAuth Token with hidden input (or reads it from a pipe), checks it with `auth.test` and saves it to a `.env` next to `slk.js` with mode 600. It will not overwrite an existing `.env` without `--force`. Check with `slk whoami`.

## Commands

```
slk setup [--name "App Name"] [--force]
slk whoami
slk who <name|email>
slk read <permalink | channelId ts>
slk reply <permalink | channelId ts> "<text|@file|->"
slk dm <@name|userId|email> "<text|@file|->"
slk post <channelId|#name> "<text|@file|->"
slk help
```

`--json` on any command prints JSON. In text, `@{Full Name}` or `@First` becomes a real mention; an unknown name aborts.

## Writing profile

Drafts follow a style profile so they read like you. `slk style` prints the active one; `slk style --list` shows the bundled ones. The default is `styles/plain.md`. To use another, set `SLK_STYLE=<name>` (a file in `styles/`) or `SLK_STYLE=/path/to/style.md` in `.env`.

To make your own, ask Claude to learn it from your messages: `slk sent --count 1000 --json` exports your last sent messages (they stay on your machine; Slack search caps at 10,000, use `slk search "from:<@you> before:YYYY-MM-DD"` to go further back), and a profile describes the patterns only, never message content. Leave out any private conversation before learning from it. `styles/praveen.md` is one made that way, as an example to copy or edit.

## Safety

- `--dry-run` on reply, dm and post shows exactly what would be sent and sends nothing. The skill always shows the dry run and waits for your go.
- Claude never replies on its own. Every message needs your go for that exact text, each time; a go for one message never covers the next, and nothing is sent automatically or in a loop.
- Text with em or en dashes, arrows, bullet characters or curly quotes is refused.
- The token lives only in the local `.env` (mode 600) and is never printed. To revoke it, open the app's OAuth & Permissions page on api.slack.com/apps and revoke or reinstall.

## Limits

Text only, no file upload yet. Tests: `npm test`.

MIT licensed.
