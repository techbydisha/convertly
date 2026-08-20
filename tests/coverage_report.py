#!/usr/bin/env python3
"""Statement coverage for src/convertly, using only the standard library.

    python3 tests/coverage_report.py            # report
    python3 tests/coverage_report.py --min 85   # report and fail below a floor

Uses the stdlib `trace` module so the project keeps its no-dependency promise.
Run from the repository root.
"""

import argparse
import io
import os
import sys
import threading
import trace
import unittest
from contextlib import redirect_stderr, redirect_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
PACKAGE = os.path.join(SRC, "convertly")

# The entry-point shims exist to be executed by a person, not by tests.
EXCLUDE = {"__main__.py", "__init__.py"}


def executable_lines(path):
    """Line numbers that could be executed in this file."""
    try:
        return {n for n in trace._find_executable_linenos(path) if n}
    except Exception:                                  # pragma: no cover
        with open(path, encoding="utf-8") as fh:
            code = compile(fh.read(), path, "exec")
        found = set()
        stack = [code]
        while stack:
            obj = stack.pop()
            found.update(line for *_, line in obj.co_lines() if line)
            stack.extend(c for c in obj.co_consts if hasattr(c, "co_lines"))
        return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--min", type=float, default=None,
                        help="fail if total coverage is below this percentage")
    args = parser.parse_args()

    sys.path.insert(0, SRC)
    sys.path.insert(0, ROOT)

    # No ignoredirs: the stdlib trace module caches ignore decisions by bare
    # module name, so ignoring the standard library would also skip our
    # server.py (it collides with http/server.py). Results are filtered by path
    # when the report is built instead.
    tracer = trace.Trace(count=1, trace=0)

    def discover_and_run():
        # Discovery happens inside the traced region so that import-time code
        # in the package is measured too.
        suite = unittest.defaultTestLoader.discover(
            os.path.join(ROOT, "tests"), top_level_dir=ROOT)
        return unittest.TextTestRunner(verbosity=0, stream=io.StringIO()).run(suite)

    result_holder = {}
    buffer = io.StringIO()
    # runfunc only traces the calling thread; the server under test answers on
    # worker threads, so those need arming separately.
    threading.settrace(tracer.globaltrace)
    try:
        with redirect_stdout(buffer), redirect_stderr(buffer):
            tracer.runfunc(lambda: result_holder.setdefault("r", discover_and_run()))
    finally:
        threading.settrace(None)
    result = result_holder["r"]

    counts = tracer.results().counts
    covered = {}
    for (filename, lineno), hits in counts.items():
        if hits:
            covered.setdefault(os.path.abspath(filename), set()).add(lineno)

    print(f"tests: {result.testsRun} run, {len(result.failures)} failed, "
          f"{len(result.errors)} errored, {len(result.skipped)} skipped\n")
    print(f"{'module':<24}{'stmts':>8}{'miss':>8}{'cover':>8}")
    print("-" * 48)

    total_stmts = total_hit = 0
    worst = []
    for name in sorted(os.listdir(PACKAGE)):
        if not name.endswith(".py") or name in EXCLUDE:
            continue
        path = os.path.join(PACKAGE, name)
        stmts = executable_lines(path)
        hit = stmts & covered.get(path, set())
        total_stmts += len(stmts)
        total_hit += len(hit)
        pct = 100.0 * len(hit) / len(stmts) if stmts else 100.0
        print(f"{name:<24}{len(stmts):>8}{len(stmts) - len(hit):>8}{pct:>7.1f}%")
        missed = sorted(stmts - hit)
        if missed:
            worst.append((name, missed))

    total_pct = 100.0 * total_hit / total_stmts if total_stmts else 100.0
    print("-" * 48)
    print(f"{'TOTAL':<24}{total_stmts:>8}{total_stmts - total_hit:>8}{total_pct:>7.1f}%")

    if os.environ.get("SHOW_MISSING"):
        print()
        for name, missed in worst:
            print(f"{name} missing lines: "
                  + ", ".join(str(n) for n in missed[:40])
                  + (" …" if len(missed) > 40 else ""))

    ok = result.wasSuccessful()
    if not ok:
        print("\nTESTS FAILED", file=sys.stderr)
    if args.min is not None and total_pct < args.min:
        print(f"\nCoverage {total_pct:.1f}% is below the required {args.min:.1f}%",
              file=sys.stderr)
        ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
