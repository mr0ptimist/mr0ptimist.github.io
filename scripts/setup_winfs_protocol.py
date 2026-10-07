import argparse
import ctypes
import json
import os
import shutil
import sys
import winreg
from pathlib import Path

SCHEMES = ("winfs", "cc", "cca", "postpub")
REGISTRY_BASE = r"Software\Classes"


def registration_plan(directory=None):
    directory = Path(directory) if directory else Path(os.environ["LOCALAPPDATA"]) / "GithubIO/protocols"
    python = Path(sys.executable).with_name("pythonw.exe")
    project = Path(__file__).resolve().parent.parent
    if python.resolve().is_relative_to(project):
        python = Path(sys.base_prefix) / "pythonw.exe"
    if python.resolve().is_relative_to(project) or not python.is_file():
        raise ValueError("请使用安装在项目目录外的 Windows Python 解释器")
    relay = directory / "protocol-relay.py"
    return {"relay": str(relay), "command": f'"{python}" -X utf8 "{relay}" "%1"', "schemes": list(SCHEMES)}


def handler_name(scheme):
    query = ctypes.windll.shlwapi.AssocQueryStringW
    query.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_wchar_p,
                      ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint)]
    query.restype = ctypes.c_long
    output = ctypes.create_unicode_buffer(4096)
    length = ctypes.c_uint(len(output))
    result = query(0x1000, 4, scheme, None, output, ctypes.byref(length))
    if result < 0 or not output.value:
        raise ValueError(f"Windows 无法解析 {scheme} 协议处理程序")
    return output.value


def install(directory=None, registry_base=REGISTRY_BASE, notify=True):
    plan = registration_plan(directory)
    relay = Path(plan["relay"])
    relay.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(Path(__file__).with_name("protocol-relay.py"), relay)
    for scheme in SCHEMES:
        base = registry_base + "\\" + scheme
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, f"URL:GithubIO {scheme} Protocol")
            winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, plan["command"])
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as key:
            if winreg.QueryValueEx(key, "") != (plan["command"], winreg.REG_SZ):
                raise ValueError(f"{scheme} 协议注册值不完整")
    if notify:
        change = ctypes.windll.shell32.SHChangeNotify
        change.argtypes = [ctypes.c_long, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
        change(0x08000000, 0x1000, None, None)
    return plan


def main():
    parser = argparse.ArgumentParser(description="为当前用户注册本地博客的 Python 协议中继")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(registration_plan() if args.dry_run else install(), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError) as error:
        print(f"注册本地协议失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
