/**
 * Limits shared by every upload session, so uploading to several folders at
 * once doesn't multiply the load on the network and the server.
 */

/**
 * Upload slots. Sessions register a "starter" that tries to start one file;
 * whenever a slot frees up the sessions are offered slots in turn, so every
 * folder keeps moving instead of the first one taking everything.
 */
export class UploadSlots {
  private used = 0;
  private starters: Array<() => boolean> = [];
  private cursor = 0;

  constructor(public readonly limit: number) {}

  register(starter: () => boolean): void {
    if (!this.starters.includes(starter)) this.starters.push(starter);
  }

  unregister(starter: () => boolean): void {
    this.starters = this.starters.filter((s) => s !== starter);
  }

  tryAcquire(): boolean {
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }

  release(): void {
    this.used = Math.max(0, this.used - 1);
    this.pump();
  }

  /** Hand out free slots round-robin until nobody can use one */
  pump(): void {
    let progressed = true;
    while (progressed && this.used < this.limit && this.starters.length > 0) {
      progressed = false;
      const n = this.starters.length;
      for (let i = 0; i < n && this.used < this.limit; i++) {
        const starter = this.starters[(this.cursor + i) % n];
        if (starter && starter()) progressed = true;
      }
      this.cursor = (this.cursor + 1) % Math.max(1, this.starters.length);
    }
  }
}

/** Plain FIFO semaphore (used for the save-to-gallery server calls) */
export class Semaphore {
  private used = 0;
  private waiters: Array<() => void> = [];

  constructor(public readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.used < this.limit) {
      this.used++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else this.used = Math.max(0, this.used - 1);
  }
}
