# Configuration control

The [`sidekick` command](../user-guide/COMMAND_LINE.md) and SideKick's own agent change SideKick
through one set of main-process control methods. The running app is the only writer and the only
process that can decrypt a credential, and nothing that reads configuration ever returns one.

## Why not configuration files

Harnesses that let agents edit a plaintext settings file show the failure modes this design avoids:

- Keys in plaintext JSON or TOML are what credential-stealing npm malware searches for first.
- A settings file that can redirect a provider's base URL sends the user's key to whoever controls
  the new address (the class of bug behind Claude Code CVE-2026-21852).
- Approving an MCP server by its name rather than its content lets an approved entry be swapped for
  a different command later (Cursor's MCPoison).
- A key passed as a command-line argument lands in shell history and in every process listing.

## Control endpoint

`src/main/control` starts the endpoint after the main window opens. Only the instance holding the
single-instance lock bootstraps, so one endpoint serves a profile; a second launch only raises the
window.

- **Transport.** Newline-delimited JSON-RPC 2.0 over `\\.\pipe\sidekick-control-<random>` on
  Windows, or a `0600` socket in a `0700` directory under the profile elsewhere (a private
  temporary directory when the path would exceed the socket length limit). libuv refuses to create
  a pipe that already exists, and the random name appears only in a private file, so another account
  cannot squat on it to collect tokens or keys.
- **Discovery and authentication.** Each launch writes `control/endpoint.json` with mode `0600`
  holding the endpoint name and a fresh 256-bit token; on Windows the profile's per-user ACL protects
  it. Clients refuse a file another account owns or can read. The first request on a connection must
  be `session.hello` with the token, compared as SHA-256 digests in constant time. Anything else, a
  wrong token, a protocol mismatch, an oversized line (64 KiB), or five seconds of silence closes
  the connection. Internal errors are logged in the app and answered with a generic message.
- **Contract.** `src/shared/controlProtocol.ts` defines the methods, results, error codes, and the
  CLI exit codes. Shutdown removes the endpoint file only when it still belongs to this launch.
- **CLI runtime.** The CLI (`src/cli`) is plain Node built to `out/main/cli.js` with no Electron
  imports. Installed builds run it with the app's own executable and `ELECTRON_RUN_AS_NODE`: the
  Windows installer puts `bin\sidekick.cmd` (and a POSIX `sidekick` for Git Bash) on the user's PATH,
  and on macOS and Linux Settings writes `~/.local/bin/sidekick`, which reads
  `control/cli-runtime` to find the running app's executable, so a remounted AppImage keeps working.

## Settings

`src/shared/settingsSchema.ts` lists every setting either path may change, with its type, bounds,
default, and whether weakening it is sensitive. Keys outside the schema (credentials, provider
instances, MCP servers, hooks, interpreter paths) cannot be written through `config`. A typed record
of every `ProviderSettings` key lets `doctor` report stored keys SideKick does not recognize. The
same schema generates the agent reference (`config reference`, `settings_reference`).

A write applies to the stored record as it is after any approval dialog closes, writes companion
values (such as the tool-call limit policy version), and then broadcasts `settings:changed`. Open
windows reload settings so a later save from the Settings window cannot write stale values back;
an already-open Settings draft is the user's explicit choice and wins when saved.

## Approvals

| Change                                | Approval                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Weakening security                    | A trusted dialog (`confirmSensitiveSettingsChange`), naming the requester                 |
| Adding or replacing an MCP server     | A trusted dialog listing everything that decides what runs; always shown                  |
| A provider base URL other than before | A trusted dialog with the old and new address and whether a stored key will be sent there |
| Any change by SideKick's agent        | An in-chat approval card with the before-and-after value, in every permission mode        |

Trusted dialogs are SideKick-styled windows the app's own window cannot control; see
[Menus and dialogs](DESKTOP_INTEGRATION.md#menus-and-dialogs).

### MCP servers are approved by content

`src/main/services/mcpServerTrust.ts` records approval as a fingerprint of a server's transport,
command, arguments, working directory, environment variable names and hashes of their encrypted
values, URL, authentication, catalog identity, and read auto-approval. The name and enabled switch
are excluded. Every `McpClientManager` in the app checks the fingerprint before starting a server
and stops a running server whose fingerprint changes, so an edit made by any route (the Settings
window, the CLI, or the settings file itself) leaves the server in `needs_approval` until the user
allows its new content. A Settings save asks only about servers it adds, edits, or switches on;
untouched unapproved servers wait for their own **Review and allow**. Servers configured before this
check existed are approved once on upgrade.

Local servers can receive environment variables. Their values are encrypted with `safeStorage` in
`__encryptedMcpEnv`, retained on save only from the stored record (a save can never plant one),
stripped from everything sent to the renderer, and decrypted only when the server starts.

## SideKick's agent

The `settings` capability (`src/shared/appSettingsTools.ts`) gives conversation runs, but not
planning, four tools backed by the same control methods with the agent as requester:

- `settings_read` and `settings_reference` are reads and run without approval.
- `settings_propose_change` sets or resets one schema setting. Its catalog entry has
  `approval: 'always'`, which the kernel honours before the permission mode: the call always
  suspends for an approval, never offers **Allow for this chat**, and carries a preview from the
  tool's registered `preview` function, which the approval card renders as before and after.
  Sensitive changes then also show the trusted dialog.
- `provider_request_key` opens Settings at a provider's key field through `app:openProviderKey`.
  The user types the key into SideKick; the agent only learns whether one is stored.

`approval: 'always'` and handler previews are general: any later tool that changes SideKick itself
can declare them instead of adding kernel special cases. The bundled `sidekick-config` skill tells
the agent how to use the tools.
