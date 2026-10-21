# Permission policy

SideKick has one authorization policy for privileged operations. Model-originated operations stay
inside the main-process kernel, which either proceeds or creates a durable in-chat permission
interaction. User-initiated destructive UI actions use an exact main-process broker grant.

## Modes

| Mode                               | Requested `auto`                  | Requested `confirm`               |
| ---------------------------------- | --------------------------------- | --------------------------------- |
| Full access                        | Automatic                         | Automatic                         |
| Ask for sensitive actions          | Automatic                         | Durable user approval interaction |
| Ask before every change or command | Durable user approval interaction | Durable user approval interaction |

Full access is the default. It removes approval prompts for in-scope work but does not erase the
host's original safety classification: audit records retain both requested and effective access.
The stricter modes are available per conversation from the composer and in Settings.

## Operation matrix

| Operation                         | Default request          | Trusted enforcement                                                                 |
| --------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| Agent shell command               | Agent-selected           | Kernel policy before canonical command service                                      |
| Agent workspace mutation          | Agent-selected           | Kernel policy plus same-run file receipt before transactional mutation              |
| Agent MCP tool call               | Confirm                  | Kernel policy before internal MCP dispatch                                          |
| Agent API call (`http_request`)   | Auto for GET and HEAD    | Kernel policy before the guarded request                                            |
| Agent use of a stored credential  | The entry's own setting  | Kernel approval before the permission mode, then scope checked again when used      |
| Agent change to SideKick settings | Always confirm           | Kernel approval in every mode, no chat-wide grant, before the shared settings write |
| MCP connector start               | Approved content         | Fingerprint check before any connector process or connection starts                 |
| Agent and child-agent tools       | Shared catalog policy    | Same kernel suspension and result envelope                                          |
| Agent starting other chats        | Mode-dependent           | Start card unless Full access; a new project always asks; see below                 |
| Checkpoint restore/rewind/reset   | Confirm                  | Exact broker grant consumed before private-History mutation                         |
| User file deletion                | Auto after in-app intent | Exact broker grant consumed before system Trash / Recycle Bin                       |
| External browser navigation       | Auto                     | Main-window policy before opening                                                   |

## Answering an approval

| Choice                  | Effect                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **Allow once**          | Runs this operation.                                                                      |
| **Allow for this chat** | Runs it, and later requests in this conversation that it fully covers run without asking. |
| **Deny**                | Refuses this operation; the agent is told and carries on.                                 |
| **Deny and stop**       | Refuses it and ends the reply.                                                            |

A chat-wide grant covers only what it named: the exact command in the same folder and mode, the same
files (deleting is separate from editing), or the exact same arguments for other tools. A later
request that reaches anything more still asks. Grants last until SideKick restarts, never apply to
other conversations, and are recorded in the audit, including the requests they covered. A
conversation waiting on an approval is marked in the sidebar, counted on the taskbar or dock icon,
and announced by a notification when SideKick is not in front.

## Stored credentials

A call that uses a [stored credential](CREDENTIALS.md) asks as that credential says, every use or
the first use in each chat, in every permission mode including Full access. Its card names the
credential, where it is sent and how; approving it approves the whole call. **Allow for this chat**
is offered only for credentials set to ask once per chat, and covers the same credential with the
same host, the same site for a sign-in, or the same exact command. A credential that any command may use asks
before every command. A use outside the credential's scope is refused without asking.

## Changes to SideKick itself

When SideKick's agent proposes changing one of SideKick's settings, the approval shows the current
and proposed value and asks every time, even in Full access, and **Allow for this chat** is not
offered. Changes that weaken security, such as switching to Full access, also show SideKick's own
dialog. The agent cannot read or set API keys; it opens a provider's key field in Settings for you
to type into.

MCP connectors are approved by what they run, not by name. A connector you add, or one whose
command, arguments, folder, environment, URL, or read auto-approval changes by any means, shows
**Needs approval** in **Settings → Integrations** and does not start until you choose **Review and
allow** and confirm what it runs. The [command line](COMMAND_LINE.md) follows the same rules.

## Starting other chats

An agent that wants to start other chats starts them at once in Full access. In the other modes it
shows a card listing each chat, where you can change its project and where it works before starting
it or not. A project the chat has not been allowed to use always asks first, in every mode, and
starting from the card allows it. A worker chat gets no tool its manager could not have, follows
your permission mode, and asks for its own approvals: **Allow for this chat** in the manager does
not carry over. Messages between chats cannot answer an approval. See
[Chats that work together](CHATS_THAT_WORK_TOGETHER.md).

## Binding

Agent approvals are bound to a durable run/interaction/tool call and resume only that suspended
kernel operation. Broker approvals are bound to a SHA-256 fingerprint of the normalized UI
operation, expire after one minute, and are single-use. Replays, missing tokens, expired tokens, and
mismatched operations are rejected.

## Optional isolated shell

Settings → Agent → Permissions → **Where commands run** offers **In a Docker container**, a
Linux container with no network. This is opt-in; the default remains **On this computer**.
Switching back to this computer requires a trusted confirmation. Isolation applies to shell commands, including project
start hooks, not to browser, language-server, MCP, or other host processes.

Install Docker with a local Linux-container daemon and explicitly pull the pinned image:

```sh
docker pull node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
```

Commands use Linux `/bin/sh` and Node, not the host's PowerShell or installed tools.
Only the selected project is mounted writable at `/workspace`; `/tmp` is temporary.
The container has no network, no Docker socket, a read-only root, dropped capabilities,
and bounded memory, CPU, processes, and lifetime. Background commands are unsupported.
Missing Docker, image, or tools fail explicitly: there is no automatic host fallback.
Project writes still change real files; isolation does not replace approvals or backups.
Cancellation removes the command container. An independent deadline also limits its
lifetime if SideKick or the Docker client exits unexpectedly.

Windows Docker boundary and client-crash tests pass; macOS/Linux native qualification
remains pending. This is command isolation, not a claim that the entire harness is sandboxed.

## Audit records

Kernel decisions live in `agent_run_events`; broker authorization/consumption records live in the
settings store. Settings projects the latest 500 entries from both authoritative sources into one
chronological audit. Each row includes operation kind/title, requested/effective access, active
mode, a safe operation fingerprint, outcome, timestamp, and failure reason when applicable. The
latest records are under Settings → Agent → Permissions → **Recent approvals**.
