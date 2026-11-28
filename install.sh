#!/usr/bin/env bash
# QoreWitness installer for Linux (Raspberry Pi OS 64-bit, Debian, Ubuntu).
#   curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/v0.6.0-beta.3/install.sh | bash
#
# It installs into ~/qorewitness, pulls the published image, starts QoreWitness and
# prints the dashboard address and the pairing code. Beta on the QoreChain test network.
# Run it again at any time: it keeps your camera, keys and account.
#
# From your own laptop, in one paste (find the IP address in your router app):
#   ssh -t USER@IP-ADDRESS "curl -fsSL https://raw.githubusercontent.com/fnoufnou/qorewitness/v0.6.0-beta.3/install.sh | bash -s -- --yes"
#
# Options:
#   --yes            accept the defaults without questions (installs Docker when it is missing)
#   --build          build the image from source instead of pulling it (needs git)
#   --terminal       old flow: setup questions in this terminal, no browser
#   --new-password   forget the dashboard password and show a new pairing code
#   --local-only     open the dashboard on this machine only (127.0.0.1)
# Env: QW_VERSION (image tag), QW_DIR (install folder), QW_UI_PORT (default 8080).

# Everything runs inside main, which bash reads completely before it starts. With
# "curl ... | bash" the script comes on stdin, and a command that reads stdin
# (docker compose up or run) would otherwise eat the rest of it: the address and
# the pairing code at the end were never printed (found on the test computer, 23 Nov).
main() {
set -euo pipefail

QW_VERSION="${QW_VERSION:-0.6.0-beta.3}"
REF="${QW_REF:-v$QW_VERSION}"
REPO="${QW_REPO:-https://github.com/fnoufnou/qorewitness.git}"
RAW="${QW_RAW:-https://raw.githubusercontent.com/fnoufnou/qorewitness/$REF}"
DIR="${QW_DIR:-$HOME/qorewitness}"
PORT="${QW_UI_PORT:-8080}"
YES=0; BUILD=0; TERMINAL=0; NEWPW=0; LOCAL=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --build) BUILD=1 ;;
    --terminal) TERMINAL=1 ;;
    --new-password) NEWPW=1 ;;
    --local-only) LOCAL=1 ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $a (see --help)"; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
ask() { # ask "question" -> 0 for yes. The default is yes (Enter). Reads the terminal, also when piped from curl.
  [ "$YES" = 1 ] && return 0
  [ -r /dev/tty ] || return 0
  local ans; printf '%s [Y/n] ' "$1" > /dev/tty; read -r ans < /dev/tty || return 0
  [[ ! "$ans" =~ ^[Nn] ]]
}

say "QoreWitness installer (beta on the QoreChain test network, free while we build out the service)"

# ---------------------------------------------------------------- system checks
[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux. See docs/INSTALL.md for other systems."
case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  armv7l|armv6l) die "This is a 32-bit system. Install Raspberry Pi OS Lite (64-bit) and run the installer again." ;;
  *) die "Unsupported processor $(uname -m). QoreWitness runs on 64-bit Intel, AMD or ARM." ;;
esac
command -v curl >/dev/null 2>&1 || die "Missing: curl. Install it with: sudo apt install curl"

SUDO=""
if [ "$(id -u)" != 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "Run this as root or install sudo."
  SUDO="sudo"
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Docker is not installed"
  echo "QoreWitness runs in Docker. The installer can install it with the official script of Docker (get.docker.com)."
  if ask "Install Docker now?"; then
    GETDOCKER="$(mktemp)"
    curl -fsSL https://get.docker.com -o "$GETDOCKER"
    $SUDO sh "$GETDOCKER" </dev/null
    rm -f "$GETDOCKER"
  else
    die "Install Docker first (https://docs.docker.com/engine/install/), or run the installer with --yes."
  fi
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="$SUDO docker"
$DOCKER compose version >/dev/null 2>&1 || die "Missing: the docker compose plugin. Install it: https://docs.docker.com/compose/install/linux/"

# ---------------------------------------------------------------- files
mkdir -p "$DIR"
cd "$DIR"
if [ "$BUILD" = 1 ]; then
  command -v git >/dev/null 2>&1 || die "--build needs git: sudo apt install git"
  if [ -d .git ]; then
    say "Updating the source in $DIR"
    git fetch -q --depth 1 origin "$REF" && git checkout -q FETCH_HEAD
  elif [ -z "$(ls -A . 2>/dev/null | grep -v -e '^data$' -e '^\.env$' -e '^SETUP-LINK.txt$' -e '^docker-compose.yml$' || true)" ]; then
    say "Downloading the source to $DIR"
    tmp="$(mktemp -d)"; git clone -q --depth 1 --branch "$REF" "$REPO" "$tmp/src"
    cp -a "$tmp/src/." . && rm -rf "$tmp"
  else
    die "$DIR holds other files. Use an empty folder (QW_DIR=...) for --build."
  fi
else
  say "Downloading the settings file for version $QW_VERSION"
  curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml.new || die "Could not download $RAW/docker-compose.yml. Check the internet connection, or set QW_VERSION to a published version."
  if [ -f docker-compose.yml ] && ! cmp -s docker-compose.yml docker-compose.yml.new; then cp docker-compose.yml docker-compose.yml.bak; fi
  mv docker-compose.yml.new docker-compose.yml
fi

# All state lives in ./data. The containers run as uid 10001. Only that user may read the keys.
mkdir -p data
$SUDO chown 10001:10001 data
$SUDO chmod 700 data

# ---------------------------------------------------------------- network
is_private() { [[ "$1" =~ ^10\. || "$1" =~ ^192\.168\. || "$1" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. || "$1" =~ ^127\. ]]; }
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
[ -n "$LAN_IP" ] || LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
# The home network with its prefix (192.168.1.229/21), for "Find my camera" in the setup.
LAN_CIDR=""
[ -n "$LAN_IP" ] && LAN_CIDR="$(ip -4 -o addr show scope global 2>/dev/null | awk -v ip="$LAN_IP" '{split($4, a, "/"); if (a[1] == ip) { print $4; exit }}' || true)"
PUBLIC=""
for ip in $(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}'); do
  is_private "$ip" || PUBLIC="$ip"
done

set_env() { # set_env KEY VALUE in ./.env, keeps other lines
  touch .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

# Keep the port of an earlier install. Otherwise take the first free port from 8080.
OLD_BIND="$(sed -n 's/^QW_UI_BIND=//p' .env 2>/dev/null || true)"
if [ -n "$OLD_BIND" ]; then
  PORT="${OLD_BIND##*:}"
else
  port_free() { ! (ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"); }
  for p in $(seq "$PORT" $((PORT + 10))); do if port_free "$p"; then PORT="$p"; break; fi; done
fi

if [ "$LOCAL" = 1 ] || [ -n "$PUBLIC" ] || [ -z "$LAN_IP" ] || ! is_private "$LAN_IP"; then
  BIND="127.0.0.1:$PORT"
  URL_HOST="localhost"
  if [ -n "$PUBLIC" ] && [ "$LOCAL" = 0 ]; then
    echo "This machine has a public IP address ($PUBLIC). The dashboard opens on this machine only."
    echo "From your laptop, use an SSH tunnel: ssh -L $PORT:127.0.0.1:$PORT $(id -un)@$PUBLIC  then open http://localhost:$PORT"
  fi
else
  # The phone or laptop on the home network must reach the setup. The page needs
  # the pairing code or a password, checks Host and Origin and refuses public clients.
  BIND="0.0.0.0:$PORT"
  URL_HOST="$LAN_IP"
fi
BASE="http://$URL_HOST:$PORT"
set_env QW_VERSION "$QW_VERSION"
set_env QW_UI_BIND "$BIND"
set_env QW_UI_PUBLIC_URL "$BASE"
if [ -n "$LAN_CIDR" ] && is_private "$LAN_IP"; then set_env QW_LAN_CIDR "$LAN_CIDR"; fi
chmod 600 .env

# ---------------------------------------------------------------- image
if [ "$BUILD" = 1 ]; then
  say "Building the image (10 minutes or more on a Raspberry Pi)"
  $DOCKER compose build --build-arg QW_COMMIT="$(git rev-parse HEAD)" </dev/null
else
  say "Downloading the QoreWitness image $QW_VERSION"
  $DOCKER compose pull -q </dev/null || die "The image ghcr.io/fnoufnou/qorewitness:$QW_VERSION is not available. Check the internet connection, or run the installer with --build."
fi

# ---------------------------------------------------------------- setup
if [ "$TERMINAL" = 1 ]; then
  say "Setup in the terminal: camera, account, keys"
  $DOCKER compose run --rm agent setup </dev/tty
fi

say "Starting QoreWitness"
$DOCKER compose up -d </dev/null

pair_args=(); [ "$NEWPW" = 1 ] && pair_args=(--new-password)
PAIR="$($DOCKER compose run --rm -T ui pair "${pair_args[@]}" </dev/null 2>/dev/null || true)"
TOKEN="$(printf '%s\n' "$PAIR" | sed -n 's/^token=//p')"
CODE="$(printf '%s\n' "$PAIR" | sed -n 's/^code=//p')"

echo
if [ -n "$TOKEN" ] && [ -n "$CODE" ]; then
  ( umask 077; printf 'Setup link: %s\nPairing code: %s\n' "$BASE/setup?token=$TOKEN" "$CODE" > SETUP-LINK.txt )
  bold "QoreWitness is ready. On your phone or laptop, open:"
  echo
  bold "      $BASE"
  echo
  bold "      Pairing code:  ${CODE:0:3} ${CODE:3:3}"
  echo
  echo "Or click this link: $BASE/setup?token=$TOKEN"
else
  bold "QoreWitness is running. Open your dashboard:"
  echo
  bold "      $BASE"
  echo
  echo "Forgot the password? Run the same command again and add --new-password."
fi
}

main "$@"
