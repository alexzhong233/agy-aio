#!/usr/bin/env sh
# agy-aio 一键卸载入口（POSIX sh）。
# 本脚本只负责检查 Node.js 版本，然后转交给 bin/agy-aio.mjs 执行卸载逻辑。

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
CLI_ENTRY="$SCRIPT_DIR/bin/agy-aio.mjs"
NODE_MIN="18.18.0"
NODE_CHECK='const [M,m]=process.versions.node.split(".").map(Number); if(M<18||(M===18&&m<18)) process.exit(1)'
HOME_DIR=${HOME:-}

node_exists() {
  [ -n "${1:-}" ] || return 1
  if [ -x "$1" ]; then
    return 0
  fi
  command -v "$1" >/dev/null 2>&1
}

node_version_ok() {
  [ -n "${1:-}" ] || return 1
  "$1" -e "$NODE_CHECK" >/dev/null 2>&1
}

# 在 root 下查找所有匹配 suffix 的 Node，并按 X.Y.Z 数值从旧到新排序，
# 输出最新一个。适用于 nvm / fnm 这类按版本分目录的安装方式。
newest_node_in() {
  _root=$1
  _suffix=$2
  [ -d "$_root" ] || return 0

  _versions=""
  for _dir in "$_root"/*; do
    [ -d "$_dir" ] || continue
    [ -x "$_dir/$_suffix" ] || continue
    _base=${_dir##*/}
    _ver=${_base#v}
    _versions="${_versions}${_ver} ${_dir}
"
  done

  [ -n "$_versions" ] || return 0

  _newest=$(
    printf '%s' "$_versions" \
      | sort -t. -k1,1n -k2,2n -k3,3n \
      | tail -n 1 \
      | cut -d' ' -f2-
  )

  if [ -n "$_newest" ]; then
    printf '%s\n' "$_newest"
  fi
}

NODE_BIN=""
FOUND_ANY=0

try_node() {
  _candidate=${1:-}
  [ -n "$_candidate" ] || return 0
  node_exists "$_candidate" || return 0
  FOUND_ANY=1
  if node_version_ok "$_candidate"; then
    NODE_BIN=$_candidate
  fi
}

# 1. PATH 中的 node
if [ -z "$NODE_BIN" ]; then
  try_node "$(command -v node 2>/dev/null || true)"
fi

# 2. Homebrew（Apple Silicon / Intel）
if [ -z "$NODE_BIN" ]; then
  try_node /opt/homebrew/bin/node
fi

if [ -z "$NODE_BIN" ]; then
  try_node /usr/local/bin/node
fi

# 3. nvm（取最新版本）
if [ -z "$NODE_BIN" ] && [ -n "$HOME_DIR" ]; then
  try_node "$(newest_node_in "$HOME_DIR/.nvm/versions/node" "bin/node")"
fi

# 4. fnm（取最新版本）
if [ -z "$NODE_BIN" ] && [ -n "$HOME_DIR" ]; then
  try_node "$(newest_node_in "$HOME_DIR/.local/share/fnm/node-versions" "installation/bin/node")"
fi

# 5. asdf
if [ -z "$NODE_BIN" ] && [ -n "$HOME_DIR" ]; then
  try_node "$HOME_DIR/.asdf/shims/node"
fi

# 6. Volta
if [ -z "$NODE_BIN" ] && [ -n "$HOME_DIR" ]; then
  try_node "$HOME_DIR/.volta/bin/node"
fi

if [ -z "$NODE_BIN" ]; then
  printf '\n' >&2
  if [ "$FOUND_ANY" -eq 1 ]; then
    printf '错误：检测到 Node.js，但版本低于 %s。\n' "$NODE_MIN" >&2
    printf 'Error: Node.js was found, but its version is lower than %s.\n' "$NODE_MIN" >&2
  else
    printf '错误：未检测到 Node.js。\n' >&2
    printf 'Error: Node.js was not found.\n' >&2
  fi
  printf '\n' >&2
  printf '请安装 Node.js %s 或更高版本 / Please install Node.js >= %s:\n' "$NODE_MIN" "$NODE_MIN" >&2
  printf '  macOS:            brew install node\n' >&2
  printf '  其他系统 / Other:  https://nodejs.org/\n' >&2
  printf '\n' >&2
  printf '安装后请重新打开终端再运行本脚本。\n' >&2
  printf 'Reopen your terminal and run this script again.\n' >&2
  exit 1
fi

if [ ! -f "$CLI_ENTRY" ]; then
  printf '错误：找不到 CLI 入口 / Error: CLI entry not found: %s\n' "$CLI_ENTRY" >&2
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/bin/agy-aio.mjs" uninstall "$@"
