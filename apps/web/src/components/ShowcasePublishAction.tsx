import { useState } from 'react';
import { useT } from '../i18n';
import { confirm } from './confirm-dialog-host';
import { Toast } from './Toast';

interface Props {
  disabled?: boolean;
  onPublish: () => Promise<boolean | void> | boolean | void;
}

export function ShowcasePublishAction({ disabled = false, onPublish }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);

  async function publish() {
    if (disabled || busy) return;
    const accepted = await confirm({
      title: t('fileViewer.publishConfirmTitle'),
      message: t('fileViewer.publishNotice'),
      confirmLabel: t('fileViewer.publishConfirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!accepted) return;

    setBusy(true);
    try {
      const queued = await onPublish();
      setToast({
        message: queued === false
          ? t('fileViewer.publishBusy')
          : t('fileViewer.publishAgentQueued'),
        tone: queued === false ? 'error' : 'success',
      });
    } catch {
      setToast({ message: t('fileViewer.publishFailed'), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="chrome-publish-button"
        className="chrome-action chrome-action-secondary chrome-action-with-label chrome-action-text-only od-tooltip"
        data-tooltip={t('fileViewer.publishTooltip')}
        data-tooltip-placement="bottom"
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={() => { void publish(); }}
      >
        <span>{t('fileViewer.publish')}</span>
      </button>
      {toast ? <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}
