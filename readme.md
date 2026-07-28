<p align="center">
  <img src="./logo.svg" width="160" />
</p>
<h1 align="center">@rabbx/overseer</h1>
<p align="center">Universal File Watcher + Process Reloader</p>
A universal process overseer and file watcher for **Node.js**, **Bun**, and **Deno**.

Built to survive the realities of local development: it watches files, gracefully restarts processes on changes, automatically injects required Deno permissions, and acts as a supervisor to keep your app alive if it crashes.

[![GitHub](https://img.shields.io/badge/GitHub-rabbxdev/overseer-black?logo=github)](https://github.com/rabbxdev/overseer)
[![Ko-fi](https://img.shields.io/badge/Support_on_Ko--fi-rabbxdev-ff5f5f?logo=kofi)](https://ko-fi.com/rabbxdev)

---

## Installation

```bash
npm install -g @rabbx/overseer
# or
bun add -g @rabbx/overseer
# or
deno install -A npm:@rabbx/overseer
```

*Note: This package relies on `@rabbx/watcher` for robust, cross-platform file system events.*

---

## Quick Start

Run any script with auto-reload and supervision. No complex flags required.

```bash
# Full command
overseer server.ts

# Shorthand aliases
ovs server.ts          # Auto-detects runtime (Bun → Deno → Node)
ovsnode server.ts      # Forces Node.js
ovsbun server.ts       # Forces Bun
ovsdeno server.ts      # Forces Deno (with all permissions)

# With CLI flags
ovs server.ts --clear --watch src,lib --restart-delay 300
```

That's it. The overseer watches your files, restarts on changes, and keeps the process alive if it crashes.

---

## Features

- **Universal Runtime Detection**: Automatically detects and spawns processes correctly for Node.js, Bun, or Deno.
- **Zero-Friction Deno**: Automatically injects `--allow-net`, `--allow-read`, `--allow-env`, `--allow-run`, and `--unstable-net` into child processes. No more massive CLI flag strings or interactive permission prompts.
- **Supervisor Mode (`keepAlive`)**: The overseer stays alive, monitors the child, and automatically restarts it if it crashes (exit code ≠ 0).
- **Graceful Shutdown**: Sends `SIGTERM`, waits for a configurable timeout, and falls back to `SIGKILL` to prevent zombie processes and port conflicts.
- **Terminal Clearing**: Built-in `--clear` flag to wipe the terminal on every reload for a clean slate.
- **Smart Debouncing**: Prevents the "thundering herd" problem when IDE auto-saves trigger rapid events.
- **Beautiful Logs**: Built-in integration with `@rabbx/colors` and `@rabbx/ms` for scannable, human-readable terminal output.
- **Extensible Plugin System**: Vite/Rollup-style plugin API to intercept lifecycle events, mutate environments, or veto file changes.

---

## CLI Usage

### Options

| Flag | Description | Default |
|---|---|---|
| `-w, --watch <paths>` | Paths to watch (comma-separated) | `./` |
| `--include <globs>` | Glob patterns to include (comma-separated) | - |
| `--exclude <globs>` | Glob patterns to exclude (comma-separated) | - |
| `--restart-delay <ms>` | Delay after last change before restart | `500` |
| `--delay <ms>` | Graceful shutdown delay | `500` |
| `--debounce <ms>` | Watcher debounce | `100` |
| `--clear` / `--no-clear` | Clear the terminal on every reload | `false` |
| `--no-graceful` | Disable graceful shutdown | - |
| `--no-keep-alive` | Disable supervisor mode | - |
| `--exts <exts>` | File extensions to watch (comma-separated) | `ts,tsx,js,jsx,mjs,cjs,json` |
| `-c, --config <path>` | Path to config file | - |

### Config File

Create `overseer.config.ts` in your project root:

```typescript
import { defineConfig } from '@rabbx/config';
import { definePlugin } from '@rabbx/overseer';

const myPlugin = definePlugin({
  name: 'my-plugin',
  onFileChange(_event, file) {
    if (file.endsWith('.log')) return false; // Veto reload
  },
});

export default defineConfig({
  watch: ['./src', './lib'],
  include: ['**/*.ts'],
  exclude: ['**/*.test.ts'],
  restartDelay: 300,
  delay: 500,
  keepAlive: true,
  clearConsole: true,
  exts: ['ts', 'tsx', 'js', 'json'],
  plugins: [myPlugin],
});
```

Config precedence: **CLI flags > config file > defaults**

---

## Programmatic API

You can also use the overseer as a library in your code:

```typescript
import { enableWatchReload } from '@rabbx/overseer';

enableWatchReload(['./src'], {
  keepAlive: true,
  clearConsole: true,
  restartDelay: 500,
  onBeforeReload: async () => {
    console.log('Cleaning up DB connections before reload...');
    // await db.close();
  }
});

// Your app logic
startServer();
```

### API Reference

#### `enableWatchReload(paths, options)`
Starts watching the specified paths and automatically reloads the process on matching changes.

| Property | Type | Default | Description |
|---|---|---|---|
| `paths` | `string \| string[]` | `['./']` | Directories or files to watch. |
| `include` / `exclude` | `string[]` | `undefined` | Glob patterns to filter files. |
| `restartDelay` | `number` | `1000` | Ms to wait after the *last* detected change. |
| `delay` | `number` | `500` | Ms to wait during graceful shutdown. |
| `keepAlive` | `boolean` | `false` | If `true`, parent stays alive and supervises the child. |
| `clearConsole` | `boolean` | `false` | If `true`, wipes the terminal on every reload. |
| `plugins` | `Plugin[]` | `[]` | Array of plugin objects. |
| `onBeforeReload` | `() => void \| Promise<void>` | `undefined` | Async hook executed before the process exits. |
| `onAfterReload` | `() => void` | `undefined` | Hook executed in the *new* process after it boots. |

#### `enableHotReload(options)`
Attaches a `SIGUSR2` listener for manual reload triggers (e.g., from an IDE extension).

```typescript
import { enableHotReload } from '@rabbx/overseer';

enableHotReload({ onBeforeReload: () => cleanupDatabase() });
// Trigger manually: kill -SIGUSR2 <pid>
```

#### `reloadProcess(options)` & `closeWatcher()`
Manually trigger a reload sequence or cleanly shut down the active watcher and supervised child process.

---

## Plugin System

Plugins are factory functions (Vite/Rollup style) that intercept lifecycle events. Errors in plugins are isolated so one broken plugin can't crash the overseer.

```typescript
import { definePlugin } from '@rabbx/overseer';

export const envInjectorPlugin = (vars: Record<string, string>) => {
  return definePlugin({
    name: 'env-injector',
    onBeforeSpawn(env) {
      Object.assign(env, vars); // Mutate environment before spawn
    },
  });
};
```

**Available Hooks:**
- `onStart(ctx)`: Overseer boots, before first spawn.
- `onFileChange(event, file, ctx)`: Return `false` to veto the reload.
- `onBeforeReload(changedFiles, ctx)`: After debounce, before restart.
- `onBeforeSpawn(env, ctx)`: Mutate `env` before child spawns.
- `onAfterSpawn(pid, ctx)`: Child successfully spawned.
- `onChildExit(code, signal, ctx)`: Child process exits.
- `onAfterReload(ctx)`: New child is running.
- `onShutdown(ctx)`: Overseer is shutting down.
- `onError(error, info, ctx)`: Centralized error handling for other hooks.

---

## Runtime-Specific Notes

- **Node.js**: Uses native `child_process.spawn` with `detached: true` (unless `keepAlive` is enabled) and `.unref()` to ensure clean handoffs.
- **Bun**: Uses `Bun.spawn` with explicit `stdin`/`stdout`/`stderr: 'inherit'` to avoid Bun's strict array-type requirements for `stdio`.
- **Deno**: Uses the modern `Deno.Command` API. **Permission Injection**: The overseer automatically prepends required flags (`--allow-net`, `--allow-read`, `--allow-env`, `--allow-run`, `--unstable-net`) to the child process. 
  - *Override behavior*: Deno evaluates flags left-to-right. If you explicitly run `deno run --deny-net server.ts`, your `--deny-net` flag will correctly override our injected `--allow-net` because it appears later in the final argument array.

---

## Environment Variables

When a process is reloaded, the new instance receives:
- `__RELOADED=1`: Indicates this is a restarted process.
- `__CHANGED_FILES=src/index.ts,src/utils.ts`: A comma-separated list of files that triggered the restart.

```typescript
if (process.env.__RELOADED === '1') {
  console.log(`Warm start triggered by: ${process.env.__CHANGED_FILES}`);
  // Example: Skip expensive initial seed data loading on reload
}
```

---

## Edge Cases & Pro Tips

1. **Hanging Hooks**: If your `onBeforeReload` hook hangs or throws, the reload sequence will abort to prevent a zombie process state. Keep cleanup logic fast and wrap it in `try/catch`.
2. **Port Conflicts**: The default `delay` (500ms) gives the OS time to release bound ports before the new process starts. If you still hit `EADDRINUSE`, increase the `delay` option to `1000`.
3. **Binary Files**: The watcher ignores binary files by default to prevent reloads triggered by compiled artifacts, lockfiles, or IDE swap files.

---

## Support

If this saves you from nodemon race conditions, Deno permission hell, or webpack-dev-server PTSD, consider buying me a coffee.

[![Support on Ko-fi](https://img.shields.io/badge/Support_on_Ko--fi-rabbxdev-ff5f5f?logo=kofi&style=for-the-badge)](https://ko-fi.com/rabbxdev)

---

## License

MIT © [rabbxdev](https://github.com/rabbxdev)