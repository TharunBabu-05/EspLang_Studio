import type { Firmware, ServerEvent } from '@esplang/compiler';
import { BuildError } from './builder.js';
import type { BuildExecutor } from './hosting.js';
import { randomUUID } from 'node:crypto';

export function remoteExecutor(base: string, secret: string, timeoutMs = 240000): BuildExecutor {
  return async (input, emit, signal) => {
    const id = randomUUID();
    const network = new AbortController();
    const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
    let responseStarted = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      cancelTimer ??= setTimeout(() => network.abort(), 30000);
      if (responseStarted)
        void fetch(new URL('/cancel', base), {
          method: 'POST',
          headers,
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(10000),
        })
          .then((response) => {
            if (!response.ok) network.abort();
          })
          .catch(() => network.abort());
    };
    const timer = setTimeout(() => network.abort(), timeoutMs + 30000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const response = await fetch(new URL('/build', base), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...input, id }),
        signal: network.signal,
      });
      responseStarted = true;
      if (signal.aborted) cancel();
      if (!response.ok || !response.body)
        throw new Error('Isolated build worker is unavailable. Try again shortly.');
      let buffer = '',
        bytes = 0,
        result: Firmware | undefined;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 12_000_000) throw new Error('Worker response exceeded its size limit');
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as ServerEvent;
          if (event.type === 'error') throw new BuildError(event.message, event.diagnostics);
          if (event.type === 'result') result = event.firmware;
          else if (event.type === 'log') emit(event);
          else throw new Error('Invalid worker response');
        }
      }
      if (
        buffer.trim() ||
        !result ||
        result.board !== input.board ||
        result.serialRoute !== input.serialRoute
      )
        throw new Error('Worker did not return a complete firmware result');
      signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      signal.removeEventListener('abort', cancel);
      network.abort();
    }
  };
}
