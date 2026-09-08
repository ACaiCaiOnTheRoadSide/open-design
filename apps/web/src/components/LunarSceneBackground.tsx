import * as React from 'react';

import type { AppTheme } from '../types';

function useDarkTheme(theme?: AppTheme): boolean {
  const [systemDark, setSystemDark] = React.useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  );

  React.useEffect(() => {
    if (
      theme === 'light' ||
      theme === 'dark' ||
      typeof window.matchMedia !== 'function'
    ) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [theme]);

  return theme === 'dark' || (theme !== 'light' && systemDark);
}

export function LunarSceneBackground({ theme }: { theme?: AppTheme }) {
  const dark = useDarkTheme(theme);

  if (!dark) return null;

  return (
    <video
      aria-hidden="true"
      autoPlay
      className="app-lunar-video"
      loop
      muted
      playsInline
      preload="auto"
      src="/backgrounds/lunar-globe-loop.mp4"
    />
  );
}
