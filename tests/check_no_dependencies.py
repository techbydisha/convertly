#!/usr/bin/env python3
"""Fail if pyproject.toml has grown a runtime dependency.

"There is nothing to install" is a promise this project makes, so it is worth
checking mechanically rather than trusting review.

Deliberately avoids `tomllib`, which is only available from Python 3.11 while
this project supports 3.10 -- the check has to run everywhere the code does.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def declared_dependencies(text):
    """The contents of the [project] `dependencies = [...]` list, as text."""
    match = re.search(r"^dependencies\s*=\s*\[(.*?)\]", text, re.MULTILINE | re.DOTALL)
    if match is None:
        return None
    # Strip comments and whitespace; anything left is a real dependency.
    body = re.sub(r"#.*", "", match.group(1))
    return body.strip()


def main():
    path = os.path.join(ROOT, "pyproject.toml")
    with open(path, encoding="utf-8") as fh:
        text = fh.read()

    deps = declared_dependencies(text)
    if deps is None:
        print("could not find a 'dependencies' key in pyproject.toml", file=sys.stderr)
        return 1
    if deps:
        print(f"unexpected runtime dependencies: {deps}", file=sys.stderr)
        print("Adding one needs an argument in the pull request -- see CONTRIBUTING.md",
              file=sys.stderr)
        return 1

    requirements = os.path.join(ROOT, "requirements.txt")
    if os.path.exists(requirements):
        with open(requirements, encoding="utf-8") as fh:
            listed = [line.strip() for line in fh
                      if line.strip() and not line.strip().startswith("#")]
        if listed:
            print(f"unexpected entries in requirements.txt: {listed}", file=sys.stderr)
            return 1

    print("no runtime dependencies, as intended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
