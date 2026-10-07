import hashlib
import functools
import http.server
import json
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import socket
import zlib
from pathlib import Path
from urllib.parse import quote

from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / "publish_local_post.py"
sys.path.insert(0, str(SCRIPT.parent))
from publish_local_post import publish


def rgba_dds(pixels, width=2, height=2):
    header = [0] * 31
    header[0:7] = [124, 0x100F, height, width, width * 4, 0, 1]
    header[18:26] = [32, 0x41, 0, 32, 0xFF, 0xFF00, 0xFF0000, 0xFF000000]
    header[26] = 0x1000
    return b"DDS " + struct.pack("<31I", *header) + bytes(pixels)


class PublishLocalPostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="publish-test-")
        self.root = Path(self.temp.name).resolve()
        (self.root / "hugo.toml").write_text("title = 'test'\n", encoding="utf-8")
        self.source = self.root / "content/local/分组/文章 空格"
        self.target = self.root / "content/posts/分组/文章 空格"
        (self.source / "images").mkdir(parents=True)
        (self.source / "shaders").mkdir()
        (self.source.parent / "_index.md").write_text("+++\ntitle = '分组'\n+++\n", encoding="utf-8")
        self.pixels = bytes([255, 17, 33, 0, 9, 180, 44, 128, 50, 60, 70, 255, 80, 90, 100, 255])
        (self.source / "images/map.dds").write_bytes(rgba_dds(self.pixels))
        self.sidecar = {"image_file": "map.dds", "file_type": "dds", "flip_y": True,
                        "renderdoc": {"format": "RGBA8", "mips": 4, "array_size": 6},
                        "ai": {"content": "通道说明"}}
        (self.source / "images/map.json").write_text(json.dumps(self.sidecar), encoding="utf-8")
        Image.new("RGB", (2, 2), "red").save(self.source / "images/thumbnail.jpg")
        (self.source / "shaders/test.hlsl").write_text("float4 main() { return 1; }", encoding="utf-8")
        (self.source / "shaders/test.json").write_text('{"entry": "main", "note": "源码说明"}', encoding="utf-8")
        (self.source / "unreferenced.dds").write_bytes(b"not a texture")
        (self.source / "context.json").write_text(json.dumps({"notes": "keep", "code_refs": []}), encoding="utf-8")
        (self.source / "evidence.json").write_text('{"ok": true}', encoding="utf-8")
        (self.source / "index.md").write_text("""+++
title = '测试文章'
date = '2026-10-06T20:00:00+08:00'
draft = true
tags = ['RenderDoc']
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
""", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def run_publish(self, *options):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.source / "index.md"),
                               "--json", *options], capture_output=True, text=True,
                              encoding="utf-8", timeout=120)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def hashes(self):
        return {p.relative_to(self.source).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.source.rglob("*") if p.is_file()}

    def test_dry_run_does_not_create_public_output(self):
        before = self.hashes()
        report = self.assert_success(self.run_publish("--dry-run"))
        self.assertTrue(report["dry_run"])
        self.assertEqual(Path(report["target"]), self.target)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.hashes(), before)

    def test_exports_referenced_assets_and_preserves_source_and_alpha(self):
        before = self.hashes()
        report = self.assert_success(self.run_publish())
        self.assertEqual(report["converted"], 1)
        self.assertEqual(self.hashes(), before)
        with Image.open(self.target / "images/map.png") as image:
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.tobytes(), bytes(v for i, v in enumerate(self.pixels) if i % 4 != 3))
        with Image.open(self.target / "images/map.alpha.png") as image:
            self.assertEqual(image.mode, "L")
            self.assertEqual(image.tobytes(), self.pixels[3::4])
        self.assertEqual(report["alpha_images"], 1)
        text = (self.target / "index.md").read_text(encoding="utf-8")
        self.assertIn("draft = false", text)
        self.assertIn("![贴图](images/map.png)", text)
        self.assertNotIn("[源码](shaders/test.hlsl)\n[证据]", text)
        self.assertIn("// [源码](shaders/test.hlsl) 与 ![示例](not-real.dds) 是代码文本。", text)
        self.assertTrue((self.target / "evidence.json").exists())
        self.assertTrue((self.target / "context.json").exists())
        self.assertTrue((self.target.parent / "_index.md").exists())
        self.assertTrue((self.target / "images/thumbnail.jpg").exists())
        self.assertFalse(list(self.target.rglob("*.dds")))
        self.assertFalse(list(self.target.rglob("*.hlsl")))
        self.assertEqual((self.target / "shaders/test.json").read_bytes(), (self.source / "shaders/test.json").read_bytes())
        sidecar = json.loads((self.target / "images/map.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["image_file"], "map.png")
        self.assertEqual(sidecar["file_type"], "png")
        self.assertTrue(sidecar["flip_y"])
        self.assertEqual(sidecar["renderdoc"], self.sidecar["renderdoc"])
        self.assertEqual(sidecar["ai"], self.sidecar["ai"])
        self.assertTrue(sidecar["publication"]["rgb_png"])
        self.assertEqual(sidecar["publication"]["alpha_file"], "map.alpha.png")

    def test_opaque_texture_needs_no_extra_alpha_image(self):
        pixels = bytearray(self.pixels)
        pixels[3::4] = b"\xff" * 4
        (self.source / "images/map.dds").write_bytes(rgba_dds(pixels))
        report = self.assert_success(self.run_publish())
        self.assertEqual(report["alpha_images"], 0)
        self.assertFalse((self.target / "images/map.alpha.png").exists())
        data = json.loads((self.target / "images/map.json").read_text(encoding="utf-8"))
        self.assertIsNone(data["publication"]["alpha_file"])

    def test_alpha_output_name_collision_keeps_previous_public_bundle(self):
        self.assert_success(self.run_publish())
        previous = (self.target / "index.md").read_bytes()
        Image.new("RGB", (2, 2), "red").save(self.source / "images/map.alpha.png")
        with (self.source / "index.md").open("a", encoding="utf-8") as handle:
            handle.write("\n![已有图](images/map.alpha.png)\n")
        result = self.run_publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Alpha", result.stderr)
        self.assertEqual((self.target / "index.md").read_bytes(), previous)

    def test_republish_discards_manual_edits_and_stale_attachments(self):
        self.assert_success(self.run_publish())
        (self.target / "index.md").write_text("manual edit", encoding="utf-8")
        (self.target / "manual.txt").write_text("remove me", encoding="utf-8")
        source_text = (self.source / "index.md").read_text(encoding="utf-8")
        (self.source / "index.md").write_text(source_text.replace("![贴图](images/map.dds)", "local changed"), encoding="utf-8")
        self.assert_success(self.run_publish())
        self.assertIn("local changed", (self.target / "index.md").read_text(encoding="utf-8"))
        self.assertFalse((self.target / "manual.txt").exists())
        self.assertFalse((self.target / "images/map.png").exists())
        self.assertFalse((self.target / "images/map.json").exists())

    def test_resolution_limit_preserves_source_and_records_both_sizes(self):
        before = self.hashes()
        report = self.assert_success(self.run_publish("--max-edge", "1"))
        self.assertEqual(report["max_edge"], 1)
        self.assertEqual(self.hashes(), before)
        png = Image.open(self.target / "images/map.png").convert("RGBA")
        self.assertEqual(png.size, (1, 1))
        self.assertEqual(png.tobytes(), self.pixels[12:16])
        sidecar = json.loads((self.target / "images/map.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["publication"]["source_size"], [2, 2])
        self.assertEqual(sidecar["publication"]["output_size"], [1, 1])
        with Image.open(self.target / "images/thumbnail.jpg") as cover:
            self.assertEqual(cover.size, (2, 2))

    def test_resolution_limit_keeps_aspect_ratio_and_does_not_upscale(self):
        (self.source / "images/map.dds").write_bytes(rgba_dds(bytes(range(32)), 4, 2))
        self.assert_success(self.run_publish("--max-edge", "2"))
        with Image.open(self.target / "images/map.png") as image:
            self.assertEqual(image.size, (2, 1))
        self.assert_success(self.run_publish("--max-edge", "2048"))
        with Image.open(self.target / "images/map.png") as image:
            self.assertEqual(image.size, (4, 2))

    def test_invalid_resolution_leaves_previous_public_version(self):
        self.target.mkdir(parents=True)
        sentinel = self.target / "sentinel.txt"
        sentinel.write_text("keep", encoding="utf-8")
        self.assertNotEqual(self.run_publish("--max-edge", "-1").returncode, 0)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_bad_texture_leaves_previous_public_version(self):
        self.assert_success(self.run_publish())
        before = (self.target / "index.md").read_bytes()
        (self.source / "images/map.dds").write_bytes(b"corrupt DDS")
        result = self.run_publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.target / "index.md").read_bytes(), before)
        self.assertTrue((self.target / "images/map.png").exists())

    def test_missing_reference_does_not_replace_destination(self):
        self.target.mkdir(parents=True)
        (self.target / "sentinel.txt").write_text("keep", encoding="utf-8")
        (self.source / "index.md").write_text("+++\ntitle = 'bad'\n+++\n![坏链接](missing.png)", encoding="utf-8")
        self.assertNotEqual(self.run_publish().returncode, 0)
        self.assertTrue((self.target / "sentinel.txt").exists())

    def test_asset_escape_is_rejected(self):
        (self.source.parent / "outside.png").write_bytes(b"outside")
        (self.source / "index.md").write_text("+++\ntitle = 'bad'\n+++\n![外部](../outside.png)", encoding="utf-8")
        self.assertNotEqual(self.run_publish().returncode, 0)
        self.assertFalse(self.target.exists())

    def test_html_and_reference_images_and_unicode_shortcodes(self):
        (self.source / "演示.html").write_text('<img src="images/map.dds">', encoding="utf-8")
        text = (self.source / "index.md").read_text(encoding="utf-8")
        text += '\n![引用图][tex]\n[tex]: images/map.dds "title"\n<img src="images/map.dds">\n{{< htmlview src="演示.html" >}}\n[外部源码](https://example.org/test.cpp)\n'
        (self.source / "index.md").write_text(text, encoding="utf-8")
        self.assert_success(self.run_publish())
        published = (self.target / "index.md").read_text(encoding="utf-8")
        self.assertIn('[tex]: images/map.png "title"', published)
        self.assertIn('<img src="images/map.png">', published)
        self.assertIn('src="演示.html"', published)
        self.assertIn('https://example.org/test.cpp', published)
        self.assertIn('images/map.png', (self.target / "演示.html").read_text(encoding="utf-8"))

    def test_nested_html_keeps_references_relative_to_its_directory(self):
        (self.source / "demos").mkdir()
        (self.source / "demos/view.html").write_text('<img src="../images/map.dds">', encoding="utf-8")
        text = (self.source / "index.md").read_text(encoding="utf-8")
        (self.source / "index.md").write_text(text + '\n{{< htmlview src="demos/view.html" >}}\n', encoding="utf-8")
        self.assert_success(self.run_publish())
        self.assertIn('src="../images/map.png"', (self.target / "demos/view.html").read_text(encoding="utf-8"))

    def test_protocol_entry_runs_without_dialogs_with_unicode_path(self):
        protocol = SCRIPT.parent / "dev_actions.py"
        url = "postpub:" + quote(str(self.source / "index.md"), safe="") + "?preview=http%3A%2F%2Flocalhost%3A1313%2Fposts%2Fentry%2F&max-edge=1"
        log = self.root / "postpub.log"
        result = subprocess.run([sys.executable, "-X", "utf8", str(protocol), url, "--no-ui", "--log-path", str(log)],
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        report = self.assert_success(result)
        self.assertEqual(report["max_edge"], 1)
        self.assertTrue((self.target / "index.md").exists())
        with Image.open(self.target / "images/map.png") as image:
            self.assertEqual(image.size, (1, 1))
        messages = log.read_text(encoding="utf-8")
        self.assertIn("publisher start", messages)
        self.assertIn("python=", messages)
        self.assertIn("publisher success", messages)

    def test_protocol_failure_is_saved_to_log(self):
        (self.source / "images/map.dds").write_bytes(b"bad DDS")
        log = self.root / "failure.log"
        url = "postpub:" + quote(str(self.source / "index.md"), safe="")
        result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT.parent / "dev_actions.py"), url, "--no-ui", "--log-path", str(log)],
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.target.exists())
        self.assertIn("publisher error", log.read_text(encoding="utf-8"))

    def test_each_completed_texture_is_reported_before_finalizing(self):
        (self.source / "images/second.dds").write_bytes((self.source / "images/map.dds").read_bytes())
        with (self.source / "index.md").open("a", encoding="utf-8") as handle:
            handle.write("\n![第二张](images/second.dds)\n")
        before = self.hashes()
        events = []
        report = publish(self.source / "index.md", progress=events.append)
        completed = [event for event in events if event["phase"] == "textures" and event["completed"]]
        self.assertEqual([event["completed"] for event in completed], [1, 2])
        self.assertEqual([event["total"] for event in completed], [2, 2])
        sources = [event["file"] for event in completed]
        self.assertEqual(sorted(sources), ["images/map.dds", "images/second.dds"])
        self.assertEqual(len(set(sources)), len(sources))
        self.assertEqual(events[-1]["phase"], "finalizing")
        self.assertEqual(report["converted"], 2)
        self.assertEqual(self.hashes(), before)

    def test_partial_texture_progress_keeps_previous_bundle_on_failure(self):
        self.assert_success(self.run_publish())
        previous = (self.target / "index.md").read_bytes()
        (self.source / "images/broken.dds").write_bytes(b"broken")
        with (self.source / "index.md").open("a", encoding="utf-8") as handle:
            handle.write("\n![损坏贴图](images/broken.dds)\n")
        events = []
        with self.assertRaisesRegex(ValueError, "贴图转换失败"):
            publish(self.source / "index.md", progress=events.append)
        completed = [event["completed"] for event in events if event["phase"] == "textures" and event["completed"]]
        self.assertEqual(completed, sorted(set(completed)))
        self.assertTrue(all(1 <= value <= 2 for value in completed))
        self.assertFalse(any(event["phase"] == "finalizing" for event in events))
        self.assertEqual((self.target / "index.md").read_bytes(), previous)

    def test_publication_resolves_public_refs_and_keeps_draft_reference_text(self):
        for name, draft in (("参考公开", False), ("未公开", True)):
            directory = self.root / "content/posts" / name
            directory.mkdir(parents=True)
            (directory / "context.json").write_text("{}", encoding="utf-8")
            (directory / "index.md").write_text(f"+++\ntitle='{name}'\ndraft={str(draft).lower()}\nslug='reference-entry'\n+++\n", encoding="utf-8")
        with (self.source / "index.md").open("a", encoding="utf-8") as handle:
            handle.write('\n[公开引用]({{< ref "/posts/参考公开/index.md" >}})\n[草稿引用]({{< relref "/posts/未公开/index.md" >}})\n')
        before = self.hashes()
        self.assert_success(self.run_publish())
        text = (self.target / "index.md").read_text(encoding="utf-8")
        self.assertIn("[公开引用](/posts/reference-entry/)", text)
        self.assertIn("草稿引用", text)
        self.assertNotIn("[草稿引用]", text)
        self.assertNotIn('{{< ref "/posts/参考公开', text)
        self.assertEqual(self.hashes(), before)

    def test_republication_works_with_hugo_watching_the_existing_bundle(self):
        if sys.platform != "win32":
            self.skipTest("Windows directory sharing")
        self.assert_success(self.run_publish())
        (self.root / "layouts").mkdir()
        (self.root / "layouts/index.html").write_text("<!doctype html><title>fixture</title>", encoding="utf-8")
        with socket.socket() as address:
            address.bind(("127.0.0.1", 0))
            port = address.getsockname()[1]
        with tempfile.TemporaryFile() as log, subprocess.Popen(["hugo", "server", "-D", "--source", str(self.root), "-p", str(port), "--poll", "500ms"], stdout=log, stderr=log) as server:
            try:
                from urllib.request import urlopen
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    try:
                        with urlopen(f"http://localhost:{port}/", timeout=1):
                            break
                    except OSError:
                        if server.poll() is not None:
                            log.seek(0)
                            self.fail(log.read().decode("utf-8", errors="replace"))
                        time.sleep(0.1)
                else:
                    self.fail("临时 Hugo 未启动")
                (self.target / "stale.txt").write_text("discard", encoding="utf-8")
                self.assert_success(self.run_publish())
                self.assertFalse((self.target / "stale.txt").exists())
            finally:
                server.terminate()
                server.wait(timeout=10)

    def test_published_png_viewer_preserves_hidden_rgb_without_fake_sliders(self):
        self.assert_success(self.run_publish())
        self.check_published_viewer()

    def test_legacy_rgba_publication_still_preserves_channels(self):
        self.assert_success(self.run_publish())
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
        header = struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0)
        rows = b"\0" + self.pixels[:8] + b"\0" + self.pixels[8:]
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
        (self.target / "images/map.png").write_bytes(png)
        (self.target / "images/map.alpha.png").unlink()
        data = dict(self.sidecar, publication={"rgba_png": True, "channels": "RGBA"})
        (self.target / "images/map.json").write_text(json.dumps(data), encoding="utf-8")
        self.check_published_viewer()

    def check_published_viewer(self):
        scripts = ["worker-shared", "dds-codec", "dds-parser", "exr-parser", "color-remap",
                   "export-texture", "published-texture", "image-viewer"]
        html = '<!doctype html><meta charset="utf-8"><div class="post-content"><img src="/images/map.png"></div>'
        html += '<script>window.ImageViewerConfig={publishedLocal:true};</script>'
        html += ''.join('<script src="/js/' + name + '.js"></script>' for name in scripts)
        (self.target / "viewer.html").write_text(html, encoding="utf-8")
        static_js = SCRIPT.parent.parent / "static/js"
        target = self.target
        class Handler(http.server.SimpleHTTPRequestHandler):
            def translate_path(self, url):
                if url.startswith("/js/"):
                    return str(static_js / url.split("?", 1)[0][4:])
                return super().translate_path(url)
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(target)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run(["node", str(SCRIPT.parent / "cdp/publish_viewer_check.js"),
                                     f"http://127.0.0.1:{server.server_port}/viewer.html"],
                                    capture_output=True, text=True, encoding="utf-8", timeout=120)
            self.assert_success(result)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_hugo_header_button_only_on_development_local_articles(self):
        source_text = (self.source / "index.md").read_text(encoding="utf-8")
        (self.source / "index.md").write_text(source_text.replace("draft = true", "draft = true\nslug = 'paired-entry'"), encoding="utf-8")
        self.assert_success(self.run_publish())
        project = SCRIPT.parent.parent
        config = "title = 'test'\nbaseURL = '/'\ntheme = 'PaperMod'\n"
        for option, directory in [("themesDir", "themes"), ("layoutDir", "layouts"), ("assetDir", "assets"), ("staticDir", "static")]:
            config += f"{option} = '{(project / directory).as_posix()}'\n"
        config += f"[params]\nvscodeContentBase = '{self.root.as_posix()}'\nlocalPublishAPI = '/'\n"
        (self.root / "hugo.toml").write_text(config, encoding="utf-8")
        destination = self.root / "site"
        for environment in ("development", "production"):
            output = destination / environment
            result = subprocess.run(["hugo", "--source", str(self.root), "--destination", str(output),
                                     "--environment", environment, "-D", "--quiet"],
                                    capture_output=True, text=True, encoding="utf-8", timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            local_page = next(p for p in (output / "local").rglob("index.html") if p.parent.name == "paired-entry")
            published_page = next(p for p in (output / "posts").rglob("index.html") if p.parent.name == "paired-entry")
            local_html = local_page.read_text(encoding="utf-8")
            self.assertEqual('id="publish-local-btn"' in local_html, environment == "development")
            self.assertEqual('id="publish-local-files"' in local_html, environment == "development")
            published_html = published_page.read_text(encoding="utf-8")
            self.assertNotIn('id="publish-local-btn"', published_html)
            self.assertEqual('id="counterpart-article-btn"' in local_html, environment == "development")
            self.assertEqual('id="counterpart-article-btn"' in published_html, environment == "development")
            if environment == "development":
                self.assertIn('title="打开公开版"', local_html)
                self.assertIn('title="打开本地版"', published_html)
                self.assertIn('href="/posts/', local_html)
                self.assertIn('href="/local/', published_html)
        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                if self.path == "/session":
                    data = b'{"token":"fixture-token"}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                file = Path(self.translate_path(self.path))
                if self.headers.get("Range") == "bytes=0-147" and file.suffix.lower() == ".dds" and file.is_file():
                    data = file.read_bytes()[:148]
                    self.send_response(206)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Content-Range", f"bytes 0-{len(data) - 1}/{file.stat().st_size}")
                    self.end_headers()
                    self.wfile.write(data)
                else:
                    super().do_GET()
        handler = functools.partial(Handler, directory=str(destination / "development"))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            route = local_page.relative_to(destination / "production").as_posix()
            result = subprocess.run(["node", str(SCRIPT.parent / "cdp/publish_viewer_check.js"),
                                     f"http://127.0.0.1:{server.server_port}/{quote(route)}", "--button",
                                     str(sum(file.stat().st_size for file in self.target.rglob("*") if file.is_file()))],
                                    capture_output=True, text=True, encoding="utf-8", timeout=120)
            self.assert_success(result)
        finally:
            server.shutdown(); server.server_close(); thread.join()
        for missing, remaining in ((self.target, "local"), (self.source, "posts")):
            index = missing / "index.md"
            hidden = missing / "index.disabled"
            index.rename(hidden)
            try:
                output = destination / ("without-" + missing.parts[-3])
                result = subprocess.run(["hugo", "--source", str(self.root), "--destination", str(output),
                                         "--environment", "development", "-D", "--quiet"],
                                        capture_output=True, text=True, encoding="utf-8", timeout=120)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                page = next(p for p in (output / remaining).rglob("index.html") if p.parent.name == "paired-entry")
                self.assertNotIn('id="counterpart-article-btn"', page.read_text(encoding="utf-8"))
            finally:
                hidden.rename(index)

    def test_float_texture_records_normalization_without_downsampling(self):
        header = [0] * 31
        header[0:7] = [124, 0x100F, 2, 2, 8, 0, 1]
        header[18:26] = [32, 4, 0x30315844, 0, 0, 0, 0, 0]
        header[26] = 0x1000
        texture = b"DDS " + struct.pack("<31I", *header) + struct.pack("<5I", 41, 3, 0, 1, 0)
        texture += struct.pack("<4f", -2, 0, 2, 6)
        (self.source / "images/map.dds").write_bytes(texture)
        self.assert_success(self.run_publish())
        with Image.open(self.target / "images/map.png") as image:
            self.assertEqual(image.size, (2, 2))
            self.assertEqual([p[0] for p in image.getdata()], [0, 64, 128, 255])
            self.assertTrue(all(p[1:3] == (0, 0) for p in image.getdata()))
        data = json.loads((self.target / "images/map.json").read_text(encoding="utf-8"))
        self.assertEqual(data["publication"]["normalization"], {"min": -2, "max": 6})
        self.assertEqual(data["publication"]["channels"], "R")

    def test_real_bptc_exr_and_packed_alpha_assets(self):
        examples = SCRIPT.parent.parent / "content/posts/网站能力展示"
        json.loads((examples / "context.json").read_text(encoding="utf-8-sig"))
        names = ["char_eye_highlight.dds", "char_skin_shadow_lut.dds", "hair_ramp_index.dds",
                 "ibl_diffuse_256.dds", "ResourceId-15373.dds", "ResourceId-16061.dds",
                 "ResourceId-630.exr", "ResourceId-633.exr"]
        entries = [{"source": str(examples / name), "destination": str(self.root / (name + ".png"))} for name in names]
        manifest = self.root / "textures.json"
        manifest.write_text(json.dumps({"images": entries}), encoding="utf-8")
        result = subprocess.run(["node", str(SCRIPT.parent / "cdp/export_texture_png.js"), str(manifest)],
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        report = self.assert_success(result)
        self.assertEqual(len(report["images"]), len(names))
        self.assertTrue(any("BC6H" in item["format"] for item in report["images"]))
        self.assertTrue(any("BC7" in item["format"] for item in report["images"]))
        for item in report["images"]:
            with Image.open(item["destination"]) as image:
                self.assertEqual(image.size, (item["width"], item["height"]))
                self.assertGreater(max(image.convert("RGB").getextrema()[0]), 0)
                if item["source"].endswith(".dds"):
                    source = Path(item["source"]).read_bytes()
                    height, width = struct.unpack_from("<2I", source, 12)
                    self.assertEqual(image.size, (width, height))

    def test_preview_uses_hugo_slug_and_creates_missing_section(self):
        (self.source.parent / "_index.md").unlink()
        source = (self.source / "index.md").read_text(encoding="utf-8")
        (self.source / "index.md").write_text(source.replace("draft = true", "draft = true\nslug = 'public-entry'"), encoding="utf-8")
        report = self.assert_success(self.run_publish())
        self.assertTrue(report["preview_url"].endswith("/public-entry/"), report)
        self.assertTrue((self.target.parent / "_index.md").exists())

    def test_destination_junction_is_rejected_without_touching_other_directory(self):
        if sys.platform != "win32":
            self.skipTest("Windows junction boundary")
        outside = self.root / "outside"
        outside.mkdir()
        sentinel = outside / "sentinel.txt"
        sentinel.write_text("keep", encoding="utf-8")
        self.target.parent.parent.mkdir(parents=True)
        junction = self.target.parent
        created = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(outside)], capture_output=True, timeout=30)
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertNotEqual(self.run_publish().returncode, 0)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
        self.assertFalse((outside / self.target.name).exists())


if __name__ == "__main__":
    unittest.main()
