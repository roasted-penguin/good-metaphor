"""맥 추출 노드 설정 파일 확인(T-411). launchd·tailscale을 실제로 건드리지 않고 파일만 읽는다."""
from __future__ import annotations

import json
import plistlib
import re
import subprocess
from datetime import datetime
from pathlib import Path

import pytest

from app.extract_worker import in_window, parse_windows

REPO_ROOT = Path(__file__).resolve().parents[2]
MAC_DIR = REPO_ROOT / "infra" / "mac"
POLICY = REPO_ROOT / "infra" / "tailscale-policy.json"
LABELS = ["com.good-metaphor.ollama-start", "com.good-metaphor.ollama-stop"]
EXPECTED_ENV = {
    "OLLAMA_HOST": "127.0.0.1:11434",
    "OLLAMA_NUM_PARALLEL": "1",
    "OLLAMA_KEEP_ALIVE": "5m",
    "OLLAMA_CONTEXT_LENGTH": "16384",
}


def load_plist(label: str) -> dict:
    return plistlib.loads((MAC_DIR / f"{label}.plist").read_bytes())


def window_spec() -> str:
    text = (MAC_DIR / "window.conf").read_text(encoding="utf-8")
    m = re.search(r'^OLLAMA_WINDOW="([^"]*)"', text, re.M)
    assert m, "window.conf에 OLLAMA_WINDOW가 없어요"
    return m.group(1)


def load_hujson(path: Path) -> dict:
    # 문자열 밖의 // 주석과 끝 쉼표만 지운다(정책 파일에 /* */와 문자열 속 //는 없다)
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        in_str = False
        for i, ch in enumerate(line):
            if ch == '"' and (i == 0 or line[i - 1] != "\\"):
                in_str = not in_str
            if not in_str and line.startswith("//", i):
                line = line[:i]
                break
        out.append(line)
    text = re.sub(r",(\s*[}\]])", r"\1", "\n".join(out))
    return json.loads(text)


@pytest.mark.parametrize("label", LABELS)
def test_plist_환경변수는_정확히_넷이고_127_0_0_1만(label):
    plist = load_plist(label)
    assert plist["Label"] == label
    assert plist["EnvironmentVariables"] == EXPECTED_ENV


@pytest.mark.parametrize("name", [f"{label}.plist" for label in LABELS] + ["window.conf", "ollama-window.sh", "install.sh"])
def test_어디에도_0_0_0_0이_없다(name):
    text = (MAC_DIR / name).read_text(encoding="utf-8")
    # install.sh는 0.0.0.0을 찾아 거절하는 정규식만 갖는다
    assert "0.0.0.0" not in text


def test_시작은_로드때_한번_끝은_로드때_안돈다():
    assert load_plist(LABELS[0])["RunAtLoad"] is True
    assert load_plist(LABELS[1])["RunAtLoad"] is False


@pytest.mark.parametrize("label", LABELS)
def test_사용자_에이전트_틀이고_로그는_good_metaphor_폴더(label):
    plist = load_plist(label)
    assert plist["ProgramArguments"][1] == "__APP_DIR__/ollama-window.sh"
    assert plist["StandardOutPath"].startswith("__LOG_DIR__/")
    assert "UserName" not in plist  # root 에이전트가 아니다


def test_시간창_형식은_서버_EXTRACT_WINDOW와_같다():
    windows = parse_windows(window_spec())
    assert windows, "시간창이 비어 있으면 늘 켜져요"


@pytest.mark.parametrize("hm", ["00:00", "06:59", "07:00", "12:09", "12:10", "12:59", "13:00", "22:59", "23:00", "23:59"])
def test_셸_시간창_판정이_서버와_같다(hm):
    windows = parse_windows(window_spec())
    h, m = map(int, hm.split(":"))
    expected = in_window(datetime(2026, 11, 22, h, m), windows)
    r = subprocess.run(["bash", str(MAC_DIR / "ollama-window.sh"), "in-window", hm], capture_output=True)
    assert r.returncode in (0, 1), r.stderr
    assert (r.returncode == 0) == expected


def test_정책_맥_11434는_rag_server만():
    policy = load_hujson(POLICY)
    assert set(policy["tagOwners"]) == {"tag:rag-server", "tag:llm-node"}
    to_mac = [g for g in policy["grants"] if any(d.startswith("tag:llm-node") for d in g["dst"])]
    assert to_mac == [{"src": ["tag:rag-server"], "dst": ["tag:llm-node"], "ip": ["tcp:11434"]}]


def test_정책에_활짝_열린_규칙이_없다():
    policy = load_hujson(POLICY)
    for g in policy["grants"]:
        for key in ("src", "dst", "ip"):
            assert "*" not in g[key], g
            assert not any(v.startswith("autogroup:internet") or v.startswith("autogroup:member") for v in g[key]), g
    assert "acls" not in policy


def test_정책_SSH는_소유자만_rag_server로():
    policy = load_hujson(POLICY)
    assert len(policy["ssh"]) == 1
    rule = policy["ssh"][0]
    assert rule["src"] == ["autogroup:admin"]
    assert rule["dst"] == ["tag:rag-server"]
    assert "root" not in rule["users"]


darwin_only = pytest.mark.skipif(__import__("sys").platform != "darwin", reason="plutil·launchctl은 맥에만 있다")


def _copy_mac_dir(tmp_path: Path) -> Path:
    dst = tmp_path / "mac"
    dst.mkdir()
    for f in MAC_DIR.iterdir():
        if f.is_file():
            (dst / f.name).write_bytes(f.read_bytes())
    return dst


@darwin_only
def test_install은_plist_OLLAMA_HOST가_다르면_아무것도_안하고_멈춘다(tmp_path):
    d = _copy_mac_dir(tmp_path)
    p = d / f"{LABELS[0]}.plist"
    p.write_text(p.read_text(encoding="utf-8").replace("127.0.0.1:11434", "0.0.0.0:11434"), encoding="utf-8")
    home = tmp_path / "home"
    home.mkdir()
    r = subprocess.run(["bash", str(d / "install.sh")], capture_output=True, text=True,
                       env={"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"})
    assert r.returncode == 1
    assert "멈춰요" in r.stderr
    assert not (home / "Library").exists()  # 에이전트·사본을 만들지 않았다


@darwin_only
def test_install은_셸_OLLAMA_HOST가_다르면_멈춘다(tmp_path):
    d = _copy_mac_dir(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    r = subprocess.run(["bash", str(d / "install.sh")], capture_output=True, text=True,
                       env={"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "OLLAMA_HOST": "0.0.0.0:11434"})
    assert r.returncode == 1
    assert "멈춰요" in r.stderr
    assert not (home / "Library").exists()


def test_시작_에이전트에_KeepAlive가_없다():
    # 조건부 KeepAlive(SuccessfulExit)를 두면 launchd가 RunAtLoad를 미뤄 로드 때 켜지지 않았다(2026-11-22)
    assert "KeepAlive" not in load_plist(LABELS[0])
