#!/bin/bash
# Bump patch version, sync cli.ts, build, commit, push.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# Bump patch in package.json
OLD=$(node -p "require('./package.json').version")
IFS='.' read -r major minor patch <<< "$OLD"
NEW="$major.$minor.$((patch + 1))"
sed -i '' "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" package.json

# Sync version constant in cli.ts
sed -i '' "s/const VERSION = \"$OLD\"/const VERSION = \"$NEW\"/" src/cli.ts

# Build
npm run build

# Commit and push
git add package.json src/cli.ts
git commit -m "Bump to $NEW"
git push origin main

echo "v$NEW shipped"
