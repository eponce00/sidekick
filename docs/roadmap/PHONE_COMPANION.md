# Phone companion: what is left

The [phone companion](../architecture/PHONE_COMPANION.md) ships pairing, encrypted local
connections, and the chat as the desktop shows it, with the shared queue, attachments, dictation and
read aloud. Still open:

- **A stable name.** A phone stores its pairing for the address it paired at, since browsers keep
  storage per origin. When the computer's address changes, the phone has to pair again. A
  `sidekick-<name>.local` name answered by SideKick itself would avoid that where phones resolve
  `.local` names, but it is a different origin from the address, so it must be the one used from the
  first pairing, and Android support varies.
- **Notifications.** Web Push goes through the browser maker's push service, and browsers do not
  register service workers for a page whose certificate they do not trust, so a phone hears about a
  finished run or a waiting card only while the page is open.
- **Other files.** The phone attaches images and text files; documents such as PDFs need the
  conversion the agent's attachment import does on the computer.
- **Fork and rewind.** The phone edits and retries messages; forking a chat from a message, and
  rewinding to one without answering again, are on the computer only.
- **Cards that act on the computer**, such as starting chats in project folders, once the phone can
  show what they would change.
