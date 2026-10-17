# Worktree isolation for parallel agents

Status: design note. Shipped behavior is described in [Projects](../user-guide/PROJECTS.md); this
file keeps only the reasoning and the work that is still open.

## Problem

Several agents can work in one folder at once: two chats in the same project, a scheduled run, or
a chat started by another agent. They read stale files, overwrite each
other's edits and mix unrelated changes into one diff. SideKick already had managed Git worktrees,
but only for "fork into a new worktree", with no way to see, sync or remove them, and nothing
stopped a second run from writing into a busy folder.

## How other harnesses do it

Checked October 2026 against official documentation, or source where noted. "Unverified" means the
documentation did not say.

| Harness                                                                                                                                                    | Unit and location                                                                                                                                                                                                         | Branch and base                                                                                                                                                       | Cleanup and safety                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code ([worktrees](https://code.claude.com/docs/en/worktrees), [desktop](https://code.claude.com/docs/en/desktop))                                   | One session per worktree in `.claude/worktrees/<name>`; desktop has a per-session toggle, a location setting and a branch prefix.                                                                                         | `worktree.baseRef`: remote default branch after a short fetch, or local HEAD.                                                                                         | A clean worktree is removed on exit; changed files or new commits ask keep or remove, and an unverifiable state asks too. A sweep removes only worktrees carrying Claude's marker, while running agents hold `git worktree lock`. On Windows removal deletes junction links, not their targets. Archiving a desktop session removes its worktree. |
| Codex app and cloud ([worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees))                                                               | Local or Worktree mode per thread; worktrees in `$CODEX_HOME/worktrees`.                                                                                                                                                  | Chosen start branch, uncommitted changes carried over; detached HEAD until "Create branch here" (`codex/` prefix). Handoff moves a thread between Local and Worktree. | Keeps the 15 newest; pinned, running and "permanent" ones are protected. A snapshot is saved before deletion and restored if the chat reopens. Setup scripts per OS run on creation. Cloud tasks run in their own environment and end as a commit or PR.                                                                                          |
| Cursor ([worktrees](https://cursor.com/docs/configuration/worktrees))                                                                                      | A worktree per agent; `/worktree`, `/apply-worktree`, best-of-N.                                                                                                                                                          | Unverified.                                                                                                                                                           | Interval cleanup keeping up to 25 per machine; `.cursor/worktrees.json` setup scripts. Up to 8 parallel agents.                                                                                                                                                                                                                                   |
| Conductor ([workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches), [scripts](https://www.conductor.build/docs/reference/scripts)) | A workspace is one worktree with a generated name; the agent renames the branch on first chat.                                                                                                                            | `origin/<base>` after a fetch.                                                                                                                                        | Setup, run and archive scripts with workspace path and a per-workspace port block; archived workspaces and their chats can be restored. States plainly that isolation is not a security boundary.                                                                                                                                                 |
| Cline Desktop (source, `cline/cline@23791b93`, `apps/examples/desktop-app`)                                                                                | "Work in" local or worktree, chosen for a new thread's first prompt (`webview/lib/work-in-selection.ts`); worktrees in `<cline dir>/worktrees/<id>/<repo>` and hidden from the workspace list (`lib/workspace-paths.ts`). | `cline/<id>` from HEAD.                                                                                                                                               | Deleting the session removes the worktree only when the path has the exact generated shape and no other session works in or under it; only the generated branch is deleted. The delete dialog warns that uncommitted changes go too (`sidecar/commands-git-worktree.test.ts`).                                                                    |
| OpenCode (source, `anomalyco/opencode@83c5abbb`, `packages/core/src/worktree.ts`)                                                                          | Project-owned worktrees recorded in SQLite under the global data folder.                                                                                                                                                  | Detached at HEAD or a given ref; project start commands run afterwards.                                                                                               | Only recorded worktrees can be removed; records whose folder vanished are dropped after `git worktree list --porcelain`.                                                                                                                                                                                                                          |

What SideKick takes from this:

- Keep worktrees in private storage and remove only what SideKick provably created: the exact
  storage shape, the recorded branch, and registration in `git worktree list` (Cline, OpenCode,
  Claude Code).
- Classify before removing and explain each refusal; forced removal keeps unmerged branches unless
  asked (Claude Code, Cline).
- Choose "Work in" for a new chat's first message, with a remembered default (Cline, Codex).
- Protect running work from cleanup and refuse a second writer in the same folder (Codex, Claude
  Code locks).
- Delete links found inside a worktree as links before removal, so a junction to a shared
  `node_modules` can never take its target with it (Claude Code on Windows).

## Design

One managed-worktree service in the trusted main process owns creation, inventory, sync and
removal. The renderer only asks for those operations by identity; it never passes paths.

- **Storage and identity.** Worktrees live in SideKick's private data folder,
  `worktrees/<source project id>/<name>`, outside the user's checkout so editors, file watchers and
  `git status` in the original folder never see them. Each is a SideKick project linked to its
  source project, with the base it was created from. It starts detached at that base (Codex,
  OpenCode), since the base branch is usually checked out in the project folder already; the agent
  creates a branch when the work needs one. Worktrees from before this have the branch SideKick
  made for them, which removal still deletes or keeps as before.
- **Work in.** A new project chat chooses "This folder" or "New worktree" before its first message.
  The choice is remembered as the default. A fresh chat (no messages yet) is moved into its new
  worktree; a chat with history forks into one instead, so its history never points at the wrong
  folder.
- **Concurrency guard.** The agent runtime records which folder every writing run uses. A
  conversation run that would write into a folder (or a folder nested in it) where another run is
  writing is refused unless the caller explicitly accepts sharing. The renderer checks first and
  offers a new worktree, sharing, or cancel. Research runs do not write and are not guarded. The
  check is in `AgentRuntimeCoordinator.startConversation`, so every caller (chat, schedule,
  agent-started chat) is covered, not only the composer.
- **Inventory.** The management view lists each worktree with its branch, base, commits ahead and
  behind, uncommitted files, the chats that use it, and disk use.
- **Sync with base.** Merges the base branch into a clean, idle worktree. A conflict aborts the merge
  and reports the conflicting files, so the worktree is never left half-merged.
- **Removal.** Safe removal keeps the existing refusals (running, in use, modified, unmerged, not a
  SideKick-managed path) and explains each one. Forced removal needs a confirmation that names what
  will be lost; chats that used the worktree are detached, never deleted, and the branch is kept
  unless the user also asks to delete it. There is still no recursive-delete fallback; only
  `git worktree remove` touches files.
- **Automatic cleanup.** Deleting the last chat of a worktree removes it when safe removal allows;
  otherwise it stays in the management view with the reason.

## Open work

Shipped in this pass: the service above, "Work in" for new project chats, the busy-folder prompt
and runtime refusal, the management view, safe and forced removal, sync with base, and cleanup when
a worktree's last chat is deleted. Still open:

- **Archive.** Chats can be archived in the main process but not yet from the interface. Archiving
  should remove a clean worktree as deleting does, and keep one with work until the chat is unarchived or deleted.
- **Snapshot before forced removal** (Codex): save uncommitted changes as a stash-like commit or
  patch so a forced removal can be undone when the chat is reopened.
- **Git worktree locks** (Claude Code): `git worktree lock` while an agent runs, so tools outside
  SideKick cannot prune a worktree in use.
- **Fresh base by default** (Claude Code, Conductor): optionally fetch the remote default branch,
  with a short timeout, before creating a worktree, and offer starting from a remote branch or pull
  request.
- **Handoff** (Codex): move a chat's uncommitted work from the project folder into a new worktree,
  and back, instead of forking without the uncommitted files.
- **Merge back.** Merging or opening a pull request from a worktree, and then removing it, is left
  to the user or the agent; a one-click flow would pair with the Git status bar.
- **Settings.** The worktree limit (20) and the storage folder are fixed. Claude Code and Codex
  make them configurable.
- **Per-worktree environment** (Conductor): pass the worktree path, name and a free port range to
  setup hooks so parallel dev servers do not collide.
- **Concurrent writes inside one worktree.** "Work here anyway" relies on the transactional mutation
  service's per-workspace serialization and conflict checks; it does not merge two agents' intent.
