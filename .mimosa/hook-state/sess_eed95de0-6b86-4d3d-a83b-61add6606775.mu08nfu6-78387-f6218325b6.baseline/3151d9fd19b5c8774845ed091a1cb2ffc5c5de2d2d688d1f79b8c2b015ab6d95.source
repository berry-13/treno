#!/bin/zsh
# Stop the background collector + API started by bin/start.sh.
# Kills by pid file AND by command pattern (npx wrappers spawn node children
# that survive a plain kill of the wrapper pid).
cd "$(dirname "$0")/.."
if [ -f data/run.pids ]; then
  while read -r name pid; do
    kill "$pid" 2>/dev/null && echo "signaled $name ($pid)" || echo "$name ($pid) not running"
  done < data/run.pids
  rm -f data/run.pids
fi
pkill -f "tsx packages/collector/src/index.ts" 2>/dev/null && echo "collector tree stopped"
pkill -f "tsx packages/api/src/server.ts" 2>/dev/null && echo "api tree stopped"
exit 0
