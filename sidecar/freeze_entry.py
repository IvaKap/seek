# Seek — frozen entry point.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# `freeze_support()` MUST be the first thing that runs. pynicotine's shares
# component spawns a subprocess with multiprocessing's *spawn* method, which
# re-imports __main__ in the child; in a frozen binary that re-runs the whole
# application. Calling freeze_support() first makes the child behave as a
# worker instead of launching a second copy of Seek.
import multiprocessing
import sys

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from seek_sidecar.__main__ import main
    sys.exit(main())
