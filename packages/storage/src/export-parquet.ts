/**
 * Training data export — GOAL §71.
 *
 *   npm run export:parquet [-- --limit 1000 --date 2026-09-13 --by-line --out DIR --source sqlite]
 *
 * Exports point-in-time training sets as Parquet, one row per scored
 * prediction (predictions ⋈ prediction_outcomes ⋈ train_runs), with
 * features_json unpacked into typed columns and run/stop context
 * (train number, line, service_date, stop_id, horizon bucket).
 *
 * Layout: data/exports/parquet/service_date=YYYY-MM-DD/part-NNNN.parquet
 * (+ a line=… subdirectory level with --by-line).
 *
 * Two paths, in preference order:
 *   (a) TRENO_CLICKHOUSE_URL set (and --source not forcing sqlite): stream
 *       `SELECT … FORMAT Parquet` server-side through @clickhouse/client
 *       (`exec` gives the raw response stream) — ClickHouse writes real,
 *       full-featured Parquet per partition.
 *   (b) Local fallback: a minimal pure-TS Parquet writer over SQLite, zero
 *       dependencies beyond the existing fflate (gzip). Documented limits:
 *         - FIXED flat schema (this file's EXPORT_COLUMNS), all columns
 *           OPTIONAL, Data Page v1, PLAIN encoding only, RLE (run-only)
 *           definition levels at bit width 1, one row group per file,
 *           gzip codec, page size capped at 32k values (several pages per
 *           column chunk), no dictionary, no statistics, no nested types.
 *         - Self-check after every file: re-parses the footer, re-decodes
 *           every page of every column and compares against the rows that
 *           were written (see verifyParquetFile).
 *
 * No new tables/columns are introduced, so deploy/clickhouse-init/01_tables.sql
 * is untouched. Analysis: DuckDB/Polars — e.g.
 *   SELECT horizon_bucket, count(*), avg(abs(our_error_sec)) FROM
 *     read_parquet('data/exports/parquet' || '/**' + '/*.parquet', hive_partitioning=true)
 */
import { mkdirSync, writeFileSync, readFileSync, statSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { gzipSync, gunzipSync } from 'fflate';
import { loadConfig } from '#core/config.ts';
import { openDb, type Db } from '#core/db.ts';

// ---------------------------------------------------------------------------
// Export schema — the fixed column list shared by both paths (order matters).
// ---------------------------------------------------------------------------

type ColType = 'int32' | 'int64' | 'double' | 'string';

interface ColDef {
  name: string;
  type: ColType;
}

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

/** Physical Parquet types (parquet.Type enum). */
const PHYSICAL_TYPE: Record<ColType, number> = { int32: 1, int64: 2, double: 5, string: 6 };

/** horizon bucket labels, computed at export time. */
function horizonBucket(sec: number): string {
  if (sec <= 300) return '0-5m';
  if (sec <= 900) return '5-15m';
  if (sec <= 1800) return '15-30m';
  if (sec <= 3600) return '30-60m';
  return '60m+';
}

const EXPORT_COLUMNS: ColDef[] = [
  { name: 'service_date', type: 'string' }, // partition key (train_runs)
  { name: 'train_number', type: 'string' },
  { name: 'operator', type: 'string' },
  { name: 'line', type: 'string' }, // train_runs.route_id
  { name: 'run_id', type: 'int64' },
  { name: 'prediction_id', type: 'int64' },
  { name: 'stop_id', type: 'string' },
  { name: 'model_version', type: 'string' },
  { name: 'generated_at', type: 'int64' }, // epoch ms
  { name: 'horizon_sec', type: 'int32' },
  { name: 'horizon_bucket', type: 'string' },
  { name: 'sched_arr_epoch', type: 'int64' },
  { name: 'operator_eta_epoch', type: 'int64' },
  { name: 'our_p10', type: 'int64' },
  { name: 'our_p50', type: 'int64' },
  { name: 'our_p90', type: 'int64' },
  { name: 'confidence', type: 'double' },
  { name: 'actual_arr_epoch', type: 'int64' }, // prediction_outcomes
  { name: 'operator_error_sec', type: 'int32' },
  { name: 'our_error_sec', type: 'int32' },
  // features_json unpacked (FeatureInput in packages/collector/src/model.ts;
  // camelCase JSON keys → snake columns; optional keys absent in older rows → null)
  { name: 'f_anchor_kind', type: 'string' },
  { name: 'f_anchor_epoch', type: 'int64' },
  { name: 'f_remaining_segments', type: 'int32' },
  { name: 'f_stats_coverage', type: 'double' },
  { name: 'f_corridor_adjust_sec', type: 'int32' },
  { name: 'f_operator_weight', type: 'double' },
  { name: 'f_independent_p50', type: 'int64' },
  { name: 'f_origin_dep_delay_sec', type: 'int32' },
  { name: 'f_train_history_delay_sec', type: 'int32' },
  { name: 'f_network_delay_sec', type: 'int32' },
  { name: 'f_operator_eta_drift_sec', type: 'int32' },
  { name: 'f_alerts_run_24h', type: 'int32' },
  { name: 'f_alerts_route_24h', type: 'int32' },
  { name: 'f_precip_mm', type: 'double' },
  { name: 'f_strike_active', type: 'int32' },
  { name: 'f_event_hours_to_start', type: 'double' },
  { name: 'f_holiday', type: 'int32' },
  { name: 'f_upstream_stop_max_delay_sec', type: 'int32' },
  { name: 'f_upstream_stop_delayed_count', type: 'int32' },
  { name: 'f_route_enc_sec', type: 'double' },
  { name: 'f_eta_accel_sec', type: 'double' },
];

type Cell = number | string | null;

/** SQLite source row (raw column names from the SELECT below). */
interface SrcRow {
  service_date: string; train_number: string; operator: string; line: string | null;
  run_id: number; prediction_id: number; stop_id: string; model_version: string;
  generated_at: number; sched_arr_epoch: number | null; operator_eta_epoch: number | null;
  our_p10: number | null; our_p50: number | null; our_p90: number | null;
  confidence: number | null; actual_arr_epoch: number | null;
  operator_error_sec: number | null; our_error_sec: number | null;
  features_json: string;
}

/** Inline literal at its prepare() site (SQL-authoring rule, packages/core/src/db.ts). */
const SQLITE_SQL = `
  SELECT r.service_date AS service_date, r.train_number AS train_number, r.operator AS operator,
         r.route_id AS line, p.run_id AS run_id, p.id AS prediction_id, p.stop_id AS stop_id,
         p.model_version AS model_version, p.generated_at AS generated_at,
         p.sched_arr_epoch AS sched_arr_epoch, p.operator_eta_epoch AS operator_eta_epoch,
         p.our_p10 AS our_p10, p.our_p50 AS our_p50, p.our_p90 AS our_p90, p.confidence AS confidence,
         o.actual_arr_epoch AS actual_arr_epoch, o.operator_error_sec AS operator_error_sec,
         o.our_error_sec AS our_error_sec, p.features_json AS features_json
  FROM predictions p
  JOIN prediction_outcomes o ON o.prediction_id = p.id
  JOIN train_runs r ON r.id = p.run_id
  WHERE p.features_json IS NOT NULL AND p.sched_arr_epoch IS NOT NULL`;

/** features_json key → cell, tolerant of absent / null / wrong-typed keys. */
function featNum(f: Record<string, unknown>, key: string): number | null {
  const v = f[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function featStr(f: Record<string, unknown>, key: string): string | null {
  const v = f[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Integer-typed feature (a few features_json blobs carry fractional epochs). */
function featInt(f: Record<string, unknown>, key: string): number | null {
  const v = featNum(f, key);
  return v == null ? null : Math.round(v);
}

function srcRowToCells(r: SrcRow): Cell[] {
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(r.features_json) as Record<string, unknown>;
  } catch {
    f = {};
  }
  // a few epoch columns hold fractional ms in older rows — int columns must be exact ints
  const toInt = (v: number | null): number | null => (v == null ? null : Math.round(v));
  const horizonSec = Math.floor((toInt(r.sched_arr_epoch)! - toInt(r.generated_at)!) / 1000);
  return [
    r.service_date, r.train_number, r.operator, r.line,
    toInt(r.run_id), toInt(r.prediction_id), r.stop_id, r.model_version,
    toInt(r.generated_at), horizonSec, horizonBucket(horizonSec),
    toInt(r.sched_arr_epoch), toInt(r.operator_eta_epoch), toInt(r.our_p10), toInt(r.our_p50), toInt(r.our_p90), r.confidence,
    toInt(r.actual_arr_epoch), toInt(r.operator_error_sec), toInt(r.our_error_sec),
    featStr(f, 'anchorKind'),
    featInt(f, 'anchorEpoch'),
    featInt(f, 'remainingSegments') ?? 0,
    featNum(f, 'statsCoverage') ?? 0,
    featInt(f, 'corridorAdjustSec') ?? 0,
    featNum(f, 'operatorWeight') ?? 0,
    featInt(f, 'independentP50'),
    featInt(f, 'originDepDelaySec'),
    featInt(f, 'trainHistoryDelaySec'),
    featInt(f, 'networkDelaySec'),
    featInt(f, 'operatorEtaDriftSec'),
    featInt(f, 'alertsRun24h'),
    featInt(f, 'alertsRoute24h'),
    featNum(f, 'precipMm'),
    featInt(f, 'strikeActive'),
    featNum(f, 'eventHoursToStart'),
    featInt(f, 'holiday'),
    featInt(f, 'upstreamStopMaxDelaySec'),
    featInt(f, 'upstreamStopDelayedCount'),
    featNum(f, 'routeEncSec'),
    featNum(f, 'etaAccelSec'),
  ];
}

// ---------------------------------------------------------------------------
// Minimal byte buffer + Thrift Compact writer (metadata only — no bools/doubles
// are ever written, which keeps the encoder small).
// ---------------------------------------------------------------------------

class ByteBuf {
  private chunks: Uint8Array[] = [];
  length = 0;

  u8(b: number): void {
    this.chunks.push(new Uint8Array([b & 0xff]));
    this.length += 1;
  }

  bytes(b: Uint8Array): void {
    if (b.length > 0) {
      this.chunks.push(b);
      this.length += b.length;
    }
  }

  private fixed(n: number, set: (dv: DataView) => void): void {
    const t = new Uint8Array(n);
    set(new DataView(t.buffer, t.byteOffset, t.byteLength));
    this.bytes(t);
  }

  u32le(v: number): void { this.fixed(4, (dv) => dv.setUint32(0, v >>> 0, true)); }
  i32le(v: number): void { this.fixed(4, (dv) => dv.setInt32(0, v | 0, true)); }
  i64le(v: bigint): void { this.fixed(8, (dv) => dv.setBigInt64(0, v, true)); }
  f64le(v: number): void { this.fixed(8, (dv) => dv.setFloat64(0, v, true)); }

  varint(x: bigint): void {
    let v = x;
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) b |= 0x80;
      this.u8(b);
    } while (v !== 0n);
  }

  toUint8(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

// Thrift Compact protocol type ids used below.
const T_I32 = 0x05, T_I64 = 0x06, T_BINARY = 0x08, T_LIST = 0x09, T_STRUCT = 0x0c;
const T_BYTE = 0x03, T_I16 = 0x04, T_DOUBLE = 0x07, T_SET = 0x0a, T_MAP = 0x0b;
const T_TRUE = 0x01, T_FALSE = 0x02;

function zigzag32(v: number): bigint {
  return BigInt(((v << 1) ^ (v >> 31)) >>> 0);
}

function zigzag64(v: bigint): bigint {
  return (v << 1n) ^ (v >> 63n);
}

class TCompactWriter {
  buf = new ByteBuf();
  private lastField = 0;
  private fieldStack: number[] = [];

  fieldHeader(id: number, type: number): void {
    const delta = id - this.lastField;
    if (delta > 0 && delta <= 15) this.buf.u8((delta << 4) | type);
    else {
      this.buf.u8(type); // long form: zero delta nibble, then zigzag varint id
      this.buf.varint(zigzag64(BigInt(id)));
    }
    this.lastField = id;
  }

  i32Field(id: number, v: number): void { this.fieldHeader(id, T_I32); this.buf.varint(zigzag32(v)); }
  i64Field(id: number, v: bigint): void { this.fieldHeader(id, T_I64); this.buf.varint(zigzag64(v)); }
  binaryField(id: number, s: string): void {
    this.fieldHeader(id, T_BINARY);
    const b = TEXT_ENC.encode(s);
    this.buf.varint(BigInt(b.length));
    this.buf.bytes(b);
  }

  i32ListField(id: number, xs: number[]): void {
    this.fieldHeader(id, T_LIST);
    this.listHeader(T_I32, xs.length);
    for (const x of xs) this.buf.varint(zigzag32(x));
  }

  stringListField(id: number, xs: string[]): void {
    this.fieldHeader(id, T_LIST);
    this.listHeader(T_BINARY, xs.length);
    for (const s of xs) {
      const b = TEXT_ENC.encode(s);
      this.buf.varint(BigInt(b.length));
      this.buf.bytes(b);
    }
  }

  listHeader(elemType: number, size: number): void {
    if (size <= 14) this.buf.u8((size << 4) | elemType);
    else {
      this.buf.u8(0xf0 | elemType);
      this.buf.varint(BigInt(size));
    }
  }

  /** Open a struct-typed field (or a struct list element — call beginElement). */
  structField(id: number): void {
    this.fieldHeader(id, T_STRUCT);
    this.fieldStack.push(this.lastField);
    this.lastField = 0;
  }

  /** A struct appearing as a list element: contents are written directly. */
  beginElement(): void {
    this.fieldStack.push(this.lastField);
    this.lastField = 0;
  }

  endStruct(): void {
    this.buf.u8(0x00); // STOP
    this.lastField = this.fieldStack.pop() ?? 0;
  }

  toUint8(): Uint8Array { return this.buf.toUint8(); }
}

// ---------------------------------------------------------------------------
// Pure-TS Parquet writer (limits documented in the file header).
// ---------------------------------------------------------------------------

const PAR1 = new Uint8Array([0x50, 0x41, 0x52, 0x31]); // "PAR1"
const CREATED_BY = 'treno export-parquet pure-ts writer 1.0 (PLAIN + gzip, data page v1)';
const PAGE_VALUES = 32_768; // max values per data page
// Parquet enums used: Type {INT32:1,INT64:2,DOUBLE:5,BYTE_ARRAY:6};
// FieldRepetitionType {OPTIONAL:1}; Encoding {PLAIN:0,RLE:3};
// CompressionCodec {GZIP:2}; ConvertedType {UTF8:0}; PageType {DATA_PAGE:0}.

interface ChunkMeta {
  name: string;
  type: ColType;
  numValues: number;
  totalUncompressed: number;
  totalCompressed: number;
  dataPageOffset: number;
}

/** RLE/bit-packed-hybrid, RLE runs only, bit width 1 (OPTIONAL flat column). */
function rleDefLevels(present: boolean[]): Uint8Array {
  const out = new ByteBuf();
  let i = 0;
  while (i < present.length) {
    const v = present[i]!;
    let j = i + 1;
    while (j < present.length && present[j] === v) j++;
    out.varint(BigInt((j - i) << 1)); // RLE run header: length << 1, LSB 0
    out.u8(v ? 1 : 0);
    i = j;
  }
  return out.toUint8();
}

function plainEncode(type: ColType, values: Cell[]): Uint8Array {
  const nonNull = values.filter((v) => v != null);
  if (type === 'string') {
    const enc = nonNull.map((v) => TEXT_ENC.encode(v as string));
    const total = enc.reduce((s, b) => s + 4 + b.length, 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let o = 0;
    for (const b of enc) {
      dv.setUint32(o, b.length, true);
      out.set(b, o + 4);
      o += 4 + b.length;
    }
    return out;
  }
  const width = type === 'int32' ? 4 : 8;
  const out = new Uint8Array(width * nonNull.length);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  nonNull.forEach((v, i) => {
    const o = i * width;
    if (type === 'int32') dv.setInt32(o, v as number, true);
    else if (type === 'int64') dv.setBigInt64(o, BigInt(v as number), true);
    else dv.setFloat64(o, v as number, true);
  });
  return out;
}

function pageHeader(numValues: number, uncompLen: number, compLen: number): Uint8Array {
  const w = new TCompactWriter();
  w.i32Field(1, 0); // PageHeader.type = DATA_PAGE
  w.i32Field(2, uncompLen);
  w.i32Field(3, compLen);
  w.structField(5); // data_page_header
  w.i32Field(1, numValues);
  w.i32Field(2, 0); // encoding = PLAIN
  w.i32Field(3, 3); // definition_level_encoding = RLE
  w.i32Field(4, 3); // repetition_level_encoding = RLE
  w.endStruct(); // data_page_header (its own STOP byte)
  w.endStruct(); // PageHeader STOP
  return w.toUint8();
}

function fileMetadata(numRows: number, cols: ColDef[], chunks: ChunkMeta[], createdBy: string): Uint8Array {
  const w = new TCompactWriter();
  w.i32Field(1, 1); // version
  // field 2: schema (list<SchemaElement>), root first
  w.fieldHeader(2, T_LIST);
  w.listHeader(T_STRUCT, cols.length + 1);
  w.beginElement();
  w.binaryField(4, 'schema');
  w.i32Field(5, cols.length); // num_children
  w.endStruct(); // root SchemaElement
  for (const c of cols) {
    w.beginElement();
    w.i32Field(1, PHYSICAL_TYPE[c.type]); // type
    w.i32Field(3, 1); // repetition_type = OPTIONAL
    w.binaryField(4, c.name);
    if (c.type === 'string') w.i32Field(6, 0); // converted_type = UTF8
    w.endStruct();
  }
  w.i64Field(3, BigInt(numRows));
  // field 4: row_groups (exactly one)
  w.fieldHeader(4, T_LIST);
  w.listHeader(T_STRUCT, 1);
  w.beginElement(); // RowGroup
  w.fieldHeader(1, T_LIST); // columns
  w.listHeader(T_STRUCT, chunks.length);
  for (const ch of chunks) {
    w.beginElement(); // ColumnChunk
    w.i64Field(2, BigInt(ch.dataPageOffset)); // file_offset
    w.structField(3); // meta_data
    w.i32Field(1, PHYSICAL_TYPE[ch.type]);
    w.i32ListField(2, [0, 3]); // encodings = [PLAIN, RLE]
    w.stringListField(3, [ch.name]); // path_in_schema
    w.i32Field(4, 2); // codec = GZIP
    w.i64Field(5, BigInt(ch.numValues));
    w.i64Field(6, BigInt(ch.totalUncompressed));
    w.i64Field(7, BigInt(ch.totalCompressed));
    w.i64Field(9, BigInt(ch.dataPageOffset));
    w.endStruct(); // meta_data
    w.endStruct(); // ColumnChunk
  }
  w.i64Field(2, BigInt(chunks.reduce((s, c) => s + c.totalUncompressed, 0))); // total_byte_size
  w.i64Field(3, BigInt(numRows));
  w.endStruct(); // RowGroup
  w.binaryField(6, createdBy);
  w.endStruct(); // FileMetaData
  return w.toUint8();
}

/** Writes one Parquet file: single row group, gzip pages. Throws on empty input. */
function writeParquetFile(path: string, cols: ColDef[], data: Cell[][], numRows: number): void {
  if (numRows === 0) throw new Error(`refusing to write empty parquet file: ${path}`);
  const parts: Uint8Array[] = [PAR1];
  let offset = 4;
  const chunks: ChunkMeta[] = [];
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c]!;
    const values = data[c]!;
    const dataPageOffset = offset;
    let unc = 0, comp = 0;
    for (let start = 0; start < numRows; start += PAGE_VALUES) {
      const end = Math.min(start + PAGE_VALUES, numRows);
      const slice = values.slice(start, end);
      const defLevels = rleDefLevels(slice.map((v) => v != null));
      const vals = plainEncode(col.type, slice);
      // data page v1 body: u32le length of the RLE level data, then levels, then values
      const body = new Uint8Array(4 + defLevels.length + vals.length);
      new DataView(body.buffer).setUint32(0, defLevels.length, true);
      body.set(defLevels, 4);
      body.set(vals, 4 + defLevels.length);
      const gz = gzipSync(body, { level: 6, mtime: 0 });
      const hdr = pageHeader(end - start, body.length, gz.length);
      parts.push(hdr, gz);
      offset += hdr.length + gz.length;
      unc += hdr.length + body.length;
      comp += hdr.length + gz.length;
    }
    chunks.push({ name: col.name, type: col.type, numValues: numRows, totalUncompressed: unc, totalCompressed: comp, dataPageOffset });
  }
  const meta = fileMetadata(numRows, cols, chunks, CREATED_BY);
  parts.push(meta);
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setUint32(0, meta.length, true);
  parts.push(lenBuf, PAR1);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const file = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    file.set(p, o);
    o += p.length;
  }
  writeFileSync(path, file);
}

// ---------------------------------------------------------------------------
// Thrift Compact reader + Parquet footer/page decoder (self-check).
// ---------------------------------------------------------------------------

class TCompactReader {
  pos: number;
  private lastField = 0;
  private fieldStack: number[] = [];

  constructor(private buf: Uint8Array, pos: number) { this.pos = pos; }

  u8(): number { return this.buf[this.pos++]!; }

  varint(): bigint {
    let r = 0n, shift = 0n;
    for (;;) {
      const b = this.u8();
      r |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return r;
      shift += 7n;
    }
  }

  zigzag(): bigint {
    const u = this.varint();
    return (u >> 1n) ^ -(u & 1n);
  }

  i32(): number { return Number(this.zigzag()); }
  i64(): bigint { return this.zigzag(); }

  binary(): string {
    const n = Number(this.varint());
    const s = TEXT_DEC.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  /** Next field, or null at struct STOP. */
  field(): { id: number; type: number } | null {
    const b = this.u8();
    if (b === 0x00) return null;
    const type = b & 0x0f;
    const delta = (b & 0xf0) >> 4;
    const id = delta === 0 ? Number(this.zigzag()) : this.lastField + delta;
    this.lastField = id;
    return { id, type };
  }

  listHeader(): { elemType: number; size: number } {
    const b = this.u8();
    let size = b >> 4;
    if (size === 15) size = Number(this.varint());
    return { elemType: b & 0x0f, size };
  }

  beginStruct(): void { this.fieldStack.push(this.lastField); this.lastField = 0; }
  endStruct(): void { this.lastField = this.fieldStack.pop() ?? 0; }

  skip(type: number): void {
    if (type === T_TRUE || type === T_FALSE) return; // encoded in the field id byte
    if (type === T_BYTE) { this.pos += 1; return; }
    if (type === T_I16 || type === T_I32 || type === T_I64) { this.varint(); return; }
    if (type === T_DOUBLE) { this.pos += 8; return; }
    // NB: keep as two statements — `this.pos += Number(this.varint())` would
    // read this.pos *before* varint() advances it (compound-assignment order).
    if (type === T_BINARY) {
      const n = Number(this.varint());
      this.pos += n;
      return;
    }
    if (type === T_LIST || type === T_SET) {
      const { elemType, size } = this.listHeader();
      for (let i = 0; i < size; i++) this.skipElement(elemType);
      return;
    }
    if (type === T_MAP) {
      const size = Number(this.varint());
      if (size > 0) {
        const kv = this.u8();
        for (let i = 0; i < size; i++) { this.skipElement(kv >> 4); this.skipElement(kv & 0x0f); }
      }
      return;
    }
    if (type === T_STRUCT) { this.beginStruct(); this.skipFields(); this.endStruct(); return; }
    throw new Error(`thrift: cannot skip type ${type}`);
  }

  private skipElement(type: number): void {
    if (type === T_TRUE || type === T_FALSE) { this.pos += 1; return; } // list elems are full bytes
    this.skip(type);
  }

  skipFields(): void {
    for (;;) {
      const f = this.field();
      if (f === null) return;
      this.skip(f.type);
    }
  }
}

interface ParsedColumnMeta {
  name: string;
  type: number;
  codec: number;
  numValues: number;
  dataPageOffset: number;
}

interface ParsedFooter {
  numRows: number;
  columns: string[];
  chunks: ParsedColumnMeta[];
}

function parseFooter(buf: Uint8Array): ParsedFooter {
  if (buf.length < 12) throw new Error('parquet: file too short');
  const head = buf.subarray(0, 4), tail = buf.subarray(buf.length - 4);
  if (!head.every((b, i) => b === PAR1[i]) || !tail.every((b, i) => b === PAR1[i])) {
    throw new Error('parquet: bad PAR1 magic');
  }
  const metaLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(buf.length - 8, true);
  if (metaLen <= 0 || buf.length - 8 - metaLen < 4) throw new Error(`parquet: bad metadata length ${metaLen}`);
  const r = new TCompactReader(buf, buf.length - 8 - metaLen);
  const out: ParsedFooter = { numRows: 0, columns: [], chunks: [] };
  r.beginStruct();
  for (;;) {
    const f = r.field();
    if (f === null) break;
    if (f.id === 1 && f.type === T_I32) { r.i32(); } // version
    else if (f.id === 2 && f.type === T_LIST) {
      const { size } = r.listHeader();
      for (let i = 0; i < size; i++) {
        r.beginStruct();
        let name = '', numChildren = 0;
        for (;;) {
          const e = r.field();
          if (e === null) break;
          if (e.id === 4 && e.type === T_BINARY) name = r.binary();
          else if (e.id === 5 && e.type === T_I32) numChildren = r.i32();
          else r.skip(e.type);
        }
        r.endStruct();
        if (numChildren === 0 && name !== 'schema') out.columns.push(name); // leaf columns
      }
    }
    else if (f.id === 3 && f.type === T_I64) { out.numRows = Number(r.i64()); }
    else if (f.id === 4 && f.type === T_LIST) {
      const groups = r.listHeader();
      for (let g = 0; g < groups.size; g++) {
        r.beginStruct();
        for (;;) {
          const e = r.field();
          if (e === null) break;
          if (e.id === 1 && e.type === T_LIST) {
            const colsList = r.listHeader();
            for (let c = 0; c < colsList.size; c++) {
              r.beginStruct();
              const cm: ParsedColumnMeta = { name: '', type: -1, codec: -1, numValues: 0, dataPageOffset: -1 };
              for (;;) {
                const cc = r.field();
                if (cc === null) break;
                if (cc.id === 3 && cc.type === T_STRUCT) {
                  r.beginStruct();
                  for (;;) {
                    const md = r.field();
                    if (md === null) break;
                    if (md.id === 1 && md.type === T_I32) cm.type = r.i32();
                    else if (md.id === 3 && md.type === T_LIST) {
                      const paths = r.listHeader();
                      cm.name = paths.size > 0 ? r.binary() : '';
                      for (let p = 1; p < paths.size; p++) { r.binary(); }
                    }
                    else if (md.id === 4 && md.type === T_I32) cm.codec = r.i32();
                    else if (md.id === 5 && md.type === T_I64) cm.numValues = Number(r.i64());
                    else if (md.id === 9 && md.type === T_I64) cm.dataPageOffset = Number(r.i64());
                    else r.skip(md.type);
                  }
                  r.endStruct();
                  out.chunks.push(cm);
                } else r.skip(cc.type);
              }
              r.endStruct();
            }
          } else r.skip(e.type);
        }
        r.endStruct();
      }
    }
    else r.skip(f.type);
  }
  r.endStruct();
  return out;
}

interface PageHead { headerLen: number; compLen: number; numValues: number; }

function parsePageHeader(buf: Uint8Array, pos: number): PageHead {
  const r = new TCompactReader(buf, pos);
  const start = pos;
  const head: PageHead = { headerLen: 0, compLen: 0, numValues: 0 };
  r.beginStruct();
  for (;;) {
    const f = r.field();
    if (f === null) break;
    if (f.id === 3 && f.type === T_I32) head.compLen = r.i32();
    else if (f.id === 5 && f.type === T_STRUCT) {
      r.beginStruct();
      for (;;) {
        const d = r.field();
        if (d === null) break;
        if (d.id === 1 && d.type === T_I32) head.numValues = r.i32();
        else r.skip(d.type);
      }
      r.endStruct();
    } else r.skip(f.type); // type (1), uncompressed_page_size (2), crc (4), …
  }
  r.endStruct();
  head.headerLen = r.pos - start;
  return head;
}

/** Decode one column chunk (our writer's encoding only: RLE runs + PLAIN). */
function decodeColumnChunk(buf: Uint8Array, chunk: ParsedColumnMeta): Cell[] {
  const out: Cell[] = [];
  let pos = chunk.dataPageOffset;
  let got = 0;
  while (got < chunk.numValues) {
    const head = parsePageHeader(buf, pos);
    if (head.numValues === 0) throw new Error('parquet self-check: page with zero values');
    const body = gunzipSync(buf.subarray(pos + head.headerLen, pos + head.headerLen + head.compLen));
    pos += head.headerLen + head.compLen;
    got += head.numValues;
    // definition levels: u32le byte length, then RLE runs (bit width 1) up to numValues
    const bodyDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const levelsLen = bodyDv.getUint32(0, true);
    const levelsEnd = 4 + levelsLen;
    const levels: number[] = [];
    let p = 4;
    while (levels.length < head.numValues && p < levelsEnd) {
      let h = 0n, shift = 0n;
      for (;;) {
        const b = body[p++]!;
        h |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      if ((h & 1n) !== 0n) throw new Error('parquet self-check: bit-packed run not supported');
      const runLen = Number(h >> 1n);
      const v = body[p++]!;
      for (let i = 0; i < runLen; i++) levels.push(v);
    }
    if (p !== levelsEnd) throw new Error(`parquet self-check: def levels consumed ${p - 4} bytes, prefix said ${levelsLen}`);
    if (levels.length !== head.numValues) throw new Error(`parquet self-check: decoded ${levels.length} levels, expected ${head.numValues}`);
    // values: PLAIN, non-null in order
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const vals: Cell[] = [];
    for (let i = 0; i < levels.length; i++) {
      if (levels[i] === 0) { vals.push(null); continue; }
      if (chunk.type === 1) { vals.push(dv.getInt32(p, true)); p += 4; }
      else if (chunk.type === 2) { vals.push(Number(dv.getBigInt64(p, true))); p += 8; }
      else if (chunk.type === 5) { vals.push(dv.getFloat64(p, true)); p += 8; }
      else if (chunk.type === 6) { const n = dv.getUint32(p, true); p += 4; vals.push(TEXT_DEC.decode(body.subarray(p, p + n))); p += n; }
      else throw new Error(`parquet self-check: physical type ${chunk.type} unsupported`);
    }
    out.push(...vals);
  }
  return out;
}

/**
 * Round-trip self-check for one file written by this module's pure-TS writer:
 * re-reads from disk, parses the footer, decodes every page of every column,
 * and compares all cells against what was written.
 */
function verifyParquetFile(path: string, cols: ColDef[], expected: Cell[][]): { rows: number; bytes: number } {
  const buf = readFileSync(path);
  const footer = parseFooter(buf);
  const names = cols.map((c) => c.name).join(',');
  const gotNames = footer.columns.join(',');
  if (gotNames !== names) throw new Error(`${path}: column mismatch\n  wrote: ${names}\n  read:  ${gotNames}`);
  if (footer.chunks.length !== cols.length) throw new Error(`${path}: expected ${cols.length} chunks, got ${footer.chunks.length}`);
  const rows = expected[0]?.length ?? 0;
  if (footer.numRows !== rows) throw new Error(`${path}: footer num_rows ${footer.numRows} != ${rows}`);
  for (let c = 0; c < cols.length; c++) {
    const decoded = decodeColumnChunk(buf, footer.chunks[c]!);
    const exp = expected[c]!;
    if (decoded.length !== exp.length) throw new Error(`${path}:${cols[c]!.name}: decoded ${decoded.length} values, expected ${exp.length}`);
    for (let i = 0; i < exp.length; i++) {
      const a = exp[i], b = decoded[i];
      const same = a === b || (a == null && b == null);
      if (!same) throw new Error(`${path}:${cols[c]!.name}[${i}]: wrote ${String(a)}, read back ${String(b)}`);
    }
  }
  return { rows: footer.numRows, bytes: buf.length };
}

// ---------------------------------------------------------------------------
// ClickHouse path (a): server-side FORMAT Parquet streamed per partition.
// ---------------------------------------------------------------------------

/** Same 41 columns as the sqlite path, in the same order, same types. */
const CH_SELECT = `
  SELECT
    toString(r.service_date) AS service_date,
    r.train_number,
    r.operator,
    r.route_id AS line,
    toInt64(p.run_id) AS run_id,
    toInt64(p.id) AS prediction_id,
    p.stop_id,
    p.model_version,
    toInt64(p.generated_at) AS generated_at,
    toInt32(intDiv(toInt64(p.sched_arr_epoch) - toInt64(p.generated_at), 1000)) AS horizon_sec,
    multiIf(horizon_sec <= 300, '0-5m', horizon_sec <= 900, '5-15m', horizon_sec <= 1800, '15-30m',
            horizon_sec <= 3600, '30-60m', '60m+') AS horizon_bucket,
    toInt64(p.sched_arr_epoch) AS sched_arr_epoch,
    toInt64(p.operator_eta_epoch) AS operator_eta_epoch,
    toInt64(p.our_p10) AS our_p10,
    toInt64(p.our_p50) AS our_p50,
    toInt64(p.our_p90) AS our_p90,
    toFloat64(p.confidence) AS confidence,
    toInt64(o.actual_arr_epoch) AS actual_arr_epoch,
    o.operator_error_sec AS operator_error_sec,
    o.our_error_sec AS our_error_sec,
    nullIf(JSONExtractString(p.features_json, 'anchorKind'), '') AS f_anchor_kind,
    toInt64(JSONExtract(p.features_json, 'anchorEpoch', 'Nullable(Int64)')) AS f_anchor_epoch,
    toInt32(JSONExtract(p.features_json, 'remainingSegments', 'Int32')) AS f_remaining_segments,
    toFloat64(JSONExtract(p.features_json, 'statsCoverage', 'Float64')) AS f_stats_coverage,
    toInt32(JSONExtract(p.features_json, 'corridorAdjustSec', 'Int32')) AS f_corridor_adjust_sec,
    toFloat64(JSONExtract(p.features_json, 'operatorWeight', 'Float64')) AS f_operator_weight,
    toInt64(JSONExtract(p.features_json, 'independentP50', 'Nullable(Int64)')) AS f_independent_p50,
    toInt32(JSONExtract(p.features_json, 'originDepDelaySec', 'Nullable(Int32)')) AS f_origin_dep_delay_sec,
    toInt32(JSONExtract(p.features_json, 'trainHistoryDelaySec', 'Nullable(Int32)')) AS f_train_history_delay_sec,
    toInt32(JSONExtract(p.features_json, 'networkDelaySec', 'Nullable(Int32)')) AS f_network_delay_sec,
    toInt32(JSONExtract(p.features_json, 'operatorEtaDriftSec', 'Nullable(Int32)')) AS f_operator_eta_drift_sec,
    toInt32(JSONExtract(p.features_json, 'alertsRun24h', 'Nullable(Int32)')) AS f_alerts_run_24h,
    toInt32(JSONExtract(p.features_json, 'alertsRoute24h', 'Nullable(Int32)')) AS f_alerts_route_24h,
    toFloat64(JSONExtract(p.features_json, 'precipMm', 'Nullable(Float64)')) AS f_precip_mm,
    toInt32(JSONExtract(p.features_json, 'strikeActive', 'Nullable(Int32)')) AS f_strike_active,
    toFloat64(JSONExtract(p.features_json, 'eventHoursToStart', 'Nullable(Float64)')) AS f_event_hours_to_start,
    toInt32(JSONExtract(p.features_json, 'holiday', 'Nullable(Int32)')) AS f_holiday,
    toInt32(JSONExtract(p.features_json, 'upstreamStopMaxDelaySec', 'Nullable(Int32)')) AS f_upstream_stop_max_delay_sec,
    toInt32(JSONExtract(p.features_json, 'upstreamStopDelayedCount', 'Nullable(Int32)')) AS f_upstream_stop_delayed_count,
    toFloat64(JSONExtract(p.features_json, 'routeEncSec', 'Nullable(Float64)')) AS f_route_enc_sec,
    toFloat64(JSONExtract(p.features_json, 'etaAccelSec', 'Nullable(Float64)')) AS f_eta_accel_sec
  FROM predictions p
  INNER JOIN prediction_outcomes o ON o.prediction_id = p.id
  INNER JOIN train_runs r ON r.run_id = p.run_id
  WHERE p.features_json IS NOT NULL AND p.features_json != '' AND p.sched_arr_epoch IS NOT NULL`;

async function exportFromClickhouse(client: ClickHouseClient, outRoot: string, opts: { date?: string; byLine: boolean; limit?: number }): Promise<void> {
  // partition keys first, then one FORMAT Parquet stream per partition
  const datesRes = await client.query({
    query: `SELECT DISTINCT r.service_date AS d
            FROM predictions p
            INNER JOIN prediction_outcomes o ON o.prediction_id = p.id
            INNER JOIN train_runs r ON r.run_id = p.run_id
            WHERE p.features_json IS NOT NULL AND p.features_json != '' AND p.sched_arr_epoch IS NOT NULL
              AND ({date:String} = '' OR r.service_date = {date:String})
            ORDER BY d`,
    query_params: { date: opts.date ?? '' },
    format: 'JSONEachRow',
  });
  const dates = (await datesRes.json<{ d: string }>()).map((r) => r.d);
  const perDate = opts.byLine
    ? `SELECT DISTINCT r.route_id AS l FROM predictions p
       INNER JOIN prediction_outcomes o ON o.prediction_id = p.id
       INNER JOIN train_runs r ON r.run_id = p.run_id
       WHERE r.service_date = {date:String} AND p.features_json IS NOT NULL AND p.features_json != ''
         AND p.sched_arr_epoch IS NOT NULL ORDER BY l`
    : '';
  let files = 0, totalBytes = 0, checkedRows = 0;
  for (const d of dates) {
    const lines: (string | null)[] = [null];
    if (opts.byLine) {
      const lr = await client.query({ query: perDate, query_params: { date: d }, format: 'JSONEachRow' });
      lines.push(...(await lr.json<{ l: string | null }>()).map((r) => r.l));
    }
    for (const line of lines) {
      const dir = join(outRoot, `service_date=${d}`, line == null ? '' : `line=${sanitize(line)}`);
      const path = join(dir, 'part-0000.parquet');
      mkdirSync(dirname(path), { recursive: true });
      const limit = opts.limit != null ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
      const lineCond = opts.byLine ? ` AND (({line:String} = '' AND r.route_id IS NULL) OR r.route_id = nullIf({line:String}, ''))` : '';
      const query = `${CH_SELECT} AND r.service_date = {date:String}${lineCond}${limit} ORDER BY p.id FORMAT Parquet`;
      const res = await client.exec({ query, query_params: { date: d, line: line ?? '' } });
      await pipeline(res.stream, createWriteStream(path));
      const bytes = statSync(path).size;
      files += 1;
      totalBytes += bytes;
      const footer = parseFooter(readFileSync(path)); // footer-level check (pages are CH-encoded)
      checkedRows += footer.numRows;
      console.log(`  ${path}: ${footer.numRows} rows, ${footer.columns.length} cols, ${(bytes / 1024).toFixed(1)} KiB (footer parsed OK)`);
    }
  }
  console.log(`clickhouse export: ${files} files, ${checkedRows} rows, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB total`);
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || '_null_';
}

// ---------------------------------------------------------------------------
// SQLite path (b): stream rows, group by partition, write with the TS writer.
// ---------------------------------------------------------------------------

async function exportFromSqlite(db: Db, outRoot: string, opts: { date?: string; byLine: boolean; limit?: number; rowsPerFile: number }): Promise<void> {
  const where = opts.date ? ' AND r.service_date = ?' : '';
  const order = opts.byLine ? ' ORDER BY r.service_date, r.route_id, p.id' : ' ORDER BY r.service_date, p.id';
  const limit = opts.limit != null ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
  const stmt = db.prepare(`${SQLITE_SQL}${where}${order}${limit}`);
  const iter = opts.date ? stmt.iterate(opts.date) : stmt.iterate();

  interface Group { dir: string; cols: Cell[][]; rows: number; }
  let current: Group | null = null;
  let exported = 0, files = 0, totalBytes = 0;
  const perDate = new Map<string, number>();

  const flushGroup = (g: Group): void => {
    for (let part = 0; part * opts.rowsPerFile < g.rows; part++) {
      const from = part * opts.rowsPerFile;
      const to = Math.min(from + opts.rowsPerFile, g.rows);
      const slice = g.cols.map((c) => c.slice(from, to));
      const path = join(outRoot, g.dir, `part-${String(part).padStart(4, '0')}.parquet`);
      mkdirSync(dirname(path), { recursive: true });
      writeParquetFile(path, EXPORT_COLUMNS, slice, to - from);
      const v = verifyParquetFile(path, EXPORT_COLUMNS, slice);
      files += 1;
      totalBytes += v.bytes;
      console.log(`  ${path}: ${v.rows} rows, ${EXPORT_COLUMNS.length} cols, ${(v.bytes / 1024).toFixed(1)} KiB, round-trip OK`);
    }
  };

  for (const raw of iter) {
    const r = raw as unknown as SrcRow;
    const cells = srcRowToCells(r);
    const dir = opts.byLine
      ? `service_date=${r.service_date}/line=${r.line == null ? '_null_' : sanitize(r.line)}`
      : `service_date=${r.service_date}`;
    if (current == null || current.dir !== dir) {
      if (current) flushGroup(current);
      current = { dir, cols: EXPORT_COLUMNS.map(() => []), rows: 0 };
    }
    for (let c = 0; c < EXPORT_COLUMNS.length; c++) current.cols[c]!.push(cells[c]!);
    current.rows += 1;
    exported += 1;
    perDate.set(r.service_date, (perDate.get(r.service_date) ?? 0) + 1);
  }
  if (current) flushGroup(current);
  for (const [d, n] of perDate) console.log(`  service_date=${d}: ${n} rows`);
  console.log(`sqlite export: ${exported} rows, ${files} files, ${EXPORT_COLUMNS.length} columns, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB total — all files round-trip verified`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      out: { type: 'string' },
      limit: { type: 'string' },
      date: { type: 'string' },
      'by-line': { type: 'boolean' },
      source: { type: 'string' }, // auto | ch | sqlite
      'rows-per-file': { type: 'string' },
    },
  });
  const cfg = loadConfig();
  const outRoot = args.values.out ?? join(cfg.dataDir, 'exports', 'parquet');
  const opts = {
    date: args.values.date,
    byLine: args.values['by-line'] ?? false,
    limit: args.values.limit != null ? Number(args.values.limit) : undefined,
    rowsPerFile: args.values['rows-per-file'] != null ? Number(args.values['rows-per-file']) : 100_000,
  };
  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 0)) throw new Error('--limit must be a non-negative integer');

  const source = (args.values.source ?? 'auto').toLowerCase();
  const chUrl = process.env.TRENO_CLICKHOUSE_URL;
  let client: ClickHouseClient | null = null;
  if ((source === 'auto' || source === 'ch') && chUrl) {
    client = createClient({ url: chUrl, request_timeout: 300_000, clickhouse_settings: { date_time_input_format: 'best_effort' } });
    if (!(await client.ping())) {
      console.error(`ClickHouse unreachable at ${chUrl} — falling back to SQLite.`);
      await client.close();
      client = null;
    }
  } else if (source === 'ch') {
    console.error('--source ch requested but TRENO_CLICKHOUSE_URL is not set — falling back to SQLite.');
  }

  console.log(`export:parquet → ${outRoot} (source: ${client ? 'clickhouse FORMAT Parquet' : 'sqlite + pure-ts writer'}${opts.byLine ? ', partitioned by date+line' : ', partitioned by date'})`);
  if (client) {
    try {
      await exportFromClickhouse(client, outRoot, opts);
    } finally {
      await client.close();
    }
  } else {
    const db = openDb(join(cfg.dataDir, 'db', 'treno.db'));
    await exportFromSqlite(db, outRoot, opts);
    db.close();
  }
  console.log(`analyze with: duckdb -c "SELECT count(*) FROM read_parquet('${outRoot.replace(/'/g, '')}/**/*.parquet', hive_partitioning=true)"`);
}

void main();
