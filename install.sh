#!/bin/sh
set -eu

UUID='clipboard@ai-nd.co'
SCHEMA='org.gnome.shell.extensions.ai-nd-co-clipboard'
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATA_ROOT=${XDG_DATA_HOME:-"$HOME/.local/share"}
TARGET_DIR="$DATA_ROOT/gnome-shell/extensions/$UUID"

for command_name in gsettings glib-compile-schemas python3; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Missing required command: $command_name" >&2
        exit 1
    fi
done

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

mkdir -p "$TARGET_DIR/schemas"
for file_name in extension.js metadata.json prefs.js stylesheet.css icon.svg LICENSE NOTICE; do
    install -m 0644 "$SOURCE_DIR/$file_name" "$TARGET_DIR/$file_name"
done
install -m 0644 "$SOURCE_DIR/schemas/org.gnome.shell.extensions.ai-nd-co-clipboard.gschema.xml" \
    "$TARGET_DIR/schemas/org.gnome.shell.extensions.ai-nd-co-clipboard.gschema.xml"

glib-compile-schemas "$TARGET_DIR/schemas"

GSETTINGS_SCHEMA_DIR="$TARGET_DIR/schemas" \
    gsettings set "$SCHEMA" toggle-shortcut "['<Super>v']"
GSETTINGS_SCHEMA_DIR="$TARGET_DIR/schemas" \
    gsettings set "$SCHEMA" enable-image-support true

# GNOME assigns Super+V and Super+M to notifications. Clipboard takes
# Super+V while notifications remain available on Super+M.
update_array_setting org.gnome.shell.keybindings toggle-message-tray remove '<Super>v'
update_array_setting org.gnome.shell.keybindings toggle-message-tray add '<Super>m'
update_array_setting org.gnome.shell enabled-extensions add "$UUID"

# This succeeds immediately for updates. A first install on Wayland becomes
# visible to GNOME Shell after the next login.
gnome-extensions enable "$UUID" >/dev/null 2>&1 || true

echo
echo 'Clipboard installed.'
echo 'Log out and back in once, then press Super+V.'
