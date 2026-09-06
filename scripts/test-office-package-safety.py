"""Synthetic, no-Office/no-GUI regression tests for package path preflight."""
from pathlib import Path
import io
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
OFFICE = Path(__file__).resolve().parents[1] / "resources" / "skills" / "office"
sys.path.insert(0, str(OFFICE))
import structure
from unpack import unpack
from pack import pack


class PackageSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sidekick-package-safety-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def archive(self, entries):
        path = self.root / "fixture.docx"
        with zipfile.ZipFile(path, "w") as archive:
            for name, content in entries:
                archive.writestr(name, content)
        return path

    def test_rejects_portability_names_during_read_without_extracting(self):
        for name in ("NUL", "word/CON.xml", "word/Aux.data", "COM1.txt", "LPT9/rels.xml", "CONIN$.xml",
                     "COM\u00b9.xml", "LPT\u00b2.xml", "word/document.xml.", "word /document.xml",
                     "word/a?b.xml", "word/a\x01b.xml"):
            with self.subTest(name=name):
                path = self.archive([(name, b"synthetic")])
                with self.assertRaisesRegex(ValueError, "Unsafe package member"):
                    structure.read_package(path)
                output = self.root / "unsafe-output"
                _, message = unpack(str(path), str(output))
                self.assertIn("Unsafe package member", message)
                self.assertFalse(output.exists())

    def test_rejects_symlink_directory_header(self):
        for name in ("linked/", "linked.xml"):
            with self.subTest(name=name):
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                with self.assertRaisesRegex(ValueError, "symlinks"):
                    structure.read_package(self.archive([(entry, b"")]))

    def test_directory_entries_count_toward_bound(self):
        path = self.archive([("a/", b""), ("b/", b""), ("c/", b"")])
        with patch.object(structure, "MAX_PARTS", 2):
            with self.assertRaisesRegex(ValueError, "size limits"):
                structure.read_package(path)

    def test_member_depth_and_utf8_byte_bounds(self):
        # Limits are extraction safety policy, not a claim about the OPC standard.
        boundary = "/".join(["a"] * 32)
        self.assertEqual(structure.safe_name(boundary), boundary)
        with self.assertRaisesRegex(ValueError, "path limits"):
            structure.read_package(self.archive([(boundary + "/a", b"synthetic")]))
        byte_boundary = "/".join(["a" * 127] * 7 + ["a" * 128])
        self.assertEqual(len(byte_boundary.encode("utf-8")), 1024)
        self.assertEqual(structure.safe_name(byte_boundary), byte_boundary)
        for excessive in (byte_boundary + "a", "é" * 513):
            with self.assertRaisesRegex(ValueError, "path limits"):
                structure.read_package(self.archive([(excessive, b"synthetic")]))

    @unittest.skipUnless(sys.platform == "win32", "Windows junction regression")
    def test_rejects_junction_before_reading_outside_package_root(self):
        # Both endpoints are owned synthetic fixtures inside this worktree.
        with tempfile.TemporaryDirectory(prefix=".office-junction-safety-", dir=OFFICE.parents[2]) as temporary:
            root = Path(temporary)
            source, outside = root / "source", root / "outside-package"
            source.mkdir()
            outside.mkdir()
            (outside / "sentinel.txt").write_bytes(b"synthetic-only")
            linked = source / "linked"
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(linked), str(outside)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, "Could not create contained fixture junction")
            self.assertFalse(linked.is_symlink(), "Regression specifically targets non-symlink junctions")
            # Establish the alias using only owned bytes; do not require newer
            # pathlib versions to retain Python 3.10's recursive junction traversal.
            self.assertEqual((linked / "sentinel.txt").read_bytes(), b"synthetic-only")
            with self.assertRaisesRegex(ValueError, "reparse"):
                structure.read_package(source)
            with self.assertRaisesRegex(ValueError, "reparse"):
                structure.read_package(linked)

    def test_rejects_directory_payload(self):
        with self.assertRaisesRegex(ValueError, "directory"):
            structure.read_package(self.archive([("word/", b"hidden payload")]))

    def test_rejects_nul_truncated_zip_name(self):
        path = self.archive([("badXname.xml", b"synthetic")])
        path.write_bytes(path.read_bytes().replace(b"badXname.xml", b"bad\x00name.xml"))
        with self.assertRaisesRegex(ValueError, "Unsafe package member"):
            structure.read_package(path)

    def test_directory_size_is_checked(self):
        path = self.archive([("word/", b"large")])
        with patch.object(structure, "MAX_PART", 4):
            with self.assertRaisesRegex(ValueError, "size limits"):
                structure.read_package(path)

    def test_native_directory_names_are_preflighted_even_without_files(self):
        source = self.root / "source"
        source.mkdir()
        # '?' is legal on POSIX but cannot be created normally on Windows;
        # mock the filesystem entry only, leaving real preflight and pack intact.
        directory = source / "unsafe?directory"
        directory_info = source.lstat()
        with patch.object(Path, "rglob", return_value=iter([directory])), \
                patch.object(Path, "is_dir", return_value=True), \
                patch.object(Path, "lstat", return_value=directory_info):
            _, message = pack(str(source), str(self.root / "rejected.docx"), validate=False)
        self.assertIn("Unsafe package member", message)
        self.assertFalse((self.root / "rejected.docx").exists())

    def test_conflicting_namespace_fails_before_output_creation(self):
        for names in (("word", "word/document.xml"), ("word/document.xml", "word"),
                      ("Word/a.xml", "word/b.xml"), ("word/", "WORD/"), ("word//",)):
            with self.subTest(names=names):
                path = self.archive([(name, b"" if name.endswith("/") else b"synthetic") for name in names])
                output = self.root / "unpacked"
                _, message = unpack(str(path), str(output))
                self.assertIn("Error", message)
                self.assertFalse(output.exists(), "Unsafe archive must fail before output creation")

    def test_ordinary_explicit_and_implicit_directories_remain_supported(self):
        parts = {
            "[Content_Types].xml": (
                f'<Types xmlns="{structure.CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="png" ContentType="image/png"/>'
                '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
            ).encode(),
            "_rels/.rels": (
                f'<Relationships xmlns="{structure.REL}"><Relationship Id="r1" Type="{structure.DOCREL}/officeDocument" Target="word/document.xml"/></Relationships>'
            ).encode(),
            "word/document.xml": f'<w:document xmlns:w="{structure.W}"><w:body/></w:document>'.encode(),
            "word/media/image1.png": b"synthetic"
        }
        path = self.archive([("word/", b""), *parts.items(), ("word/media/", b"")])
        self.assertEqual(structure.read_package(path), parts)
        output = self.root / "unpacked"
        _, message = unpack(str(path), str(output))
        self.assertNotIn("Error", message)
        self.assertEqual((output / "word/media/image1.png").read_bytes(), b"synthetic")
        _, message = pack(str(output), str(self.root / "repacked.docx"), validate=True)
        self.assertNotIn("Error", message)
        self.assertEqual(set(structure.read_package(self.root / "repacked.docx")), set(parts))

    def test_actual_stream_bytes_cannot_exceed_declared_zip_size(self):
        path = self.archive([("part.bin", b"x")])
        reads = []

        class MismatchedStream(io.BytesIO):
            def read(self, size=-1):
                reads.append(size)
                return super().read(size)

        with patch.object(zipfile.ZipFile, "open", side_effect=lambda *a, **k: MismatchedStream(b"oversized")):
            with self.assertRaisesRegex(ValueError, "size"):
                structure.read_package(path)
        self.assertTrue(all(0 <= size <= 2 for size in reads))

    def test_declared_compressed_bomb_rejected_before_member_open(self):
        path = self.root / "compressed.docx"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("part.bin", b"a" * 64)
        with patch.object(structure, "MAX_PART", 8), patch.object(zipfile.ZipFile, "open") as opened:
            with self.assertRaisesRegex(ValueError, "size limits"):
                structure.read_package(path)
        opened.assert_not_called()

    def test_file_grown_since_stat_does_not_bypass_byte_limit(self):
        source = self.root / "source"
        source.mkdir()
        part = source / "part.bin"
        part.write_bytes(b"oversized")
        original_stat = Path.stat

        def stale_stat(path, *args, **kwargs):
            info = original_stat(path, *args, **kwargs)
            if path == part:
                class Info:
                    st_mode = info.st_mode
                    st_file_attributes = getattr(info, "st_file_attributes", 0)
                    st_size = 1
                return Info()
            return info

        with patch.object(Path, "stat", stale_stat), patch.object(structure, "MAX_PART", 4):
            with self.assertRaisesRegex(ValueError, "actual size"):
                structure.read_package(source)

    def test_actual_stream_shorter_than_declared_is_rejected(self):
        path = self.archive([("part.bin", b"longer")])
        with patch.object(zipfile.ZipFile, "open", side_effect=lambda *a, **k: io.BytesIO(b"x")):
            with self.assertRaisesRegex(ValueError, "actual size"):
                structure.read_package(path)

    def test_native_special_entry_rejected_not_silently_omitted(self):
        source = self.root / "source"
        source.mkdir()
        special = source / "synthetic-fifo"
        original = Path.lstat

        def entry_info(path):
            if path == special:
                class Info:
                    st_mode = stat.S_IFIFO | 0o600
                    st_file_attributes = 0
                return Info()
            return original(path)

        with patch.object(Path, "rglob", return_value=iter([special])), patch.object(Path, "lstat", entry_info):
            with self.assertRaisesRegex(ValueError, "special"):
                structure.read_package(source)

    def test_dtds_are_rejected_without_entity_resolution(self):
        original = structure.ET.XMLParser
        resolutions = []

        class DenyResolver(structure.ET.Resolver):
            def resolve(self, url, public_id, context):
                resolutions.append(url)
                raise AssertionError("No entity fetch is permitted")

        def parser(*args, **kwargs):
            value = original(*args, **kwargs)
            value.resolvers.add(DenyResolver())
            return value

        with patch.object(structure.ET, "XMLParser", parser):
            for document in ('<!DOCTYPE x [<!ENTITY a "tiny">]><x>&a;</x>',
                             '<!DOCTYPE x SYSTEM "file:///NONEXISTENT-SYNTHETIC.dtd"><x/>',
                             '<!DOCTYPE x [<!ENTITY a SYSTEM "https://example.invalid/entity">]><x>&a;</x>'):
                with self.subTest(document=document):
                    with self.assertRaisesRegex(ValueError, "DTD"):
                        structure.parse_xml(document.encode())
        self.assertEqual(resolutions, [])

    def test_external_relationship_is_only_reported_not_fetched(self):
        parts = {"_rels/.rels": f'<Relationships xmlns="{structure.REL}"><Relationship Id="r1" Type="example" Target="https://example.invalid/synthetic" TargetMode="External"/></Relationships>'.encode()}
        report = structure.validate_parts(parts)
        self.assertIn("External relationship not fetched", " ".join(report["warnings"]))


if __name__ == "__main__":
    unittest.main()
