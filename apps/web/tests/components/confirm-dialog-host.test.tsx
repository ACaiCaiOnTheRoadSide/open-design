// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost, confirm } from '../../src/components/confirm-dialog-host';

const options = (message: string) => ({
  message,
  confirmLabel: 'Yes',
  cancelLabel: 'No',
});

describe('ConfirmDialogHost', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves concurrent requests in FIFO order without losing promises', async () => {
    render(<ConfirmDialogHost />);
    const first = confirm(options('first'));
    const second = confirm(options('second'));

    expect(await screen.findByText('first')).toBeTruthy();
    fireEvent.click(screen.getByText('Yes'));
    await expect(first).resolves.toBe(true);
    expect(await screen.findByText('second')).toBeTruthy();
    fireEvent.click(screen.getByText('No'));
    await expect(second).resolves.toBe(false);
  });

  it('resolves active and queued requests false when the host unmounts', async () => {
    const view = render(<ConfirmDialogHost />);
    const first = confirm(options('first'));
    const second = confirm(options('second'));
    await screen.findByText('first');
    view.unmount();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it('uses native fallback only when no host is available', async () => {
    const native = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await waitFor(async () => expect(await confirm(options('fallback'))).toBe(true));
    expect(native).toHaveBeenCalledWith('fallback');
  });
});
