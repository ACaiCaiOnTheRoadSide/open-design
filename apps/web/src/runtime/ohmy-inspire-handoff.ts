import type { Locale } from '../i18n/types';

const TEMPLATE_URL_PARAM = 'template_url';

type TemplateHandoff = {
  prompt: string;
  sanitizedUrl: string;
};

export function templateHandoffFromPageUrl(
  pageUrl: string,
  locale: Locale,
): TemplateHandoff | null {
  const url = new URL(pageUrl);
  const templateUrl = url.searchParams.get(TEMPLATE_URL_PARAM);
  if (!templateUrl || !isHttpUrl(templateUrl)) return null;

  const prompt = locale.startsWith('zh')
    ? `请下载并解压以下 OhMyInspire 模板，先阅读其中的 SKILL.md，然后以该模板为基础进行开发。我会继续补充具体需求。\n\n模板下载地址：${templateUrl}`
    : `Download and extract the following OhMyInspire template. Read its SKILL.md first, then develop from the template. I will add my specific requirements.\n\nTemplate download URL: ${templateUrl}`;
  url.searchParams.delete(TEMPLATE_URL_PARAM);
  return { prompt, sanitizedUrl: url.toString() };
}

export function consumeOhMyInspireTemplateHandoff(locale: Locale) {
  if (typeof window === 'undefined') return null;
  const handoff = templateHandoffFromPageUrl(window.location.href, locale);
  if (!handoff) return null;
  window.history.replaceState(window.history.state, '', handoff.sanitizedUrl);
  return handoff.prompt;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
