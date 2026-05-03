#!/usr/bin/env bash
# uninstall.sh — Uninstall all components of otel-codex-hook
#
# Steps:
#   1. Remove hooks from ~/.codex/config.toml
#   2. Remove ~/.local/bin/otel-codex-hook wrapper (if exists)
#   3. Print uninstall result

set -euo pipefail

CACHE_DIR="$HOME/.cache/opentelemetry.instrumentation.codex"
CONFIG_FILE="$HOME/.codex/config.toml"

# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------
detect_lang() {
    if [ -n "${OTEL_CODEX_LANG:-}" ]; then echo "$OTEL_CODEX_LANG"; return; fi
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    if [ "$(uname)" = "Darwin" ]; then
        local apple_lang
        apple_lang=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$apple_lang" ]; then echo "zh"; return; fi
        local apple_locale
        apple_locale=$(defaults read -g AppleLocale 2>/dev/null || true)
        if echo "$apple_locale" | grep -qi "zh"; then echo "zh"; return; fi
    fi
    if [ "$(uname -o 2>/dev/null || true)" = "Msys" ] || [ "$(uname -o 2>/dev/null || true)" = "Cygwin" ]; then
        local locale
        locale=$(reg query "HKCU\\Control Panel\\International" /v LocaleName 2>/dev/null | grep -o "zh[^[:space:]]*" | head -1 || true)
        if [ -n "$locale" ]; then echo "zh"; return; fi
    fi
    echo "en"
}
LANG_MODE=$(detect_lang)

msg() {
    local zh="$1"
    local en="$2"
    if [ "$LANG_MODE" = "zh" ]; then
        echo "$zh"
    else
        echo "$en"
    fi
}

# ---------------------------------------------------------------------------

msg "==============================" \
    "=============================="
msg " otel-codex-hook — 卸载" \
    " otel-codex-hook — Uninstall"
msg "==============================" \
    "=============================="
echo ""

# 1. Clean up ~/.codex/config.toml
msg "==> 清理 hooks 配置 ($CONFIG_FILE)..." \
    "==> Cleaning up hooks config ($CONFIG_FILE)..."

if [ -f "$CONFIG_FILE" ]; then
    if command -v otel-codex-hook >/dev/null 2>&1; then
        otel-codex-hook uninstall 2>/dev/null || true
        msg "    ✅ hooks 配置已清理 (via otel-codex-hook uninstall)" \
            "    ✅ Hooks config cleaned up (via otel-codex-hook uninstall)"
    elif grep -q "otel-codex-hook" "$CONFIG_FILE" 2>/dev/null; then
        local marker="# OpenTelemetry instrumentation hooks"
        if grep -q "$marker" "$CONFIG_FILE" 2>/dev/null; then
            local tmp
            tmp=$(mktemp)
            sed "/$marker/,\$d" "$CONFIG_FILE" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$tmp"
            mv "$tmp" "$CONFIG_FILE"
        else
            local tmp
            tmp=$(mktemp)
            grep -v "otel-codex-hook" "$CONFIG_FILE" > "$tmp"
            mv "$tmp" "$CONFIG_FILE"
        fi
        msg "    ✅ hooks 配置已清理 (via sed)" \
            "    ✅ Hooks config cleaned up (via sed)"
    else
        msg "    ℹ️  未找到 otel-codex-hook 相关配置，跳过" \
            "    ℹ️  No otel-codex-hook config found, skipping"
    fi
else
    msg "    ℹ️  $CONFIG_FILE 不存在，跳过" \
        "    ℹ️  $CONFIG_FILE not found, skipping"
fi
echo ""

# 2. Remove ~/.local/bin wrapper (if exists)
LOCAL_WRAPPER="$HOME/.local/bin/otel-codex-hook"
msg "==> 检查本地 wrapper..." \
    "==> Checking local wrapper..."
if [ -f "$LOCAL_WRAPPER" ]; then
    rm -f "$LOCAL_WRAPPER"
    msg "    ✅ 已删除 $LOCAL_WRAPPER" \
        "    ✅ Deleted $LOCAL_WRAPPER"
else
    msg "    ℹ️  $LOCAL_WRAPPER 不存在，跳过" \
        "    ℹ️  $LOCAL_WRAPPER not found, skipping"
fi
echo ""

# 3. Done
msg "==============================" \
    "=============================="
msg " ✅ 卸载完成！" \
    " ✅ Uninstall complete!"
msg "==============================" \
    "=============================="
echo ""
msg "注意：" \
    "Notes:"
msg "  - Session 数据仍保留在: $CACHE_DIR/sessions/" \
    "  - Session data retained at: $CACHE_DIR/sessions/"
msg "  - 完全删除缓存请运行: rm -rf $CACHE_DIR" \
    "  - To fully remove cache: rm -rf $CACHE_DIR"
echo ""
