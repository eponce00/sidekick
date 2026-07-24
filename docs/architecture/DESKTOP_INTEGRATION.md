# Desktop integration contract

SideKick targets macOS and Windows as first-class desktop platforms. Shared React components own
product behavior, while Electron's trusted main process owns operating-system integration. Platform
differences are explicit; the renderer does not infer them from user-agent strings.

## Text editing and contextual actions

All editable fields use Chromium/Electron spellcheck and a native Electron menu. The menu includes
suggestions, dictionary learning, undo/redo, cut/copy/paste, paste-and-match-style, delete, and
select all. Links add Open in Browser and Copy Link; images add Copy Image and Copy Image Address.

- macOS uses the native spellchecker and automatic language detection. Selected text also exposes
  Lookup, Speech, Substitutions, and the system Services menu. Writing Tools can appear through the
  operating-system Services integration when the Mac, language, and OS support it. Electron does
  not expose Apple's full native grammar panel as a Chromium menu role, so SideKick must not label
  basic spellcheck as grammar checking.
- Windows uses Electron's Hunspell integration. SideKick selects up to four installed dictionaries
  from the user's preferred Windows languages instead of forcing US English. The OS locale remains
  the fallback when no preferred installed dictionary matches.

References: [Electron spellchecker](https://www.electronjs.org/docs/latest/tutorial/spellchecker/),
[Electron menu roles](https://www.electronjs.org/docs/latest/api/menu-item), and
[Apple spelling and grammar behavior](https://support.apple.com/guide/mac-help/typing-suggestions-correct-mistakes-mac-mchlp2299/mac).

## Menus, shortcuts, and windows

The native application menu is deliberately installed on both platforms so development never
inherits Electron's generic menu.

| Action       | macOS               | Windows  |
| ------------ | ------------------- | -------- |
| New chat     | `Command+N`         | `Ctrl+N` |
| Open project | `Command+O`         | `Ctrl+O` |
| Settings     | `Command+,`         | `Ctrl+,` |
| Full screen  | `Control+Command+F` | `F11`    |
| Close window | `Command+W`         | `Alt+F4` |

macOS uses native hidden-inset chrome, traffic lights, Spaces full screen, tiling, Dock identity,
and standard close-versus-quit behavior. Windows keeps SideKick's caption buttons; maximize changes
to a restore glyph when appropriate. Right-clicking the Windows title bar or pressing `Alt+Space`
opens the conventional restore/minimize/maximize/close menu. Window size and position are persisted,
clamped to a connected display's work area, and discarded if a saved window was stranded on a
disconnected monitor.

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
matching AppUserModelID. Development behavior is therefore not proof of packaged notification
behavior; both community packages need physical smoke coverage, and macOS notification delivery
must not be promised where the zero-cost identity cannot provide it.

Reference: [Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications).

## Dialog and accessibility behavior

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
  and Spanish spelling, focus restoration, Dock icon, actual notification behavior, first-launch
  Gatekeeper approval, Finder reveal.
- Windows: caption buttons, maximize/restore glyph, title-bar right-click, `Alt+Space`, hidden menu
  via Alt, `Ctrl` shortcuts, English and Spanish suggestions, installed native notification,
  File Explorer reveal, Recycle Bin wording, multi-monitor restore.
