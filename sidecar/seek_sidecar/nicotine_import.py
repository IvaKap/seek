# Seek — import settings from an existing Nicotine+ installation.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# THE RULES THIS MODULE EXISTS TO ENFORCE
#
# 1. USER-TRIGGERED ONLY. Nothing here runs on startup, on connect, or as a
#    fallback when Seek's own config is empty. It runs when the user clicks the
#    button and at no other time. There is deliberately no auto-detect-and-adopt
#    path, because "it just worked" and "it read my credentials without asking"
#    are the same event described by two different people.
#
# 2. INSPECT BEFORE APPLY. `inspect()` reports what WOULD be read so the UI can
#    state it plainly first. `apply()` takes explicit per-category opt-ins —
#    credentials, shares, download folder — with no "import everything"
#    shorthand.
#
# 3. THE PASSWORD NEVER CROSSES THE WIRE. `ImportSource` has no password field
#    and never will. `inspect()` reports only whether one exists; `apply()`
#    copies the value from one config dict to another inside this process. It is
#    never returned, never logged, and never emitted as an event.
#
# Nicotine+ stores its password in plaintext in its own config file. That is
# upstream's design and not something Seek can fix, but it is a good reason to
# touch the value as few times as possible and never move it anywhere new.

import ast
import logging
import os
import sys
from configparser import ConfigParser, Error as ConfigParserError

log = logging.getLogger("seek.import")


def default_config_path():
    """Where Nicotine+ keeps its config on this platform.

    Mirrors pynicotine.config.Config.get_user_folders() rather than importing
    it, because that function has the side effect of setting NICOTINE_DATA_HOME
    and we want a pure lookup.
    """
    home = os.path.expanduser("~")

    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", os.path.join(home, "AppData", "Roaming"))
        return os.path.join(os.path.normpath(appdata), "nicotine", "config", "config")

    legacy = os.path.join(home, ".nicotine")
    if os.path.isdir(legacy):
        return os.path.join(legacy, "config")

    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = xdg.split(":")[0] if xdg else os.path.join(home, ".config")
    return os.path.join(base, "nicotine", "config")


def _read(config_path):
    """Parse a Nicotine+ config into {section: {option: value}}.

    Upstream writes every value with `str(value)` and reads it back through
    ast.literal_eval, so lists and tuples arrive as Python reprs.
    """
    parser = ConfigParser(strict=False, interpolation=None)
    with open(config_path, encoding="utf-8") as handle:
        parser.read_file(handle)

    out = {}
    for section in parser.sections():
        values = {}
        for option in parser.options(section):
            raw = parser.get(section, option)
            try:
                values[option] = ast.literal_eval(raw)
            except (ValueError, SyntaxError):
                values[option] = raw
        out[section] = values
    return out


def _shared_folders(transfers):
    """Normalise upstream's `shared` list into SharedFolder dicts.

    Entries are (virtual_name, path) tuples, but tolerate bare strings from very
    old configs.
    """
    folders = []
    for entry in transfers.get("shared") or ():
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            virtual_name, path = str(entry[0]), str(entry[1])
        elif isinstance(entry, str):
            virtual_name, path = os.path.basename(entry.rstrip("/")) or entry, entry
        else:
            continue
        folders.append({
            "virtualName": virtual_name,
            "path": path,
            "exists": os.path.isdir(path),
        })
    return folders


def inspect(config_path=None):
    """Report what an existing Nicotine+ install offers. Reads nothing else.

    Returns an ImportSource payload. Never includes the password.
    """
    config_path = config_path or default_config_path()
    blank = {
        "available": False,
        "configPath": config_path,
        "hasCredentials": False,
        "username": None,
        "folders": [],
        "downloadFolder": None,
        "error": None,
    }

    if not os.path.isfile(config_path):
        return blank

    try:
        sections = _read(config_path)
    except (OSError, ConfigParserError, UnicodeDecodeError) as error:
        blank["error"] = f"could not read config: {error}"
        return blank

    server = sections.get("server", {})
    transfers = sections.get("transfers", {})

    username = server.get("login") or None
    password = server.get("passw") or None
    download_folder = transfers.get("downloaddir") or None

    return {
        "available": True,
        "configPath": config_path,
        # Reported as a boolean. The value itself stays in this process.
        "hasCredentials": bool(username and password),
        "username": str(username) if username else None,
        "folders": _shared_folders(transfers),
        "downloadFolder": str(download_folder) if download_folder else None,
        "error": None,
    }


def apply(config, params, config_path=None):
    """Copy selected settings into Seek's live pynicotine config.

    `config` is the pynicotine config singleton. Mutates it in place and returns
    an ImportResult. The caller is responsible for persisting
    (`config.write_configuration()`).

    Every category is an explicit opt-in. Nothing is copied that was not asked
    for by name.
    """
    config_path = config_path or default_config_path()
    result = {
        "importedCredentials": False,
        "importedShares": 0,
        "importedDownloadFolder": False,
        "username": None,
    }

    if not os.path.isfile(config_path):
        raise FileNotFoundError(f"no Nicotine+ config at {config_path}")

    sections = _read(config_path)
    server = sections.get("server", {})
    transfers = sections.get("transfers", {})

    if params.get("credentials"):
        username = server.get("login")
        password = server.get("passw")
        if username and password:
            # The one place the password is touched. Straight from the parsed
            # source dict into the destination config. Not returned, not logged.
            config.sections["server"]["login"] = str(username)
            config.sections["server"]["passw"] = str(password)
            result["importedCredentials"] = True
            result["username"] = str(username)
            log.info("imported credentials for user %s", username)

    if params.get("shares"):
        folders = _shared_folders(transfers)
        if folders:
            config.sections["transfers"]["shared"] = [
                (folder["virtualName"], folder["path"]) for folder in folders
            ]
            result["importedShares"] = len(folders)
            log.info("imported %d shared folder(s)", len(folders))

    if params.get("downloadFolder"):
        download_folder = transfers.get("downloaddir")
        if download_folder:
            config.sections["transfers"]["downloaddir"] = str(download_folder)
            result["importedDownloadFolder"] = True

    return result
