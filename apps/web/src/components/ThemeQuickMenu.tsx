import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import {
  ACCENT_SWATCHES,
  DEFAULT_ACCENT_COLOR,
  normalizeAccentColor,
} from '../state/appearance';
import type { AppConfig, AppTheme } from '../types';
import { Icon } from './Icon';

const THEME_OPTIONS: Array<{
  value: AppTheme;
  icon: 'sun-moon' | 'sun' | 'moon';
  labelKey: 'settings.themeSystem' | 'settings.themeLight' | 'settings.themeDark';
}> = [
  { value: 'system', icon: 'sun-moon', labelKey: 'settings.themeSystem' },
  { value: 'light', icon: 'sun', labelKey: 'settings.themeLight' },
  { value: 'dark', icon: 'moon', labelKey: 'settings.themeDark' },
];

interface Props {
  config: AppConfig;
  onThemeChange: (theme: AppTheme) => void;
  onAccentColorChange: (color: string) => void;
}

/**
 * Standalone appearance-only control pinned to the viewport's top-right
 * corner. The SaaS white-label build (embed.css in the deploy repo) hides
 * the entry topbar and every `.settings-icon-btn` gear, so theme switching
 * needs its own surface with its own class names. Scope is deliberately
 * appearance-only: theme mode (system/light/dark) + accent color. Both
 * apply instantly through the same App-level handlers the settings gear
 * uses, and persist to localStorage.
 */
export function ThemeQuickMenu({ config, onThemeChange, onAccentColorChange }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const activeTheme = config.theme ?? 'system';
  const activeAccent = normalizeAccentColor(config.accentColor) ?? DEFAULT_ACCENT_COLOR;

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="theme-quick-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`theme-quick-menu__trigger od-tooltip${open ? ' is-active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title={t('settings.appearance')}
        data-tooltip={t('settings.appearance')}
        data-tooltip-placement="bottom"
        aria-label={t('settings.appearance')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="theme-quick-menu-trigger"
      >
        <Icon name="palette" size={16} />
      </button>
      {open ? (
        <div
          className="theme-quick-menu__popover"
          role="menu"
          aria-label={t('settings.appearance')}
          data-testid="theme-quick-menu"
        >
          <div className="entry-settings-menu__theme-row">
            {THEME_OPTIONS.map((option) => {
              const active = activeTheme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  className={`entry-settings-menu__theme${active ? ' is-active' : ''}`}
                  onClick={() => onThemeChange(option.value)}
                >
                  <Icon name={option.icon} size={13} />
                  <span>{t(option.labelKey)}</span>
                </button>
              );
            })}
          </div>
          <div
            className="pet-swatches theme-quick-menu__swatches"
            role="radiogroup"
            aria-label={t('pet.fieldAccent')}
          >
            {ACCENT_SWATCHES.map((color) => {
              const active = activeAccent === color;
              return (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`pet-swatch${active ? ' active' : ''}`}
                  style={{ background: color }}
                  aria-label={
                    color === DEFAULT_ACCENT_COLOR ? t('pet.fieldAccentDefault') : color
                  }
                  onClick={() => onAccentColorChange(color)}
                />
              );
            })}
            <input
              type="color"
              aria-label={t('pet.fieldAccentCustom')}
              className="pet-swatch-picker"
              value={activeAccent}
              onChange={(event) => onAccentColorChange(event.target.value)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
