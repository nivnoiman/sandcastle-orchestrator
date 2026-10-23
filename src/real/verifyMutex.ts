export class VerifyMutex {
  private held = false;
  private readonly queue: (() => void)[] = [];

  busy(): boolean {
    return this.held;
  }

  waiting(): number {
    return this.queue.length;
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.held) return new Promise((resolve) => this.queue.push(resolve));
    this.held = true;
    return Promise.resolve();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.held = false;
      return;
    }
    next();
  }
}
