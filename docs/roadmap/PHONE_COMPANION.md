# Phone companion: what is left

The [phone companion](../architecture/PHONE_COMPANION.md) ships pairing, encrypted local
connections, chats, live progress, sending, stopping and answering cards. Still open:

- **A stable name.** A phone stores its pairing for the address it paired at, since browsers keep
  storage per origin. When the computer's address changes, the phone has to pair again. A
  `sidekick-<name>.local` name answered by SideKick itself would avoid that where phones resolve
  `.local` names, but it is a different origin from the address, so it must be the one used from the
  first pairing, and Android support varies.
- **Notifications.** Web Push needs a secure context and a push service, so a phone hears about a
  finished run or a waiting card only while the page is open.
- **Images and files.** Sending a photo from the phone, and showing images from chats, once the
  transfer is bounded and redacted like other attachments.
- **New chats in a project.** A chat started on the phone has no project; choosing one, and its
  model, from the phone.
- **Cards that act on the computer**, such as starting chats in project folders, once the phone can
  show what they would change.
