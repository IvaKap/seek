# Seek — Python sidecar for the Nicotine+ core.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later

# Not the version anything reads: the one that goes on the wire, and the one
# release.sh checks against package.json, is SIDECAR_VERSION in core_host.py.
# This is the conventional package attribute, kept in step so it cannot be
# mistaken for the answer.
#
# It was 0.2.5 through the whole of 0.2.6, because "kept in step" was a promise
# with nothing behind it. release.sh now checks this line too, which is the
# only reason to believe the sentence above.
__version__ = "0.2.8"
