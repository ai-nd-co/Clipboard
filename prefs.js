/* prefs.js — Preferences page for the Clipboard History extension
 *
 * SPDX-FileCopyrightText: 2025 Manouchehr Ghalevand
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * This file runs in a separate process from gnome-shell, on GTK4 + Adwaita,
 * so none of Clutter, Meta, Shell or St are available here.
 */

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Keys that are meaningless as a shortcut on their own — they only ever
// accompany a primary key — and are therefore ignored while capturing input.
const MODIFIER_KEYVALS = [
    Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock,
];

export default class ClipboardHistoryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep a reference on the window so the settings object is not
        // garbage-collected while the window is still open.
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'edit-paste-symbolic',
        });
        window.add(page);

        // ---------------- Shortcut group ----------------
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcut',
            description: 'The key that opens/closes the clipboard history panel.',
        });
        page.add(shortcutGroup);
        shortcutGroup.add(this._buildShortcutRow(
            settings, 'toggle-shortcut',
            'Toggle clipboard panel',
            'Super+V is the default. The installer keeps GNOME notifications on Super+M.'
        ));

        // ---------------- History group ----------------
        const historyGroup = new Adw.PreferencesGroup({title: 'History'});
        page.add(historyGroup);

        const maxRow = new Adw.SpinRow({
            title: 'Maximum number of items',
            subtitle: 'Pinned items are exempt from this limit and are always kept.',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 500,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        settings.bind('max-history-size', maxRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(maxRow);

        const imagesRow = new Adw.SwitchRow({
            title: 'Save copied images',
            subtitle: 'When off, only text clipboard changes are recorded.',
        });
        settings.bind('enable-image-support', imagesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(imagesRow);

        // ---------------- Help group ----------------
        const helpGroup = new Adw.PreferencesGroup({title: 'Help'});
        page.add(helpGroup);
        helpGroup.add(new Adw.ActionRow({
            title: 'How to use',
            subtitle:
                'Click the star icon to pin an item, and the trash icon to ' +
                'delete it. Clicking an item restores it to the clipboard and ' +
                'automatically pastes it into the active application.',
        }));
    }

    /** An Adw.ActionRow with a "Change" button that captures a new shortcut.
     *
     * The key controller is attached to the preferences window itself rather
     * than to a dedicated capture dialog: under some hosts of prefs.js — the
     * Extensions app in particular — an extra toplevel is never mapped and
     * never takes focus, so clicking "Change" appears to do nothing. */
    _buildShortcutRow(settings, key, title, subtitle) {
        const row = new Adw.ActionRow({title, subtitle});

        const shortcutLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });

        const updateLabel = () => {
            const [accel] = settings.get_strv(key);
            if (!accel) {
                shortcutLabel.set_label('Not set');
                return;
            }
            // Gtk.accelerator_parse returns [ok, keyval, mods], not
            // [keyval, mods]; destructuring it as a pair passes the keyval
            // where the modifier mask belongs and crashes accelerator_get_label.
            const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
            if (!ok) {
                shortcutLabel.set_label(accel);
                return;
            }
            shortcutLabel.set_label(Gtk.accelerator_get_label(keyval, mods));
        };
        updateLabel();

        const editButton = new Gtk.Button({
            label: 'Change',
            valign: Gtk.Align.CENTER,
        });

        let keyController = null;

        const stopCapturing = rootWidget => {
            editButton.label = 'Change';
            editButton.remove_css_class('suggested-action');
            if (keyController) {
                rootWidget.remove_controller(keyController);
                keyController = null;
            }
        };

        editButton.connect('clicked', () => {
            const rootWidget = editButton.get_root();
            if (!rootWidget)
                return;

            if (keyController) {
                // A second click on "Change" while listening cancels capture.
                stopCapturing(rootWidget);
                return;
            }

            editButton.label = 'Press a key…';
            editButton.add_css_class('suggested-action');

            keyController = new Gtk.EventControllerKey();
            rootWidget.add_controller(keyController);
            keyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
                if (keyval === Gdk.KEY_Escape) {
                    stopCapturing(rootWidget);
                    return Gdk.EVENT_STOP;
                }

                if (MODIFIER_KEYVALS.includes(keyval))
                    return Gdk.EVENT_STOP; // Modifier alone: wait for a primary key

                const mask = state & Gtk.accelerator_get_default_mod_mask();
                if (!Gtk.accelerator_valid(keyval, mask))
                    return Gdk.EVENT_STOP;

                const accel = Gtk.accelerator_name(keyval, mask);
                settings.set_strv(key, [accel]);
                updateLabel();
                stopCapturing(rootWidget);
                return Gdk.EVENT_STOP;
            });
        });

        row.add_suffix(shortcutLabel);
        row.add_suffix(editButton);
        row.activatable_widget = editButton;

        return row;
    }
}
