// examples/deno-serve.ts
import { enableWatchReload } from '../src/index.ts';

const PORT = 3000;
 
// Deno.serve returns an HttpServer with a .shutdown() method (Deno 2.x)
// or .close() in Deno 1.x. We target 2.x here.
const server = Deno.serve({ port: PORT ,reusePort:true}, (req) => {
  const url = new URL(req.url);

  if (url.pathname === '/health') {
    return Response.json({ status: 'ok', pid: Deno.pid });
  }

  return new Response(`Hello from Den! PID: ${Deno.pid}\n`, { 
    headers: { 'Content-Type': 'text/plain' },
  }); 
});
 
console.log(`[deno] Serving on http://localhost:${PORT} (PID: ${Deno.pid})`);  

enableWatchReload(['./src',"./examples"], {  
  keepAlive:true,
  restartDelay: 300,
  delay: 300,
  onBeforeReload: async () => {
    console.log('[deno] Shutting down server...');
    // Deno 2.x: .shutdown() returns a Promise that resolves
    // once all active connections are drained.
    await server.shutdown();
  },
  onAfterReload: () => {
    console.log('[deno] Warm restart complete');
  },
});