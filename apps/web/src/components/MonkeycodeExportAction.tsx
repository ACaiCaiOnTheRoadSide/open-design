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
  variant?: 'export' | 'handoff';
  onDialogOpenChange?: (open: boolean) => void;
}

/** Isolated export-menu action so FileViewer only needs a one-row insertion. */
export function MonkeycodeExportAction({
  projectId,
  filePath,
  onStarted,
  variant = 'export',
  onDialogOpenChange,
}: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function prepare() {
    if (busy) return;
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
      onDialogOpenChange?.(true);
    } catch {
      setToast(t('fileViewer.exportToMonkeycodeOpenFailed'));
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
    onDialogOpenChange?.(false);
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
        className={variant === 'handoff'
          ? 'handoff-menu-item handoff-target-card handoff-cli-card'
          : 'share-menu-item'}
        role={variant === 'export' ? 'menuitem' : undefined}
        data-testid="monkeycode-handoff-action"
        disabled={busy}
        aria-busy={busy}
        onClick={() => { void prepare(); }}
      >
        <span className={variant === 'handoff' ? undefined : 'share-menu-icon'}>
          <RemixIcon name={busy ? 'loader-4-line' : 'code-box-line'} size={15} className={busy ? 'icon-spin' : undefined} />
        </span>
        <span className={variant === 'handoff' ? 'handoff-target-copy' : undefined}>
          <span>{busy ? t('fileViewer.exportToMonkeycodeLoading') : t('fileViewer.exportToMonkeycode')}</span>
          {variant === 'handoff' ? <span className="handoff-target-meta">MonkeyCode</span> : null}
        </span>
      </button>
      <MonkeycodeExportDialog
        open={dialogOpen}
        prompt={prompt}
        onCancel={() => {
          setDialogOpen(false);
          onDialogOpenChange?.(false);
        }}
        onConfirm={(value) => { void confirm(value); }}
      />
      {toast ? <Toast message={toast} tone="error" onDismiss={() => setToast(null)} /> : null}
    </>
  );
}
