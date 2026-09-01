import type { Response } from 'express';

export interface SseChannel {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Server-sent events with the headers proxies need to not buffer the stream.
 * Without `X-Accel-Buffering: no` an nginx-style proxy will hold the crawl log
 * until the response ends, which is precisely the opposite of the point.
 */
export function openSse(res: Response): SseChannel {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  // Comment lines keep intermediaries from timing the connection out.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);

  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };

  res.on('close', finish);
  res.on('error', finish);

  return {
    get closed() { return closed; },
    send(event: string, data: unknown): void {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text: string): void {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    close(): void {
      finish();
      res.end();
    },
  };
}
