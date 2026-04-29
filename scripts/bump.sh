#!/bin/bash
# Bump patch version, build, commit, push. cli.ts reads version from package.json at runtime.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# Bump patch in package.json
OLD=$(node -p "require('./package.json').version")
IFS='.' read -r major minor patch <<< "$OLD"
NEW="$major.$minor.$((patch + 1))"
sed -i '' "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" package.json

# Build
npm run build

# Commit and push
git add package.json
git commit -m "Bump to $NEW"
git push origin main

echo "v$NEW shipped"
