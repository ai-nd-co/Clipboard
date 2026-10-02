#!/bin/sh
set -eu

UUID='clipboard@ai-nd.co'
SCHEMA='org.gnome.shell.extensions.ai-nd-co-clipboard'
DATA_ROOT=${XDG_DATA_HOME:-"$HOME/.local/share"}
CACHE_ROOT=${XDG_CACHE_HOME:-"$HOME/.cache"}
TARGET_DIR="$DATA_ROOT/gnome-shell/extensions/$UUID"
CACHE_DIR="$CACHE_ROOT/$UUID"
PURGE=${1:-}

case "$PURGE" in
    ''|'--purge') ;;
    *)
        echo 'Usage: ./uninstall.sh [--purge]' >&2
        exit 2
        ;;
esac

update_array_setting() {
    schema_name=$1
    key_name=$2
    operation=$3
    requested_value=$4
    current_value=$(gsettings get "$schema_name" "$key_name")
    updated_value=$(python3 - "$operation" "$requested_value" "$current_value" <<'PY'
import ast
import sys

operation, requested, raw = sys.argv[1:]
if raw.startswith('@as '):
    raw = raw[4:]
items = list(ast.literal_eval(raw))
matches = lambda item: item.casefold() == requested.casefold()

if operation == 'add' and not any(matches(item) for item in items):
    items.append(requested)
elif operation == 'remove':
    items = [item for item in items if not matches(item)]

print(repr(items))
PY
    )
    gsettings set "$schema_name" "$key_name" "$updated_value"
}

gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
update_array_setting org.gnome.shell enabled-extensions remove "$UUID"
update_array_setting org.gnome.shell.keybindings toggle-message-tray add '<Super>v'
update_array_setting org.gnome.shell.keybindings toggle-message-tray add '<Super>m'

if [ -f "$TARGET_DIR/schemas/gschemas.compiled" ]; then
    GSETTINGS_SCHEMA_DIR="$TARGET_DIR/schemas" gsettings reset-recursively "$SCHEMA" || true
fi

case "$TARGET_DIR" in
    */gnome-shell/extensions/clipboard@ai-nd.co)
        rm -rf -- "$TARGET_DIR"
        ;;
    *)
        echo "Refusing unexpected extension path: $TARGET_DIR" >&2
        exit 1
        ;;
esac

if [ "$PURGE" = '--purge' ]; then
    case "$CACHE_DIR" in
        */clipboard@ai-nd.co)
            rm -rf -- "$CACHE_DIR"
            ;;
        *)
            echo "Refusing unexpected cache path: $CACHE_DIR" >&2
            exit 1
            ;;
    esac
fi

echo 'Clipboard uninstalled. Log out and back in to finish.'
if [ "$PURGE" != '--purge' ]; then
    echo "History was kept at: $CACHE_DIR"
fi
