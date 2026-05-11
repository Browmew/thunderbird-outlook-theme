# Thunderbird Outlook Theme

A custom Thunderbird theme that gives your email client an Outlook-style look — complete with sender avatar circles, an Outlook-inspired layout, and an optional one-click delete button on every email row.

---

## Features

- **Outlook-style layout** — compact card view with sender initials, subject previews, and a clean dark theme
- **Sender avatar circles** — coloured initials badges next to every email, just like Outlook (via addon)
- **Trash button** *(optional addon)* — a clickable delete button on every email row; moves emails to Trash and supports Ctrl+Z undo
- **Wallpaper background** — displays a wallpaper behind the email list and reading pane when no email is selected
- **Mica transparency** — takes advantage of Windows 11 Mica blur effects
- **Unread highlighting** — blue left border and bold text on unread messages
- **Date group headers** — Today, Yesterday, Last 7 Days, etc.

---

## Requirements

- **Thunderbird 115 or later** (tested on 150)
- **Windows 10/11** recommended (Mica effects are Windows-only; the rest works on all platforms)

---

## Installation

### Step 1 — Enable userChrome.css

1. Open Thunderbird
2. Go to **Settings → General**
3. Scroll to the bottom and click **Config Editor…**
4. Search for `toolkit.legacyUserProfileCustomizations.stylesheets` and set it to **`true`**
5. Restart Thunderbird

### Step 2 — Enable Mica transparency *(Windows 11 only, optional)*

In the Config Editor:
- Set `widget.windows.mica` → **`true`**
- Set `widget.windows.mica.popups` → **`2`**

### Step 3 — Copy the theme files

1. In Thunderbird, go to **Help → Troubleshooting Information**
2. Next to **Profile Folder**, click **Open Folder**
3. Inside your profile folder, open (or create) a folder named **`chrome`**
4. Copy all files from this repository into that `chrome` folder:
   - `userChrome.css`
   - `custom.css`
   - `Titlebar_Icons/` folder
5. If you want a wallpaper background, place an image named **`wallpaper.jpg`** in the `chrome` folder. Remove or rename it if you do not want a background.
6. Restart Thunderbird

> Make sure **no other theme** is active in Thunderbird settings. Set the theme to **System Theme**.

---

## Optional Addons

Both addons are WebExtension experiments and require one extra config change before installing.

**Enable addon experiments (one-time setup):**

1. Open the Config Editor (`Settings → General → Config Editor…`)
2. Search for `extensions.experiments.enabled` and set it to **`true`**
3. Search for `xpinstall.signatures.required` and set it to **`false`**

### Sender Avatar Circles

Adds coloured initials circles next to every email row, just like Outlook.

**Install:**
1. Download `sender-avatars.xpi` from the [Releases](../../releases) page
2. In Thunderbird, go to **Add-ons and Themes** (`Tools → Add-ons and Themes`)
3. Click the gear icon → **Install Add-on From File…**
4. Select `sender-avatars.xpi`
5. Restart Thunderbird

### Trash Button *(optional)*

Adds a clickable trash icon to each email row that moves the email to Trash. Supports Ctrl+Z undo.

**Install:**
1. Download `trash-button.xpi` from the [Releases](../../releases) page
2. Follow the same install steps as above, selecting `trash-button.xpi`
3. Restart Thunderbird

---

## Uninstalling

- **Theme:** delete `userChrome.css`, `custom.css`, and the `Titlebar_Icons` folder from your `chrome` directory, then restart.
- **Addons:** go to **Add-ons and Themes**, find the addon, and click **Remove**.

---

## Known Issues

- Mica transparency only works on Windows 11.
- Some areas of Thunderbird (Settings pages, compose window, popups) are rendered in a Shadow DOM and cannot be themed via userChrome.css.
- Calendar, Tasks, and Chat sections have limited styling coverage.

---

## Credits

Titlebar icons (maximise button) are from the [FluentBird](https://www.dannyking.co.uk) project by **Danny King** — thank you!

Fluent Design icons are provided by Microsoft, licensed under the MIT License.
Copyright (c) Microsoft Corporation.

---

## License

MIT License — free to use, modify, and share.
