// examples/http-server.ts
import { createServer } from 'node:http';
import { enableWatchReload } from '../dist/index.js';

// 1. Setup the watcher with a graceful delay
/*enableWatchReload(['./src', './examples'], {
  keepAlive:true,
  restartDelay: 500, // Wait 300ms after file changes
  delay: 900,        // Wait 500ms before killing the old process (gives OS time to free the port)
});*/

// 2. Start the server
const server = createServer((req, res) => {
 
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Hello World! node  Process PID: ${process.pid}\n`);
});

const PORT = 3000;
setTimeout(function() {
  server.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT} (PID: ${process.pid})`);
});
}, 0);

