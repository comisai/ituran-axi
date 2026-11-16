import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fetchAnswer } from '../../src/http.ts';

it('aborts, cancels an unread body and clears the deadline when buffering fails in-process', async (t) => {
  let signal: AbortSignal | undefined;
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      cancel: () => {
        cancelled++;
      },
    }),
  );
  response.arrayBuffer = async () => {
    throw new Error('buffer failed');
  };
  const timer = t.mock.method(globalThis, 'setTimeout');
  const clear = t.mock.method(globalThis, 'clearTimeout');
  await assert.rejects(
    fetchAnswer(
      {
        fetch: async (_url, init) => {
          signal = init?.signal ?? undefined;
          return response;
        },
        sleep: async () => {},
      },
      new URL('https://ituran.invalid/api/v2/vehicles'),
      { method: 'GET', headers: {} },
      60_000,
    ),
    { code: 'unreachable' },
  );
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, 1, 'unread response body was cancelled');
  assert.equal(timer.mock.callCount(), 1);
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(clear.mock.calls[0]?.arguments[0], timer.mock.calls[0]?.result);
});
