"""Child process of `guard-scan.mjs`: one Hermes plugin scanner over one tree.

    python3 -I -B guard-scan-run.py <scanner root> <tree>

It imports `tools.plugin_guard` from the scanner checkout at `<scanner root>`
(and refuses to go on when the module came from anywhere else, because the fork
and upstream both define a package called `tools`), calls the two functions an
install or update calls,

    scan_plugin(tree)
    should_allow_plugin_install(result)

and prints the scanner's own report followed by one line, `GUARD_SCAN_RESULT`
and a JSON object, for the parent to read. It decides nothing: the parent passes
a tree only on a `safe` verdict that the install would allow outright.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

RESULT_PREFIX = "GUARD_SCAN_RESULT "


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: guard-scan-run.py <scanner root> <tree>", file=sys.stderr)
        return 2
    root = Path(argv[1])
    tree = Path(argv[2])

    sys.path.insert(0, str(root))
    from tools import plugin_guard  # noqa: PLC0415 - must follow the sys.path edit

    loaded = Path(plugin_guard.__file__).resolve()
    if root.resolve() not in loaded.parents:
        print(f"refusing to continue: tools.plugin_guard came from {loaded}, not from {root}", file=sys.stderr)
        return 1

    result = plugin_guard.scan_plugin(tree, source="hermie-web-client")
    allowed, reason = plugin_guard.should_allow_plugin_install(result)
    print(plugin_guard.format_scan_report(result))
    payload = {
        "verdict": str(result.verdict),
        "allowed": allowed,
        "reason": str(reason),
        "scanner_version": str(getattr(plugin_guard, "PLUGIN_SCANNER_VERSION", "unknown")),
        "findings": [
            {
                "severity": str(f.severity),
                "category": str(f.category),
                "pattern": str(f.pattern_id),
                "file": str(f.file),
                "line": int(f.line),
            }
            for f in result.findings
        ],
    }
    print(RESULT_PREFIX + json.dumps(payload, sort_keys=True))
    return 0 if (result.verdict == "safe" and allowed is True) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
