import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

// 命令式的 window.confirm 替代:调用 `await confirm({...})`,确认返回 true、
// 取消/点背景/Esc 返回 false。UI 走自研的 ConfirmDialog(居中模态),与产品
// 一致,不再是浏览器原生弹窗。单例 host 在 App 根挂一次,持有弹窗状态。
export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 破坏性操作:确认按钮红色。 */
  danger?: boolean;
}

let requestConfirm: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

/** 命令式确认弹窗。host 未挂载(SSR / 首帧前)时退回原生 confirm,不阻塞逻辑。 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (requestConfirm) return requestConfirm(opts);
  if (typeof window !== 'undefined') return Promise.resolve(window.confirm(opts.message));
  return Promise.resolve(false);
}

/** 挂在 App 根:注册 confirm() 的实现,渲染唯一的确认弹窗。 */
export function ConfirmDialogHost() {
  const [open, setOpen] = useState(false);
  // opts 在关闭(退场动画)期间保留,避免内容闪成空白;下次打开时被覆盖。
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const activeRef = useRef<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const queueRef = useRef<Array<{ opts: ConfirmOptions; resolve: (ok: boolean) => void }>>([]);

  useEffect(() => {
    requestConfirm = (next) => new Promise<boolean>((resolve) => {
      const request = { opts: next, resolve };
      if (activeRef.current) {
        queueRef.current.push(request);
        return;
      }
      activeRef.current = request;
      setOpts(next);
      setOpen(true);
    });
    return () => {
      requestConfirm = null;
      activeRef.current?.resolve(false);
      activeRef.current = null;
      for (const pending of queueRef.current.splice(0)) pending.resolve(false);
    };
  }, []);

  function close(ok: boolean) {
    const completed = activeRef.current;
    if (!completed) return;
    completed.resolve(ok);
    const next = queueRef.current.shift() ?? null;
    activeRef.current = next;
    if (next) {
      setOpts(next.opts);
      setOpen(true);
    } else {
      setOpen(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      message={opts?.message ?? ''}
      {...(opts?.title !== undefined ? { title: opts.title } : {})}
      confirmLabel={opts?.confirmLabel ?? ''}
      cancelLabel={opts?.cancelLabel ?? ''}
      danger={opts?.danger ?? false}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  );
}
