import { t } from '#src/i18n/index';
import { CryptoRepository } from '#src/repositories/crypto.repository';

/** The part of `fetch` the store uses: manual redirects, so every hop is checked against the allow-list. */
export type FetchLike = (
  url: string,
  init: { redirect: 'manual'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export interface StoreRelease {
  version: string;
  url: string;
  hash: string;
  size: number;
  minVersion: string | null;
  updated: number | null;
  notes: string | null;
}

export interface StoreMod {
  id: string;
  name: string;
  description: string;
  tags: Array<string>;
  homeURL: string | null;
  authorURL?: string | null;
  logoURL: string | null;
  releases: Array<StoreRelease>;
}

export const storeDirectoryUrl = 'https://raw.githubusercontent.com/SauceLLC/sauce4zwift-mod-store/main/directory.json';

export const storeHosts: ReadonlySet<string> = new Set([
  'raw.githubusercontent.com',
  'mod-api.sauce.llc',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

const DEFAULT_MAX_ARCHIVE_BYTES = 50_000_000;
const DEFAULT_CACHE_MS = 600_000;
const MAX_DIRECTORY_BYTES = 2_000_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 20_000;

const REQUEST_HEADERS = {
  'User-Agent': 'ZluggishOverlay/1.0 (self-hosted mod installer)',
  Accept: '*/*',
} satisfies Record<string, string>;

const HASH_PATTERN = /^[0-9a-f]{64}$/i;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_PATTERN = /^[\w./-]{1,100}$/;

const GITHUB_REPO_URL = /(?:github\.com|raw\.githubusercontent\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/;

/** The GitHub `owner/repo` a store mod points at: the first of `homeURL`, `authorURL`, `logoURL` that
looks like a GitHub link, with a trailing `.git` stripped; null when none of them does. */
export function githubRepoOf(mod: StoreMod): string | null {
  for (const url of [mod.homeURL, mod.authorURL, mod.logoURL]) {
    if (typeof url !== 'string') {
      continue;
    }

    const [, owner, name] = GITHUB_REPO_URL.exec(url) ?? [];

    if (owner !== undefined && name !== undefined) {
      const strip = (part: string) => (part.endsWith('.git') ? part.slice(0, -'.git'.length) : part);

      return `${strip(owner)}/${strip(name)}`;
    }
  }

  return null;
}

/**
The repository (and maybe the ref) a pasted GitHub input points at. Accepted: a bare
`owner/name`; `github.com/owner/name` with or without a scheme (`https://`, `http://`,
`www.github.com`) and with a trailing slash, `.git`, query or fragment; the ssh form
`git@github.com:owner/name.git`; and the same repository behind one of the GitHub paths that
name a ref: `/tree/<ref>[/...]`, `/releases/tag/<tag>`, `/blob/<ref>/...`,
`/archive/refs/heads/<ref>.zip`, `/archive/refs/tags/<tag>.zip` or `/archive/<ref>.zip` —
the ref is the first path segment after `tree`/`blob`, the whole tag after `releases/tag`,
the archived path with its `.zip` stripped. Surrounding whitespace is trimmed. Owner and
name must match `[A-Za-z0-9_.-]+`; anything else (other hosts, `a/b/c`, junk) is null.
*/
export function parseGitHubInput(input: string): { repo: string; ref?: string } | null {
  const text = input.trim();

  if (text.length === 0) {
    return null;
  }

  // Without a scheme an input of one word could be a host ('example.com') or junk; an input with
  // a '/' is a path. Only 'github.com/<path>' and a bare path are repository shapes; a bare path
  // of three or more segments ('a/b/c') is no repository at all.
  let candidate: string;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    candidate = text;
  } else {
    const host = /^[A-Za-z0-9_.-]+/.exec(text)?.[0] ?? '';

    if (host === 'github.com' || host === 'www.github.com') {
      candidate = `https://${text}`;
    } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]/.test(text)) {
      if (text.split('/').filter((segment) => segment.length > 0).length !== 2) {
        return null;
      }

      candidate = `https://github.com/${text}`;
    } else {
      candidate = `https://${text}`;
    }
  }

  // The ssh form: git@github.com:owner/name(.git) — ':' is its path separator.
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text);

  if (ssh !== null) {
    return { repo: `${ssh[1]}/${ssh[2]}` };
  }

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return null;
  }

  const [owner = '', given = '', ...rest] = url.pathname.split('/').filter((segment) => segment.length > 0);
  const name = given.endsWith('.git') ? given.slice(0, -'.git'.length) : given;

  if (owner.length === 0 || name.length === 0 || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) {
    return null;
  }

  const repo = `${owner}/${name}`;
  const [kind, second, third, fourth] = rest;

  if (kind === 'tree' || kind === 'blob') {
    // A ref with slashes is not known where it ends: take the first segment after the marker.
    return second === undefined ? { repo } : { repo, ref: second };
  }

  if (kind === 'releases' && second === 'tag' && third !== undefined) {
    return { repo, ref: third };
  }

  if (kind === 'archive') {
    if (second === 'refs' && (third === 'heads' || third === 'tags') && fourth !== undefined) {
      return { repo, ref: withoutZip(fourth) };
    }

    if (second !== undefined && rest.length === 2) {
      return { repo, ref: withoutZip(second) };
    }
  }

  return { repo };
}

const withoutZip = (value: string): string => (value.endsWith('.zip') ? value.slice(0, -'.zip'.length) : value);

/** The fields of one JSON object of the store directory; anything else has none. */
function fieldsOf(value: unknown): ReadonlyMap<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? new Map(Object.entries(value)) : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

function asNullableText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asHttpsUrl(value: unknown, hosts: ReadonlySet<string>): string | null {
  const text = asText(value);
  if (text === null) {
    return null;
  }
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' && hosts.has(parsed.hostname) ? text : null;
  } catch {
    return null;
  }
}

function asHttpUrl(value: unknown): string | null {
  const text = asText(value);
  return text !== null && text.startsWith('https://') ? text : null;
}

function asTags(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    : [];
}

function asFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** True for abort/timeout rejections (DOMException names AbortError/TimeoutError, also as `cause`). */
function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const names: Array<string> = [error.name];
  if (error.cause instanceof Error) {
    names.push(error.cause.name);
  }
  return names.includes('AbortError') || names.includes('TimeoutError');
}

/** Streams the body chunk by chunk, cancelling the reader as soon as the running total exceeds maxBytes. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (body === null) {
    return Buffer.alloc(0);
  }

  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(t('mod_store_download_too_large'));
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

export class ModStore {
  private readonly fetchImpl: FetchLike;

  private readonly directoryUrl: string;

  private readonly hosts: ReadonlySet<string>;

  private readonly maxArchiveBytes: number;

  private readonly cacheMs: number;

  private readonly now: () => number;

  private readonly crypto = new CryptoRepository();

  private cache: { mods: Array<StoreMod>; at: number } | null = null;

  constructor(options?: {
    fetch?: FetchLike;
    now?: () => number;
    directoryUrl?: string;
    hosts?: ReadonlySet<string>;
    maxArchiveBytes?: number;
    cacheMs?: number;
  }) {
    this.fetchImpl = options?.fetch ?? ((url, init) => fetch(url, init));
    this.now = options?.now ?? ((): number => Date.now());
    this.directoryUrl = options?.directoryUrl ?? storeDirectoryUrl;
    this.hosts = options?.hosts ?? storeHosts;
    this.maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    this.cacheMs = options?.cacheMs ?? DEFAULT_CACHE_MS;
  }

  /** https + allow-list fetch with manual redirects and a hard byte cap. */
  private async get(url: string, maxBytes: number): Promise<Buffer> {
    let current = url;

    for (let hop = 0; ; hop += 1) {
      if (asHttpsUrl(current, this.hosts) === null) {
        throw new Error(t('mod_store_host_not_allowed'));
      }

      let response: Response;
      try {
        response = await this.fetchImpl(current, {
          redirect: 'manual',
          headers: REQUEST_HEADERS,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        // A network/DNS/TLS failure of the fetch itself must not leak as a 500; the errors this
        // method throws on purpose ('host not allowed', 'download too large', 'download failed: HTTP n')
        // never originate here. Never leak the original error text or the full URL.
        const host = new URL(current).hostname;
        if (isAbortLike(error)) {
          throw new Error(t('mod_store_download_timed_out', { value1: host }), { cause: error });
        }
        throw new Error(t('mod_store_download_unreachable', { value1: host }), { cause: error });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (hop >= MAX_REDIRECTS || location === null) {
          throw new Error(t('mod_store_download_failed_http', { value1: response.status }));
        }
        try {
          current = new URL(location, current).href;
        } catch {
          throw new Error(t('mod_store_download_failed_http', { value1: response.status }));
        }
        continue;
      }

      if (response.status !== 200) {
        throw new Error(t('mod_store_download_failed_http', { value1: response.status }));
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(t('mod_store_download_too_large'));
      }

      return await readCapped(response, maxBytes);
    }
  }

  /** Cached JSON directory, parsed defensively; only successful results are cached. */
  async directory(): Promise<Array<StoreMod>> {
    if (this.cache !== null && this.now() - this.cache.at < this.cacheMs) {
      return this.cache.mods;
    }

    const body = await this.get(this.directoryUrl, MAX_DIRECTORY_BYTES);
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(parsed)) {
      throw new TypeError(t('mod_store_unexpected_store_directory'));
    }

    const mods = parsed
      .map((entry): StoreMod | null => this.toMod(entry))
      .filter((mod): mod is StoreMod => mod !== null)
      .sort((left, right) => left.name.localeCompare(right.name));

    this.cache = { mods, at: this.now() };
    return mods;
  }

  /** Downloads one release and verifies its size and SHA-256. */
  async download(
    storeId: string,
    version?: string,
  ): Promise<{ mod: StoreMod; release: StoreRelease; archive: Buffer }> {
    const mods = await this.directory();
    const mod = mods.find((candidate) => candidate.id === storeId);
    if (!mod) {
      throw new Error(t('mod_store_unknown_store_mod'));
    }

    const release = version ? mod.releases.find((item) => item.version === version) : mod.releases[0];
    if (!release) {
      throw new Error(t('mod_store_unknown_release'));
    }

    const archive = await this.get(release.url, Math.min(release.size + 1024, this.maxArchiveBytes));
    if (archive.length !== release.size) {
      throw new Error(t('mod_store_size_mismatch'));
    }
    if (this.crypto.sha256(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength)) !== release.hash) {
      throw new Error(t('mod_store_hash_mismatch'));
    }

    return { mod, release, archive };
  }

  /**
  Downloads a repository zip archive from codeload.github.com (the store host
  currently rejects TLS and many mods live in GitHub repositories anyway).
  A ref starting with 'v' followed by a digit (v1.2.3) or made of digits and
  dots only (1.2) is treated as a TAG (refs/tags/...); anything else is a
  branch (refs/heads/...); the default 'HEAD' means the default branch.
  Repository archives have no published hash: none is checked here; the
  administrator approves the mod on enable and the registry pins its hash.
  */
  async downloadGitHub(repo: string, ref = 'HEAD'): Promise<{ repo: string; ref: string; archive: Buffer }> {
    if (!REPOSITORY_PATTERN.test(repo) || repo.includes('..') || repo.startsWith('.') || repo.endsWith('.')) {
      throw new Error(t('mod_store_invalid_repository'));
    }

    const wanted = ref;
    if (!REF_PATTERN.test(wanted) || wanted.includes('..')) {
      throw new Error(t('mod_store_invalid_ref'));
    }

    let location: string;
    if (wanted === 'HEAD') {
      location = 'HEAD';
    } else if (/^v\d/.test(wanted) || /^\d+(\.\d+)+$/.test(wanted)) {
      location = `refs/tags/${wanted}`;
    } else {
      location = `refs/heads/${wanted}`;
    }

    const archive = await this.get(`https://codeload.github.com/${repo}/zip/${location}`, this.maxArchiveBytes);
    return { repo, ref: wanted, archive };
  }

  private toMod(entry: unknown): StoreMod | null {
    const raw = fieldsOf(entry);
    const id = asNullableText(raw?.get('id'));
    const name = asNullableText(raw?.get('name'));
    if (raw === null || id === null || name === null) {
      return null;
    }

    const listed = raw.get('releases');
    const releasesRaw: ReadonlyArray<unknown> = Array.isArray(listed) ? listed : [];
    const releases = releasesRaw
      .values()
      .map((item): StoreRelease | null => this.toRelease(item))
      .filter((release): release is StoreRelease => release !== null)
      .toArray()
      .sort((left, right) => (right.updated ?? -1) - (left.updated ?? -1));
    if (releases.length === 0) {
      return null;
    }

    return {
      id,
      name,
      description: asText(raw.get('description')) ?? '',
      tags: asTags(raw.get('tags')),
      homeURL: asHttpUrl(raw.get('homeURL')),
      logoURL: asHttpUrl(raw.get('logoURL')),
      releases,
    };
  }

  private toRelease(item: unknown): StoreRelease | null {
    const raw = fieldsOf(item);
    const version = asNullableText(raw?.get('version'));
    const url = raw ? asHttpsUrl(raw.get('url'), this.hosts) : null;
    const hash = asText(raw?.get('hash'));
    if (raw === null || version === null || url === null || hash === null || !HASH_PATTERN.test(hash)) {
      return null;
    }

    const size = asFiniteNumberOrNull(raw.get('size'));
    if (size === null || size <= 0 || size > this.maxArchiveBytes) {
      return null;
    }

    return {
      version,
      url,
      hash: hash.toLowerCase(),
      size,
      minVersion: asNullableText(raw.get('minVersion')),
      updated: asFiniteNumberOrNull(raw.get('updated')),
      notes: asNullableText(raw.get('notes')),
    };
  }
}
