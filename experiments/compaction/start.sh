#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -x /Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13 ]; then
  exec /Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13 compaction_visualizer.py
fi
exec python3 compaction_visualizer.py
