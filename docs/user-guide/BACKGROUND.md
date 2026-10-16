# Working in the background

Agents keep working when the SideKick window is out of the way. How you get the window back, and
how you quit, depends on the platform.

## Windows and Linux

Closing the window hides SideKick to its icon in the notification area (the system tray on
Linux). Agents carry on, approvals and questions still reach you as notifications, and the first
time the window hides SideKick tells you where it went.

- **Click the icon** to bring the window back.
- **Right-click the icon** for the menu:
  - **Open SideKick** and **New Chat**.
  - The chats waiting for your approval or answer, by title. Choose one to go straight to it.
  - How many chats have an agent working.
  - **Settings…** and **Check for Updates…**. Once an update has downloaded, this entry becomes
    **Restart to Update**.
  - **Quit SideKick**.

While a chat is waiting for you, the icon carries a small dot and its tooltip says how many
are waiting.

Quitting, from the tray or from the **File** menu (press **Alt** to show it), asks first when
agents are still working, as described in [After an interruption](CHAT.md#after-an-interruption).

To have closing the window quit SideKick instead, turn off **Close to the notification area**
(**Close to the system tray** on Linux) under **Settings → General → Background**. The tray
icon goes away with it.

Some Linux desktops, such as GNOME without an AppIndicator extension, show no tray icons. There,
open SideKick again from your launcher to bring the hidden window back, or turn the setting off.

## macOS

macOS keeps its usual behavior: closing the window leaves SideKick running in the Dock, and
clicking the Dock icon opens the window again. The Dock icon shows how many chats are waiting
for you, and its menu offers **New Chat** and those chats. Quit with **SideKick → Quit
SideKick** or **⌘Q**.
