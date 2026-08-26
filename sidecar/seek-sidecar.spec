# Seek — freeze the sidecar into a self-contained binary.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Build:  .venv/bin/pyinstaller seek-sidecar.spec --noconfirm
#
# TWO THINGS THIS FILE EXISTS TO SOLVE.
#
# 1. pynicotine imports plugins and protocol message classes dynamically, so
#    PyInstaller's static analysis cannot see them. `collect_submodules` walks
#    the package and names them all explicitly. Without this the app freezes
#    fine and then dies at runtime the first time it touches a plugin.
#
# 2. `shares` spawns a subprocess using multiprocessing's *spawn* method, which
#    re-imports __main__ in the child. Under PyInstaller that would re-run the
#    whole frozen app — a fork bomb dressed as a rescan. `freeze_support()` in
#    the entry point is what stops it, and it must be the first thing that runs.
#
# ONE-FILE vs ONE-DIR: one-dir, deliberately. A --onefile binary unpacks itself
# to a temp directory on every launch, which for numpy plus libsndfile is a
# visible delay each time the app starts, and leaves litter if it is killed.

from PyInstaller.utils.hooks import (
    collect_data_files, collect_dynamic_libs, collect_submodules,
)

# `upstream/` is a sibling of this directory and is not installed, so it has to
# be added to the analysis path explicitly rather than found on sys.path.
UPSTREAM = "../upstream"

hidden = []
hidden += collect_submodules("pynicotine")
hidden += collect_submodules("seek_sidecar")
# soundfile loads libsndfile through cffi at import time; numpy pulls parts of
# itself in lazily.
hidden += ["_cffi_backend", "soundfile", "numpy"]
# mutagen resolves format handlers by extension at runtime.
hidden += collect_submodules("mutagen")

binaries = collect_dynamic_libs("soundfile")

# DATA FILES, not just modules. `collect_submodules` gathers Python only, and
# pynicotine ships real data it reads at runtime — most importantly
# `external/data/ip_country_data.csv`, which `get_country_code` opens the
# moment a login succeeds. Without this the frozen app starts fine, signs in,
# and then dies: a crash that only ever appears in a distributable build.
datas = collect_data_files("pynicotine", include_py_files=False)
datas += collect_data_files("soundfile")

a = Analysis(
    ["freeze_entry.py"],
    pathex=[".", UPSTREAM],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    excludes=[
        # The sidecar is headless. Excluding the GUI stacks keeps the bundle
        # from carrying a toolkit it will never import — and proves the
        # separation RECON.md verified, since nothing here needs them.
        "gi", "gtk", "tkinter", "PyQt5", "PyQt6", "PySide6",
        "matplotlib", "IPython", "pytest",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="seek-sidecar",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="seek-sidecar",
)
