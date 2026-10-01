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

## Checked changes

When a reply changed files in a project that defines a check, its footer says whether one ran
afterwards: **Checks passed**, **Checks failed**, **Checks out of date**, or **Not checked**. A check
is a test, build, typecheck, or lint command from the project's manifest, such as the scripts in
`package.json`; reading files back or viewing a page does not count. Changes outside such a project,
like a standalone page or document, have no check, so the reply shows no status and the agent is
not asked for one. Select the status
to see the commands and their results. The footer appears when you point at the reply, except after
a failed check, which stays in sight.

## Sub-agents

When the agent delegates part of the work, the reply shows a row for the task. While the
sub-agent works, the row shows what it is doing now, how many tools it has used, and for how long,
and says so when it has produced nothing for a few minutes. Once it is done, the row shows the start
of its report.

- **Open the row** to see the sub-agent's own transcript in place of the chat: the task it was
  given, then everything it did, live while it works. **Back** or **Esc** returns to the chat where
  you left it.
- **Its questions and approvals** appear under the row, and count as the conversation waiting on
  you.
- **Stop** on the row stops only the sub-agent; the reply carries on with what it found. Stopping
  the reply also stops its sub-agents.
- **Its tool budget** is 25 rounds, or the reply's own if that is smaller. It is told to stop once
  it has what the task asks for. When the budget runs out, it reports what it found and what it left
  unchecked, instead of asking to continue; the agent can delegate again.
- **Several at once:** tasks the agent delegates together are each approved in turn, then start
  together. How many run at once is set per provider in Settings, under **Sub-agents at once** (one
  by default); the rest show as queued until one finishes. More than one helps a server that keeps
  several prompts cached or serves several requests at once.

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
