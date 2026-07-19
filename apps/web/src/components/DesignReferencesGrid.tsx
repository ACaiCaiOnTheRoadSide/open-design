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
  const chosen = selectedId;

  const handleClick = (item: DesignReferenceItem) => {
    if (disabled || chosen) return;
    onSelect?.(formatDesignReferenceSelection(item));
  };

  const resolveImageUrl = (image: string) => {
    if (image.startsWith('/') || image.startsWith('http')) return image;
    if (projectId) return projectFileUrl(projectId, image);
    return image;
  };

  return (
    <div className={styles.grid}>
      {refs.items.map((item) => (
        <button
          key={item.id}
          className={[
            styles.card,
            chosen === item.id ? styles.cardSelected : '',
            chosen && chosen !== item.id ? styles.cardDimmed : '',
          ].filter(Boolean).join(' ')}
          onClick={() => handleClick(item)}
          disabled={!!chosen || disabled}
          type="button"
        >
          <div className={styles.imageWrap}>
            <img src={resolveImageUrl(item.image)} alt={item.title} loading="lazy" />
          </div>
          <div className={styles.meta}>
            <p className={styles.title}>{item.title}</p>
            {item.description ? <p className={styles.description}>{item.description}</p> : null}
          </div>
          {chosen === item.id ? (
            <span className={styles.selectedBadge}>
              <Icon name="check" size={14} />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
