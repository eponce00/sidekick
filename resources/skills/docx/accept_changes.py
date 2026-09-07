"""Accept all tracked changes in a DOCX file using LibreOffice.

Requires LibreOffice (soffice) to be installed.
"""

import argparse
import logging
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

logger = logging.getLogger(__name__)

ACCEPT_CHANGES_MACRO = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
    Sub AcceptAllTrackedChanges()
        Dim document As Object
        Dim dispatcher As Object

        document = ThisComponent.CurrentController.Frame
        dispatcher = createUnoService("com.sun.star.frame.DispatchHelper")

        dispatcher.executeDispatch(document, ".uno:AcceptAllTrackedChanges", "", 0, Array())
        ThisComponent.store()
        ThisComponent.close(True)
    End Sub
</script:module>"""


def accept_changes(
    input_file: str,
    output_file: str,
) -> tuple[None, str]:
    input_path = Path(input_file)
    output_path = Path(output_file)

    if not input_path.exists():
        return None, f"Error: Input file not found: {input_file}"

    if not input_path.suffix.lower() == ".docx":
        return None, f"Error: Input file is not a DOCX file: {input_file}"

    if output_path.exists() or input_path.resolve() == output_path.resolve():
        return None, "Error: Output must be a new file; existing files are preserved"
    executable = shutil.which("soffice")
    if not executable:
        return None, "Error: Missing dependency: LibreOffice (soffice on PATH). Nothing installed."
    try:
        import defusedxml.ElementTree as ET
    except ImportError:
        return None, "Error: Missing dependency: defusedxml. Nothing installed."
    try:
        with tempfile.TemporaryDirectory(prefix="sidekick-docx-accept-") as temporary:
            root = Path(temporary)
            profile = root / "profile"
            working = root / "working.docx"
            shutil.copy2(input_path, working)
            if not _setup_libreoffice_macro(profile, executable):
                return None, "Error: Failed to set up isolated LibreOffice macro"
            result = subprocess.run(
                [executable, "--headless", f"-env:UserInstallation={profile.as_uri()}",
                 "--norestore", str(working),
                 "vnd.sun.star.script:Standard.Module1.AcceptAllTrackedChanges?language=Basic&location=application"],
                capture_output=True, text=True, timeout=30, check=False,
            )
            if result.returncode != 0:
                return None, "Error: LibreOffice failed; no output published"
            # Do not treat a successful process launch as successful revision acceptance.
            with zipfile.ZipFile(working) as archive:
                if "word/document.xml" not in archive.namelist():
                    return None, "Error: Output is not a valid DOCX package; no output published"
                for name in archive.namelist():
                    if name.startswith("word/") and name.endswith(".xml"):
                        for node in ET.fromstring(archive.read(name)).iter():
                            if not node.tag.startswith("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"):
                                continue
                            tag = node.tag.rsplit("}", 1)[-1]
                            if tag in {"ins", "del", "moveFrom", "moveTo", "cellIns", "cellDel", "cellMerge"} or tag.endswith("Change") or tag.startswith(("moveFromRange", "moveToRange")):
                                return None, "Error: Tracked changes remain; no output published"
            with output_path.open("xb") as target, working.open("rb") as content:
                shutil.copyfileobj(content, target)
    except subprocess.TimeoutExpired:
        return None, "Error: LibreOffice timed out; acceptance is unverified and no output was published"
    except Exception as error:
        return None, f"Error: {error}"

    return (
        None,
        f"Successfully accepted all tracked changes: {input_file} -> {output_file}",
    )


def _setup_libreoffice_macro(profile: Path, executable: str) -> bool:
    macro_dir = profile / "user" / "basic" / "Standard"
    macro_file = macro_dir / "Module1.xba"

    if macro_file.exists() and "AcceptAllTrackedChanges" in macro_file.read_text():
        return True

    if not macro_dir.exists():
        subprocess.run(
            [
                executable,
                "--headless",
                f"-env:UserInstallation={profile.as_uri()}",
                "--terminate_after_init",
            ],
            capture_output=True,
            timeout=10,
            check=False,
        )
        macro_dir.mkdir(parents=True, exist_ok=True)

    try:
        macro_file.write_text(ACCEPT_CHANGES_MACRO)
        return True
    except Exception as e:
        logger.warning(f"Failed to setup LibreOffice macro: {e}")
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Accept all tracked changes in a DOCX file"
    )
    parser.add_argument("input_file", help="Input DOCX file with tracked changes")
    parser.add_argument(
        "output_file", help="Output DOCX file (clean, no tracked changes)"
    )
    args = parser.parse_args()

    _, message = accept_changes(args.input_file, args.output_file)
    print(message)

    if "Error" in message:
        raise SystemExit(1)
