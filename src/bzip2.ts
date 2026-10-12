/**
 * Read a bzip2 stream: sherpa-onnx publishes every build and model as a
 * tar.bz2, and scribe fetches the diarizer from there (ADR-0007).
 *
 * `node:zlib` reads gzip, deflate and brotli, but not bzip2, and scribe takes
 * no dependency. So this decoder is scribe's own. It reads the format as
 * bzip2 1.0 writes it, step by step, in the order the encoder made it:
 *
 * 1. Huffman codes give a list of symbols.
 * 2. The symbols are run lengths and move-to-front indexes, which give bytes.
 * 3. The inverse Burrows-Wheeler transform puts the bytes back in order.
 * 4. A run of four equal bytes and a count byte gives the run back.
 *
 * No number a stream gives is trusted. A block that is longer than its stream
 * says, a code length out of range, a pointer past the block, or a CRC that
 * does not match is refused with a sentence, so a broken download is never
 * unpacked. Streams one after another, as pbzip2 writes them, are read as one.
 * The old "randomised" blocks, which no bzip2 since 0.9.5 writes, are refused.
 */

/** The magic number that starts a block: the digits of pi. */
const BLOCK_MAGIC = [0x3141, 0x5926, 0x5359] as const;

/** The magic number that ends a stream: the digits of the square root of pi. */
const END_MAGIC = [0x1772, 0x4538, 0x5090] as const;

/** The longest Huffman code bzip2 writes, in bits. */
const MAX_CODE_LENGTH = 20;

/** How many bits the decoder looks up at once; a longer code is read bit by bit after. */
const LOOKUP_BITS = 10;

/** How many symbols one Huffman table codes before the next selector. */
const GROUP_SIZE = 50;

/** The CRC-32 of bzip2: the polynomial 0x04c11db7, most significant bit first. */
const CRC_TABLE = ((): Int32Array => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let crc = n << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    table[n] = crc;
  }
  return table;
})();

/** Decompress a whole bzip2 file, or throw a sentence that says what is wrong with it. */
export function bunzip2(data: Uint8Array): Buffer {
  const input = bitReader(data);
  const parts: Buffer[] = [];
  do {
    parts.push(...readStream(input));
    input.alignToByte();
  } while (!input.atEnd());
  return Buffer.concat(parts);
}

/** The blocks of one stream, from its `BZh` header to its end magic. */
function readStream(input: BitReader): Buffer[] {
  if (input.bits(8) !== 0x42 || input.bits(8) !== 0x5a || input.bits(8) !== 0x68) {
    throw new Error('it is not a bzip2 stream.');
  }
  const level = input.bits(8) - 0x30;
  if (level < 1 || level > 9) throw new Error(`its block size, ${level}, is not 1 to 9.`);
  const maxBlock = level * 100_000;

  const blocks: Buffer[] = [];
  let combined = 0;
  for (;;) {
    const magic = [input.bits(16), input.bits(16), input.bits(16)];
    const crc = ((input.bits(16) << 16) | input.bits(16)) >>> 0;
    if (same(magic, END_MAGIC)) {
      if (crc !== combined) throw new Error('its CRC does not match: it is damaged.');
      return blocks;
    }
    if (!same(magic, BLOCK_MAGIC)) throw new Error('a block of it has no magic number.');
    const block = readBlock(input, maxBlock);
    if (crcOf(block) !== crc) throw new Error('a block of it fails its CRC: it is damaged.');
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
    blocks.push(block);
  }
}

/** One block, read and decoded back to the bytes it was made from. */
function readBlock(input: BitReader, maxBlock: number): Buffer {
  if (input.bits(1) !== 0) {
    throw new Error('it has a randomised block, which scribe does not read.');
  }
  const origin = input.bits(24);
  const used = readUsedBytes(input);
  if (used.length === 0) throw new Error('a block of it uses no byte.');
  // Every byte used, plus RUNA and RUNB in place of index 0, plus the end of block.
  const alphabet = used.length + 2;

  const groups = input.bits(3);
  if (groups < 2 || groups > 6) throw new Error(`it has ${groups} Huffman tables, not 2 to 6.`);
  const selectors = readSelectors(input, groups);
  const tables: HuffmanTable[] = [];
  for (let n = 0; n < groups; n += 1) {
    tables.push(huffmanTable(readCodeLengths(input, alphabet)));
  }

  const transformed = readSymbols(input, tables, selectors, used, maxBlock);
  if (origin >= transformed.length) throw new Error('its block pointer is past its block.');
  return undoRuns(inverseBwt(transformed, origin));
}

/** The bytes a block uses, in order: a map of 16 ranges of 16. */
function readUsedBytes(input: BitReader): number[] {
  const ranges = input.bits(16);
  const used: number[] = [];
  for (let range = 0; range < 16; range += 1) {
    if ((ranges & (0x8000 >>> range)) === 0) continue;
    const bytes = input.bits(16);
    for (let n = 0; n < 16; n += 1) {
      if ((bytes & (0x8000 >>> n)) !== 0) used.push(range * 16 + n);
    }
  }
  return used;
}

/** Which table codes each group of 50 symbols, kept move-to-front and written in unary. */
function readSelectors(input: BitReader, groups: number): number[] {
  const count = input.bits(15);
  if (count === 0) throw new Error('a block of it has no selectors.');
  const order = Array.from({ length: groups }, (_, n) => n);
  const selectors: number[] = [];
  for (let n = 0; n < count; n += 1) {
    let index = 0;
    while (input.bits(1) === 1) {
      index += 1;
      if (index >= groups) throw new Error('a selector of it names no table.');
    }
    const table = order[index] as number;
    order.splice(index, 1);
    order.unshift(table);
    selectors.push(table);
  }
  return selectors;
}

/** The length of each symbol's code: a start of five bits, then a change per symbol. */
function readCodeLengths(input: BitReader, alphabet: number): number[] {
  const lengths: number[] = [];
  let length = input.bits(5);
  for (let symbol = 0; symbol < alphabet; symbol += 1) {
    for (;;) {
      if (length < 1 || length > MAX_CODE_LENGTH) {
        throw new Error(`a code length of it is ${length}, not 1 to ${MAX_CODE_LENGTH}.`);
      }
      if (input.bits(1) === 0) break;
      length += input.bits(1) === 0 ? 1 : -1;
    }
    lengths.push(length);
  }
  return lengths;
}

/** A canonical Huffman code, as the decoder walks it one bit at a time. */
type HuffmanTable = {
  /** How many codes have each length. */
  readonly counts: Uint16Array;
  /** The first code of each length. */
  readonly firsts: Int32Array;
  /** Where the symbols of each length start in `symbols`. */
  readonly starts: Uint16Array;
  /** The symbols, by code length, then by value. */
  readonly symbols: Uint16Array;
  /**
   * Every code of at most LOOKUP_BITS, by the next LOOKUP_BITS bits, as its
   * symbol times 32 plus its length. Zero where the code is longer.
   */
  readonly lookup: Uint16Array;
};

/** The canonical code these lengths give: shorter codes first, equal lengths by symbol. */
function huffmanTable(lengths: readonly number[]): HuffmanTable {
  const counts = new Uint16Array(MAX_CODE_LENGTH + 1);
  for (const length of lengths) counts[length] = (counts[length] as number) + 1;
  const firsts = new Int32Array(MAX_CODE_LENGTH + 1);
  const starts = new Uint16Array(MAX_CODE_LENGTH + 1);
  for (let length = 1; length <= MAX_CODE_LENGTH; length += 1) {
    const before = length - 1;
    firsts[length] = ((firsts[before] as number) + (counts[before] as number)) << 1;
    starts[length] = (starts[before] as number) + (counts[before] as number);
  }
  const symbols = new Uint16Array(lengths.length);
  const lookup = new Uint16Array(1 << LOOKUP_BITS);
  const next = Uint16Array.from(starts);
  lengths.forEach((length, symbol) => {
    const rank = (next[length] as number) - (starts[length] as number);
    symbols[next[length] as number] = symbol;
    next[length] = (next[length] as number) + 1;
    if (length > LOOKUP_BITS) return;
    // The code, followed by every value of the bits after it.
    const spare = LOOKUP_BITS - length;
    const from = ((firsts[length] as number) + rank) << spare;
    lookup.fill((symbol << 5) | length, from, from + (1 << spare));
  });
  return { counts, firsts, starts, symbols, lookup };
}

/** The next symbol: looked up when its code is short, else read one bit at a time. */
function decodeSymbol(input: BitReader, table: HuffmanTable): number {
  const found = table.lookup[input.peek(LOOKUP_BITS)] as number;
  if (found !== 0) {
    input.skip(found & 31);
    return found >>> 5;
  }
  let code = input.bits(LOOKUP_BITS);
  for (let length = LOOKUP_BITS + 1; length <= MAX_CODE_LENGTH; length += 1) {
    code = (code << 1) | input.bits(1);
    // Canonical codes of one length are consecutive, from the first one up.
    const offset = code - (table.firsts[length] as number);
    if (offset >= 0 && offset < (table.counts[length] as number)) {
      return table.symbols[(table.starts[length] as number) + offset] as number;
    }
  }
  throw new Error('a block of it holds a code that is in no table.');
}

/**
 * The block as the Burrows-Wheeler transform left it. Each symbol is a
 * move-to-front index, and runs of index 0 are written in base 2 with the
 * digits RUNA (1) and RUNB (2), least significant first.
 */
function readSymbols(
  input: BitReader,
  tables: readonly HuffmanTable[],
  selectors: readonly number[],
  used: readonly number[],
  maxBlock: number,
): Uint8Array {
  const endOfBlock = used.length + 1;
  const front = Uint8Array.from(used);
  const out = new Uint8Array(maxBlock);
  let length = 0;
  let run = 0;
  let weight = 1;

  for (let read = 0; ; read += 1) {
    const selector = selectors[Math.floor(read / GROUP_SIZE)];
    if (selector === undefined) throw new Error('a block of it runs past its selectors.');
    const symbol = decodeSymbol(input, tables[selector] as HuffmanTable);

    if (symbol <= 1) {
      run += weight << symbol;
      weight <<= 1;
      if (run > maxBlock) throw new Error('a block of it is longer than its stream says.');
      continue;
    }
    if (run > 0) {
      if (length + run > maxBlock) {
        throw new Error('a block of it is longer than its stream says.');
      }
      out.fill(front[0] as number, length, length + run);
      length += run;
      run = 0;
      weight = 1;
    }
    if (symbol === endOfBlock) return out.subarray(0, length);

    if (length >= maxBlock) throw new Error('a block of it is longer than its stream says.');
    const index = symbol - 1;
    const byte = front[index] as number;
    front.copyWithin(1, 0, index);
    front[0] = byte;
    out[length] = byte;
    length += 1;
  }
}

/**
 * Put the bytes back in order. Each row of `links` holds its own byte in the
 * low 8 bits, and above them the row that comes after it, so the walk from the
 * row the encoder kept reads one number per byte.
 */
function inverseBwt(last: Uint8Array, origin: number): Uint8Array {
  const starts = new Int32Array(256);
  for (let row = 0; row < last.length; row += 1) {
    const byte = last[row] as number;
    starts[byte] = (starts[byte] as number) + 1;
  }
  let sum = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    const count = starts[byte] as number;
    starts[byte] = sum;
    sum += count;
  }
  const links = Uint32Array.from(last);
  for (let row = 0; row < last.length; row += 1) {
    const byte = last[row] as number;
    const at = starts[byte] as number;
    links[at] = (links[at] as number) | (row << 8);
    starts[byte] = at + 1;
  }
  const out = new Uint8Array(last.length);
  let row = (links[origin] as number) >>> 8;
  for (let n = 0; n < last.length; n += 1) {
    const link = links[row] as number;
    out[n] = link & 0xff;
    row = link >>> 8;
  }
  return out;
}

/** Undo the first step of bzip2: four equal bytes are followed by how many more there are. */
function undoRuns(bytes: Uint8Array): Buffer {
  let out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  const room = (more: number): void => {
    if (length + more <= out.length) return;
    const larger = Buffer.allocUnsafe(Math.max(out.length * 2, length + more));
    out.copy(larger, 0, 0, length);
    out = larger;
  };
  let previous = -1;
  let repeats = 0;
  for (let n = 0; n < bytes.length; n += 1) {
    const byte = bytes[n] as number;
    if (repeats === 4) {
      room(byte);
      out.fill(previous, length, length + byte);
      length += byte;
      repeats = 0;
      previous = -1;
      continue;
    }
    room(1);
    out[length] = byte;
    length += 1;
    repeats = byte === previous ? repeats + 1 : 1;
    previous = byte;
  }
  return out.subarray(0, length);
}

/** The CRC bzip2 keeps for each block. */
function crcOf(bytes: Uint8Array): number {
  let crc = -1;
  for (let n = 0; n < bytes.length; n += 1) {
    crc = (crc << 8) ^ (CRC_TABLE[(crc >>> 24) ^ (bytes[n] as number)] as number);
  }
  return ~crc >>> 0;
}

/** Whether two magic numbers are the same, part by part. */
function same(left: readonly number[], right: readonly number[]): boolean {
  return left.every((value, n) => value === right[n]);
}

/** Bits from a byte array, most significant first, as bzip2 writes them. */
type BitReader = {
  /** The next `count` bits, at most 24, as a number. */
  readonly bits: (count: number) => number;
  /** The next `count` bits, at most 24, but not read yet: zeros past the end. */
  readonly peek: (count: number) => number;
  /** Read `count` bits that `peek` has seen. */
  readonly skip: (count: number) => void;
  /** Pass over what is left of the byte, as a stream ends on a whole byte. */
  readonly alignToByte: () => void;
  /** Whether every byte has been read. */
  readonly atEnd: () => boolean;
};

/** A reader of these bytes, from the first bit. */
function bitReader(data: Uint8Array): BitReader {
  let at = 0;
  let held = 0;
  let count = 0;
  const fill = (wanted: number): void => {
    while (count < wanted && at < data.length) {
      held = (held << 8) | (data[at] as number);
      at += 1;
      count += 8;
    }
  };
  const skip = (wanted: number): void => {
    if (count < wanted) throw new Error('it ends before its end of stream.');
    count -= wanted;
  };
  return {
    bits: (wanted) => {
      fill(wanted);
      skip(wanted);
      return (held >>> count) & ((1 << wanted) - 1);
    },
    peek: (wanted) => {
      fill(wanted);
      const bits = count >= wanted ? held >>> (count - wanted) : held << (wanted - count);
      return bits & ((1 << wanted) - 1);
    },
    skip,
    alignToByte: () => {
      count -= count % 8;
    },
    atEnd: () => at >= data.length && count === 0,
  };
}
