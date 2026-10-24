# Use SideKick from your phone

SideKick can show your chats on your phone and let you drive them from there, while the agent keeps
running on your computer. The phone connects to the computer directly over your Wi-Fi. Nothing goes
through the internet or any other service, and there is no app to install.

## Connect a phone

1. Click the phone icon at the bottom of the sidebar, then turn on **Phone access**. A QR code
   appears.
2. Scan it with your phone's camera. SideKick opens in the phone's browser.

   The browser first warns that the connection is not private. SideKick makes its own certificate
   for your computer rather than one from a public authority, which no authority issues for a home
   network address, so the phone does not know it. Open the details (**Advanced** in Chrome, **Show
   Details** in Safari) and continue to the page. The browser may warn again after a while, or
   when the computer's address changes.

3. On the computer, SideKick asks whether to allow the phone, by its name (such as "iPhone ·
   Safari") and network address. Click **Allow**.

The phone then shows your chats. To open it like an app, use the browser's **Add to Home Screen**.
On iPhone and iPad it opens full screen.

The first time phone access is on, Windows may ask whether SideKick can use private networks; allow
it, or phones cannot connect.

## What the phone can do

The phone shows a chat as the computer does, laid out for a small screen: the agent's reply as it
streams, its thinking, the tools it runs with their output and the changes they made, images, cards
and the agent's other chats.

- **Send** a message in a chat, or start a new chat, in Chat, Research or Plan mode and on the model
  you choose for the chat.
- **Start a chat in a project** with the **+** beside the project in the chat list, or by choosing
  the project above the message box of a new chat. For a project in a Git repository, choose
  **New worktree** there to have the chat work in its own copy of the project, as **Work in** does
  on the computer.
- **Tap a message you sent** for **Copy**, **Read aloud**, **Edit** and **Retry**.
  **Edit** puts the message back in the message box to change and send again; **Retry** answers it
  again. Either way, the replies after it leave the chat, and the files SideKick changed since are
  put back, as on the computer. Where your permission settings ask before that, the computer asks.
  A reply's own buttons are always under it.
- **While the agent works**, a message you send is queued, as on the computer, and is sent when the
  reply finishes. The queue is the same one the computer's composer shows: edit, reorder or remove
  messages from either, or **Steer** one to hand it to the agent now. Editing a queued message on
  the phone puts it in the message box, as editing a sent one does; send it to save the change. A message steered while the
  agent waits for you, or is finishing, stops the reply and starts the next one.
- **Attach** photos from the phone, take one with the camera, or attach text files such as notes,
  logs or code. Photos are reduced on the phone before they are sent. The chat's model must be able
  to see images.
- **Dictate** with SideKick's microphone button: tap it and your words appear in the message box
  as you speak, written by the computer's own dictation. Tap it again to stop, or send the message,
  which stops it too. Replies are read aloud only when you tap **Read aloud**. The first time, the
  browser asks whether the page may use the microphone.
- **Read aloud** a reply: the computer speaks it in its own voice, and the phone plays it.
- **Copy** a reply: it pastes with its headings, lists and tables where the app you paste into
  keeps formatting, such as notes or mail, and as plain text everywhere else.
- **Stop** a running agent.
- **Answer** approval cards, questions, plan reviews and tool-limit prompts. Cards that act on the
  computer itself, such as starting chats in project folders or taking over the browser, are
  answered on the computer.

Dictation and read aloud need **Voice** turned on in the computer's Settings. The phone never sees
stored credentials or settings, cannot browse your files, and cannot type into terminals. Images it
shows from chats are reduced copies.

## Who can connect

Only phones you allowed. Each QR code works once and for two minutes, and a phone that scanned it
still needs your **Allow** on the computer. The secret in the code never travels over the network,
and everything between the phone and the computer is encrypted, so someone else on the Wi-Fi cannot
read it or join in by copying the link.

The page is served over HTTPS with SideKick's own certificate, which is what lets it use the
microphone. The certificate does not decide who connects: pairing and the encryption above do.

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
