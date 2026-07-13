// 问题反馈入口:视口右上角 quick-entry-cluster(见 shell.css)里、主题快捷菜单
// (ThemeQuickMenu)左侧的气泡按钮。与 ThemeQuickMenu 同理由拥有独立类名 ——
// SaaS 白标构建(embed.css)隐藏了 entry topbar 与 settings 齿轮,反馈入口必须
// 不被那批选择器命中。
// 弹窗收集 标题+描述+截图(选择/粘贴,≤3 张、单张 ≤5MB),multipart 提交到
// backend `POST /api/v1/feedback`(GatewayAuth 会话鉴权,同源直连)。
// 宿主门控:backend 只在 SaaS 部署存在,本地 dev(next rewrites 把 /api 全转
// daemon)与上游/桌面形态没有该路由——挂载时探活 /api/v1/health,失败则整个
// 入口不渲染,与 templateRecommendEnabled 的宿主开关先例语义一致。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button, Input, Textarea } from '@open-design/components';
import { useT } from '../i18n';
import { modalOverlay, modalContent } from '../motion';
import { Icon } from './Icon';
import { Toast } from './Toast';
import styles from './FeedbackQuickButton.module.css';

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

interface PendingAttachment {
  file: File;
  // object URL,兼作列表 key 与删除标识(每次 createObjectURL 返回值全局唯一)。
  previewUrl: string;
}

interface ToastState {
  message: string;
  tone: 'success' | 'error';
}

// backend 探活结果模块级缓存:整个页面生命周期只探一次。
let backendProbe: Promise<boolean> | null = null;

function probeFeedbackBackend(): Promise<boolean> {
  if (!backendProbe) {
    try {
      backendProbe = fetch('/api/v1/health', { method: 'GET' })
        .then(
          (resp) =>
            resp.ok &&
            (resp.headers.get('content-type') ?? '').includes('application/json'),
        )
        .catch(() => false);
    } catch {
      // 测试/无 fetch 环境:视为无 backend,入口不渲染。
      backendProbe = Promise.resolve(false);
    }
  }
  return backendProbe;
}

export function FeedbackQuickButton() {
  const t = useT();
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // state 镜像,供事件处理器读取最新附件列表(副作用都在处理器里做,
  // setState updater 保持纯函数 —— StrictMode 会双调 updater)。
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;

  useEffect(() => {
    let alive = true;
    void probeFeedbackBackend().then((available) => {
      if (alive) setBackendAvailable(available);
    });
    return () => {
      alive = false;
    };
  }, []);

  const resetForm = useCallback(() => {
    setTitle('');
    setContent('');
    for (const attachment of attachmentsRef.current) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    setAttachments([]);
  }, []);

  // 关闭(Esc/遮罩/取消)保留草稿:用户可能写了很长的复现步骤,误触一次
  // 不应清空;只有提交成功才 resetForm。
  const closeDialog = useCallback(() => {
    if (submitting) return;
    setOpen(false);
  }, [submitting]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeDialog]);

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const existing = attachmentsRef.current.length;
      const accepted: PendingAttachment[] = [];
      let rejected = false;
      for (const file of files) {
        if (existing + accepted.length >= MAX_ATTACHMENTS) {
          rejected = true;
          break;
        }
        if (!file.type.startsWith('image/') || file.size > MAX_ATTACHMENT_BYTES) {
          rejected = true;
          continue;
        }
        accepted.push({ file, previewUrl: URL.createObjectURL(file) });
      }
      if (rejected) setToast({ message: t('feedback.attachInvalid'), tone: 'error' });
      if (accepted.length) {
        setAttachments((current) => [...current, ...accepted]);
      }
    },
    [t],
  );

  const onPickFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(event.target.files ?? []));
      // 允许重复选择同一文件。
      event.target.value = '';
    },
    [addFiles],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (!files.length) return;
      event.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  const removeAttachment = useCallback((previewUrl: string) => {
    URL.revokeObjectURL(previewUrl);
    setAttachments((current) =>
      current.filter((attachment) => attachment.previewUrl !== previewUrl),
    );
  }, []);

  const canSubmit = title.trim().length > 0 && content.trim().length > 0 && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('title', title.trim());
      form.append('content', content.trim());
      for (const attachment of attachments) {
        form.append('screenshots', attachment.file, attachment.file.name || 'screenshot.png');
      }
      const resp = await fetch('/api/v1/feedback', { method: 'POST', body: form });
      // 只看 resp.ok 不够:部署链网关对过期会话可能 302→登录页(HTTP 200),
      // fetch 会跟随重定向。校验 JSON content-type + 信封 code 才算真成功,
      // 否则会向用户报"已提交"并丢掉表单内容。
      const contentType = resp.headers.get('content-type') ?? '';
      if (!resp.ok || !contentType.includes('application/json')) {
        throw new Error(`feedback submit failed: ${resp.status}`);
      }
      const payload = (await resp.json()) as { code?: unknown };
      if (payload.code !== 'ok') {
        throw new Error(`feedback submit rejected: ${String(payload.code)}`);
      }
      setOpen(false);
      resetForm();
      setToast({ message: t('feedback.success'), tone: 'success' });
    } catch {
      setToast({ message: t('feedback.error'), tone: 'error' });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, title, content, attachments, resetForm, t]);

  if (!backendAvailable) return null;

  return (
    <>
      <div className="feedback-quick-entry">
        <button
          type="button"
          className="feedback-quick-entry__trigger od-tooltip"
          onClick={() => setOpen(true)}
          title={t('feedback.entryLabel')}
          data-tooltip={t('feedback.entryLabel')}
          data-tooltip-placement="bottom"
          aria-label={t('feedback.entryLabel')}
          aria-haspopup="dialog"
          data-testid="feedback-quick-entry"
        >
          <Icon name="comment" size={16} />
        </button>
      </div>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="modal-backdrop"
            onClick={closeDialog}
            variants={modalOverlay}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <motion.div
              className={`modal ${styles.dialog}`}
              role="dialog"
              aria-modal="true"
              aria-label={t('feedback.dialogTitle')}
              onClick={(e) => e.stopPropagation()}
              onPaste={onPaste}
              variants={modalContent}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <h2>{t('feedback.dialogTitle')}</h2>
              <p className="hint">{t('feedback.dialogHint')}</p>
              <label>
                {t('feedback.titleLabel')}
                <Input
                  type="text"
                  value={title}
                  placeholder={t('feedback.titlePlaceholder')}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                />
              </label>
              <label>
                {t('feedback.contentLabel')}
                <Textarea
                  rows={6}
                  value={content}
                  placeholder={t('feedback.contentPlaceholder')}
                  maxLength={5000}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>
              <div className={styles.attachments}>
                <span className={styles.attachmentsLabel}>{t('feedback.attachLabel')}</span>
                <div className={styles.thumbs}>
                  {attachments.map((attachment) => (
                    <div key={attachment.previewUrl} className={styles.thumb}>
                      <img src={attachment.previewUrl} alt={attachment.file.name} />
                      <button
                        type="button"
                        className={styles.thumbRemove}
                        onClick={() => removeAttachment(attachment.previewUrl)}
                        aria-label={t('feedback.remove')}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  ))}
                  {attachments.length < MAX_ATTACHMENTS ? (
                    <button
                      type="button"
                      className={styles.thumbAdd}
                      onClick={() => fileInputRef.current?.click()}
                      aria-label={t('feedback.attachAdd')}
                    >
                      <Icon name="image" size={16} />
                      <span>{t('feedback.attachAdd')}</span>
                    </button>
                  ) : null}
                </div>
                <p className="hint">{t('feedback.attachHint')}</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={onPickFiles}
                />
              </div>
              <div className="row">
                <Button onClick={closeDialog} disabled={submitting}>
                  {t('feedback.cancel')}
                </Button>
                <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
                  {submitting ? <Icon name="spinner" size={14} /> : null}
                  {t('feedback.submit')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {toast ? (
          <Toast
            message={toast.message}
            tone={toast.tone}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            onDismiss={() => setToast(null)}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}
