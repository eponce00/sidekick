"""Packs a rendered frame sequence into an animated WebP for the README.

Usage: python -I encode.py <frames-dir> <out.webp> [fps] [every]
"""
import pathlib
import sys

from PIL import Image

frames_dir, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
fps = int(sys.argv[3]) if len(sys.argv) > 3 else 30
every = int(sys.argv[4]) if len(sys.argv) > 4 else 2
files = sorted(p for p in frames_dir.iterdir() if p.suffix in ('.jpeg', '.jpg', '.png'))[::every]
frames = [Image.open(p).convert('RGB') for p in files]
frames[0].save(
    out,
    save_all=True,
    append_images=frames[1:],
    duration=round(1000 * every / fps),
    loop=0,
    quality=78,
    method=6,
)
print(f'{out.name}: {len(frames)} frames, {out.stat().st_size / 1e6:.1f} MB')
