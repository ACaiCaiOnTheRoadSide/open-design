import type { ProjectKind, ProjectMetadata, SkillSummary } from '@open-design/contracts';

const TEMPLATE_URL_PARAM = 'template_url';
const TEMPLATE_ID_PARAM = 'template_id';

type TemplateHandoff = {
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
