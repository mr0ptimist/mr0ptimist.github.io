import argparse
import ctypes
import json
import logging
import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from publish_local_post import no_redirect, publish

SCHEMES = {"winfs", "cc", "cca", "postpub"}


def parse_url(url):
    scheme, separator, payload = url.partition(":")
    scheme = scheme.lower()
    if not separator or scheme not in SCHEMES:
        raise ValueError("未知本地协议")
    if scheme == "postpub":
        payload = payload.split("?", 1)[0]
    path = Path(unquote(payload, errors="strict"))
    if not path.is_absolute():
        raise ValueError("本地协议需要绝对路径")
    root = next((directory for directory in (path, *path.parents) if (directory / "hugo.toml").is_file()), None)
    if root is None:
        raise ValueError(f"找不到文章所属项目的 hugo.toml：{path}")
    return scheme, path, root.resolve()


def article_bundle(article, root):
    no_redirect(article, root / "content")
    if article.suffix.lower() != ".md" or article.name == "_index.md":
        raise ValueError("Claude 文章入口需要 Markdown 文章")
    private = root / "content/PRIVATE.md"
    if private.is_file():
        private.read_text(encoding="utf-8-sig")
    directory = article.parent if article.name == "index.md" else article.with_suffix("")
    previous_context = article.parent / "context.json"
    no_redirect(previous_context, root / "content")
    if previous_context.is_file():
        json.loads(previous_context.read_text(encoding="utf-8-sig"))
    index = directory / "index.md"
    no_redirect(index, root / "content")
    context = directory / "context.json"
    no_redirect(context, root / "content")
    if context.is_file():
        json.loads(context.read_text(encoding="utf-8-sig"))
    if article.name == "index.md":
        if not article.is_file():
            raise ValueError(f"文章不存在：{article}")
        return article
    if index.exists() and not index.is_file():
        raise ValueError(f"文章目标不是文件：{index}")
    if not index.exists():
        if not article.is_file():
            raise ValueError(f"文章不存在：{article}")
        directory.mkdir(exist_ok=True)
        article.rename(index)
    if not context.exists():
        context.write_text(json.dumps({"rdc_files": [], "code_refs": [], "notes": ""}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return index


def python_console():
    executable = Path(sys.executable)
    if executable.name.lower() == "pythonw.exe":
        executable = executable.with_name("python.exe")
    if not executable.is_file():
        raise ValueError("找不到 Python 控制台解释器")
    return str(executable)


def dispatch(url, terminal=False, no_ui=False, log_path=None):
    scheme, path, root = parse_url(url)
    if scheme == "winfs":
        if not path.exists():
            raise ValueError(f"目录或文件不存在：{path}")
        subprocess.Popen(["explorer.exe", "/select,", str(path)])
        return None
    if scheme in {"cc", "cca"}:
        if scheme == "cca":
            path = article_bundle(path, root)
            directory = path.parent
        else:
            directory = root
        if not terminal:
            canonical = scheme + ":" + quote(str(path), safe="")
            subprocess.Popen([python_console(), "-X", "utf8", str(Path(__file__).resolve()), canonical, "--terminal"],
                             cwd=directory, creationflags=subprocess.CREATE_NEW_CONSOLE)
            return None
        config = json.loads((root / "scripts/prompts.json").read_text(encoding="utf-8-sig"))
        prompt = config["article" if scheme == "cca" else "project"]["prompt"]
        claude = shutil.which("claude.exe")
        if not claude:
            raise ValueError("找不到原生 Claude CLI（claude.exe）")
        return subprocess.call([claude, "--model", "deepseek-v4-flash[1m]", "--dangerously-skip-permissions", prompt], cwd=directory)
    query = parse_qs(url.partition("?")[2])
    try:
        edge = int(query.get("max-edge", ["0"])[0])
    except ValueError as error:
        raise ValueError("贴图最长边无效") from error
    logger = logging.getLogger("GithubIO.postpub")
    location = Path(log_path) if log_path else Path(os.environ["LOCALAPPDATA"]) / "GithubIO/protocols/postpub.log"
    location.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(location, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s [%(process)d] %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        logger.info("publisher start url=%s", url)
        logger.info("publisher python=%s article=%s max-edge=%s", sys.executable, path, edge)
        report = publish(path, max_edge=edge)
        logger.info("publisher success target=%s converted=%s bytes=%s", report["target"], report["converted"], report["output_bytes"])
        if not no_ui:
            preview = report.get("preview_url") or query.get("preview", [""])[0]
            address = urlsplit(preview)
            if address.scheme == "http" and address.hostname in {"localhost", "127.0.0.1", "::1"} and address.port == 1313:
                webbrowser.open(preview)
            ctypes.windll.user32.MessageBoxW(None, f"已生成公开文章\n{report['target']}\n贴图转换：{report['converted']} 张", "发布完成", 0)
        return report
    except Exception:
        logger.exception("publisher error")
        raise
    finally:
        handler.close()
        logger.removeHandler(handler)


def main():
    parser = argparse.ArgumentParser(description="本地博客 Explorer / Claude / 发布动作")
    parser.add_argument("url")
    parser.add_argument("--terminal", action="store_true")
    parser.add_argument("--no-ui", action="store_true")
    parser.add_argument("--log-path", type=Path)
    args = parser.parse_args()
    try:
        result = dispatch(args.url, terminal=args.terminal, no_ui=args.no_ui, log_path=args.log_path)
        if args.no_ui and isinstance(result, dict):
            print(json.dumps(result, ensure_ascii=False))
        return result if type(result) is int else 0
    except Exception as error:
        if args.no_ui or args.terminal:
            print(f"本地动作失败：{error}", file=sys.stderr)
        else:
            ctypes.windll.user32.MessageBoxW(None, str(error), "本地动作失败", 0x10)
        return 1
    finally:
        if args.terminal:
            try:
                input("\n会话已结束，按 Enter 关闭窗口…")
            except (EOFError, KeyboardInterrupt):
                pass


if __name__ == "__main__":
    raise SystemExit(main())
