# Configuration CLI: remaining work

The [`sidekick` command](../user-guide/COMMAND_LINE.md) and SideKick's self-configuration tools are
described in [Configuration control](../architecture/CONFIGURATION_CONTROL.md). This file lists only
what is not done.

- **Qualify the installed command on every platform.** The Windows installer's PATH step and the
  `bin` wrappers are built and exercised from an unpacked build, but not yet installed and
  uninstalled on a clean machine. The macOS and Linux shell script is tested with `sh` on Windows;
  it still needs a run from a real app bundle and AppImage, including an AppImage that falls back to
  `--no-sandbox`.
- **Microsoft Store package.** The Store package cannot run installer scripts. Declare an
  `AppExecutionAlias` for the command, or document that Store installs have no command line.
- **Electron fuses.** The command runs the app's executable as Node through
  `ELECTRON_RUN_AS_NODE`. If the release ever disables the `RunAsNode` fuse, which hardening guides
  recommend, the command needs its own small launcher first.
- **Starting the app.** A `--start` option could launch SideKick normally, with its window, and
  wait for the endpoint. Starting it headlessly stays out of scope, because approvals are dialogs in
  that window.
- **MCP connector environment in Settings.** Environment values can be set only with
  `sidekick mcp add --env`. Settings shows the names but has no way to enter or replace a value.
- **Model management.** `sidekick provider` cannot discover or choose models; that still happens in
  Settings.
