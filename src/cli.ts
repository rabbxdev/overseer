
import cac from 'cac';
import { watch, type Watcher } from '@rabbx/watcher'; 
import { ms } from '@rabbx/ms';
import { cyan, green, red, yellow, dim, bold } from '@rabbx/colors';
import { resolve, isAbsolute, dirname, relative } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import { loadAny } from '@rabbx/config';
import {
  type Plugin,
  type PluginContext,
  runHook,
} from './plugins.js';

// --- Global error handlers ---
process.on('uncaughtException', (err) => {
  console.error(`${red('[overseer]')} Uncaught exception:`, err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`${red('[overseer]')} Unhandled rejection:`, reason);
  process.exit(1);
});

// --- Log helpers ---
const logOverseer = (msg: string) => console.log(`${cyan('[overseer]')} ${msg}`);
const logWatcher = (msg: string) => console.log(`${green('[watcher]')} ${msg}`);
const logError = (msg: string, err?: unknown) =>
  console.error(`${red('[error]')} ${msg}`, err ?? '');

function clearTerminal(): void {
  process.stdout.write('\x1Bc');
}

// --- Types ---
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

type OverseerConfig = z.infer<typeof overseerSchema>;

interface ChildProcessHandle {
  pid?: number;
  kill: (signal?: string) => void;
  onExit: (cb: (code: number | null, signal: string | null) => void) => void;
}

// --- Runtime detection ---
type Runtime = 'bun' | 'deno' | 'node' | 'unknown';

function detectRuntime(): Runtime {
  // @ts-ignore
  if (typeof Bun !== 'undefined') return 'bun';
  // @ts-ignore
  if (typeof Deno !== 'undefined') return 'deno';
  if (typeof process !== 'undefined' && process.versions?.node) return 'node';
  return 'unknown';
}

function getCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
}

// --- Child process spawning ---
async function spawnChild(
  script: string,
  scriptArgs: string[],
  env: Record<string, string>,
  keepAlive: boolean
): Promise<ChildProcessHandle> {
  const runtime = detectRuntime();
  const execPath = process.argv[0];

  if (runtime === 'bun') {
    // @ts-ignore
    const subprocess = Bun.spawn([execPath, script, ...scriptArgs], {
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      detached: !keepAlive,
    });
    if (!keepAlive) subprocess.unref?.();
    return {
      pid: subprocess.pid,
      kill: (signal = 'SIGTERM') => subprocess.kill(signal),
      onExit: (cb) => { subprocess.exited.then((code) => cb(code, null)); },
    };
  }

  if (runtime === 'deno') {
    const requiredFlags = [
      '--allow-net', '--allow-read', '--allow-env',
      '--allow-run', '--unstable-net',
    ];
    const finalArgs = [...new Set([...requiredFlags, script, ...scriptArgs])];

    // @ts-ignore
    const child = new Deno.Command(execPath, {
      args: finalArgs,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    }).spawn();

    return {
      pid: child.pid,
      kill: (signal = 'SIGTERM') => {
        try { child.kill(signal); } catch { /* already dead */ }
      },
      onExit: (cb) => {
        child.status.then((s) => cb(s.code, s.signal ?? null));
      },
    };
  }

  if (runtime === 'node') {
    const { spawn } = await import('node:child_process');
    const child = spawn(execPath, [script, ...scriptArgs], {
      env,
      stdio: 'inherit',
      detached: !keepAlive,
    });
    if (!keepAlive) child.unref();
    return {
      pid: child.pid,
      kill: (signal = 'SIGTERM') => child.kill(signal),
      onExit: (cb) => { child.on('exit', (code, signal) => cb(code, signal)); },
    };
  }

  throw new Error(`Unsupported runtime: ${runtime}`);
}

// --- Graceful shutdown ---
async function gracefulShutdown(
  child: ChildProcessHandle,
  timeout: number
): Promise<void> {
  if (!child.pid) return;

  logOverseer(`Sending SIGTERM to child (PID: ${child.pid})...`);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(forceTimer);
      resolve();
    };

    const forceTimer = setTimeout(() => {
      logOverseer(`Child did not exit in ${ms(timeout)}. Force killing...`);
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      finish();
    }, timeout);

    child.onExit(() => {
      logOverseer('Child exited gracefully');
      finish();
    });

    child.kill('SIGTERM');
  });
}

// --- Config loading ---
async function resolveConfig(
  cliFlags: Partial<OverseerConfig>,
  configPath?: string
): Promise<{ config: OverseerConfig; configFilePath: string | null }> {
  try {
    const candidates = configPath 
      ? [configPath] 
      : [
          './overseer.config.ts',
          './overseer.config.js',
          './overseer.config.mjs',
          './overseer.config.cjs',
          './overseer.config.json',
          './rabbx.config.ts',
          './rabbx.config.js',
        ];

    const configManager = await loadAny(candidates, overseerSchema, { cache: { maxSize: 10 } });
    const fileConfig = configManager.get() || {};
    const filePath = configManager.filePath;

    return {
      config: {
        watch: cliFlags.watch ?? fileConfig.watch ?? ['./'],
        include: cliFlags.include ?? fileConfig.include,
        exclude: cliFlags.exclude ?? fileConfig.exclude,
        restartDelay: cliFlags.restartDelay ?? fileConfig.restartDelay ?? 500,
        delay: cliFlags.delay ?? fileConfig.delay ?? 500,
        debounce: cliFlags.debounce ?? fileConfig.debounce ?? 100,
        graceful: cliFlags.graceful ?? fileConfig.graceful ?? true,
        keepAlive: cliFlags.keepAlive ?? fileConfig.keepAlive ?? true,
        exts: cliFlags.exts ?? fileConfig.exts ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json'],
        clearConsole: cliFlags.clearConsole ?? fileConfig.clearConsole ?? false,
        plugins: fileConfig.plugins ?? [],
      },
      configFilePath: filePath,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (!errMsg.includes('not found') && !errMsg.includes('ENOENT')) {
      logOverseer(`Config loading skipped: ${dim(errMsg)}`);
    }

    return {
      config: {
        watch: cliFlags.watch ?? ['./'],
        include: cliFlags.include,
        exclude: cliFlags.exclude,
        restartDelay: cliFlags.restartDelay ?? 500,
        delay: cliFlags.delay ?? 500,
        debounce: cliFlags.debounce ?? 100,
        graceful: cliFlags.graceful ?? true,
        keepAlive: cliFlags.keepAlive ?? true,
        exts: cliFlags.exts ?? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json'],
        clearConsole: cliFlags.clearConsole ?? false,
        plugins: [],
      },
      configFilePath: null,
    };
  }
}

// --- Main CLI ---
const cli = cac('overseer');

cli
  .command('<script> [...args]', 'Oversee a script with auto-reload')
  .option('-w, --watch <paths>', 'Paths to watch (comma-separated)', { default: './' })
  .option('--include <globs>', 'Glob patterns to include (comma-separated)')
  .option('--exclude <globs>', 'Glob patterns to exclude (comma-separated)')
  .option('--restart-delay <ms>', 'Delay after last change before restart', { default: 500 })
  .option('--delay <ms>', 'Graceful shutdown delay', { default: 500 })
  .option('--debounce <ms>', 'Watcher debounce', { default: 100 })
  .option('--no-graceful', 'Disable graceful shutdown')
  .option('--no-keep-alive', 'Disable supervisor mode')
  .option('--exts <exts>', 'File extensions to watch (comma-separated)')
  .option('--clear', 'Clear the terminal on every reload')
  .option('--no-clear', 'Disable terminal clearing')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (script: string, scriptArgs: string[], rawOptions: any) => {
    const scriptPath = isAbsolute(script) ? script : resolve(process.cwd(), script);

    if (!existsSync(scriptPath)) {
      logError(`Script not found: ${scriptPath}`);
      process.exit(1);
    }

    const cliFlags: Partial<OverseerConfig> = {
      watch: typeof rawOptions.watch === 'string'
        ? rawOptions.watch.split(',').map((s: string) => s.trim())
        : rawOptions.watch,
      include: rawOptions.include?.split(',').map((s: string) => s.trim()),
      exclude: rawOptions.exclude?.split(',').map((s: string) => s.trim()),
      exts: rawOptions.exts?.split(',').map((s: string) => s.trim()),
      restartDelay: rawOptions.restartDelay ? Number(rawOptions.restartDelay) : undefined,
      delay: rawOptions.delay ? Number(rawOptions.delay) : undefined,
      debounce: rawOptions.debounce ? Number(rawOptions.debounce) : undefined,
      graceful: rawOptions.graceful,
      keepAlive: rawOptions.keepAlive,
      clearConsole: rawOptions.clear,
    };

    const { config: initialConfig, configFilePath } = await resolveConfig(cliFlags, rawOptions.config);
    
    let currentConfig = initialConfig;
    const runtime = detectRuntime();

    const ctx: PluginContext = {
      runtime,
      script: scriptPath,
      args: scriptArgs,
    };

    logOverseer(`Starting ${bold(script)} with ${bold(runtime)}`);
    
    // --- FIX: Ensure we ONLY pass directories to the watcher ---
    const rawWatchPaths = Array.isArray(currentConfig.watch) ? currentConfig.watch : [currentConfig.watch!];
    const watchDirs = new Set<string>();

    for (const p of rawWatchPaths) {
      const absPath = isAbsolute(p) ? p : resolve(process.cwd(), p);
      if (existsSync(absPath)) {
        const stats = statSync(absPath);
        watchDirs.add(stats.isFile() ? dirname(absPath) : absPath);
      } else {
        watchDirs.add(absPath);
      }
    }

    if (configFilePath) {
      const absConfigPath = isAbsolute(configFilePath) ? configFilePath : resolve(process.cwd(), configFilePath);
      watchDirs.add(dirname(absConfigPath));
    }

    const finalWatchPaths = Array.from(watchDirs);

    logWatcher(`Watching dirs: ${bold(finalWatchPaths.join(', '))}`);
    logWatcher(
      `RestartDelay: ${ms(currentConfig.restartDelay!)} | ShutdownDelay: ${ms(currentConfig.delay!)} | KeepAlive: ${currentConfig.keepAlive ? bold('yes') : dim('no')} | ClearConsole: ${currentConfig.clearConsole ? bold('yes') : dim('no')}`
    );
    
    // FIX: Always derive plugins from currentConfig
    const plugins = (currentConfig.plugins as Plugin[]) ?? [];
    if (plugins.length) {
      logOverseer(`Plugins: ${dim(plugins.map(p => p.name).join(', '))}`);
    }

    // FIX: Create a function that always uses the latest config
    const shouldReload = (absoluteFile: string): boolean => {
      // Get relative path from cwd for pattern matching
      const relPath = relative(process.cwd(), absoluteFile).replace(/\\/g, '/');
      const absPathNormalized = absoluteFile.replace(/\\/g, '/');
      
      // Test against both relative and absolute paths
      const testPaths = [relPath, absPathNormalized];
      
      // Check exclude patterns
      if (currentConfig.exclude?.length) {
        for (const pattern of currentConfig.exclude) {
          const regex = globToRegex(pattern);
          if (testPaths.some(p => regex.test(p))) {
            return false;
          }
        }
      }
      
      // Check include patterns
      if (currentConfig.include?.length) {
        let included = false;
        for (const pattern of currentConfig.include) {
          const regex = globToRegex(pattern);
          if (testPaths.some(p => regex.test(p))) {
            included = true;
            break;
          }
        }
        if (!included) return false;
      }
      
      // Check file extension (always use latest config)
      const extsRegex = new RegExp(`\\.(${(currentConfig.exts ?? []).join('|')})$`);
      return extsRegex.test(absPathNormalized);
    };

    let watcher: Watcher | null = null;
    let child: ChildProcessHandle | null = null;
    let restarting = false;
    let shuttingDown = false;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    const changedFiles = new Set<string>();

    const startChild = async () => {
      const env = {
        ...getCleanEnv(),
        __RELOADED: child ? '1' : '0',
        __CHANGED_FILES: [...changedFiles].join(','),
      };

      // FIX: Always use current plugins
      const currentPlugins = (currentConfig.plugins as Plugin[]) ?? [];
      await runHook('onBeforeSpawn', currentPlugins, ctx, env);

      logOverseer(`Spawning ${bold(runtime)} process...`);
      if (changedFiles.size) {
        logOverseer(`Changed: ${dim([...changedFiles].join(', '))}`);
      }

      child = await spawnChild(scriptPath, scriptArgs, env, currentConfig.keepAlive!);
      if (child.pid) {
        logOverseer(`Child started with PID: ${bold(String(child.pid))}`);
      }

      await runHook('onAfterSpawn', currentPlugins, ctx, child.pid);

      child.onExit(async (code, signal) => {
        if (shuttingDown || restarting) return;

        const currentPlugins = (currentConfig.plugins as Plugin[]) ?? [];
        await runHook('onChildExit', currentPlugins, ctx, code, signal);

        if (code !== 0 && code !== null) {
          logError(`Child exited with code ${code}. Restarting in 1s...`);
          setTimeout(() => {
            if (!shuttingDown) startChild().catch((e) => logError('Restart failed:', e));
          }, 1000);
        } else if (signal) {
          logOverseer(`Child killed by signal ${signal}`);
        } else {
          logOverseer('Child exited normally');
        }
      });
    };

    const scheduleRestart = () => {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(async () => {
        if (restarting || shuttingDown) return;
        restarting = true;

        try {
          const currentPlugins = (currentConfig.plugins as Plugin[]) ?? [];
          await runHook('onBeforeReload', currentPlugins, ctx, [...changedFiles]);

          if (child) {
            await gracefulShutdown(child, currentConfig.delay!);
            child = null;
          }
          await startChild();

          await runHook('onAfterReload', currentPlugins, ctx);
        } catch (e) {
          logError('Restart failed:', e);
        } finally {
          restarting = false;
        }
      }, currentConfig.restartDelay!);
    };

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;

      logWatcher('Shutting down...');
      if (restartTimer) clearTimeout(restartTimer);

      const currentPlugins = (currentConfig.plugins as Plugin[]) ?? [];
      await runHook('onShutdown', currentPlugins, ctx);

      if (child) {
        await gracefulShutdown(child, 5000);
        child = null;
      }
      if (watcher) {
        await watcher.close();
        watcher = null;
      }

      logWatcher('Goodbye!');
      process.exit(0);
    };

    watcher = watch(finalWatchPaths, {
      ignored: [/node_modules/, /\.git/, /dist/, /\.bun/, /\.tmp/],
      ignoreInitial: true,
      recursive: true,
      delay: currentConfig.debounce!,
      ignoreBinary: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    watcher.on('ready', () => logWatcher('Ready'));
    watcher.on('error', (err) => logError('Watcher error:', err));

    watcher.on('all', async (event, file) => {
      if (restarting || shuttingDown) return;

      const absoluteFile = isAbsolute(file) ? file : resolve(process.cwd(), file);
      const normalizedFile = absoluteFile.replace(/\\/g, '/');
      
      const absoluteConfigPath = configFilePath 
        ? (isAbsolute(configFilePath) ? configFilePath : resolve(process.cwd(), configFilePath)).replace(/\\/g, '/')
        : null;

      const isConfigChange = absoluteConfigPath && normalizedFile === absoluteConfigPath;

      if (isConfigChange) {
        logOverseer(`Config file changed: ${dim(file)}. Reloading config and restarting...`);
        try {
          const { config: newConfig } = await resolveConfig(cliFlags, rawOptions.config);
          currentConfig = newConfig;
          
          changedFiles.add(file);
          scheduleRestart();
          return;
        } catch (err) {
          logError(`Failed to reload config (keeping old config):`, err);
          return;
        }
      }

      if (!shouldReload(absoluteFile)) {
        // Debug: uncomment to see what files are being filtered
        // logWatcher(`${dim('[filtered]')} ${event}: ${file}`);
        return;
      }

      const currentPlugins = (currentConfig.plugins as Plugin[]) ?? [];
      
      const vetoed = await runHook('onFileChange', currentPlugins, ctx, event, normalizedFile);
      if (vetoed) return;

      changedFiles.add(file);
      const color = event === 'change' ? yellow : cyan;

      if (currentConfig.clearConsole) {
        clearTerminal();
      }

      logWatcher(`${color(event)}: ${dim(file)}`);
      
      scheduleRestart();
      console.log(currentPlugins,"curr")
    });

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // FIX: Use current plugins
    const currentPlugins = (currentConfig.plugins as Plugin[]) ?? [];
    await runHook('onStart', currentPlugins, ctx);

    await startChild();
  });

cli.help();
cli.version('1.0.0');
cli.parse();