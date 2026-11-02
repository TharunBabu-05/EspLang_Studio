import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Firmware, ServerEvent } from '../packages/compiler/src/index.js';
import {
  BuildQueue,
  Sessions,
  UsageLimiter,
  clientAddress,
  proxyNetworks,
  type BuildExecutor,
  type BuildInput,
} from '../packages/server/src/hosting.js';
import { containerArguments } from '../packages/server/src/containerRunner.js';
import { hostingConfig } from '../packages/server/src/config.js';

const input: BuildInput = { source: 'setup {} loop {}', board: 'esp32', serialRoute: 'uart' };
const firmware: Firmware = {
  board: 'esp32',
  serialRoute: 'uart',
  fqbn: 'test',
  artifacts: [],
  cpp: '',
  diagnostics: [],
};
const options = { concurrency: 1, maxQueued: 2, waitMs: 1000, buildMs: 2000 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve!: (value: Firmware) => void;
  const promise = new Promise<Firmware>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('hosted build queue', () => {
  it('runs FIFO, reports positions, and bounds concurrency', async () => {
    const builds = [deferred(), deferred(), deferred()];
    let index = 0;
    const execute = vi.fn<BuildExecutor>(() => builds[index++]!.promise);
    const queue = new BuildQueue(execute, options);
    const second: ServerEvent[] = [],
      third: ServerEvent[] = [];
    const a = queue.submit('a', input, () => {}, new AbortController().signal);
    const b = queue.submit('b', input, (e) => second.push(e), new AbortController().signal);
    const c = queue.submit('c', input, (e) => third.push(e), new AbortController().signal);
    expect(queue.status).toEqual({ active: 1, queued: 2, capacity: 1 });
    expect(third).toContainEqual({ type: 'status', state: 'queued', position: 2 });
    await tick();
    expect(execute).toHaveBeenCalledTimes(1);
    builds[0]!.resolve(firmware);
    await a;
    await tick();
    expect(second.at(-1)).toEqual({ type: 'status', state: 'building' });
    expect(third.at(-1)).toEqual({ type: 'status', state: 'queued', position: 1 });
    builds[1]!.resolve(firmware);
    await b;
    await tick();
    builds[2]!.resolve(firmware);
    await c;
    await tick();
    expect(queue.status.active).toBe(0);
    queue.close();
  });
  it('rejects duplicates/full queues before charging quota and removes cancelled waiters', async () => {
    const build = deferred();
    const queue = new BuildQueue(() => build.promise, { ...options, maxQueued: 1 });
    const charge = vi.fn();
    const a = queue.submit('a', input, () => {}, new AbortController().signal, charge);
    expect(() => queue.submit('a', input, () => {}, new AbortController().signal, charge)).toThrow(
      'already',
    );
    const controller = new AbortController();
    const b = queue.submit('b', input, () => {}, controller.signal, charge);
    const rejected = expect(b).rejects.toThrow('cancelled');
    expect(() => queue.submit('c', input, () => {}, new AbortController().signal, charge)).toThrow(
      'full',
    );
    expect(charge).toHaveBeenCalledTimes(2);
    controller.abort();
    await rejected;
    expect(queue.status.queued).toBe(0);
    build.resolve(firmware);
    await a;
    await tick();
    queue.close();
  });
  it('keeps an active slot until cancelled executor cleanup completes', async () => {
    const cleanup = deferred();
    const execute = vi.fn<BuildExecutor>(() => cleanup.promise);
    const queue = new BuildQueue(execute, options);
    const controller = new AbortController();
    const a = queue.submit('a', input, () => {}, controller.signal);
    const cancelled = expect(a).rejects.toThrow('cancelled');
    const b = queue.submit('b', input, () => {}, new AbortController().signal);
    await tick();
    controller.abort();
    await tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.status.active).toBe(1);
    cleanup.resolve(firmware);
    await cancelled;
    await b;
    await tick();
    queue.close();
  });
  it('expires queued work and aborts running work at its deadline', async () => {
    vi.useFakeTimers();
    const queue = new BuildQueue(
      (_input, _emit, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
      options,
    );
    const a = queue.submit('a', input, () => {}, new AbortController().signal);
    const b = queue.submit('b', input, () => {}, new AbortController().signal);
    const assertionB = expect(b).rejects.toThrow('Queue wait timed out');
    const assertionA = expect(a).rejects.toThrow('time limit');
    await vi.advanceTimersByTimeAsync(1001);
    await assertionB;
    await vi.advanceTimersByTimeAsync(1000);
    await assertionA;
    queue.close();
  });
  it('shuts down queued and running work', async () => {
    const queue = new BuildQueue(
      (_input, _emit, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
      options,
    );
    const a = queue.submit('a', input, () => {}, new AbortController().signal);
    const b = queue.submit('b', input, () => {}, new AbortController().signal);
    const assertionA = expect(a).rejects.toThrow('shutting down');
    const assertionB = expect(b).rejects.toThrow('shutting down');
    await tick();
    queue.close();
    await Promise.all([assertionA, assertionB]);
    expect(() => queue.submit('c', input, () => {}, new AbortController().signal)).toThrow(
      'shutting down',
    );
  });
});

describe('sessions, usage, and proxy identity', () => {
  it('expires signed tokens and rejects tampering and client changes', () => {
    let now = 100;
    const sessions = new Sessions('s'.repeat(64), 1000, () => now);
    const owner = sessions.owner('192.0.2.1');
    const { token } = sessions.issue(owner);
    expect(sessions.verify(token, owner)).toBe(true);
    expect(sessions.verify(token, sessions.owner('192.0.2.2'))).toBe(false);
    expect(sessions.verify(`${token}x`, owner)).toBe(false);
    expect(sessions.verify('é'.repeat(2000), owner)).toBe(false);
    expect(sessions.verify(null, owner)).toBe(false);
    now = 1100;
    expect(sessions.verify(token, owner)).toBe(false);
  });
  it('preserves quotas when its key capacity is exhausted, then resets expired windows', () => {
    let now = 0;
    const limits = new UsageLimiter(1, () => now);
    limits.take('a', 1, 1000);
    expect(() => limits.take('a', 1, 1000)).toThrow('Usage limit');
    expect(() => limits.take('b', 1, 1000)).toThrow('busy');
    expect(() => limits.take('a', 1, 1000)).toThrow('Usage limit');
    now = 1000;
    expect(() => limits.take('b', 1, 1000)).not.toThrow();
  });
  it('ignores spoofed forwarding headers outside explicitly trusted proxies', () => {
    const request = (peer: string, forwarded: string) =>
      ({
        socket: { remoteAddress: peer },
        headers: { 'x-forwarded-for': forwarded },
      }) as IncomingMessage;
    const trusted = proxyNetworks('172.30.21.0/24');
    expect(clientAddress(request('192.0.2.1', '198.51.100.4'), trusted)).toBe('192.0.2.1');
    expect(clientAddress(request('::ffff:172.30.21.2', '198.51.100.4'), trusted)).toBe(
      '198.51.100.4',
    );
    expect(clientAddress(request('172.30.21.2', '198.51.100.4, 192.0.2.2'), trusted)).toBe(
      '172.30.21.2',
    );
    expect(() => proxyNetworks('0.0.0.0/99')).toThrow();
  });
  it('fails closed for incomplete hosted configuration', () => {
    vi.stubEnv('BUILD_MODE', 'hosted');
    vi.stubEnv('PUBLIC_ORIGIN', 'http://studio.example.com');
    expect(hostingConfig).toThrow('HTTPS');
    vi.stubEnv('PUBLIC_ORIGIN', 'https://studio.example.com');
    vi.stubEnv('WORKER_SECRET', '');
    expect(hostingConfig).toThrow('WORKER_URL');
  });
});

it('creates a networkless, nonroot, bounded sandbox without mounts or inherited secrets', () => {
  const args = containerArguments('job-test', {
    image: 'worker:test',
    pool: 'test',
    memoryMb: 2048,
    cpus: 1,
    tmpfsMb: 1024,
    timeoutMs: 1000,
  });
  expect(args).toEqual(
    expect.arrayContaining([
      '--network',
      'none',
      '--read-only',
      '--user',
      '1000:1000',
      '--cap-drop',
      'ALL',
      '--memory',
      '2048m',
      '--memory-swap',
      '2048m',
      '--pids-limit',
      '128',
    ]),
  );
  expect(args.join(' ')).not.toMatch(
    /--privileged|--volume|--mount|WORKER_SECRET|SESSION_SECRET|docker.sock/,
  );
  expect(args.at(-1)).toBe('worker:test');
});
