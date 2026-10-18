# Desktop integration contract

SideKick targets macOS, Windows, and Linux as first-class desktop platforms. Shared React components
own product behavior, while Electron's trusted main process owns operating-system integration.
Platform differences are explicit; the renderer does not infer them from user-agent strings.

## Text editing and contextual actions

All editable fields use Chromium/Electron spellcheck and an Electron menu template drawn in
SideKick's style (see [Menus and dialogs](#menus-and-dialogs)). The menu includes suggestions,
dictionary learning, undo/redo, cut/copy/paste, paste-and-match-style, delete, and select all.
Links add Open in Browser and Copy Link; images add Copy Image and Copy Image Address. A menu with a
macOS-only item (Services, Speech, Substitutions) and a menu from an embedded frame stay native.

- macOS uses the native spellchecker and automatic language detection. Selected text also exposes
  Lookup, Speech, Substitutions, and the system Services menu. Writing Tools can appear through the
  operating-system Services integration when the Mac, language, and OS support it. Electron does
  not expose Apple's full native grammar panel as a Chromium menu role, so SideKick must not label
  basic spellcheck as grammar checking.
- Windows uses Electron's Hunspell integration. SideKick selects up to four installed dictionaries
  from the user's preferred Windows languages instead of forcing US English. The OS locale remains
  the fallback when no preferred installed dictionary matches.
- Linux also uses Electron's installed Hunspell dictionaries and preferred system languages. The
  available languages depend on the distribution and desktop environment.

References: [Electron spellchecker](https://www.electronjs.org/docs/latest/tutorial/spellchecker/),
[Electron menu roles](https://www.electronjs.org/docs/latest/api/menu-item), and
[Apple spelling and grammar behavior](https://support.apple.com/guide/mac-help/typing-suggestions-correct-mistakes-mac-mchlp2299/mac).

## Menus, shortcuts, and windows

The native application menu is deliberately installed on all platforms so development never
inherits Electron's generic menu.

| Action       | macOS               | Windows  | Linux    |
| ------------ | ------------------- | -------- | -------- |
| New chat     | `Command+N`         | `Ctrl+N` | `Ctrl+N` |
| Open project | `Command+O`         | `Ctrl+O` | `Ctrl+O` |
| Settings     | `Command+,`         | `Ctrl+,` | `Ctrl+,` |
| Full screen  | `Control+Command+F` | `F11`    | `F11`    |
| Close window | `Command+W`         | `Alt+F4` | `Alt+F4` |

macOS uses native hidden-inset chrome, traffic lights, Spaces full screen, tiling, Dock identity,
and standard close-versus-quit behavior. Windows keeps SideKick's caption buttons; maximize changes
to a restore glyph when appropriate. Right-clicking the Windows title bar or pressing `Alt+Space`
opens the conventional restore/minimize/maximize/close menu. Window size and position are persisted,
clamped to a connected display's work area, and discarded if a saved window was stranded on a
disconnected monitor. Linux uses the same compact custom caption controls, persists maximize state,
and binds its reverse-DNS desktop filename, executable, icon, and `StartupWMClass` so GNOME, KDE,
and compatible desktops associate the running window with the SideKick launcher.

The custom Windows caption buttons do not participate in Windows 11's native Snap Layout hover
surface. SideKick intentionally retains its current caption-button design.

## Notifications and system surfaces

Response completion uses Electron's native Notification API. This lets Notification Center,
Windows notifications, Focus/Do Not Disturb, accessibility, and the user's system settings own the
presentation. Clicking a notification restores and focuses the originating SideKick window. The
in-app sound option maps to the native notification's `silent` flag; SideKick does not play a
second synthesized chime.

macOS notification behavior depends on application identity and may be limited for an ad-hoc or
self-signed community build. Windows notifications rely on the installed Start Menu shortcut and
matching AppUserModelID. Linux delivery depends on the active desktop notification service and the
AppImage's matching launcher identity. Development behavior is therefore not proof of packaged
notification behavior; all community packages need physical smoke coverage, and macOS notification
delivery must not be promised where the zero-cost identity cannot provide it.

Reference: [Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications).

## Tray and background work

Agent runs live in the main process, so they continue while no window is visible. On Windows and
Linux the main window's close is intercepted and the window hidden, while the `closeToTray`
setting is on (the default) and a tray icon could be created. The tray icon exists only while
that setting is on; turning it off restores close-to-quit. A close that belongs to a quit (the
quit sequence has started, the updater is restarting, or the operating system is ending the
session) is never intercepted. Quit from the tray or app menu goes through the same active-work
confirmation as any other quit; when the window is hidden, that dialog is shown unparented so it
stays visible.

The tray menu is rebuilt from a snapshot (working conversations, waiting conversations with their
titles, update state) after run events, coalesced so streaming does not rebuild it per token. A
waiting conversation adds the accent attention dot to the tray icon. Windows and Linux open the
window on a left click and the menu on a right click; Linux indicators that only support a menu
show it on any click. Electron cannot tell whether a Linux desktop actually displays tray icons,
so relaunching SideKick (which reveals the existing window) is the fallback there.

macOS gets no menu-bar extra. Closing a window there already leaves the app running, and the Dock
reopens it and badges the waiting count, so a second always-visible icon would duplicate the Dock.
The tray's contextual entries (New Chat and waiting conversations) go in the Dock menu instead.

The tray's shape (Open, New, a running-count status line, Settings, update entry, Quit, and
hide-on-close) follows Cline's desktop app; SideKick's implementation is independent.

## Menus and dialogs

Menus the main process opens, such as a file's actions, the browser's device sizes, the Windows
title-bar menu and the text menu, are drawn by the renderer in SideKick's style
(`src/main/services/appMenus.ts`, `AppMenuHost`). The main process keeps every action: it sends a
serializable description with a one-time token, and the renderer reports only the token and the
chosen item's id, for a menu opened for that window. Templates with roles only the system can
perform fall back to the native menu. The device menu opens over the page, which is a native view
drawn above the app, so the panel shows a capture of the page while that menu is open. Dropdowns are
`Select`, not `<select>`, so their lists are styled and float above dialogs.

Questions the main process must hear from the user directly, such as security-sensitive settings,
MCP connectors, permission prompts and quitting with active runs, use `showTrustedDialog`. It is a
modal child window with its own sandboxed page, built from escaped text with a strict content
security policy, that reports the answer by a navigation the main process intercepts. The app's
window cannot read, click or cover it, so it keeps the guarantee of a system dialog in SideKick's
style. It always opens over the app's own window, never a browser page's window parked off screen.
When SideKick is not in front, its taskbar entry flashes and a notification says what is being
asked. With the window minimized, in the tray or closed, it asks with the system dialog instead.
A tool waiting on the answer does not spend its time limit meanwhile (`whileWaitingForUser`), and
a caller can pass a signal that withdraws the question, as Cancel, when its run stops. The system
tray, the macOS menu bar and the page's own context menu in the browser stay native.

## Dialog and accessibility behavior

Settings is a full-window application workspace rather than a modal. It keeps the platform caption
controls available, provides a searchable section rail, and returns to the exact prior app view
through **Back to app**. Save and Cancel remain anchored while the selected section scrolls.

Primary modal surfaces expose dialog semantics, contain Tab focus, close with Escape, and restore
focus to the invoking control. Destructive confirmation dialogs initially focus Cancel. Focus rings
remain keyboard-visible, and global reduced-motion media queries collapse nonessential animation.
Platform terms are localized at the product level: Finder versus File Explorer, and Trash versus
Recycle Bin.

## Release smoke matrix

Automated tests cover menu structure, spellchecker language resolution, native context-menu
composition, notification byte bounds, title-bar menu state, platform mapping, and safe window-state
restoration. Before release, physically verify:

- macOS: traffic lights, tiling/full screen, `Command` shortcuts, Lookup/Services, automatic English
  and Spanish spelling, focus restoration, Dock icon and its menu, actual notification behavior,
  first-launch Gatekeeper approval, Finder reveal.
- Windows: caption buttons, maximize/restore glyph, title-bar right-click, `Alt+Space`, hidden menu
  via Alt, `Ctrl` shortcuts, English and Spanish suggestions, installed native notification,
  File Explorer reveal, Recycle Bin wording, multi-monitor restore, close to the notification
  area, tray click and menu, quit from the tray.
- Linux: AppImage executable permission and launch, caption buttons, maximize/restore glyph, hidden
  menu via Alt, `Ctrl` shortcuts, available dictionaries, desktop notification and launcher icon,
  file-manager reveal, Trash wording, X11 and Wayland desktop association, multi-monitor restore,
  tray icon on KDE and on GNOME with and without an AppIndicator extension.
