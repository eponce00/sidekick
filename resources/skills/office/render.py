"""Render an Office file to PDF and optional page PNGs using a private LibreOffice profile.

Requires LibreOffice on PATH. Optional --images also requires pdftoppm (Poppler).
Never installs anything or overwrites an existing output directory or source file.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def render(source, destination, images=False, timeout=60):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_file() or source.suffix.lower() not in (".docx", ".pptx", ".xlsx"):
        return {"error": "Input must be an existing DOCX/PPTX/XLSX file"}
    if destination.exists():
        return {"error": "Output directory must be new; existing files are preserved"}
    soffice = shutil.which("soffice")
    if not soffice:
        return {"error": "Missing LibreOffice (soffice on PATH); nothing installed"}
    poppler = shutil.which("pdftoppm") if images else None
    if images and not poppler:
        return {"error": "Missing pdftoppm (Poppler); nothing installed"}
    try:
        with tempfile.TemporaryDirectory(prefix="sidekick-office-render-") as temporary:
            root = Path(temporary)
            profile = (root / "profile").as_uri()
            converted = root / "rendered"
            converted.mkdir()
            result = subprocess.run([soffice, f"-env:UserInstallation={profile}", "--headless", "--norestore",
                                     "--convert-to", "pdf", "--outdir", str(converted), str(source)],
                                    capture_output=True, timeout=max(1, timeout), check=False)
            pdf = converted / (source.stem + ".pdf")
            if result.returncode != 0 or not pdf.is_file() or not pdf.read_bytes().startswith(b"%PDF-"):
                return {"error": "LibreOffice did not produce a PDF; no output published"}
            if images:
                result = subprocess.run([poppler, "-png", "-r", "100", str(pdf), str(converted / "page")],
                                        capture_output=True, timeout=max(1, timeout), check=False)
                if result.returncode != 0 or not list(converted.glob("page-*.png")):
                    return {"error": "Page rendering failed; no output published"}
            # copytree rejects a destination created since the initial check.
            shutil.copytree(converted, destination)
            return {"status": "success", "pdf": str(destination / pdf.name),
                    "images": [str(destination / p.name) for p in sorted(converted.glob("page-*.png"))],
                    "note": "Rendered by LibreOffice; inspect pages for layout and content. Rendering is not full XSD validation."}
    except subprocess.TimeoutExpired:
        return {"error": "Office rendering timed out; output was not verified or published"}
    except Exception as error:
        return {"error": str(error)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--images", action="store_true")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()
    report = render(args.source, args.destination, args.images, args.timeout)
    print(json.dumps(report, indent=2))
    sys.exit(0 if report.get("status") == "success" else 1)
