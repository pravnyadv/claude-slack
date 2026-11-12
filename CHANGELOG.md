# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project follows semantic versioning.
Release with `scripts/release.sh <version>`: it moves Unreleased under the new version.

## [Unreleased]

## [0.6.1] - 2026-11-12

### Changed
- The app manifest asks for `files:read`, so attachments on a message (images, PDFs) can be downloaded. Existing installs: add the scope under OAuth & Permissions and reinstall the app.

## [0.6.0] - 2026-11-10

### Added
- Human typing pause: every real send first waits as long as typing it takes at `SLK_WPM` words per
  minute (default 80, 5 characters a word, 10% jitter, 2s to 90s). `SLK_WPM=0` sends at once; dry
  runs never wait.

### Changed
- The plugin is now `slack@pravnyadv` (was `slack-messages@pravnyadv`) and the repo is `claude-slack`.
  Reinstall with `/plugin install slack@pravnyadv`.
- `styles/praveen.md` gets a length budget (a live-chat reply is at most 25 words, longer content
  goes as two or three short messages) with before and after examples; the skill cuts every draft
  to the budget before sending.

## [0.5.0] - 2026-11-05

### Added
- `slk listen`: a Socket Mode listener that receives your DMs, group DMs, @mentions and replies in
  your threads as they happen and keeps them in `data/slk.db` (node:sqlite, no dependency). It only
  reads. `listen --install` / `--uninstall` run it as a launchd agent; `setup --app-token` saves the
  `xapp-` token it needs.
- `slk inbox`: what is new for you, grouped by conversation, the current Claude session's own
  conversations first; `--all --count N` re-shows recent ones.
- `slk wait [<@name|#channel>] [--minutes N]`: blocks until a reply lands in the session's
  conversations. Sends, `read` and `history` link a conversation to the session
  (`CLAUDE_CODE_SESSION_ID`), and replies in a thread a session follows are kept without a mention.
- `slk history <@name|#channel> [--last N]`: the recent conversation, oldest first.
- Send mode `SLK_SEND=when-sure`: the skill may send without a draft when you asked for the message,
  every fact is proven and it goes to people already in the conversation. The default stays draft-first.
- `SLK_DEBUG=1` logs every event the listener receives.

### Fixed
- Piped stdin (`setup` reading a token) is read asynchronously; a synchronous read of a pipe could
  fail with EAGAIN.

## [0.4.0] - 2026-11-05

### Added
- `slk` CLI (setup, whoami, who, read, reply, dm, post, search, sent, style) and the
  `slack-messages` skill: read and reply on Slack as yourself with your own user token, draft-first.
- `read --last N`, short timestamps and compact JSON to cut token use.
