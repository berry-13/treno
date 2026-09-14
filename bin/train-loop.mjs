#!/usr/bin/env node
/**
 * Cron-style trainer for containers (PLAN_docker_clickhouse.md §1): runs the
 * full nightly pipeline — retrain ETA model, retrain connection model,
 * backtest report — then sleeps until 03:30 Europe/Rome and repeats. Mirrors
 * the local launchd job in bin/com.treno.train.plist.
 */
import { execFileSync } from 'node:child_process';

const STEPS = [
  ['npm', ['run', 'train']],
  ['npm', ['run', 'train:connections']],
  ['npm', ['run', 'backtest']],
];

/** Milliseconds until the next 03:30 Europe/Rome, DST-safe via Intl probing. */
function msUntilNextRomeRun(hour, minute) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', hourCycle: 'h23', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const partsOf = (t) => {
    const parts = {};
    for (const p of fmt.formatToParts(new Date(t))) parts[p.type] = p.value;
    return parts;
  };
  const now = Date.now();
  const p = partsOf(now);
  let cand = now + ((hour - Number(p.hour)) * 60 + (minute - Number(p.minute))) * 60_000;
  // refine twice so wall-clock offsets (incl. DST jumps) converge; if the
  // candidate slipped into the past, roll a day forward
  for (let i = 0; i < 2; i++) {
    const q = partsOf(cand);
    cand += ((hour - Number(q.hour)) * 60 + (minute - Number(q.minute))) * 60_000;
  }
  while (cand <= now) cand += 24 * 3600_000;
  return cand - now;
}

function pipeline() {
  for (const [cmd, args] of STEPS) {
    console.log(`[train-loop] ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { stdio: 'inherit' });
  }
}

while (true) {
  let failed = false;
  try {
    pipeline();
  } catch (e) {
    failed = true;
    console.error(`[train-loop] pipeline step failed: ${e.message}`);
  }
  const waitMs = msUntilNextRomeRun(3, 30);
  console.log(`[train-loop] ${failed ? 'pipeline failed; will retry at' : 'next run'} 03:30 Europe/Rome (in ${Math.round(waitMs / 60000)} min)`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
}
