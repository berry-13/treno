#!/bin/zsh
# Start the treno collector + API in the background.
set -e
cd "$(dirname "$0")/.."
mkdir -p data/logs
nohup npx tsx packages/collector/src/index.ts >> data/logs/collector.out 2>&1 &
echo "collector $!" > data/run.pids
nohup npx tsx packages/api/src/server.ts >> data/logs/api.out 2>&1 &
echo "api $!" >> data/run.pids
echo "started:"; cat data/run.pids
