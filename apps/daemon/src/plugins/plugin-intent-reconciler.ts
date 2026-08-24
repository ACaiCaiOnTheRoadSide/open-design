import type { PluginInstallIntent, PluginInstallIntentStore } from '../storage/plugin-install-intents.js';

export interface PluginIntentMaterializer {
  isMaterialized?(pluginId: string, source: string | null): Promise<boolean>;
  install(expectedPluginId: string, source: string, signal: AbortSignal): Promise<{ pluginId: string }>;
  uninstall(pluginId: string, signal: AbortSignal): Promise<void>;
}

export interface PluginIntentReconciler {
  start(): void;
  reconcileNow(pluginId?: string): Promise<void>;
  shutdown(): Promise<void>;
}

export function createPluginIntentReconciler(options: {
  store: PluginInstallIntentStore;
  materializer: PluginIntentMaterializer;
  retryMs?: number;
  logger?: Pick<Console, 'warn' | 'info'>;
}): PluginIntentReconciler {
  const retryMs = options.retryMs ?? 60_000;
  const logger = options.logger ?? console;
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let queue = Promise.resolve();

  const runOne = async (intent: PluginInstallIntent): Promise<void> => {
    if (abort.signal.aborted) return;
    if (!await options.store.markAttempt(intent.pluginId, intent.revision)) return;
    try {
      if (intent.desiredState === 'installed') {
        if (!intent.source || (intent.sourceKind !== 'github' && intent.sourceKind !== 'https')) {
          throw new Error('intent source is not refetchable');
        }
        if (await options.materializer.isMaterialized?.(intent.pluginId, intent.source)) {
          await options.store.markSuccess(intent.pluginId, intent.revision);
          return;
        }
        const installed = await options.materializer.install(intent.pluginId, intent.source, abort.signal);
        if (installed.pluginId !== intent.pluginId) {
          throw new Error(`installed manifest id "${installed.pluginId}" does not match requested id "${intent.pluginId}"`);
        }
        const current = await options.store.get(intent.pluginId);
        if (!current || current.revision !== intent.revision || current.desiredState !== 'installed') {
          // A DELETE won while the fetch was in flight. Remove the just-written
          // cache before yielding so the stale install cannot resurrect it.
          await options.materializer.uninstall(intent.pluginId, abort.signal);
          return;
        }
      } else {
        if (options.materializer.isMaterialized
          && !await options.materializer.isMaterialized(intent.pluginId, null)) {
          await options.store.markSuccess(intent.pluginId, intent.revision);
          return;
        }
        await options.materializer.uninstall(intent.pluginId, abort.signal);
      }
      await options.store.markSuccess(intent.pluginId, intent.revision);
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      await options.store.markError(intent.pluginId, intent.revision, message).catch(() => false);
      logger.warn(`[plugins] intent reconcile ${intent.pluginId} failed: ${message}`);
    }
  };

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const reconcileNow = (pluginId?: string) => enqueue(async () => {
    if (abort.signal.aborted) return;
    const intents = pluginId
      ? [await options.store.get(pluginId)].filter((value): value is PluginInstallIntent => value !== null)
      : await options.store.list();
    for (const intent of intents) {
      if (abort.signal.aborted) break;
      await runOne(intent);
    }
  });

  const schedule = (): void => {
    void reconcileNow().catch((error) => {
      if (!abort.signal.aborted) {
        logger.warn(`[plugins] intent reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  return {
    start() {
      if (timer || abort.signal.aborted) return;
      schedule();
      timer = setInterval(schedule, retryMs);
      timer.unref();
    },
    reconcileNow,
    async shutdown() {
      abort.abort();
      if (timer) clearInterval(timer);
      timer = undefined;
      await queue;
    },
  };
}

