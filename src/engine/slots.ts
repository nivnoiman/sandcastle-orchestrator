export interface WorkerSlots {
  tryAcquire(): boolean;
  release(): void;
}

export class LocalSlots implements WorkerSlots {
  tryAcquire(): boolean {
    return true;
  }

  release(): void {}
}
