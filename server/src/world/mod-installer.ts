import { t } from '#src/i18n/index';
// Installs a mod archive into the mods root. Everything is staged in a dot-prefixed
// directory and moved into place atomically; state.json is never touched, so a
// replaced mod shows as 'changed' until an administrator approves it again.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isSafeId, isSafePath, sanitizeId, validateManifest } from '#src/world/mods-core';
import { readZip } from '#src/world/zip-reader';
import type { ZipEntry, ZipLimits } from '#src/world/zip-reader';

export interface InstallResult {
  id: string;
  replaced: boolean;
  skipped: number;
}

const MAX_MANIFEST_BYTES = 256 * 1024;

// '' when manifest.json is at the archive root, otherwise 'SomeDir/'.
function findPrefix(entries: Array<ZipEntry>): string {
  if (entries.some((entry) => entry.name === 'manifest.json')) {
    return '';
  }

  const [first] = entries;
  const [segment] = first?.name.split('/') ?? [];

  if (!segment || entries.some((entry) => !entry.name.startsWith(`${segment}/`))) {
    throw new Error(t('mod_install_no_manifest'));
  }
  if (entries.every((entry) => entry.name !== `${segment}/manifest.json`)) {
    throw new Error(t('mod_install_no_manifest'));
  }

  return `${segment}/`;
}

export function installModZip(root: string, archive: Buffer, limits?: ZipLimits): InstallResult {
  const entries = readZip(archive, limits);
  const prefix = findPrefix(entries);
  const files = entries.map((entry) => ({ ...entry, name: entry.name.slice(prefix.length) }));

  // Manifest: size-capped, parsed, then schema-validated (ModValidationError propagates).
  const manifestEntry = files.find((entry) => entry.name === 'manifest.json');

  if (!manifestEntry) {
    throw new Error(t('mod_install_no_manifest'));
  }
  if (manifestEntry.data.length > MAX_MANIFEST_BYTES) {
    throw new Error(t('mod_install_manifest_too_large'));
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    throw new Error(t('mod_install_manifest_not_json'));
  }

  const { manifest } = validateManifest(parsed);
  // A GitHub archive is rooted in `<repo>-<ref>/`: without an id in the manifest the folder name is the id, minus `-HEAD`.
  const id =
    manifest.id ?? sanitizeId(prefix ? prefix.slice(0, -1).replace(/-HEAD$/, '') : manifest.name.toLowerCase());

  if (!isSafeId(id)) {
    throw new Error(t('mod_install_unusable_mod_id'));
  }

  // Repository archives carry files that could never be served (.github/, .gitignore,
  // names with spaces, ...). Skipping them keeps the install working; unsafe names are
  // still never written anywhere.
  const kept = files.filter(
    (entry) => isSafePath(entry.name) && entry.name.split('/').every((segment) => !segment.startsWith('.')),
  );
  const skipped = files.length - kept.length;

  mkdirSync(root, { recursive: true });

  // Dot-prefixed staging directory: the registry ignores it until the rename lands.
  const staging = join(root, `.incoming-${id}-${process.pid}-${Date.now()}`);

  try {
    mkdirSync(staging, { recursive: true });

    for (const entry of kept) {
      const target = join(staging, entry.name);

      if (!resolve(target).startsWith(`${resolve(staging)}${sep}`) && resolve(target) !== staging) {
        throw new Error(t('mod_install_path_escape'));
      }

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data, { mode: 0o644 });
    }

    const destination = join(root, id);
    const replaced = existsSync(destination);

    if (replaced) {
      const old = join(root, `.old-${id}-${process.pid}-${Date.now()}`);

      renameSync(destination, old);
      renameSync(staging, destination);
      rmSync(old, { recursive: true, force: true });
    } else {
      renameSync(staging, destination);
    }

    return { id, replaced, skipped };
  } catch (error) {
    if (existsSync(staging)) {
      rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
}
