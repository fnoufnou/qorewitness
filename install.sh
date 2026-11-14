#!/usr/bin/env bash
# QoreWitness installer for Linux with Docker (Debian, Ubuntu, Raspberry Pi OS 64-bit).
#   curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/main/install.sh | bash
# Testnet only, early alpha. It installs into ~/qorewitness and asks a few questions.
set -euo pipefail
REPO="${QW_REPO:-https://github.com/fnoufnou/qorewitness.git}"
REF="${QW_REF:-main}"
DIR="${QW_DIR:-$HOME/qorewitness}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2"; exit 1; }; }

say "QoreWitness installer (QoreChain testnet, early alpha)"
need git "Install it with: sudo apt install git"
need docker "Install Docker first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || { echo "Missing: docker compose plugin. https://docs.docker.com/compose/install/linux/"; exit 1; }
SUDO=""; docker info >/dev/null 2>&1 || SUDO="sudo"

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" fetch -q --depth 1 origin "$REF" && git -C "$DIR" checkout -q FETCH_HEAD
else
  say "Downloading to $DIR"
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
fi
cd "$DIR"
mkdir -p data
# The containers run as uid 10001. Only that user may read the keys in ./data.
$SUDO chown 10001 data && chmod 700 data

say "Building the image (a few minutes the first time)"
$SUDO docker compose build --build-arg QW_COMMIT="$(git rev-parse HEAD)"

say "Setup: camera, account, keys"
$SUDO docker compose run --rm agent setup </dev/tty

say "Starting recorder and agent"
$SUDO docker compose up -d
echo
echo "Done. Logs:      cd $DIR && docker compose logs -f agent"
echo "Receipts:        $DIR/data/<camera>/receipts (one per 10 minutes)"
echo "Verify a clip:   https://qorewitness.fnoufnou.com (browser verifier)"
echo "Back up $DIR/data/qorewitness.env and $DIR/data/keys/. They hold your testnet keys."
