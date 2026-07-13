import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@open-design/components';
import { modalOverlay, modalContent } from '../motion';

// 通用的居中确认弹窗,替代原生 window.confirm——后者由浏览器 chrome 绘制,
// 与产品主题割裂。复用全局 .modal / .row / .hint 样式(见 mention-home.css)与
// PasteTextDialog 等模态一致。所有文案由调用方传入(已本地化),组件本身不碰 i18n。
interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 破坏性操作:确认按钮渲染为红色。 */
  danger?: boolean;
  /** 操作进行中:禁用按钮、屏蔽背景点击关闭。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  // 危险按钮:Button 原语无 danger 变体,内联覆盖颜色是最稳的(跨 CSS Module
  // 的类名级联顺序不保证能盖过 primary)。hover 差异对确认框可接受。
  const dangerStyle = danger
    ? { background: 'var(--danger, #c0392b)', borderColor: 'var(--danger, #c0392b)', color: '#fff' }
    : undefined;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="modal-backdrop"
          onClick={busy ? undefined : onCancel}
          variants={modalOverlay}
          initial="hidden"
          animate="visible"
          exit="exit"
          role="presentation"
        >
          <motion.div
            className="modal"
            style={{ maxWidth: 420 }}
            onClick={(event) => event.stopPropagation()}
            variants={modalContent}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="dialog"
            aria-modal="true"
          >
            {title ? <h2>{title}</h2> : null}
            <p className="hint">{message}</p>
            <div className="row">
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </Button>
              <Button
                variant={danger ? 'default' : 'primary'}
                style={dangerStyle}
                onClick={onConfirm}
                disabled={busy}
                autoFocus
              >
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
