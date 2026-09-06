"""Bounded, non-mutating OPC/OOXML structural checks. NOT complete XSD validation."""
from collections import Counter
from pathlib import Path
import posixpath
import stat
from urllib.parse import unquote, urlsplit
import zipfile

from lxml import etree as ET

REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
DOCREL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
MAX_PART = 64 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_PARTS = 5000
# Extraction resource policy, not OPC/XSD conformance limits. Bound implicit
# ancestor expansion before constructing any namespace prefixes.
MAX_NAME_BYTES = 1024
MAX_NAME_DEPTH = 32
WINDOWS_DEVICES = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} | {
    prefix + digit for prefix in ("COM", "LPT") for digit in "123456789\u00b9\u00b2\u00b3"
}


def safe_name(name):
    if len(name) > MAX_NAME_BYTES or len(name.encode("utf-8")) > MAX_NAME_BYTES or name.count("/") >= MAX_NAME_DEPTH:
        raise ValueError("Package member exceeds extraction path limits")
    if not name or name.startswith("/") or "\\" in name or ":" in name or any(p in ("", ".", "..") for p in name.split("/")):
        raise ValueError(f"Unsafe package member: {name}")
    # Validate every component on every platform: a package edited on Linux may
    # later be unpacked on Windows. Device stems remain reserved with extensions.
    for component in name.split("/"):
        if (component.endswith((".", " "))
                or component.partition(".")[0].rstrip(" ").upper() in WINDOWS_DEVICES
                or any(ord(char) < 32 or char in '<>"|?*' for char in component)):
            raise ValueError(f"Unsafe package member: {name}")
    return name


def read_package(path):
    path = Path(path)
    parts = {}
    namespace = {}
    entries = 0
    total = 0

    def reject_links(part):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("Package symlinks are unsupported")
        if (stat.S_ISDIR(info.st_mode)
                and getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
            raise ValueError("Package directory reparse points are unsupported")
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError("Package special files are unsupported")

    def add(name, size, reader=None):
        nonlocal total, entries
        safe_name(name)
        directory = reader is None
        # Include implicit ancestor directories. A file 'word' cannot coexist
        # with 'word/document.xml', nor can Word/a.xml alias word/b.xml.
        components = name.split("/")
        for index in range(1, len(components) + 1):
            prefix = "/".join(components[:index])
            key = prefix.casefold()
            is_directory = index < len(components) or directory
            explicit = index == len(components)
            previous = namespace.get(key)
            if previous:
                old_name, old_directory, old_explicit = previous
                if old_name != prefix or old_directory != is_directory or (explicit and old_explicit):
                    raise ValueError("Duplicate, case-colliding or file/directory-conflicting package parts")
                explicit = explicit or old_explicit
            namespace[key] = (prefix, is_directory, explicit)
        entries += 1
        total += size
        if size > MAX_PART or total > MAX_TOTAL or entries > MAX_PARTS:
            raise ValueError("Package exceeds structural-check size limits")
        if directory:
            if size:
                raise ValueError("Package directory entries must not contain data")
        else:
            # Do not trust a ZIP header or an earlier stat for allocation/read bounds.
            # One extra byte detects growth/misreported size; short reads fail closed too.
            with reader() as stream:
                content = stream.read(size + 1)
            if len(content) != size:
                raise ValueError("Package part actual size differs from declared size")
            parts[name] = content

    reject_links(path)
    if path.is_dir():
        for part in path.rglob("*"):
            # rglob yields a junction before descending into it. Reject it here
            # before advancing the iterator; is_symlink alone misses junctions.
            reject_links(part)
            if part.is_dir():
                add(part.relative_to(path).as_posix(), 0)
            elif part.is_file():
                add(part.relative_to(path).as_posix(), part.stat().st_size, lambda entry=part: entry.open("rb"))
    else:
        with zipfile.ZipFile(path) as archive:
            for part in archive.infolist():
                if stat.S_ISLNK(part.external_attr >> 16):
                    raise ValueError("Package symlinks are unsupported")
                # ZipInfo truncates at NUL; never accept its normalized alias.
                if part.orig_filename != part.filename:
                    raise ValueError("Unsafe package member spelling")
                if part.is_dir():
                    add(part.filename[:-1], part.file_size)
                else:
                    add(part.filename, part.file_size, lambda entry=part: archive.open(entry))
    return parts


def parse_xml(data):
    tree = ET.fromstring(data, ET.XMLParser(resolve_entities=False, no_network=True))
    if tree.getroottree().docinfo.doctype:
        raise ValueError("DTD declarations are unsupported")
    return tree


def target_part(owner, target):
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.query or "\\" in target:
        raise ValueError("Invalid internal relationship target")
    decoded = unquote(parsed.path)
    joined = decoded.lstrip("/") if decoded.startswith("/") else posixpath.join(posixpath.dirname(owner), decoded)
    normalized = posixpath.normpath(joined)
    return safe_name(normalized)


def validate_parts(parts):
    errors = []
    warnings = []
    xml = {}
    for name, data in parts.items():
        if name.endswith((".xml", ".rels")):
            try:
                xml[name] = parse_xml(data)
            except Exception as error:
                errors.append(f"Malformed or unsafe XML in {name}: {error}")
    types = xml.get("[Content_Types].xml")
    if types is None or types.tag != f"{{{CT}}}Types":
        errors.append("Missing or invalid [Content_Types].xml")
    defaults, overrides = {}, {}
    if types is not None:
        for node in types:
            if node.tag == f"{{{CT}}}Default":
                key = node.get("Extension", "").lower()
                destination = defaults
            elif node.tag == f"{{{CT}}}Override":
                key = unquote(node.get("PartName", "")).lstrip("/")
                destination = overrides
                if key not in parts:
                    errors.append(f"Content-type override points to missing part: {key}")
            else:
                errors.append("Unknown content-types element")
                continue
            if not key or key in destination or not node.get("ContentType"):
                errors.append("Missing or duplicate content-type declaration")
            destination[key] = node.get("ContentType")
        for name in parts:
            if name != "[Content_Types].xml" and name not in overrides and name.rsplit(".", 1)[-1].lower() not in defaults:
                errors.append(f"No content type for part: {name}")
    relationships = {}
    for name, tree in xml.items():
        if not name.endswith(".rels"):
            continue
        if name == "_rels/.rels":
            owner = ""
        elif "/_rels/" in name:
            prefix, leaf = name.rsplit("/_rels/", 1)
            owner = prefix + "/" + leaf[:-5]
        else:
            errors.append(f"Invalid relationships part location: {name}")
            continue
        if owner and owner not in parts:
            errors.append(f"Relationships owner is missing: {owner}")
        if tree.tag != f"{{{REL}}}Relationships":
            errors.append(f"Invalid relationships root: {name}")
        refs = {}
        for rel in tree:
            rid = rel.get("Id")
            if rel.tag != f"{{{REL}}}Relationship" or not rid or rid in refs or not rel.get("Type") or not rel.get("Target"):
                errors.append(f"Invalid or duplicate relationship in {name}")
                continue
            external = rel.get("TargetMode") == "External"
            target = rel.get("Target")
            if external:
                warnings.append(f"External relationship not fetched: {name}#{rid}")
            else:
                try:
                    target = target_part(owner, target)
                    if target not in parts:
                        errors.append(f"Missing relationship target: {owner} -> {target}")
                except ValueError as error:
                    errors.append(f"{name}#{rid}: {error}")
            refs[rid] = (rel.get("Type"), target, external)
        relationships[owner] = refs
    main = [ref for ref in relationships.get("", {}).values() if ref[0] == DOCREL + "/officeDocument" and not ref[2]]
    if len(main) != 1:
        errors.append("Package must have exactly one internal officeDocument relationship")
    for name, tree in xml.items():
        for element in tree.iter():
            for key, value in element.attrib.items():
                if key.startswith("{" + DOCREL + "}") and value not in relationships.get(name, {}):
                    errors.append(f"Unknown relationship ID {value} in {name}")
    for _, main_name, _ in main:
        tree = xml.get(main_name)
        if tree is None:
            continue
        if tree.tag == f"{{{W}}}document":
            if overrides.get(main_name) != "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml":
                errors.append("Word main part has an unsupported or incorrect content type")
            if tree.find(f"{{{W}}}body") is None:
                errors.append("Word document body is missing")
            comments_refs = [ref for ref in relationships.get(main_name, {}).values() if ref[0] == DOCREL + "/comments"]
            if len(comments_refs) > 1:
                errors.append("Multiple comments parts are ambiguous")
            comment_ids = []
            if comments_refs:
                comments = xml.get(comments_refs[0][1])
                if comments is None or comments.tag != f"{{{W}}}comments":
                    errors.append("Invalid comments part")
                else:
                    comment_ids = [node.get(f"{{{W}}}id") for node in comments.findall(f"{{{W}}}comment")]
                    if len(comment_ids) != len(set(comment_ids)) or None in comment_ids:
                        errors.append("Duplicate or missing comment IDs")
            markers = {tag: Counter(node.get(f"{{{W}}}id") for node in tree.iter(f"{{{W}}}{tag}")) for tag in ("commentReference", "commentRangeStart", "commentRangeEnd")}
            for tag, counts in markers.items():
                for cid, count in counts.items():
                    if cid not in comment_ids or count != 1:
                        errors.append(f"Invalid {tag} ID: {cid}")
            if markers["commentRangeStart"] != markers["commentRangeEnd"]:
                errors.append("Unpaired comment range markers")
            for cid in markers["commentRangeStart"]:
                if cid not in markers["commentReference"]:
                    errors.append(f"Comment range has no reference: {cid}")
        elif tree.tag == f"{{{P}}}presentation":
            if overrides.get(main_name) != "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml":
                errors.append("Presentation main part has an unsupported or incorrect content type")
            ids = [node.get("id") for node in tree.iter(f"{{{P}}}sldId")]
            if None in ids or len(ids) != len(set(ids)):
                errors.append("Duplicate or missing slide IDs")
        elif tree.tag == f"{{{S}}}workbook":
            if overrides.get(main_name) != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml":
                errors.append("Workbook main part has an unsupported or incorrect content type")
            sheets = list(tree.iter(f"{{{S}}}sheet"))
            for attribute in ("name", "sheetId"):
                ids = [node.get(attribute) for node in sheets]
                if None in ids or len(ids) != len(set(ids)):
                    errors.append(f"Duplicate or missing sheet {attribute}")
        else:
            errors.append("Unsupported main document namespace/type (structural checker supports transitional DOCX/PPTX/XLSX)")
    for name, tree in xml.items():
        if tree.tag == f"{{{S}}}worksheet":
            ids = [node.get("r") for node in tree.iter(f"{{{S}}}c")]
            if None in ids or len(ids) != len(set(ids)):
                errors.append(f"Duplicate or missing cell references: {name}")
    return {"valid": not errors, "scope": "opc-ooxml-structural", "xsd_validation": False,
            "parts_checked": len(parts), "errors": errors[:100], "warnings": warnings[:100],
            "limitations": "Not full XSD/ISO conformance, layout rendering, formula calculation, or semantic content verification."}


def validate_package(path):
    try:
        return validate_parts(read_package(path))
    except Exception as error:
        return {"valid": False, "scope": "opc-ooxml-structural", "xsd_validation": False,
                "errors": [str(error)], "warnings": []}
