#!/usr/bin/env bash
# Install slk and its skill from a cloned checkout (the non-plugin route).
# Copies the skill into ~/.claude/skills with the bundled-CLI path rewritten to this clone,
# and symlinks slk.js into ~/.local/bin.
set -euo pipefail

CLONE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/skills/slack-messages"

# An older install may have left a symlink here; remove it so we never write through it.
[ -L "$DEST" ] && rm "$DEST"
mkdir -p "$DEST" "$HOME/.local/bin"
sed "s|\$CLAUDE_PLUGIN_ROOT|$CLONE_DIR|g" "$CLONE_DIR/skills/slack-messages/SKILL.md" > "$DEST/SKILL.md"
chmod +x "$CLONE_DIR/slk.js"
ln -sfn "$CLONE_DIR/slk.js" "$HOME/.local/bin/slk"

echo "skill -> $DEST"
echo "slk   -> $HOME/.local/bin/slk"
echo
echo "next: slk setup"
