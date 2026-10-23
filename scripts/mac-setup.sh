#!/bin/bash
# One-time setup of the Creature Show on a Mac (Apple silicon recommended).
# Needs Node.js 22+ (https://nodejs.org) and Ollama (https://ollama.com) installed first.
# Usage, from the project folder:  bash scripts/mac-setup.sh
set -e
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "Node.js is not installed: get it from https://nodejs.org (LTS), then run this again."; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node.js 22 or newer is needed (you have $(node -v))."; exit 1; }

echo "Installing the show's packages (the Mac builds of the voice and AI libraries come with them)..."
npm install

if command -v ollama >/dev/null; then
  # The same local model as on the PC (about 6 GB). Ollama uses the Mac's GPU (Metal) itself.
  echo "Downloading the local AI model qwen3.5:9b (about 6 GB, once)..."
  ollama pull qwen3.5:9b
else
  echo "Ollama is not installed: get it from https://ollama.com, then run:  ollama pull qwen3.5:9b"
fi

echo
echo "Done. Start the show with:  npm start"
echo "Then open http://localhost:3000 (setup page) and http://localhost:3000/stream (stream window)."
