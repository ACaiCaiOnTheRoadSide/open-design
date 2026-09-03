import { useState } from 'react';
import { useT } from '../i18n';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import {
  buildMonkeycodeTaskUrl,
  ensureSiteConfig,
  uploadProjectArchiveToOss,
} from '../runtime/monkeycode';
import { MonkeycodeExportDialog } from './MonkeycodeExportDialog';
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
  const [prompt, setPrompt] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function prepare() {
    if (disabled || busy) return;
    setBusy(true);
    onStarted?.();
    try {
      const archiveUrl = await uploadProjectArchiveToOss(projectId, filePath);
      setPrompt([
        t('fileViewer.exportToMonkeycodePromptDownload'),
        archiveUrl,
        '',
        t('fileViewer.exportToMonkeycodePromptDevelop'),
      ].join('\n'));
      setDialogOpen(true);
    } catch (error) {
      setToast(error instanceof Error ? error.message : t('fileViewer.exportToMonkeycodeOpenFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(editedPrompt: string) {
    // Must happen in the click stack: Safari blocks windows opened after either
    // site-config or clipboard awaits. Detach opener before cross-origin nav.
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setDialogOpen(false);
    await ensureSiteConfig();
    const copied = await copyToClipboard(editedPrompt);
    const taskUrl = buildMonkeycodeTaskUrl(editedPrompt);
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
        onClick={() => { void prepare(); }}
      >
        {variant === 'export' ? (
          <span className="share-menu-icon">
            <RemixIcon name={busy ? 'loader-4-line' : 'code-box-line'} size={15} className={busy ? 'icon-spin' : undefined} />
          </span>
        ) : null}
        <span>{busy ? t('fileViewer.exportToMonkeycodeLoading') : t('fileViewer.exportToMonkeycode')}</span>
      </button>
      <MonkeycodeExportDialog
        open={dialogOpen}
        prompt={prompt}
        onCancel={() => {
          setDialogOpen(false);
        }}
        onConfirm={(value) => { void confirm(value); }}
      />
      {toast ? <Toast message={toast} tone="error" onDismiss={() => setToast(null)} /> : null}
    </>
  );
}
