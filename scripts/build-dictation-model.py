"""Build SideKick's dictation model: Moondream Parakeet Ultra, converted for sherpa-onnx.

    python -I scripts/build-dictation-model.py <work folder> [--source <download folder>]

docs/development/VOICE_MODELS.md explains the build and how it is published. Every input is
pinned below by revision and sha256. The script downloads moondream/parakeet-ultra into
<work>/source, or checks an existing download given by --source. It loads the checkpoint with
transformers' ParakeetForTDT and exports the three graphs that sherpa-onnx's NeMo transducer
runs, with the inputs, outputs and metadata of k2-fsa's
scripts/nemo/parakeet-tdt-0.6b-v3/export_onnx.py. Then it quantizes them to weight-only int8
(MatMulNBits: 8 bits, symmetric, block 128, accuracy level 4). In SideKick's trial that recipe
scored 0.3-2 WER points better than the quantize_dynamic recipe behind k2-fsa's Parakeet build.
The files to publish go to <work>/out, and their sizes and hashes are printed for VOICE_MODELS.

The export follows velddev's convert-bark.py
(https://huggingface.co/velddev/Underdog-Bark-3.0-sherpa-onnx, revision f438275, CC BY 4.0),
changed to load Parakeet Ultra's safetensors instead of Bark's packed weights.

Requirements: scripts/requirements-dictation-model.txt, in a virtual environment of its own.
"""

import argparse
import hashlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path

REPO = "moondream/parakeet-ultra"
REVISION = "73175eb7aeb0d82f1e2a6b53b3aabc10a90bcd0b"
SOURCE_FILES = {
    "config.json": (1_153, "e747b85e1bdfd300c8b8ac63bac8dd5221f8fe9bc275b48d06c735fcd6971b6e"),
    "tokenizer.json": (1_159_960, "bd321b096832a3f270bd3b2a88823957920f1a5c5ada71114a26ea729d0cbe91"),
    "model.safetensors": (1_255_353_386, "c9608f36d0ab956c14bfcc525479b0746b3b42a56f6949ec85c14eb7466717dc"),
}
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/legalcode.txt"
LICENSE_SHA256 = "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411"
# The vocabulary is NVIDIA's: tokens.txt must match k2-fsa's for parakeet-tdt-0.6b-v3.
TOKENS_SHA256 = "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"

METADATA = {
    "vocab_size": 8192,
    "normalize_type": "per_feature",
    "pred_rnn_layers": 2,
    "pred_hidden": 640,
    "subsampling_factor": 8,
    "model_type": "EncDecRNNTBPEModel",
    "version": "2",
    "model_author": "Moondream (parakeet-ultra), from NVIDIA (parakeet-tdt-0.6b-v3)",
    # sherpa-onnx decodes as TDT only when the url contains "tdt" (offline-transducer-nemo-model.cc).
    "url": "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
    "source": f"https://huggingface.co/{REPO}/tree/{REVISION}",
    "license": "CC-BY-4.0",
    "comment": "Moondream Parakeet Ultra, converted to ONNX and quantized to int8 by SideKick",
    "feat_dim": 128,
}

NOTICE = f"""Parakeet Ultra, converted for sherpa-onnx by SideKick

Model: Moondream Parakeet Ultra, by Moondream, licensed under CC BY 4.0
  https://huggingface.co/{REPO} (revision {REVISION[:7]})
It is a post-trained version of NVIDIA Parakeet TDT 0.6B v3, by NVIDIA, licensed under CC BY 4.0
  https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3

License: https://creativecommons.org/licenses/by/4.0/ (the legal code is in LICENSE)

Changes: SideKick converted the model to ONNX for sherpa-onnx and quantized its weights to 8 bits.
Only the TDT transducer is exported. The recipe is scripts/build-dictation-model.py in
https://github.com/eponce00/sidekick.

The model is provided as-is, without warranties of any kind; see section 5 of the license.
"""

CARD = f"""---
license: cc-by-4.0
base_model: {REPO}
language: [en, de, fr, es, it, pt, ru, uk, hr, sl, lv, lt, et, fi, sv, da, nl, pl, cs, sk, hu, ro, bg, el, mt]
pipeline_tag: automatic-speech-recognition
tags: [sherpa-onnx, onnx, parakeet, tdt, int8]
---

# Parakeet Ultra for sherpa-onnx (int8)

[Moondream Parakeet Ultra](https://huggingface.co/{REPO}) by Moondream, a post-trained version of
[NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), converted to
ONNX for [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and quantized to int8 by
[SideKick](https://github.com/eponce00/sidekick), which uses it for on-device dictation. It
speaks the same 25 European languages as the original.

Both models are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and so
is this conversion. See `NOTICE` and `LICENSE`.

## Files

The same layout as k2-fsa's `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`: load it as a
`nemo_transducer` with `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` and
`tokens.txt`. The weights are 8-bit and weight-only: onnxruntime's `MatMulNBits` operator,
symmetric, in blocks of 128, accuracy level 4.

## How it was made

[`scripts/build-dictation-model.py`](https://github.com/eponce00/sidekick/blob/main/scripts/build-dictation-model.py)
builds these files from `{REPO}` at revision `{REVISION[:7]}`.
[`docs/development/VOICE_MODELS.md`](https://github.com/eponce00/sidekick/blob/main/docs/development/VOICE_MODELS.md)
gives the pinned versions, the hashes and SideKick's accuracy measurements.

The model is provided as-is, without warranties of any kind.
"""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def check(path: Path, size: int, digest: str) -> bool:
    return path.is_file() and path.stat().st_size == size and sha256(path) == digest


def fetch(url: str, target: Path) -> None:
    print(f"fetch   {url}", flush=True)
    partial = target.with_name(target.name + ".partial")
    # creativecommons.org refuses urllib's default user agent.
    request = urllib.request.Request(url, headers={"User-Agent": "sidekick-build-dictation-model"})
    with urllib.request.urlopen(request) as response, open(partial, "wb") as file:
        shutil.copyfileobj(response, file, 1 << 20)
    partial.replace(target)


def source(folder: Path, download: bool) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name, (size, digest) in SOURCE_FILES.items():
        path = folder / name
        if not check(path, size, digest) and download:
            fetch(f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}", path)
        if not check(path, size, digest):
            sys.exit(f"{path} is not the pinned {REPO} file")
        print(f"source  {name} {digest}", flush=True)


def load(folder: Path):
    from transformers import ParakeetForTDT

    return ParakeetForTDT.from_pretrained(str(folder), attn_implementation="eager").eval()


def wrappers(model):
    import torch
    from torch import nn

    class Pointwise(nn.Module):
        """A kernel-1 Conv1d written as the equivalent MatMul, so the weight-only quantizer
        covers the conformer convolution modules too."""

        def __init__(self, conv: nn.Conv1d):
            super().__init__()
            assert conv.kernel_size == (1,) and conv.groups == 1 and conv.stride == (1,) and conv.padding == (0,)
            self.weight = nn.Parameter(conv.weight.detach()[:, :, 0].clone(), requires_grad=False)
            self.bias = None if conv.bias is None else nn.Parameter(conv.bias.detach().clone(), requires_grad=False)

        def forward(self, x):
            return nn.functional.linear(x.transpose(1, 2), self.weight, self.bias).transpose(1, 2)

    for layer in model.encoder.layers:
        for name in ("pointwise_conv1", "pointwise_conv2"):
            conv = getattr(layer.conv, name)
            if isinstance(conv, nn.Conv1d):
                setattr(layer.conv, name, Pointwise(conv))

    class Encoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.m = model

        def forward(self, audio_signal, length):
            x = audio_signal.transpose(1, 2)
            mask = (torch.arange(x.shape[1], device=x.device)[None, :] < length[:, None]).long()
            h = self.m.encoder(input_features=x, attention_mask=mask).last_hidden_state
            lens = self.m._get_subsampling_output_length(length).to(torch.int64)
            return h.transpose(1, 2), lens

    class Decoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.d = model.decoder

        def forward(self, targets, target_length, h, c):
            emb = self.d.embedding(targets.to(torch.int64))
            out, (h2, c2) = self.d.lstm(emb, (h, c))
            return self.d.decoder_projector(out).transpose(1, 2), target_length, h2, c2

    class Joiner(nn.Module):
        """transformers splits NeMo's joint: the encoder projection is applied here."""

        def __init__(self):
            super().__init__()
            self.proj = model.encoder_projector
            self.joint = model.joint

        def forward(self, encoder_outputs, decoder_outputs):
            f = self.proj(encoder_outputs.transpose(1, 2))
            g = decoder_outputs.transpose(1, 2)
            return self.joint.head(self.joint.activation(f[:, :, None, :] + g[:, None, :, :]))

    return Encoder().eval(), Decoder().eval(), Joiner().eval()


def set_metadata(model, data: dict) -> None:
    del model.metadata_props[:]
    for key, value in data.items():
        prop = model.metadata_props.add()
        prop.key, prop.value = key, str(value)


def export(model, fp32: Path) -> None:
    import onnx
    import torch

    encoder, decoder, joiner = wrappers(model)
    tmp = fp32 / ".export"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    with torch.no_grad():
        frames = 501
        torch.onnx.export(
            encoder, (torch.randn(1, 128, frames), torch.tensor([frames], dtype=torch.int64)),
            str(tmp / "encoder.onnx"), dynamo=False, opset_version=17,
            input_names=["audio_signal", "length"], output_names=["outputs", "encoded_lengths"],
            dynamic_axes={"audio_signal": {0: "N", 2: "T"}, "length": {0: "N"},
                          "outputs": {0: "N", 2: "T_out"}, "encoded_lengths": {0: "N"}})
        state = torch.zeros(2, 1, 640)
        torch.onnx.export(
            decoder, (torch.tensor([[8192]], dtype=torch.int32), torch.tensor([1], dtype=torch.int32), state, state),
            str(tmp / "decoder.onnx"), dynamo=False, opset_version=17,
            input_names=["targets", "target_length", "states.1", "states.2"],
            output_names=["outputs", "prednet_lengths", "states", "states.2_out"],
            dynamic_axes={"targets": {0: "N", 1: "U"}, "target_length": {0: "N"}, "states.1": {1: "N"},
                          "states.2": {1: "N"}, "outputs": {0: "N", 2: "U"}, "prednet_lengths": {0: "N"},
                          "states": {1: "N"}, "states.2_out": {1: "N"}})
        torch.onnx.export(
            joiner, (torch.randn(1, 1024, 1), torch.randn(1, 640, 1)), str(tmp / "joiner.onnx"), dynamo=False,
            opset_version=17, input_names=["encoder_outputs", "decoder_outputs"], output_names=["outputs"],
            dynamic_axes={"encoder_outputs": {0: "N", 2: "T"}, "decoder_outputs": {0: "N", 2: "U"},
                          "outputs": {0: "N", 1: "T", 2: "U"}})
    for name in ("encoder", "decoder", "joiner"):
        graph = onnx.load(str(tmp / f"{name}.onnx"))
        if name == "encoder":
            # The fp32 encoder is over the 2 GB protobuf limit, so its weights go beside it.
            onnx.save(graph, str(fp32 / "encoder.onnx"), save_as_external_data=True,
                      all_tensors_to_one_file=True, location="encoder.weights", size_threshold=0)
        else:
            onnx.save(graph, str(fp32 / f"{name}.onnx"))
        del graph
    shutil.rmtree(tmp)


def quantize(fp32: Path, out: Path) -> None:
    import onnx
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    for name in ("encoder", "decoder", "joiner"):
        graph = onnx.load(str(fp32 / f"{name}.onnx"))
        quantizer = MatMulNBitsQuantizer(graph, bits=8, block_size=128, is_symmetric=True, accuracy_level=4)
        quantizer.process()
        result = quantizer.model.model
        if name == "encoder":
            set_metadata(result, METADATA)
        onnx.save(result, str(out / f"{name}.int8.onnx"))
        del graph, quantizer, result
        print(f"int8    {name}.int8.onnx", flush=True)


def tokens(folder: Path, out: Path) -> None:
    vocab = json.loads((folder / "tokenizer.json").read_text(encoding="utf-8"))["model"]["vocab"]
    pieces = sorted(vocab, key=vocab.get)
    assert [vocab[piece] for piece in pieces] == list(range(8192)), "token ids are not 0-8191"
    assert not any(" " in piece or not piece for piece in pieces)
    lines = [f"{piece} {index}\n" for index, piece in enumerate(pieces)] + ["<blk> 8192\n"]
    path = out / "tokens.txt"
    with open(path, "w", encoding="utf-8", newline="\n") as file:
        file.writelines(lines)
    if sha256(path) != TOKENS_SHA256:
        sys.exit("tokens.txt differs from Parakeet TDT 0.6B v3's vocabulary")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("work", type=Path, help="a folder for the download, the fp32 export and the output")
    parser.add_argument("--source", type=Path, help=f"an existing download of {REPO} at {REVISION[:7]}")
    args = parser.parse_args()

    import torch

    torch.manual_seed(0)
    torch.set_num_threads(12)
    folder = args.source or args.work / "source"
    source(folder, download=args.source is None)
    fp32 = args.work / "fp32"
    out = args.work / "out"
    shutil.rmtree(out, ignore_errors=True)
    fp32.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True)

    model = load(folder)
    print(f"export  {fp32}", flush=True)
    export(model, fp32)
    del model
    quantize(fp32, out)
    tokens(folder, out)

    license_path = out / "LICENSE"
    fetch(LICENSE_URL, license_path)
    if sha256(license_path) != LICENSE_SHA256:
        sys.exit(f"{LICENSE_URL} is not the pinned CC BY 4.0 legal code")
    (out / "NOTICE").write_bytes(NOTICE.encode("utf-8"))
    (out / "README.md").write_bytes(CARD.encode("utf-8"))

    for path in sorted(out.iterdir()):
        print(f"  {path.stat().st_size:>11,}  {sha256(path)}  {path.name}")


if __name__ == "__main__":
    main()
