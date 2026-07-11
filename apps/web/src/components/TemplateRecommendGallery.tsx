// 首页「为你推荐」分组 — 模板推荐结果渲染在官方模板画廊的位置,复用
// PluginCard 的 gallery 瓦片(带 example.html 实时预览),替代原先挂在
// composer 下方的纯文字三选一卡片:模板本质是视觉选择,"看图挑"比
// "读理由挑"直觉;每张瓦片下方保留一行推荐理由。入口在 HomeHero 的
// composer 工具栏(设计系统选择器右侧)。
import { useEffect, useRef } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { Icon } from './Icon';
import { useT } from '../i18n';
import type { TemplateRecommendation } from '../state/templateRecommend';
import { PluginCard } from './plugins-home/PluginCard';
import styles from './TemplateRecommendGallery.module.css';

export interface RecommendGalleryItem {
  rec: TemplateRecommendation;
  /** 画廊里对应的插件记录;推荐条目没有孪生插件时为 null(降级为文字卡)。 */
  record: InstalledPluginRecord | null;
}

interface Props {
  items: RecommendGalleryItem[];
  degraded: boolean;
  busy: boolean;
  pendingApplyId: string | null;
  onUse: (rec: TemplateRecommendation) => void;
  onOpenDetails: (record: InstalledPluginRecord) => void;
  onRefresh: () => void;
  onDismiss: () => void;
}

export function TemplateRecommendGallery({
  items,
  degraded,
  busy,
  pendingApplyId,
  onUse,
  onOpenDetails,
  onRefresh,
  onDismiss,
}: Props) {
  const t = useT();
  const rootRef = useRef<HTMLElement | null>(null);

  // 挂载时把自己滚进视野:入口按钮在 composer 工具栏,结果在下方画廊,
  // 不滚动的话用户会以为点了没反应。父层用 key={recRound} 重挂,每轮
  // 推荐(含"换一批")都会重新对准。
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (items.length === 0) return null;
  return (
    <section
      ref={rootRef}
      className={styles.root}
      data-testid="template-recommend-gallery"
      aria-label={t('templateRec.title')}
    >
      <div className={styles.header}>
        <span className={styles.title}>
          <Icon name="sparkles" size={14} />
          {t('templateRec.title')}
        </span>
        {degraded ? <span className={styles.degraded}>{t('templateRec.degraded')}</span> : null}
        <span className={styles.actions}>
          <Button
            variant="subtle"
            disabled={busy}
            onClick={onRefresh}
            data-testid="template-recommend-refresh"
          >
            {busy ? t('templateRec.loading') : t('templateRec.next')}
          </Button>
          <Button
            variant="ghost"
            onClick={onDismiss}
            data-testid="template-recommend-dismiss"
          >
            {t('templateRec.dismiss')}
          </Button>
        </span>
      </div>
      <div className={`plugins-home__grid plugins-home__grid--gallery ${styles.grid}`} role="list">
        {items.map(({ rec, record }) =>
          record ? (
            <div key={rec.id} className={styles.item}>
              <PluginCard
                record={record}
                isActive={false}
                isPending={pendingApplyId === record.id}
                pendingAny={pendingApplyId != null}
                isDuplicatePending={false}
                pendingDuplicateAny={false}
                isFeatured={false}
                isSaved={false}
                onSave={() => {}}
                onUse={() => onUse(rec)}
                onOpenDetails={onOpenDetails}
                layout="gallery"
              />
              <div className={styles.reason} title={rec.reason}>
                {rec.reason}
              </div>
            </div>
          ) : (
            // 没有画廊孪生记录的推荐(个别 design-template 无插件预览):
            // 退化为文字卡,仍可直接使用。
            <div key={rec.id} className={styles.item} role="listitem">
              <div className={styles.fallbackCard}>
                <span className={styles.fallbackName}>{rec.name_zh || rec.name}</span>
                <Button variant="subtle" onClick={() => onUse(rec)}>
                  {t('templateRec.use')}
                </Button>
              </div>
              <div className={styles.reason} title={rec.reason}>
                {rec.reason}
              </div>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
