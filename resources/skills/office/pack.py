"""Pack a directory into a DOCX, PPTX, or XLSX file.

Performs bounded structural validation, condenses XML formatting, and creates the Office file.
Structural validation is not complete XSD validation or rendering verification.

Usage:
    python pack.py <input_directory> <output_file> [--original <file>] [--validate true|false]

Examples:
    python pack.py unpacked/ output.docx --original input.docx
    python pack.py unpacked/ output.pptx --validate false
"""

import argparse
import os
import stat
import sys

# Ensure stdout/stderr use UTF-8 on Windows (avoids cp1252 encoding crashes)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')  # type: ignore
import tempfile
import zipfile
from pathlib import Path

import defusedxml.minidom

from structure import MAX_PARTS, read_package, safe_name, validate_parts

TRANSACTION_PREFIXES = (".sidekick-comment-", ".sidekick-pack-")
TRANSACTION_RESIDUE_ERROR = (
    "Error: Office transaction residue detected. Review and recover the original parts first; "
    "remove recognized staging/backup files only after review, then retry. Nothing was packed or removed."
)


def _transaction_residue(name):
    return any(part.casefold().startswith(TRANSACTION_PREFIXES) for part in Path(name).parts)


def _package_names_without_following_links(root):
    """Bounded metadata-only preflight; never recurse through symlinks/reparse points."""
    def check(info):
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            raise ValueError("Package links and reparse points are unsupported")
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError("Package special files are unsupported")

    check(root.lstat())
    pending = [(root, 0)]
    entries = 0
    while pending:
        directory, depth = pending.pop()
        # Check again immediately before opening, including directories queued earlier.
        check(directory.lstat())
        with os.scandir(directory) as children:
            for child in children:
                entries += 1
                if entries > MAX_PARTS or depth >= 32:
                    raise ValueError("Package exceeds residue-scan entry/depth limits")
                path = Path(child.path)
                name = path.relative_to(root).as_posix()
                if len(name) > 1024 or len(name.encode("utf-8")) > 1024:
                    raise ValueError("Package exceeds residue-scan path limits")
                safe_name(name)
                info = child.stat(follow_symlinks=False)
                check(info)
                yield name
                if stat.S_ISDIR(info.st_mode):
                    pending.append((path, depth + 1))

def pack(
    input_directory: str,
    output_file: str,
    original_file: str | None = None,
    validate: bool = True,
    infer_author_func=None,
) -> tuple[None, str]:
    input_dir = Path(input_directory)
    output_path = Path(output_file)
    suffix = output_path.suffix.lower()

    if not input_dir.is_dir():
        return None, f"Error: {input_dir} is not a directory"

    if suffix not in {".docx", ".pptx", ".xlsx"}:
        return None, f"Error: {output_file} must be a .docx, .pptx, or .xlsx file"
    if os.path.lexists(output_path):
        return None, "Error: Output already exists; choose a new output path"

    try:
        # Inspect names before reading bytes, including empty residue directories.
        # Never silently discard backups that may contain the only original content.
        if _transaction_residue(input_dir.name) or any(
            _transaction_residue(name) for name in _package_names_without_following_links(input_dir)
        ):
            return None, TRANSACTION_RESIDUE_ERROR
        # Path/size/symlink safety applies even when semantic structural checks are disabled.
        parts = read_package(input_dir)
        # A residue may have appeared after the directory scan; reject that snapshot too.
        if any(_transaction_residue(name) for name in parts):
            return None, TRANSACTION_RESIDUE_ERROR
    except Exception as error:
        return None, f"Error: Unsafe or unreadable package: {error}"

    if validate:
        report = validate_parts(parts)
        if not report["valid"]:
            return None, "Error: Structural validation failed: " + "; ".join(report["errors"])
        print("OPC/OOXML structural checks passed; full XSD, rendering, and semantic validation not performed")

    staged = None
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_content_dir = Path(temp_dir) / "content"
            temp_content_dir.mkdir()
            for name, content in parts.items():
                destination = temp_content_dir / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(content)

            for pattern in ["*.xml", "*.rels"]:
                for xml_file in temp_content_dir.rglob(pattern):
                    _condense_xml(xml_file)

            output_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w+b", dir=output_path.parent,
                                             prefix=".sidekick-pack-", suffix=".tmp", delete=False) as stream:
                staged = Path(stream.name)
                with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as zf:
                    for f in temp_content_dir.rglob("*"):
                        if f.is_file():
                            zf.write(f, f.relative_to(temp_content_dir))
                stream.flush()
                os.fsync(stream.fileno())

        # Same-directory hard-link publication is atomic and cannot replace a destination
        # created since the initial check. Never fall back to copy or overwriting rename.
        # Unsupported filesystems fail closed; a crash may leave only a hidden staging file.
        os.link(staged, output_path)
    except Exception as error:
        return None, f"Error: Packing or atomic publication failed: {error}"
    finally:
        if staged is not None:
            try:
                staged.unlink(missing_ok=True)
            except OSError:
                # Publication may already have succeeded. Do not misreport a complete final
                # artifact as a failed write solely because temporary-name cleanup failed.
                print("Warning: Could not remove a .sidekick-pack- staging file", file=sys.stderr)

    return None, f"Successfully packed {input_dir} to {output_file}" + (" (structural validation passed; not XSD validation)" if validate else " (validation not performed)")


def _condense_xml(xml_file: Path) -> None:
    try:
        with open(xml_file, encoding="utf-8") as f:
            dom = defusedxml.minidom.parse(f)

        for element in dom.getElementsByTagName("*"):
            if element.tagName.endswith(":t"):
                continue

            for child in list(element.childNodes):
                if (
                    child.nodeType == child.TEXT_NODE
                    and child.nodeValue
                    and child.nodeValue.strip() == ""
                ) or child.nodeType == child.COMMENT_NODE:
                    element.removeChild(child)

        xml_file.write_bytes(dom.toxml(encoding="UTF-8"))
    except Exception as e:
        print(f"ERROR: Failed to parse {xml_file.name}: {e}", file=sys.stderr)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Pack a directory into a DOCX, PPTX, or XLSX file"
    )
    parser.add_argument("input_directory", help="Unpacked Office document directory")
    parser.add_argument("output_file", help="Output Office file (.docx/.pptx/.xlsx)")
    parser.add_argument(
        "--original",
        help="Legacy compatibility argument; structural checks do not compare document semantics",
    )
    parser.add_argument(
        "--validate",
        type=lambda x: x.lower() == "true",
        default=True,
        metavar="true|false",
        help="Run non-mutating structural checks, not XSD validation (default: true)",
    )
    args = parser.parse_args()

    _, message = pack(
        args.input_directory,
        args.output_file,
        original_file=args.original,
        validate=args.validate,
    )
    print(message)

    if "Error" in message:
        sys.exit(1)
