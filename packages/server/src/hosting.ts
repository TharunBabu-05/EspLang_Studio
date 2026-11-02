import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { BoardId, Firmware, ServerEvent } from '@esplang/compiler';

export interface BuildInput {
  source: string;
  board: BoardId;
  serialRoute: 'uart' | 'usb';
}
export type BuildExecutor = (
  input: BuildInput,
  emit: (event: ServerEvent) => void,
  signal: AbortSignal,
) => Promise<Firmware>;

export class AdmissionError extends Error {
  constructor(
    message: string,
    public readonly retryAfter = 0,
  ) {
    super(message);
  }
}

/** Fixed windows, bounded keys, and no eviction of live quotas under load. */
export class UsageLimiter {
  private readonly entries = new Map<string, { count: number; expires: number }>();
  constructor(
    private readonly capacity = 10000,
    private readonly now = Date.now,
  ) {}
  take(key: string, limit: number, windowMs: number): void {
    const now = this.now();
    for (const [id, value] of this.entries) if (value.expires <= now) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.capacity)
        throw new AdmissionError('Service is busy. Try again later.', 60);
      entry = { count: 0, expires: now + windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= limit)
      throw new AdmissionError(
        'Usage limit reached. Try again later.',
        Math.max(1, Math.ceil((entry.expires - now) / 1000)),
      );
    entry.count++;
  }
}

export class Sessions {
  constructor(
    private readonly secret: string,
    private readonly ttlMs = 30 * 60_000,
    private readonly now = Date.now,
  ) {
    if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  }
  owner(address: string): string {
    return createHmac('sha256', this.secret).update(`client:${address}`).digest('base64url');
  }
  issue(owner: string): { token: string; expiresAt: number } {
    const expiresAt = this.now() + this.ttlMs;
    const body = Buffer.from(JSON.stringify({ owner, expiresAt, nonce: randomUUID() })).toString(
      'base64url',
    );
    return { token: `${body}.${this.sign(body)}`, expiresAt };
  }
  verify(token: unknown, owner: string): boolean {
    if (typeof token !== 'string' || token.length > 1024) return false;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return false;
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        owner?: unknown;
        expiresAt?: unknown;
      };
      return (
        data.owner === owner &&
        typeof data.expiresAt === 'number' &&
        data.expiresAt > this.now() &&
        data.expiresAt <= this.now() + this.ttlMs
      );
    } catch {
      return false;
    }
  }
  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

export function clientAddress(req: IncomingMessage, trusted: BlockList): string {
  const normalize = (value: string): string =>
    value.startsWith('::ffff:') ? value.slice(7) : value;
  const peer = normalize(req.socket.remoteAddress ?? 'unknown');
  const family = isIP(peer);
  const forwarded = req.headers['x-forwarded-for'];
  // The deployment proxy overwrites this header. Arbitrary lists are rejected.
  if (
    family &&
    trusted.check(peer, family === 6 ? 'ipv6' : 'ipv4') &&
    typeof forwarded === 'string' &&
    isIP(normalize(forwarded.trim()))
  )
    return normalize(forwarded.trim());
  return peer;
}

export function proxyNetworks(value = ''): BlockList {
  const list = new BlockList();
  for (const entry of value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address ?? '');
    if (!family) throw new Error('TRUST_PROXY_CIDRS contains an invalid address');
    const bits = prefix === undefined ? (family === 6 ? 128 : 32) : Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > (family === 6 ? 128 : 32))
      throw new Error('TRUST_PROXY_CIDRS contains an invalid prefix');
    list.addSubnet(address!, bits, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

interface Job {
  owner: string;
  input: BuildInput;
  emit: (event: ServerEvent) => void;
  controller: AbortController;
  resolve: (firmware: Firmware) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  waitTimer?: ReturnType<typeof setTimeout>;
}

export class BuildQueue {
  private readonly pending: Job[] = [];
  private readonly owners = new Set<string>();
  private readonly active = new Set<Job>();
  private closed = false;
  constructor(
    private readonly execute: BuildExecutor,
    private readonly options: {
      concurrency: number;
      maxQueued: number;
      waitMs: number;
      buildMs: number;
    },
  ) {}
  get status() {
    return {
      active: this.active.size,
      queued: this.pending.length,
      capacity: this.options.concurrency,
    };
  }
  submit(
    owner: string,
    input: BuildInput,
    emit: Job['emit'],
    signal: AbortSignal,
    admit = () => {},
  ): Promise<Firmware> {
    if (this.closed) throw new AdmissionError('Build service is shutting down');
    if (signal.aborted) throw new AdmissionError('Build cancelled');
    if (this.owners.has(owner))
      throw new AdmissionError('You already have a queued or running build');
    if (
      this.active.size >= this.options.concurrency &&
      this.pending.length >= this.options.maxQueued
    )
      throw new AdmissionError('Build queue is full. Try again shortly.', 30);
    admit();
    this.owners.add(owner);
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const abort = () => {
        controller.abort(new Error('Build cancelled'));
        const index = this.pending.indexOf(job);
        if (index !== -1) {
          this.pending.splice(index, 1);
          job.cleanup();
          reject(new Error('Build cancelled'));
          this.positions();
        }
      };
      const job: Job = {
        owner,
        input,
        emit,
        controller,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(job.waitTimer);
          signal.removeEventListener('abort', abort);
          this.owners.delete(owner);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      job.waitTimer = setTimeout(() => {
        const index = this.pending.indexOf(job);
        if (index === -1) return;
        this.pending.splice(index, 1);
        job.cleanup();
        reject(new AdmissionError('Queue wait timed out. Try again shortly.', 30));
        this.positions();
      }, this.options.waitMs);
      this.pending.push(job);
      this.pump();
      if (signal.aborted) abort();
    });
  }
  close(): void {
    this.closed = true;
    for (const job of this.pending.splice(0)) {
      job.cleanup();
      job.reject(new Error('Build service is shutting down'));
    }
    for (const job of this.active)
      job.controller.abort(new Error('Build service is shutting down'));
  }
  private positions(): void {
    this.pending.forEach((job, index) =>
      job.emit({ type: 'status', state: 'queued', position: index + 1 }),
    );
  }
  private pump(): void {
    while (!this.closed && this.active.size < this.options.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      clearTimeout(job.waitTimer);
      this.active.add(job);
      job.emit({ type: 'status', state: 'building' });
      const timer = setTimeout(
        () => job.controller.abort(new Error('Build exceeded its time limit')),
        this.options.buildMs,
      );
      void Promise.resolve()
        .then(() => {
          job.controller.signal.throwIfAborted();
          return this.execute(job.input, job.emit, job.controller.signal);
        })
        .then((value) => {
          if (job.controller.signal.aborted) job.reject(job.controller.signal.reason);
          else job.resolve(value);
        }, job.reject)
        .finally(() => {
          clearTimeout(timer);
          this.active.delete(job);
          job.cleanup();
          this.pump();
        });
    }
    this.positions();
  }
}
