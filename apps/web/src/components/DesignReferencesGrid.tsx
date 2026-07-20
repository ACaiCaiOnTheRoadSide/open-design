import { useState } from 'react';
import type { DesignReferenceItem, DesignReferences } from '../artifacts/design-references';
import { formatDesignReferenceSelection } from '../artifacts/design-references';
import { projectFileUrl } from '../providers/registry';
import { Icon } from './Icon';
import styles from './DesignReferencesGrid.module.css';

interface Props {
  refs: DesignReferences;
  projectId?: string | null;
  onSelect?: (text: string) => void;
  disabled?: boolean;
  selectedId?: string | null;
}

const DEFAULT_PAGE_SIZE = 3;

export function DesignReferencesGrid({ refs, projectId, onSelect, disabled, selectedId }: Props) {
  const committed = selectedId;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const pageSize = refs.pageSize ?? DEFAULT_PAGE_SIZE;
  const totalPages = Math.ceil(refs.items.length / pageSize);
  const paginated = totalPages > 1;
  const pageItems = paginated
    ? refs.items.slice(page * pageSize, (page + 1) * pageSize)
    : refs.items;

  const handleClick = (item: DesignReferenceItem) => {
    if (disabled || committed) return;
    setPendingId(item.id === pendingId ? null : item.id);
  };

  const handleConfirm = () => {
    const item = refs.items.find((i) => i.id === pendingId);
    if (!item) return;
    onSelect?.(formatDesignReferenceSelection(item));
  };

  const handleReject = () => {
    onSelect?.('[design reference selected — none — 都不喜欢]');
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
            disabled={!!committed || disabled}
            type="button"
          >
            <div className={styles.imageWrap}>
              <img src={resolveImageUrl(item.image)} alt={item.title} loading="lazy" />
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
            disabled={!pendingId}
            onClick={handleConfirm}
          >
            确认选择
          </button>
          {paginated && (
            <>
              <button
                type="button"
                className={styles.pageBtn}
                disabled={page === 0}
                onClick={handlePrevPage}
              >
                上一轮
              </button>
              <span className={styles.pageIndicator}>{page + 1} / {totalPages}</span>
              <button
                type="button"
                className={styles.pageBtn}
                disabled={page >= totalPages - 1}
                onClick={handleNextPage}
              >
                下一轮
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.rejectBtn}
            onClick={handleReject}
          >
            都不喜欢
          </button>
        </div>
      )}
    </div>
  );
}
