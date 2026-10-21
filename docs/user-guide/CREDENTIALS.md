# Credentials

Store an API key or a sign-in in SideKick so it never has to be pasted into a chat. You type the
value into Settings once. SideKick never shows it to the agent, the chat, or the model provider,
and you cannot read it back either: like GitHub's repository secrets, a stored value can only be
replaced.

## Adding a credential

Open **Settings → Credentials** and choose **Add credential**.

| Field                               | What it is                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Kind**                            | **Secret** for one value, such as an API key, client secret or token. **Sign-in** for a username and a password.                                                                                                                                             |
| **Alias**                           | The name the agent uses, such as `partner-center`: lowercase letters, digits, `-` and `_`.                                                                                                                                                                   |
| **Description**                     | What it is for. The agent reads this, so identifiers that are not secret, such as a client or tenant ID, belong here.                                                                                                                                        |
| **Value fields**                    | Typed once. When you edit a credential they start empty and say the value is stored; typing replaces it, and leaving them empty keeps it. A secret can span several lines, such as a private key. Spaces around a secret or username are removed.            |
| **Let the agent read the username** | For sign-ins: lets the agent see the username, so it can say which account it used. The password stays hidden either way. While the username is hidden, it is replaced wherever it appears in output, so a common name such as `admin` is hidden everywhere. |
| **Ask before each use**             | Every use, the first use in each chat, or never within its scope. It applies in every permission mode, including Full access.                                                                                                                                |
| **Projects**                        | All projects, or only chats in the projects you pick.                                                                                                                                                                                                        |
| **Allow in background runs**        | Whether chats a schedule or another chat started may use it. Off by default, since nobody may be watching them.                                                                                                                                              |

A secret or password must be at least 4 characters, and one under 8 characters is saved with a
warning: short values are hard to tell apart from ordinary text, so SideKick cannot reliably hide
them. A username under 4 characters is not hidden.

When a task needs a credential you have not stored, the agent opens this editor for you with a
suggested alias and description. The editor marks a description the agent wrote; check it before
saving, since every chat that lists your credentials reads it. The agent cannot fill in the value,
and it never asks you to paste one into the chat; if anything ever does, add it here instead.

## What the agent sees

The agent can list your credentials: each alias, kind, description, and where it may be used. It
never receives a value, its length, or any part of it.

SideKick also hides every stored value wherever it would otherwise appear: command output, the
Terminal, tool results, retained output the agent reads later, and every request sent to the model
provider, including a message you type yourself. A hidden value reads `[secret: alias]`. Common
encodings of a value, such as Base64, URL encoding, JSON escaping and hexadecimal, are hidden too.

Because a file that holds a stored value shows the agent `[secret: alias]` instead, the agent's file
tools refuse to write that placeholder back, which would replace your value with it. Edit such a
line yourself.

This is a safety net, not a guarantee. A program that is given a value can always transform it
beyond recognition, which is why where a credential may be used is limited and asked about.

## Changing, deleting, and moving

Editing a credential so the agent can use it more widely, for example in more projects, in
background runs, or with fewer questions, asks you to confirm in a SideKick dialog. **Delete** also
asks first; the agent can no longer use the credential, including in chats that are running.
**Recent activity** in the editor lists when the credential was added, changed, and used, never its
value.

Values are encrypted with your operating system's protected storage (the Keychain on macOS, DPAPI on
Windows, and the Secret Service or KWallet on Linux), so they belong to this computer and this user
account. If you copy SideKick's data to another computer, each credential shows **Needs a new
value**: enter the value again and choose where it can be used. On Linux without a keyring,
Credentials is unavailable rather than storing values unprotected. Credentials saved by a newer
version of SideKick cannot be changed by an older one; update SideKick instead.

The protection is against other people and other accounts, not against programs you run yourself:
on Windows and Linux, any program running as you can ask the operating system to decrypt SideKick's
data, as it can for provider keys.
