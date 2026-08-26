"""
Seek — test-run setup for the sidecar.
SPDX-License-Identifier: GPL-3.0-or-later

WHY THIS FILE EXISTS: to stop the test suite passing against code you have
already changed.

CPython decides a cached .pyc is still good by comparing the source file's
modification time (whole seconds) and its size. Both can match after a real
edit — change a line to something the same length and rerun inside the same
second and the cache is silently reused. It was reproduced here with no clock
trickery at all: a file whose source read "NEW" ran as "OLD", and pytest
reported 1 passed.

That is an ordinary edit-run-edit-run afternoon in this project, so the cache
is turned off for test runs rather than trusted. It costs a few milliseconds
of recompilation. Set the same thing for the SERVER with
PYTHONDONTWRITEBYTECODE=1 — see CLAUDE.md — because the sidecar does not
hot-reload either, and the two failure modes look identical from the outside.
"""

import sys

sys.dont_write_bytecode = True
