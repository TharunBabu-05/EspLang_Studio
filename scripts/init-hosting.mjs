import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const domain = process.argv[2]?.toLowerCase();
if (
  !domain ||
  domain.length > 253 ||
  !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
) {
  console.error('Usage: node scripts/init-hosting.mjs studio.your-domain.com');
  process.exit(1);
}
const file = fileURLToPath(new URL('../deploy/.env', import.meta.url));
const secret = () => randomBytes(32).toString('hex');
try {
  await writeFile(
    file,
    `DOMAIN=${domain}\nSESSION_SECRET=${secret()}\nWORKER_SECRET=${secret()}\nBUILD_CONCURRENCY=2\nBUILDS_PER_HOUR=10\nMAX_QUEUED_BUILDS=20\nBUILD_TIMEOUT_MS=240000\nQUEUE_TIMEOUT_MS=120000\nWORKER_MEMORY_MB=2048\nWORKER_TMPFS_MB=1024\nWORKER_CPUS=1\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created deploy/.env with unique secrets. Keep this ignored file on the server.');
} catch (error) {
  if (error.code === 'EEXIST')
    console.error('deploy/.env already exists; existing secrets were preserved.');
  else throw error;
  process.exitCode = 1;
}
