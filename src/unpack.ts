/**
 * Unpack a whisper.cpp build: a zip on Windows, a tar.gz on Linux, as
 * whisper.cpp publishes them (ADR-0005).
 *
 * Node reads neither, and scribe takes no dependency, so this is a small
 * reader of its own over `node:zlib`: the same code on every system, with no
 * program of the system's to find, and nothing in an archive is run. It reads
 * what whisper.cpp's archives hold, and refuses the rest with a sentence: a
 * zip that is encrypted, split or ZIP64, an entry of a kind it does not know.
 *
 * Every entry must land inside the directory it is unpacked into. A name that
 * is absolute or climbs out with `..` is refused, and so is a link whose
 * target is outside the archive. A link is written as a copy of the file it
 * names, because Windows lets few accounts make one, and whisper.cpp's Linux
 * build names its libraries through links.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import type { Format } from './downloads.ts';

/** One entry of an archive, read out of it. */
type Entry =
  | { readonly kind: 'file'; readonly path: string; readonly mode: number; readonly data: Buffer }
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'link'; readonly path: string; readonly target: string };

/** Unpack an archive of this format into `into`, which must exist and be empty. */
export function unpack(archive: Buffer, format: Format, into: string): void {
  const entries = format === 'zip' ? readZip(archive) : readTar(gunzipSync(archive));
  const files = new Map<string, Entry>();
  for (const entry of entries) files.set(entry.path, entry);

  for (const entry of entries) {
    const at = join(into, ...entry.path.split('/'));
    if (entry.kind === 'directory') {
      mkdirSync(at, { recursive: true });
      continue;
    }
    const file = entry.kind === 'file' ? entry : followed(entry, files);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, file.data);
    chmodSync(at, file.mode & 0o777 || 0o644);
  }
}

/** The file a link names, through any links between, or a refusal. */
function followed(
  link: Extract<Entry, { kind: 'link' }>,
  files: ReadonlyMap<string, Entry>,
): Extract<Entry, { kind: 'file' }> {
  let at: Entry = link;
  for (let hops = 0; hops < 16; hops += 1) {
    if (at.kind === 'file') return at;
    if (at.kind === 'directory') break;
    const target = posix.normalize(posix.join(posix.dirname(at.path), at.target));
    const next = files.get(safe(target, link.path));
    if (next === undefined) break;
    at = next;
  }
  throw new Error(`the link ${link.path} names no file inside the archive.`);
}

/** A name inside the archive, as a relative path with `/`, or a refusal. */
function safe(name: string, shown = name): string {
  const path = posix.normalize(name.split('\\').join('/')).replace(/\/+$/, '');
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
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('its central directory is broken.');
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

    const path = safe(name);
    if (name.endsWith('/') || name.endsWith('\\')) {
      entries.push({ kind: 'directory', path });
      continue;
    }
    if ((flags & 1) !== 0) throw new Error(`${name} is encrypted.`);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name} has no local header.`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + packed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`${name} is packed by method ${method}, which scribe does not read.`);
    if (data.length !== size) throw new Error(`${name} is not the size its archive says.`);
    // A zip made on Unix keeps the file's mode in the top half of its attributes.
    const mode = madeOn === 3 ? (attributes >>> 16) & 0o777 : 0o644;
    entries.push({ kind: 'file', path, mode, data });
  }
  return entries;
}

/** The entries of a tar, in the ustar and GNU forms, with the long names of both. */
function readTar(tar: Buffer): readonly Entry[] {
  const entries: Entry[] = [];
  const text = (from: number, length: number): string => {
    const field = tar.subarray(from, from + length);
    const zero = field.indexOf(0);
    return field.toString('utf8', 0, zero < 0 ? field.length : zero);
  };
  const octal = (from: number, length: number): number =>
    Number.parseInt(text(from, length).trim() || '0', 8);

  let longName: string | null = null;
  let longLink: string | null = null;
  for (let next = 0; next + 512 <= tar.length; ) {
    const header = next;
    if (tar.subarray(header, header + 512).every((byte) => byte === 0)) break;
    const type = String.fromCharCode(tar[header + 156] ?? 0);
    const size = octal(header + 124, 12);
    const data = tar.subarray(header + 512, header + 512 + size);
    next += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L' || type === 'K') {
      const value = data.toString('utf8').replace(/\0+$/, '');
      if (type === 'L') longName = value;
      else longLink = value;
      continue;
    }
    if (type === 'x') {
      for (const record of data.toString('utf8').split('\n')) {
        const found = /^\d+ (path|linkpath)=(.*)$/.exec(record);
        if (found?.[1] === 'path') longName = found[2] ?? null;
        if (found?.[1] === 'linkpath') longLink = found[2] ?? null;
      }
      continue;
    }
    if (type === 'g') continue;

    // Only the POSIX form keeps a prefix of the name at 345; the GNU form
    // keeps other fields there.
    const prefix = text(header + 257, 6) === 'ustar' ? text(header + 345, 155) : '';
    const short = text(header, 100);
    const name = longName ?? (prefix === '' ? short : `${prefix}/${short}`);
    const target = longLink ?? text(header + 157, 100);
    longName = null;
    longLink = null;

    const path = safe(name);
    if (type === '0' || type === '\0' || type === '7') {
      entries.push({ kind: 'file', path, mode: octal(header + 100, 8), data: Buffer.from(data) });
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
  return entries;
}
