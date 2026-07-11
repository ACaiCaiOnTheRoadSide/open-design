// 模板推荐卡片(baizhi fork)。
//
// 对话中展示候选的名称/推荐理由/实时预览(design-template 走共享的
// /api/skills/:id/example 路由),提供「使用此模板 / 换一个 / 不使用」三个
// 动作。候选队列在前端翻页——接口一次返回 top 3~5,"换一个"先翻本地候选,
// 翻尽由宿主带 excludeIds 重调。
//
// 入口按钮不在本文件:首页在 HomeHero 工具栏(设计系统选择器右侧),对话中
// 在 composer 的 staged-context 行(同样在设计系统选择器右侧);首页的结果
// 展示也已改走 TemplateRecommendGallery(官方模板画廊「为你推荐」分组)。
import { useMemo, useState } from 'react';
import { Button } from '@open-design/components';
// 只用 useT 不用 useI18n:宿主组件的部分测试 vi.mock 了 i18n 模块且只提供
// useT,locale 从 appLocale()(<html lang>)拿,避免打破那些 mock。
import { useT } from '../i18n';
import { appLocale, type TemplateRecommendation } from '../state/templateRecommend';
import styles from './TemplateRecommendCard.module.css';

interface Props {
  recommendations: TemplateRecommendation[];
  degraded: boolean;
  busy?: boolean;
  // displayName 是按当前 locale 解析后的展示名,宿主直接用于提示文案,
  // 无需自行引入 i18n(部分宿主测试 mock 了 i18n 模块的子集)。
  onUse: (rec: TemplateRecommendation, displayName: string) => void;
  // 本地候选翻尽时宿主重调接口(带 excludeIds)拉下一批。
  onExhausted?: () => void;
  onDismiss: () => void;
}

export function TemplateRecommendCard({
  recommendations,
  degraded,
  busy = false,
  onUse,
  onExhausted,
  onDismiss,
}: Props) {
  const t = useT();
  const locale = appLocale();
  const [index, setIndex] = useState(0);
  const current = recommendations[index] ?? null;

  const displayName = useMemo(() => {
    if (!current) return '';
    const zh = current.name_zh?.trim();
    if (zh && locale.startsWith('zh')) return zh;
    return current.name || current.id;
  }, [current, locale]);

  if (!current) return null;

  const previewSrc =
    current.kind === 'design-template'
      ? `/api/skills/${encodeURIComponent(current.id)}/example`
      : null;

  const next = () => {
    if (index + 1 < recommendations.length) {
      setIndex(index + 1);
      return;
    }
    onExhausted?.();
  };

  return (
    <section className={styles.card} data-testid="template-recommend-card">
      <header className={styles.head}>
        <span className={styles.title}>{t('templateRec.title')}</span>
        <span className={styles.counter}>
          {index + 1}/{recommendations.length}
        </span>
      </header>
      {previewSrc ? (
        <div className={styles.previewShell}>
          <iframe
            key={current.id}
            className={styles.preview}
            src={previewSrc}
            title={displayName}
            sandbox="allow-scripts allow-same-origin"
            loading="lazy"
          />
        </div>
      ) : null}
      <div className={styles.body}>
        <div className={styles.name}>{displayName}</div>
        <p className={styles.reason}>{current.reason}</p>
        {degraded ? <p className={styles.degraded}>{t('templateRec.degraded')}</p> : null}
      </div>
      <footer className={styles.actions}>
        <Button variant="primary" onClick={() => onUse(current, displayName)} disabled={busy}>
          {t('templateRec.use')}
        </Button>
        <Button variant="ghost" onClick={next} disabled={busy}>
          {t('templateRec.next')}
        </Button>
        <Button variant="ghost" onClick={onDismiss} disabled={busy}>
          {t('templateRec.dismiss')}
        </Button>
      </footer>
    </section>
  );
}
