#!/bin/bash
# Push the GEE inspector apps from gee_app/ into the user's Earth Engine
# Code Editor scripts repo (earthengine.googlesource.com), where they appear
# under Scripts -> Owner -> cropint/. Requires the one-time googlesource
# credential in ~/.gitcookies (regenerate at https://www.googlesource.com/new-password).
set -euo pipefail

REPO_URL="https://earthengine.googlesource.com/users/akhil_rajsias24/year_24"
CACHE="$HOME/.gee-scripts-repo"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$CACHE/.git" ]; then
  git clone -q "$REPO_URL" "$CACHE"
fi

cd "$CACHE"
git pull -q --rebase origin master
mkdir -p cropint
cp "$PROJECT_DIR/gee_app/karnataka_intensity_inspector_v3.js" cropint/karnataka_inspector_v3
cp "$PROJECT_DIR/gee_app/karnataka_intensity_inspector_v2.js" cropint/karnataka_inspector_v2

if git diff --quiet && git diff --cached --quiet; then
  echo "No changes to push."
  exit 0
fi

git add cropint/
git -c user.name="Akhil Raj" -c user.email="akhil_raj.sias24@krea.ac.in" \
  commit -q -m "Update cropint inspector apps ($(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo local))"
git push -q origin master
echo "Pushed. Refresh the Code Editor to see Scripts -> Owner -> cropint/."
