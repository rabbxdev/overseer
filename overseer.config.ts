import { defineConfig } from '@rabbx/config';
import { definePlugin } from '@rabbx/overseer';

const myPlugin = definePlugin({
  name: 'my-plugin',
 onBeforeSpawn:async (ev,f)=>{
   return ev
   console.log(ev,f,"b4") 
    return true
  },
  onFileChange: async (_event, file,ctx)=>{ 
     
    console.log(_event,file,ctx,"co")
    return true
  }, 
}); 
 
export default defineConfig({
  watch: ['./src',"./examples"],
  include: ['**/*.ts'],
  exclude: ['**/*.test.ts'],
  restartDelay: 300,  
  delay:200,
  keepAlive: true,
  clearConsole: true,
  exts: ['ts', 'tsx', 'json'], 
  plugins: [myPlugin],
}); 
