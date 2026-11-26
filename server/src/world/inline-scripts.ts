import { t } from '#src/i18n/index';
const MAX_INLINE_SCRIPTS = 20;
const MAX_INLINE_SCRIPT_CHARS = 256 * 1024;
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTRIBUTE = /\bsrc\s*=/i;

const MAX_INLINE_HANDLERS = 200;
const MAX_INLINE_HANDLER_CHARS = 16 * 1024;
const START_TAG = /<[a-zA-Z][^>]*>/g;
const QUOTED_HANDLER = /\s(on[a-z]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const UNQUOTED_HANDLER = /\s(on[a-z]+)\s*=\s*([^\s"'>]+)/gi;

// CSP source digests (`'sha256-<base64>'`) for the inline `<script>` blocks of a page, so a
// response can be served without `'unsafe-inline'`. Digests follow first-seen order and are unique.
// `sha256Hex` returns the hexadecimal SHA-256 of its argument; hashing is injected so this module
// stays free of the crypto implementation.
export function inlineScriptHashes(html: string, sha256Hex: (data: string) => string): Array<string> {
  const digests: Array<string> = [];
  const seen = new Set<string>();
  let scripts = 0;

  for (const match of html.matchAll(SCRIPT_TAG)) {
    const attributes = match[1] ?? '';
    const content = match[2] ?? '';

    if (SRC_ATTRIBUTE.test(attributes) || content.length === 0) {
      continue;
    }

    if (content.length > MAX_INLINE_SCRIPT_CHARS) {
      throw new Error(t('mod_page_inline_script_too_large'));
    }

    scripts += 1;

    if (scripts > MAX_INLINE_SCRIPTS) {
      throw new Error(t('mod_page_too_many_inline_scripts'));
    }
    const digest = Buffer.from(sha256Hex(content), 'hex').toString('base64');

    if (seen.has(digest)) {
      continue;
    }
    seen.add(digest);
    digests.push(digest);
  }

  return digests;
}

/** Decodes the HTML entities an attribute value may carry before its handler is hashed. */
function decodeHandlerEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

// CSP3 `'unsafe-hashes'` digests (`'sha256-<base64>'`) for the inline event handler attributes of a
// page (`onclick="..."`, `onchange="..."`, ...), so `script-src-attr` can allow exactly those handlers.
// The hash covers the attribute VALUE text exactly as written, after HTML entity decoding. Digests
// follow first-seen order and are unique; `sha256Hex` is injected as in `inlineScriptHashes`.
export function inlineHandlerHashes(html: string, sha256Hex: (data: string) => string): Array<string> {
  const digests: Array<string> = [];
  const seen = new Set<string>();

  const add = (raw: string): void => {
    const value = decodeHandlerEntities(raw);

    if (value.length === 0) {
      return;
    }

    if (value.length > MAX_INLINE_HANDLER_CHARS) {
      throw new Error(t('mod_page_inline_handler_too_large'));
    }

    const digest = Buffer.from(sha256Hex(value), 'hex').toString('base64');

    if (seen.has(digest)) {
      return;
    }
    seen.add(digest);
    digests.push(digest);

    if (digests.length > MAX_INLINE_HANDLERS) {
      throw new Error(t('mod_page_too_many_inline_handlers'));
    }
  };

  for (const tag of html.matchAll(START_TAG)) {
    for (const match of tag[0].matchAll(QUOTED_HANDLER)) {
      add(match[3] ?? match[4] ?? '');
    }

    for (const match of tag[0].matchAll(UNQUOTED_HANDLER)) {
      add(match[2] ?? '');
    }
  }

  return digests;
}
