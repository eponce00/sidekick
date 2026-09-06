"""Add an anchored classic DOCX comment to an unpacked package without regenerating it.

Plain text is escaped by the XML library. Existing parts/comments are retained.
Threaded replies are deliberately unsupported; --parent fails before mutation.
"""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import posixpath
import sys
import tempfile
from urllib.parse import unquote

from lxml import etree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
COMMENT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
COMMENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"


def parse_xml(data):
    parser = ET.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)
    tree = ET.fromstring(data, parser)
    if tree.getroottree().docinfo.doctype:
        raise ValueError("DTD declarations are not supported")
    return tree


def package_path(root, part):
    path = root / part
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Package paths must remain inside the document; symlinks are unsupported")
    return path


def commit_parts(parts):
    """Stage bytes and backups first; ordinary I/O rollback, not crash-atomic commit."""
    originals = {path: path.read_bytes() if path.exists() else None for path in parts}
    staged = {}
    backups = {}
    retained = set()
    replaced = []
    phase = "staging"
    try:
        for path, content in parts.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".sidekick-comment-", delete=False) as stream:
                staged[path] = Path(stream.name)
                stream.write(content)
            if originals[path] is not None:
                with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".sidekick-comment-backup-{path.name}-", delete=False) as stream:
                    backups[path] = Path(stream.name)
                    stream.write(originals[path])
        phase = "replacement"
        for path, temporary in staged.items():
            os.replace(temporary, path)
            replaced.append(path)
    except Exception:
        rollback_failures = 0
        for path in reversed(replaced):
            try:
                if originals[path] is None:
                    path.unlink(missing_ok=True)
                else:
                    os.replace(backups[path], path)
            except OSError:
                rollback_failures += 1
                if path in backups:
                    retained.add(backups[path])
        # Never include exception text, document content, or paths in this diagnostic.
        message = f"Comment transaction failed during {phase}."
        if rollback_failures:
            message += (f" Rollback incomplete for {rollback_failures} part(s); do not pack this directory."
                        f" Retained {len(retained)} original backup(s) in .sidekick-comment-backup-* files beside affected parts.")
        else:
            message += " Original parts restored; no comment changes committed."
        raise RuntimeError(message) from None
    finally:
        for temporary in (*staged.values(), *backups.values()):
            if temporary not in retained:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    print("Warning: Could not remove a .sidekick-comment- staging file", file=sys.stderr)


def add_comment(unpacked_dir, comment_id, text, author="SideKick", initials="SK",
                parent_id=None, paragraph_index=0):
    try:
        if parent_id is not None:
            raise ValueError("Threaded replies are not supported; no document changes made")
        if not isinstance(paragraph_index, int) or paragraph_index < 0:
            raise ValueError("paragraph index must be a non-negative integer")
        root = Path(unpacked_dir).resolve()
        document_path = package_path(root, "word/document.xml")
        types_path = package_path(root, "[Content_Types].xml")
        rels_path = package_path(root, "word/_rels/document.xml.rels")
        document = parse_xml(document_path.read_bytes())
        if document.tag != f"{{{W}}}document":
            raise ValueError("Only transitional WordprocessingML documents are supported")
        types = parse_xml(types_path.read_bytes())
        if types.tag != f"{{{CT}}}Types":
            raise ValueError("Invalid package content-types root")
        rels = parse_xml(rels_path.read_bytes()) if rels_path.exists() else ET.Element(f"{{{R}}}Relationships", nsmap={None: R})
        if rels.tag != f"{{{R}}}Relationships":
            raise ValueError("Invalid document relationships root")
        relationships = list(rels)
        ids = [rel.get("Id") for rel in relationships]
        if any(not value for value in ids) or len(ids) != len(set(ids)):
            raise ValueError("Duplicate or missing relationship IDs")
        comment_relationships = [rel for rel in relationships if rel.get("Type") == COMMENT_REL]
        if len(comment_relationships) > 1:
            raise ValueError("Multiple comments relationships are ambiguous")
        if comment_relationships:
            rel = comment_relationships[0]
            if rel.get("TargetMode") == "External":
                raise ValueError("External comments parts are unsupported")
            target = unquote(rel.get("Target", ""))
            if not target or "\\" in target or ":" in target:
                raise ValueError("Invalid comments relationship target")
            part = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "word/" + target)
        else:
            part = "word/comments.xml"
        comments_path = package_path(root, part)
        if comment_relationships and not comments_path.is_file():
            raise ValueError("Existing comments relationship points to a missing part")
        comments = parse_xml(comments_path.read_bytes()) if comments_path.exists() else ET.Element(f"{{{W}}}comments", nsmap={"w": W})
        if comments.tag != f"{{{W}}}comments":
            raise ValueError("Invalid comments part root")
        used = [comment.get(f"{{{W}}}id") for comment in comments.findall(f"{{{W}}}comment")]
        if len(used) != len(set(used)) or any(value is None or not value.isdecimal() for value in used):
            raise ValueError("Existing comment IDs are invalid or duplicated")
        # Do not reuse an orphan marker ID in a damaged document.
        occupied = set(used)
        for tag in ("commentReference", "commentRangeStart", "commentRangeEnd"):
            occupied.update(node.get(f"{{{W}}}id") for node in document.iter(f"{{{W}}}{tag}"))
        if comment_id is None:
            comment_id = max([int(value) for value in occupied if value and value.isdecimal()] + [-1]) + 1
        if not isinstance(comment_id, int) or comment_id < 0 or str(comment_id) in occupied:
            raise ValueError("Comment ID must be unique and non-negative; use auto to allocate one")
        body = document.find(f"{{{W}}}body")
        paragraphs = list(body.iter(f"{{{W}}}p")) if body is not None else []
        if paragraph_index >= len(paragraphs):
            raise ValueError("Requested paragraph does not exist")
        paragraph = paragraphs[paragraph_index]
        cid = str(comment_id)
        comment = ET.SubElement(comments, f"{{{W}}}comment", {
            f"{{{W}}}id": cid, f"{{{W}}}author": author, f"{{{W}}}initials": initials,
            f"{{{W}}}date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        for line in text.split("\n"):
            p = ET.SubElement(comment, f"{{{W}}}p")
            run = ET.SubElement(p, f"{{{W}}}r")
            t = ET.SubElement(run, f"{{{W}}}t", {"{http://www.w3.org/XML/1998/namespace}space": "preserve"})
            t.text = line
        # Keep paragraph properties first, preserve all pre-existing content/markers.
        start = ET.Element(f"{{{W}}}commentRangeStart", {f"{{{W}}}id": cid})
        paragraph.insert(1 if len(paragraph) and paragraph[0].tag == f"{{{W}}}pPr" else 0, start)
        ET.SubElement(paragraph, f"{{{W}}}commentRangeEnd", {f"{{{W}}}id": cid})
        reference_run = ET.SubElement(paragraph, f"{{{W}}}r")
        ET.SubElement(reference_run, f"{{{W}}}commentReference", {f"{{{W}}}id": cid})
        if not comment_relationships:
            number = 1
            while f"rId{number}" in ids:
                number += 1
            ET.SubElement(rels, f"{{{R}}}Relationship", {"Id": f"rId{number}", "Type": COMMENT_REL,
                          "Target": posixpath.relpath(part, "word")})
        overrides = [node for node in types if node.get("PartName") == "/" + part]
        if len(overrides) > 1 or (overrides and overrides[0].get("ContentType") != COMMENT_TYPE):
            raise ValueError("Comments content type is conflicting or duplicated")
        if not overrides:
            ET.SubElement(types, f"{{{CT}}}Override", {"PartName": "/" + part, "ContentType": COMMENT_TYPE})
        parts = {document_path: document, comments_path: comments, types_path: types, rels_path: rels}
        commit_parts({path: ET.tostring(tree, encoding="UTF-8", xml_declaration=True, standalone=True)
                      for path, tree in parts.items()})
        return cid, f"Added anchored classic comment {cid} to paragraph {paragraph_index}"
    except Exception as error:
        return "", f"Error: {error}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("unpacked_dir")
    parser.add_argument("comment_id", help="Unique integer ID, or auto")
    parser.add_argument("text", help="Plain comment text; do not XML-escape it")
    parser.add_argument("--paragraph", type=int, required=True, help="Zero-based paragraph index in the document body")
    parser.add_argument("--author", default="SideKick")
    parser.add_argument("--initials", default="SK")
    parser.add_argument("--parent", type=int, help="Unsupported; fails without mutation")
    args = parser.parse_args()
    try:
        cid = None if args.comment_id == "auto" else int(args.comment_id)
    except ValueError:
        parser.error("comment_id must be an integer or auto")
    _, message = add_comment(args.unpacked_dir, cid, args.text, args.author, args.initials, args.parent, args.paragraph)
    print(message)
    sys.exit(1 if message.startswith("Error:") else 0)
