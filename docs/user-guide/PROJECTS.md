# Projects and conversations

SideKick treats a project as a durable, folder-backed context boundary and a conversation as one
focused thread within that boundary. This follows the current Codex desktop model while preserving
standalone chats for work that does not belong to a folder.

## Product model

- A project has a stable identity, display name, local folder, pin state, and its own conversation
  collection.
- A project conversation inherits the project folder, file tools, command working directory,
  checkpoints, project memory, and instruction files.
- A standalone conversation has no project folder and therefore does not silently inherit file or
  command context from the last project that happened to be open. It works in a folder of its own
  inside SideKick's data instead, so its file and command tools, browser downloads, Terminal and
  History work there. The Files panel shows it as **Chat files**. Paths outside it are refused as
  they are outside a project. A fork starts with a copy of its files, moving the chat into a
  project switches it to the project's folder, and deleting the chat deletes its folder. A chat
  detached from its project works in a folder of its own the same way until it is reattached.
- The global New Chat action creates a standalone chat. The plus action beside a project creates a
  chat inside that project. A new chat left before anything is sent in it goes away rather than
  waiting in the sidebar, unless something was typed in its message box; a worktree made for it
  goes too when nothing in it changed.
- A never-attached standalone conversation may enter one project. That canonical folder becomes its
  durable affinity. It may later detach to Chats and reattach only to that same folder; direct or
  indirect moves between different projects are rejected.
- Removing a project never deletes or changes its folder. Its conversations are retained as
  detached chats with project History visible but read-only until the original folder is reopened
  and the chat is reattached.

## Several folders in one project

A project can work across several folders, such as an app and the library it uses, or two
repositories that change together. One folder is the **primary** one: chats start in it, commands
run there unless told otherwise, and its Git branch, pull request status, instructions, memory and
worktrees are the project's. The other folders are added beside it, each under a short name.

Open **Edit project…** from a project's **⋯** menu in the sidebar, or from the command palette:

- **Add folder** picks a folder in the folder picker. Its name is the folder's own name, with a
  number added when the project already has one of that name or the primary folder holds a file or
  folder of that name. A folder inside one of the project's folders, or around one, is refused: add
  folders that sit side by side.
- **Make primary** (the star) swaps that folder with the primary one. The project's chats, memory
  and folder list stay with the project.
- **Remove** (the cross) takes a folder out of the project. Its files stay where they are. The
  primary folder cannot be removed; make another folder primary first.

Removing a folder or changing the primary one waits until none of the project's chats is working.

How the agent uses the folders:

- A relative path means the primary folder. A path in another folder starts with its name, as
  `api/src/index.ts`, and an absolute path inside a folder works too. The system prompt lists every
  folder by name and path. Should the primary folder have a folder of the same name as another
  folder, `./api/...` names the primary's own.
- Reading, searching, editing, writing, deleting and patching work in every folder the same way,
  with the same read-before-edit rule, change review and checks. One patch may change files in
  several folders; it is checked whole before anything is written.
- Commands start in the primary folder. The agent sets a command's working folder to another
  folder's name to run it there.
- Each folder's own instructions (`AGENTS.md`, `SIDEKICK.md`, `.sidekick/rules.md`) reach the agent
  the first time it uses that folder in a run, as nested instructions do.
- History keeps each folder's changes in that folder's own private history, and Undo, Retry, Edit
  and Rewind put every folder back together; see
  [Private workspace History](WORKSPACE_HISTORY.md).
- Every folder is a boundary of its own. Paths that climb out of one, and links that lead from one
  folder into another or outside the project, are refused, as for a single folder.

The Files panel shows one node for each folder, the primary one marked, and `@` in the composer
finds files in every folder. An attached file from another folder keeps its folder's name in its
path.

## Persistence and activation

`projects` stores the project identity and canonical primary folder path, and `project_folders` its
other folders with their names. `conversations.project_id` is the source of truth for membership;
`NULL` means standalone.

When a conversation is activated, the renderer resolves its project and updates the trusted
main-process workspace before rendering the conversation as active. The main process accepts only a
folder it already knows (a project's folders, a chat's own folder or worktree) as that workspace,
and makes a project, or adds a folder to one, only from a folder chosen in its folder picker. File
tools, shell commands,
memory, checkpoints, and the file explorer continue to use the main-process workspace boundary, but
that boundary is now derived from the active conversation instead of being an unrelated global UI
preference.

Workspace History is private application data and remains separate from a folder's own Git
repository. See [Private workspace History](WORKSPACE_HISTORY.md) for ownership, conflict, restore,
and lifecycle rules.

## Project instructions

Instructions are read again before every agent run so edits take effect without restarting SideKick.
Discovery follows the Codex/OpenCode directory-scope model within the project boundary:

1. Load the first user-wide file found at `~/.sidekick/AGENTS.override.md`,
   `~/.sidekick/AGENTS.md`, or `~/.agents/AGENTS.md`.
2. Load the SideKick-specific project-root additions, `SIDEKICK.md` and `.sidekick/rules.md`.
3. Walk from the project root toward the current file or command working directory. In each
   directory, use `AGENTS.override.md` when present; otherwise use `AGENTS.md`.
4. Concatenate instructions from broadest to most specific, so later nested instructions take
   precedence only inside their directory tree.
5. Bound individual and combined instruction sizes, cache unchanged files by metadata, and show
   source/truncation diagnostics in the composer.

The initial block contains global and project-root rules, the project root being the primary
folder. Another folder of the project is a root of its own: its root rules arrive the first time
the agent touches it in a run, without the user-wide file again. During an agent run, file reads,
recursive
search matches, commands with a deeper `cwd`, and file mutations resolve newly applicable nested
rules once per scope. A mutation is never performed in the same tool call that first discovers a
nested rule; the model receives the rule and retries after reviewing it. Direct chats, independent
group agents, and sub-agents use this same resolver and preserve the current user's request as the
higher-priority task.

## Interface

### Worktrees

Two agents writing in one folder overwrite each other's work. A worktree is a separate copy of the
project, so each chat can work without touching another chat's files. A worktree belongs to its
chat: the chat stays in its project in the sidebar, marked with a branch icon, and only works in a
different folder.

#### Where worktrees are kept

SideKick puts a new worktree in a folder beside the project's repository, named after the
repository with `.worktrees` added. The worktree's own folder has a short name: a few words from
the chat's title, or a worker's name, and six random characters. A chat titled "Fix the login page"
in `C:\Code\shop` works in `C:\Code\shop.worktrees\fix-the-login-page-3f9a1c`. The folder is
outside your checkout, so your editor, file watchers and `git status` in the project never see the
worktree, and the path stays short enough for Windows tools that cannot open paths longer than 260
characters. SideKick removes the `.worktrees` folder when its last worktree goes and nothing else is
in it.

When it cannot make that folder, SideKick keeps the worktree in its private data folder, under
`worktrees`, where earlier versions kept every worktree. That happens when the repository is at the
root of a drive, when the folder beside it belongs to another Git repository (so the worktree would
show up there as untracked files), or when the folder beside it cannot be written. Worktrees made by
earlier versions stay where they are and keep working there.

#### Starting a chat in a worktree

Before the first message of a project chat, the bar above the composer offers **Work in: This
folder** or **New worktree**. A new worktree starts **from** the branch the project folder is on,
or another branch you choose, on a new branch of its own named after its folder, such as
`sidekick/fix-cards-3f9a1c`. It cannot use the branch it starts from: Git lets a branch be checked
out in only one folder, and the project folder already has it. Sending the first message
creates the chat's worktree and then starts the agent there. SideKick remembers your
last choice for the next new chat. Worktrees need a project inside a Git repository; for any other
folder the bar says so and the chat works in the folder. A new chat outside any project shows
**Work in: No project** instead; choosing a project there moves the chat into it and offers both
choices.

A worktree copies the primary folder's repository. In a project of several folders, a folder in
that same repository is the worktree's copy of it; every other folder stays as it is and is shared
with the project's other chats. When another chat is already changing files in such a folder, the
agent is told so the first time it tries to change one there, and that change waits.

Every new chat in a project gets the same choice, so two chats never share a worktree by accident.
A chat that already has messages keeps its folder. To move its work aside, fork it into a new
worktree. Uncommitted files stay in the original folder and are not copied into a new worktree.

Once a chat works in a worktree, the Work in bar goes away. A small branch label in the
composer's bottom row shows the branch checked out in it. A worktree made by an earlier version
may read "detached from main" until the agent creates a branch there.

#### Finishing the work

A worktree's work never has to come back through the project folder. The agent knows it works in
a worktree and on which branch. It commits there, may rename the branch, create others or switch
between them, and runs whatever Git commands the work needs, as your permission mode allows. It
then merges into the base where the base is checked out, or pushes the branch and opens a pull
request. Once the work is merged, remove the worktree or delete its chat. Each chat can have its
own worktree, so several agents can each finish their own change this way.

#### When another agent is already working in the folder

If you send a message in a folder where another chat's agent is writing, SideKick asks before
starting:

- **Start in a new worktree** (a chat with no messages yet) or **Fork into a new worktree** (a chat
  with history, which opens the fork with your message ready to send).
- **Work here anyway**, when the two changes cannot overlap.

Closing the prompt leaves the message unsent in the composer. The rule also covers folders inside or
around the busy one, and runs started without the composer: SideKick's
runtime refuses a second writer in a busy folder unless the run was started to share it. Research
reports only read, so they are never held back. A worker chat set to work in its manager's folder
shares it by design; see [Chats that work together](CHATS_THAT_WORK_TOGETHER.md).

#### Older worktrees are set aside

SideKick keeps the 15 most recently used worktrees on disk. When there are more, it sets the least
recently used ones aside: it saves each one's commits and uncommitted files in a snapshot that Git
keeps under `refs/sidekick/worktrees/`, then deletes the folder. A worktree whose chat is running
or pinned is never set aside. Sending a message in the chat brings the worktree back as it was:
the same folder, commit, branch and files, with its changes unstaged. Files Git ignores, such as
installed dependencies, are not kept, so the agent may need to reinstall them.

#### Managing worktrees

The branch label in the composer, the settings icon beside **Work in**, or **Manage worktrees** in
the command palette opens the list. Each row shows the chat, the project and branch, and when it was
last used, marked **Working**, **Set aside**, or with its number of changed files.

- **Open its chat** switches to the chat, or starts one in the worktree.
- **Show the folder** opens it in your file manager. A set-aside worktree has no folder until its
  chat continues.
- **Remove** asks once, then deletes the folder with any uncommitted changes. Branches with
  commits stay in the repository. The branch SideKick made for it is deleted too when it holds
  nothing its base lacks, because it was never committed on or is already merged. Its chats keep
  their history as chats outside any project.

Deleting a worktree's chat removes the worktree too. SideKick never removes a worktree while an agent works in it, or one it
cannot prove it created: the folder must sit directly inside the repository's `.worktrees` folder or
SideKick's storage, and be registered with Git. Removal goes through `git worktree remove`; there is no recursive-delete
fallback. Links inside a worktree, such as a `node_modules` junction to a shared install, are
deleted as links first, so their targets are never emptied.

SideKick's worktree commands disable implicit Git hooks for that invocation without changing your
Git configuration. This is not a sandbox for arbitrary Git filters or manually executed commands.

### Pull request status

A line under the composer shows the GitHub pull request for the branch checked out in the chat's
folder, whether that is the project folder or a managed worktree:

- the pull request number, which opens it in your browser
- its state: draft, open, in a merge queue, merged, or closed
- merge status: ready to merge, conflicts, blocked, behind the base branch, or checks failing
- lines added and removed
- CI checks; click the summary to list each check, and click a check to open its log
- the branch name

When the branch has no pull request, **Create PR** opens GitHub's compare form for it. Push your
commits before you submit that form. SideKick never pushes, creates, or merges anything here; it
only reads.

Status refreshes every 30 seconds while the window is visible, when the window regains focus, and
from the refresh button. A failed refresh keeps the last status and shows a message you can dismiss.

The line needs the [GitHub CLI](https://cli.github.com/) installed and signed in with
`gh auth login`, and an `origin` remote on github.com over HTTPS or SSH. It is hidden for the
default branch, a detached HEAD, a folder that is not a Git repository, and other Git hosts. A
missing or signed-out GitHub CLI also hides it; SideKick checks again about every five minutes, so
the line appears shortly after you install or sign in to `gh`.

### Sidebar

The sidebar has two sections. Each heading folds its section away with its arrow, showing how many
items it holds while closed, and offers its own create action when you point at it:

- **Projects:** compact folder rows with collapsible nested conversations, new-chat, pin, rename,
  edit, and remove actions; **+** opens a folder as a project.
- **Chats:** standalone conversations only; the pen starts one.

The layout button beside the SideKick name switches between two layouts. It shows a folder while
chats are grouped by folder and a clock while they are listed by recent activity, and SideKick
remembers your choice:

- **By folder:** the two sections above.
- **By recent activity:** every chat in one list, newest first, under Pinned, Today, Yesterday,
  Previous 7 days, and Older. Each row names its project, and rows keep their time order, so they
  cannot be dragged; use **Move to** instead.

The filter button narrows either layout to chats that **Need attention** (waiting on an approval or
an answer), are **Working**, or have an **Unread** reply. Its
menu counts each kind, and the button itself shows how many chats are waiting on you, even inside a
folded project. A filter opens every section and project so nothing it matches is hidden; clear it
with the **×** on the chip under the search box. Filters reset when SideKick restarts.

The **⋯** menu holds the rest: a new chat, the command palette, collapsing or expanding every
project at once, and clearing all chats. When the sidebar is collapsed, it also opens a project, as
it does in the recent-activity layout.

Chats that another chat started sit under it in both layouts; see
[Chats that work together](CHATS_THAT_WORK_TOGETHER.md).

Search spans the sections and labels project-backed results. The title bar and composer project pill
show the active project so folder context is never implicit.
