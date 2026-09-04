import { useState } from 'react';
import { useT } from '../i18n';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import {
  buildMonkeycodeTaskUrl,
  ensureSiteConfig,
} from '../runtime/monkeycode';
import { archiveRootFromFilePath } from '../runtime/exports';
import { RemixIcon } from './RemixIcon';
import { Toast } from './Toast';

interface Props {
  projectId: string;
  filePath: string;
  onStarted?: () => void;
  variant?: 'export' | 'header';
  disabled?: boolean;
}

/** Isolated export-menu action so FileViewer only needs a one-row insertion. */
export function MonkeycodeExportAction({
  projectId,
  filePath,
  onStarted,
  variant = 'export',
  disabled = false,
}: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function openMonkeycode() {
    if (disabled || busy) return;
    // Must happen in the click stack: Safari blocks windows opened after either
    // site-config or clipboard awaits. Detach opener before cross-origin nav.
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setBusy(true);
    onStarted?.();

    const root = archiveRootFromFilePath(filePath);
    const archivePath = `/api/projects/${encodeURIComponent(projectId)}/archive${
      root ? `?root=${encodeURIComponent(root)}` : ''
    }`;
    const archiveUrl = new URL(archivePath, window.location.origin).toString();
    const prompt = [
      t('fileViewer.exportToMonkeycodePromptDownload'),
      archiveUrl,
      t('fileViewer.exportToMonkeycodePromptDevelop'),
    ].join('\n');

    try {
      await ensureSiteConfig();
      const copied = await copyToClipboard(prompt);
      const taskUrl = buildMonkeycodeTaskUrl(prompt);
      if (!taskUrl) {
        popup?.close();
        setToast(copied
          ? t('fileViewer.exportToMonkeycodePopupBlocked')
          : t('fileViewer.exportToMonkeycodeCopyFailed'));
        return;
      }
      if (!popup) {
        setToast(copied
          ? t('fileViewer.exportToMonkeycodePopupBlocked')
          : t('fileViewer.exportToMonkeycodeCopyFailed'));
        return;
      }
      popup.location.replace(taskUrl);
    } catch (error) {
      popup?.close();
      setToast(error instanceof Error ? error.message : t('fileViewer.exportToMonkeycodeOpenFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={variant === 'header'
          ? 'chrome-action chrome-action-secondary chrome-action-with-label chrome-action-text-only od-tooltip'
          : 'share-menu-item'}
        role={variant === 'export' ? 'menuitem' : undefined}
        data-testid={variant === 'header' ? 'chrome-monkeycode-button' : 'monkeycode-export-action'}
        data-tooltip={variant === 'header' ? t('fileViewer.exportToMonkeycode') : undefined}
        data-tooltip-placement={variant === 'header' ? 'bottom' : undefined}
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={() => { void openMonkeycode(); }}
      >
        {variant === 'export' ? (
          <span className="share-menu-icon">
            <RemixIcon name={busy ? 'loader-4-line' : 'code-box-line'} size={15} className={busy ? 'icon-spin' : undefined} />
          </span>
        ) : null}
        <span>{busy ? t('fileViewer.exportZip') : t('fileViewer.exportToMonkeycode')}</span>
      </button>
      {toast ? <Toast message={toast} tone="error" onDismiss={() => setToast(null)} /> : null}
    </>
  );
}
