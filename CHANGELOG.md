# Changelog

## 3.3.3

This release is a substantial visual and quality-of-life overhaul of the original theme.

### Interface

- Reworked message cards with improved density, spacing, borders, corners, hover, selection, and unread states.
- Refined folder pane, tabs, Spaces toolbar, message header, reading-pane actions, light mode, and dark mode.
- Corrected positioning for the date, time, menu, star, attachment, and quick-delete controls.
- Reduced the gap between sender avatars and message text.
- Added responsive narrow-window rules, visible keyboard focus, and reduced-motion support.
- Preserved Thunderbird's favourite star while adding a separate delete action.

### Account switcher

- Replaced Favourite Folders with a one-click Email Accounts list.
- Opens All Mail, falling back to Inbox, without expanding or scrolling All Folders.
- Automatically groups common mail providers and creates headings for other domains.
- Added user-created headers with account assignments.
- Added optional flat/ungrouped mode.
- Added drag-and-drop ordering for accounts and whole groups.
- Added Compact, Comfortable, and Spacious account row sizes independent of Thunderbird's global font size.
- Added per-account visibility controls and an option to hide All Folders.
- Added optional live unread-count badges with consistent rounded styling.
- Added an option to hide the account header buttons, with right-click access to restore the options.
- Fixed duplicate shortcuts, stale multi-selection highlighting, provider regrouping, reset-order behaviour, and unwanted folder-tree scrolling.

### Behaviour and reliability

- Opens initial date groups automatically when the mail view loads.
- Preserves the message-list scroll position when a visible email is selected.
- Combined Sender Avatars and Trash Button into one add-on with a single lifecycle.
- Narrowed and debounced account observers to remain responsive with large account collections.
- Added reliable cold-start handling for delayed Thunderbird windows, message trees, Favourite Folders, and account rows.
- Added explicit background and mail-window startup listeners.

## 1.0

- Initial Outlook-style CSS theme.
- Customisable wallpaper and Windows Mica support.
- Separate Sender Avatars and optional Trash Button add-ons.
- Basic unread highlighting and date-group styling.
- Optional `user.js` preferences for suppressing Thunderbird's welcome/update pages.
