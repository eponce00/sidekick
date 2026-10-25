# Browser data import

SideKick imports bookmarks and history from browsers on the same computer so the Browser panel's
bookmark list and address suggestions start with the user's own pages. What the user sees is
described in [Visual browser](../user-guide/BROWSER.md#bookmarks-and-history-from-your-other-browsers);
this page covers the trusted design.

## What is read, and what never is

| Browser                            | Bookmarks                                | History                        |
| ---------------------------------- | ---------------------------------------- | ------------------------------ |
| Chrome, Edge, Brave, Chromium, Arc | `Bookmarks` (JSON)                       | `History` (SQLite, `urls`)     |
| Firefox                            | `places.sqlite` (`moz_bookmarks`)        | `places.sqlite` (`moz_places`) |
| Safari                             | `Bookmarks.plist` (binary property list) | `History.db` (SQLite)          |
| Any browser's export               | Netscape bookmark HTML file              | —                              |

Profile folders come from each browser's documentation: Chromium's
[user data directory](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)
and its `Local State` profile names, Firefox's `profiles.ini`
([where Firefox stores user data](https://support.mozilla.org/kb/profiles-where-firefox-stores-user-data),
[Places schema](https://searchfox.org/firefox-main/source/toolkit/components/places/nsPlacesTables.h)),
and `~/Library/Safari`. Only Chromium folders named `Default` or `Profile N` are opened; Firefox
profiles whose relative path leaves the folder holding `profiles.ini` are skipped.

Cookies, saved passwords, autofill, and session files are never opened. Chromium's
[app-bound encryption](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/os_crypt/app_bound_encryption_win.h)
on Windows, and the Keychain on macOS, exist so that other programs cannot read sign-ins; reading
them is what credential stealers do, and SideKick does not attempt it. The agent's browser
partition is in memory per chat in any case (see
[Native visual browser](OVERVIEW.md#native-visual-browser)), so imported cookies would not last.
Sign-ins go through [stored credentials](CREDENTIALS.md) or the user signing in in the panel.

## Process boundary

All reading happens in the main process, in `src/main/services/browserImport`:

- `browserProfiles` finds browsers and profiles for the current platform. The renderer receives
  browser names and profile display names with an opaque id, never a folder.
- `BrowserImportService` resolves a request by finding the profiles again and matching the browser
  and id exactly, so the renderer cannot name a folder, a parent path, or a profile it was not
  shown. Imports run one at a time.
- A bookmarks file is chosen in a system open dialog in the main process; the renderer never
  passes a path.
- `BrowserLibraryStore` keeps the results in SideKick's database (`browser_library_sources`,
  `browser_library_bookmarks`, `browser_library_history`). The renderer reads them through
  `window.api.browserLibrary`: a bookmark list, up to six suggestions for typed text, and the
  sources with counts. Nothing in the agent's tool registry reads these tables.

Nothing imported is secret: addresses that carry a username or password are dropped rather than
stored, so no `safeStorage` encryption is involved.

## Reading other programs' files safely

The files belong to another program and may be damaged or crafted, so each reader bounds its work:

- A file is opened only if `lstat` shows a regular file under a size limit; links are refused
  rather than followed.
- SQLite databases are copied, with any `-wal` or `-journal` file, to a private temporary folder
  and opened there, so a running browser is not disturbed and its lock does not block the import.
  SQLite brings the copy to its last committed state. The connection sets `trusted_schema = OFF`
  and `query_only = ON`, checks that each table it queries is a table rather than a view, and reads
  with a row limit. The folder is deleted afterwards, whether or not reading succeeded.
- JSON and property-list trees are walked with an explicit stack, never recursion, with a node
  budget and a folder-depth limit. Firefox folders are entered once each.
- The binary property list reader checks every offset, length, and reference against the file,
  resolves each object once, refuses reference loops and nesting past 64 levels, and builds
  dictionaries without a prototype.
- The bookmark HTML scanner finds each tag's end with `indexOf`, parses attributes in one pass,
  and stops searching for a closing tag once the rest of the file lacks it, so its time stays
  linear in the file's size.
- Every address must parse as `http:` or `https:` with no user information and at most 2,048
  characters; titles lose control and bidirectional-override characters and are cut to 300
  characters. One import keeps at most 20,000 bookmarks and the 20,000 most visited pages.

Tests in the same folder cover each format with fixtures written in the browsers' own layouts,
plus adversarial cases for all of the above.
