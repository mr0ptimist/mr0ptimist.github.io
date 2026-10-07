import json
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

import test_publish_local_post as fixtures

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    from local_publish_server import PublishServer
except ImportError:
    PublishServer = None


class LocalPublishServerTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(PublishServer, "本地发布服务尚未实现")
        self.fixture = fixtures.PublishLocalPostTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.server = PublishServer(("127.0.0.1", 0), self.fixture.root,
                                    log_path=self.fixture.root / "publish-server.log")
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.origin = "http://localhost:1313"
        self.token = self.request("/session")[1]["token"]

    def request(self, route, method="GET", body=None, headers=None):
        request_headers = {"Origin": self.origin, "X-GithubIO-Publish-Token": getattr(self, "token", "")}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        request = Request(self.base + route, data=data, method=method, headers=request_headers)
        try:
            response = urlopen(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else {}, response.headers

    def publish(self):
        status, job, _ = self.request("/publish", "POST", {
            "article": str(self.fixture.source / "index.md"), "max_edge": 1024})
        self.assertEqual(status, 202, job)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            status, result, _ = self.request("/jobs/" + job["id"])
            self.assertEqual(status, 200, result)
            if result["state"] != "running":
                return result
            time.sleep(0.05)
        self.fail("发布任务未结束")

    def test_remove_draft_preserves_other_front_matter_and_body(self):
        article = self.fixture.source / "index.md"
        original = '+++\r\ntitle = "测试" # title comment\r\ndraft = true # draft comment\r\n[params]\r\ndraft = true\r\n+++\r\n正文\r\n'
        article.write_bytes(original.encode("utf-8"))
        status, result, _ = self.request("/remove-draft", "POST", {"article": str(article)})
        self.assertEqual(status, 200, result)
        self.assertEqual(article.read_bytes(), original.replace('draft = true # draft comment\r\n', '').encode("utf-8"))
        before = article.read_bytes()
        self.assertEqual(self.request("/remove-draft", "POST", {"article": str(article)})[0], 200)
        self.assertEqual(article.read_bytes(), before)

    def test_remove_draft_accepts_protect_and_rejects_outside_paths_and_missing_auth(self):
        article = self.fixture.root / "content/protect/group/post/index.md"
        article.parent.mkdir(parents=True)
        article.write_text('+++\ntitle = "私有"\ndraft = true\n+++\n内容\n', encoding="utf-8")
        body = {"article": str(article)}
        self.assertEqual(self.request("/remove-draft", "POST", body, {"X-GithubIO-Publish-Token": ""})[0], 403)
        self.assertEqual(self.request("/remove-draft", "POST", body)[0], 200)
        outside = self.fixture.root / "outside.md"
        outside.write_text('+++\ndraft = true\n+++\n', encoding="utf-8")
        before = outside.read_bytes()
        self.assertEqual(self.request("/remove-draft", "POST", {"article": str(outside)})[0], 400)
        self.assertEqual(outside.read_bytes(), before)

    def test_remove_draft_refuses_changes_during_publication(self):
        article = self.fixture.source / "index.md"
        before = article.read_bytes()
        self.server.active = "running-job"
        self.assertEqual(self.request("/remove-draft", "POST", {"article": str(article)})[0], 409)
        self.assertEqual(article.read_bytes(), before)

    def test_confirmation_generates_and_replaces_bundle_with_observable_result(self):
        before = self.fixture.hashes()
        job = self.publish()
        self.assertEqual(job["state"], "succeeded", job)
        self.assertEqual(job["result"]["converted"], 1)
        self.assertGreater(job["result"]["output_bytes"], 0)
        target = self.fixture.target
        self.assertTrue((target / "images/map.png").is_file())
        self.assertTrue((target / "shaders/test.json").is_file())
        self.assertFalse((target / "images/map.dds").exists())
        self.assertFalse((target / "shaders/test.hlsl").exists())
        self.assertEqual(self.fixture.hashes(), before)
        (target / "stale.txt").write_text("discard", encoding="utf-8")
        (target / "index.md").write_text("manual edit", encoding="utf-8")
        job = self.publish()
        self.assertEqual(job["state"], "succeeded", job)
        self.assertFalse((target / "stale.txt").exists())
        self.assertIn("测试文章", (target / "index.md").read_text(encoding="utf-8"))
        self.assertEqual(self.fixture.hashes(), before)

    def test_failed_conversion_is_reported_and_preserves_public_bundle(self):
        self.assertEqual(self.publish()["state"], "succeeded")
        previous = (self.fixture.target / "index.md").read_bytes()
        (self.fixture.source / "images/map.dds").write_bytes(b"broken texture")
        job = self.publish()
        self.assertEqual(job["state"], "failed", job)
        self.assertIn("贴图转换失败", job["error"])
        self.assertEqual((self.fixture.target / "index.md").read_bytes(), previous)
        self.assertIn("publish failed", (self.fixture.root / "publish-server.log").read_text(encoding="utf-8"))

    def test_remote_origins_missing_tokens_and_outside_articles_are_rejected(self):
        body = {"article": str(self.fixture.source / "index.md"), "max_edge": 0}
        self.assertEqual(self.request("/session", headers={"Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.request("/publish", "POST", body, {"Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.request("/publish", "POST", body, {"X-GithubIO-Publish-Token": ""})[0], 403)
        self.assertEqual(self.request("/publish", "POST", body, {"Host": "example.com"})[0], 403)
        body["article"] = str(self.fixture.root / "outside.md")
        self.assertEqual(self.request("/publish", "POST", body)[0], 400)
        body["article"] = str(self.fixture.source / "index.md")
        body["max_edge"] = 7
        self.assertEqual(self.request("/publish", "POST", body)[0], 400)
        self.assertFalse(self.fixture.target.exists())

    def test_browser_preflight_and_health_allow_only_the_local_preview(self):
        status, _, headers = self.request("/publish", "OPTIONS", headers={
            "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-githubio-publish-token"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], self.origin)
        self.assertIn("X-GithubIO-Publish-Token", headers["Access-Control-Allow-Headers"])
        self.assertEqual(self.request("/publish", "OPTIONS", headers={"Origin": "http://localhost:9999"})[0], 403)
        status, health, _ = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(Path(health["root"]), self.fixture.root)
        self.assertNotIn("token", health)

    def test_browser_observes_each_completed_texture_while_job_is_running(self):
        source = self.fixture.source
        (source / "images/second.dds").write_bytes((source / "images/map.dds").read_bytes())
        with (source / "index.md").open("a", encoding="utf-8") as handle:
            handle.write("\n![第二张](images/second.dds)\n")
        first = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        from publish_local_post import publish as generate
        def tracked(*args, **kwargs):
            callback = kwargs.get("progress")
            if callback:
                def update(event):
                    callback(event)
                    if event["phase"] == "textures" and event["completed"] == 1:
                        first.set()
                        release.wait(10)
                kwargs["progress"] = update
            return generate(*args, **kwargs)
        with patch("local_publish_server.publish", side_effect=tracked):
            status, started, _ = self.request("/publish", "POST", {"article": str(source / "index.md"), "max_edge": 0})
            self.assertEqual(status, 202)
            self.assertTrue(first.wait(10), "第一张完成事件未送达")
            job = self.request("/jobs/" + started["id"])[1]
            self.assertEqual(job["state"], "running")
            self.assertEqual(job["progress"]["phase"], "textures")
            self.assertEqual(job["progress"]["completed"], 1)
            self.assertEqual(job["progress"]["total"], 2)
            self.assertIn(job["progress"]["file"], {"images/map.dds", "images/second.dds"})
            self.assertIn("1 / 2 张", job["message"])
            release.set()
            deadline = time.monotonic() + 10
            while job["state"] == "running" and time.monotonic() < deadline:
                time.sleep(0.05)
                job = self.request("/jobs/" + started["id"])[1]
            self.assertEqual(job["state"], "succeeded", job)
            self.assertEqual(job["progress"]["completed"], 2)

    def test_preview_failure_exits_and_can_reuse_the_same_project_service(self):
        (self.fixture.root / "hugo.toml").write_text("title = [\n", encoding="utf-8")
        for port in (0, self.server.server_port):
            result = subprocess.run([sys.executable, "-X", "utf8", str(Path(__file__).resolve().parents[1] / "local_publish_server.py"),
                                     "--root", str(self.fixture.root), "--with-preview", "--port", str(port), "--preview-port", "0"],
                                    capture_output=True, text=True, encoding="utf-8", timeout=20,
                                    env={**os.environ, "LOCALAPPDATA": str(self.fixture.root)})
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("本地发布服务", result.stdout)
            self.assertIn("toml", (result.stdout + result.stderr).lower())

    def test_preview_does_not_reuse_a_service_from_another_project(self):
        other = self.fixture.root / "another-project"
        other.mkdir()
        (other / "hugo.toml").write_text("title = 'another'\n", encoding="utf-8")
        result = subprocess.run([sys.executable, "-X", "utf8", str(Path(__file__).resolve().parents[1] / "local_publish_server.py"),
                                 "--root", str(other), "--with-preview", "--port", str(self.server.server_port)],
                                capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("不属于当前项目", result.stderr)


if __name__ == "__main__":
    unittest.main()
