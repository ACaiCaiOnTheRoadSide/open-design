import { VisuallyHidden } from '@open-design/components';
import { useI18n } from '../i18n';

export function RailAccountSyncTip() {
  const { t } = useI18n();
  return (
    <div
      className="entry-rail-account-skeleton"
      role="status"
      aria-live="polite"
      data-testid="entry-rail-account-sync-tip"
    >
      <span className="entry-rail-account-skeleton__avatar" aria-hidden />
      <span className="entry-rail-account-skeleton__name" aria-hidden />
      <VisuallyHidden>{t('common.loading')}</VisuallyHidden>
    </div>
  );
}

export function RailAccountRecoveryTip() {
  const { t } = useI18n();
  return (
    <div
      className="entry-rail-account-recovery"
      role="status"
      aria-live="polite"
      data-testid="entry-rail-account-recovery-tip"
    >
      <span className="entry-rail-account-recovery__spinner" aria-hidden />
      <span className="entry-rail-account-recovery__text">
        {t('entry.cloudRecovering')}
      </span>
    </div>
  );
}
