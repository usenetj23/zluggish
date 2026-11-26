import { t } from '#src/i18n/index';
import { Option, Schema } from 'effect';
import { isSafeId, isSafePath, ModValidationError, validateManifest } from '#src/world/mods-core';
import type { ModManifest } from '#src/world/mods-core';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import type { ModContent } from '#src/world/mod-content';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';

export type ModStatus = 'active' | 'disabled' | 'changed' | 'invalid';

export interface ModFileInfo {
  path: string;
  size: number;
}

export interface ModEntry {
  id: string;
  dir: string;
  manifest: ModManifest | null;
  error: string | null;
  /** Server-side only: the FULL message of the failure behind `error` (an `ENOENT ...` carries an
  absolute path). Never put it in a response: `error` is the sanitized, path-free text meant for a
  viewer, `detail` is what an operator reading a log or a debug endpoint would want. */
  detail: string | null;
  warnings: Array<string>;
  status: ModStatus;
  enabled: boolean;
  /** Per-mod permission: may this mod reach the internet (false when the state has no such flag). */
  network: boolean;
  hash: string;
  approvedHash: string | null;
  files: Array<ModFileInfo>;
}

interface ModState {
  enabled?: boolean;
  approvedHash?: string;
  network?: boolean;
}

/** `storage/mods/state.json`: the state of every mod by id; a broken file is no state at all. */
const decodeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        approvedHash: Schema.optionalKey(Schema.String),
        network: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
);

/** One window of an enabled mod, in the shape of `getWebWindowManifests`. */
export interface ModWindowManifest {
  type: string;
  file: string;
  mod: true;
  modId: string;
  query: Readonly<Record<string, string>> | undefined;
  groupTitle: string;
  prettyName: string;
  prettyDesc: string | undefined;
  options: {
    width: number | undefined;
    height: number | undefined;
    x: number | undefined;
    y: number | undefined;
    aspectRatio: number | undefined;
    frame: boolean | undefined;
  };
  overlay: boolean | undefined;
}

/** The files of one mod folder and their total size, as `collect` walks it. */
interface CollectedFiles {
  files: Array<ScannedFile>;
  total: number;
}

interface BuiltMod {
  fingerprint: string;
  manifest: ModManifest;
  warnings: Array<string>;
  files: Array<ModFileInfo>;
  hash: string;
}

interface ScannedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

const MANIFEST_CAP = 256 * 1024;
const FILE_CAP = 5000;
const TOTAL_CAP = 100 * 1024 * 1024;
const READ_CAP = 20 * 1024 * 1024;

function inside(realpath: string, parent: string): boolean {
  return realpath === parent || realpath.startsWith(parent + sep);
}

function messageOf(error: unknown): string {
  if (error instanceof ModValidationError) {
    return `${[...error.path, error.key].filter((part): part is string => !!part).join('.')}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}

// `messageOf` is the full message: an fs failure names the file it stat()ed, so it carries an
// absolute server path and must never reach a viewer.
const UNREADABLE_MANIFEST = t('mod_registry_manifest_missing');
const BROKEN_MANIFEST = t('mod_install_manifest_not_json');
const BROKEN_MANIFEST_FALLBACK = t('mod_registry_manifest_unreadable');

// The fs codes of a manifest that cannot be opened (missing, denied, a path component that is not a
// directory, a symlink loop, a name too long); every one of their messages quotes the absolute path.
const UNREADABLE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

function hasPath(text: string): boolean {
  return text.includes('/') || text.includes('\\');
}

/**
The entry's `error` as it leaves the process: a short, path-free reason. A missing or unreadable
manifest, a manifest that is not JSON and an fs failure are mapped to fixed sentences; a schema
failure keeps its field-level text (`bogus: Unexpected key`) unless that text itself quotes a path,
which the `valid` checks of a `content_js` / `web_root` / window `file` value can do.
*/
function describeManifestFailure(error: unknown): string {
  if (error instanceof ModValidationError) {
    const field = [...error.path, error.key].filter((part): part is string => !!part).join('.');
    const text = hasPath(error.message) ? t('mod_registry_invalid_value') : error.message;

    return field.length > 0 ? `${field}: ${text}` : text;
  }

  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

  if (typeof code === 'string' && UNREADABLE_CODES.has(code)) {
    return UNREADABLE_MANIFEST;
  }
  if (error instanceof SyntaxError) {
    return BROKEN_MANIFEST;
  }

  const message = error instanceof Error ? error.message : String(error);

  // `manifest too large`, `mod too large`: their own words are already path-free.
  return hasPath(message) ? BROKEN_MANIFEST_FALLBACK : message;
}

export class ModRegistry {
  private readonly crypto = new CryptoRepository();

  /** Per mod directory, the manifest/files/hash of the last scan, keyed by the directory path and
  guarded by a fingerprint of it (relative path + size + mtimeMs of every file, from stat alone).
  The SHA-256 of up to 100 MB is expensive, and every `/mods/...` request used to pay for it 3-4
  times; the fingerprint makes the repeat calls cost only stat(). */
  private readonly built = new Map<string, BuiltMod>();

  /** How many file contents the registry itself has read (the SHA-256 pass). A test hook for the
  cache: a second `list()`/`get()` over an unchanged directory must not raise it. */
  private contentReads = 0;

  reads(): number {
    return this.contentReads;
  }

  constructor(readonly root: string) {}

  list(): Array<ModEntry> {
    const entries: Array<ModEntry> = [];

    if (!existsSync(this.root)) {
      return entries;
    }

    const rootReal = realpathSync(this.root);
    const state = this.readState();
    const claims = new Set<string>();

    for (const name of readdirSync(this.root)
      .filter((name) => isSafeId(name))
      .sort()) {
      const dir = join(this.root, name);

      try {
        if (!statSync(dir).isDirectory()) {
          continue;
        }

        if (!inside(realpathSync(dir), rootReal)) {
          continue;
        }
      } catch {
        continue;
      }

      let parsed: BuiltMod | null = null;
      let failure: Error | null = null;

      try {
        parsed = this.scan(dir);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }

      const claimed = parsed?.manifest.id ?? name;

      if (claims.has(claimed)) {
        entries.push(this.invalid(dir, name, t('mod_registry_duplicate_mod_id'), t('mod_registry_duplicate_mod_id')));
        continue;
      }
      claims.add(claimed);

      const entry = parsed
        ? this.build(dir, claimed, parsed)
        : this.invalid(dir, name, describeManifestFailure(failure), messageOf(failure));
      const saved = state.get(entry.id);

      entry.approvedHash = typeof saved?.approvedHash === 'string' ? saved.approvedHash : null;
      // A changed hash never resets the network permission: it is a per-mod choice, not per-content.
      entry.network = saved?.network === true;

      if (entry.status === 'invalid' || saved?.enabled !== true) {
        entry.enabled = false;
      } else if (entry.approvedHash === entry.hash) {
        entry.status = 'active';
        entry.enabled = true;
      } else {
        entry.status = 'changed';
        entry.enabled = false;
      }

      entries.push(entry);
    }

    return entries;
  }

  get(id: string): ModEntry | undefined {
    return this.list().find((entry) => entry.id === id);
  }

  setEnabled(id: string, enabled: boolean, expectedHash?: string): ModEntry {
    const entry = this.get(id);

    if (!entry) {
      throw new Error(t('mod_registry_unknown_mod'));
    }

    if (enabled && entry.status === 'invalid') {
      throw new Error(t('mod_registry_invalid_mod', { value1: entry.error ?? t('mod_registry_unknown_error') }));
    }

    // Enabling runs the mod same-origin with the administrator's session, so the administrator must
    // approve exactly the content they reviewed: the hash they were shown is required and must still
    // be the hash on disk.
    if (enabled && (typeof expectedHash !== 'string' || expectedHash !== entry.hash)) {
      throw new Error(t('mod_registry_changed_since_review'));
    }

    const state = this.readState();

    if (enabled) {
      state.set(entry.id, { enabled: true, approvedHash: entry.hash });
    } else {
      state.set(
        entry.id,
        entry.approvedHash === null ? { enabled: false } : { enabled: false, approvedHash: entry.approvedHash },
      );
    }

    this.writeState(state);

    const fresh = this.get(id);

    if (!fresh) {
      throw new Error(t('mod_registry_unknown_mod'));
    }

    return fresh;
  }

  /** Flips the per-mod internet permission. Unlike `setEnabled` it needs no hash and never touches
  `enabled`/`approvedHash`; a mod without a state record gets one (enabled false). */
  setNetwork(id: string, allowed: boolean): void {
    const entry = this.get(id);

    if (!entry) {
      throw new Error(t('mod_registry_unknown_mod'));
    }

    const state = this.readState();
    const saved = state.get(entry.id) ?? {};

    state.set(entry.id, { ...saved, network: allowed });

    this.writeState(state);
  }

  remove(id: string): void {
    const entry = this.get(id);

    if (!entry) {
      throw new Error(t('mod_registry_unknown_mod'));
    }

    const rootReal = realpathSync(this.root);
    let dirReal: string;

    try {
      dirReal = realpathSync(entry.dir);
    } catch {
      throw new Error(t('mod_registry_remove_outside_folder'));
    }

    if (!dirReal.startsWith(rootReal + sep) || !lstatSync(entry.dir).isDirectory()) {
      throw new Error(t('mod_registry_remove_outside_folder'));
    }

    rmSync(entry.dir, { recursive: true });

    const state = this.readState();

    state.delete(id);
    this.writeState(state);
  }

  windowManifests(): Array<ModWindowManifest> {
    const windows: Array<ModWindowManifest> = [];

    for (const entry of this.list()) {
      if (entry.status !== 'active' || !entry.manifest?.windows) {
        continue;
      }

      for (const window of entry.manifest.windows) {
        const bounds = window.default_bounds ?? {};

        windows.push({
          type: `${entry.id}-${window.id}`,
          file: `/mods/${entry.id}/${window.file}`,
          mod: true,
          modId: entry.id,
          query: window.query,
          groupTitle: `[MOD]: ${entry.manifest.name}`,
          prettyName: window.name,
          prettyDesc: window.description,
          options: {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            aspectRatio: bounds.aspect_ratio,
            frame: window.frame,
          },
          overlay: window.overlay,
        });
      }
    }

    return windows;
  }

  fileOf(id: string, path: string): { absolute: string; size: number } | null {
    const entry = this.get(id);

    if (!entry) {
      return null;
    }

    return this.entryFileOf(entry, path);
  }

  contentFiles(): ModContent {
    const scripts: Array<string> = [];
    const styles: Array<string> = [];

    for (const entry of this.list()) {
      if (entry.status !== 'active' || !entry.manifest) {
        continue;
      }

      for (const file of this.contentPaths(entry)) {
        scripts.push(`/mods/${entry.id}/${file}`);
      }
      for (const file of this.contentPaths(entry, 'content_css')) {
        styles.push(`/mods/${entry.id}/${file}`);
      }
    }

    return { scripts, styles };
  }

  isContentFile(id: string, path: string): boolean {
    const entry = this.get(id);

    if (!entry || entry.status !== 'active' || !entry.manifest) {
      return false;
    }

    return this.entryIsContentFile(entry, path);
  }

  /** The declared `content_js` (default) or `content_css` paths of an entry, no filesystem work.
  A route that already resolved the entry uses these instead of the `id`-based helpers, so one
  request pays for the (cached) scan once. */
  contentPaths(entry: ModEntry, key: 'content_js' | 'content_css' = 'content_js'): Array<string> {
    return entry.manifest?.[key] ?? [];
  }

  entryIsContentFile(entry: ModEntry, path: string): boolean {
    return (
      entry.status === 'active' &&
      !!entry.manifest &&
      (this.contentPaths(entry).includes(path) || this.contentPaths(entry, 'content_css').includes(path))
    );
  }

  /** `fileOf` for an entry the caller already resolved. */
  entryFileOf(entry: ModEntry, path: string): { absolute: string; size: number } | null {
    if (entry.status !== 'active' || !isSafePath(path)) {
      return null;
    }

    const dirReal = realpathSync(entry.dir);
    const absolute = join(dirReal, path);

    if (!absolute.startsWith(dirReal + sep) || !existsSync(absolute)) {
      return null;
    }

    const real = realpathSync(absolute);
    const stats = statSync(real);

    if (!stats.isFile() || !inside(real, dirReal) || stats.size > READ_CAP) {
      return null;
    }

    return { absolute: real, size: stats.size };
  }

  /** Drops the cached hash/files of every mod directory (or of one, when given). Called on any
  registry write so a state change never leaves an entry built from a stale directory behind. */
  invalidate(dir?: string): void {
    if (dir === undefined) {
      this.built.clear();
    } else {
      this.built.delete(dir);
    }
  }

  protected readState(): Map<string, ModState> {
    try {
      const parsed = decodeState(readFileSync(join(this.root, 'state.json'), 'utf8'));

      if (Option.isSome(parsed)) {
        return new Map(Object.entries(parsed.value));
      }
    } catch {
      // a missing or broken state behaves like an empty one
    }

    return new Map();
  }

  protected writeState(state: ReadonlyMap<string, ModState>): void {
    mkdirSync(this.root, { recursive: true });
    const target = join(this.root, 'state.json');
    writeFileSync(`${target}.tmp`, JSON.stringify(Object.fromEntries(state), null, 2), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
    // Any registry write (setEnabled, remove) drops the cache; a mod installed by the installer
    // changes the directory fingerprint and is recomputed by the same mechanism.
    this.built.clear();
  }

  private invalid(dir: string, name: string, error: string, detail: string): ModEntry {
    return {
      id: name,
      dir,
      manifest: null,
      error,
      detail,
      warnings: [],
      status: 'invalid',
      enabled: false,
      network: false,
      hash: '',
      approvedHash: null,
      files: [],
    };
  }

  /** The manifest, files and hash of a mod directory, recomputed only when the directory's cheap
  fingerprint (paths + sizes + mtimes from stat, no content read) changed. A failure (invalid
  manifest, oversized mod) is never cached: the next call tries again, exactly as before. */
  private scan(dir: string): BuiltMod {
    const scanned = this.collect(dir, [], 0).files.sort((a, b) => a.path.localeCompare(b.path));
    const fingerprint = scanned.map((file) => `${file.path}\0${file.size}\0${file.mtimeMs}`).join('\n');
    const cached = this.built.get(dir);

    if (cached && cached.fingerprint === fingerprint) {
      return cached;
    }

    const manifest = this.loadManifest(dir);
    let hash = '';

    for (const file of scanned) {
      this.contentReads += 1;
      hash += `${file.path}\n${this.crypto.sha256File(join(dir, file.path))}\n`;
    }

    hash = this.crypto.sha256(hash);

    const built: BuiltMod = {
      fingerprint,
      manifest: manifest.manifest,
      warnings: manifest.warnings,
      files: scanned.map((file) => ({ path: file.path, size: file.size })),
      hash,
    };

    this.built.set(dir, built);

    return built;
  }

  private loadManifest(dir: string): { manifest: ModManifest; warnings: Array<string> } {
    const file = join(dir, 'manifest.json');

    if (statSync(file).size > MANIFEST_CAP) {
      throw new Error(t('mod_registry_manifest_too_large'));
    }

    return validateManifest(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  }

  private build(dir: string, id: string, scanned: BuiltMod): ModEntry {
    return {
      id,
      dir,
      manifest: scanned.manifest,
      error: null,
      detail: null,
      warnings: scanned.warnings,
      status: 'disabled',
      enabled: false,
      network: false,
      hash: scanned.hash,
      approvedHash: null,
      files: scanned.files,
    };
  }

  private collect(dir: string, files: Array<ScannedFile>, total: number, prefix = ''): CollectedFiles {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) {
        continue;
      }

      const relative = prefix.length > 0 ? `${prefix}/${item.name}` : item.name;

      if (item.isDirectory()) {
        ({ files, total } = this.collect(join(dir, item.name), files, total, relative));
      } else if (item.isFile()) {
        const stats = statSync(join(dir, item.name));

        files.push({ path: relative, size: stats.size, mtimeMs: stats.mtimeMs });
        total += stats.size;

        if (files.length > FILE_CAP || total > TOTAL_CAP) {
          throw new Error(t('mod_registry_mod_too_large'));
        }
      }
    }

    return { files, total };
  }
}
