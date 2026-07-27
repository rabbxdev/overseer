// examples/bun-serve.ts
import { enableWatchReload } from '../dist/index.js';

const PORT = 3000;

const server = Bun.serve({
  port: PORT,
  reusePort:true,   
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', pid: process.pid });
    }

    return new Response(`Hello from yup Bun! PID: ${process.pid}\n`, {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
});

console.log(`[bun] Serving on http://localhost:${PORT} (PID: ${process.pid})`);

// The catch: Bun.serve binds the port immediately.
// If we don't call server.stop() before the process exits,
// the new process will fail with EADDRINUSE.
enableWatchReload(['./src',"./examples"], {
  keepAlive:true,
  restartDelay: 300,
  delay: 200, // Bun releases ports faster than Node, 200ms is usually enough
  onBeforeReload: () => {
    console.log('[bun] Stopping server...');
    server.stop(true); // true = close active connections immediately
  },
  onAfterReload: () => {
    console.log('[bun] Warm restart complete');
  },
});