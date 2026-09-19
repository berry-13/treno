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
  ['npm', ['run', 'train:platforms']],
  ['npm', ['run', 'backtest']],
];

/** Milliseconds until the next 03:30 Europe/Rome, DST-safe by construction:
 * scan forward in 30-min steps until the Rome wall clock truly reads HH:MM
 * (wall-time arithmetic alone drifts across both DST boundaries). ≤48 probes. */
function msUntilNextRomeRun(hour, minute) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit',
  });
  const readsTarget = (t) => {
    const parts = {};
    for (const p of fmt.formatToParts(new Date(t))) parts[p.type] = p.value;
    return Number(parts.hour) === hour && Number(parts.minute) === minute;
  };
  const now = Date.now();
  const halfHour = 30 * 60_000;
  // snap to the next half-hour boundary (Rome offsets are whole hours, so a
  // UTC half-hour boundary is also a Rome :00/:30) — otherwise the scan's
  // minute-of-hour would never hit the target minute
  let cand = now - (now % halfHour) + halfHour;
  while (!readsTarget(cand)) cand += halfHour;
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
