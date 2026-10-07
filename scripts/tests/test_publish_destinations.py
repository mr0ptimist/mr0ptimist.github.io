import hashlib
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import tomlkit
from PIL import Image


TESTS = Path(__file__).resolve().parent
SCRIPT = TESTS.parent / "publish_local_post.py"
sys.path.insert(0, str(SCRIPT.parent))
import publish_local_post as publisher

try:
    from local_publish_server import PublishServer
except ImportError:
    PublishServer = None


def rgba_dds(pixels, width=2, height=2):
    header = [0] * 31
    header[0:7] = [124, 0x100F, height, width, width * 4, 0, 1]
    header[18:26] = [32, 0x41, 0, 32, 0xFF, 0xFF00, 0xFF0000, 0xFF000000]
    header[26] = 0x1000
    return b"DDS " + struct.pack("<31I", *header) + bytes(pixels)


class PublishDestinationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="publish-destinations-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "hugo.toml").write_text("title = 'test'\n", encoding="utf-8")
        self.pixels = bytes([255, 17, 33, 0, 9, 180, 44, 128, 50, 60, 70, 255, 80, 90, 100, 200])
        self.plain = self.write_article("分组/纯文本文章", """+++
title = '纯文本文章'
date = '2026-10-07T10:00:00+08:00'
draft = true
type = 'local'
tags = ['测试']
+++

纯文本正文。
""")
        (self.root / "content/local/分组/_index.md").write_text("+++\ntitle = '分组'\n+++\n", encoding="utf-8")
        self.nested = self.write_article("新分组/新文章", """+++
title = '新文章'
draft = true
type = 'local'
slug = 'protect-entry'
+++

新文章正文。
""")
        self.sibling = self.root / "content/protect/已有分组/已有私有文章"
        self.sibling.mkdir(parents=True)
        (self.sibling / "index.md").write_text("+++\ntitle = '已有私有文章'\n+++\n\n已有内容\n", encoding="utf-8")
        (self.sibling / "notes.json").write_text('{"keep": true}', encoding="utf-8")
        self.sidecar = {"image_file": "map.dds", "file_type": "dds", "flip_y": True,
                        "renderdoc": {"format": "RGBA8", "mips": 4}, "ai": {"content": "通道说明"}}
        texture = self.write_article("纹理文章", """+++
title = '纹理文章'
draft = true
type = 'local'
[cover]
image = 'images/thumbnail.jpg'
+++

![贴图](images/map.dds)
[源码](shaders/test.hlsl)
[证据](evidence.json)

```hlsl
// [源码](shaders/test.hlsl) 与 ![示例](not-real.dds) 是代码文本。
float4 value = 1;
```
""").parent
        (texture / "images").mkdir()
        (texture / "shaders").mkdir()
        (texture / "images/map.dds").write_bytes(rgba_dds(self.pixels))
        (texture / "images/map.json").write_text(json.dumps(self.sidecar), encoding="utf-8")
        Image.new("RGB", (2, 2), "red").save(texture / "images/thumbnail.jpg")
        (texture / "shaders/test.hlsl").write_text("float4 main() { return 1; }", encoding="utf-8")
        (texture / "shaders/test.json").write_text('{"entry": "main"}', encoding="utf-8")
        (texture / "unreferenced.dds").write_bytes(b"not a texture")
        (texture / "evidence.json").write_text('{"ok": true}', encoding="utf-8")
        self.texture = texture / "index.md"

    def write_article(self, relative, text):
        article = self.root / "content/local" / relative / "index.md"
        article.parent.mkdir(parents=True)
        article.write_text(text, encoding="utf-8")
        (article.parent / "context.json").write_text(json.dumps({"notes": "keep", "code_refs": []}), encoding="utf-8")
        return article

    def section(self, destination):
        return self.root / "content" / ("posts" if destination == "public" else "protect")

    def run_publish(self, article, *options):
        return subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT), str(article), "--json", *options],
                              capture_output=True, text=True, encoding="utf-8", timeout=180)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def hashes(self, directory):
        return {p.relative_to(directory).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in directory.rglob("*") if p.is_file()}

    def front(self, path):
        text = path.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("+++\n"), text[:40])
        return tomlkit.parse(text.split("+++\n", 2)[1])

    def test_public_and_protect_coexist_and_repeat_protect_replaces_only_protect(self):
        local_before = self.hashes(self.root / "content/local")
        public = self.assert_success(self.run_publish(self.plain, "--destination", "public"))
        self.assertEqual(public["destination"], "public")
        self.assertEqual(Path(public["target"]), self.section("public") / "分组/纯文本文章")
        protect = self.assert_success(self.run_publish(self.plain, "--destination", "protect"))
        self.assertEqual(protect["destination"], "protect")
        self.assertEqual(Path(protect["target"]), self.section("protect") / "分组/纯文本文章")
        self.assertTrue((self.section("public") / "分组/纯文本文章/index.md").is_file())
        default = self.assert_success(self.run_publish(self.nested))
        self.assertEqual(default["destination"], "public")
        self.assertEqual(Path(default["target"]), self.section("public") / "新分组/新文章")
        public_bundle = self.section("public") / "分组/纯文本文章"
        protect_bundle = self.section("protect") / "分组/纯文本文章"
        (public_bundle / "manual.txt").write_text("public 手工文件", encoding="utf-8")
        (protect_bundle / "stale.txt").write_text("stale", encoding="utf-8")
        public_snapshot = self.hashes(public_bundle)
        sibling_before = self.hashes(self.sibling)
        self.assert_success(self.run_publish(self.plain, "--destination", "protect"))
        self.assertFalse((protect_bundle / "stale.txt").exists())
        self.assertEqual(self.hashes(public_bundle), public_snapshot)
        self.assertEqual(self.hashes(self.sibling), sibling_before)
        self.assertEqual(self.hashes(self.root / "content/local"), local_before)

    def test_protect_bundle_keeps_context_code_sidecars_and_rgb_alpha_pipeline(self):
        local_before = self.hashes(self.root / "content/local")
        report = self.assert_success(self.run_publish(self.texture, "--destination", "protect", "--max-edge", "1"))
        bundle = self.section("protect") / "纹理文章"
        self.assertEqual(Path(report["target"]), bundle)
        self.assertEqual(report["converted"], 1)
        self.assertEqual(report["alpha_images"], 1)
        self.assertEqual((bundle / "context.json").read_bytes(), (self.texture.parent / "context.json").read_bytes())
        self.assertEqual((bundle / "evidence.json").read_bytes(), (self.texture.parent / "evidence.json").read_bytes())
        self.assertFalse((bundle / "shaders/test.hlsl").exists())
        self.assertEqual((bundle / "shaders/test.json").read_bytes(), (self.texture.parent / "shaders/test.json").read_bytes())
        with Image.open(bundle / "images/map.png") as image:
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.size, (1, 1))
            self.assertEqual(image.tobytes(), self.pixels[12:15])
        with Image.open(bundle / "images/map.alpha.png") as image:
            self.assertEqual(image.mode, "L")
            self.assertEqual(image.size, (1, 1))
            self.assertEqual(image.tobytes(), bytes([self.pixels[15]]))
        sidecar = json.loads((bundle / "images/map.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["image_file"], "map.png")
        self.assertEqual(sidecar["file_type"], "png")
        self.assertEqual(sidecar["flip_y"], self.sidecar["flip_y"])
        self.assertEqual(sidecar["renderdoc"], self.sidecar["renderdoc"])
        self.assertEqual(sidecar["ai"], self.sidecar["ai"])
        self.assertTrue(sidecar["publication"]["rgb_png"])
        self.assertEqual(sidecar["publication"]["alpha_file"], "map.alpha.png")
        self.assertEqual(sidecar["publication"]["source_size"], [2, 2])
        self.assertEqual(sidecar["publication"]["output_size"], [1, 1])
        self.assertEqual(sidecar["publication"]["channels"], "RGBA")
        published = (bundle / "index.md").read_text(encoding="utf-8")
        self.assertIn("![贴图](images/map.png)", published)
        self.assertNotIn("[源码](shaders/test.hlsl)\n[证据]", published)
        self.assertIn("// [源码](shaders/test.hlsl) 与 ![示例](not-real.dds) 是代码文本。", published)
        self.assertFalse(list(bundle.rglob("*.dds")))
        self.assertFalse(list(bundle.rglob("*.hlsl")))
        self.assertTrue((bundle / "images/thumbnail.jpg").is_file())
        self.assertFalse((self.section("public") / "纹理文章").exists())
        self.assertEqual(self.hashes(self.root / "content/local"), local_before)

    def test_protect_group_section_type_local_source_and_slug_preview(self):
        report = self.assert_success(self.run_publish(self.nested, "--destination", "protect"))
        bundle = self.section("protect") / "新分组/新文章"
        self.assertEqual(Path(report["target"]), bundle)
        self.assertTrue(report["preview_url"].endswith("/protect-entry/"), report["preview_url"])
        self.assertTrue((self.section("protect") / "新分组/_index.md").is_file())
        self.assertFalse((self.section("public") / "新分组").exists())
        front = self.front(bundle / "index.md")
        self.assertEqual(front["type"], "protect")
        self.assertEqual(front["local_source"], "local/新分组/新文章/index.md")
        self.assertFalse(front["draft"])
        self.assertTrue(front["local_publication"])
        public = self.assert_success(self.run_publish(self.nested, "--destination", "public"))
        self.assertEqual(self.front(Path(public["target"]) / "index.md")["type"], "posts")
        self.assertTrue((self.section("public") / "新分组/_index.md").is_file())

    def test_preview_falls_back_to_selected_section_when_hugo_list_fails(self):
        (self.root / "hugo.toml").write_text("title = [\n", encoding="utf-8")
        for destination, section in (("public", "posts"), ("protect", "protect")):
            report = publisher.publish(self.plain, destination=destination)
            expected = "http://localhost:1313" + quote(f"/{section}/分组/纯文本文章/", safe="/-._~")
            self.assertEqual(report["preview_url"], expected)

    def test_local_url_front_matter_is_rebased_to_selected_section(self):
        text = self.plain.read_text(encoding="utf-8").replace("type = 'local'", "type = 'local'\nurl = '/local/分组/纯文本文章/'")
        self.plain.write_text(text, encoding="utf-8")
        protect = self.assert_success(self.run_publish(self.plain, "--destination", "protect"))
        protect_front = self.front(Path(protect["target"]) / "index.md")
        self.assertEqual(protect_front["type"], "protect")
        self.assertEqual(protect_front["url"], "/protect/分组/纯文本文章/")
        self.assertNotIn("/posts/", protect_front["url"])
        public = self.assert_success(self.run_publish(self.plain, "--destination", "public"))
        public_front = self.front(Path(public["target"]) / "index.md")
        self.assertEqual(public_front["type"], "posts")
        self.assertEqual(public_front["url"], "/posts/分组/纯文本文章/")

    def test_other_local_links_stay_out_of_public_assets_in_protect(self):
        other = self.root / "content/local/其他文章"
        other.mkdir(parents=True)
        (other / "index.md").write_text("+++\ntitle = '其他文章'\n+++\n", encoding="utf-8")
        (self.plain.parent / "evidence.json").write_text('{"ok": true}', encoding="utf-8")
        text = self.plain.read_text(encoding="utf-8") + (
            "\n[其他本地文章](/local/其他文章/)\n[本包证据](/local/分组/纯文本文章/evidence.json)\n")
        self.plain.write_text(text, encoding="utf-8")
        report = self.assert_success(self.run_publish(self.plain, "--destination", "protect"))
        published = (Path(report["target"]) / "index.md").read_text(encoding="utf-8")
        self.assertIn("[其他本地文章](/local/其他文章/)", published)
        self.assertIn("[本包证据](evidence.json)", published)
        self.assertNotIn("/posts/", published)
        self.assertTrue((Path(report["target"]) / "evidence.json").is_file())
        self.assertFalse((self.section("public") / "其他文章").exists())

    def test_invalid_destinations_are_rejected_before_any_write(self):
        self.assertEqual(publisher.DESTINATIONS, {"public": "posts", "protect": "protect"})
        local_before = self.hashes(self.root / "content/local")
        for value in ("private", "", "Protect", "/posts", "../protect", "posts/../protect",
                      None, 123, True, ["protect"], {"destination": "protect"}):
            with self.assertRaises(ValueError) as caught:
                publisher.publish(self.plain, destination=value)
            self.assertIn("public", str(caught.exception))
            self.assertIn("protect", str(caught.exception))
            self.assertFalse((self.section("public") / "分组/纯文本文章").exists())
            self.assertFalse((self.section("protect") / "分组/纯文本文章").exists())
        cli = self.run_publish(self.plain, "--destination", "private")
        self.assertNotEqual(cli.returncode, 0, cli.stdout + cli.stderr)
        self.assertEqual(self.hashes(self.root / "content/local"), local_before)
        self.assertFalse((self.section("public") / "分组/纯文本文章").exists())

    def test_corrupt_texture_preserves_selected_destination_and_sibling(self):
        protect_bundle = self.section("protect") / "纹理文章"
        protect_bundle.mkdir(parents=True)
        published = protect_bundle / "index.md"
        published.write_text("protect 已发布版本", encoding="utf-8")
        public_bundle = self.section("public") / "纹理文章"
        public_bundle.mkdir(parents=True)
        public_published = public_bundle / "index.md"
        public_published.write_text("public 已发布版本", encoding="utf-8")
        sibling_before = self.hashes(self.sibling)
        (self.texture.parent / "images/map.dds").write_bytes(b"corrupt DDS")
        local_before = self.hashes(self.root / "content/local")
        with self.assertRaisesRegex(ValueError, "贴图转换失败"):
            publisher.publish(self.texture, destination="protect")
        self.assertEqual(published.read_text(encoding="utf-8"), "protect 已发布版本")
        self.assertEqual(public_published.read_text(encoding="utf-8"), "public 已发布版本")
        self.assertEqual(self.hashes(self.sibling), sibling_before)
        self.assertEqual(self.hashes(self.root / "content/local"), local_before)

    def test_protect_destination_junction_is_rejected_without_writes(self):
        if sys.platform != "win32":
            self.skipTest("Windows junction boundary")
        outside = self.root / "outside"
        outside.mkdir()
        sentinel = outside / "sentinel.txt"
        sentinel.write_text("keep", encoding="utf-8")
        (self.root / "content/protect").mkdir(parents=True, exist_ok=True)
        junction = self.root / "content/protect/分组"
        created = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(outside)],
                                 capture_output=True, timeout=30)
        self.assertEqual(created.returncode, 0, created.stderr)
        result = self.run_publish(self.plain, "--destination", "protect")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
        self.assertFalse((outside / "纯文本文章").exists())

    def test_http_advertises_destinations_and_rejects_invalid_without_starting_job(self):
        self.assertIsNotNone(PublishServer, "本地发布服务尚未实现")
        server = PublishServer(("127.0.0.1", 0), self.root, log_path=self.root / "publish-server.log")
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
        token = {}

        def request(route, method="GET", body=None):
            headers = {"Origin": "http://localhost:1313", "X-GithubIO-Publish-Token": token.get("value", "")}
            if body is not None:
                headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode() if body is not None else None
            try:
                response = urlopen(Request(base + route, data=data, method=method, headers=headers), timeout=15)
            except HTTPError as error:
                response = error
            with response:
                payload = response.read()
                return response.status, json.loads(payload) if payload else {}

        status, session = request("/session")
        self.assertEqual(status, 200, session)
        token["value"] = session["token"]
        self.assertEqual(session["destinations"], ["public", "protect"])
        status, health = request("/health")
        self.assertEqual(status, 200, health)
        self.assertEqual(health["destinations"], ["public", "protect"])
        for value in ("private", "", "protect/../posts", 123, {"name": "protect"}):
            status, payload = request("/publish", "POST",
                                      {"article": str(self.plain), "max_edge": 0, "destination": value})
            self.assertEqual(status, 400, payload)
            self.assertIn("public", payload["error"])
            self.assertIsNone(server.active)
        self.assertFalse((self.section("protect") / "分组/纯文本文章").exists())
        status, started = request("/publish", "POST",
                                  {"article": str(self.plain), "max_edge": 0, "destination": "protect"})
        self.assertEqual(status, 202, started)
        job = self.wait_job(request, started["id"])
        self.assertEqual(job["state"], "succeeded", job)
        self.assertEqual(job["destination"], "protect")
        self.assertEqual(job["result"]["destination"], "protect")
        self.assertEqual(Path(job["result"]["target"]), self.section("protect") / "分组/纯文本文章")
        self.assertFalse((self.section("public") / "分组/纯文本文章").exists())
        status, started = request("/publish", "POST", {"article": str(self.nested), "max_edge": 0})
        self.assertEqual(status, 202, started)
        job = self.wait_job(request, started["id"])
        self.assertEqual(job["state"], "succeeded", job)
        self.assertEqual(job["result"]["destination"], "public")
        self.assertEqual(Path(job["result"]["target"]), self.section("public") / "新分组/新文章")
        self.assertFalse((self.section("protect") / "新分组").exists())

    def wait_job(self, request, job_id, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status, job = request("/jobs/" + job_id)
            self.assertEqual(status, 200, job)
            if job["state"] != "running":
                return job
            time.sleep(0.05)
        self.fail("发布任务未结束")

    def test_production_build_keeps_posts_and_omits_protect(self):
        self.assert_success(self.run_publish(self.plain, "--destination", "public"))
        protect = self.assert_success(self.run_publish(self.plain, "--destination", "protect"))
        self.assertFalse(self.front(Path(protect["target"]) / "index.md")["draft"])
        project = SCRIPT.parent.parent
        config = "title = 'test'\nbaseURL = '/'\ntheme = 'PaperMod'\n"
        production_config = self.root / "config/production/hugo.toml"
        production_config.parent.mkdir(parents=True)
        shutil.copy2(project / "config/production/hugo.toml", production_config)
        for option, directory in (("themesDir", "themes"), ("layoutDir", "layouts"),
                                  ("assetDir", "assets"), ("staticDir", "static")):
            config += f"{option} = '{(project / directory).as_posix()}'\n"
        config += "[params]\nmainSections = ['posts']\n"
        (self.root / "hugo.toml").write_text(config, encoding="utf-8")
        output = self.root / "site"
        result = subprocess.run(["hugo", "--source", str(self.root), "--destination", str(output),
                                 "--environment", "production", "--quiet"],
                                capture_output=True, text=True, encoding="utf-8", timeout=180)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(p.is_file() for p in (output / "posts").rglob("index.html")))
        self.assertFalse((output / "protect").exists())
        self.assertFalse((output / "local").exists())


if __name__ == "__main__":
    unittest.main()
