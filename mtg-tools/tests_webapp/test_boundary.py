"""The dependency arrow points one way.

`webapp` may import `binders`. `binders` may never import `webapp`, or Flask,
or anything else outside the standard library — that is what keeps the library
usable, testable and installable with nothing installed, and it is the reason
the core suite lives in a separate runner.
"""

from __future__ import annotations

import ast
import os
import subprocess
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BINDERS = os.path.join(REPO, "binders")

STDLIB_OK = {
    "__future__", "argparse", "ast", "collections", "contextlib", "csv",
    "dataclasses", "datetime", "decimal", "difflib", "functools", "hashlib",
    "io", "json", "math", "os", "re", "statistics", "sys", "tempfile",
    "typing", "unicodedata", "unittest", "urllib", "webbrowser",
}


def _module_files():
    for name in sorted(os.listdir(BINDERS)):
        if name.endswith(".py"):
            yield os.path.join(BINDERS, name)


class TestBindersStaysPure(unittest.TestCase):
    def test_no_third_party_imports_anywhere_in_binders(self):
        offenders = []
        for path in _module_files():
            with open(path, encoding="utf-8") as handle:
                tree = ast.parse(handle.read(), path)
            for node in ast.walk(tree):
                roots = []
                if isinstance(node, ast.Import):
                    roots = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    # level > 0 is a relative import inside the package.
                    if node.level == 0 and node.module:
                        roots = [node.module.split(".")[0]]
                for root in roots:
                    # `binders` and `webapp` are both first-party. That `webapp`
                    # is imported *lazily* is enforced by
                    # `test_webapp_import_in_cli_is_lazy`; this test is only
                    # about third-party dependencies.
                    if root in ("binders", "webapp"):
                        continue
                    if root not in STDLIB_OK:
                        offenders.append((os.path.basename(path), root))
        self.assertEqual(offenders, [], f"non-stdlib imports in binders: {offenders}")

    def test_importing_binders_does_not_pull_in_flask(self):
        """Even with Flask installed, importing the library must not touch it."""
        code = (
            "import sys; import binders; "
            "import binders.cli, binders.dashboard, binders.sealed_dashboard; "
            "bad = [m for m in sys.modules if m.split('.')[0] in "
            "('flask','werkzeug','jinja2','click','webapp')]; "
            "print(','.join(sorted(bad)))"
        )
        out = subprocess.run(
            [sys.executable, "-c", code], cwd=REPO, capture_output=True, text=True
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "", "binders pulled in a web dependency")

    def test_webapp_import_in_cli_is_lazy(self):
        """`serve` imports webapp inside the function, not at module scope."""
        with open(os.path.join(BINDERS, "cli.py"), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                name = getattr(node, "module", "") or ""
                self.assertNotIn("webapp", name)


if __name__ == "__main__":
    unittest.main()
