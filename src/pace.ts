// Ituran answers bursts with HTTP 481. Every request of one command passes one
// gate: at most two in flight, and starts at least 400 ms apart.

export const GAP_MS = 400;
export const IN_FLIGHT = 2;

export class Pace {
  private last = Number.NEGATIVE_INFINITY;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;

  constructor(
    sleep: (ms: number) => Promise<void>,
    clock: () => number = () => performance.now(),
  ) {
    this.sleep = sleep;
    this.clock = clock;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= IN_FLIGHT) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      const now = this.clock();
      const start = Math.max(now, this.last + GAP_MS);
      this.last = start;
      if (start > now) await this.sleep(start - now);
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
