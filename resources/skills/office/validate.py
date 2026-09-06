"""Non-mutating structural validation for DOCX/PPTX/XLSX packages or unpacked directories.

Checks OPC relationships/content types and selected Office invariants.
This is not full XSD validation, rendering QA, or semantic/content equivalence.
"""
import argparse
import json
import sys
from structure import validate_package


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument("--xsd", action="store_true", help="Require full XSD validation (currently unsupported)")
    parser.add_argument("--original", help="Compatibility argument; no semantic comparison is implied")
    args = parser.parse_args()
    if args.xsd:
        report = {"valid": False, "scope": "xsd", "errors": ["Full XSD validation is not bundled; structural checks are not a substitute."]}
    else:
        report = validate_package(args.path)
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["valid"] else 1)
