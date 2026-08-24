import { useRef, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import {
  ACCENT_SWATCHES,
  DEFAULT_ACCENT_COLOR,
  normalizeAccentColor,
} from '../state/appearance';
import type { AppTheme } from '../types';
import { Icon } from './Icon';

const THEME_OPTIONS: ReadonlyArray<{
  value: AppTheme;
  icon: 'sun-moon' | 'sun' | 'moon';
  labelKey: 'settings.themeSystem' | 'settings.themeLight' | 'settings.themeDark';
}> = [
  { value: 'system', icon: 'sun-moon', labelKey: 'settings.themeSystem' },
  { value: 'light', icon: 'sun', labelKey: 'settings.themeLight' },
  { value: 'dark', icon: 'moon', labelKey: 'settings.themeDark' },
];

export function ThemeModeSelector({
  value,
  onChange,
}: {
  value: AppTheme;
  onChange: (theme: AppTheme) => void;
}) {
  const t = useT();
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    let next = index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = THEME_OPTIONS.length - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (index + 1) % THEME_OPTIONS.length;
    } else {
      next = (index - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    }
    const option = THEME_OPTIONS[next]!;
    onChange(option.value);
    buttonsRef.current[next]?.focus();
  };

  return (
    <div className="appearance-theme-options" role="radiogroup" aria-label={t('settings.appearance')}>
      {THEME_OPTIONS.map((option, index) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            ref={(node) => { buttonsRef.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={`appearance-theme-option${active ? ' is-active' : ''}`}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <Icon name={option.icon} size={13} />
            <span>{t(option.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AccentColorPicker({
  value,
  onChange,
  className = '',
}: {
  value?: string;
  onChange: (color: string) => void;
  className?: string;
}) {
  const t = useT();
  const active = normalizeAccentColor(value) ?? DEFAULT_ACCENT_COLOR;
  return (
    <div
      className={`appearance-accent-options${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label={t('settings.accentColor')}
    >
      {ACCENT_SWATCHES.map((color) => {
        const normalized = color.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={active === normalized}
            className={`settings-accent-swatch appearance-accent-swatch${active === normalized ? ' is-active' : ''}`}
            data-active={active === normalized ? 'true' : 'false'}
            style={{ backgroundColor: color }}
            aria-label={color === DEFAULT_ACCENT_COLOR ? t('settings.accentColorDefault') : color}
            onClick={() => onChange(color)}
          />
        );
      })}
      <label className="settings-accent-custom appearance-accent-custom" title={t('settings.accentColorCustom')}>
        <input
          type="color"
          value={active}
          aria-label={t('settings.accentColorCustom')}
          onChange={(event) => onChange(event.target.value)}
        />
        <Icon name="palette" size={16} />
      </label>
    </div>
  );
}
