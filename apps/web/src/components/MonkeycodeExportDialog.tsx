import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Textarea } from '@open-design/components';
import { useT } from '../i18n';
import { modalOverlay, modalContent } from '../motion';
import { MONKEYCODE_TASK_CONTENT_MAX } from '../runtime/monkeycode';

// "导入到 MonkeyCode 开发"的确认弹窗:展示即将带往 MonkeyCode 的开发提示词,
// 用户可在跳转前直接编辑。确认后调用方负责复制剪贴板(兜底)并携带编辑后的
// 提示词跳转。复用全局 .modal / .row / .hint 样式,与 PasteTextDialog 一致。
interface Props {
  open: boolean;
  /** 初始提示词;每次打开时重置编辑框内容。 */
  prompt: string;
  onConfirm: (prompt: string) => void;
  onCancel: () => void;
}

export function MonkeycodeExportDialog({ open, prompt, onConfirm, onCancel }: Props) {
  const t = useT();
  const [value, setValue] = useState(prompt);

  // 打开时以最新 prompt 重置;关闭期间保留内容,避免退场动画中闪成空白。
  useEffect(() => {
    if (open) setValue(prompt);
  }, [open, prompt]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="modal-backdrop"
          onClick={onCancel}
          variants={modalOverlay}
          initial="hidden"
          animate="visible"
          exit="exit"
          role="presentation"
        >
          <motion.div
            className="modal"
            style={{ maxWidth: 520 }}
            onClick={(event) => event.stopPropagation()}
            variants={modalContent}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="dialog"
            aria-modal="true"
          >
            <h2>{t('fileViewer.exportToMonkeycodeEditTitle')}</h2>
            <p className="hint">{t('fileViewer.exportToMonkeycodeEditHint')}</p>
            <Textarea
              rows={8}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              maxLength={MONKEYCODE_TASK_CONTENT_MAX}
              data-testid="monkeycode-prompt-editor"
            />
            <div className="row">
              <Button variant="ghost" onClick={onCancel}>
                {t('fileViewer.exportToMonkeycodeCancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => onConfirm(value)}
                disabled={!value.trim()}
              >
                {t('fileViewer.exportToMonkeycodeGo')}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
