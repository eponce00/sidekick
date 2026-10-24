# Phone companion

The phone companion lets a phone on the same local network see and drive the user's chats. The
user-facing behavior is in the [phone guide](../user-guide/PHONE.md).

## Constraints

- **Local only.** The phone connects to the computer directly. There is no relay, account, hosted
  page or other service, and nothing is installed on the phone.
- **Only the user's phone.** Others on the same network must not be able to use or read the
  connection, even with the link.
- **No certificate install.** Phones only trust HTTPS for a private address after the user installs
  a root certificate in system settings, which was judged too much friction.
- **A secure page.** Browsers give the microphone, the rich clipboard and `crypto.subtle` only to a
  secure context, which plain HTTP is not.

The page is therefore served over HTTPS with a certificate SideKick makes for the computer's
address. The phone does not know it and warns; once the user continues past the warning, Chrome
treats the page as a secure context. The certificate only makes the page secure: who may
connect, and what others on the network can read, are decided by pairing and by the encryption
inside the connection. OpenCode exposes its web interface on the network behind a password; T3 Code
pairs with a one-time QR token and relies on Tailscale for HTTPS. SideKick uses a one-time QR
secret, an approval on the computer and per-device keys, with no outside service.

## Processes

The trusted main process owns everything. `src/main/ipc/companion.ts` wires the server to the app;
`src/main/services/companion/` holds the server, the phone's API, its uploads and the device store.
The phone is treated like an untrusted renderer: every input is checked in `CompanionApi`, and its
calls go through the same services the desktop window uses: the engine's start, stop, events,
steer and interaction requests.

- **Messages** the phone sends are checked as the window's are (`validateMessageImages`,
  `validateMessageContextAttachments`, the pasted-text budget of the chat's model), saved like a
  scheduled prompt, and the window reloads an open chat on `conversations:messagesChanged`.
- **The queue** is the window's own prompt-admission queue. A message sent while a run works is
  queued; **Steer** makes it the pending steer and hands it to the run, and a run that cannot take
  it is stopped, as in the composer. Changes from either side reach the other
  (`agentRuns:admissionsChanged`, `queue.changed`). The window sends the next queued message when a
  run it follows ends; for a chat no window follows, the main process does, shortly after, and
  taking an item is atomic, so it is never sent twice.
- **Retry and Edit** (`chat.retry`) follow the window's `useConversationActions`, in the main
  process: the chat's folder goes back to its last history point before the message (or to before
  the first one after it) through the permission broker, as the window's checkpoint calls do; then
  an edit's new text is saved, the messages after it are deleted, the chat's summaries from there
  on are invalidated, and a run starts. Nothing is retried while a run works or across a goal's
  first message.
- **New chats in a project** are created as the window creates them, and with `workIn: 'worktree'`
  moved into a worktree of their own before the first run (`createChatWorktree`, shared with the
  window's handler, including the project's setup).
- **Uploads** arrive in pieces of at most 128 KB, up to 20 MB each and 64 MB held across phones,
  belong to the phone that sent them, are taken once and expire after ten minutes.
- **Images** go to the phone as reduced copies, at most 1,600 pixels on the longer side. Images a
  tool saved, such as viewed images and screenshots, are fetched by their `sidekick-browser://`
  address through the same checks as the window's protocol (`readBrowserArtifact`).
- **Voice** uses the computer's own models, through the desktop's own voice API on the phone, so the
  desktop's microphone button, voice loop and player run unchanged. The phone captures 16 kHz audio
  with the desktop's capture worklet and streams it in order, one call at a time, as 16-bit samples
  (`voice.dictation.audio`, at most two seconds a call). The computer writes the words back as
  `dictation.text` events to that phone only, and `dictation.end` follows the last words after a
  stop. A dictation belongs to the phone that started it, ends after 15 seconds without audio and
  after thirty minutes, and the voice service knows it by an ID of its own. Speech is streamed to
  the phone that asked as 16-bit samples, and only that phone can stop it.

The phone page is its own small bundle, `src/renderer/companion.html`, built with the renderer. In
development the server fetches it from the renderer's development server.

## Network surface

- The server listens only while phone access is on, on one private IPv4 address of a real network
  adapter (Wi-Fi first), on a remembered port so a home-screen icon keeps working.
- It speaks HTTPS (TLS 1.2 or later) with a certificate from `companionCertificate.ts`: an ECDSA
  P-256 key and a self-signed certificate for that address only (not an authority, server use
  only), valid for 397 days. It is kept, with its key sealed by the operating system's key store
  where it has one, so a phone that accepted it is not warned again; it is replaced when the
  address changes or a month before it ends. Plain HTTP on the same port, which an address saved
  before the page was HTTPS uses, gets a redirect to the HTTPS page after the same address and
  `Host` checks, and nothing else.
- The page may use the microphone (`Permissions-Policy: microphone=(self)`); the camera and
  location stay refused, and photos come from the phone's camera app through a file input.
- Requests from addresses outside the private, link-local and unique-local ranges are refused, as
  are requests whose `Host` is not that address and port (DNS rebinding) and API requests from
  another `Origin`.
- Only the page, its built assets, its manifest and its icon are served, with a strict
  Content-Security-Policy that allows nothing from elsewhere.
- Pairing and session starts are rate-limited per address, bodies are limited to 256 KB, and the
  server never opens ports on the router.

## Pairing

The QR code holds `https://<address>:<port>/#p=<secret>`, a 128-bit secret in the URL fragment,
which browsers never send. It works once and for two minutes.

1. The phone creates a random device ID and a 256-bit device secret and sends them sealed with
   XChaCha20-Poly1305 under a key derived (HKDF-SHA256) from the QR secret.
2. Only the current code opens the request. The code is spent at once, whatever happens next.
3. The computer asks the user in a trusted dialog, which the app window cannot click or cover,
   naming the phone and its address.
4. On **Allow**, the device is stored and the reply is sealed with the same QR secret, so the phone
   knows it reached the computer that showed the code. Device secrets are stored sealed by the
   operating system's key store where it has one.

## Sessions and messages

Each connection starts with an X25519 exchange. Both ends derive the session keys with HKDF from
the shared secret and the device secret, over a transcript of the device ID, session ID, both
public keys and both random values. A device that does not hold the device secret derives
different keys. The computer proves it holds the secret with an HMAC the phone checks, and the
phone proves it with its first message, which must authenticate. A device secret leaked later does
not open earlier sessions.

- Calls are sealed with ChaCha20-Poly1305 under the request key, with a counter nonce. The server
  takes each counter once (out of order within 64), so a recorded call cannot be replayed.
- Each reply is sealed under its own key, with the request's counter as nonce, so it answers only
  that call.
- Events go over Server-Sent Events, opened with a one-time ticket obtained over an encrypted call.
  Each is sealed under the event key with a rising counter, and the phone drops one that is not
  newer. Run events are trimmed: long text is cut and images are left out.

Removing a device ends its sessions and streams at once. Turning phone access off stops the server
and forgets every session.

Both ends use the same implementation, `src/shared/companionProtocol.ts`, built on the audited
[noble](https://paulmillr.com/noble/) libraries, so the phone and the computer run identical code
whatever the browser offers.

## The risk that remains

An attacker who controls the network can serve their own page with their own certificate. The
phone warns about it as it warns about SideKick's, and a user who continues past that warning gets
the attacker's page, which could read what the phone stores and act as that phone. Once a phone
accepted SideKick's certificate, a different one warns again, but browsers forget the choice after
a while, so the user is used to continuing. Nothing that keeps to the constraints above closes
this. The mitigations are
that phone access is off until turned on and stays a deliberate choice, the guidance to use it only
on trusted Wi-Fi, the connection dot and **Remove**, and the narrow API: no credentials, settings,
files or terminal input, and no cards that act on the computer itself.

## Tests

- `src/shared/companionProtocol.test.ts`: key agreement, sealing, tampering, cross-purpose and
  replayed messages.
- `src/main/services/companion/companionServer.test.ts` drives a real HTTPS server, checking its
  certificate: reused, expired and forged codes, a refused pairing, unknown and removed devices, a
  device without its secret, tampered and replayed calls, unknown calls, wrong `Host` and `Origin`,
  outside addresses, oversized and non-JSON bodies, one-time event tickets, the plain-HTTP redirect
  and the permissions the page gets.
- `src/main/services/companion/companionCertificate.test.ts`: the certificate's address, key,
  extensions and validity, and when a saved one is replaced.
- `src/main/services/companion/companionApi.test.ts`: the phone's calls and their checks, including
  dictation that only its own phone reaches.
