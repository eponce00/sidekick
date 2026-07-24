# Private workspace History

SideKick History is an application-level undo timeline for project files. It uses Git internally as
a reliable content store, but it is not the project's Git repository and the interface does not
require users to understand commits, branches, indexes, or stashes.

## Coexistence with a real Git repository

For each canonical project folder, SideKick stores a private bare repository under Electron's
`userData/history/<workspace-hash>/checkpoints.git`. No History data is created inside the project.
Every internal Git process receives an explicit private `GIT_DIR` and project `GIT_WORK_TREE`.

SideKick never changes the project's `.git`, current branch, HEAD, commits, index, stash, tags, or
reflog. If the project is a real Git worktree, restoring SideKick History naturally appears to Git as
ordinary working-tree changes. The user remains free to review, commit, discard, or otherwise manage
those changes with their normal Git tool.

## What one History point owns

History captures a baseline immediately before the first SideKick tool in a response that could
change project files. Commands, file writes/edits/deletes, sub-agents, and MCP calls trigger this lazy
capture. A second tree is captured when the response completes.

Only the baseline-to-completion delta belongs to that History point. Files already modified by the
user before the run remain context, not SideKick-owned changes. If the baseline cannot be captured,
the response continues but SideKick deliberately skips the History point rather than claiming an
unsafe delta.

History excludes the real `.git`, common dependency/build directories, virtual environments,
`.env` variants, and common private-key formats. These files stay on disk but are not copied into
SideKick History. The store is local application data; it is not synchronized or pushed anywhere.

## Restore rules

A restore computes the SideKick-owned paths for every History point being traversed. Before writing
anything, the trusted main process checks the complete operation:

- unrelated files are never touched;
- a file staged in the project's real Git index is protected;
- an affected file whose content or executable mode changed after SideKick left it is protected;
- directories, devices, and other unsupported replacements are protected;
- if any protected path conflicts, nothing is restored and the UI lists the paths and reasons.

“Restore” is a soft move: it changes the applied project state but preserves the newer SideKick
timeline, so the user can return to latest. “Remove newer” restores the selected point and then drops
the newer SideKick timeline. If a new agent change is made after a soft restore, it starts a new
timeline from the restored point and the former redo path is discarded, matching normal undo/redo
behavior.

## Manual and concurrent edits

Manual changes made before a SideKick run are excluded by its baseline. Manual changes to unrelated
files after a run survive restores. Later changes to a SideKick-affected file cause a safe conflict
instead of an overwrite.

There is one unavoidable boundary: if another program modifies the same file while a SideKick tool
itself is running, filesystem ownership cannot always be inferred reliably. The current design
favors safety on later restores and never force-overwrites a detected mismatch.

## Lifecycle

History is keyed by canonical project path, so chats attached to the same project share one file
timeline. Detaching a chat makes that project's History visible but read-only. Reattaching to its
original project restores access. Chats cannot move History between different projects.

Private History may be cleaned up after its retention period. Conversation messages and History
labels are separate SQLite records; removing private file History does not delete chat transcripts.
