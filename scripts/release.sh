#!/usr/bin/env bash
# Cut a release: scripts/release.sh 0.6.0
# Moves CHANGELOG's Unreleased section under the version, bumps package.json and plugin.json
# (plugin installs see the new version), runs the tests, commits, tags and pushes. The tag
# push runs .github/workflows/release.yml, which creates the GitHub release from the changelog.
set -euo pipefail
cd "$(dirname "$0")/.."

v="${1:?usage: scripts/release.sh <version>}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z" >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "release from main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$v" >/dev/null && { echo "v$v already exists" >&2; exit 1; }
awk '/^## \[Unreleased\]/ {on=1; next} /^## \[/ {on=0} on && NF' CHANGELOG.md | grep -q . \
  || { echo "CHANGELOG.md has nothing under Unreleased" >&2; exit 1; }

node -e '
const fs = require("fs"); const v = process.argv[1];
for (const f of ["package.json", ".claude-plugin/plugin.json"]) {
  const j = JSON.parse(fs.readFileSync(f, "utf8")); j.version = v;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}
const c = fs.readFileSync("CHANGELOG.md", "utf8");
fs.writeFileSync("CHANGELOG.md", c.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${v}] - ${new Date().toISOString().slice(0, 10)}\n`));
' "$v"

npm test
git add package.json .claude-plugin/plugin.json CHANGELOG.md
git commit -m "release v$v"
git tag -a "v$v" -m "v$v"
git push origin main "v$v"
echo "pushed v$v; the Release workflow creates the GitHub release"
