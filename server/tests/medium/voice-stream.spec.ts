import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { createWebApp } from '#src/http/web-app';
import { VoiceService } from '#src/services/voice.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { mediumFixture } from '#tests/medium/support';

/** Reads the stream until the text holds what is waited for. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, wanted: string) {
  const decoder = new TextDecoder();
  let text = '';

  while (!text.includes(wanted)) {
    const chunk = await reader.read();

    if (chunk.done) break;

    text += decoder.decode(chunk.value);
  }

  return text;
}

await test('the voice stream carries the chat bubbles of the signed-in rider and only theirs', async (t) => {
  const f = await mediumFixture(t);
  const web = createWebApp(f);
  const voice = f.effects.runSync(VoiceService);

  const { id: session } = f.effects.runSync(
    WebSessionsService.use((sessions) => sessions.create(f.accounts.identityOf(f.rider))),
  );

  const response = await web.request('http://local:8080/api/voice/stream?language=en', {
    headers: { Cookie: `zluggish_web_session=${session}` },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.ok(response.body);

  const reader = response.body.getReader();

  t.after(() => void reader.cancel());

  await Effect.runPromise(
    voice.onSocial({ playerId: 42n, from: 'Bot Bob', text: 'not for you' }, [BigInt(f.other.player_id)]),
  );
  await Effect.runPromise(
    voice.onSocial({ playerId: 42n, from: 'Bot Bob', text: 'for you' }, [BigInt(f.rider.player_id)]),
  );

  const text = await readUntil(reader, 'for you');

  assert.match(text, /event: chat/);
  assert.match(text, /for you/);
  assert.doesNotMatch(text, /not for you/);
});

await test('the voice stream needs a signed-in rider', async (t) => {
  const f = await mediumFixture(t);
  const response = await createWebApp(f).request('http://local:8080/api/voice/stream');

  assert.notEqual(response.status, 200);
  await response.body?.cancel();
});
