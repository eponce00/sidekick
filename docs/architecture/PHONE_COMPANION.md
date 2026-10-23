# Phone companion

The phone companion lets a phone on the same local network see and drive the user's chats. The
user-facing behavior is in the [phone guide](../user-guide/PHONE.md).

## Constraints

- **Local only.** The phone connects to the computer directly. There is no relay, account, hosted
  page or other service, and nothing is installed on the phone.
- **Only the user's phone.** Others on the same network must not be able to use or read the
  connection, even with the link.
- **No certificate step.** Phones only trust HTTPS for a private address after the user installs a
  root certificate in system settings, which was judged too much friction. A self-signed certificate
  warns on every visit and still does not give the page a secure context.

The page is therefore served over plain HTTP, and security comes from pairing and from encryption
inside the connection. OpenCode exposes its web interface on the network behind a password; T3 Code
pairs with a one-time QR token and relies on Tailscale for HTTPS. SideKick uses a one-time QR
secret, an approval on the computer and per-device keys, with no outside service.

## Processes

The trusted main process owns everything. `src/main/ipc/companion.ts` wires the server to the app;
`src/main/services/companion/` holds the server, the phone's API and the device store. The phone is
treated like an untrusted renderer: every input is checked in `CompanionApi`, and its calls go
through the same services the desktop window uses: the engine's start, stop, events and
interaction requests, and `AgentRuntimeCoordinator.steerUserMessage` for a message sent while a run
works. A message the phone sends is saved like a scheduled prompt, and the desktop window reloads
an open chat on `conversations:messagesChanged`.

The phone page is its own small bundle, `src/renderer/companion.html`, built with the renderer. In
development the server fetches it from the renderer's development server.

## Network surface

- The server listens only while phone access is on, on one private IPv4 address of a real network
  adapter (Wi-Fi first), on a remembered port so a home-screen icon keeps working.
- Requests from addresses outside the private, link-local and unique-local ranges are refused, as
  are requests whose `Host` is not that address and port (DNS rebinding) and API requests from
  another `Origin`.
- Only the page, its built assets, its manifest and its icon are served, with a strict
  Content-Security-Policy that allows nothing from elsewhere.
- Pairing and session starts are rate-limited per address, bodies are limited to 256 KB, and the
  server never opens ports on the router.

## Pairing

The QR code holds `http://<address>:<port>/#p=<secret>`, a 128-bit secret in the URL fragment,
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
[noble](https://paulmillr.com/noble/) libraries, because phones offer no built-in crypto on plain
HTTP.

## The risk that remains

An attacker who controls the network can change the page while it loads, since nothing
authenticates the HTTP response that carries the page. Such a page could read what the phone stores
and act as that phone. Nothing that keeps to the constraints above closes this. The mitigations are
that phone access is off until turned on and stays a deliberate choice, the guidance to use it only
on trusted Wi-Fi, the connection dot and **Remove**, and the narrow API: no credentials, settings,
files or terminal input, and no cards that act on the computer itself.

## Tests

- `src/shared/companionProtocol.test.ts`: key agreement, sealing, tampering, cross-purpose and
  replayed messages.
- `src/main/services/companion/companionServer.test.ts` drives a real server: reused, expired and
  forged codes, a refused pairing, unknown and removed devices, a device without its secret,
  tampered and replayed calls, unknown calls, wrong `Host` and `Origin`, outside addresses,
  oversized and non-JSON bodies, and one-time event tickets.
- `src/main/services/companion/companionApi.test.ts`: the phone's calls and their checks.
