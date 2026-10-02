# Clipboard

A small Windows-style clipboard history for GNOME Shell. Press **Super+V** to see recent text, links, and pictures in one chronological list, then select an item to paste it into the active application.

![Clipboard icon](icon.png)

## Features

- Mixed history for text, links, and images, newest first
- Inline image thumbnails and distinct link previews
- Click an item to restore and paste it
- Search, pin, delete, and clear history
- Keeps the latest 50 unpinned items by default
- Ignores clipboard content marked sensitive by compatible password managers
- Stores history locally with private filesystem permissions
- Works on GNOME Shell 46–50, including Wayland

## Install

```bash
git clone https://github.com/ai-nd-co/Clipboard.git
cd Clipboard
./install.sh
```

Log out and back in once after the first installation. GNOME Shell on Wayland cannot load a newly installed extension into the current desktop session.

After logging back in, copy some text, a URL, or an image and press **Super+V**. GNOME notifications remain available on **Super+M**.

## Update

```bash
git pull
./install.sh
```

If Clipboard is already loaded, disable and re-enable it to load code-only updates. Changes to extension metadata still require a logout and login.

## Uninstall

```bash
./uninstall.sh
```

The uninstaller keeps clipboard history by default. To remove the stored history too:

```bash
./uninstall.sh --purge
```

## Preferences

Open the Extensions application and choose **Clipboard**, or run:

```bash
gnome-extensions prefs clipboard@ai-nd.co
```

You can change the keyboard shortcut, history size, and image capture setting.

## Privacy

Clipboard content never leaves the computer. History metadata and cached images are stored in `~/.cache/clipboard@ai-nd.co/` with user-only permissions. Because clipboard history can contain sensitive information, review and clear it when using a shared computer.

## Development

Validate and package the extension with the GNOME tools:

```bash
node --check extension.js
glib-compile-schemas --strict --dry-run schemas
gnome-extensions pack . --force --extra-source=icon.svg --extra-source=LICENSE --extra-source=NOTICE
```

GNOME 48 and earlier can test the extension in a nested shell with:

```bash
dbus-run-session gnome-shell --nested --wayland
```

## Credits and license

Clipboard is derived from [Clipboard History](https://github.com/M-ghalevand/gnome-shell-extension-clipboard-history) by Manouchehr Ghalevand. See [NOTICE](NOTICE) for attribution.

Licensed under GPL-2.0-or-later. See [LICENSE](LICENSE).
