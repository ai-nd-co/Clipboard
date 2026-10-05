/* extension.js — Clipboard History (Super+V)
 *
 * SPDX-FileCopyrightText: 2025 Manouchehr Ghalevand
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * A Windows-style clipboard history panel (Super+V) for GNOME Shell, written
 * against the ESM extension API of GNOME Shell 46–50 and tested on Wayland.
 *
 * Layout of this file:
 *   ClipboardWatcher          Listens for clipboard owner changes; no polling
 *   HistoryStore              In-memory history plus async persistence to disk
 *   HistoryItem               A single popup menu row (text or image)
 *   ClipboardHistoryIndicator Panel button and menu (list, search, pin, delete)
 *   Extension (default)       enable()/disable(), keybinding and paste handling
 *
 * One architectural constraint drives much of the code below: GJS is single
 * threaded and shares that thread with the whole Mutter compositor. No
 * expensive or blocking work — disk reads and writes, image decoding — may
 * therefore run synchronously, and the asynchronous variants of the Gio and
 * GdkPixbuf APIs (the _async/_finish pairs) are used throughout.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------

// Many applications change the clipboard owner several times for a single
// Ctrl+C — once for text/plain and again for a rich format, for instance.
// This window coalesces such bursts of owner-changed events.
const CLIPBOARD_DEBOUNCE_MS = 50;

// After the extension itself puts content on the clipboard, in order to
// paste a history entry, the owner-changed event caused by that write is
// ignored for this long, so the entry is not recorded again as a new copy.
const SELF_WRITE_GUARD_MS = 400;

// Delay between closing the menu and synthesising Ctrl+V, which gives
// keyboard focus time to return to the previously focused window. Some
// applications — Electron and Java ones especially — are slower to take
// focus back; raise this value if pastes occasionally land too early.
const PASTE_DELAY_MS = 250;

// Small gap between consecutive notify_keyval calls (press and release).
// Without it, applications that process input events on a dedicated UI
// thread may fail to recognise a synthetic key combination whose events all
// arrive within a single tick.
const PASTE_KEY_STAGGER_MS = 15;

const MAX_PREVIEW_CHARS = 400;
const THUMBNAIL_ICON_SIZE = 48;

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/tiff', 'image/bmp'];

// An established convention across the GNOME and KDE ecosystems: password
// managers such as KeePassXC, Bitwarden and KWallet advertise this MIME type
// to mark clipboard content as sensitive, so that clipboard managers know not
// to record it.
const SENSITIVE_MIME_TYPES = ['x-kde-passwordManagerHint'];

// Linux evdev keycodes (linux/input-event-codes.h). Pasting by keycode rather
// than by keyval works under any active layout: with a Russian layout active,
// the keyval 'v' maps to no key and Mutter silently drops the event.
const EVDEV_KEY_LEFTCTRL = 29;
const EVDEV_KEY_LEFTSHIFT = 42;
const EVDEV_KEY_V = 47;

// Terminals bind Ctrl+V to a literal ^V, so they receive Ctrl+Shift+V instead.
// Matched case-insensitively against the window's WM_CLASS.
const TERMINAL_WM_CLASSES = [
    'gnome-terminal-server', 'org.gnome.terminal', 'org.gnome.ptyxis', 'ptyxis',
    'org.gnome.console', 'kgx', 'kitty', 'alacritty', 'org.wezfurlong.wezterm',
    'wezterm', 'com.mitchellh.ghostty', 'ghostty', 'tilix', 'com.gexperts.tilix',
    'konsole', 'org.kde.konsole', 'terminator', 'xterm', 'urxvt', 'foot',
    'xfce4-terminal', 'qterminal', 'lxterminal', 'blackbox', 'com.raggesilver.blackbox',
];

function isTerminalWindow(window) {
    const wmClass = (window?.get_wm_class() ?? '').toLowerCase();
    const wmInstance = (window?.get_wm_class_instance() ?? '').toLowerCase();
    return TERMINAL_WM_CLASSES.includes(wmClass) || TERMINAL_WM_CLASSES.includes(wmInstance);
}

// ----------------------------------------------------------------------
// Standalone helpers
// ----------------------------------------------------------------------

/** Determines text direction (RTL or LTR) from the content of the string
 * itself, rather than from the fixed direction of the user interface. */
function detectTextDirection(text) {
    const baseDir = Pango.find_base_dir(text, -1);
    const isRtl = baseDir === Pango.Direction.RTL || baseDir === Pango.Direction.WEAK_RTL;
    return isRtl ? Clutter.TextDirection.RTL : Clutter.TextDirection.LTR;
}

/** Condenses text for display in a single row: one line, bounded length. */
function makePreviewText(text) {
    let preview = text.replace(/\s+/g, ' ').trim();
    if (preview.length > MAX_PREVIEW_CHARS)
        preview = `${preview.slice(0, MAX_PREVIEW_CHARS)}…`;
    return preview;
}

/** A copied URL is still stored as text, but showing a link icon makes it
 * immediately distinguishable from notes and code in the mixed history. */
function isLink(text) {
    const value = text.trim();
    return /^(https?:\/\/|ftp:\/\/|mailto:|www\.)\S+$/i.test(value);
}

/** The single logging call site for the extension. Only failures the user
 * may need to act on are reported here; recoverable conditions, such as a
 * cached image the user has since deleted, are handled without logging. */
function reportError(message, error) {
    console.error(`Clipboard History: ${message}: ${error.message}`);
}

/** True for the error an async operation raises when the store's cancellable
 * is cancelled during teardown, which is expected rather than a failure. The
 * instanceof guard matters because some of the try blocks below also cover
 * non-GLib calls, whose errors have no matches() method. */
function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

let _idCounter = 0;
function nextId() {
    _idCounter += 1;
    return `${Date.now()}-${_idCounter}`;
}

// ----------------------------------------------------------------------
// ClipboardWatcher
// ----------------------------------------------------------------------
//
// Listens for the 'owner-changed' signal on global.display.get_selection(),
// which is emitted whenever ownership of a selection changes and so requires
// no polling. Only SELECTION_CLIPBOARD is of interest here — ordinary
// copy and paste, not the PRIMARY mouse selection.

class ClipboardWatcher extends Signals.EventEmitter {
    constructor(enableImages) {
        super();

        this.enableImages = enableImages;

        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._debounceId = null;
        this._guardUntil = 0; // Events are ignored until this GLib.get_monotonic_time() value

        this._ownerChangedId = this._selection.connect('owner-changed',
            (selection, selectionType) => this._onOwnerChanged(selectionType));
    }

    /** Called immediately before the extension writes to the clipboard, so
     * that the owner-changed event caused by that write is ignored. */
    _suppressNextChange() {
        this._guardUntil = GLib.get_monotonic_time() + SELF_WRITE_GUARD_MS * 1000;
    }

    setText(text) {
        this._suppressNextChange();
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    }

    setImage(bytes, mimeType) {
        this._suppressNextChange();
        this._clipboard.set_content(St.ClipboardType.CLIPBOARD, mimeType, bytes);
    }

    _onOwnerChanged(selectionType) {
        if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        if (GLib.get_monotonic_time() < this._guardUntil)
            return;

        // Debounce: coalesce a burst of consecutive events into one timer.
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLIPBOARD_DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._readClipboard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readClipboard() {
        const mimeTypes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (mimeTypes.length === 0)
            return;

        if (SENSITIVE_MIME_TYPES.some(m => mimeTypes.includes(m)))
            return; // Sensitive content, e.g. from a password manager: do not store

        if (this.enableImages) {
            const imageMime = IMAGE_MIME_TYPES.find(m => mimeTypes.includes(m));
            if (imageMime) {
                this._clipboard.get_content(St.ClipboardType.CLIPBOARD, imageMime, (clipboard, bytes) => {
                    if (bytes && bytes.get_size() > 0)
                        this.emit('image-copied', bytes, imageMime);
                });
                return;
            }
        }

        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
            if (text && text.length > 0)
                this.emit('text-copied', text);
        });
    }

    destroy() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = null;
        }
    }
}

// ----------------------------------------------------------------------
// HistoryStore — persists the history to disk, entirely asynchronously
// ----------------------------------------------------------------------
//
// Only lightweight metadata — text, image path, timestamp, pinned flag — is
// kept in a single JSON file. The image bytes themselves live in separate
// PNG files, which keeps the index file small.

class HistoryStore {
    constructor(uuid) {
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), uuid]);
        this._imagesDir = GLib.build_filenamev([this._cacheDir, 'images']);
        this._indexPath = GLib.build_filenamev([this._cacheDir, 'history.json']);
        // Shared by every async operation the store starts, and by the pixbuf
        // decode the indicator runs on bytes headed for this store. A fresh
        // store — and so a fresh cancellable — is built on every enable().
        this.cancellable = new Gio.Cancellable();
        this._ensureDirs();
    }

    _ensureDirs() {
        // The images directory is inside the cache directory, so creating it
        // with parents creates both.
        try {
            Gio.File.new_for_path(this._imagesDir).make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                reportError(`could not create ${this._imagesDir}`, e);
        }

        // Clipboard history is private user data. Ubuntu commonly uses a
        // group-writable umask, so set restrictive permissions explicitly.
        GLib.chmod(this._cacheDir, 0o700);
        GLib.chmod(this._imagesDir, 0o700);
    }

    loadIndexAsync(callback) {
        const file = Gio.File.new_for_path(this._indexPath);
        file.load_contents_async(this.cancellable, (source, res) => {
            try {
                const [, contents] = source.load_contents_finish(res);
                const entries = JSON.parse(new TextDecoder().decode(contents));
                callback(Array.isArray(entries) ? entries : []);
            } catch (e) {
                if (isCancelled(e))
                    return;
                callback([]); // First run, or a missing or corrupt file
            }
        });
    }

    saveIndexAsync(entries) {
        const file = Gio.File.new_for_path(this._indexPath);
        const json = JSON.stringify(entries);
        const bytes = new GLib.Bytes(new TextEncoder().encode(json));
        file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, this.cancellable, (source, res) => {
                try {
                    source.replace_contents_finish(res);
                    GLib.chmod(this._indexPath, 0o600);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                    reportError('could not save the history', e);
                }
            });
    }

    saveImageAsync(id, bytes, callback) {
        const path = GLib.build_filenamev([this._imagesDir, `${id}.png`]);
        const file = Gio.File.new_for_path(path);
        file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, this.cancellable, (source, res) => {
                try {
                    source.replace_contents_finish(res);
                    GLib.chmod(path, 0o600);
                    callback(path);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                    reportError('could not save the image', e);
                    callback(null);
                }
            });
    }

    readImageBytes(entry, callback) {
        const file = Gio.File.new_for_path(entry.imagePath);
        file.load_bytes_async(this.cancellable, (source, res) => {
            try {
                const [bytes] = source.load_bytes_finish(res);
                callback(bytes);
            } catch (e) {
                if (isCancelled(e))
                    return;
                // A cached image can be absent for ordinary reasons — the user
                // emptying ~/.cache by hand, for one — so the caller recovers
                // from a null result rather than this being reported.
                callback(null);
            }
        });
    }

    deleteImageAsync(id) {
        const path = GLib.build_filenamev([this._imagesDir, `${id}.png`]);
        Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, this.cancellable, (source, res) => {
            try {
                source.delete_finish(res);
            } catch (e) {
                if (isCancelled(e))
                    return;
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    reportError(`could not delete ${path}`, e);
            }
        });
    }

    destroy() {
        this.cancellable.cancel();
    }
}

// ----------------------------------------------------------------------
// HistoryItem — a single row of the popup menu
// ----------------------------------------------------------------------

const HistoryItem = GObject.registerClass({
    Signals: {
        'pin-toggled': {},
        'delete-requested': {},
    },
}, class HistoryItem extends PopupMenu.PopupBaseMenuItem {
    _init(entry) {
        super._init({
            style_class: 'clipboard-history-item',
            can_focus: true,
        });

        // entry: {id, type:'text'|'image', text?, imagePath?, mimeType?, width?,
        //         height?, pinned, timestamp}
        this.entry = entry;

        this._buildContent();
    }

    _buildContent() {
        if (this.entry.type === 'image')
            this._buildImagePreview();
        else
            this._buildTextPreview();

        this._buildPinButton();
        this._buildDeleteButton();
    }

    _buildImagePreview() {
        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(this.entry.imagePath),
            icon_size: THUMBNAIL_ICON_SIZE,
            style_class: 'clipboard-history-thumbnail',
        });
        this.add_child(icon);

        const caption = (this.entry.width && this.entry.height)
            ? `Image  ${this.entry.width}×${this.entry.height}`
            : 'Copied image';
        const label = new St.Label({
            text: caption,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this.add_child(label);
        this.label_actor = label;
    }

    _buildTextPreview() {
        this.add_child(new St.Icon({
            icon_name: isLink(this.entry.text) ? 'web-browser-symbolic' : 'edit-copy-symbolic',
            icon_size: 20,
            style_class: 'clipboard-history-type-icon',
        }));

        const label = new St.Label({
            text: makePreviewText(this.entry.text),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        label.clutter_text.line_wrap = false;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // The key to RTL support: direction is derived from the content of
        // this particular entry, not fixed once for the whole interface.
        label.clutter_text.set_text_direction(detectTextDirection(this.entry.text));
        this.add_child(label);
        this.label_actor = label;
    }

    _buildPinButton() {
        const pinIcon = new St.Icon({
            icon_name: this.entry.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
            style_class: 'popup-menu-icon',
        });
        this._pinButton = new St.Button({
            child: pinIcon,
            style_class: 'clipboard-history-icon-button',
            can_focus: true,
            toggle_mode: true,
            checked: this.entry.pinned,
        });
        this._pinButton.connect('clicked', () => {
            this.entry.pinned = this._pinButton.checked;
            pinIcon.icon_name = this.entry.pinned ? 'starred-symbolic' : 'non-starred-symbolic';
            this.emit('pin-toggled');
        });
        this.add_child(this._pinButton);
    }

    _buildDeleteButton() {
        const deleteButton = new St.Button({
            child: new St.Icon({icon_name: 'edit-delete-symbolic', style_class: 'popup-menu-icon'}),
            style_class: 'clipboard-history-icon-button',
            can_focus: true,
        });
        deleteButton.connect('clicked', () => this.emit('delete-requested'));
        this.add_child(deleteButton);
    }
});

// ----------------------------------------------------------------------
// ClipboardHistoryIndicator — panel button and main menu
// ----------------------------------------------------------------------

const ClipboardHistoryIndicator = GObject.registerClass(
class ClipboardHistoryIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Clipboard History', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._store = extension.store;
        this._watcher = extension.watcher;

        this._entries = []; // In-memory model: an array of text and image entries
        this._renderedItems = [];

        this.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon'}));

        this._buildMenu();
        this._connectWatcher();
        this._loadHistory();
    }

    // -------------------- Menu construction --------------------

    _buildMenu() {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.add_child(new St.Label({
            text: 'Clipboard',
            style_class: 'clipboard-history-title',
        }));
        this.menu.addMenuItem(header);

        this._buildSearchRow();

        // Windows-style history is one chronological stream: pictures, text,
        // and links are mixed together with the newest item first.
        this._historySection = new PopupMenu.PopupMenuSection();

        this._scrollView = new St.ScrollView({
            style_class: 'clipboard-history-scrollview',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scrollView.set_child(this._historySection.actor);
        this.menu.box.add_child(this._scrollView);

        this._emptyLabel = new St.Label({
            text: 'History is empty',
            style_class: 'clipboard-history-empty-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.menu.box.add_child(this._emptyLabel);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._clearAction = this.menu.addAction('Clear history (keep pinned)', () => this._clearHistory());
        this._clearAction.visible = false;

        this._menuStateId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                // Remember where the paste should land before the menu takes focus.
                this._targetWindow = global.display.focus_window;
                this._searchEntry.set_text('');
                this._applyFilter();
                global.stage.set_key_focus(this._searchEntry);
            }
        });
    }


    /** Search row for text and link entries. Images remain visible while the
     * search box is empty. */
    _buildSearchRow() {
        this._searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const clearIcon = new St.Icon({icon_name: 'edit-clear-symbolic', style_class: 'popup-menu-icon'});
        this._searchEntry = new St.Entry({
            hint_text: 'Search copied items…',
            can_focus: true,
            x_expand: true,
            style_class: 'clipboard-history-search',
            secondary_icon: clearIcon,
        });
        this._searchEntry.connect('secondary-icon-clicked', () => this._searchEntry.set_text(''));
        this._searchEntry.connect('notify::text', () => this._applyFilter());
        this._searchItem.add_child(this._searchEntry);
        this.menu.addMenuItem(this._searchItem);
    }


    // -------------------- Wiring up ClipboardWatcher --------------------

    _connectWatcher() {
        this._watcherIds = [
            this._watcher.connect('text-copied', (watcher, text) => this._onTextCopied(text)),
            this._watcher.connect('image-copied', (watcher, bytes, mimeType) => this._onImageCopied(bytes, mimeType)),
        ];
    }

    _onTextCopied(text) {
        const existing = this._entries.find(e => e.type === 'text' && e.text === text);
        if (existing) {
            existing.timestamp = Date.now();
        } else {
            this._entries.unshift({
                id: nextId(),
                type: 'text',
                text,
                pinned: false,
                timestamp: Date.now(),
            });
            this._trimHistory();
        }
        this._persist();
        this._rebuildList();
    }

    _onImageCopied(bytes, mimeType) {
        const id = nextId();
        this._store.saveImageAsync(id, bytes, imagePath => {
            if (!imagePath)
                return;

            this._entries.unshift({
                id,
                type: 'image',
                imagePath,
                mimeType,
                pinned: false,
                timestamp: Date.now(),
            });
            this._trimHistory();
            this._persist();
            this._rebuildList();

            this._readImageDimensions(bytes, id);
        });
    }

    /** Reads the image dimensions asynchronously, from the bytes already in
     * memory rather than from disk, so that a more informative caption such
     * as "Image 640×480" can be shown. */
    _readImageDimensions(bytes, id) {
        const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, this._store.cancellable, (source, res) => {
            try {
                const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
                const entry = this._entries.find(e => e.id === id);
                if (entry) {
                    entry.width = pixbuf.get_width();
                    entry.height = pixbuf.get_height();
                    this._persist();
                    this._rebuildList();
                }
            } catch (e) {
                if (isCancelled(e))
                    return;
                // The row keeps its generic caption, but content the clipboard
                // advertised as an image failing to decode is worth knowing.
                reportError('could not decode the copied image', e);
            }
        });
    }

    // -------------------- History operations --------------------

    _onItemActivated(entry) {
        this.menu.close();

        if (entry.type === 'image') {
            this._store.readImageBytes(entry, bytes => {
                // The bytes are whatever the source application offered, so they
                // must go back out under that same type. Entries written before
                // mimeType was recorded predate any non-PNG capture path.
                if (bytes)
                    this._watcher.setImage(bytes, entry.mimeType ?? 'image/png');
                this._schedulePaste();
            });
        } else {
            this._watcher.setText(entry.text);
            this._schedulePaste();
        }
    }

    _schedulePaste() {
        this._extension.schedulePaste(PASTE_DELAY_MS, this._targetWindow);
        this._targetWindow = null;
    }

    _onPinToggled() {
        this._persist();
        this._rebuildList();
    }

    _onDeleteRequested(entry) {
        this._entries = this._entries.filter(e => e.id !== entry.id);
        if (entry.type === 'image')
            this._store.deleteImageAsync(entry.id);
        this._persist();
        this._rebuildList();
    }

    /** Clears all unpinned items. Pinned text, links, and images are kept. */
    _clearHistory() {
        const toRemove = this._entries.filter(e => !e.pinned);
        this._entries = this._entries.filter(e => e.pinned);
        for (const e of toRemove) {
            if (e.type === 'image')
                this._store.deleteImageAsync(e.id);
        }
        this._persist();
        this._rebuildList();
    }

    _trimHistory() {
        const max = this._settings.get_int('max-history-size');
        const nonPinned = this._entries
            .filter(e => !e.pinned)
            .sort((a, b) => b.timestamp - a.timestamp);

        if (nonPinned.length <= max)
            return;

        const toRemoveIds = new Set(nonPinned.slice(max).map(e => e.id));
        for (const e of this._entries) {
            if (toRemoveIds.has(e.id) && e.type === 'image')
                this._store.deleteImageAsync(e.id);
        }
        this._entries = this._entries.filter(e => !toRemoveIds.has(e.id));
    }

    _persist() {
        this._store.saveIndexAsync(this._entries);
    }

    _loadHistory() {
        this._store.loadIndexAsync(entries => {
            this._entries = entries || [];
            this._rebuildList();
        });
    }

    // -------------------- List rendering --------------------

    _rebuildList() {
        this._historySection.removeAll();
        this._renderedItems = [];

        const sortFn = (a, b) => {
            if (a.pinned !== b.pinned)
                return a.pinned ? -1 : 1;
            return b.timestamp - a.timestamp;
        };

        const addRow = entry => {
            const item = new HistoryItem(entry);
            item.connect('activate', () => this._onItemActivated(entry));
            item.connect('pin-toggled', () => this._onPinToggled());
            item.connect('delete-requested', () => this._onDeleteRequested(entry));
            this._historySection.addMenuItem(item);
            this._renderedItems.push(item);
        };

        for (const entry of [...this._entries].sort(sortFn))
            addRow(entry);

        this._clearAction.visible = this._entries.some(e => !e.pinned);
        this._applyFilter();
    }

    /** Search text and links in the single mixed history list. */
    _applyFilter() {
        const query = this._searchEntry.get_text().trim().toLowerCase();
        let anyVisible = false;
        for (const item of this._renderedItems) {
            const visible = query.length === 0 ||
                (item.entry.type === 'text' && item.entry.text.toLowerCase().includes(query));
            item.visible = visible;
            anyVisible = anyVisible || visible;
        }
        this._emptyLabel.visible = !anyVisible;
        this._emptyLabel.text = query.length > 0 && this._renderedItems.length > 0
            ? 'No matching copied items'
            : 'Copy something to see it here';
    }

    destroy() {
        // The watcher and store are owned by the Extension class and destroyed
        // there; only these handlers and the references are dropped here.
        for (const id of this._watcherIds)
            this._watcher.disconnect(id);
        this._watcherIds = [];

        if (this._menuStateId) {
            this.menu.disconnect(this._menuStateId);
            this._menuStateId = null;
        }

        this._targetWindow = null;
        this._watcher = null;
        this._store = null;
        super.destroy();
    }
});

// ----------------------------------------------------------------------
// The extension class itself
// ----------------------------------------------------------------------

export default class ClipboardHistoryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this.watcher = new ClipboardWatcher(this._settings.get_boolean('enable-image-support'));
        this._imageSettingId = this._settings.connect('changed::enable-image-support', () => {
            this.watcher.enableImages = this._settings.get_boolean('enable-image-support');
        });

        this.store = new HistoryStore(this.uuid);
        this._virtualKeyboard = null; // Created lazily in simulatePaste()
        this._pasteTimeoutIds = new Set(); // All pending paste timers, cleared on disable()

        this._indicator = new ClipboardHistoryIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // 'toggle-shortcut' ships empty, so this registers no accelerator until
        // the user sets one; Main.wm.addKeybinding tracks the key from there on.
        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._indicator.menu.toggle()
        );
    }

    disable() {
        // First, so that disk and decode callbacks still in flight return
        // early instead of touching the objects released below.
        this.store.destroy();

        Main.wm.removeKeybinding('toggle-shortcut');

        this._removePasteTimeouts();

        this._settings.disconnect(this._imageSettingId);
        this._imageSettingId = null;

        this._indicator.destroy();
        this._indicator = null;

        this.watcher.destroy();
        this.watcher = null;

        this.store = null;
        this._virtualKeyboard = null;
        this._settings = null;
    }

    // ---------- Synthesising Ctrl+V through a virtual input device ----------
    //
    // This is the same approach gnome-shell takes for its own on-screen
    // keyboard in js/ui/keyboard.js: a virtual input device is created from
    // the seat, and key events are emitted on it.

    /** Runs a callback after a delay, keeping the GLib source id so that
     * disable() can cancel anything still pending. */
    _addPasteTimeout(delayMs, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._pasteTimeoutIds.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._pasteTimeoutIds.add(id);
    }

    _removePasteTimeouts() {
        for (const id of this._pasteTimeoutIds)
            GLib.source_remove(id);
        this._pasteTimeoutIds.clear();
    }

    /** Pastes into the focused application after a short delay, giving
     * keyboard focus time to return there once the menu has closed. */
    schedulePaste(delayMs, targetWindow) {
        this._addPasteTimeout(delayMs, () => this.simulatePaste(targetWindow));
    }

    simulatePaste(targetWindow) {
        // The window may have closed while the menu was open.
        let window = global.display.focus_window;
        if (targetWindow && global.get_window_actors().some(a => a.meta_window === targetWindow)) {
            if (window !== targetWindow)
                targetWindow.activate(global.get_current_time());
            window = targetWindow;
        }
        if (!this._virtualKeyboard) {
            // Both branches are live across the supported range: gnome-shell 46
            // reaches the seat through Clutter.get_default_backend(), and 47+
            // through global.stage.context.get_backend().
            const backend = global.stage.context?.get_backend
                ? global.stage.context.get_backend()
                : Clutter.get_default_backend();
            const seat = backend.get_default_seat();
            this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }

        // The key events — press and release for the modifiers and for V —
        // are sent slightly apart rather than all within one tick, which is
        // more reliable with applications that discard synthetic events
        // arriving too close together, as some Electron and Java ones do. If
        // pasting still fails in a particular application, the content is on
        // the clipboard regardless and the user can press Ctrl+V themselves.
        const modifiers = isTerminalWindow(window)
            ? [EVDEV_KEY_LEFTCTRL, EVDEV_KEY_LEFTSHIFT]
            : [EVDEV_KEY_LEFTCTRL];
        const steps = [
            ...modifiers.map(key => [key, Clutter.KeyState.PRESSED]),
            [EVDEV_KEY_V, Clutter.KeyState.PRESSED],
            [EVDEV_KEY_V, Clutter.KeyState.RELEASED],
            ...modifiers.reverse().map(key => [key, Clutter.KeyState.RELEASED]),
        ];

        steps.forEach(([key, state], index) => {
            this._addPasteTimeout(index * PASTE_KEY_STAGGER_MS, () => {
                this._virtualKeyboard?.notify_key(GLib.get_monotonic_time(), key, state);
            });
        });
    }
}
