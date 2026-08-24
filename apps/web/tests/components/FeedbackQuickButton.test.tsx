// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackQuickButton } from '../../src/components/FeedbackQuickButton';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FeedbackQuickButton', () => {
  it('health-gates the entry, caps images at three, and submits multipart', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ code: 'ok' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((file) => `blob:${(file as File).name}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const view = render(<FeedbackQuickButton />);
    const entry = await screen.findByTestId('feedback-quick-entry');
    fireEvent.click(entry);

    fireEvent.change(screen.getByPlaceholderText('Brief summary of the issue'), {
      target: { value: 'Broken export' },
    });
    fireEvent.change(screen.getByPlaceholderText('Describe the issue: steps to reproduce, expected and actual behavior…'), {
      target: { value: 'Steps to reproduce' },
    });
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [1, 2, 3, 4].map((n) => new File(['x'], `${n}.png`, { type: 'image/png' }));
    fireEvent.change(input, { target: { files } });
    expect(view.container.querySelectorAll('img')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/feedback');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).getAll('screenshots')).toHaveLength(3);
  });
});
