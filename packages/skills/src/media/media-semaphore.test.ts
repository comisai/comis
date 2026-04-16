import { describe, it, expect } from "vitest";
import { createMediaSemaphore } from "./media-semaphore.js";

/** Helper: create a deferred promise for manual control. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Helper: wait for the next microtask. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("createMediaSemaphore", () => {
  it("limits concurrency to configured value", async () => {
    const sem = createMediaSemaphore(2);
    let maxActive = 0;

    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();

    const task = (d: ReturnType<typeof deferred>) => async () => {
      const current = sem.active();
      if (current > maxActive) maxActive = current;
      await d.promise;
    };

    const p1 = sem.run(task(d1));
    const p2 = sem.run(task(d2));
    const p3 = sem.run(task(d3));

    await tick();

    // At most 2 should be active
    expect(sem.active()).toBeLessThanOrEqual(2);

    d1.resolve();
    d2.resolve();
    d3.resolve();

    await Promise.all([p1, p2, p3]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("queues operations in FIFO order when at capacity", async () => {
    const sem = createMediaSemaphore(1);
    const order: number[] = [];

    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();

    const makeTask = (index: number, d: ReturnType<typeof deferred>) => async () => {
      order.push(index);
      await d.promise;
    };

    const p1 = sem.run(makeTask(0, d1));
    const p2 = sem.run(makeTask(1, d2));
    const p3 = sem.run(makeTask(2, d3));

    await tick();
    // Only first task should have started
    expect(order).toEqual([0]);

    d1.resolve();
    await tick();
    // Second task starts
    expect(order).toEqual([0, 1]);

    d2.resolve();
    await tick();
    // Third task starts
    expect(order).toEqual([0, 1, 2]);

    d3.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([0, 1, 2]);
  });

  it("returns the operation result", async () => {
    const sem = createMediaSemaphore(3);

    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from the operation", async () => {
    const sem = createMediaSemaphore(3);

    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("pending counts running + waiting", async () => {
    const sem = createMediaSemaphore(1);

    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();

    const task = (d: ReturnType<typeof deferred>) => async () => {
      await d.promise;
    };

    const p1 = sem.run(task(d1));
    const p2 = sem.run(task(d2));
    const p3 = sem.run(task(d3));

    await tick();

    // 1 running + 2 waiting = 3 pending
    expect(sem.pending()).toBe(3);
    expect(sem.active()).toBe(1);

    d1.resolve();
    d2.resolve();
    d3.resolve();

    await Promise.all([p1, p2, p3]);
    expect(sem.pending()).toBe(0);
  });

  it("pause and resume work correctly", async () => {
    const sem = createMediaSemaphore(3);
    sem.pause();

    let started = false;
    const p = sem.run(async () => {
      started = true;
      return "done";
    });

    await tick();
    // Operation should NOT have started while paused
    expect(started).toBe(false);
    expect(sem.active()).toBe(0);

    sem.resume();
    const result = await p;

    expect(started).toBe(true);
    expect(result).toBe("done");
  });

  it("clear removes pending operations", async () => {
    const sem = createMediaSemaphore(1);
    let completed = 0;

    const d1 = deferred();

    const p1 = sem.run(async () => {
      await d1.promise;
      completed++;
    });

    // These will be queued (concurrency = 1)
    const p2 = sem.run(async () => {
      completed++;
    });
    const p3 = sem.run(async () => {
      completed++;
    });

    await tick();

    // Clear pending operations (p2 and p3 are waiting)
    sem.clear();

    // Complete the in-flight operation
    d1.resolve();
    await p1;

    // Give time for anything else to run
    await tick();

    // Only the first operation should have completed
    expect(completed).toBe(1);
  });

  it("onIdle resolves when all operations complete", async () => {
    const sem = createMediaSemaphore(2);

    const d1 = deferred();
    const d2 = deferred();

    const p1 = sem.run(async () => {
      await d1.promise;
    });
    const p2 = sem.run(async () => {
      await d2.promise;
    });

    let idleResolved = false;
    const idlePromise = sem.onIdle().then(() => {
      idleResolved = true;
    });

    await tick();
    expect(idleResolved).toBe(false);

    d1.resolve();
    await tick();
    expect(idleResolved).toBe(false);

    d2.resolve();
    await Promise.all([p1, p2, idlePromise]);
    expect(idleResolved).toBe(true);
    expect(sem.pending()).toBe(0);
  });
});
