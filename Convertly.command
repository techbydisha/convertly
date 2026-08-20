#!/bin/bash
# Double-click this file in Finder to start Convertly.
cd "$(dirname "$0")" || exit 1
exec python3 run.py "$@"
