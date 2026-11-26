import { t } from '#src/i18n/index';
import { inflateRawSync } from 'node:zlib';

/**
Minimal, defensive zip reader used to unpack mods downloaded from the mod
store. Everything is bounds-checked and size-capped: a hostile archive can
make us read off the end of the buffer or inflate a tiny entry into a huge
one (a zip bomb), so every length is validated against both the buffer and
the caller's limits before anything is copied or inflated.
*/
export interface ZipEntry {
  name: string;
  size: number;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
}

export const defaultZipLimits: ZipLimits = {
  maxEntries: 5000,
  maxTotalBytes: 100 * 1024 * 1024,
  maxEntryBytes: 20 * 1024 * 1024,
};

export class ZipError extends Error {}

const EOCD_SIG = 0x06_05_4b_50;
const CEN_SIG = 0x02_01_4b_50;
const LOC_SIG = 0x04_03_4b_50;
const EOCD_MIN = 22;
const EOCD_MAX_SCAN = 65_557; // EOCD size + max comment length
const UNSAFE = /^[a-z]:/i;

function corrupt(): never {
  throw new ZipError(t('mod_zip_corrupt_archive'));
}

/** Find the End Of Central Directory record by scanning backwards. */
function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - EOCD_MAX_SCAN);

  for (let offset = buffer.length - EOCD_MIN; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) {
      return offset;
    }
  }

  throw new ZipError(t('mod_zip_not_zip_file'));
}

function isUnsafe(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
    return true;
  }

  return name.split('/').includes('..') || UNSAFE.test(name);
}

export function readZip(buffer: Buffer, limits: ZipLimits = defaultZipLimits): Array<ZipEntry> {
  if (buffer.length < EOCD_MIN) {
    throw new ZipError(t('mod_zip_not_zip_file'));
  }

  const eocd = findEocd(buffer);

  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipError(t('mod_zip_zip64_not_supported'));
  }

  const count = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirOffset = buffer.readUInt32LE(eocd + 16);

  if (count === 0xff_ff || dirOffset === 0xff_ff_ff_ff || dirSize === 0xff_ff_ff_ff) {
    throw new ZipError(t('mod_zip_zip64_not_supported'));
  }

  if (count > limits.maxEntries) {
    throw new ZipError(t('mod_zip_too_many_entries'));
  }
  if (dirOffset + dirSize > buffer.length) {
    corrupt();
  }

  const entries: Array<ZipEntry> = [];
  const seen = new Set<string>();
  let total = 0;
  let cursor = dirOffset;

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CEN_SIG) {
      corrupt();
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    if (cursor + 46 + nameLength + extraLength + commentLength > buffer.length) {
      corrupt();
    }

    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) {
      continue;
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError(t('mod_zip_unsupported_compression'));
    }
    if (flags & 1) {
      throw new ZipError(t('mod_zip_encrypted_entries'));
    }
    if (isUnsafe(name)) {
      throw new ZipError(t('mod_zip_unsafe_path', { value1: name }));
    }
    if (seen.has(name)) {
      throw new ZipError(t('mod_zip_duplicate_entry', { value1: name }));
    }
    if (size > limits.maxEntryBytes) {
      throw new ZipError(t('mod_zip_entry_too_large', { value1: name }));
    }
    if (total + size > limits.maxTotalBytes) {
      throw new ZipError(t('mod_zip_archive_too_large'));
    }

    // The local header repeats the name/extra lengths; use those, not the central ones.
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOC_SIG) {
      corrupt();
    }

    const dataAt = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);

    if (dataAt + compSize > buffer.length) {
      corrupt();
    }

    const packed = buffer.subarray(dataAt, dataAt + compSize);
    let data: Buffer;

    try {
      data =
        method === 8
          ? inflateRawSync(packed, { maxOutputLength: Math.min(limits.maxEntryBytes, size + 1) })
          : Buffer.from(packed);
    } catch {
      throw new ZipError(t('mod_zip_corrupt_entry', { value1: name }));
    }

    if (data.length !== size) {
      throw new ZipError(t('mod_zip_corrupt_entry', { value1: name }));
    }

    seen.add(name);
    total += size;
    entries.push({ name, size, data });
  }

  return entries;
}
