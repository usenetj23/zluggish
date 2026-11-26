import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupWindows, popupFeatures, webWindowsResponse, windowUrl, settingsUrl } from './overlay';

const watching = {
  type: 'watching',
  file: '/pages/watching.html?windowType=watching',
  groupTitle: 'Main',
  prettyName: 'Watching',
  prettyDesc: 'The streams of the rider you watch.',
};

const power = {
  type: 'power',
  file: '/pages/gauges/power.html',
  groupTitle: 'Main',
  prettyName: 'Power Gauge',
  options: { width: 380, height: 300 },
};

const radar = {
  type: 'hill-hill-radar',
  file: '/mods/hill/pages/hill-radar.html',
  mod: true,
  modId: 'hill',
  query: { units: 'metric' },
  groupTitle: '[MOD]: Hill',
  prettyName: 'Hill Radar',
  settingsFile: '/mods/hill/pages/hill-settings.html',
};

await test('the manifest answer validates and keeps the built-in shape', () => {
  const answer = webWindowsResponse.parse({ success: true, value: [watching] });

  assert.equal(answer.success, true);
  assert.equal(answer.value?.[0].prettyName, 'Watching');
});

await test('the built-in window url is its own path', () => {
  assert.equal(windowUrl(watching), '/pages/watching.html?windowType=watching');
});

await test('a mod window gets its query appended', () => {
  assert.equal(windowUrl(radar), '/mods/hill/pages/hill-radar.html?units=metric');
});

await test('a bare file sits under /pages', () => {
  assert.equal(
    windowUrl({ type: 'chat', file: 'chat.html', prettyName: 'Chat', query: { compact: '1' } }),
    '/pages/chat.html?compact=1',
  );
});

await test('settings open their own file, else the window itself', () => {
  assert.equal(settingsUrl(radar), '/mods/hill/pages/hill-settings.html');
  assert.equal(settingsUrl(watching), '/pages/watching.html?windowType=watching');
});

await test('the popup feature string carries the manifest size', () => {
  assert.equal(popupFeatures(power), 'popup,width=380,height=300');
});

await test('no size means a plain popup', () => {
  assert.equal(popupFeatures(watching), 'popup');
});

await test('mod windows group apart from the built-ins', () => {
  const groups = groupWindows([watching, radar]);

  assert.deepStrictEqual(groups.builtin, [watching]);
  assert.deepStrictEqual(groups.mods, [radar]);
});

await test('a failed RPC answer validates without a value', () => {
  assert.deepStrictEqual(
    webWindowsResponse.parse({ success: false, error: { name: 'AuthenticationError', stack: '' } }),
    {
      success: false,
      error: { name: 'AuthenticationError', stack: '' },
    },
  );
});
