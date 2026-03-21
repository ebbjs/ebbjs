#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$SCRIPT_DIR/package-template"
PACKAGES_DIR="$ROOT_DIR/packages"

if [ -z "$1" ]; then
  echo "Usage: $0 <package-name>"
  echo "Example: $0 my-package"
  exit 1
fi

NAME="$1"

if [[ ! "$NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "Error: Package name must be kebab-case (e.g., 'my-package')"
  exit 1
fi

if [[ "$NAME" =~ ^- || "$NAME" =~ -$ ]]; then
  echo "Error: Package name cannot start or end with a hyphen"
  exit 1
fi

if [ -d "$PACKAGES_DIR/$NAME" ]; then
  echo "Error: Package '$NAME' already exists at packages/$NAME"
  exit 1
fi

echo "Creating package '@zuko/$NAME'..."

mkdir -p "$PACKAGES_DIR/$NAME/src"

cp "$TEMPLATES_DIR/package.json" "$PACKAGES_DIR/$NAME/"
cp "$TEMPLATES_DIR/tsconfig.json" "$PACKAGES_DIR/$NAME/"
cp "$TEMPLATES_DIR/vite.config.ts" "$PACKAGES_DIR/$NAME/"
cp "$TEMPLATES_DIR/vitest.config.ts" "$PACKAGES_DIR/$NAME/"
cp "$TEMPLATES_DIR/README.md" "$PACKAGES_DIR/$NAME/"
cp "$TEMPLATES_DIR/src/index.ts" "$PACKAGES_DIR/$NAME/src/"

node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PACKAGES_DIR/$NAME/package.json', 'utf8'));
  const content = fs.readFileSync('$PACKAGES_DIR/$NAME/vite.config.ts', 'utf8');
  const updated = content.replace(/{{name}}/g, '$NAME');
  fs.writeFileSync('$PACKAGES_DIR/$NAME/vite.config.ts', updated);
"

ROOT_PACKAGE_JSON="$ROOT_DIR/package.json"

if grep -q "\"$NAME\":" "$ROOT_PACKAGE_JSON"; then
  echo "Scripts already exist for '$NAME' in root package.json"
else
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$ROOT_PACKAGE_JSON', 'utf8'));
    pkg.scripts['dev:$NAME'] = 'pnpm --filter @zuko/$NAME dev';
    pkg.scripts['$NAME'] = 'pnpm --filter @zuko/$NAME';
    fs.writeFileSync('$ROOT_PACKAGE_JSON', JSON.stringify(pkg, null, 2) + '\n');
  "
fi

echo "Done! Created packages/$NAME with npm script aliases:"
echo "  pnpm dev:$NAME"
echo "  pnpm $NAME"
