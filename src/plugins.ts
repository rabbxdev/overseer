// src/plugins.ts
import { red, dim, bold } from '@rabbx/colors'; 

export interface PluginContext {
  /** Current runtime: 'node' | 'bun' | 'deno' */
  runtime: 'node' | 'bun' | 'deno' | 'unknown';
  /** Path to the script being overseen */ 
  script: string;
  /** Arguments passed to the script */
  args: string[];
}

export interface Plugin {
  /** Unique plugin name (used in logs and error reporting) */
  name: string;

  // --- Lifecycle ---
  /** Called once when the overseer starts, before the first child spawns */
  onStart?: (ctx: PluginContext) => void | Promise<void>;
  /** Called when the overseer is shutting down */
  onShutdown?: (ctx: PluginContext) => void | Promise<void>;

  // --- File watching ---
  /**
   * Called on every file change event.
   * Return `false` to veto the reload (skip this file).
   * Return `void`/`true`/`undefined` to allow normal processing.
   */
  onFileChange?: (
    event: string,
    file: string,
    ctx: PluginContext
  ) => boolean | void | Promise<boolean | void>;

  // --- Process spawning ---
  /** Called before a new child process is spawned. Mutate `env` to inject variables. */
  onBeforeSpawn?: (
    env: Record<string, string>,
    ctx: PluginContext
  ) => void | Promise<void>;
  /** Called after a child process has been spawned successfully */
  onAfterSpawn?: (pid: number | undefined, ctx: PluginContext) => void | Promise<void>;
  /** Called when the child process exits */
  onChildExit?: (
    code: number | null,
    signal: string | null,
    ctx: PluginContext
  ) => void | Promise<void>;

  // --- Reload ---
  /** Called before a reload is triggered (after debounce) */
  onBeforeReload?: (
    changedFiles: string[],
    ctx: PluginContext
  ) => void | Promise<void>;
  /** Called after the new child process has been spawned */
  onAfterReload?: (ctx: PluginContext) => void | Promise<void>;

  // --- Errors ---
  /** Called when any hook in any plugin throws. Use for centralized error reporting. */
  onError?: (
    error: unknown,
    info: { plugin: string; hook: string },
    ctx: PluginContext
  ) => void | Promise<void>;
}

/**
 * Helper for type-safe plugin definitions with autocompletion.
 * Purely a typing aid — returns the plugin unchanged.
 */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/**
 * Execute a hook across all plugins, isolating errors so one
 * failing plugin doesn't break the chain.
 *
 * - For void hooks: runs all plugins, logs errors via onError.
 * - For boolean hooks (onFileChange): returns false if ANY plugin vetoes.
 */
export async function runHook<K extends keyof Plugin>(
  hookName: K,
  plugins: Plugin[],
  ctx: PluginContext,
  ...args: any[]
): Promise<boolean> {
  let vetoed = false;

  for (const plugin of plugins) {
    const hook = plugin[hookName] as Function | undefined;
    if (!hook) continue;

    try {
      const result = await hook(...args, ctx);
      
      if (hookName === 'onFileChange' && result === false) {
        vetoed = true;
      }
    } catch (error) {
      // Route the error through onError hooks of OTHER plugins
      await runErrorHandler(error, { plugin: plugin.name, hook: hookName as string }, plugins, ctx);
    }
  }

  return vetoed;
}

async function runErrorHandler(
  error: unknown,
  info: { plugin: string; hook: string },
  plugins: Plugin[],
  ctx: PluginContext
): Promise<void> {
  const fallbackMsg = `${red('[plugin-error]')} ${bold(info.plugin)}.${dim(info.hook)} threw: ${error instanceof Error ? error.message : String(error)}`;
  let handled = false;

  for (const plugin of plugins) {
    if (!plugin.onError || plugin.name === info.plugin) continue;
    try {
      await plugin.onError(error, info, ctx);
      handled = true;
    } catch {
      // onError itself failed — fall through to console
    }
  }

  if (!handled) {
    console.error(fallbackMsg);
  }
}