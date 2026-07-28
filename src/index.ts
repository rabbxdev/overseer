// src/index.ts
import { watch, type Watcher } from '@rabbx/watcher';
import { ms } from '@rabbx/ms';
import { cyan, green, red, yellow, dim, bold } from '@rabbx/colors';
import {
  type Plugin,
  type PluginContext,
  runHook,
} from './plugins.js';

export type { Plugin, PluginContext } from './plugins.js';
export { definePlugin } from './plugins.js';

type Runtime = 'bun' | 'deno' | 'node' | 'unknown';

// --- Log helpers ---
const logOverseer = (msg: string) => console.log(`${cyan('[Rabbx overseer]')} ${msg}`);
const logWatcher = (msg: string) => console.log(`${green('[watcher]')} ${msg}`);
const logError = (msg: string, err?: unknown) =>
  console.error(`${red('[error]')} ${msg}`, err ?? '');

/**
 * Full terminal reset. More reliable than console.clear() which
 * may scroll instead of clearing on some terminals.
 */
function clearTerminal(): void {
  process.stdout.write('\x1Bc');
}

function detectRuntime(): Runtime {
  // @ts-ignore
  if (typeof Bun !== 'undefined') return 'bun';
  // @ts-ignore
  if (typeof Deno !== 'undefined') return 'deno';
  if (typeof process !== 'undefined' && process.versions?.node) return 'node';
  return 'unknown';
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regex}$`);
}

export interface ReloadOptions {
  /** Wait for existing connections to close before killing */
  graceful?: boolean;
  /** Delay (ms) before killing the old process during graceful shutdown */
  delay?: number;
  /** Wait (ms) after the last file change before triggering a restart */
  restartDelay?: number;
  /** Debounce (ms) for watcher events */
  debounce?: number;
  /** Keep parent process alive to monitor and restart child if it crashes */
  keepAlive?: boolean;
  /** Clear the terminal on every reload */
  clearConsole?: boolean;
  /** Plugins to extend overseer behavior */
  plugins?: Plugin[];
  /** Hook executed in the old process before it exits */
  onBeforeReload?: () => void | Promise<void>;
  /** Hook executed in the new process after it starts */
  onAfterReload?: () => void;
}

export interface WatchOptions{ //extends Omit<WatcherOptions, 'ignored'> {
  paths?: string | string[];
  include?: string[];
  exclude?: string[];
  ignored?: (string | RegExp)[];
}

interface ChildProcessHandle {
  pid?: number;
  kill: (signal?: string) => void;
  onExit: (cb: (code: number | null, signal: string | null) => void) => void;
}

let watcher: Watcher | null = null;
let reloading = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let changedFiles = new Set<string>();
let childProcess: ChildProcessHandle | null = null;
let isShuttingDown = false;
let activePlugins: Plugin[] = [];
let activeContext: PluginContext | null = null;

/**
 * Sanitize environment variables for cross-runtime compatibility.
 * Deno's Command API strictly requires Record<string, string>,
 * while Node's process.env can contain undefined.
 */
function getCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function spawnNewProcess(opts: ReloadOptions): Promise<ChildProcessHandle | null> {
  const runtime = detectRuntime();
  const execPath = process.argv[0];
  const args = process.argv.slice(1);

  const env = {
    ...getCleanEnv(),
    __RELOADED: '1',
    __CHANGED_FILES: [...changedFiles].join(','),
  };

  if (activeContext) {
    await runHook('onBeforeSpawn', activePlugins, activeContext, env);
  }

  logOverseer(`Spawning new ${bold(runtime)} process...`);
  if (changedFiles.size) {
    logOverseer(`Changed: ${dim([...changedFiles].join(', '))}`);
  }

  let handle: ChildProcessHandle;

  if (runtime === 'bun') {
    // Bun requires stdin/stdout/stderr individually (not stdio array)
    // @ts-ignore
    const subprocess = Bun.spawn([execPath, ...args], {
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      detached: !opts.keepAlive,
    });
    handle = {
      pid: subprocess.pid,
      kill: (signal = 'SIGTERM') => subprocess.kill(signal),
      onExit: (cb) => { subprocess.exited.then((code) => cb(code, null)); },
    };
    if (!opts.keepAlive) subprocess.unref?.();
  } else if (runtime === 'deno') {
    // Auto-inject required Deno permissions
    const requiredFlags = [
      '--allow-net', '--allow-read', '--allow-env',"--unstable-sloppy-imports","--allow-write",
      '--allow-run', '--unstable-net',
    ];
    const finalArgs = [...new Set([...requiredFlags, ...args])];
    // @ts-ignore
    const child = new Deno.Command(execPath, {
      args: finalArgs, env, stdout: 'inherit', stderr: 'inherit',
    }).spawn();
    handle = {
      pid: child.pid,
      kill: (signal = 'SIGTERM') => { try { child.kill(signal); } catch {} },
      onExit: (cb) => { child.status.then((s) => cb(s.code, s.signal ?? null)); },
    };
  } else if (runtime === 'node') {
    const { spawn } = await import('child_process');
    const child = spawn(execPath, args, {
      env, stdio: 'inherit', detached: !opts.keepAlive,
    });
    handle = {
      pid: child.pid,
      kill: (signal = 'SIGTERM') => child.kill(signal),
      onExit: (cb) => { child.on('exit', (code, signal) => cb(code, signal)); },
    };
    if (!opts.keepAlive) child.unref();
  } else {
    throw new Error('Unsupported runtime');
  }

  if (handle.pid) {
    logOverseer(`Child process started with PID: ${bold(String(handle.pid))}`);
  }

  if (activeContext) {
    await runHook('onAfterSpawn', activePlugins, activeContext, handle.pid);
  }

  return handle;
}

async function gracefulShutdownChild(timeout = 5000): Promise<void> {
  if (!childProcess) return;
  logOverseer(`Sending SIGTERM to child process (PID: ${childProcess.pid})...`);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      logOverseer(`Child did not exit in ${ms(timeout)}. Force killing...`);
      try { childProcess?.kill('SIGKILL'); } catch {}
      finish();
    }, timeout);
    childProcess.onExit(() => {
      logOverseer('Child process exited gracefully');
      finish();
    });
    childProcess.kill('SIGTERM');
  });
}

export async function reloadProcess(opts: ReloadOptions = {}) {
  if (reloading) return;
  reloading = true;

  const { graceful = true, delay = 500, onBeforeReload } = opts;

  if (activeContext) {
    await runHook('onBeforeReload', activePlugins, activeContext, [...changedFiles]);
  }

  try {
    if (onBeforeReload) {
      logOverseer(`Running ${dim('onBeforeReload')} hook...`);
      await onBeforeReload();
    }
  } catch (e) {
    logError(`${red('onBeforeReload failed. Aborting restart.')}`, e);
    reloading = false;
    return;
  }

  if (opts.keepAlive && childProcess) {
    await gracefulShutdownChild(delay);
    childProcess = null;
  } else if (graceful) {
    logOverseer(`Waiting ${ms(delay)} before exit...`);
    await new Promise(r => setTimeout(r, delay));
  }

  const newChild = await spawnNewProcess(opts);

  if (opts.keepAlive && newChild) {
    childProcess = newChild;
    childProcess.onExit((code, signal) => {
      if (isShuttingDown) return;
      if (activeContext) {
        runHook('onChildExit', activePlugins, activeContext, code, signal);
      }
      if (code !== 0 && code !== null) {
        logError(`Child process exited with code ${code}. Restarting...`);
        setTimeout(() => {
          if (!isShuttingDown) reloadProcess(opts).catch((e) => logError('Restart failed:', e));
        }, 1000);
      } else if (signal) {
        logOverseer(`Child process killed by signal ${signal}`);
      } else {
        logOverseer('Child process exited normally');
      }
    });
    reloading = false;
  } else {
    if (activeContext) {
      await runHook('onAfterReload', activePlugins, activeContext);
    }
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  }
}

function shouldReload(file: string, include?: string[], exclude?: string[], exts?: string[]): boolean {
  // Normalize path separators for cross-platform regex matching
  const normalizedFile = file.replace(/\\/g, '/');

  if (exclude?.some(g => globToRegex(g).test(normalizedFile))) return false;
  if (include?.length) {
    return include.some(g => globToRegex(g).test(normalizedFile));
  }
  // Default extension filter
  const extsRegex = new RegExp(`\\.(${(exts ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json']).join('|')})$`);
  return extsRegex.test(normalizedFile);
}

function scheduleRestart(opts: ReloadOptions) {
  if (restartTimer) clearTimeout(restartTimer);
  const { restartDelay = 1000 } = opts;
  restartTimer = setTimeout(async () => {
    await reloadProcess(opts);
  }, restartDelay);
}

export function enableWatchReload(
  paths: string | string[] = ['./'],
  watchOpts: WatchOptions & ReloadOptions = {}
) {
  if (watcher) return watcher;

  const {
    include, exclude,
    ignored = [/node_modules/, /\.git/, /dist/, /\.bun/, /\.tmp/],
    ignoreInitial = true, recursive = true, delay = 100,
    ignoreBinary = true, debounce = 100,
    awaitWriteFinish = { stabilityThreshold: 300, pollInterval: 100 },
    keepAlive = false,
    clearConsole = false,
    plugins = [],
    exts,
    ...rest
  } = watchOpts;

  // Store plugins and context for hook invocations
  activePlugins = plugins;
  activeContext = {
    runtime: detectRuntime(),
    script: process.argv[1] ?? '',
    args: process.argv.slice(2),
  };

  const watchPaths = Array.isArray(paths) ? paths : [paths];
  const restartDelay = watchOpts.restartDelay ?? 1000;

  logOverseer(`Watching: ${bold(watchPaths.join(', '))}`);
  logOverseer(
    `Debounce: ${ms(debounce)} | RestartDelay: ${ms(restartDelay)} | KeepAlive: ${keepAlive ? bold('yes') : dim('no')} | ClearConsole: ${clearConsole ? bold('yes') : dim('no')}`
  );
  if (plugins.length) {
    logOverseer(`Plugins: ${dim(plugins.map(p => p.name).join(', '))}`);
  }

  // Fire onStart hook
  if (activeContext) {
    runHook('onStart', activePlugins, activeContext).catch(() => {});
  }

  watcher = watch(watchPaths, {
    ignored, ignoreInitial, recursive, delay, ignoreBinary, awaitWriteFinish, ...rest,
  });

  watcher.on('ready', () => logWatcher('Ready'));
  watcher.on('error', (err) => logError('Watcher error:', err));

  watcher.on('all', async (event, file) => {
    if (reloading || isShuttingDown) return;
    if (!shouldReload(file, include, exclude, exts)) return;

    if (activeContext) {
      const vetoed = await runHook('onFileChange', activePlugins, activeContext, event, file);
      if (vetoed) return;
    }

    changedFiles.add(file);
    const eventColor = event === 'change' ? yellow : cyan;

    if (clearConsole) {
      clearTerminal();
    }

    logWatcher(`${eventColor(event)}: ${dim(file)}`);
    scheduleRestart(watchOpts);
  });

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logWatcher('Shutting down...');
    if (restartTimer) clearTimeout(restartTimer);

    if (activeContext) {
      await runHook('onShutdown', activePlugins, activeContext);
    }

    if (keepAlive && childProcess) {
      await gracefulShutdownChild(5000);
    }

    await watcher?.close();
    logWatcher('Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Handle post-reload logic if this process was spawned by a previous reload
  if (process.env.__RELOADED === '1') {
    watchOpts.onAfterReload?.();
    if (process.env.__CHANGED_FILES) {
      logOverseer(`Triggered by: ${dim(process.env.__CHANGED_FILES)}`);
    }
  }

  return watcher;
}

export function enableHotReload(opts: ReloadOptions = {}) {
  process.on('SIGUSR2', () => {
    logOverseer(`${yellow('SIGUSR2')} received`);
    changedFiles.clear();
    reloadProcess(opts).catch(console.error);
  });
  logOverseer(`Hot reload enabled. Send ${bold('SIGUSR2')} to reload`);
}

export async function closeWatcher() {
  if (restartTimer) clearTimeout(restartTimer);
  if (activeContext) {
    await runHook('onShutdown', activePlugins, activeContext);
  }
  if (childProcess) {
    await gracefulShutdownChild(5000);
    childProcess = null;
  }
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}