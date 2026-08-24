// 模板推荐 API 客户端(baizhi fork)。
//
// 端点在 SaaS backend(`POST /api/v1/templates/recommend`,GatewayAuth 会话
// 鉴权),不在 daemon:推荐用的 LLM 凭证唯一可信源是 backend PG 的 byok 全局
// 默认模型。部署态 od-web 与 backend 同源(frontend nginx `/api/v1/` 直转
// backend),浏览器 fetch 自带会话;本地 tools-dev 开发没有 backend,首次失败
// 后记为 unavailable,入口自行隐藏。
export interface TemplateRecommendation {
  id: string;
  kind: 'design-template' | 'plugin' | 'design-system';
  plugin_group?: string;
  name: string;
  name_zh?: string;
  reason: string;
  confidence: number;
}

export interface TemplateRecommendResponse {
  recommendations: TemplateRecommendation[];
  design_systems?: TemplateRecommendation[];
  degraded: boolean;
  index_version: string;
}

export interface RecommendInput {
  prompt: string;
  surface?: string;
  locale?: string;
  excludeIds?: string[];
  topN?: number;
}

export function preferredTemplateRecommendationPrompt(draft: string, lastSent: string): string {
  return draft.trim() || lastSent.trim();
}

export function designTemplateRecommendations(
  response: TemplateRecommendResponse,
): TemplateRecommendation[] {
  return response.recommendations.filter((item) => item.kind === 'design-template');
}

let serviceUnavailable = false;

// 推荐服务是否已被探测为不可达(本地开发/未部署 backend)。
export function templateRecommendUnavailable(): boolean {
  return serviceUnavailable;
}

// 应用 locale:i18n provider 会把它写到 <html lang>(index.tsx:166)。
// 从 DOM 读而不依赖 i18n 模块本身,调用方(ChatPane/推荐卡片)就不必为拿
// locale 引入 useI18n——部分组件测试用 vi.mock 只替换了 i18n 模块的 useT,
// 多引 useI18n 会打破那些 mock。
export function appLocale(): string {
  if (typeof document === 'undefined') return '';
  return document.documentElement.getAttribute('lang') ?? '';
}

export async function recommendTemplates(
  input: RecommendInput,
): Promise<TemplateRecommendResponse | null> {
  const locale = input.locale ?? appLocale();
  try {
    const resp = await fetch('/api/v1/templates/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: input.prompt,
        ...(input.surface ? { surface: input.surface } : {}),
        ...(locale ? { locale } : {}),
        ...(input.excludeIds && input.excludeIds.length > 0
          ? { exclude_ids: input.excludeIds }
          : {}),
        ...(input.topN ? { top_n: input.topN } : {}),
      }),
    });
    if (resp.status === 404 || resp.status === 502 || resp.status === 501) {
      // 路由不存在 = 无 backend 部署;记住,入口隐藏,不再打扰。
      serviceUnavailable = true;
      return null;
    }
    if (!resp.ok) return null;
    const json = (await resp.json()) as
      | TemplateRecommendResponse
      | { data?: TemplateRecommendResponse };
    // backend httpctx.OK 包了一层 { data },兼容裸响应两种形状。
    const payload = (json as { data?: TemplateRecommendResponse }).data ?? (json as TemplateRecommendResponse);
    if (!payload || !Array.isArray(payload.recommendations)) return null;
    return payload;
  } catch {
    serviceUnavailable = true;
    return null;
  }
}
