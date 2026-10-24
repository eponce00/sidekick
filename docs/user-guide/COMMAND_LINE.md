# Command line

The `sidekick` command inspects and configures the running SideKick app from a terminal. It is
meant for you and for other agents, such as Claude Code or Codex, that help you set SideKick up.
It never edits SideKick's files and never prints an API key.

## Getting the command

| Platform | How                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | The installer adds SideKick's `bin` folder to your PATH. Open a new terminal after installing. It works in Command Prompt, PowerShell, and Git Bash. The Microsoft Store package cannot add commands to PATH. |
| macOS    | **Settings → Integrations → Command line → Install command** writes `~/.local/bin/sidekick`. Add `~/.local/bin` to PATH in your shell profile if `sidekick` is not found.                                     |
| Linux    | The same Settings button writes `~/.local/bin/sidekick`. It finds the running AppImage on its own, so moving or updating the AppImage does not break it.                                                      |

The command runs with SideKick's own runtime, so you do not need Node.js. Settings shows whether
the command is installed and on PATH.

From a source checkout, build once (`npm run build` or `npm run dev`), then use
`npm run sidekick -- <command>`, which talks to the development build.

## SideKick must be running

Every command except `--help` and `config reference` asks the running app. On macOS and Linux the
installed command borrows the running app's runtime, so even those two need SideKick open. When
SideKick is not running, the command exits with code 3 and asks you to start it. It does not edit settings files
behind the app's back, because a second writer could lose changes, skip validation, and could not
encrypt a key.

## Commands

| Command                                                                          | What it does                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sidekick doctor`                                                                | Version, settings file, unrecognized or invalid settings, key storage, which providers have a key, connector health |
| `sidekick config list`                                                           | Every setting you can change, with its value and whether it is the default                                          |
| `sidekick config get <key>`                                                      | One setting; prints only the value                                                                                  |
| `sidekick config set <key> <value>`                                              | Change one setting                                                                                                  |
| `sidekick config unset <key>`                                                    | Return one setting to its default                                                                                   |
| `sidekick config reference`                                                      | Every setting's type, allowed values, and default, as Markdown for agents                                           |
| `sidekick auth set <provider-instance> --stdin`                                  | Store a provider key read from standard input                                                                       |
| `sidekick auth set <provider-instance> --from-env NAME`                          | Store a provider key read from an environment variable                                                              |
| `sidekick provider list`                                                         | Provider instances, their addresses and models, and whether each has a key                                          |
| `sidekick provider add <id> --kind KIND [--name N] [--base-url URL]`             | Add a provider instance                                                                                             |
| `sidekick provider set <id> [--name N] [--base-url URL] [--enable \| --disable]` | Change a provider instance                                                                                          |
| `sidekick provider remove <id>`                                                  | Remove a provider instance and its key                                                                              |
| `sidekick mcp list`                                                              | MCP connectors, what each runs or contacts, and whether you approved it                                             |
| `sidekick mcp add <id> --command CMD [--env NAME]... [-- ARGS...]`               | Add a local connector                                                                                               |
| `sidekick mcp add <id> --url URL [--oauth]`                                      | Add a remote connector                                                                                              |
| `sidekick mcp remove <id>`                                                       | Remove a connector, its stored environment values, and its approval                                                 |

Run `sidekick <command> --help` for every option.

## What waits for you in SideKick

Some changes show a dialog in SideKick, and the command waits for your answer:

- weakening security, such as setting `commandPermissionMode` to `full-access` or `shellIsolation`
  to `host`;
- adding or replacing an MCP connector. The dialog shows the command, arguments, folder,
  environment variable names, or URL. Editing any of those later, by any means, needs approval again;
- changing a provider's base URL, or adding one at an address other than its default, because the
  stored key and your prompts are sent there.

Cancelling exits with code 7 and changes nothing.

## API keys and secrets

- `auth set` never takes a key as an argument, where it would land in shell history. Pipe it, for
  example `printenv OPENROUTER_API_KEY | sidekick auth set openrouter --stdin`, or name an
  environment variable with `--from-env`. It refuses to read a key typed into a terminal, where it
  would be echoed.
- `mcp add --env NAME` copies `NAME` from the command's own environment. `NAME=VALUE` is refused.
- SideKick encrypts keys and environment values with the operating system's credential storage.
  When that storage is unavailable, the command exits with code 8 instead of storing anything.
- No command returns a key or an environment value. Reports say only whether one is stored.

## Output for scripts and agents

Add `--json` to any command for one JSON document on standard output:

```json
{ "ok": true, "result": { "key": "textScale", "previous": 100, "value": 110, "changed": true } }
```

A failure prints `{"ok": false, "error": {"code": "...", "message": "..."}}` and exits with:

| Exit | Code                | Meaning                                              |
| ---- | ------------------- | ---------------------------------------------------- |
| 0    |                     | Success                                              |
| 1    | `internal`          | Unexpected failure                                   |
| 2    | `usage`             | Bad arguments, including a key passed as an argument |
| 3    | `not-running`       | SideKick is not running                              |
| 4    | `unauthorized`      | The app refused the connection                       |
| 5    | `not-found`         | Unknown setting, provider instance, or connector     |
| 6    | `invalid-value`     | The value is not allowed                             |
| 7    | `denied`            | You declined the change in SideKick                  |
| 8    | `storage-locked`    | Secure credential storage is unavailable             |
| 9    | `protocol-mismatch` | The command and the app are different versions       |

Fields are only ever added, never renamed or removed, within one protocol version.

## SideKick's own agent

Ask SideKick to change its own settings and it loads the **SideKick Configuration** skill. It can
read your configuration freely, but every change shows the current and proposed value and waits for
**Allow once**, even in Full access. It cannot read or set keys: when a provider needs one, it opens
that provider's key field in Settings for you to type into. See [Permissions](PERMISSIONS.md).

How the command and the app talk to each other is described in
[Configuration control](../architecture/CONFIGURATION_CONTROL.md).
