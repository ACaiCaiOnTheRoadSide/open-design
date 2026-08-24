import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { normalizeAccentColor, DEFAULT_ACCENT_COLOR } from '../state/appearance';
import type { AppConfig, AppTheme } from '../types';
import { AccentColorPicker, ThemeModeSelector } from './AppearanceControls';
import { Icon } from './Icon';

interface Props {
  config: Pick<AppConfig, 'theme' | 'accentColor'>;
  onThemeChange: (theme: AppTheme) => void;
  onAccentColorChange: (color: string) => void;
  /** Light-only products keep the useful accent picker reachable without advertising unsupported modes. */
  showThemeModes?: boolean;
}

export function ThemeQuickMenu({
  config,
  onThemeChange,
  onAccentColorChange,
  showThemeModes = true,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    popoverRef.current?.querySelector<HTMLElement>('[role="radio"], input')?.focus();
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="theme-quick-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`theme-quick-menu__trigger od-tooltip${open ? ' is-active' : ''}`}
        onClick={() => setOpen((current) => !current)}
        data-tooltip={t('settings.appearance')}
        data-tooltip-placement="bottom"
        aria-label={t('settings.appearance')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="theme-quick-menu-popover"
        data-testid="theme-quick-menu-trigger"
      >
        <Icon name="palette" size={16} />
      </button>
      {open ? (
        <div
          id="theme-quick-menu-popover"
          ref={popoverRef}
          className="theme-quick-menu__popover"
          role="dialog"
          aria-modal="false"
          aria-label={t('settings.appearance')}
          data-testid="theme-quick-menu"
        >
          {showThemeModes ? (
            <ThemeModeSelector
              value={config.theme ?? 'system'}
              onChange={onThemeChange}
            />
          ) : null}
          <AccentColorPicker
            value={normalizeAccentColor(config.accentColor) ?? DEFAULT_ACCENT_COLOR}
            onChange={onAccentColorChange}
          />
        </div>
      ) : null}
    </div>
  );
}
