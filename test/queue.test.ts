import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearQueue,
  emptyQueue,
  enqueue,
  finishCurrent,
  nextItem,
  queueSummary,
  startNext,
  type QueueItem,
} from '../src/web/queue.ts';

const youtube: QueueItem = { packageName: 'com.google.android.youtube', appName: 'YouTube', version: '21.43.523' };
const spotify: QueueItem = { packageName: 'com.spotify.music', appName: 'Spotify', version: '9.0.10' };

test('apps are downloaded in the order they were queued', () => {
  let queue = enqueue(enqueue(emptyQueue, youtube), spotify);
  assert.equal(queue.items.length, 2);

  // The same app and version twice is still one download.
  queue = enqueue(queue, youtube);
  assert.equal(queue.items.length, 2);

  // A different version of the same app is a different download.
  queue = enqueue(queue, { ...youtube, version: '21.44.100' });
  assert.equal(queue.items.length, 3);
});

test('the queue runs one item at a time and advances on success', () => {
  let queue = enqueue(enqueue(emptyQueue, youtube), spotify);

  assert.deepEqual(nextItem(queue), youtube);
  queue = startNext(queue);
  assert.equal(queue.current, 0);
  // Busy: nothing else is handed out while one is running.
  assert.equal(nextItem(queue), null);

  queue = finishCurrent(queue, true);
  assert.equal(queue.current, -1);
  assert.equal(queue.done, 1);
  assert.deepEqual(nextItem(queue), spotify);

  queue = finishCurrent(startNext(queue), true);
  assert.equal(queue.done, 2);
  assert.equal(nextItem(queue), null);
  assert.equal(queue.failed.length, 0);
});

test('a failed download does not stop the rest of the queue', () => {
  let queue = startNext(enqueue(enqueue(emptyQueue, youtube), spotify));
  queue = finishCurrent(queue, false);

  assert.deepEqual(queue.failed, [youtube]);
  assert.deepEqual(nextItem(queue), spotify);
  assert.equal(queue.done, 1);
});

test('finishing with nothing running changes nothing', () => {
  const untouched = finishCurrent(enqueue(emptyQueue, youtube), true);
  assert.equal(untouched.done, 0);
  assert.equal(untouched.current, -1);
});

test('startNext refuses to run two downloads at once', () => {
  const running = startNext(enqueue(enqueue(emptyQueue, youtube), spotify));
  assert.equal(startNext(running), running);
});

test('the header says what is happening without opening a panel', () => {
  assert.equal(queueSummary(emptyQueue), null);

  const waiting = enqueue(enqueue(emptyQueue, youtube), spotify);
  assert.equal(queueSummary(waiting), '2 queued');

  const running = startNext(waiting);
  assert.equal(queueSummary(running), 'Downloading YouTube · 1 of 2');

  assert.equal(queueSummary(finishCurrent(running, true)), '1 queued');
});

test('clearing forgets what is waiting but keeps what failed', () => {
  let queue = startNext(enqueue(enqueue(emptyQueue, youtube), spotify));
  queue = finishCurrent(queue, false);
  queue = enqueue(queue, { ...spotify, version: '9.0.11' });

  const cleared = clearQueue(queue);
  assert.equal(cleared.items.length, 0);
  assert.equal(cleared.done, 0);
  assert.equal(cleared.current, -1);
  assert.deepEqual(cleared.failed, [youtube]);
});
