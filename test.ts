import { z } from 'zod';
import { loadAny } from '@rabbx/config'
const overseerSchema = z.object({
  watch: z.union([z.string(), z.array(z.string())]).optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  restartDelay: z.number().optional(),
  delay: z.number().optional(),
  debounce: z.number().optional(),
  graceful: z.boolean().optional(),
  keepAlive: z.boolean().optional(),
  exts: z.array(z.string()).optional(),
  clearConsole: z.boolean().optional(),
  plugins: z.array(z.any()).optional(),
}).passthrough();

const candidates =  [
          './overseer.config.ts',
          './overseer.config.js',
          './overseer.config.mjs',
          './overseer.config.cjs',
          './overseer.config.json',
          './rabbx.config.ts',
          './rabbx.config.js',
        ];  

    const configManager = await loadAny(candidates, overseerSchema, { cache: { maxSize: 10 },watch:true });
      
    const fileConfig = configManager.get() || {};
    const filePath = configManager.filePath;
configManager.watch(async (newConfig) => {
      console.log("con ch",newConfig)
}, {
  delay: 100,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  exclude: ['**/node_modules/**']
}); 
console.log("here")
Promise.resolve("vv")
Bun.serve({
  fetch:(req)=>{
    return new Response("hhh")
  }
})