# Chatting with SideKick

## While a reply is being written

- **Steer:** send a message while the agent works to redirect it. The message joins the running
  reply before its next model step, without cutting off a tool call or the text being written, and
  appears in the reply where the agent took it in. When the reply cannot take it (it is waiting on
  an approval or a question, or is finishing), SideKick stops the reply and starts a new one from
  your message instead.
- **Queue:** a message added to the queue waits for the reply to finish and is sent next.
- **Waiting on you:** a conversation that needs an approval or an answer is marked in the sidebar,
  counted on the taskbar or dock icon, and announced by a notification when SideKick is not in
  front. A failed reply is announced the same way.

## The message box

- **Drafts:** what you have not sent stays with its conversation, including attachments, when you
  switch chats or restart SideKick.
- **Earlier messages:** in an empty box, or with the cursor at its very start, **↑** brings back
  what you sent before in this conversation, and **↓** returns to what you were writing.
- **Comments on changes:** in a reply's file changes, click a line number (shift-click to extend
  the range) and write a comment. It is attached to your next message as a card, with the file,
  the lines, and the quoted change, for the agent to act on.
- **Commands:** type `/` for the message box's own commands, such as the model, plan, research, and
  goal.

## After an interruption

A reply cut off because SideKick closed ends with **Interrupted** and a **Continue** button. Continue
picks the work up from what the reply had already done. A step whose outcome is unknown is checked
before it is repeated. Quitting while agents are working asks for confirmation first.

## Keyboard

**Ctrl+K** (**⌘K** on macOS) opens the command palette: search conversations, projects, and actions,
each shown with its shortcut.

| Keys (macOS: ⌘ for Ctrl)   | Action                                         |
| -------------------------- | ---------------------------------------------- |
| Ctrl+K                     | Command palette                                |
| Ctrl+N                     | New chat                                       |
| Ctrl+O                     | Open a project folder                          |
| Ctrl+,                     | Settings                                       |
| Ctrl+1 … Ctrl+9            | Go to a conversation by its place in the list  |
| Ctrl+Shift+[ / ]           | Previous or next conversation                  |
| Ctrl+Space (macOS: ⌥Space) | Turn [voice](VOICE.md) on or off               |
| Ctrl+Shift+V               | Paste long text inline instead of attaching it |
| Enter / Shift+Enter        | Send / new line                                |
| Esc                        | Close a menu, or skip a reply being read aloud |
| Ctrl + / - / 0             | Zoom in, out, or reset                         |
