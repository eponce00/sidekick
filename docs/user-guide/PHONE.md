# Use SideKick from your phone

SideKick can show your chats on your phone and let you drive them from there, while the agent keeps
running on your computer. The phone connects to the computer directly over your Wi-Fi. Nothing goes
through the internet or any other service, and there is no app to install.

## Connect a phone

1. Click the phone icon at the bottom of the sidebar, then turn on **Phone access**. A QR code
   appears.
2. Scan it with your phone's camera. SideKick opens in the phone's browser.
3. On the computer, SideKick asks whether to allow the phone, by its name (such as "iPhone ·
   Safari") and network address. Click **Allow**.

The phone then shows your chats. To open it like an app, use the browser's **Add to Home Screen**.
On iPhone and iPad it opens full screen.

The first time phone access is on, Windows may ask whether SideKick can use private networks; allow
it, or phones cannot connect.

## What the phone can do

- See your chats and each agent's progress as it happens: its reply, the tools it runs, and its
  status.
- Send a message in a chat, or start a new chat. While the agent is working, a message you send is
  handed to it, as one sent from the computer's composer is. If it stops before reading it, the
  message is saved to the chat, so the next reply reads it.
- Stop a running agent.
- Answer approval cards, questions and plan reviews. Cards that act on the computer itself, such as
  starting chats in project folders or taking over the browser, are answered on the computer.

The phone never sees stored credentials or settings, cannot browse your files, and cannot type into
terminals. Images in chats are not sent to the phone.

## Who can connect

Only phones you allowed. Each QR code works once and for two minutes, and a phone that scanned it
still needs your **Allow** on the computer. The secret in the code never travels over the network,
and everything between the phone and the computer is encrypted, so someone else on the Wi-Fi cannot
read it or join in by copying the link.

The phone icon shows a dot while a phone is connected. **Paired phones** in the same panel lists
every phone with when it was last used; **Remove** disconnects one at once, and it must scan a new
code to come back. Turning **Phone access** off closes every connection, and SideKick stops
listening on the network. Phone access stays on across restarts until you turn it off.

Turn phone access on only on Wi-Fi you trust, such as at home. Someone who controls the network
could tamper with the phone page as it loads; on public Wi-Fi, leave it off.

## When the phone cannot connect

- **Same Wi-Fi only.** The phone must be on the same network as the computer. Guest networks and
  some office networks keep devices apart, so phones cannot reach the computer there.
- **The computer's address changed.** The phone remembers the address it paired at. If the computer
  gets a new one, scan a new code, then remove the old entry from **Paired phones**. Your router's
  address reservation keeps it the same.
- **The phone was removed** or its browser data was cleared: scan a new code.

See the [phone companion design](../architecture/PHONE_COMPANION.md) for how pairing and encryption
work.
