#!/bin/bash
#
# Warn (but don't block) when the current branch name doesn't match
# the convention in CONTRIBUTING.md:
#
#   <type>/<description>          — e.g. fix/reconnect-backoff
#   <type>/<description>-issue-N  — e.g. fix/reconnect-backoff-issue-40
#
# Always exits 0 (pre-push should not block). Lefthook reports the warning.
#
set -e

branch=$(git branch --show-current)

# main and master are exempt.
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  exit 0
fi

# Pattern: <type>/<slug>[ -]<something>...
# - type: lowercase letters only
# - slug: kebab-case, may be a free description or start with `issue-N`
if echo "$branch" | grep -qE '^(feat|fix|chore|docs|refactor|test|perf|ci|build|style|debug|prototype)/[a-z0-9][a-z0-9-]*$'; then
  exit 0
fi

cat >&2 <<EOF
⚠  Branch name "$branch" doesn't match the convention in CONTRIBUTING.md.

  Expected: <type>/<description>           e.g. fix/reconnect-backoff
             <type>/issue-<N>-<description>  e.g. fix/issue-40-reconnect-backoff

  This is a warning, not an error — push will proceed.
EOF

exit 0
