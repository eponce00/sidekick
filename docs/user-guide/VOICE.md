# Voice

SideKick can listen to you, write what you say into the message box, and read messages
aloud. It all runs on this device: audio is never sent to a provider or any other service.

## Talking with SideKick

Press **Ctrl+Space** (**⌥Space** on macOS), or click the microphone beside the model picker.
While the mic is on:

1. **You talk.** Words appear in the box as you speak, and each phrase is corrected when it
   ends. You can edit the text or type between phrases.
2. **Enter sends.** You decide when the message is finished, not a silence timer. The mic
   pauses at once, so it never hears the reply being read.
3. **The reply is read aloud.** Only its answer is read: not the work before it or reasoning
   written inline. Press **Esc**, or click the speaker, to skip to the next step.
4. **It listens again.** Carry on with the next message.

Press the shortcut or click the mic to turn it off; switching to another chat also turns it
off. The empty message box says what is happening at each step. If no sound reaches SideKick
for three seconds, it says which microphone it is hearing.

To dictate without having replies read, turn off **Talk back and forth** in the voice
settings: the mic then keeps listening after you send.

Dictation understands English, Spanish, and 23 other European languages, detects which one you
are speaking, and adds punctuation and capitals.

## Read aloud

Hover any message, yours or SideKick's, and click the speaker. Playback starts with the first
sentence while the rest is generated; click again to stop. Code blocks, tables, images, and bare
links are skipped.

## Settings

**Settings → General → Voice** holds:

- the switch for voice, including its background download;
- the **microphone** and **speaker**, the system default unless you choose one, with a level
  test and a spoken sample;
- the **voice**, one of ten;
- the **read-aloud language**, detected from each message unless you choose one;
- **Talk back and forth**, on by default.

Device, voice, and language choices apply at once and belong to this machine.

The first time, SideKick asks the operating system for microphone access. If it was refused,
allow SideKick under the system's microphone privacy settings.

## Setup

The speech models download quietly in the background shortly after SideKick starts: about
670 MB for dictation and 145 MB for read-aloud. Downloads resume after an interruption and are
checked against pinned hashes before use. Until a model is ready its button shows a progress
ring, and clicking it moves that model to the front of the download.

## Models

- Dictation: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3),
  CC BY 4.0, with [Silero VAD](https://github.com/snakers4/silero-vad) to find speech.
- Read aloud: [Supertone Supertonic 3](https://huggingface.co/Supertone/supertonic-3),
  OpenRAIL-M.

Both run through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) on the CPU. Models load
on first use and are released after ten idle minutes.
