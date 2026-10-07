import argparse
import json
import logging
import os
import re
import secrets
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

import tomlkit

from publish_local_post import DESTINATIONS, no_redirect, publish


def remove_draft(root, article):
    content = root / "content"
    no_redirect(article, content)
    if article.relative_to(content).parts[0] not in {"local", "posts", "protect"} or article.name != "index.md" or not article.is_file():
        raise ValueError("只能修改 local、posts 或 protect 中的文章 index.md")
    original = article.read_bytes()
    text = original.decode("utf-8")
    match = re.match(r"\A(\ufeff?\+\+\+[ \t]*\r?\n)(.*?)(^\+\+\+[ \t]*(?:\r?\n|$))", text, re.DOTALL | re.MULTILINE)
    if not match:
        raise ValueError("文章必须使用 TOML front matter")
    front = tomlkit.parse(match[2])
    if front.get("draft") is not True:
        return {"draft": False, "changed": False}
    del front["draft"]
    updated = (match[1] + tomlkit.dumps(front) + match[3] + text[match.end():]).encode("utf-8")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=article.parent, prefix=".draft-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(updated)
        if article.read_bytes() != original:
            raise ValueError("文章已被其他程序修改，请刷新后重试")
        os.replace(temporary, article)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"draft": False, "changed": True}


class PublishServer(ThreadingHTTPServer):
    def __init__(self, address, root, preview_port=1313, log_path=None):
        if address[0] not in {"127.0.0.1", "localhost"}:
            raise ValueError("发布服务只能监听本机回环地址")
        self.root = Path(root).resolve()
        if not (self.root / "hugo.toml").is_file():
            raise ValueError("发布服务项目缺少 hugo.toml")
        self.origins = {f"http://localhost:{preview_port}", f"http://127.0.0.1:{preview_port}"}
        self.token = secrets.token_urlsafe(32)
        self.jobs = {}
        self.active = None
        self.lock = threading.Lock()
        self.workers = ThreadPoolExecutor(max_workers=1)
        path = Path(log_path) if log_path else Path(os.getenv("LOCALAPPDATA", str(self.root / ".tmp-localcheck"))) / "GithubIO/protocols/publish-server.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        self.logger = logging.getLogger(f"local-publish.{id(self)}")
        self.logger.setLevel(logging.INFO)
        self.logger.propagate = False
        handler = RotatingFileHandler(path, maxBytes=2 * 1024 * 1024, backupCount=1, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s [%(process)d] %(message)s"))
        self.logger.addHandler(handler)
        super().__init__(address, PublishHandler)
        self.logger.info("server ready root=%s port=%s", self.root, self.server_port)

    def generate(self, job_id, article, max_edge, destination):
        self.logger.info("publish start id=%s article=%s max_edge=%s destination=%s",
                         job_id, article, max_edge, destination)
        def progress(value):
            count = f"{value['completed']} / {value['total']} 张"
            message = f"已完成 {count}：{value['file']}" if value["file"] else f"正在转换贴图：{count}"
            if value["phase"] == "finalizing":
                message = f"贴图 {count} 已完成，正在写入文章与 sidecar…"
            with self.lock:
                self.jobs[job_id].update(progress=value, message=message)
            if value["file"]:
                self.logger.info("texture done id=%s completed=%s total=%s file=%s", job_id,
                                 value["completed"], value["total"], value["file"])
        try:
            plan = publish(article, dry_run=True, max_edge=max_edge, destination=destination)
            progress({"phase": "textures", "completed": 0, "total": plan["converted"], "file": ""})
            result = publish(article, max_edge=max_edge, progress=progress, destination=destination)
            with self.lock:
                self.jobs[job_id].update(state="succeeded", result=result)
            self.logger.info("publish success id=%s destination=%s target=%s converted=%s bytes=%s", job_id,
                             destination, result["target"], result["converted"], result["output_bytes"])
        except Exception as error:
            with self.lock:
                self.jobs[job_id].update(state="failed", error=str(error))
            self.logger.exception("publish failed id=%s", job_id)
        finally:
            with self.lock:
                self.active = None

    def server_close(self):
        super().server_close()
        self.workers.shutdown(wait=True)
        for handler in self.logger.handlers[:]:
            handler.close()
            self.logger.removeHandler(handler)


class PublishHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def reply(self, status, value=None):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if self.headers.get("Origin") in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-GithubIO-Publish-Token")
            self.send_header("Access-Control-Max-Age", "300")
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def authorized(self, token=True, health=False):
        hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        origin = self.headers.get("Origin")
        if self.headers.get("Host", "").lower() not in hosts or (origin not in self.server.origins and not (health and origin is None)):
            self.reply(403, {"error": "发布服务只接受本机博客预览页面的请求"})
            return False
        if token and not secrets.compare_digest(self.headers.get("X-GithubIO-Publish-Token", ""), self.server.token):
            self.reply(403, {"error": "发布会话已失效，请重新打开配置面板"})
            return False
        return True

    def do_OPTIONS(self):
        if not self.authorized(token=False):
            return
        self.reply(204)

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/health":
            if self.authorized(token=False, health=True):
                with self.server.lock:
                    busy = self.server.active is not None
                self.reply(200, {"service": "GithubIO.local-publish", "root": str(self.server.root), "pid": os.getpid(),
                                 "texture_progress": True, "busy": busy, "destinations": list(DESTINATIONS)})
        elif route == "/session":
            if self.authorized(token=False):
                self.reply(200, {"token": self.server.token, "destinations": list(DESTINATIONS), "remove_draft": True})
        elif route.startswith("/jobs/"):
            if not self.authorized():
                return
            with self.server.lock:
                job = self.server.jobs.get(route[6:])
                snapshot = dict(job) if job else None
            self.reply(200 if snapshot else 404, snapshot or {"error": "发布任务不存在，请重新生成"})
        else:
            self.reply(404, {"error": "未知发布接口"})

    def do_POST(self):
        if not self.authorized():
            return
        route = urlsplit(self.path).path
        if route not in {"/publish", "/remove-draft"}:
            self.reply(404, {"error": "未知发布接口"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384 or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise ValueError("发布请求必须为不超过 16 KiB 的 JSON")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or not isinstance(data.get("article"), str):
                raise ValueError("发布请求缺少文章路径")
            if route == "/remove-draft":
                article = Path(data["article"])
                if not article.is_absolute():
                    article = self.server.root / article
                with self.server.lock:
                    if self.server.active:
                        self.reply(409, {"error": "正在生成文章，请等待完成后再移除草稿"})
                        return
                    result = remove_draft(self.server.root, article)
                self.server.logger.info("remove draft article=%s changed=%s", article, result["changed"])
                self.reply(200, result)
                return
            edge = data.get("max_edge", 0)
            if type(edge) is not int or edge not in {0, 1024, 2048}:
                raise ValueError("贴图尺寸请选择原尺寸、2048 或 1024")
            destination = data.get("destination", "public")
            if not isinstance(destination, str) or destination not in DESTINATIONS:
                raise ValueError("发布目标必须是 public 或 protect")
            article = Path(data["article"])
            if not article.is_absolute():
                article = self.server.root / article
            no_redirect(article, self.server.root / "content/local")
            if not article.is_file() or article.suffix.lower() != ".md" or article.name == "_index.md":
                raise ValueError("请指定 local 下的文章 Markdown 文件")
            with self.server.lock:
                if self.server.active:
                    self.reply(409, {"error": "已有文章正在发布，请等待它完成"})
                    return
                if len(self.server.jobs) >= 20:
                    del self.server.jobs[next(iter(self.server.jobs))]
                job_id = secrets.token_hex(16)
                self.server.jobs[job_id] = {"id": job_id, "state": "running", "destination": destination,
                                            "message": "正在读取 local 源并准备生成…"}
                self.server.active = job_id
            self.server.workers.submit(self.server.generate, job_id, article, edge, destination)
            self.reply(202, {"id": job_id, "state": "running"})
        except (ValueError, OSError) as error:
            self.reply(400, {"error": str(error)})

    def log_message(self, format, *args):
        if not self.path.startswith("/jobs/"):
            self.server.logger.info(format, *args)


def main():
    parser = argparse.ArgumentParser(description="本地博客文章发布服务")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--port", type=int, default=1314)
    parser.add_argument("--preview-port", type=int, default=1313)
    parser.add_argument("--with-preview", action="store_true", help="同时运行 Hugo 预览，退出预览时关闭发布服务")
    args = parser.parse_args()
    args.root = args.root.resolve()
    preview_command = ["hugo", "server", "-D", "-p", str(args.preview_port), "--source", str(args.root)]
    if os.name == "nt":
        preview_command.extend(["--poll", "500ms"])
    if args.with_preview and args.port:
        try:
            with urlopen(f"http://127.0.0.1:{args.port}/health", timeout=2) as response:
                health = json.loads(response.read(8192))
        except (URLError, TimeoutError):
            health = None
        if health is not None:
            if not isinstance(health, dict) or health.get("service") != "GithubIO.local-publish" or Path(health.get("root", "")).resolve() != args.root:
                parser.error(f"端口 {args.port} 上的服务不属于当前项目")
            print(f"复用当前项目的本地发布服务：http://127.0.0.1:{args.port}", flush=True)
            try:
                return subprocess.call(preview_command)
            except KeyboardInterrupt:
                return 0
    with PublishServer(("127.0.0.1", args.port), args.root, args.preview_port) as server:
        print(f"本地发布服务：http://127.0.0.1:{server.server_port}", flush=True)
        if args.with_preview:
            preview = subprocess.Popen(preview_command)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                return preview.wait()
            except KeyboardInterrupt:
                return 0
            finally:
                if preview.poll() is None:
                    preview.terminate()
                    preview.wait()
                server.shutdown()
                thread.join()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
