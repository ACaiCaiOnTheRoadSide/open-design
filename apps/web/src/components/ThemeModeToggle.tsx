import { useT } from '../i18n';
import type { AppTheme } from '../types';
import { Icon } from './Icon';

interface Props {
  theme?: AppTheme;
  onChange: (theme: AppTheme) => void;
}

export function ThemeModeToggle({ theme = 'system', onChange }: Props) {
  const t = useT();
  const systemIsDark = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && systemIsDark);
  const nextTheme: AppTheme = isDark ? 'light' : 'dark';
  const label = t(isDark ? 'settings.themeLight' : 'settings.themeDark');

  return (
    <button
      type="button"
      className="theme-mode-toggle od-tooltip"
      onClick={() => onChange(nextTheme)}
      data-tooltip={label}
      data-tooltip-placement="bottom"
      aria-label={label}
      aria-pressed={isDark}
      data-testid="theme-mode-toggle"
    >
      <Icon name={isDark ? 'sun' : 'moon'} size={17} />
    </button>
  );
}
