import { useState } from 'react';
import { useT } from '../i18n';
import { confirm } from './confirm-dialog-host';
import { Toast } from './Toast';

interface Props {
  disabled?: boolean;
  onPublish: () => Promise<boolean | void> | boolean | void;
  onPublishOhMyInspire?: () => Promise<boolean | void> | boolean | void;
}

type PublishTarget = 'showcase' | 'ohmyinspire';

export function ShowcasePublishAction({ disabled = false, onPublish, onPublishOhMyInspire }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);

  const [open, setOpen] = useState(false);

  async function publish(target: PublishTarget) {
    if (disabled || busy) return;
    setOpen(false);
    const ohMyInspire = target === 'ohmyinspire';
    const accepted = await confirm({
      title: ohMyInspire ? '发布到 OhMyInspire' : t('fileViewer.publishConfirmTitle'),
      message: ohMyInspire
        ? '模板将保存到 OhMyInspire「我的模板」中，默认为草稿，之后可由你选择公开。'
        : t('fileViewer.publishNotice'),
      confirmLabel: ohMyInspire ? '发布模板' : t('fileViewer.publishConfirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!accepted) return;

    setBusy(true);
    try {
      const queued = await (ohMyInspire ? onPublishOhMyInspire?.() : onPublish());
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
      <div className="relative">
        <button
          type="button"
          data-testid="chrome-publish-button"
          className="chrome-action chrome-action-secondary chrome-action-with-label chrome-action-text-only od-tooltip"
          data-tooltip={t('fileViewer.publishTooltip')}
          data-tooltip-placement="bottom"
          disabled={disabled || busy}
          aria-busy={busy}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{t('fileViewer.publish')} ▾</span>
        </button>
        {open ? (
          <div role="menu" className="absolute right-0 top-full z-50 mt-1 min-w-44 rounded-md border border-border bg-background p-1 shadow-lg">
            <button type="button" role="menuitem" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => { void publish('showcase'); }}>
              发布到 Showcase
            </button>
            {onPublishOhMyInspire ? (
              <button type="button" role="menuitem" className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => { void publish('ohmyinspire'); }}>
                发布到 OhMyInspire
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {toast ? <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}
