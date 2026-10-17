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

Hover any message, yours or SideKick's, and click the speaker. Playback starts with the opening
words while the rest is generated; click again to stop. The voice reads a few sentences at a time
so they flow together, pausing briefly between them and longer between paragraphs.

What is there to be looked at rather than heard is skipped: code blocks, tables' rules, images,
links' addresses, source lists, citation marks such as [1], and the dates and outlets put in
brackets after a fact. Symbols are said as words, so "~3 → 5" is read as "about 3 to 5".

Read aloud speaks English, Spanish, French, Italian, Portuguese, and Hindi. A message in another
language is not read; the speaker button says so.

## Settings

**Settings → General → Voice** holds:

- the switch for voice, including its background download;
- the **microphone** and **speaker**, the system default unless you choose one. **Test** beside
  the microphone shows a live input level under it; **Sample** beside the speaker plays a short
  spoken sample;
- the **voice**, one of eight American English voices, Heart by default. A message in another
  language is read by that language's own voice of the same kind, female or male;
- the **read-aloud language**, detected from each message unless you choose one;
- **Talk back and forth**, on by default;
- the **mic shortcut**, for reference.

Device, voice, and language choices apply at once and belong to this machine.

The first time, SideKick asks the operating system for microphone access. If it was refused,
allow SideKick under the system's microphone privacy settings.

## Setup

The speech models download quietly in the background shortly after SideKick starts: about
670 MB for dictation and 360 MB for read-aloud. Downloads resume after an interruption and are
checked against pinned hashes before use. Until a model is ready its button shows a progress
ring, and clicking it moves that model to the front of the download.

## Models

- Dictation: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3),
  CC BY 4.0, with [Silero VAD](https://github.com/snakers4/silero-vad) to find speech.
- Read aloud: [Kokoro 82M v1.0](https://huggingface.co/hexgrad/Kokoro-82M), Apache 2.0, with
  [espeak-ng](https://github.com/espeak-ng/espeak-ng) data (GPL-3.0) for pronunciation.

Both run through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) on the CPU. Models load
on first use and are released after ten idle minutes.
