export interface ModContent {
  scripts: ReadonlyArray<string>;
  styles: ReadonlyArray<string>;
}

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
Injects the `content_js` / `content_css` URLs declared by Sauce mods into the HTML of a window
page. Styles come first, then classic scripts (no type=module, no defer): Sauce content scripts
run before the page's own modules.

Insertion point: immediately before the first `</head>`; failing that, immediately after the
first `<body...>` opening tag; failing that, prepended to the document. Only the first match is
used. A URL that already appears verbatim in the HTML is skipped, so injecting twice yields the
same document as injecting once.
*/
export function injectModContent(html: string, content: ModContent): string {
  const newStyles = content.styles.filter((href) => !html.includes(href));
  const newScripts = content.scripts.filter((src) => !html.includes(src));
  if (newStyles.length === 0 && newScripts.length === 0) {
    return html;
  }

  const tags = [
    ...newStyles.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}"/>`),
    ...newScripts.map((src) => `<script src="${escapeAttr(src)}"></script>`),
  ];
  const block = `\n    ${tags.join('\n    ')}\n`;

  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose) {
    const at = headClose.index;
    return `${html.slice(0, at)}${block}${html.slice(at)}`;
  }

  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (bodyOpen) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return `${html.slice(0, at)}${block}${html.slice(at)}`;
  }

  return `${block}${html}`;
}

/**
Mods written for older Sauce versions create `common.Renderer`, the deprecated name of `Renderer` in
`fields.mjs`; the shim in `common.mjs` hands the call on to `globalThis._fields_module_back_compat_Renderer`,
which only exists once `fields.mjs` has been loaded. A page that never loads it itself gets it here, as the
first module script of its head, so it has run by the time the page's own modules do. A page that already names
the module is left as it is.
*/
export function injectFieldsModule(html: string): string {
  if (html.includes('/pages/src/fields.mjs')) {
    return html;
  }

  const tag = '<script type="module" src="/pages/src/fields.mjs"></script>';
  const headOpen = /<head\b[^>]*>/i.exec(html);

  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;

    return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`;
  }

  // No head to put it in (a fragment): prepending would put the tag before the doctype, so leave the page alone.
  return html;
}

/**
The import assertion syntax `import x from './x.json' assert { type: 'json' }` was removed from Chromium in
favour of `with { type: 'json' }`, and the Electron of the runner is newer than the one Sauce mods were
written for. Only the keyword of an import statement is rewritten; anything else is returned as it is.
*/
export function modernizeImportAssertions(source: string): string {
  return source.replaceAll(/(\bimport\b[^;]*?\bfrom\s*['"][^'"\n]+['"]\s*)assert(\s*\{)/g, '$1with$2');
}
