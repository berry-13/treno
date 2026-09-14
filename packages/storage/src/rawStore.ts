/**
 * Raw snapshot store (GOAL.md §28-29, §44): every upstream response is indexed
 * per fetch; the payload bytes are written to partitioned zstd-compressed
 * files only when they change, so history can be reprocessed without
 * re-fetching and unchanged polls don't burn disk.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { getRow, runStmt, type Db } from '#core/db.ts';
import { ch } from './clickhouse.ts';

export interface PutSnapshotArgs {
  source: string;
  entityKey: string;
  fetchedAt: number; // epoch ms
  httpStatus: number;
  etag: string | null;
  lastModified: string | null;
  payloadJson: string;
  relevantHash: string | null;
  parserVersion: string;
  error?: string | null;
}

export interface SnapshotInfo {
  id: number;
  payloadHash: string;
  relevantHash: string | null;
  changed: boolean;
  bytes: number | null;
  path: string | null;
}

interface PrevSnapshot { id: number; payload_hash: string; path: string | null }

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function partitionPath(dataDir: string, source: string, fetchedAt: number, entityKey: string): string {
  const iso = new Date(fetchedAt).toISOString();
  const p = join(dataDir, 'raw', source, iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10));
  mkdirSync(p, { recursive: true });
  return join(p, safeName(entityKey) + '_' + String(fetchedAt) + '.json.zst');
}

function relPath(dataDir: string, abs: string): string {
  return abs.slice(dataDir.length + 1);
}

export function putSnapshot(db: Db, dataDir: string, args: PutSnapshotArgs): SnapshotInfo {
  const payloadHash = createHash('sha256').update(args.payloadJson).digest('hex');
  const prev = getRow<PrevSnapshot>(
    db,
    'SELECT id, payload_hash, path FROM source_snapshots WHERE source=? AND entity_key=? ORDER BY fetched_at DESC, id DESC LIMIT 1',
    [args.source, args.entityKey],
  );
  const changed = !prev || prev.payload_hash !== payloadHash;
  let absPath: string | null = null;
  let bytes: number | null = null;
  if (changed && args.payloadJson.length > 0) {
    absPath = partitionPath(dataDir, args.source, args.fetchedAt, args.entityKey);
    const compressed = zstdCompressSync(Buffer.from(args.payloadJson, 'utf8'));
    writeFileSync(absPath, compressed);
    bytes = compressed.length;
  }
  const rel = absPath ? relPath(dataDir, absPath) : null;
  const result = db.prepare(
    'INSERT INTO source_snapshots(source, entity_key, fetched_at, http_status, etag, last_modified, payload_hash, relevant_hash, changed, codec, bytes, path, parser_version, error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    args.source, args.entityKey, args.fetchedAt, args.httpStatus, args.etag, args.lastModified,
    payloadHash, args.relevantHash, changed ? 1 : 0, 'zstd', bytes, rel, args.parserVersion, args.error ?? null,
  );
  const id = Number(result.lastInsertRowid);
  ch.queue('source_snapshots', {
    fetched_at: new Date(args.fetchedAt), source: args.source, entity_key: args.entityKey,
    http_status: args.httpStatus, etag: args.etag, last_modified: args.lastModified,
    payload_hash: payloadHash, relevant_hash: args.relevantHash, changed: changed ? 1 : 0,
    codec: 'zstd', bytes, path: rel, parser_version: args.parserVersion, error: args.error ?? null,
  });
  return { id, payloadHash, relevantHash: args.relevantHash, changed, bytes, path: rel };
}

/** Read back a stored raw payload (for offline reprocessing). */
export function readSnapshotJson(dataDir: string, rel: string): string {
  const buf = readFileSync(join(dataDir, rel));
  return Buffer.from(zstdDecompressSync(buf)).toString('utf8');
}
