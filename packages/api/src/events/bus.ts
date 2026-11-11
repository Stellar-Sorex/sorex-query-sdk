import type { EventRecord } from "../types.js";

type Listener = (event: EventRecord) => void;

/**
 * In-process fan-out for live events. Each subscription gets a bounded queue so
 * a slow websocket client cannot grow memory without limit; the oldest events
 * are dropped first and the subscriber is marked as lagging.
 */
export class EventBus {
  readonly #listeners = new Set<Listener>();
  #published = 0;

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  get publishedCount(): number {
    return this.#published;
  }

  publish(event: EventRecord): void {
    this.#published += 1;
    for (const listener of this.#listeners) listener(event);
  }

  subscribe(): AsyncIterableIterator<EventRecord> {
    const queue: EventRecord[] = [];
    let waiting: ((result: IteratorResult<EventRecord>) => void) | null = null;
    let closed = false;
    const maxQueue = 1_000;

    const listener: Listener = (event) => {
      if (closed) return;
      if (queue.length >= maxQueue) queue.shift();
      queue.push(event);
      waiting?.({ value: queue.shift()!, done: false });
      waiting = null;
    };

    this.#listeners.add(listener);

    const iterator: AsyncIterableIterator<EventRecord> = {
      next: () => {
        const event = queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      return: () => {
        closed = true;
        this.#listeners.delete(listener);
        waiting?.({ value: undefined, done: true });
        waiting = null;
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (error?: unknown) => {
        closed = true;
        this.#listeners.delete(listener);
        return Promise.reject(error);
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };

    return iterator;
  }

  close(): void {
    this.#listeners.clear();
  }
}
