# Credentials

Store a password, an API key or a token in SideKick, as you would in a password manager, so it
never has to be pasted into a chat. You type the value into Settings once. The agent decides when a
task needs it and where it goes, but SideKick adds the value itself: the agent, the chat and the
model provider never see it, and you cannot read it back either. A stored value can only be
replaced.

## Adding a credential

Open **Settings → Credentials** and choose **Add credential**.

| Field               | What it is                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Name**            | What the agent calls it, such as `github` or `build-server`. Type it as words; it is saved in lowercase, with hyphens for spaces.                                                                                                                            |
| **Description**     | What it is for and where it is used, such as "My GitHub account, for github.com" or "SSH to the build server, 10.0.0.5". The agent reads this to pick the right credential, so identifiers that are not secret, such as a client ID, belong here.            |
| **Website**         | Optional, as in a password manager: where it belongs, such as `github.com`. The agent then sends it, and fills it in, only there and on its subdomains. Name several separated by commas. Leave it empty for a credential used anywhere or only in commands. |
| **Username**        | For a sign-in. Leave it empty for an API key or token on its own. The agent can read the username, as a password manager shows it.                                                                                                                           |
| **Password or key** | Typed once. When you edit a credential it starts empty and says the value is stored; typing replaces it, and leaving it empty keeps it. It can span several lines, such as a private key. Spaces around a key or username are removed.                       |

A password or key must be at least 4 characters, and one under 8 characters is saved with a
warning: short values are hard to tell apart from ordinary text, so SideKick cannot reliably hide
them.

When a task needs a credential you have not stored, the agent opens this editor for you with a
suggested name and description. The editor marks a description the agent wrote; check it before
saving, since every chat reads it. The agent cannot fill in the value, and it never asks you to
paste one into the chat; if anything ever does, add it here instead.

## When SideKick asks

Using a credential follows your [permission mode](PERMISSIONS.md), the same one that decides
commands and file changes, set in the composer or in Settings:

- **Full access** uses it without asking.
- **Ask for sensitive actions** asks before each use. The card names the credential, where it goes
  and how. **Allow for this chat** lets later uses of the same credential run without asking; a
  call that would ask anyway, such as a command that changes something, still asks for itself.
- **Ask before every change or command** asks before each use too.

A few rules hold in every mode, and a use that breaks one is refused without asking: a value is
sent only over HTTPS (or to a server on this computer), and only to its **Website** when it has
one, never into a variable that changes how commands run, and a password is filled in only on a
secure page.

Setting a **Website** is the best protection against a page or a file that tries to talk the agent
into sending a credential somewhere else, and against a page made to look like the right site.

## Web requests

The agent's `http_request` tool calls an API with the credential, named by its name. The agent says
where the API expects it, as a header (such as `Authorization: Bearer …` or `X-Api-Key`), a query
parameter, a form or JSON field, or, for a sign-in, Basic authentication, and SideKick puts the
value there. The agent cannot also set that header, parameter or field itself, in any letter case,
nor the body's type when the value goes in the body.

Some services exchange a secret for a short-lived access token, as Microsoft's sign-in endpoint
does for Partner Center. When a request that used the credential returns one, the agent gets an
alias such as `partner-center~1` instead, usable only in web requests, only until the reply that
received it ends, and for at most an hour. If SideKick cannot tell whether such a response holds a
token it could not replace, the agent gets the status and headers but not the body.

`http_request` never follows a redirect, so a response cannot lead a credential to another address;
the agent sees where the redirect points and can make a new request.

## Commands

The agent can run a command with the credential in an environment variable, such as
`msstore publish --clientSecret $env:PC_SECRET` or `sshpass -e ssh deploy@10.0.0.5`. SideKick sets
the variable itself, so the value never appears in the command, the process list, the chat or the
Terminal's record of what ran. For a sign-in, the agent names `name.username` or `name.password`.

A command that receives a value can print it, save it, or send it anywhere, and SideKick hides the
value only as typed, not in a form the command changed it into. In the modes that ask, read the
command on the card before allowing it.

A command never receives a credential when its program would run a file inside the project, such
as a `gh.cmd` placed there, instead of the program installed on this computer. Variables that
change how commands run, such as `PATH`, `NODE_OPTIONS` or `LD_PRELOAD`, cannot hold a credential.
The variable reaches everything the command starts, and a background command keeps it until it
ends. In the [Docker shell](PERMISSIONS.md#optional-isolated-shell), which has no network, the
variable is passed into the container by name. A program that prompts for a password is answered by
you; the agent cannot type a credential into it.

## Browser sign-in

A sign-in can be filled in by the agent's [browser](BROWSER.md) the way a password manager fills a
login: the agent opens the sign-in page and asks SideKick to sign in by name, and SideKick types the
username and password into the page itself. The agent never sees the password.

- A sign-in with a **Website** is filled in only there. Without one, the agent decides from the
  description, so set it for every sign-in you use in the browser. A card that asks shows the site
  it is about to fill.
- SideKick fills only fields of the page itself, never fields inside a frame, and only while the
  page is still on the site the use was approved for. The page must be HTTPS, or plain HTTP on a
  server on this computer such as `http://localhost:3000`.
- It refuses a form that would send the sign-in to another site, though a form may send to another
  address of the same domain, such as `auth.example.com` from `login.example.com`. It puts the
  password only into a real password field, which shows dots.
- It finds the form itself, including a first step that asks only for the username; the agent can
  point at the fields when a page is unusual.
- While a filled password is still on the page, the agent cannot run its own script on the page,
  and SideKick takes no screenshot if the page shows the password as text, for example after its
  **Show password** button.

Once you are signed in, the agent can act on that site as you. Use an account limited to what the
task needs. You can still sign in yourself instead, by typing in the Browser panel.

## What the agent sees

The agent can list your credentials: each name, whether it is a sign-in or a key, its description
and a sign-in's username. It never receives a password or key, its length, or any part of it.

SideKick also hides every stored password and key wherever it would otherwise appear: command
output, the Terminal, tool results, retained output the agent reads later, and every request sent to
the model provider, including a message you type yourself. A hidden value reads `[secret: name]`.
Common encodings of a value, such as Base64, URL encoding, JSON escaping and hexadecimal, are
hidden too. A username is not hidden.

Because a file that holds a stored value shows the agent `[secret: name]` instead, the agent's file
tools refuse to write that placeholder back, which would replace your value with it. Edit such a
line yourself.

This is a safety net, not a guarantee. A program that is given a value can always transform it
beyond recognition, so a mode that asks lets you check where a value goes first.

## Changing, deleting, and moving

**Delete** asks first; the agent can no longer use the credential, including in chats that are
running. **Recent activity** in the editor lists when the credential was added, changed, and used,
never its value.

Values are encrypted with your operating system's protected storage (the Keychain on macOS, DPAPI on
Windows, and the Secret Service or KWallet on Linux), so they belong to this computer and this user
account. If you copy SideKick's data to another computer, each credential shows **Needs a new
value**: enter the value again. On Linux without a keyring, Credentials is unavailable rather than
storing values unprotected. Credentials saved by a newer version of SideKick cannot be changed by an
older one; update SideKick instead.

The protection is against other people and other accounts, not against programs you run yourself:
on Windows and Linux, any program running as you can ask the operating system to decrypt SideKick's
data, as it can for provider keys.
