#!/usr/bin/env python3
"""Start Convertly without installing anything.

    python3 run.py

Adds src/ to the import path and hands over to the package, so the app runs
straight from a checkout.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from convertly.server import main  # noqa: E402  (import needs the path above)

if __name__ == "__main__":
    main()
