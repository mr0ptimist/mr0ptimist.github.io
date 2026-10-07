import ctypes
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote


def dispatch(url):
    scheme, separator, payload = url.partition(":")
    if not separator or scheme.lower() not in {"winfs", "cc", "cca", "postpub"}:
        raise ValueError("未知本地协议")
    if scheme.lower() == "postpub":
        payload = payload.split("?", 1)[0]
    path = Path(unquote(payload, errors="strict"))
    if not path.is_absolute():
        raise ValueError("本地协议需要绝对路径")
    root = next((directory for directory in (path, *path.parents) if (directory / "hugo.toml").is_file()), None)
    if root is None:
        raise ValueError(f"找不到项目 hugo.toml：{path}")
    handler = root / "scripts/dev_actions.py"
    if not handler.is_file():
        raise ValueError(f"本地动作脚本不存在：{handler}")
    subprocess.Popen([sys.executable, "-X", "utf8", str(handler), url], cwd=root,
                     creationflags=subprocess.CREATE_NO_WINDOW)


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError("本地协议需要一个 URL 参数")
        dispatch(sys.argv[1])
        return 0
    except Exception as error:
        directory = Path(os.environ["LOCALAPPDATA"]) / "GithubIO/protocols"
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "relay.log").open("a", encoding="utf-8") as log:
            log.write(str(error) + "\n")
        ctypes.windll.user32.MessageBoxW(None, str(error), "本地工具启动失败", 0x10)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
