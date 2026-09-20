import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { confirm } from './confirm-dialog-host';
import { RemixIcon } from './RemixIcon';
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
  const [toast, setToast] = useState<{
    message: string;
    details?: string;
    tone: 'success' | 'error' | 'loading';
  } | null>(null);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

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
    setToast({
      message: ohMyInspire ? '正在发布到 OhMyInspire…' : t('fileViewer.publishAgentQueued'),
      tone: 'loading',
    });
    try {
      const queued = await (ohMyInspire ? onPublishOhMyInspire?.() : onPublish());
      setToast({
        message: queued === false
          ? t('fileViewer.publishBusy')
          : ohMyInspire
            ? '已发布到 OhMyInspire「我的模板」'
            : t('fileViewer.publishAgentQueued'),
        tone: queued === false ? 'error' : 'success',
      });
    } catch (error) {
      setToast({
        message: ohMyInspire ? '发布到 OhMyInspire 失败' : t('fileViewer.publishFailed'),
        ...(error instanceof Error ? { details: error.message } : {}),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div ref={rootRef} className="showcase-publish">
        <button
          type="button"
          data-testid="chrome-publish-button"
          className="chrome-action chrome-action-secondary chrome-action-with-label chrome-action-text-only showcase-publish__trigger od-tooltip"
          data-tooltip={t('fileViewer.publishTooltip')}
          data-tooltip-placement="bottom"
          disabled={disabled || busy}
          aria-busy={busy}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{t('fileViewer.publish')}</span>
          <RemixIcon name="arrow-down-s-line" size={14} className="showcase-publish__chevron" />
        </button>
        {open ? (
          <div role="menu" aria-label={t('fileViewer.publish')} className="showcase-publish__menu">
            <button type="button" role="menuitem" className="showcase-publish__item" onClick={() => { void publish('showcase'); }}>
              <span className="showcase-publish__icon"><RemixIcon name="upload-cloud-2-line" size={16} /></span>
              <span className="showcase-publish__copy">
                <span className="showcase-publish__title">发布到 Showcase</span>
                <span className="showcase-publish__description">公开展示到案例墙</span>
              </span>
            </button>
            {onPublishOhMyInspire ? (
              <button type="button" role="menuitem" className="showcase-publish__item" onClick={() => { void publish('ohmyinspire'); }}>
                <span className="showcase-publish__icon"><RemixIcon name="sparkling-line" size={16} /></span>
                <span className="showcase-publish__copy">
                  <span className="showcase-publish__title">发布到 OhMyInspire</span>
                  <span className="showcase-publish__description">保存到我的模板</span>
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {toast ? (
        <Toast
          message={toast.message}
          details={toast.details}
          tone={toast.tone}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          {...(toast.tone === 'loading' ? { ttlMs: 0 } : {})}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </>
  );
}
