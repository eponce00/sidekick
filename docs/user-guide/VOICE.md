# Voice

SideKick can take dictation into the message box and read replies aloud. Both run on this
device: audio is never sent to a provider or any other service.

## Dictation

Click the microphone beside the model picker, speak, and click it again to finish. Words appear
at the cursor as you talk; stopping only waits for the last few. The ring around the button
follows your voice so you can see you are being heard.

Dictation understands English, Spanish, and 23 other European languages, and detects which one
you are speaking. It adds punctuation and capitals.

The first time, SideKick asks the operating system for microphone access. If it was refused,
allow SideKick under the system's microphone privacy settings.

## Read aloud

Hover a reply and click the speaker. Playback starts with the first sentence while the rest is
generated; click again to stop. Code blocks, tables, images, and bare links are skipped. The
language is chosen from the reply's words.

## Setup and settings

The speech models download quietly in the background shortly after SideKick starts: about
670 MB for dictation and 145 MB for read-aloud. Downloads resume after an interruption and are
checked against pinned hashes before use. Until a model is ready, its button shows a progress
ring, and clicking it moves that model to the front of the download.

Turn both features off, including the download, under **Settings → General → Voice**. The same
card shows each model's status.

## Models

- Dictation: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3),
  CC BY 4.0, with [Silero VAD](https://github.com/snakers4/silero-vad) to find speech.
- Read aloud: [Supertone Supertonic 3](https://huggingface.co/Supertone/supertonic-3),
  OpenRAIL-M.

Both run through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) on the CPU. Models load
on first use and are released after ten idle minutes.
