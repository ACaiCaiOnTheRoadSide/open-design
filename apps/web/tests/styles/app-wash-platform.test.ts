import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appWashCss = readFileSync(
  new URL('../../src/styles/app-wash.css', import.meta.url),
  'utf8',
);
const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
);
const lunarSceneSource = readFileSync(
  new URL('../../src/components/LunarSceneBackground.tsx', import.meta.url),
  'utf8',
);
const appSource = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');

describe('desktop app wash platform contract', () => {
  it('uses the design-prompt lunar globe only for explicit or system dark mode', () => {
    expect(existsSync(new URL('../../public/backgrounds/lunar-surface.jpg', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../public/backgrounds/lunar-globe-fallback.jpg', import.meta.url))).toBe(true);
    expect(appSource).toContain("import { LunarSceneBackground } from './components/LunarSceneBackground'");
    expect(appSource).toContain('<LunarSceneBackground theme={config.theme} />');
    expect(lunarSceneSource).toContain("image.src = '/backgrounds/lunar-surface.jpg'");
    expect(lunarSceneSource).toContain("className=\"app-lunar-atmosphere\"");
    expect(lunarSceneSource).toContain('portrait ? -0.2 : -0.52');
    expect(lunarSceneSource).toContain('Math.min(0.98, aspect * 0.78)');
    expect(appWashCss).toContain("url('/backgrounds/lunar-globe-fallback.jpg')");
    expect(appWashCss).toMatch(/\[data-theme='dark'\]\s*{\s*--app-wash: var\(--dark-lunar-wash\)/);
    expect(appWashCss).toMatch(/html:not\(\[data-theme\]\)\s*{\s*--app-wash: var\(--dark-lunar-wash\)/);
    expect(homeHeroCss).toMatch(/\[data-theme='dark'\] body:has\(> \.home-view__pearl-fluid\)\s*{\s*--app-wash: var\(--dark-lunar-wash\)/);
    expect(homeHeroCss).toMatch(/\[data-theme='dark'\] \.home-view__pearl-fluid[\s\S]*?display: none;/);
  });

  it('uses a neutral token mix only for Windows desktop hosts', () => {
    expect(appWashCss).toMatch(
      /html:has\(\.workspace-shell--desktop\[data-host-platform='win32'\]\)\s*{\s*--app-wash:\s*color-mix\(in srgb, var\(--bg-panel\) 50%, var\(--bg-subtle\)\);\s*}/,
    );
    expect(appWashCss).toContain('radial-gradient(');
  });

  it('limits window-vibrancy material rules to macOS desktop hosts', () => {
    const macDesktopSelector =
      ":has(.workspace-shell--desktop[data-host-platform='darwin'])";
    const vibrancySelectors = appWashCss
      .match(
        /html(?:\.is-window-blurred)?:has\(\.workspace-shell--desktop[^)]*\)(?: body(?:::before)?)?/g,
      )
      ?.filter((selector) => !selector.includes("data-host-platform='win32'"));

    expect(vibrancySelectors).not.toBeNull();
    expect(vibrancySelectors).not.toHaveLength(0);
    expect(vibrancySelectors?.every((selector) => selector.includes(macDesktopSelector))).toBe(true);
  });
});
