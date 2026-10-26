"""验证交付包的实际入口、依赖和小说隔离，不写入正式数据。"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import build_web_package as package
import make_init_package as initial


class PackageTests(unittest.TestCase):
    def test_owner_and_partner_packages_have_independent_correct_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = package.build(ROOT, tmp)
            with zipfile.ZipFile(result["owner"]["path"]) as z:
                self.assertIn("hub.js", z.namelist())
                self.assertIn("legacy.html", z.namelist())
                self.assertIn(b"hub.js", z.read("index.html"))
            with zipfile.ZipFile(result["partner"]["path"]) as z:
                self.assertIn(b"reader.js", z.read("index.html"))
                self.assertNotIn("hub.js", z.namelist())
                self.assertNotIn("legacy.html", z.namelist())
                self.assertIn("hub-core.mjs", z.namelist())
                self.assertFalse(any(name.startswith("book/") or name.startswith("qa-") for name in z.namelist()))

    def test_management_package_is_empty_and_contains_no_novel_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = package.build(ROOT, tmp)
            with zipfile.ZipFile(result["management"]["path"]) as z:
                data = json.loads(z.read("books.json"))
                self.assertEqual(data["books"], [])
                self.assertEqual(data["revision"], 0)
                self.assertNotIn("token", data)
                self.assertFalse(any(name.startswith("book/") for name in z.namelist()))

    def test_initialization_archive_contains_executable_checker_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "init.zip"
            initial.build(ROOT, out)
            with zipfile.ZipFile(out) as z:
                for name in ("tools/check_updates.mjs", "tools/daily_update.py", "web/dist/hub-core.mjs", "web/dist/core.mjs", "docs/每日自动更新.md", "docs/旧书接入工作台.md"):
                    self.assertIn(name, z.namelist())
                self.assertNotIn("book/daily/active.json", z.namelist())
                z.extractall(Path(tmp) / "extracted")
            import shutil
            if shutil.which("node"):
                run = subprocess.run(["node", "tools/check_updates.mjs", "--help"], cwd=Path(tmp) / "extracted", capture_output=True, text=True)
                self.assertEqual(run.returncode, 0, run.stderr)
