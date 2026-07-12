// 模板推荐入口按钮 — 首页工具栏(HomeHero,设计系统选择器右侧)与对话
// composer 的 staged 行(ChatPane,经 ChatComposer stagedRowAccessory 槽)
// 共用的单一实现;两处只差 size 规格。内部走 @open-design/components 的
// Button(组件复用规则),accent 胶囊皮肤由同局 module 提供。
//
// 可及性:置灰原因同时写进 title 与 aria-label —— 触屏没有 hover、读屏
// 对 disabled 按钮的 title 播报不可靠,只靠 title 时这部分用户永远不知道
// "先描述需求才能推荐"。
import { Button } from '@open-design/components';
import { Icon } from './Icon';
import { useT } from '../i18n';
import styles from './TemplateRecommendTrigger.module.css';

interface Props {
  enabled: boolean;
  loading: boolean;
  onClick: () => void;
  /** compact = 对话 staged 行的 22px 紧凑规格;default = 首页工具栏。 */
  size?: 'default' | 'compact';
  /**
   * 置灰时的提示文案;缺省用 templateRec.entryHint("先描述需求")。
   * 宿主在"已有需求但暂不可点"(如结果卡片已打开)时传入别的文案,
   * 避免误导用户去重新输入。
   */
  disabledHint?: string;
  'data-testid'?: string;
}

export function TemplateRecommendTrigger({
  enabled,
  loading,
  onClick,
  size = 'default',
  disabledHint,
  'data-testid': testid,
}: Props) {
  const t = useT();
  const label = loading ? t('templateRec.loading') : t('templateRec.button');
  // 悬浮 tips 走全局 od-tooltip 层(TooltipLayer 读 data-tooltip):可用态
  // 展示使用指引("在输入框描述需求再点击"),置灰态解释原因。title 保留
  // 作为兜底(disabled 按钮不触发 JS 悬浮事件时仍有原生提示)。
  const tip =
    !enabled && !loading ? disabledHint ?? t('templateRec.entryHint') : t('templateRec.hoverTip');
  return (
    <Button
      variant="subtle"
      className={`od-tooltip ${size === 'compact' ? `${styles.trigger} ${styles.compact}` : styles.trigger}`}
      disabled={!enabled || loading}
      aria-busy={loading}
      data-tooltip={tip}
      title={tip}
      aria-label={tip}
      onClick={onClick}
      {...(testid ? { 'data-testid': testid } : {})}
    >
      <Icon name={loading ? 'spinner' : 'sparkles'} size={size === 'compact' ? 12 : 13} />
      <span>{label}</span>
    </Button>
  );
}
