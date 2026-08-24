import { useEffect, useRef, useState } from 'react';
import type { DesignReferenceItem, DesignReferences } from '../artifacts/design-references';
import { formatDesignReferenceSelection } from '../artifacts/design-references';
import { projectFileUrl } from '../providers/registry';
import { Icon } from './Icon';
import { useT } from '../i18n';
import styles from './DesignReferencesGrid.module.css';

interface Props {
  refs: DesignReferences;
  projectId?: string | null;
  onSelect?: (text: string) => void;
  disabled?: boolean;
  selectedId?: string | null;
}

const DEFAULT_PAGE_SIZE = 3;

// In SaaS mode reference files reach the daemon through sandbox sync, so the
// block often streams into the chat before its images are fetchable. A plain
// <img> that 404s once stays broken forever (same src never reloads), so retry
// with a cache-busting query param on a backoff schedule until the file lands.
const RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 12000];

function RefImage({ src, alt }: { src: string; alt: string }) {
  const [attempt, setAttempt] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setAttempt(0);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [src]);

  const handleError = () => {
    if (attempt >= RETRY_DELAYS_MS.length || timerRef.current !== null) return;
    timerRef.current = window.setTimeout(
      () => {
        timerRef.current = null;
        setAttempt((a) => a + 1);
      },
      RETRY_DELAYS_MS[attempt],
    );
  };

  const url =
    attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}odRetry=${attempt}`;
  return <img src={url} alt={alt} loading="lazy" onError={handleError} />;
}

export function DesignReferencesGrid({ refs, projectId, onSelect, disabled, selectedId }: Props) {
  const t = useT();
  const committed = selectedId;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submissionRef = useRef(false);

  const pageSize = refs.pageSize ?? DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(refs.items.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const paginated = totalPages > 1;
  const pageItems = paginated
    ? refs.items.slice(safePage * pageSize, (safePage + 1) * pageSize)
    : refs.items;
  const refsKey = `${pageSize}:${refs.items.map((item) => `${item.id}\x00${item.image}`).join('\x01')}`;

  useEffect(() => {
    setPage(0);
    setPendingId(null);
    submissionRef.current = false;
    setSubmitting(false);
  }, [refsKey]);

  const handleClick = (item: DesignReferenceItem) => {
    if (disabled || committed || submissionRef.current) return;
    setPendingId(item.id === pendingId ? null : item.id);
  };

  const submit = (text: string) => {
    if (!onSelect || disabled || committed || submissionRef.current) return;
    submissionRef.current = true;
    setSubmitting(true);
    onSelect(text);
  };

  const handleConfirm = () => {
    const item = refs.items.find((i) => i.id === pendingId);
    if (!item) return;
    submit(formatDesignReferenceSelection(item));
  };

  const handleReject = () => {
    submit('[design reference selected — none — none selected]');
  };

  const handleNextPage = () => {
    setPendingId(null);
    setPage((p) => Math.min(p + 1, totalPages - 1));
  };

  const handlePrevPage = () => {
    setPendingId(null);
    setPage((p) => Math.max(p - 1, 0));
  };

  const resolveImageUrl = (image: string) => {
    if (image.startsWith('/') || image.startsWith('http')) return image;
    if (projectId) return projectFileUrl(projectId, image);
    return image;
  };

  const activeId = committed ?? pendingId;

  return (
    <div className={styles.container}>
      <div className={styles.grid}>
        {pageItems.map((item) => (
          <button
            key={item.id}
            className={[
              styles.card,
              activeId === item.id ? styles.cardSelected : '',
              activeId && activeId !== item.id ? styles.cardDimmed : '',
            ].filter(Boolean).join(' ')}
            onClick={() => handleClick(item)}
            disabled={!!committed || disabled || submitting}
            type="button"
          >
            <div className={styles.imageWrap}>
              <RefImage src={resolveImageUrl(item.image)} alt={item.title} />
            </div>
            <div className={styles.meta}>
              <p className={styles.title}>{item.title}</p>
              {item.description ? <p className={styles.description}>{item.description}</p> : null}
            </div>
            {activeId === item.id ? (
              <span className={styles.selectedBadge}>
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {!committed && !disabled && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.confirmBtn}
            disabled={!pendingId || submitting}
            onClick={handleConfirm}
          >
            {t('designReferences.confirm')}
          </button>
          {paginated && (
            <>
              <button
                type="button"
                className={styles.pageBtn}
                disabled={safePage === 0 || submitting}
                onClick={handlePrevPage}
              >
                {t('designReferences.previous')}
              </button>
              <span className={styles.pageIndicator}>{safePage + 1} / {totalPages}</span>
              <button
                type="button"
                className={styles.pageBtn}
                disabled={safePage >= totalPages - 1 || submitting}
                onClick={handleNextPage}
              >
                {t('designReferences.next')}
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.rejectBtn}
            disabled={submitting}
            onClick={handleReject}
          >
            {t('designReferences.reject')}
          </button>
        </div>
      )}
    </div>
  );
}
