# Credentials the agent can use but not read

Status: design note. The vault, the Settings page, the agent's list and request tools, the audit
and redaction have shipped; they are described in [Credentials](../architecture/CREDENTIALS.md)
and the [user guide](../user-guide/CREDENTIALS.md). This file keeps the reasoning and the work
still open.

## Problem

Users want to give the agent an API key or a sign-in for a task, such as a Microsoft Partner
Center client secret for Store submissions, without pasting it into a chat where the model, the
provider, the transcript and every later summary keep it. Today the only stored credentials are
provider keys, MCP server environments and connector OAuth tokens, and the agent's own tools can
use none of them.

The goal: the user stores a value once under an alias, and the agent uses it by that alias in the
places the user allowed. No tool, transcript, log or renderer API ever returns the value.

## How other tools do it

Checked October 2026 against official documentation, specifications and source.

| Tool                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Mechanism                                                                                                                                                                                                                                                | Prevents                                                   | Leaks or caveats                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1Password CLI ([secret references](https://www.1password.dev/cli/secret-references/), [`op run`](https://www.1password.dev/cli/secrets-environment-variables/))                                                                                                                                                                                                                                                                                              | `op://vault/item/field` references resolved into one child process's environment; values printed to stdout or stderr are concealed.                                                                                                                      | Plaintext in configuration and Git.                        | The child holds plaintext and can transform it; 1Password warns that same-user processes can read another's environment. How masking matches is undocumented.                                                                                                                                                                                                                               |
| 1Password for Claude and Secure Agentic Autofill ([support](https://support.1password.com/1password-claude/), [blog](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents))                                                                                                                                                                                                                                                  | The agent asks for a login; the user approves the item; 1Password fills the page outside the agent's view. The model learns only which login was used.                                                                                                   | The model ever seeing the password.                        | After sign-in the agent acts with the user's session.                                                                                                                                                                                                                                                                                                                                       |
| GitHub Actions ([secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions), [runner](https://github.com/actions/runner/blob/main/src/Runner.Common/HostContext.cs))                                                                                                                                                                                                                           | Secrets reach steps as inputs or environment. The runner masks each value, each line of it, Base64 at three alignments, and JSON, URI, XML and shell escapes. Environments can require a reviewer; forks get none.                                       | Accidental echo in logs; secrets reaching untrusted forks. | "Automatic redaction is not guaranteed." Structured and derived values escape masking unless registered. Command-line arguments are visible in `ps`.                                                                                                                                                                                                                                        |
| Bitwarden ([Secrets Manager CLI](https://bitwarden.com/help/secrets-manager-cli/), [URI matching](https://bitwarden.com/help/uri-match-detection/), [MCP server](https://github.com/bitwarden/mcp-server))                                                                                                                                                                                                                                                   | `bws run` injects project-scoped secrets as environment variables. Autofill matches base domain by default, with host and exact options; no autofill in untrusted iframes; warns on HTTP.                                                                | Over-broad access; filling on the wrong site.              | `bws run` "does not create a sandbox". "Starts with" and regex matching are called dangerous. Its MCP server returns passwords to the model.                                                                                                                                                                                                                                                |
| Chromium and Firefox password managers ([filling rules](https://chromium.googlesource.com/chromium/src/+/main/components/password_manager/core/browser/password_form_filling.cc), [actor login](https://chromium.googlesource.com/chromium/src/+/main/components/password_manager/core/browser/actor_login/actor_login_service.h), [Firefox](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/passwordmgr/LoginManagerChild.sys.mjs)) | Fill only a matching origin. Chrome waits for the user on related-domain matches, cross-origin frames, insecure pages and while its own agent acts; its agent login service lists credentials without passwords. Firefox also matches the form's action. | Wrong-origin fills; page script reading autofilled values. | The allowed site's script sees what is typed into it.                                                                                                                                                                                                                                                                                                                                       |
| Egress substitution: Fly.io [tokenizer](https://github.com/superfly/tokenizer), [Vercel](https://vercel.com/docs/sandbox/concepts/firewall) and [Deno](https://docs.deno.com/sandbox/security/) sandboxes, Claude Code [on the web](https://code.claude.com/docs/en/cloud-environments), Codex credential masking                                                                                                                                            | The process holds a placeholder; a proxy adds the real value only to requests for hosts bound to it. Claude Code's network secrets set the header and are never viewable after saving.                                                                   | The process ever having the value.                         | A bound host that echoes content back (Fly.io's "echo oracle"). Vercel sends unmatched requests on without the credential instead of blocking; Codex falls back to unmasked credentials with a warning.                                                                                                                                                                                     |
| Claude Code CLI, Codex CLI, OpenCode, Cline, Goose ([Claude Code permissions](https://code.claude.com/docs/en/permissions), [Codex](https://learn.chatgpt.com/docs/config-file/config-advanced), [OpenCode](https://opencode.ai/docs/permissions/))                                                                                                                                                                                                          | Environment variables, configuration substitution, keyring or plaintext files; read deny rules for `.env`. Claude Code's sandbox can mask a credential behind a placeholder for chosen hosts.                                                            | Casual reads of secret files.                              | Deny rules are bypassed by `grep -r` and scripts, as Claude Code documents and [OpenCode](https://github.com/anomalyco/opencode/issues/56545) shows. Secrets are kept verbatim in transcripts: Claude Code closed [secret scrubbing](https://github.com/anthropics/claude-code/issues/50014) as not planned, and [Goose's issue](https://github.com/aaif-goose/goose/issues/12413) is open. |
| Cursor cloud agents ([security](https://cursor.com/docs/cloud-agent/security-network))                                                                                                                                                                                                                                                                                                                                                                       | Runtime secrets are environment variables replaced with `[REDACTED]` in tool results, transcripts and commits.                                                                                                                                           | Accidental echo.                                           | `od -c`, `base64` and `xxd` bypass it; Cursor calls this a known limitation of substring matching.                                                                                                                                                                                                                                                                                          |
| Warp ([secret redaction](https://docs.warp.dev/support-and-community/privacy-and-security/secret-redaction/))                                                                                                                                                                                                                                                                                                                                                | Values fetched from a secret manager into the shell; optional regex redaction before text reaches an AI provider.                                                                                                                                        | Known key formats reaching the provider.                   | Anything in the shell reads the values; unknown formats are missed; redaction is off by default.                                                                                                                                                                                                                                                                                            |
| MCP specification, 2026-07-28 ([authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [elicitation](https://modelcontextprotocol.io/specification/latest/client/elicitation))                                                                                                                                                                                                                                            | OAuth 2.1 with audience-bound tokens and no token passthrough. A server must ask for secrets through URL elicitation, opened where neither the client nor the model can inspect what the user types.                                                     | Tokens reused across servers; confused deputies.           | Local servers take credentials from their environment, with no further protection.                                                                                                                                                                                                                                                                                                          |

What SideKick takes from this:

- Add the value where the agent cannot reach it, only for targets the user bound, and refuse a
  request outside them (egress substitution). Claude Code fails closed; Codex falls back to
  unmasked credentials, and Vercel sends unmatched requests on.
- Let the user, not the model, decide where a value goes in a request (Claude Code's network
  secrets, Vercel's header rules, Fly.io's sealed destinations), which closes the echo oracle.
- Give the model a list without values and a way to ask SideKick to use one (Chromium's agent
  login service, 1Password for Claude).
- Match origins exactly, refuse cross-origin frames and insecure pages, and check the form's target
  (Chrome, Firefox, Bitwarden, 1Password).
- Redact with GitHub's set of encodings, but treat redaction as a second line (GitHub's own
  caveat, Cursor's confirmed bypass), and scrub transcripts and logs, the gap Claude Code and Goose
  left open.
- Collect stored values only in SideKick's own Settings window, never through the chat or a page
  the agent drives (MCP elicitation).
- Ask a person by default and keep credentials away from untrusted contexts (1Password's
  approvals, GitHub's required reviewers and fork rule).
- Fail closed when protected storage is missing.

## Design

### Shipped

An entry is a secret (one value) or a sign-in (username and password) under an alias, with a
description the agent can read, an approval setting, and a project and background scope. Values
are sealed with `safeStorage` together with the scope, entered only in **Settings → Credentials**,
never returned to the renderer, and redacted, with their common encodings, at the source of every
tool output stream, for every tool result, and for every model request. Widening an entry and
deleting one confirm in a trusted dialog, and every change is audited. See
[Credentials](../architecture/CREDENTIALS.md) for how.

### Using a credential

The agent names an alias in a typed argument of the few tools that accept one. It never writes a
placeholder into free text for SideKick to expand: where the value goes inside a request is set by
the user on the entry, not chosen by the model. A text template such as `{{secret:alias}}` was
considered and rejected, because it lets the model put a value in a request body that an allowed
host publishes back, such as a GitHub issue comment (Fly.io calls this an "echo oracle"), and
because escaping a value correctly inside JSON, URLs and shell text is error-prone.

| Tool                    | Argument                                     | What SideKick does                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_request` (new)    | `credential: "partner-center"`               | Adds the value where the entry says (a header with an optional prefix, Basic authentication for a sign-in, a form or JSON body field, or a query parameter), only for the entry's hosts over HTTPS. |
| `shell`                 | `secrets: { "PC_SECRET": "partner-center" }` | Puts the value in that environment variable of the command. The command text, the process list and the stored command never contain it.                                                             |
| `browser_sign_in` (new) | `credential: "github-login"`                 | Fills the sign-in's username and password on the current page if its origin matches; see [Browser sign-in](#browser-sign-in).                                                                       |
| MCP tools (later)       | Server environments and named arguments      | Lets a server's environment point at an entry instead of holding its own copy.                                                                                                                      |

Every other tool, including file writes, messages to other chats, questions to the user, artifacts
and settings changes, has no way to name a credential. The value never enters a tool's arguments:
the handler asks the vault for it at the moment it sends the request or starts the process, and the
vault checks scope again. Arguments, and everything built from them (the run ledger, live previews,
approval cards, chat grants and the tool's title, which is recomputed from the arguments after
authorization), therefore hold only the alias.

The model already sees `credentials_list`, which returns each entry's alias, kind, description,
scope and approval setting, and the username where the entry allows it. This mirrors Chromium's
agent login service, whose credential list carries username and origin but has no password field.
The tools' own descriptions say how credentials work, so the prompt and tool list do not change as
entries change.

**`http_request`.** `web_fetch` reads pages and takes only a URL, so calling an API needs a new tool
with method, URL, headers, body and a timeout. It is admitted through `webNetworkGuard` like
`web_fetch`. A request naming a credential does not follow a redirect to another host: the redirect
response is returned instead, and a host outside scope is refused rather than sent without the
credential. The model may not set the header, body field or parameter the entry uses itself. The
response is bounded and passes through redaction.

**Derived tokens.** A token exchange, such as an OAuth client-credentials request to
`login.microsoftonline.com`, returns a new bearer token the redactor does not know. GitHub's
documentation warns about exactly this: a value derived from a secret must be registered as a
secret too. In the response to a request that used a credential, string fields named like
`access_token`, `refresh_token` or `id_token` are replaced by run-scoped aliases such as
`partner-center~1`. They are sent as `Authorization: Bearer` only to the hosts the entry lists for
returned tokens, and expire with the run. A dedicated OAuth client-credentials kind, where SideKick
performs the exchange itself as Fly.io's tokenizer does, is a later option.

**Commands.** A command that receives a value can reveal it, so the agent can in effect read any
value it passes to a command. Settings says so on the entry, and commands ask every time by default.
The variable is added after `shellChildEnvironment` removes secret-looking names inherited from
SideKick's own environment, and reaches every process the command starts. Variable names that
change what runs (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `PSModulePath`, `ComSpec` and similar)
are refused. In the Docker shell, which has no network, the variable is passed by name, so the
value never appears on the `docker` command line. Background commands keep it for their lifetime.
`send_command_input` accepts no credentials; a program prompting for a password is answered by the
user.

### Scope and approval

Each entry says where it can be used. A use outside that scope is refused without a prompt, and the
agent is told the user can widen it in Settings. Only the Settings page changes scope: no agent tool,
approval card or command-line call can.

| Scope           | Choices                                                                                                                                 | Default                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Web requests    | Exact hosts (port included), HTTPS only; how the value is sent; hosts that may receive tokens it returns                                | None                                         |
| Browser sign-in | Exact origins                                                                                                                           | None                                         |
| Commands        | Off, ask every time, or allowed programs (`gh`, `az`, `msstore`): a single simple command, no chaining, pipes, redirection or subshells | Off for sign-ins, ask every time for secrets |
| Projects        | All, or selected projects                                                                                                               | All                                          |
| Background runs | Whether schedules and worker chats may use it                                                                                           | Off                                          |

Hosts and origins match exactly. Bitwarden's documentation calls its looser "starts with" and
regular-expression matching dangerous, and Chrome and Firefox will not fill automatically on a
merely related domain; a wildcard such as `*.example.com` is allowed only when typed explicitly.

Shells and interpreters (`sh`, `bash`, `pwsh`, `powershell`, `cmd`, `node`, `python` and similar)
cannot be allowed programs, because they run anything. General network tools such as `curl` can be,
with a warning that they send anywhere.

**When to ask:** every use, first use in each chat (default for web and browser), or never within
scope. Commands default to every use. `authorizeTool` makes this decision for any call that names a
credential, before the permission mode and even for network tools, which skip authorization today,
so it applies in Full access as `approval: 'always'` does. The card uses the existing handler
`preview` to name the alias, the tool and the exact target (host, origin, or the full command with
variable names), never a value. **Allow for this chat** is keyed on the entry and the target, not on
the call's whole arguments, and covers only those.

### Browser sign-in

A browser password manager fills only on the site a password belongs to. Chromium's own agent
support goes further: while its agent is acting, Chrome stops filling automatically, and the agent
must ask its login service to sign in with a credential it picked from a list that has no password.
SideKick follows that contract with `browser_sign_in`:

- The agent names a sign-in, and optionally the username and password fields by element reference.
  Without references SideKick finds the form itself, as a password manager does, including a
  username-only first step.
- The value is inserted only when the field's own frame origin and the top-level page origin both
  match one of the entry's origins over HTTPS, with no cross-origin frame in between (Chrome,
  Firefox and 1Password all refuse cross-origin frames). The check runs at insertion time, inside
  the existing text-entry check that already refuses a focus or navigation change before a value is
  inserted, and the attempt stops if the page navigates while filling.
- A form that submits to an origin outside the entry's scope is refused, as Firefox matches a
  login's form action.
- The password goes only into `<input type="password">`, which Chromium paints as dots in
  screenshots. One sign-in runs per tab at a time. Like `browser_fill_form`, it returns one
  redacted semantic observation and no screenshot.
- After a fill the document is marked as holding a secret until it navigates away. While marked,
  `browser_evaluate` is refused, because its regular-expression filter does not stop page script
  from reading the field or calling `fetch`, and a screenshot or observation is refused if the
  password field is no longer a password field, for example after the page's "show password"
  button is pressed.
- `browser_type` and `browser_fill_form` cannot use credentials.
- Usernames may appear in screenshots; redaction covers only text.
- The existing **Take control** card stays the alternative for a site the user would rather sign in
  to themselves.

### Audit of uses

Every use a tool makes will be recorded in the existing audit as `used`, `denied` or `refused`,
with the tool and its target (host, origin, or command with variable names), and the permission
audit will include credential decisions.

### Export

Export will write aliases, kinds, descriptions, scope and approval settings only, and import will
recreate entries without values, as with GitHub secrets: values are write-only. A profile copied to
another computer already lists its entries as **Needs a new value**.

## Threats and limits

Redaction keeps a value out of what the model reads; it does not stop a process that holds the
value from sending it somewhere. Once a value is in a command's environment, that command and
everything it starts can write it to a file, transform it, or send it anywhere, and no output filter
can prove otherwise. The real boundary is therefore which tool and target receive the value, which
is why commands ask every time by default and why scope can only be widened in Settings.

| Threat                                                                          | Mitigation                                                                                                                                         | What remains                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo $KEY`, `printenv`, `env`                                                  | Every output path is redacted, raw and encoded.                                                                                                    | None for these forms.                                                                                                                                                                                                                           |
| Transforming the value to dodge redaction (reverse, split, char codes, encrypt) | Commands that receive a value ask every time by default; the card shows the full command.                                                          | Not preventable once a command holds the value. A command can also answer yes-or-no questions about it.                                                                                                                                         |
| Writing the value to a file, then reading it                                    | `read` and every other result are redacted; file-writing tools cannot name a credential.                                                           | The file holds the value in plaintext, and Workspace History may snapshot it.                                                                                                                                                                   |
| Sending it to an unrelated host with `http_request`                             | Host scope, HTTPS only, no redirect to another host.                                                                                               | A host in scope that relays requests elsewhere.                                                                                                                                                                                                 |
| Placing the value where an allowed host publishes it (an issue comment, a gist) | The entry, not the model, decides where in the request the value goes.                                                                             | Nothing for `http_request`; a command holding the value can still do it.                                                                                                                                                                        |
| Sending it to an unrelated host from a command                                  | Commands off or ask every time by default; allowed programs exclude shells and interpreters and refuse chaining, pipes, redirection and subshells. | An allowed program that can itself send anywhere, such as `curl`.                                                                                                                                                                               |
| Prompt injection asking the agent to use a credential somewhere                 | Out-of-scope uses are refused without a prompt; scope changes only in Settings; the card shows the exact target.                                   | A user approving a command they did not read.                                                                                                                                                                                                   |
| Filling a password on the wrong site                                            | Frame and top-level origin match at insertion time, HTTPS, form target check.                                                                      | Script on the allowed site can read its own password field, as with any password manager.                                                                                                                                                       |
| Revealing a filled password on screen                                           | Password fields only; screenshots refused once the field stops being a password field; `browser_evaluate` refused.                                 | Usernames appear in screenshots.                                                                                                                                                                                                                |
| Misusing a signed-in session                                                    | The sign-in itself asks per the entry's setting; the session stays in that chat's browser.                                                         | Once signed in, the agent can act as the user on that site, as with any agent given a login. Use an account limited to what the task needs.                                                                                                     |
| Reading SideKick's own store and decrypting it                                  | Records are encrypted; a decrypted value printed as-is is redacted; the Docker shell cannot reach the profile.                                     | On Windows (DPAPI) and Linux (Secret Service) a command running on this computer as the user can decrypt `safeStorage` data, as it can provider keys today, and checking command text cannot reliably stop it. macOS asks through the Keychain. |
| A value in persisted arguments                                                  | Arguments carry only the alias; the handler fetches the value when it sends.                                                                       | None.                                                                                                                                                                                                                                           |
| A compromised renderer                                                          | No read API; the renderer receives redacted streams only.                                                                                          | It can see what the user types while saving a value.                                                                                                                                                                                            |
| The user pastes a stored value into a message                                   | The final pass over outgoing model requests replaces it.                                                                                           | The message is kept locally as typed; a value that is not stored is not caught.                                                                                                                                                                 |
| Short or common values                                                          | Secrets and passwords under 4 characters refused; warning under 8.                                                                                 | Short values may be missed. Over-redaction hides ordinary text that matches, such as a hidden username like `admin`; file tools refuse to write a placeholder back.                                                                             |
| Memory                                                                          | Values decrypted only when used; the redaction set lives in the main process.                                                                      | A memory dump of the main process contains values, as it does provider keys.                                                                                                                                                                    |

## Tests

Fixtures generate random values at run time; no test, fixture, document or log contains a real
credential. Each boundary gets adversarial tests:

- **Storage.** No preload call or IPC response contains a stored value (asserted by scanning every
  response); the store file holds no plaintext; an unavailable backend refuses to save; a tampered
  record is refused.
- **Credential arguments.** Only the declared arguments of `http_request`, `shell` and
  `browser_sign_in` accept an alias, checked by iterating the whole catalog; unknown aliases and
  `~` aliases from another run are refused; the model cannot set the header, field or parameter an
  entry uses itself.
- **Persistence.** The run ledger, approval card, renderer events and transcripts hold
  the alias, never the value.
- **Scope.** Hosts: exact and wildcard, case, trailing dot, punycode, userinfo tricks
  (`https://allowed.example@evil.example`), port and scheme changes, cross-host redirects, and
  names resolving to private addresses. Commands: chaining and substitution in Bash and PowerShell
  (`;`, `&&`, `|`, `$()`, backticks, `&`, `iex`), refused variable names, shells as allowed
  programs. Browser: iframe origin differing from the top frame, navigation between resolving and
  inserting, form targets.
- **Approval.** Full access still asks per the entry's setting; a chat grant does not cover another
  host or command; schedules and worker chats are refused unless allowed; out-of-scope uses never
  prompt.
- **Redaction.** Every encoding; a value split across chunks at every offset; overlapping values;
  values inside ANSI sequences and across UTF-8 boundaries; the retained output store; compaction
  summaries; HTTP client errors; a value planted in a user message and in a worker reply caught at
  the provider boundary.
- **Browser.** A real-Electron smoke on a local fixture page: fill on the right origin succeeds;
  wrong origin, cross-origin iframe, text field and "show password" followed by a screenshot are
  refused; `browser_evaluate` is refused after a fill; a page that logs the value has it redacted.
- **Deletion.** A deleted entry stops working mid-run; a replaced value is still redacted until
  restart; the audit keeps the alias.

## Changes from the agreed design

Made while building the vault, and why:

- **Deleting confirms in a trusted dialog**, not with a broker grant. The dialog is drawn by the
  main process, so a compromised renderer still cannot delete an entry without the user.
- **Opened records stay in main-process memory** for the session instead of being decrypted for
  each use, because the redactor must hold every value anyway.
- **`import_attachment` copies files as they are.** The receiving agent reads them through the same
  redacted tools, and copying them redacted would corrupt them.
- **Integrity is the platform's.** Windows seals records with AES-GCM; macOS and Linux use AES-CBC
  without a MAC, so a process that can write the profile could alter or replay a record's settings.
  That process can already change SideKick's settings, and on Windows and Linux decrypt values, so
  an authenticated layer of SideKick's own is left for later.
- **Approval defaults per use.** Each kind of use has its own scope, which an entry gains only when
  the user turns that use on, so a later use can default to asking every time without touching
  existing entries. Records carry a schema version for any migration a default change needs.
- **Descriptions are untrusted.** `credentials_request` can suggest one, and every chat reads it, so
  Settings marks an agent's description until the user edits it and `credentials_list` tells the
  model descriptions are notes, not instructions.

## Phases

Each phase is one pull request with its tests and, when it ships, user documentation.

1. **Vault and redaction** (shipped). Storage, the Settings page, `credentials_list`,
   `credentials_request`, the audit, and redaction at every output source and the provider
   boundary.
2. **API calls.** `http_request` with host scope, approvals and derived tokens.
3. **Commands.** The `shell` `secrets` argument, command scope and allowed programs.
4. **Browser sign-in.** `browser_sign_in`, origin-bound filling and marked documents.
5. **Later.** MCP server environments and arguments from entries, one-time codes, an OAuth
   client-credentials kind, and answering a waiting command prompt with a credential the user
   picks.

## Decisions

Settled before the first phase:

1. **When to ask by default.** First use of an entry in each chat for web requests and browser
   sign-in, and every use for commands. Asking every time everywhere and never asking within scope
   were rejected: the first trains users to approve without reading, and the second gives a command
   the value with no one looking.
2. **Order of tools.** Vault and redaction, then `http_request`, then commands, then browser
   sign-in. API keys such as the Partner Center secret are covered first.
3. **A use outside scope.** Refused, and the agent is told the user can widen the scope in
   Settings. No dialog offers to widen it, so prompt injection cannot turn a refusal into an
   approval.
4. **Export.** Settings only. Values are re-entered on a new computer, and no file outside the
   encrypted store ever holds one.
