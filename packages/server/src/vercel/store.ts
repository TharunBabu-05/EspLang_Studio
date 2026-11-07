import { Redis } from '@upstash/redis';
import type { Firmware } from '@esplang/compiler';
import type { BuildInput } from '../hosting.js';
import { AdmissionError } from '../hosting.js';

export type JobState = 'queued' | 'building' | 'succeeded' | 'failed' | 'cancelled';
export interface CloudJob extends BuildInput {
  id: string;
  owner: string;
  state: JobState;
  createdAt: number;
  expiresAt: number;
  lease?: string;
  leaseUntil?: number;
  sandboxId?: string;
  logs: string;
  error?: string;
  firmware?: Firmware;
}
export interface CloudLimits {
  concurrency: number;
  maxQueued: number;
  waitMs: number;
  buildMs: number;
  buildsPerHour: number;
  buildsPerDay: number;
}
export interface JobStore {
  admit(job: CloudJob): Promise<void>;
  get(id: string): Promise<CloudJob | null>;
  claim(id: string, lease: string): Promise<'claimed' | 'busy' | 'done'>;
  update(id: string, lease: string, patch: { logs?: string; sandboxId?: string }): Promise<boolean>;
  finish(id: string, lease: string | undefined, result: { firmware?: Firmware; error?: string }): Promise<void>;
  cancel(id: string, owner: string): Promise<boolean>;
  release(id: string, lease: string): Promise<void>;
  position(id: string): Promise<number>;
  rate(owner: string): Promise<void>;
  ready(): Promise<boolean>;
}

// Exported for integration tests against real Redis. Each transition is atomic
// across Vercel function instances; no quotas or leases live in process memory.
export const ADMIT_JOB = `
local now = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now-tonumber(ARGV[3]))
if redis.call('EXISTS', KEYS[2]) == 1 then return 'owner' end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 'full' end
if tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[5]) then return 'hour' end
if tonumber(redis.call('GET', KEYS[4]) or '0') >= tonumber(ARGV[6]) then return 'day' end
redis.call('INCR', KEYS[3]); redis.call('EXPIRE', KEYS[3], 3600)
redis.call('INCR', KEYS[4]); redis.call('EXPIRE', KEYS[4], 86400)
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[7])
redis.call('SET', KEYS[5], ARGV[8], 'PX', ARGV[7])
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('EXPIRE', KEYS[1], 900)
return 'ok'`;

export const CLAIM_JOB = `
local raw = redis.call('GET', KEYS[1]); if not raw then return 'done' end
local job = cjson.decode(raw); local now = tonumber(ARGV[1])
if job.state ~= 'queued' then
  if job.state == 'building' and tonumber(job.leaseUntil or 0) > now then return 'busy' end
  return 'done'
end
if now-job.createdAt > tonumber(ARGV[2]) then
  job.state='failed'; job.error='Queue wait timed out. Please build again.'; job.source=''
  redis.call('SET', KEYS[1], cjson.encode(job), 'KEEPTTL')
  redis.call('ZREM', KEYS[2], job.id)
  if redis.call('GET', KEYS[4]) == job.id then redis.call('DEL', KEYS[4]) end
  return 'done'
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[3]) then return 'busy' end
job.state='building'; job.lease=ARGV[4]; job.leaseUntil=now+tonumber(ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(job), 'KEEPTTL')
redis.call('ZREM', KEYS[2], job.id)
redis.call('ZADD', KEYS[3], job.leaseUntil, job.id)
redis.call('EXPIRE', KEYS[3], 900)
return 'claimed'`;

export const UPDATE_JOB = `
local raw=redis.call('GET', KEYS[1]); if not raw then return 0 end
local job=cjson.decode(raw)
if job.state ~= 'building' or job.lease ~= ARGV[1] then return 0 end
local patch=cjson.decode(ARGV[2])
if patch.logs then job.logs=patch.logs end
if patch.sandboxId then job.sandboxId=patch.sandboxId end
redis.call('SET', KEYS[1], cjson.encode(job), 'KEEPTTL'); return 1`;

export const FINISH_JOB = `
local raw=redis.call('GET', KEYS[1]); if not raw then return 0 end
local job=cjson.decode(raw)
if (job.lease or '') ~= ARGV[1] then return 0 end
if job.state ~= 'queued' and job.state ~= 'building' and job.state ~= 'cancelled' then return 0 end
if job.state ~= 'cancelled' then
  local result=cjson.decode(ARGV[2]); job.error=result.error; job.firmware=result.firmware
  if result.firmware then job.state='succeeded' else job.state='failed' end
end
job.source=''; job.sandboxId=nil
redis.call('SET', KEYS[1], cjson.encode(job), 'KEEPTTL')
redis.call('ZREM', KEYS[2], job.id); redis.call('ZREM', KEYS[3], job.id)
if redis.call('GET', KEYS[4]) == job.id then redis.call('DEL', KEYS[4]) end
return 1`;

export const CANCEL_JOB = `
local raw=redis.call('GET', KEYS[1]); if not raw then return 0 end
local job=cjson.decode(raw); if job.owner ~= ARGV[1] then return 0 end
if job.state ~= 'queued' and job.state ~= 'building' then return 1 end
local wasQueued=job.state=='queued'
job.state='cancelled'; job.source=''; job.error='Build cancelled'
redis.call('SET', KEYS[1], cjson.encode(job), 'KEEPTTL'); redis.call('ZREM', KEYS[2], job.id)
if wasQueued and redis.call('GET', KEYS[3]) == job.id then redis.call('DEL', KEYS[3]) end
return 1`;

export const RATE_LIMIT = `
local n=redis.call('INCR', KEYS[1]); if n==1 then redis.call('EXPIRE', KEYS[1], 60) end
if n>180 then return 0 end; return 1`;

export class RedisJobStore implements JobStore {
  constructor(private readonly redis: Redis, private readonly prefix: string, private readonly limits: CloudLimits, private readonly now = Date.now) {}
  private key(id: string) { return `${this.prefix}:${id}`; }
  async ready() { return await this.redis.ping() === 'PONG'; }
  async admit(job: CloudJob) {
    const now = this.now();
    const code = await this.redis.eval<unknown[], string>(ADMIT_JOB,
      [this.key('queue'), this.key(`owner:${job.owner}`), this.key(`hour:${job.owner}:${Math.floor(now/3600000)}`), this.key(`day:${Math.floor(now/86400000)}`), this.key(`job:${job.id}`)],
      [job.id, now, this.limits.waitMs, this.limits.maxQueued, this.limits.buildsPerHour, this.limits.buildsPerDay, job.expiresAt-now, JSON.stringify(job)]);
    const messages: Record<string, [string, number]> = {
      owner: ['You already have a queued or running build. Please wait for its cleanup.', 10],
      full: ['Build queue is full. Try again shortly.', 30],
      hour: ['Your hourly build allowance is exhausted.', Math.ceil((3600000-now%3600000)/1000)],
      day: ['The site has reached its daily build allowance.', Math.ceil((86400000-now%86400000)/1000)],
    };
    if (code !== 'ok') { const [message, retry] = messages[code] ?? ['Build service is busy.', 30]; throw new AdmissionError(message, retry); }
  }
  get(id: string) { return this.redis.get<CloudJob>(this.key(`job:${id}`)); }
  async claim(id: string, lease: string) {
    const job = await this.get(id); if (!job) return 'done';
    return this.redis.eval<unknown[], 'claimed' | 'busy' | 'done'>(CLAIM_JOB,
      [this.key(`job:${id}`), this.key('queue'), this.key('active'), this.key(`owner:${job.owner}`)],
      [this.now(), this.limits.waitMs, this.limits.concurrency, lease, this.limits.buildMs+30000]);
  }
  async update(id: string, lease: string, patch: { logs?: string; sandboxId?: string }) {
    return await this.redis.eval<unknown[], number>(UPDATE_JOB, [this.key(`job:${id}`)], [lease, JSON.stringify(patch)]) === 1;
  }
  async finish(id: string, lease: string | undefined, result: { firmware?: Firmware; error?: string }) {
    const job = await this.get(id); if (!job) return;
    await this.redis.eval(FINISH_JOB, [this.key(`job:${id}`), this.key('queue'), this.key('active'), this.key(`owner:${job.owner}`)], [lease ?? '', JSON.stringify(result)]);
  }
  async cancel(id: string, owner: string) {
    return await this.redis.eval<unknown[], number>(CANCEL_JOB, [this.key(`job:${id}`), this.key('queue'), this.key(`owner:${owner}`)], [owner]) === 1;
  }
  async release(id: string, lease: string) { await this.finish(id, lease, { error: 'Build worker stopped before completion. Please build again.' }); }
  async position(id: string) { const rank = await this.redis.zrank(this.key('queue'), id); return rank === null ? 0 : rank+1; }
  async rate(owner: string) {
    if (await this.redis.eval<unknown[], number>(RATE_LIMIT, [this.key(`rate:${owner}:${Math.floor(this.now()/60000)}`)], []) !== 1) throw new AdmissionError('Too many requests. Try again shortly.', 60);
  }
}
