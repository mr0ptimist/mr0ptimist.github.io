import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
try:
    from dev_actions import dispatch, parse_url
    from setup_winfs_protocol import install, registration_plan
except ImportError:
    dispatch = parse_url = install = registration_plan = None


class DevActionsTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(dispatch, "Python 本地动作尚未实现")
        self.temp = tempfile.TemporaryDirectory(prefix="dev-actions-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "hugo.toml").write_text("title='test'\n", encoding="utf-8")
        (self.root / "scripts").mkdir()
        self.prompt = '读文章 "引号" & %PATH% ; $HOME `test` 中文'
        (self.root / "scripts/prompts.json").write_text(json.dumps({
            "project": {"prompt": self.prompt}, "article": {"prompt": self.prompt}}), encoding="utf-8")
        self.article = self.root / "content/local/分组/文章 空格/index.md"
        self.article.parent.mkdir(parents=True)
        self.article.write_text("+++\ntitle='test'\n+++\n", encoding="utf-8")
        self.context = self.article.parent / "context.json"
        self.context.write_text('{"notes":"retain"}', encoding="utf-8")

    def url(self, scheme, path):
        return scheme + ":" + quote(str(path), safe="")

    def test_unicode_url_resolves_project_without_an_embedded_project_path(self):
        scheme, path, root = parse_url(self.url("cca", self.article))
        self.assertEqual((scheme, path, root), ("cca", self.article, self.root))
        with self.assertRaises(ValueError):
            parse_url(self.url("unknown", self.article))
        with self.assertRaises(ValueError):
            parse_url("cc:relative/path")

    def test_explorer_selects_the_exact_file_with_argument_array(self):
        with patch("dev_actions.subprocess.Popen") as process:
            dispatch(self.url("winfs", self.article))
        self.assertEqual(process.call_args.args[0], ["explorer.exe", "/select,", str(self.article)])
        self.assertFalse(process.call_args.kwargs.get("shell", False))

    def test_claude_native_cli_receives_prompt_as_one_literal_argument(self):
        with patch("dev_actions.shutil.which", return_value="C:/Tools/claude.exe"), patch("dev_actions.subprocess.call", return_value=0) as run:
            dispatch(self.url("cca", self.article), terminal=True)
        self.assertEqual(run.call_args.args[0], ["C:/Tools/claude.exe", "--model", "deepseek-v4-flash[1m]",
                                               "--dangerously-skip-permissions", self.prompt])
        self.assertEqual(run.call_args.kwargs["cwd"], self.article.parent)
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        self.assertEqual(self.context.read_text(encoding="utf-8"), '{"notes":"retain"}')

    def test_project_claude_runs_at_the_project_root(self):
        with patch("dev_actions.shutil.which", return_value="claude.exe"), patch("dev_actions.subprocess.call", return_value=0) as run:
            dispatch(self.url("cc", self.root), terminal=True)
        self.assertEqual(run.call_args.kwargs["cwd"], self.root)

    def test_claude_button_creates_an_interactive_python_console(self):
        with patch("dev_actions.subprocess.Popen") as process:
            dispatch(self.url("cca", self.article))
        command = process.call_args.args[0]
        self.assertEqual(command[-1], "--terminal")
        self.assertTrue(command[0].lower().endswith("python.exe"))
        self.assertEqual(process.call_args.kwargs["creationflags"], subprocess.CREATE_NEW_CONSOLE)
        self.assertNotIn("powershell", " ".join(command).lower())
        self.assertNotIn("encodedcommand", " ".join(command).lower())

    def test_single_markdown_becomes_a_bundle_and_existing_bundle_is_not_overwritten(self):
        single = self.article.parent.parent / "单篇.md"
        single.write_text("original", encoding="utf-8")
        with patch("dev_actions.subprocess.Popen"):
            dispatch(self.url("cca", single))
        target = single.with_suffix("")
        self.assertFalse(single.exists())
        self.assertEqual((target / "index.md").read_text(encoding="utf-8"), "original")
        self.assertEqual(json.loads((target / "context.json").read_text(encoding="utf-8")), {
            "rdc_files": [], "code_refs": [], "notes": ""})
        with patch("dev_actions.subprocess.Popen"):
            dispatch(self.url("cca", single))
        self.assertEqual((target / "index.md").read_text(encoding="utf-8"), "original")

    def test_claude_rejects_redirected_article_paths(self):
        if os.name != "nt":
            self.skipTest("Windows junction")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "index.md").write_text("keep", encoding="utf-8")
        link = self.root / "content/local/linked"
        result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.assertRaises(ValueError), patch("dev_actions.subprocess.Popen") as process:
            dispatch(self.url("cca", link / "index.md"))
        process.assert_not_called()
        self.assertEqual((outside / "index.md").read_text(encoding="utf-8"), "keep")

    def test_installed_relay_dispatches_to_the_payload_project(self):
        handler = self.root / "scripts/dev_actions.py"
        handler.write_text("pass\n", encoding="utf-8")
        specification = importlib.util.spec_from_file_location("protocol_relay_test", SCRIPTS / "protocol-relay.py")
        relay = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(relay)
        url = self.url("winfs", self.article)
        with patch.object(relay.subprocess, "Popen") as process:
            relay.dispatch(url)
        self.assertEqual(process.call_args.args[0][1:], ["-X", "utf8", str(handler), url])
        self.assertEqual(process.call_args.kwargs["cwd"], self.root)

    def test_registration_preserves_percent_placeholder_and_installs_outside_project(self):
        directory = self.root / "installed"
        plan = registration_plan(directory)
        self.assertIn('"%1"', plan["command"])
        self.assertNotIn(".ps1", plan["command"])
        self.assertNotIn("powershell", plan["command"].lower())
        base = "Software\\GithubIO.Tests\\" + uuid.uuid4().hex
        result = install(directory, registry_base=base, notify=False)
        self.assertEqual(Path(result["relay"]).read_bytes(), (SCRIPTS / "protocol-relay.py").read_bytes())
        import winreg
        try:
            for scheme in ("winfs", "cc", "cca", "postpub"):
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + "\\" + scheme) as key:
                    self.assertEqual(winreg.QueryValueEx(key, "URL Protocol")[0], "")
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + "\\" + scheme + "\\shell\\open\\command") as key:
                    self.assertEqual(winreg.QueryValueEx(key, "")[0], plan["command"])
        finally:
            for scheme in ("winfs", "cc", "cca", "postpub"):
                for suffix in ("\\shell\\open\\command", "\\shell\\open", "\\shell", ""):
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, base + "\\" + scheme + suffix)
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, base)

    def test_project_venv_is_not_written_into_protocol_registration(self):
        with patch("setup_winfs_protocol.sys.executable", str(SCRIPTS.parent / ".venv/Scripts/python.exe")):
            plan = registration_plan(self.root / "installed")
        self.assertNotIn(str(SCRIPTS.parent), plan["command"])
        self.assertIn(str(Path(sys.base_prefix) / "pythonw.exe"), plan["command"])


if __name__ == "__main__":
    unittest.main()
