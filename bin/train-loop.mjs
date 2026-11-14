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

/** Run every step even if an earlier one fails (a broken ETA retrain must
 * not also freeze the connection/platform models and the backtest). Returns
 * the names of the failed steps. */
function pipeline() {
  const failed = [];
  for (const [cmd, args] of STEPS) {
    const name = `${cmd} ${args.join(' ')}`;
    console.log(`[train-loop] ${name}`);
    try {
      execFileSync(cmd, args, { stdio: 'inherit' });
    } catch (e) {
      failed.push(name);
      console.error(`[train-loop] step failed: ${name}: ${e.message}`);
    }
  }
  return failed;
}

/** Optional heartbeat (e.g. an Uptime Kuma push URL) hit only when every
 * step succeeded, so a trainer that silently stops training gets noticed. */
async function heartbeat(failed) {
  const url = process.env.TRENO_TRAIN_PUSH_URL;
  if (!url) return;
  const u = new URL(url);
  u.searchParams.set('status', failed.length === 0 ? 'up' : 'down');
  u.searchParams.set('msg', failed.length === 0 ? 'OK' : `failed: ${failed.join(', ')}`);
  try {
    await fetch(u, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    console.error(`[train-loop] heartbeat failed: ${e.message}`);
  }
}

while (true) {
  const failed = pipeline();
  await heartbeat(failed);
  const waitMs = msUntilNextRomeRun(3, 30);
  console.log(`[train-loop] ${failed.length ? `${failed.length} step(s) failed; next run` : 'next run'} 03:30 Europe/Rome (in ${Math.round(waitMs / 60000)} min)`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
}
