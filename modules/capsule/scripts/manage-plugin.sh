#!/usr/bin/env sh
set -eu

# Messages print as an [English] block, then a [中文] block.
say() { printf '[English]\n%s\n[中文]\n%s\n' "$1" "$2"; }

ACTION="${1:-install}"
case "$ACTION" in install|uninstall) ;; *) say "Unknown action: $ACTION" "未知操作：$ACTION" >&2; exit 1 ;; esac
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
SRC="$(CDPATH= cd -- "$SCRIPT_DIR/../agy-capsule" && pwd -P)"
PLUGIN_ROOT="${AGY_CAPSULE_PLUGINS_DIR:-$HOME/.gemini/config/plugins}"

if [ "$ACTION" = install ]; then
    test -f "$SRC/plugin.json" || { say 'Source plugin manifest missing' '缺少源插件清单' >&2; exit 1; }
    mkdir -p -- "$PLUGIN_ROOT"
elif [ ! -d "$PLUGIN_ROOT" ]; then
    say 'agy-capsule is not installed. Preferences were kept.' 'agy-capsule 未安装，已保留设置。'
    exit 0
fi
PLUGIN_ROOT="$(CDPATH= cd -- "$PLUGIN_ROOT" && pwd -P)"
DST="$PLUGIN_ROOT/agy-capsule"
test ! -L "$DST" || { say "Plugin destination is a link; remove the link manually: $DST" "插件目标路径是一个链接，请先手动删除这个链接：$DST" >&2; exit 1; }
test "$DST" != "$SRC" || { say 'Source and destination must differ' '源目录和目标目录不能相同' >&2; exit 1; }

if [ "$ACTION" = uninstall ]; then
    rm -rf -- "$DST"
    say "Removed $DST
Preferences were kept. Reload open Antigravity pages to clear any remaining UI." "已移除 $DST
已保留设置。重新加载已打开的 Antigravity 页面即可清除残留界面。"
    exit 0
fi

mkdir -p -- "$DST"
MARKER="$DST/.update-in-progress"
printf 'Updating agy-capsule\n' > "$MARKER"
trap 'rm -f -- "$MARKER"' 0
trap 'exit 1' 1 2 15
# Keep the marker present while replacing the installed files, including stale files.
find "$DST" ! -path "$DST" -prune ! -name '.update-in-progress' -exec rm -rf -- {} +
cp -R "$SRC/." "$DST/"
say "Installed/updated agy-capsule at $DST
Enable it in Antigravity Plugins on first install. Updates auto-restart a running reload-enabled version." "已安装/更新 agy-capsule 到 $DST
首次安装需在 Antigravity 的 Plugins 面板中启用。更新后，支持自动重载的插件会自动重启。"
