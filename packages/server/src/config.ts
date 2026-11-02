export function integer(name: string, fallback: number, min = 1, max = 1_000_000): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
export function hostingConfig() {
  const hosted = process.env.BUILD_MODE === 'hosted';
  if (process.env.BUILD_MODE && !['hosted', 'local'].includes(process.env.BUILD_MODE))
    throw new Error('BUILD_MODE must be local or hosted');
  const origin = process.env.PUBLIC_ORIGIN;
  if (
    hosted &&
    (!origin || new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:')
  )
    throw new Error('Hosted mode requires an exact HTTPS PUBLIC_ORIGIN');
  const worker = process.env.WORKER_URL;
  const workerSecret = process.env.WORKER_SECRET ?? '';
  if (
    hosted &&
    (!worker || !['http:', 'https:'].includes(new URL(worker).protocol) || workerSecret.length < 32)
  )
    throw new Error(
      'Hosted mode requires WORKER_URL and a WORKER_SECRET of at least 32 characters',
    );
  return {
    hosted,
    origin,
    worker,
    workerSecret,
    concurrency: integer('BUILD_CONCURRENCY', hosted ? 2 : 1, 1, 8),
    maxQueued: integer('MAX_QUEUED_BUILDS', 20, 0, 100),
    buildMs: integer('BUILD_TIMEOUT_MS', 240000, 1000, 900000),
    waitMs: integer('QUEUE_TIMEOUT_MS', 120000, 1000, 900000),
    buildsPerHour: integer('BUILDS_PER_HOUR', 10, 1, 1000),
    maxConnections: integer('MAX_CONNECTIONS', 100, 1, 10000),
  };
}
