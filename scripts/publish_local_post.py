import argparse
import contextlib
import csv
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import tomlkit


SCRIPT_DIR = Path(__file__).resolve().parent
TEXTURES = {".dds", ".exr"}
IMAGES = TEXTURES | {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tga"}
CODE_FILES = {".hlsl", ".glsl", ".usf", ".ush", ".ufh", ".shader", ".compute", ".cpp", ".c", ".cc",
              ".cxx", ".h", ".hpp", ".inl", ".cs", ".py", ".js", ".ts", ".metal", ".wgsl", ".spv", ".cso", ".dxil"}
ATTACHMENTS = {".json", ".md", ".txt", ".html", ".csv", ".css"}
CODE_TEXT = re.compile(r"(?ms)(^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n.*?^[ \t]{0,3}\2[ \t]*$|`+[^`\n]*`+)")
PAGE_REF = re.compile(r"{{[<%]\s*(?:rel)?ref\s+(['\"])(.*?)\1\s*[>%]}}")
LINK = re.compile(r"(!?)\[([^\]\n]*)\]\((<[^>\n]+>|(?:\\.|[^()\n]|\([^()\n]*\))*)\)")
DESTINATION = re.compile(r"^(<[^>]+>|\S+?)(\s+[\"'][\s\S]*[\"'])?$", re.DOTALL)


def inside(path, directory):
    resolved, base = path.resolve(), directory.resolve()
    if resolved == base or not resolved.is_relative_to(base):
        raise ValueError(f"路径必须位于目录内: {path} ({directory})")
    return resolved


def no_redirect(path, directory):
    path, directory = path.absolute(), directory.absolute()
    if not path.is_relative_to(directory):
        raise ValueError(f"发布路径必须位于目录内: {path} ({directory})")
    inside(path, directory)
    current = path
    while True:
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ValueError(f"发布路径不能包含符号链接或目录联接: {current}")
        if current == directory:
            break
        current = current.parent


def rename_directory(source, destination):
    for attempt in range(21):
        try:
            source.rename(destination)
            return
        except PermissionError as error:
            if os.name != "nt":
                raise
            if attempt == 20:
                raise PermissionError(f"文章目录被占用：{source}；请关闭目录中的终端，Windows Hugo 预览请使用 --poll 500ms") from error
            time.sleep(0.1)


@contextlib.contextmanager
def publish_lock(workspace, article):
    lock_path = workspace / (hashlib.sha256(str(article).encode()).hexdigest()[:20] + ".lock")
    with lock_path.open("a+b") as handle:
        handle.write(b"0"); handle.flush(); handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ValueError("这篇文章正在发布，请等待当前任务结束") from error
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def split_article(text):
    match = re.match(r"\A\+\+\+\s*\n(.*?)\n\+\+\+[^\S\n]*\n?", text, re.DOTALL)
    if not match:
        raise ValueError("文章必须使用 +++ 分隔的 TOML front matter")
    return tomlkit.parse(match.group(1)), text[match.end():]


def preview_url(root, target, front, relative):
    fallback = str(front.get("url") or "/posts/" + relative.as_posix().lower().replace(" ", "-") + "/")
    try:
        result = subprocess.run(["hugo", "list", "all", "--environment", "development", "--noBuildLock"],
                                cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=30)
        if result.returncode == 0:
            for row in csv.DictReader(io.StringIO(result.stdout)):
                page = Path(row.get("path", ""))
                if not page.is_absolute():
                    page = root / page
                if page.resolve() == (target / "index.md").resolve():
                    return "http://localhost:1313" + urlsplit(row["permalink"]).path
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    return "http://localhost:1313" + quote(fallback, safe="/-._~")


def convert_textures(manifest, bundle, progress):
    command = ["node", str(SCRIPT_DIR / "cdp/export_texture_png.js"), str(manifest)]
    if progress is None:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=600)
        if result.returncode:
            raise ValueError("贴图转换失败:\n" + result.stderr.strip())
        return json.loads(result.stdout)["images"]
    with tempfile.TemporaryFile() as errors, subprocess.Popen(command + ["--progress"], stdout=subprocess.PIPE,
                                                              stderr=errors, text=True, encoding="utf-8") as process:
        timed_out = threading.Event()
        def timeout():
            timed_out.set()
            process.kill()
        timer = threading.Timer(600, timeout)
        timer.daemon = True
        timer.start()
        converted = None
        try:
            for line in process.stdout:
                event = json.loads(line)
                if event.get("event") == "texture":
                    progress({"phase": "textures", "completed": event["completed"], "total": event["total"],
                              "file": Path(event["source"]).relative_to(bundle).as_posix()})
                else:
                    converted = event["images"]
            code = process.wait()
            if timed_out.is_set():
                raise subprocess.TimeoutExpired(command, 600)
            if code:
                errors.seek(0)
                raise ValueError("贴图转换失败:\n" + errors.read().decode("utf-8", errors="replace").strip())
            if converted is None:
                raise ValueError("贴图转换结果缺失")
            return converted
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
                process.wait()


def publish(article, dry_run=False, max_edge=0, progress=None):
    if not isinstance(max_edge, int) or not 0 <= max_edge <= 16384:
        raise ValueError("贴图最长边必须为 0（原尺寸）或 1–16384")
    article = Path(article).absolute()
    if article.is_dir():
        article /= "index.md"
    root = next((p for p in article.parents if (p / "hugo.toml").is_file()), None)
    if root is None:
        raise ValueError("无法从文章路径找到项目 hugo.toml")
    no_redirect(article, root / "content/local")
    root, article = root.resolve(), article.resolve()
    local, posts = root / "content/local", root / "content/posts"
    no_redirect(article, local)
    if not article.is_file() or article.suffix.lower() != ".md" or article.name == "_index.md":
        raise ValueError("请指定 local 下的文章 Markdown 文件")
    bundle = article.parent
    relative = article.relative_to(local).parent if article.name == "index.md" else article.relative_to(local).with_suffix("")
    if not relative.parts:
        raise ValueError("不能把 local 根目录作为文章发布")
    target = posts / relative
    no_redirect(posts, root)
    no_redirect(target, posts)
    if target.exists() and not target.is_dir():
        raise ValueError(f"目标不是文章文件夹: {target}")
    context = bundle / "context.json"
    if context.exists():
        no_redirect(context, bundle)
        json.loads(context.read_text(encoding="utf-8-sig"))
    front, body = split_article(article.read_text(encoding="utf-8-sig"))
    assets, sidecars = {}, {}
    removed = set()
    unpublished_refs = set()
    page_links = None

    def page_reference(match):
        nonlocal page_links
        if page_links is None:
            result = subprocess.run(["hugo", "list", "published", "--environment", "production", "--noBuildLock"],
                                    cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=30)
            if result.returncode:
                raise ValueError("无法解析公开文章引用：" + result.stderr.strip())
            page_links = {}
            for row in csv.DictReader(io.StringIO(result.stdout)):
                file = Path(row["path"])
                if not file.is_absolute():
                    file = root / file
                relative_page = file.relative_to(root / "content").as_posix()
                for alias in {relative_page, relative_page.removesuffix("/index.md"), str(Path(relative_page).with_suffix("")).replace("\\", "/")}:
                    page_links[alias.lower()] = urlsplit(row["permalink"]).path
        requested = urlsplit(unquote(match.group(2)))
        link = page_links.get(requested.path.lstrip("/").lower())
        if link:
            return link + ("#" + quote(requested.fragment) if requested.fragment else "")
        unpublished_refs.add(match.group(2))
        return "\x00UNPUBLISHEDPAGE\x00"

    def reference(value, base=bundle):
        if value == "\x00UNPUBLISHEDPAGE\x00":
            return None
        parsed = urlsplit(value)
        suffix = Path(unquote(parsed.path)).suffix.lower()
        if parsed.scheme.lower() in {"winfs", "vscode", "cc", "cca", "file"}:
            removed.add(value)
            return None
        if parsed.scheme or parsed.netloc or not parsed.path:
            return value
        code_attachment = suffix in CODE_FILES
        if code_attachment:
            removed.add(value)
        if parsed.path.startswith("/"):
            prefix = "/local/" + relative.as_posix().rstrip("/") + "/"
            if not parsed.path.startswith(prefix):
                return None if code_attachment else value
            source = bundle / unquote(parsed.path[len(prefix):])
        else:
            source = base / unquote(parsed.path).replace("\\", "/")
        if code_attachment:
            sidecar = source.with_suffix(".json").resolve()
            if sidecar.is_relative_to(bundle) and sidecar.is_file():
                reference(quote(sidecar.relative_to(bundle).as_posix(), safe="/-._~"))
            return None
        source = inside(source, bundle)
        if not source.is_file():
            raise ValueError(f"正文引用的文件不存在: {source}")
        if suffix not in IMAGES | ATTACHMENTS:
            raise ValueError(f"公开版不支持附件类型: {source.name}")
        if suffix in ATTACHMENTS and source.stat().st_size > 16 * 1024 * 1024:
            raise ValueError(f"资料附件超过 16 MiB: {source.name}")
        output = source.relative_to(bundle)
        if suffix in TEXTURES:
            output = output.with_suffix(".png")
        conflict = next((src for src, dst in assets.items() if dst == output and src != source), None)
        if conflict:
            raise ValueError(f"转换后文件名冲突: {source.name} / {conflict.name}")
        if source not in assets:
            assets[source] = output
            if suffix in IMAGES:
                sidecar = source.with_suffix(".json")
                if sidecar.is_file():
                    inside(sidecar, bundle)
                    sidecars[source] = json.loads(sidecar.read_text(encoding="utf-8-sig"))
        new_path = quote(Path(os.path.relpath(bundle / output, base)).as_posix(), safe="/-._~")
        return urlunsplit(("", "", new_path, parsed.query, parsed.fragment))

    def rewrite(text, base=bundle):
        protected = []
        def protect(match):
            protected.append(match.group(0))
            return f"\x00CODE{len(protected) - 1}\x00"
        text = CODE_TEXT.sub(protect, text)
        text = PAGE_REF.sub(page_reference, text)
        def link(match):
            destination = DESTINATION.fullmatch(match.group(3).strip())
            if not destination or "{{" in destination.group(1):
                return match.group(0)
            old = destination.group(1).strip("<>")
            new = reference(old, base)
            if new is None:
                return match.group(2)
            return f"{match.group(1)}[{match.group(2)}]({new}{destination.group(2) or ''})"
        text = LINK.sub(link, text)
        def html_link(match):
            new = reference(match.group(2), base)
            if new is None:
                return match.group(3)
            return match.group(0).replace(match.group(2), new, 1)
        text = re.sub(r"<a\b[^>]*\bhref\s*=\s*(['\"])(.*?)\1[^>]*>(.*?)</a>", html_link, text, flags=re.I | re.S)
        def attribute(match):
            before = text[:match.start()]
            shortcode_start = before.rfind("{{")
            in_shortcode = shortcode_start > before.rfind("}}")
            if in_shortcode and "htmlview" in before[shortcode_start:] and (root / "static" / match.group(3)).is_file():
                return match.group(0)
            new = reference(match.group(3), base)
            if new is None:
                raise ValueError(f"图片或短代码不能引用源码附件: {match.group(3)}")
            if in_shortcode:
                new = unquote(new)
            return match.group(1) + match.group(2) + new + match.group(2)
        text = re.sub(r"(\bsrc\s*=\s*)(['\"])(.*?)\2", attribute, text, flags=re.I)
        def definition(match):
            new = reference(match.group(2).strip("<>"), base)
            if new is None:
                label = re.escape(match.group(1))
                code_definitions.append((label, match.group(1)))
                return ""
            return f"[{match.group(1)}]: {new}{match.group(3)}"
        code_definitions = []
        text = re.sub(r"^\[([^\]\n]+)\]:\s*(<[^>]+>|\S+)([^\n]*)$", definition, text, flags=re.M)
        for label, original in code_definitions:
            text = re.sub(r"\[([^\]\n]+)\]\[" + label + r"\]", r"\1", text, flags=re.I)
            text = re.sub(r"\[" + label + r"\]", original, text, flags=re.I)
        for index, original in enumerate(protected):
            text = text.replace(f"\x00CODE{index}\x00", original)
        return text.replace("\x00UNPUBLISHEDPAGE\x00", "")

    body = rewrite(body)
    front["draft"] = False
    front["local_publication"] = True
    front["local_source"] = article.relative_to(root / "content").as_posix()
    if front.get("type") == "local":
        front["type"] = "posts"
    if str(front.get("url", "")).startswith("/local/"):
        front["url"] = str(front["url"]).replace("/local/", "/posts/", 1)
    if isinstance(front.get("cover"), dict) and front["cover"].get("image"):
        front["cover"]["image"] = reference(str(front["cover"]["image"]))
    texts = {}
    pending = list(assets)
    while pending:
        source = pending.pop(0)
        if source.suffix.lower() not in {".md", ".html"} or source in texts:
            continue
        texts[source] = rewrite(source.read_text(encoding="utf-8-sig"), source.parent)
        pending.extend(s for s in assets if s not in texts and s not in pending and s.suffix.lower() in {".md", ".html"})
    rendered = "+++\n" + tomlkit.dumps(front).rstrip() + "\n+++\n" + body
    if context.is_file():
        assets[context] = Path("context.json")
    for source, output in assets.items():
        if source.suffix.lower() in TEXTURES and output.with_name(output.stem + ".alpha.png") in assets.values():
            raise ValueError(f"Alpha 导出文件名与已有附件冲突：{output.stem}.alpha.png")
    groups = []
    for length in range(1, len(relative.parts)):
        group = Path(*relative.parts[:length])
        section = local / group / "_index.md"
        if not (posts / group / "_index.md").exists():
            no_redirect(posts / group / "_index.md", posts)
            groups.append((section if section.is_file() else None, posts / group / "_index.md"))
    source_files = set(assets) | {p.with_suffix(".json") for p in sidecars}
    report = {"source": str(article), "target": str(target), "dry_run": dry_run, "max_edge": max_edge,
              "converted": sum(s.suffix.lower() in TEXTURES for s in assets),
              "files": ["index.md"] + [p.as_posix() for p in assets.values()],
              "removed_code_links": sorted(removed), "unpublished_refs": sorted(unpublished_refs),
              "source_bytes": article.stat().st_size + sum(p.stat().st_size for p in source_files)}
    if dry_run:
        return report
    workspace = root / ".tmp-localcheck"
    workspace.mkdir(exist_ok=True)
    no_redirect(workspace / "publish", root)
    with publish_lock(workspace, article), tempfile.TemporaryDirectory(prefix="publish-", dir=workspace) as temporary:
        work = Path(temporary)
        stage = work / "bundle"
        stage.mkdir()
        textures = []
        for source, output in assets.items():
            destination = stage / output
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.suffix.lower() in TEXTURES:
                textures.append({"source": str(source), "destination": str(destination), "sidecar": sidecars.get(source, {})})
            elif source in texts:
                destination.write_text(texts[source], encoding="utf-8")
            else:
                shutil.copy2(source, destination)
        converted = []
        if progress:
            progress({"phase": "textures", "completed": 0, "total": len(textures), "file": ""})
        if textures:
            manifest = work / "textures.json"
            manifest.write_text(json.dumps({"images": textures, "max_edge": max_edge}, ensure_ascii=False), encoding="utf-8")
            converted = convert_textures(manifest, bundle, progress)
            if len(converted) != len(textures):
                raise ValueError("贴图转换结果不完整")
        if progress:
            progress({"phase": "finalizing", "completed": len(converted), "total": len(textures), "file": ""})
        metadata = {Path(item["source"]): item for item in converted}
        report["alpha_images"] = sum(bool(item["alpha_file"]) for item in converted)
        for source, data in sidecars.items():
            data = dict(data)
            output = assets[source]
            if source.suffix.lower() in TEXTURES:
                frame = metadata[source]
                data["image_file"] = output.name
                data["file_type"] = "png"
                data["publication"] = {"source_image": source.name, "source_format": frame["format"],
                                       "channels": frame["channels"], "mip": 0, "slice": 0,
                                       "source_size": [frame["source_width"], frame["source_height"]],
                                       "output_size": [frame["width"], frame["height"]], "max_edge": max_edge,
                                       "normalization": {"min": frame["normMin"], "max": frame["normMax"]},
                                       "rgb_png": True, "alpha_file": frame["alpha_file"]}
            (stage / output.with_suffix(".json")).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for source in metadata.keys() - sidecars.keys():
            frame = metadata[source]
            output = assets[source]
            data = {"image_file": output.name, "file_type": "png", "publication": {
                "source_image": source.name, "source_format": frame["format"], "channels": frame["channels"],
                "source_size": [frame["source_width"], frame["source_height"]],
                "output_size": [frame["width"], frame["height"]], "max_edge": max_edge,
                "mip": 0, "slice": 0, "normalization": {"min": frame["normMin"], "max": frame["normMax"]},
                "rgb_png": True, "alpha_file": frame["alpha_file"]}}
            (stage / output.with_suffix(".json")).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (stage / "index.md").write_text(rendered, encoding="utf-8")
        report["output_bytes"] = sum(p.stat().st_size for p in stage.rglob("*") if p.is_file())
        previous = work / "previous"
        created_sections = []
        try:
            for source, destination in groups:
                no_redirect(destination, posts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.exists():
                    created_sections.append(destination)
                    if source:
                        shutil.copy2(source, destination)
                    else:
                        destination.write_text("+++\n" + tomlkit.dumps({"title": destination.parent.name}) + "+++\n", encoding="utf-8")
            target.parent.mkdir(parents=True, exist_ok=True)
            no_redirect(target, posts)
            if target.exists():
                rename_directory(target, previous)
            rename_directory(stage, target)
        except BaseException:
            if previous.exists():
                rename_directory(previous, target)
            for section in reversed(created_sections):
                no_redirect(section, posts)
                section.unlink(missing_ok=True)
            raise
    report["preview_url"] = preview_url(root, target, front, relative)
    return report


def main():
    parser = argparse.ArgumentParser(description="以 local 为唯一源，重新生成公开文章（整包替换）")
    parser.add_argument("article", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--max-edge", type=int, default=0, help="DDS/EXR 转 PNG 的最长边，0 保留原尺寸")
    options = parser.parse_args()
    try:
        report = publish(options.article, options.dry_run, options.max_edge)
        if options.json:
            print(json.dumps(report, ensure_ascii=False))
        else:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"发布失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
