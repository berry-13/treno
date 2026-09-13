#!/bin/zsh
# Stop the background collector + API started by bin/start.sh.
cd "$(dirname "$0")/.."
if [ -f data/run.pids ]; then
  while read -r name pid; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "stopped $name ($pid)"
    else
      echo "$name ($pid) not running"
    fi
  done < data/run.pids
  rm data/run.pids
else
  echo "no data/run.pids — nothing to stop"
fi
