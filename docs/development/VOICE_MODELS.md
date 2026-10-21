# Voice models

SideKick downloads its speech models at run time; none ship in the installer.
`src/main/services/voice/voiceModels.ts` pins every file by revision, size, and sha256, and a file
that does not match is refused. [Voice](../user-guide/VOICE.md) describes what users see.

| Use            | Model                                                                                                   | Files from                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dictation      | [Moondream Parakeet Ultra](https://huggingface.co/moondream/parakeet-ultra), CC BY 4.0                  | SideKick's conversion, [erponce/sherpa-onnx-parakeet-ultra-tdt-0.6b-v3-int8](https://huggingface.co/erponce/sherpa-onnx-parakeet-ultra-tdt-0.6b-v3-int8) |
| Finding speech | [Silero VAD](https://github.com/snakers4/silero-vad), MIT                                               | the k2-fsa/sherpa-onnx `asr-models` release                                                                                                              |
| Read aloud     | [Kokoro 82M v1.0](https://huggingface.co/hexgrad/Kokoro-82M), Apache 2.0, with espeak-ng data (GPL-3.0) | k2-fsa's conversion, csukuangfj/kokoro-multi-lang-v1_0                                                                                                   |

## The dictation model

Parakeet Ultra is Moondream's post-training of
[NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). It has the
same architecture, tokenizer, and 25 languages, so sherpa-onnx runs it as a `nemo_transducer`
exactly as it ran NVIDIA's model. Moondream publishes it only as transformers safetensors, so
SideKick converts it to ONNX and quantizes it to int8.

### Why this model

Measured on Windows x64 (i5-12400, CPU, 4 threads, sherpa-onnx), on clips spread evenly through
each test set: LibriSpeech test-clean (200 clips), AMI meetings as cleaned for the Open ASR
leaderboard (200), Earnings-22 (100), and Multilingual LibriSpeech Spanish (100). Word error rate
in percent, lower is better:

| Model                                         | Read English | Meetings | Earnings calls | Spanish |
| --------------------------------------------- | -----------: | -------: | -------------: | ------: |
| NVIDIA Parakeet, k2-fsa's int8 build (before) |         2.68 |    11.80 |          12.22 |    5.22 |
| Parakeet Ultra, `quantize_dynamic` int8       |         2.33 |    11.06 |          11.58 |    4.55 |
| Parakeet Ultra, weight-only int8 (shipped)    |         2.05 |    10.81 |          10.01 |    3.96 |

The shipped build's gains on read English, earnings calls, and Spanish were outside the 95%
paired-bootstrap interval; on meetings the difference was within noise. It wrote numbers as digits
more often, which matters for dictation. It runs at the same speed as NVIDIA's build (about 13x
real time) and peaks at the same 1.4 GB of memory. Underdog Bark 3.0, which is built on Parakeet
Ultra, was also measured. It is English only and was worse at Spanish (18.6), so it was not
adopted.

### Building it

[`scripts/build-dictation-model.py`](../../scripts/build-dictation-model.py) builds the hosted
files. It pins the source (`moondream/parakeet-ultra` at `73175eb`, each file by sha256) and the
CC BY 4.0 legal code it publishes beside them. The script does the following:

1. Loads the checkpoint with transformers' `ParakeetForTDT`. The voice-activity head in Ultra's
   weights is not exported.
2. Exports the encoder, decoder, and joiner with the inputs, outputs, and metadata of k2-fsa's
   `scripts/nemo/parakeet-tdt-0.6b-v3/export_onnx.py`. Kernel-1 convolutions become the equivalent
   MatMuls. The metadata `url` names a TDT model, because sherpa-onnx decodes TDT only when it
   does.
3. Quantizes the weights only: every MatMul becomes `MatMulNBits` with 8 bits, symmetric, in
   blocks of 128, at accuracy level 4. The LSTM, embedding, and depthwise convolutions stay
   fp32. onnxruntime's `quantize_dynamic`, which k2-fsa uses for NVIDIA's build, cost 0.25 to 1.6
   points in the measurements above.
4. Writes `tokens.txt` from the tokenizer and checks that it matches NVIDIA's vocabulary.

The export follows [velddev's conversion of Bark 3.0](https://huggingface.co/velddev/Underdog-Bark-3.0-sherpa-onnx)
(revision `f438275`, CC BY 4.0), as the script's header records.

Run it in a virtual environment of its own, with the versions in
[`scripts/requirements-dictation-model.txt`](../../scripts/requirements-dictation-model.txt)
installed. The work folder needs about 5 GB, including the 1.3 GB download:

```bash
python -I scripts/build-dictation-model.py <work folder>
```

It prints each output file's size and sha256. With these versions on Windows x64 it gives:

| File                | Bytes       | sha256                                                             |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| `encoder.int8.onnx` | 630,748,061 | `677ec8e965d3319f7094548231a56efe4c08b16f90fddd064db2de277dcb6325` |
| `decoder.int8.onnx` | 47,658,545  | `bd806df64c71fce9269769d825da80542c2761b946be4fafa30e0dabdb85025a` |
| `joiner.int8.onnx`  | 6,123,465   | `d90a4d2a41a081c6255b19a5b102fd7289feb648374a1e745392380781e1578f` |
| `tokens.txt`        | 93,939      | `d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d` |

The output also holds the `LICENSE`, `NOTICE`, and `README.md` model card published with them.

### Attribution

CC BY 4.0 requires crediting the creators, linking the license, and saying what changed. SideKick
credits Moondream and NVIDIA, links the license, and says that SideKick converted and quantized
the model in three places: the Settings → General → Voice hint, the Models section of
[Voice](../user-guide/VOICE.md), and the hosted `NOTICE` and model card.

## Changing a model

1. Publish the new files and pin them by commit, size, and sha256.
2. Give the manifest a new `folder`. The new revision downloads beside the old one.
3. Move the old manifest to `replaces`. Where it is installed, it keeps working until the new
   revision has downloaded and is then deleted. Where it is not, its folder is removed. A dictation
   in progress finishes on the old model; the next one loads the new model.
4. Run `SIDEKICK_VOICE_LIVE=1 npm test -- voiceService.live`, which downloads the real models
   and transcribes English and Spanish read by Kokoro.

A folder that no revision replaces, such as a dropped model, goes in `SUPERSEDED_VOICE_FOLDERS`
and is deleted at startup.
