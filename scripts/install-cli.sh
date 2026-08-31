#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 18.17 or newer is required." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm 10 is required. Install it, then run this script again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required to create the global CLI link." >&2
  exit 1
fi

cd "${repo_root}"

echo "Installing Trellis Lite dependencies..."
pnpm install --frozen-lockfile

echo "Building trellis-lite-core and trellis-lite..."
pnpm build

echo "Linking only the trellis-lite and tll commands..."
(
  cd packages/cli
  npm link
)

echo
echo "Trellis Lite CLI installed."
echo "  trellis-lite --version"
echo "  tll --version"
echo
echo "The official trellis and tl commands were not modified."
