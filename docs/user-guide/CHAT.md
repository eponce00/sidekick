# Chatting with SideKick

## While a reply is being written

- **Steer:** send a message while the agent works to redirect it. The message joins the running
  reply before its next model step, without cutting off a tool call or the text being written, and
  appears in the reply where the agent took it in. When the reply cannot take it (it is waiting on
  an approval or a question, or is finishing), SideKick stops the reply and starts a new one from
  your message instead.
- **Queue:** a message added to the queue waits for the reply to finish and is sent next. Drag
  queued messages to reorder them. **Edit** moves one into the message box, as editing a sent
  message does; sending saves it back in the queue, and **Cancel** or Esc leaves it as it was and
  brings back what the box held.
- **Live progress:** a line at the foot of the reply shows what the agent is doing (waiting for
  the model, thinking, using tools, writing, compacting context, or waiting for you), how long it
  has worked since your message, how many tokens the model has written and how fast, and how full
  its context is. The token count for a model step still being written is estimated from its text
  until the server reports it. Once the reply ends, its footer shows the totals when you point at
  it.
- **Compacting context:** when a long conversation reaches the share of the model's context that
  Settings names, counted the way the model counts it, the agent pauses while the model summarizes
  the earlier messages, then carries on from the summary and the most recent work. On a local
  model this can take a minute or more, and nothing is written meanwhile. A **Context compacted**
  row marks the point in the reply. A finished summary is kept even if you then stop the reply,
  retry it or edit your message, so the next reply does not summarize the same messages again.
  A chat left alone for two minutes after a reply, close enough to that point that the next
  reply would summarize first, is summarized then instead, so your next message starts at once.
  This uses the model only while no other reply needs it, and steps aside when one does.
  When the latest tool results alone outgrow a small window and there is little earlier history,
  SideKick shortens those results instead, and a **Context fitted** row says how many.
- **Waiting on you:** a conversation that needs an approval or an answer is marked in the sidebar,
  counted on the taskbar or dock icon and listed in the tray menu, and announced by a notification
  when SideKick is not in front. A failed reply is announced the same way. See
  [Working in the background](BACKGROUND.md).

## Questions from the agent

When the agent needs a decision, it asks in the reply, one question at a time, with numbered
choices and a field for an answer of your own.

- **Answer:** click a choice, or press its number. Arrow keys move between the choices and the
  field. A question that takes several answers has square marks and a **Next** or **Send answers**
  button.
- **Skip** passes over one question; **Cancel** dismisses all of them without answering.
- **Once answered,** the question folds to one line showing what was asked and what you chose.
  Select it to see every question and answer.

## Checked changes

When a reply changed files in a project that defines a check, its footer says whether one ran
afterwards: **Checks passed**, **Checks failed**, **Checks out of date**, or **Not checked**. A check
is a test, build, typecheck, or lint command from the project's manifest, such as the scripts in
`package.json`; reading files back or viewing a page does not count. Changes outside such a project,
like a standalone page or document, have no check, so the reply shows no status and the agent is
not asked for one. Select the status
to see the commands and their results. The footer appears when you point at the reply, except after
a failed check, which stays in sight.

## Artifacts

When you ask for something live, such as a chart, a calculator or a small tool, the agent can build
it as an artifact that runs inside the reply.

- **Takes shape as it is written:** the artifact appears in the reply while the agent is still
  writing it, and grows piece by piece as the code arrives: what is already there stays put, new
  parts appear where they belong, and a part whose code has not arrived yet shows as a plain
  placeholder. Nothing flashes or animates while it grows: charts appear already drawn. Beneath it,
  a short line says what it is doing: **Writing**, **Checking how it looks**, or **Polishing**
  while a fix is made. A fixed version replaces it in place once it has settled, without drawing
  its charts in again; a version that fails along the way is never shown. While it is still being
  written it does not load data; the finished version does.
- **Changes in place:** ask for a change to an artifact, such as a color or a new column, and the
  agent edits just that part of it, which takes seconds rather than writing it again. Within a
  reply, the artifact stays where it is and says **Updating** until the changed version replaces
  it; a change asked for in a later message shows the new version in that reply, and the earlier
  one stays as it was.
- **Part of the reply:** an artifact sits in the reply like an image, as wide as the text, with no
  card or frame around it. It uses SideKick's font, colors and accent, and follows your light or
  dark theme and accent as you change them.
- **As tall as it needs:** it grows to fit what it shows, and grows or shrinks smoothly when that
  changes. While it first renders, one quiet line holds its place. Something taller than about two
  screens stops there and scrolls inside; open it full screen to see all of it. Scrolling over an
  artifact that does not scroll itself scrolls the chat.
- **Controls when you want them:** point at an artifact, or move focus into it, to see its name and
  three buttons beneath it: **View code** shows its code in its place, **Copy code**, and **Open
  full screen**, which shows it across the window until you press Esc or **Close**.
- **When it fails:** an artifact that could not run shows one line saying so. Select it to read the
  error, or choose **Retry**. An error after it showed leaves it in place, with a short note under
  it.
- **On the phone,** an artifact shows as its name and a note to open it on the computer.

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
- **Images:** paste an image or choose one with **+**: PNG, JPEG, WebP, GIF, AVIF, or BMP, up to
  100 MB each and four per message. Size is not something to manage: the chat keeps the image as
  you attached it, and each model receives a copy made to fit what it takes, shrunk to its size
  and byte limits and converted when it cannot read the format. When the selected model will get a
  smaller copy, the image's tooltip says so. HEIC photos are not read yet; export them as JPEG.
- **Files:** type `@` to pick a project file. Its path goes into the message and the file is
  attached. Attached files, up to four per message, are read before the agent starts, so its first
  step already has their contents; the reads show in the reply like any other. In a chat without
  a project, **+** → **Files** attaches files from anywhere on your computer, up to 100 MB each:
  the chat keeps a copy in the `uploads` folder of its own folder, so the original is never
  changed, and the copies go when the chat is deleted.
- **Commands:** type `/` for the message box's own commands, such as the model, plan, research, and
  goal, and for your saved prompts.
- **Saved prompts:** a Markdown file in `.sidekick/prompts`, in the project or in your home folder,
  is offered as `/` followed by its file name. A `description:` line in a leading `---` block
  describes it in the menu. Claude Code's `.claude/commands` folders are read too. Choosing one fills
  the message box; where the prompt says `$ARGUMENTS`, that word is selected so you type over it.
- **Permissions:** the shield beside the model shows and changes the
  [permission mode](PERMISSIONS.md), one setting for every chat: Full access, the default, or a mode
  that asks first. A change applies from the next reply.
- **Model:** each conversation keeps the model chosen in it, so choosing a model in one
  conversation never changes another. A new conversation starts on the model chosen most recently
  in any conversation. Retries, continued replies, and chats a conversation starts use its model; a
  scheduled run uses its schedule's. When a conversation's model is removed or turned off in
  Settings, the picker marks it **Unavailable** and the message box asks you to choose another
  before sending, rather than switching models for you.
- **Reasoning:** for a model that lets you choose how much it reasons, the model picker shows the
  level beside its name and opens on a slider with a stop for each level that model takes; its name
  opens the list of models, and the reset button beside the level returns to the model's own
  default. Each model keeps its own level. The levels are the ones the model's server lists for it
  when you load its models in Settings:

  | Provider             | What the server says                                                  |
  | -------------------- | --------------------------------------------------------------------- |
  | LM Studio 0.4.8+     | Each model's allowed options, such as Off and On, and its default     |
  | Ollama, Ollama Cloud | Each model's `think` values, such as On and Off, or Low, Medium, High |
  | Anthropic            | Whether thinking can be off, and each effort level the model takes    |
  | OpenRouter           | Each model's efforts, its default, and whether reasoning can stop     |
  | LiteLLM              | Each deployment's effort levels, where its model info lists them      |
  | llama.cpp            | Whether the loaded chat template takes an effort or switches on/off   |

  Where a server says a model reasons but lists no levels, the picker offers what its protocol can
  send. A model that cannot reason, always reasons the same way, or whose server says nothing, as
  with a generic OpenAI-compatible server such as vLLM, has no reasoning control and uses its own
  default; mark its Reasoning capability as supported in its settings to choose a level for it. A
  server that
  rejects a level answers with the model's default instead of failing. The command palette's
  Reasoning entry steps to the next level. In a reply, each step of reasoning shows the same brain
  among the agent's steps; select it to read it in full.

## Tables in replies

A table in a reply gives each column room for its content on one line, up to a limit, so short
columns such as names and numbers never wrap; when the table is wider than the chat, it scrolls
sideways inside its card. Drag a column header's right edge to resize the column, or focus the edge
and use the arrow keys. Double-click the edge, or press **Enter** on it, to fit the columns to their
content again.

## The side panel

The panel beside the chat works with tabs, like a browser's. Each tab shows one app: **Files**,
**Browser**, **Terminal**, and **Chats** for a chat that started others. **+** opens a new tab
showing the apps; choose one and the tab becomes it. An app is open once: choosing one that is
already open goes to its tab. Close a tab with its **×** or a middle click; closing the last one
leaves a new tab.

Drag a tab along its row to reorder it. Drag it onto the top or bottom of the page below the tabs to
give it a section of its own above or below, with its own tabs, up to four; drag the line between
two sections to share the height between them. Drop a tab on another section's row, or in the
middle of its page, to move it there. The panel keeps its tabs and sections for next time.

Drag **Files**, **Browser** or **Terminal** out of the window and let go to open it in a window of
its own, for the same chat, where you let go. Its title bar names the app and the chat; **Put back**
returns it to the panel. While it has its own window, choosing it in the panel brings that window
forward, and closing SideKick's main window closes it too.

Drag the panel's left edge to resize it. While you drag, nothing else moves: a tinted outline shows where the panel will land,
with an icon for what letting go will do. Let go, and the panel glides there in one motion as the
chat and the left sidebar make room.

- Near the **narrow** column or an **even split** with the chat, the outline settles on it with a
  little spring. Anywhere in between, the panel stays where you leave it, and SideKick remembers
  the width.
- Past the point where the chat would get too narrow, the outline takes the **full window**: the
  chat steps aside and the left sidebar folds to its thin rail, so a browser page, for example, gets
  the whole window. Drag back to bring them back. Opening the sidebar also returns the panel beside
  the chat.
- Nearly shut, the outline shrinks to the rail and the panel **folds away** to its tab icons when
  let go. Click an icon, or drag out from the rail, to open it again at the width it had.
- **Esc** while dragging leaves the panel as it was.

The fold button at the end of the first row of tabs also folds the panel away. Double-click the
edge to switch
between the narrow column and the even split; the arrow keys move a focused edge.

In **Files**, the trash button beside a file or folder, or **Move to Recycle Bin** (**Move to
Trash** on macOS and Linux) in its right-click menu, asks first, saying how many items a folder
holds, and then moves it to the Recycle Bin, where you can restore it. The project folder itself and
Git's `.git` folders cannot be moved this way.

## Going back

- **Rewind to here** on a message you sent goes back to before it without asking again: the
  message and everything after it leave the chat, and the message returns to the box to change or
  send. When SideKick changed the project's files since that message, it asks what to do with
  them: **Rewind chat and files** also undoes those changes, as
  [Workspace History](WORKSPACE_HISTORY.md) restores them, and **Chat only** leaves files as they
  are. With no file changes since, it just rewinds.
- **Undo** on a reply that changed files takes back that reply's changes and keeps the chat.
- **Edit** on a message you sent moves it into the message box, with its images, attachments,
  mode, and goal, and blurs it and everything after it. Change it with anything the box offers,
  then send: the message and what followed are replaced and SideKick answers again from there, the
  same way a rewind does. **Esc** or **Cancel** puts back what the box held before.
- **Retry** rewinds to the message and asks again at once.
- When the files cannot be restored, for example because one was changed since or the restore was
  not approved, a rewind, retry or edit keeps every message, starts no new reply, and says why in
  the chat.
- A reply after a rewind, retry or edit reads a file again before changing it, even one an earlier
  reply read, since that reply is no longer in the chat.

## After an interruption

A reply cut off because SideKick closed ends with **Interrupted** and a **Continue** button. Continue
picks the work up from what the reply had already done. A step whose outcome is unknown is checked
before it is repeated. Quitting while agents are working asks for confirmation first.

## When a reply fails

A failed reply's heading says what went wrong, such as **Model server unreachable**, **Model
server timed out**, **Provider refused access**, or **Model not set up**, and its message says what
to check. Once that is fixed, for example the model server is running again or the key is
corrected, **Continue** picks up from where the reply stopped and keeps its work; **Retry** starts
it over. SideKick retries some failures itself before failing: a chat too long for the model's
window is compacted, older images are dropped when the model takes fewer, a reply limit above the
provider's maximum is lowered to it, and a reply whose connection to the model server drops
partway, as when a local server restarts or swaps models, is asked again once a few seconds later.
What it had written is replaced by the new attempt, and a row in the reply says the connection was
lost.

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
| Ctrl + / - / 0             | Text size larger, smaller, or back to 100%     |

The text-size shortcuts and **Settings → Appearance → Text size** are one setting. Each step sizes
the whole window, text and interface together, through 80, 90, 100, 110, 120, 135, and 150%.
