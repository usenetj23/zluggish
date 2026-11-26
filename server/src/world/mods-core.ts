// Behaviour follows src/mods-core.mjs of Sauce for Zwift (https://github.com/SauceLLC/sauce4zwift, GPL-3.0):
// the manifest schema of Sauce mods, so Sauce mods load unchanged.
import { t } from '#src/i18n/index';
import { Option, Schema } from 'effect';

export class ModValidationError extends TypeError {
  readonly path: ReadonlyArray<string>;

  readonly key: string | undefined;

  constructor(path: ReadonlyArray<string>, key: string | undefined, message: string) {
    super(message);
    this.name = 'ModValidationError';
    this.path = path;
    this.key = key;
  }
}

export function isSafePath(value: string): boolean {
  return /^[a-z0-9]+[a-z0-9_\-./]*$/i.test(value) && !value.includes('..');
}

export function isSafeId(value: string): boolean {
  return /^[a-z0-9-_]+$/i.test(value);
}

export function sanitizeId(value: string): string {
  return value.replaceAll(/[^a-z0-9\-_]/gi, '-');
}

export interface ModWindow {
  file: string;
  id: string;
  name: string;
  description?: string;
  query?: Record<string, string>;
  always_visible?: boolean;
  overlay?: boolean;
  frame?: boolean;
  default_bounds?: { width?: number; height?: number; x?: number; y?: number; aspect_ratio?: number };
}

export interface ModManifest {
  manifest_version: 1;
  id?: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  website_url?: string;
  web_root?: string;
  content_js?: Array<string>;
  content_css?: Array<string>;
  windows?: Array<ModWindow>;
}

/** One value of a manifest: the manifest is JSON. */
type ManifestValue = typeof Schema.Json.Type;

interface Descriptor {
  readonly type: 'string' | 'number' | 'boolean' | 'object';
  readonly required?: boolean;
  readonly unique?: boolean;
  readonly isArray?: boolean;
  readonly deprecated?: boolean;
  readonly valid?: (value: ManifestValue) => boolean;
  readonly schema?: Readonly<Record<string, Descriptor>>;
}

const DEFAULT_BOUNDS_SCHEMA = {
  width: { type: 'number', valid: (v) => typeof v === 'number' && v >= 0 },
  height: { type: 'number', valid: (v) => typeof v === 'number' && v >= 0 },
  x: { type: 'number' },
  y: { type: 'number' },
  aspect_ratio: { type: 'number', valid: (v) => typeof v === 'number' && v > 0 },
} satisfies Readonly<Record<string, Descriptor>>;

const WINDOWS_SCHEMA = {
  file: { type: 'string', required: true, unique: true, valid: (v) => typeof v === 'string' && isSafePath(v) },
  query: { type: 'object', schema: { '*': { type: 'string' } } },
  id: { type: 'string', required: true, unique: true },
  name: { type: 'string', required: true, unique: true },
  description: { type: 'string' },
  always_visible: { type: 'boolean', deprecated: true },
  overlay: { type: 'boolean' },
  frame: { type: 'boolean' },
  default_bounds: { type: 'object', schema: DEFAULT_BOUNDS_SCHEMA },
} satisfies Readonly<Record<string, Descriptor>>;

const MANIFEST_SCHEMA = {
  manifest_version: { type: 'number', required: true, valid: (v) => v === 1 },
  id: { type: 'string', valid: (v) => typeof v === 'string' && isSafeId(v) },
  name: { type: 'string', required: true },
  description: { type: 'string', required: true },
  version: { type: 'string', required: true },
  author: { type: 'string' },
  website_url: { type: 'string' },
  web_root: { type: 'string', valid: (v) => typeof v === 'string' && isSafePath(v) },
  content_js: { type: 'string', isArray: true, valid: (v) => typeof v === 'string' && isSafePath(v) },
  content_css: { type: 'string', isArray: true, valid: (v) => typeof v === 'string' && isSafePath(v) },
  windows: { type: 'object', isArray: true, schema: WINDOWS_SCHEMA },
} satisfies Readonly<Record<string, Descriptor>>;

const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

function matchesType(value: ManifestValue, type: Descriptor['type']): boolean {
  if (type === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  return typeof value === type;
}

function validateDescriptor(
  value: ManifestValue,
  descriptor: Descriptor,
  path: ReadonlyArray<string>,
  key: string,
  warnings: Array<string>,
): void {
  if (descriptor.isArray && !Array.isArray(value)) {
    throw new ModValidationError(path, key, t('mod_manifest_invalid_type_expected_array'));
  }
  const items: ReadonlyArray<ManifestValue> = descriptor.isArray && Array.isArray(value) ? value : [value];
  const uniqueSeen = new Map<string, Set<ManifestValue>>();
  for (const [index, item] of items.entries()) {
    const pathKey = descriptor.isArray ? `${key}[${index}]` : key;
    if (descriptor.deprecated) {
      warnings.push(t('mod_manifest_deprecated_field', { value1: [...path, pathKey].join('.') }));
    }
    if (!matchesType(item, descriptor.type)) {
      throw new ModValidationError(path, pathKey, t('mod_manifest_invalid_type_expected', { value1: descriptor.type }));
    }
    if (descriptor.valid && !descriptor.valid(item)) {
      throw new ModValidationError(path, pathKey, t('mod_manifest_invalid_value', { value1: String(item) }));
    }
    if (descriptor.schema) {
      validateObject(item, descriptor.schema, [...path, pathKey], warnings, uniqueSeen);
    }
  }
}

function validateObject(
  value: ManifestValue,
  schema: Readonly<Record<string, Descriptor>>,
  path: ReadonlyArray<string>,
  warnings: Array<string>,
  uniqueSeen: Map<string, Set<ManifestValue>>,
): void {
  const record = Option.getOrThrowWith(
    decodeObject(value),
    () => new ModValidationError(path, undefined, t('mod_manifest_root_not_object')),
  );
  for (const [key, field] of Object.entries(record)) {
    const descriptor = schema[key] ?? (key === '*' ? undefined : schema['*']);
    if (!descriptor) {
      throw new ModValidationError(path, key, t('mod_manifest_unexpected_key'));
    }
    validateDescriptor(field, descriptor, path, key, warnings);
    if (!descriptor.unique) {
      continue;
    }
    const seen = uniqueSeen.get(key) ?? new Set<ManifestValue>();
    uniqueSeen.set(key, seen);
    if (seen.has(field)) {
      throw new ModValidationError(path, key, t('mod_manifest_duplicate_value', { value1: String(field) }));
    }
    seen.add(field);
  }
  const missing = Object.entries(schema)
    .filter(([key, descriptor]) => key !== '*' && descriptor.required && !Object.hasOwn(record, key))
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new ModValidationError(path, undefined, t('mod_manifest_missing_keys', { value1: missing.join(',') }));
  }
}

/** A checked manifest and the warnings of its deprecated fields. */
export interface ManifestCheck {
  manifest: ModManifest;
  warnings: Array<string>;
}

/** Whether `value` is a manifest; a value that is none raises `ModValidationError` instead of answering false. */
function isManifest(value: unknown, warnings: Array<string>): value is ModManifest {
  const json = Option.getOrThrowWith(
    Schema.decodeUnknownOption(Schema.Json)(value),
    () => new ModValidationError([], undefined, t('mod_manifest_root_not_object')),
  );
  validateObject(json, MANIFEST_SCHEMA, [], warnings, new Map<string, Set<ManifestValue>>());
  return true;
}

export function validateManifest(value: unknown): ManifestCheck {
  const warnings: Array<string> = [];
  if (!isManifest(value, warnings)) {
    throw new ModValidationError([], undefined, t('mod_manifest_root_not_object'));
  }
  return { manifest: value, warnings };
}
