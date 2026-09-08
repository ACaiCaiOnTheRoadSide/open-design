import type { ProjectKind, ProjectMetadata, SkillSummary } from '@open-design/contracts';

const TEMPLATE_URL_PARAM = 'template_url';
const TEMPLATE_ID_PARAM = 'template_id';

export type TemplateHandoff = {
  sourceUrl: string;
  templateId: string | null;
  sanitizedUrl: string;
};

export function templateHandoffFromPageUrl(
  pageUrl: string,
): TemplateHandoff | null {
  const url = new URL(pageUrl);
  const templateUrl = url.searchParams.get(TEMPLATE_URL_PARAM);
  if (!templateUrl || !isTemplateHandoffUrl(templateUrl)) return null;

  const templateId = url.searchParams.get(TEMPLATE_ID_PARAM)?.trim() || null;
  url.searchParams.delete(TEMPLATE_URL_PARAM);
  url.searchParams.delete(TEMPLATE_ID_PARAM);
  return { sourceUrl: templateUrl, templateId, sanitizedUrl: url.toString() };
}

export function templateHandoffTrialPrompt(locale: string): string {
  return locale.startsWith('zh')
    ? '请使用已选模板实现一个可运行的示例：如有 SKILL.md，请优先按照其中的要求实现；否则参考其他可用的说明文件与资源，并尽量还原模板中的设计与交互。'
    : 'Build a working example from the selected template. If SKILL.md is available, follow it first; otherwise use the other available instructions and resources. Match the template’s design and interactions as closely as possible.';
}

export function projectInputForInstalledTemplate(skill: SkillSummary): {
  name: string;
  skillId: string;
  pendingPrompt: string;
  metadata: ProjectMetadata;
} {
  const kind = projectKindForTemplateMode(skill.mode);
  const prompt = skill.examplePrompt.trim() || `Create a new result using the ${skill.name} template.`;
  return {
    name: skill.name,
    skillId: skill.id,
    pendingPrompt: prompt,
    metadata: {
      kind,
      nameSource: 'generated',
      ...(kind === 'image' || kind === 'video'
        ? {
            promptTemplate: {
              id: skill.id,
              surface: kind,
              title: skill.name,
              prompt,
              summary: skill.description,
              ...(skill.category ? { category: skill.category } : {}),
            },
          }
        : {}),
    },
  };
}

function projectKindForTemplateMode(mode: SkillSummary['mode']): ProjectKind {
  if (mode === 'prototype' || mode === 'deck' || mode === 'image' || mode === 'video' || mode === 'audio') {
    return mode;
  }
  return 'other';
}

function isTemplateHandoffUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && /\/api\/v1\/catalog\/handoff-download\/[^/]+$/.test(url.pathname);
  } catch {
    return false;
  }
}
