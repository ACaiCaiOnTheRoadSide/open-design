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

export function DesignReferencesGrid({ refs, projectId, onSelect, disabled, selectedId }: Props) {
  const committed = selectedId;
  const [pendingId, setPendingId] = useState<string | null>(null);

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

  const resolveImageUrl = (image: string) => {
    if (image.startsWith('/') || image.startsWith('http')) return image;
    if (projectId) return projectFileUrl(projectId, image);
    return image;
  };

  const activeId = committed ?? pendingId;

  return (
    <div className={styles.container}>
      <div className={styles.grid}>
        {refs.items.map((item) => (
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
