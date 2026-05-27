#!/usr/bin/env python
"""Download the latest Stockfish binary for the current platform."""
import io
import sys
import zipfile
from pathlib import Path

import requests

REPO = "official-stockfish/Stockfish"
RELEASES_API = f"https://api.github.com/repos/{REPO}/releases/latest"

# Maps sys.platform → substring that appears in Stockfish asset names
_PLATFORM_KEY = {
    "win32": "windows",
    "darwin": "macos",
    "linux": "ubuntu",
}

# Preferred CPU feature levels (most capable first)
_CPU_PREFS = ["avx2", "bmi2", "modern", "x86-64"]


def _pick_asset(assets: list[dict], platform_key: str) -> dict:
    for pref in _CPU_PREFS:
        for asset in assets:
            name = asset["name"].lower()
            if platform_key in name and pref in name and name.endswith(".zip"):
                return asset
    # Fallback: any zip for this platform
    for asset in assets:
        name = asset["name"].lower()
        if platform_key in name and name.endswith(".zip"):
            return asset
    raise RuntimeError(
        f"No Stockfish zip found for platform '{platform_key}'.\n"
        f"Available assets: {[a['name'] for a in assets]}"
    )


def _find_exe_in_zip(z: zipfile.ZipFile) -> str:
    """Return the zip member path for the Stockfish executable."""
    for member in z.namelist():
        if member.endswith("/"):
            continue  # skip directory entries (file_size == 0)
        name = Path(member).name.lower()
        if name.startswith("stockfish") and (name.endswith(".exe") or "." not in name):
            return member
    raise RuntimeError("Could not locate Stockfish executable inside the zip archive.")


def download_stockfish(dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Return early if already downloaded
    existing = list(dest_dir.glob("stockfish*.exe")) + list(dest_dir.glob("stockfish"))
    if existing:
        print(f"Stockfish already present: {existing[0]}")
        return existing[0]

    platform_key = _PLATFORM_KEY.get(sys.platform)
    if not platform_key:
        raise RuntimeError(f"Unsupported platform: {sys.platform}")

    print("Querying GitHub for latest Stockfish release...")
    resp = requests.get(RELEASES_API, timeout=30, headers={"User-Agent": "Pawnprint/0.1"})
    resp.raise_for_status()
    release = resp.json()
    tag = release["tag_name"]

    asset = _pick_asset(release["assets"], platform_key)
    url = asset["browser_download_url"]
    filename = asset["name"]
    print(f"Downloading {filename} ({tag})...")

    resp = requests.get(url, stream=True, timeout=120, headers={"User-Agent": "Pawnprint/0.1"})
    resp.raise_for_status()

    total = int(resp.headers.get("content-length", 0))
    chunks: list[bytes] = []
    downloaded = 0
    for chunk in resp.iter_content(chunk_size=65536):
        chunks.append(chunk)
        downloaded += len(chunk)
        if total:
            bar = "#" * int(40 * downloaded / total)
            print(f"\r  [{bar:<40}] {downloaded/1024/1024:.1f}/{total/1024/1024:.1f} MB", end="", flush=True)
    print()

    data = b"".join(chunks)
    print("Extracting...")

    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member = _find_exe_in_zip(z)
        exe_bytes = z.read(member)

    # Save with a clean name
    ext = ".exe" if sys.platform == "win32" else ""
    target = dest_dir / f"stockfish{ext}"
    target.write_bytes(exe_bytes)
    if sys.platform != "win32":
        target.chmod(0o755)

    print(f"Stockfish installed at: {target}")
    return target


if __name__ == "__main__":
    project_root = Path(__file__).parent.parent
    dest = project_root / "data" / "stockfish"
    path = download_stockfish(dest)
    print(f"\nDone. Binary path: {path}")
    print("Add to config or set STOCKFISH_PATH env var if using a custom location.")
