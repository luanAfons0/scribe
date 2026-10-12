/**
 * Unpack a whisper.cpp build: a zip on Windows, a tar.gz on Linux, as
 * whisper.cpp publishes them (ADR-0005). sherpa-onnx publishes a tar.bz2 for
 * every system (ADR-0007).
 *
 * Node reads none of them, and scribe takes no dependency, so this is a small
 * reader of its own over `node:zlib` and `bzip2.ts`: the same code on every system, with no
 * program of the system's to find, and nothing in an archive is run. It reads
 * what whisper.cpp's archives hold, and refuses the rest with a sentence: a
 * zip that is encrypted, split or ZIP64, an entry of a kind it does not know.
 *
 * Every entry must land inside the directory it is unpacked into. A name that
 * is absolute or climbs out with `..` is refused, and so is a link whose
 * target is outside the archive, and a path the archive holds twice. No number
 * an archive gives is trusted: a size that is not a number, or a length or an
 * offset that leads past the bytes it holds, is refused, and an entry is never
 * inflated past the size it declares. The archive's own top directory, `./`,
 * is no entry to unpack, and is passed over. A link is written as a copy of
 * the file it names, because Windows lets few accounts make one, and
 * whisper.cpp's Linux build names its libraries through links.
 *
 * A sherpa-onnx build holds every program of sherpa-onnx, and the diarizer
 * needs one of them (ADR-0007): the Windows archive unpacks to 1.3 GB for
 * 17 MB kept. So the caller may name the members to keep, each with the path
 * it is written at. The whole archive is still read and checked, and only
 * those members are written. A member named and not in the archive is
 * refused.
 *
 * So a machine of 8 GB can fetch it, a tar.bz2 is never held whole: it is
 * read from its file a chunk at a time, bzip2.ts gives it back a block at a
 * time, and the tar reader takes the bytes of a member that is kept, across
 * blocks, and passes over the rest as they go by. Only the members kept are
 * held, and they are written once the last block and the stream's CRC are
 * checked, so nothing of a damaged archive is written.
 */
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { bunzip2 } from './bzip2.ts';
import type { Format } from './downloads.ts';

/** How much of a tar.bz2 is read from its file at once. */
const CHUNK = 1 << 20;

/** One entry of an archive, read out of it: a file's data is null when it is passed over. */
type Entry =
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly mode: number;
      readonly data: Buffer | null;
    }
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'link'; readonly path: string; readonly target: string };

/**
 * Unpack the archive at this path, in this format, into `into`, which must
 * exist and be empty. With `keep`, only its members are written, each at the
 * path it maps to.
 */
export function unpack(
  archive: string,
  format: Format,
  into: string,
  keep?: ReadonlyMap<string, string>,
): void {
  const wanted = (path: string): boolean => keep === undefined || keep.has(path);
  let entries: readonly Entry[];
  if (format === 'zip') entries = readZip(readFileSync(archive));
  else if (format === 'tar.gz') entries = readTar([gunzipSync(readFileSync(archive))], wanted);
  else {
    const chunks = fileChunks(archive);
    try {
      entries = readTar(bunzip2(chunks), wanted);
    } finally {
      // Closes the file, also when the archive is refused halfway.
      chunks.return(undefined);
    }
  }
  const files = new Map<string, Entry>();
  for (const entry of entries) {
    if (files.has(entry.path)) throw new Error(`${entry.path} is in the archive twice.`);
    files.set(entry.path, entry);
  }

  for (const member of keep?.keys() ?? []) {
    if (!files.has(member)) throw new Error(`${member} is not in the archive.`);
  }

  for (const entry of entries) {
    const placed = keep === undefined ? entry.path : keep.get(entry.path);
    if (placed === undefined) continue;
    const at = join(into, ...safe(placed).split('/'));
    if (entry.kind === 'directory') {
      mkdirSync(at, { recursive: true });
      continue;
    }
    const file = followed(entry, files);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, file.data);
    chmodSync(at, file.mode & 0o777 || 0o644);
  }
}

/** The data and mode of a file, or of the file a link names through any links between. */
function followed(
  entry: Exclude<Entry, { kind: 'directory' }>,
  files: ReadonlyMap<string, Entry>,
): { readonly data: Buffer; readonly mode: number } {
  let at: Entry = entry;
  for (let hops = 0; hops < 16; hops += 1) {
    if (at.kind === 'file') {
      if (at.data !== null) return { data: at.data, mode: at.mode };
      // A link may name a file that was passed over, as it was not kept.
      throw new Error(`${entry.path} names ${at.path}, which is not kept.`);
    }
    if (at.kind === 'directory') break;
    const target = posix.normalize(posix.join(posix.dirname(at.path), at.target));
    const next = files.get(safe(target, entry.path));
    if (next === undefined) break;
    at = next;
  }
  throw new Error(`the link ${entry.path} names no file inside the archive.`);
}

/** A name as a relative path with `/`, before it is checked. */
function normal(name: string): string {
  return posix.normalize(name.split('\\').join('/')).replace(/\/+$/, '');
}

/** Whether a directory entry is the archive's own top, `.` or `./`, which holds the rest. */
function isTop(name: string): boolean {
  return normal(name) === '.';
}

/** A name inside the archive, as a relative path with `/`, or a refusal. */
function safe(name: string, shown = name): string {
  const path = normal(name);
  if (path === '' || path === '.' || path.startsWith('/') || /^[A-Za-z]:/.test(path) ||
    path === '..' || path.startsWith('../')) {
    throw new Error(`${shown} would land outside the directory it is unpacked into.`);
  }
  return path;
}

/** The entries of a zip, read through its central directory. */
function readZip(zip: Buffer): readonly Entry[] {
  // The end of central directory record is the last thing in the file, after
  // a comment of at most 65535 bytes.
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65_535); at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('it is not a zip archive.');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('it is a ZIP64 archive.');

  const entries: Entry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) {
      throw new Error('its central directory is broken.');
    }
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const madeOn = zip.readUInt8(at + 5);
    const attributes = zip.readUInt32LE(at + 38);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/') || name.endsWith('\\')) {
      if (!isTop(name)) entries.push({ kind: 'directory', path: safe(name) });
      continue;
    }
    const path = safe(name);
    if ((flags & 1) !== 0) throw new Error(`${name} is encrypted.`);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) {
      throw new Error(`${name} has no local header.`);
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + packed > zip.length) throw new Error(`${name} runs past the end of the archive.`);
    const raw = zip.subarray(start, start + packed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflated(raw, size, name);
    else throw new Error(`${name} is packed by method ${method}, which scribe does not read.`);
    if (data.length !== size) throw new Error(`${name} is not the size its archive says.`);
    // A zip made on Unix keeps the file's mode in the top half of its attributes.
    const mode = madeOn === 3 ? (attributes >>> 16) & 0o777 : 0o644;
    entries.push({ kind: 'file', path, mode, data });
  }
  return entries;
}

/**
 * A deflated entry, inflated to at most the size its archive declares, so an
 * entry that says it is small cannot fill the memory of the Plugin Server.
 */
function inflated(raw: Buffer, size: number, name: string): Buffer {
  try {
    // zlib takes no limit below one byte; an empty entry is still checked
    // against its size after.
    return inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
  } catch (fault) {
    if ((fault as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`${name} unpacks to more than the ${size} bytes its archive says.`);
    }
    throw new Error(`${name} cannot be inflated: ${(fault as Error).message}`);
  }
}

/**
 * The entries of a tar, in the ustar and GNU forms, with the long names of
 * both, read out of chunks that come one at a time. The data of a file is held
 * only when `wanted` takes its path; the rest is passed over as it goes by.
 * Every chunk is read, also after the end of the tar, so every check the
 * chunks carry runs.
 */
function readTar(chunks: Iterable<Buffer>, wanted: (path: string) => boolean): readonly Entry[] {
  const bytes = byteReader(chunks);
  const entries: Entry[] = [];

  let longName: string | null = null;
  let longLink: string | null = null;
  for (;;) {
    const header = bytes.take(512);
    if (header.length < 512 || header.every((byte) => byte === 0)) break;
    const text = (from: number, length: number): string => {
      const field = header.subarray(from, from + length);
      const zero = field.indexOf(0);
      return field.toString('utf8', 0, zero < 0 ? field.length : zero);
    };
    /** An octal field, or NaN when it holds anything but octal digits. */
    const octal = (from: number, length: number): number => {
      const digits = text(from, length).trim();
      return /^[0-7]*$/.test(digits) ? Number.parseInt(digits || '0', 8) : Number.NaN;
    };
    const type = String.fromCharCode(header[156] ?? 0);
    const size = octal(124, 12);
    const named = (): string => longName ?? text(0, 100);
    if (!Number.isSafeInteger(size)) {
      throw new Error(`${named()} has a size that is not a number.`);
    }
    const padding = (512 - (size % 512)) % 512;
    const short = (): Error => new Error(`${named()} runs past the end of the archive.`);
    /** The data of this entry, held. */
    const held = (): Buffer => {
      const data = bytes.take(size);
      if (data.length < size) throw short();
      bytes.pass(padding);
      return data;
    };

    if (type === 'L' || type === 'K') {
      const value = held().toString('utf8').replace(/\0+$/, '');
      if (type === 'L') longName = value;
      else longLink = value;
      continue;
    }
    if (type === 'x') {
      for (const record of held().toString('utf8').split('\n')) {
        const found = /^\d+ (path|linkpath)=(.*)$/.exec(record);
        if (found?.[1] === 'path') longName = found[2] ?? null;
        if (found?.[1] === 'linkpath') longLink = found[2] ?? null;
      }
      continue;
    }

    // Only the POSIX form keeps a prefix of the name at 345; the GNU form
    // keeps other fields there.
    const prefix = text(257, 6) === 'ustar' ? text(345, 155) : '';
    const name = longName ?? (prefix === '' ? text(0, 100) : `${prefix}/${text(0, 100)}`);
    const target = longLink ?? text(157, 100);
    const file = type === '0' || type === '\0' || type === '7';
    const path = type === 'g' || (type === '5' && isTop(name)) ? null : safe(name);
    let data: Buffer | null = null;
    if (file && path !== null && wanted(path)) {
      data = held();
    } else {
      if (bytes.pass(size) < size) throw short();
      bytes.pass(padding);
    }
    longName = null;
    longLink = null;

    if (path === null) continue;
    if (file) {
      entries.push({ kind: 'file', path, mode: octal(100, 8), data });
    } else if (type === '5') {
      entries.push({ kind: 'directory', path });
    } else if (type === '2') {
      entries.push({ kind: 'link', path, target });
    } else if (type === '1') {
      // A hard link names its target from the top of the archive.
      entries.push({ kind: 'link', path, target: posix.relative(posix.dirname(path), target) });
    } else {
      throw new Error(`${name} is an entry of type ${type}, which scribe does not unpack.`);
    }
  }
  bytes.drain();
  return entries;
}

/** Bytes read in order out of chunks that come one at a time, and are let go once read. */
type ByteReader = {
  /** The next `count` bytes, or fewer where the bytes end. */
  readonly take: (count: number) => Buffer;
  /** Pass over the next `count` bytes, and say how many there were. */
  readonly pass: (count: number) => number;
  /** Read every chunk that is left. */
  readonly drain: () => void;
};

/** A reader of these chunks, from the first byte. */
function byteReader(chunks: Iterable<Buffer>): ByteReader {
  const source = chunks[Symbol.iterator]();
  let chunk: Buffer = Buffer.alloc(0);
  let at = 0;
  /** Whether a byte is left, after the next chunk is asked for if it must be. */
  const more = (): boolean => {
    while (at >= chunk.length) {
      const next = source.next();
      if (next.done === true) return false;
      chunk = next.value;
      at = 0;
    }
    return true;
  };
  return {
    take: (count) => {
      const pieces: Buffer[] = [];
      let got = 0;
      while (got < count && more()) {
        const piece = chunk.subarray(at, at + count - got);
        pieces.push(piece);
        got += piece.length;
        at += piece.length;
      }
      return pieces.length === 1 ? (pieces[0] as Buffer) : Buffer.concat(pieces, got);
    },
    pass: (count) => {
      let passed = 0;
      while (passed < count && more()) {
        const step = Math.min(count - passed, chunk.length - at);
        at += step;
        passed += step;
      }
      return passed;
    },
    drain: () => {
      while (more()) at = chunk.length;
    },
  };
}

/** A file read a chunk at a time; it is closed when the reading ends or is given up. */
function* fileChunks(path: string): Generator<Buffer, void, undefined> {
  const descriptor = openSync(path, 'r');
  try {
    for (;;) {
      // A new buffer each time: the one before may still be read.
      const chunk = Buffer.allocUnsafe(CHUNK);
      const read = readSync(descriptor, chunk, 0, CHUNK, null);
      if (read === 0) return;
      yield chunk.subarray(0, read);
    }
  } finally {
    closeSync(descriptor);
  }
}
