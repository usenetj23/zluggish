# Zluggish Overlay: the Sauce for Zwift widget pages

The files under `pages/` and `shared/` come from [Sauce for Zwift](https://github.com/SauceLLC/sauce4zwift),
copyright Sauce, LLC, released under the GNU General Public License v3.0 (`LICENSE` in this folder).
Zluggish is AGPL-3.0; GPLv3 section 13 allows combining GPL-3.0 files into an AGPL-3.0 work, and these
files keep their GPL-3.0 licence. Sauce for Zwift is not affiliated with Zluggish.

- Upstream: `https://github.com/SauceLLC/sauce4zwift`
- Vendored commit: `6de4254a454d376e8bfce02c3a098274a7723711` (19 November 2026), Sauce for Zwift 2.4.0-alpha.7
- Pages included: Overview (the status bar, without its settings page, which is the admin panel of the Sauce
  application), Groups, Nearby, Watching and Chat with their settings pages, and the six gauges (power, heart rate,
  cadence, pace, W'bal and draft, in `pages/gauges/`) with their shared settings page.

## What is here

- `pages/*.html`, `pages/*-manifest.json`, `pages/gauges/*`, `pages/src/*.mjs` and `pages/src/preloads.js`: the page
  documents and the modules they load.
- `pages/templates/watching-screen-layout.html.tpl`: the layout template the Watching page fetches at run time.
- `shared/*.mjs`, `shared/sauce/*.mjs`: upstream's shared modules.
- `pages/images/`: upstream's images, except the ones listed under "Removed" below. `pages/images/powerups/` holds
  Zluggish-drawn placeholders (see change 6).
- `pages/fonts/`: upstream's `Saira`, `Permanent Marker`, `Material Symbols Rounded` (Apache License 2.0) and `empty`
  fonts, unchanged, plus Montserrat (change 9).
- `pages/scss/`: the stylesheet sources. `pages/css/` is **generated** from them with `sass@1.105.1` (the version
  upstream's `package.json` pins): `sass --no-source-map pages/scss:pages/css`, upstream's own `make sass` rule
  without source maps. Edit the SCSS, never the CSS.
- `pages/deps/src/echarts.mjs`: [Apache ECharts](https://echarts.apache.org) 6.1.0, `dist/echarts.esm.min.js` as
  published on npm, under the Apache License 2.0 (`LICENSE-echarts`, `NOTICE-echarts`). Upstream copies the same
  file (its `pages/deps/Makefile`). The Watching page and the gauges import it.
- `pages/deps/flags/*.png`: the 64x64 flags of the npm package `world_countries_lists` 3.3.0, as upstream's
  `pages/deps/Makefile` copies them, licensed CC BY-SA 4.0 (`pages/deps/flags/LICENSE-flags.txt`).
- `shared/deps/data/countries.json`: `world_countries_lists@3.3.0`, `data/countries/_combined/world.json`, as
  upstream's `shared/deps/Makefile` copies it.

## Removed

- The ZwiftPower logo, the ZwiftPower category images (`pages/images/ranking/`) and the in-game power-up icons
  (`pages/images/powerups/`): Zwift artwork that the GPL cannot license.
- The Sauce logos (`logo_horiz_*`, `logo_vert_*`; the bottle icons are replaced, change 6): a trademark, and no
  affiliation is implied.
- Everything the included pages do not load.

## Changes made for Zluggish

Changed HTML pages say so in a comment at their top; in scripts and stylesheets the changes are marked with a
`Zluggish` comment where they are not plain renames.

1. Inline scripts. Each HTML page carried one inline `<script type="module">` that only calls `main()` or
   `settingsMain()`. Zluggish's Content-Security-Policy forbids inline scripts, so each moved to
   `pages/src/boot-<page>.mjs` (the gauges share `boot-gauge.mjs` and `boot-gauge-settings.mjs`).
2. `pages/deps/src/sentry.mjs` is a Zluggish-written stub (not GPL code from upstream), so Sauce's error reporting
   has nothing to send to.
3. `shared/sauce/time.mjs`: `establish()` used to open a WebSocket to Sauce's time server
   (`time.sauce-llc.workers.dev`), which would tell a third party the viewer's address. It now sets the offset to
   zero and returns before any connection is made.
4. `pages/overview.html`: the Analysis, Athletes and Events buttons are hidden with an inline `style="display: none"`
   (the page's script looks each one up and logs an error when it is missing) and the settings button is removed,
   because Zluggish does not ship those pages.
5. `pages/src/common.mjs`, `rpcCall`: the calls that change the world are sent as `POST /api/rpc/v1/<name>` with the
   `X-CSRF-Token` of the web app session (read from `/api/me`), never as a GET. A GET with a `SameSite=Lax` cookie can
   be fired by a page on another site with a plain navigation; a POST with a token cannot. `setSetting` and the mod
   calls (`setModNetwork`, `installModFromGitHub`, `installModFromZip`) are on that list too, because Zluggish
   answers them only as a POST.
6. Icons. `pages/images/icon{32,64,128,256}.png` and `favicon.png` show Zluggish's logo instead of Sauce's.
   `pages/images/powerups/*.svg` are plain Zluggish-drawn circles with a short label, under the file names
   `fields.mjs` asks for. The gauge needle is always the plain pointer (`pages/src/gauge.mjs`), because the logo
   needle drew the Sauce logo; the "Boring mode" switch that chose between them is gone from `gauges/settings.html`.
7. Names. The module is called **Zluggish Overlay** in the `<title>` of every page, the visible name of
   `overview.html` and the web manifests. `NP®`, `TSS®` and `IF®` (TrainingPeaks marks) are named **Normalized
   Power** (short `Norm Power`), **Load** and **Intensity** in `pages/src/{nearby,fields,watching}.mjs`, and
   `attributions.tp` in `common.mjs` explains these names instead of the trademark notice.
8. Look. The themes (`pages/scss/themes.scss`, the theme list in `pages/src/custom-elements.mjs`) are rewritten: the
   default theme follows the Zluggish web app (slate blue, orange accent) and is listed as "Zluggish Default" (its id
   `sauce` is unchanged, so saved settings still work), the named skins are deep two-colour gradients with one accent
   each, and there are generated (`random`, `custom`) and material themes and more background textures
   (`pages/scss/materials.scss`, `pages/scss/themes-transparent.scss`). The texture is a layer of its own with its own
   opacity. `pages/scss/common.scss` gives every form control one look and restyles the top bar; the sorted column
   and the watched row of Nearby are panes of glass (`pages/scss/nearby.scss`); the Overview bar has no texture.
9. Font. Montserrat is the default font, from `@fontsource/montserrat` 5.3.0 (the `latin` 400, 600 and 800 files,
   unchanged), under the SIL Open Font License 1.1 (`LICENSE-montserrat`). Saira stays selectable (`/font` setting),
   and each settings page offers a font and a texture opacity for its window (`pages/src/common.mjs`).
10. Groups: a setting "Shrink with distance" (default on, `groups-settings.html`, `pages/src/groups.mjs`,
    `pages/scss/groups.scss`). In the zoomed view each athlete's circle gets smaller the further it is from the
    watched athlete (9% per place, down to 60%).
11. Fixes. `Common.settingsStore.setDefault` fills in the keys that are missing, not only an empty store, so a widget
    opened after its settings page never runs with undefined settings. The Nearby settings page starts from the
    default field states when the widget never ran. The field lists of the Nearby settings and the "Add section" list
    of Watching are sorted alphabetically. Colour inputs of the settings pages have titles.

Everything else is byte for byte what upstream has at the commit above.

## Written for Zluggish

These files are not from upstream and say so at their top: `pages/mods.html`, `pages/src/mods.mjs`,
`pages/src/boot-mods.mjs` and `pages/scss/mods.scss` (the page that lists, installs and enables mods).

## Updating

1. Clone upstream into an empty folder and note the commit.
2. Copy the files listed above over this folder and re-apply the changes. For the stylesheets, replace
   `pages/scss/` with upstream's and re-apply the `Zluggish` blocks of `common`, `nearby`, `groups` and `overview`
   (`themes`, `materials` and `themes-transparent` are Zluggish's own), then rebuild `pages/css/` with the command
   above.
3. Update the commit in this file and run the `widget-pages` tests: they request every file the pages need through
   the real routes.
