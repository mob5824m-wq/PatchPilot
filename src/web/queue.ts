/**
 * The download queue: several apps fetched one after another, while the user
 * keeps browsing. A phone download is minutes long, so queueing is the
 * difference between "pick one and wait" and "pick six and put it down".
 *
 * Pure state transitions, so the ordering rules are testable without a DOM.
 */

export interface QueueItem {
  packageName: string;
  appName: string;
  version: string;
}

export interface QueueState {
  items: QueueItem[];
  /** Index of the item being downloaded, or -1 when idle. */
  current: number;
  /** How many finished, successfully or not. */
  done: number;
  failed: QueueItem[];
}

export const emptyQueue: QueueState = { items: [], current: -1, done: 0, failed: [] };

export function enqueue(state: QueueState, item: QueueItem): QueueState {
  const exists = state.items.some(
    (queued) => queued.packageName === item.packageName && queued.version === item.version,
  );
  if (exists) return state;
  return { ...state, items: [...state.items, item] };
}

/** The item to start now, or null when the queue is finished or already busy. */
export function nextItem(state: QueueState): QueueItem | null {
  if (state.current >= 0) return null;
  const index = state.done;
  return state.items[index] ?? null;
}

export function startNext(state: QueueState): QueueState {
  if (state.current >= 0) return state;
  if (state.done >= state.items.length) return state;
  return { ...state, current: state.done };
}

/** Records the outcome of the item at `current` and moves on. */
export function finishCurrent(state: QueueState, ok: boolean): QueueState {
  if (state.current < 0) return state;
  const item = state.items[state.current];
  const failed = !ok && item ? [...state.failed, item] : state.failed;
  return { ...state, current: -1, done: state.done + 1, failed };
}

export function clearQueue(state: QueueState): QueueState {
  return { ...emptyQueue, failed: state.failed };
}

export function queueSummary(state: QueueState): string | null {
  if (!state.items.length) return null;
  const position = Math.min(state.done + 1, state.items.length);
  const active = state.current >= 0 ? state.items[state.current]?.appName : null;
  return active
    ? `Downloading ${active} · ${position} of ${state.items.length}`
    : `${state.items.length - state.done} queued`;
}
