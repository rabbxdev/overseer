import { defineConfig } from '@rabbx/config';
import { definePlugin } from '@rabbx/overseer';

const myPlugin = definePlugin({
  name: 'my-plugin',
  onFileChange(_event, file) {
     
    console.log(_event,file,"co")
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
