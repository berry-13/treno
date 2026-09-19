/**
 * Latent vehicle feasibility study (GOAL.md §22, PLAN_next_frontiers F2).
 *   npx tsx packages/collector/src/atm-latent-study.ts
 *
 * Pure analysis, no writes. Measures on recorded atm_stop_observations whether
 * anonymous vehicles can be linked across consecutive stops from the
 * quantized WaitMessages alone:
 *
 *  1. passage events: per (stop, line), an ETA sequence that reaches
 *     "in arrivo"/minimum then vanishes = one vehicle passage;
 *  2. linkability: a passage at stop A links to one at the next stop B on the
 *     same line when inter-stop gap ∈ [plausible runtime window];
 *  3. bunching collisions: two overlapping passages at the same stop+line
 *     with indistinguishable ETAs (< 60 s apart) — identity is ambiguous.
 *
 * GO/NO-GO gate (from the plan): build a tracker only when ≥70% of passages
 * link across ≥3 stops AND collisions <20%. Anything less: stay stop-level,
 * document, revisit when RAPSODIA VehiclePositions lands.
 */
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { getRows, type Db } from '#core/db.ts';
import { decodeWaitMessage } from '#providers/atm.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ObsRow { stop_id: string; fetched_at: number; wait_messages: string }

interface Passage {
  stopId: string;
  line: string;
  passedAt: number; // fetch time of the last frame that still showed the vehicle
}

function extractPassages(rows: ObsRow[]): Passage[] {
  // rows are one stop's frames in time order; per line, track the current
  // ETA and whether it was present in the previous frame
  const passages: Passage[] = [];
  const byStop = new Map<string, ObsRow[]>();
  for (const r of rows) {
    let a = byStop.get(r.stop_id);
    if (!a) byStop.set(r.stop_id, a = []);
    a.push(r);
  }
  for (const [stopId, frames] of byStop) {
    frames.sort((a, b) => a.fetched_at - b.fetched_at);
    const active = new Map<string, { etaSec: number | null; lastSeen: number }>();
    for (const f of frames) {
      let msgs: Array<{ line: string | null; message: string | null }> = [];
      try { msgs = JSON.parse(f.wait_messages) as typeof msgs; } catch { continue; }
      const seen = new Set<string>();
      for (const m of msgs) {
        if (m.line == null) continue;
        seen.add(m.line);
        const d = decodeWaitMessage(m.message);
        active.set(m.line, { etaSec: d.etaSec, lastSeen: f.fetched_at });
      }
      // a line vanishing after having been close = a passage
      for (const [line, st] of [...active.entries()]) {
        if (!seen.has(line)) {
          if (st.etaSec != null && st.etaSec <= 90) {
            passages.push({ stopId, line, passedAt: f.fetched_at });
          }
          active.delete(line);
        }
      }
    }
  }
  return passages;
}

function main() {
  const cfg = loadConfig();
  const db = openTrenoDb(cfg);
  const rows = getRows<ObsRow>(
    db,
    'SELECT stop_id, fetched_at, wait_messages FROM atm_stop_observations ORDER BY fetched_at ASC',
  );
  db.close();
  if (rows.length === 0) {
    const verdict = [
      '# ATM latent-vehicle feasibility study (§22)',
      '',
      '- generated: ' + new Date().toISOString(),
      '- observations: 0 — TRENO_ATM_STOPS is not set (or nothing collected yet)',
      '',
      'Nothing to measure. Re-run after F1 collection has run for ≥2 weeks.',
    ].join('\n');
    writeOut(cfg.dataDir, verdict);
    log.warn('atm-latent-study: no observations');
    return;
  }

  const passages = extractPassages(rows);
  // stop adjacency from the ATM static feed (when loaded): pairs sharing a trip
  const db2 = openTrenoDb(cfg);
  const adj = new Map<string, Set<string>>();
  try {
    for (const r of getRows<{ a: string; b: string }>(
      db2,
      'SELECT s1.stop_id AS a, s2.stop_id AS b FROM atm_stop_times s1 JOIN atm_stop_times s2 ON s2.trip_id = s1.trip_id AND s2.stop_sequence = s1.stop_sequence + 1',
    )) {
      let s = adj.get(r.a);
      if (!s) adj.set(r.a, s = new Set());
      s.add(r.b);
    }
  } catch { /* atm gtfs not loaded */ }
  db2.close();

  // linkability: passage at A links to passage at adjacent B (same line)
  // within [30 s, 20 min]; runtime tolerance is coarse because ETAs are
  // minute-quantized
  let link2 = 0;
  const linkedFrom = new Map<string, number>();
  for (const p of passages) {
    const nexts = adj.get(p.stopId);
    if (!nexts) continue;
    const match = passages.some((q) =>
      q.line === p.line && nexts.has(q.stopId)
      && q.passedAt > p.passedAt && q.passedAt - p.passedAt <= 20 * 60_000);
    if (match) {
      link2++;
      linkedFrom.set(p.stopId, (linkedFrom.get(p.stopId) ?? 0) + 1);
    }
  }
  // ≥3-stop chains: passage whose linked successor itself links onward
  let link3 = 0;
  for (const p of passages) {
    const nexts = adj.get(p.stopId);
    if (!nexts) continue;
    for (const q of passages) {
      if (q.line !== p.line || !nexts.has(q.stopId) || q.passedAt <= p.passedAt || q.passedAt - p.passedAt > 20 * 60_000) continue;
      const nexts2 = adj.get(q.stopId);
      if (nexts2 && passages.some((r) => r.line === q.line && nexts2.has(r.stopId) && r.passedAt > q.passedAt && r.passedAt - q.passedAt <= 20 * 60_000)) {
        link3++;
        break;
      }
    }
  }
  // collisions: two passages same stop+line within 90 s
  let collisions = 0;
  const sorted = [...passages].sort((a, b) => (a.stopId + a.line < b.stopId + b.line ? -1 : 1) || a.passedAt - b.passedAt);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!, b = sorted[i]!;
    if (a.stopId === b.stopId && a.line === b.line && b.passedAt - a.passedAt < 90_000) collisions++;
  }

  const n = passages.length || 1;
  const link2Pct = Math.round((link2 / n) * 1000) / 10;
  const link3Pct = Math.round((link3 / n) * 1000) / 10;
  const collPct = Math.round((collisions / n) * 1000) / 10;
  const go = link3Pct >= 70 && collPct < 20;
  const verdict = [
    '# ATM latent-vehicle feasibility study (§22)',
    '',
    '- generated: ' + new Date().toISOString(),
    '- observation frames: ' + rows.length,
    '- reconstructed passages: ' + passages.length,
    '- adjacent-stop linkable: ' + link2 + ' (' + link2Pct + '%)',
    '- ≥3-stop chains: ' + link3 + ' (' + link3Pct + '%)',
    '- bunching collisions: ' + collisions + ' (' + collPct + '%)',
    '- stop adjacency known for: ' + adj.size + ' stops (ATM static feed ' + (adj.size > 0 ? 'loaded' : 'NOT loaded') + ')',
    '',
    go
      ? 'GATE GO: identity reconstruction is feasible — proceed to the tracker (F2 step 3).'
      : 'GATE NO-GO (needs ≥70% ≥3-stop chains and <20% collisions): stay stop-level, revisit when RAPSODIA VehiclePositions lands.',
  ].join('\n');
  writeOut(cfg.dataDir, verdict);
  console.log('\n' + verdict);
}

function writeOut(dataDir: string, text: string): void {
  mkdirSync(join(dataDir, 'reports'), { recursive: true });
  writeFileSync(join(dataDir, 'reports', 'atm-latent-study-' + new Date().toISOString().slice(0, 10) + '.md'), text + '\n');
}

if (process.argv[1] && process.argv[1].endsWith('atm-latent-study.ts')) {
  main();
}
