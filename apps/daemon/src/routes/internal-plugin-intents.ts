import type { Express, Request, Response } from 'express';
import { apiTokenAuthorizationMatches } from '../api-token-auth.js';
import { classifyRefetchablePluginSource, type PluginInstallIntentStore } from '../storage/plugin-install-intents.js';
import type { PluginIntentReconciler } from '../plugins/plugin-intent-reconciler.js';

const SAFE_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function registerInternalPluginIntentRoutes(app: Express, options: {
  apiToken: string;
  store: PluginInstallIntentStore | null;
  reconciler: PluginIntentReconciler | null;
}): void {
  const authenticate = (req: Request, res: Response): boolean => {
    const authorization = req.get('authorization');
    if (!options.apiToken || !/^Bearer[\t ]+/i.test(authorization ?? '')
      || !apiTokenAuthorizationMatches(authorization, options.apiToken)) {
      res.status(401).json({ error: { code: 'API_TOKEN_REQUIRED', message: 'valid OD_API_TOKEN Bearer token required' } });
      return false;
    }
    return true;
  };
  const available = (res: Response): boolean => {
    if (options.store && options.reconciler) return true;
    res.status(503).json({ error: { code: 'PLUGIN_INTENTS_UNAVAILABLE', message: 'plugin desired state requires OD_DAEMON_DB=postgres' } });
    return false;
  };

  app.put('/api/internal/plugin-intents/:pluginId', async (req, res) => {
    if (!authenticate(req, res) || !available(res)) return;
    const pluginId = req.params.pluginId;
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const sourceKind = classifyRefetchablePluginSource(source);
    if (!SAFE_PLUGIN_ID.test(pluginId) || !sourceKind) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'safe plugin id and refetchable github:/https:// source required' } });
    }
    try {
      const intent = await options.store!.putInstalled(pluginId, source, sourceKind);
      await options.reconciler!.reconcileNow(pluginId);
      const current = await options.store!.get(pluginId);
      if (current?.revision === intent.revision && current.lastError) {
        return res.status(422).json({ ok: false, intent: current, error: current.lastError });
      }
      return res.status(200).json({ ok: true, intent: current ?? intent });
    } catch (error) {
      return res.status(500).json({ error: { code: 'PLUGIN_INTENT_FAILED', message: String(error) } });
    }
  });

  app.delete('/api/internal/plugin-intents/:pluginId', async (req, res) => {
    if (!authenticate(req, res) || !available(res)) return;
    const pluginId = req.params.pluginId;
    if (!SAFE_PLUGIN_ID.test(pluginId)) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid plugin id' } });
    try {
      const intent = await options.store!.putAbsent(pluginId);
      await options.reconciler!.reconcileNow(pluginId);
      const current = await options.store!.get(pluginId);
      if (current?.revision === intent.revision && current.lastError) {
        return res.status(500).json({ ok: false, intent: current, error: current.lastError });
      }
      return res.status(200).json({ ok: true, intent: current ?? intent });
    } catch (error) {
      return res.status(500).json({ error: { code: 'PLUGIN_INTENT_FAILED', message: String(error) } });
    }
  });
}
