// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitOnDesignReferences } from '../../src/artifacts/design-references';
import { DesignReferencesGrid } from '../../src/components/DesignReferencesGrid';

const refs = {
  pageSize: 3,
  items: Array.from({ length: 7 }, (_, index) => ({
    id: `ref-${index + 1}`,
    title: `Reference ${index + 1}`,
    image: `refs/ref-${index + 1}.jpg`,
  })),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('design references', () => {
  it('parses fenced Pinterest-style paginated payloads', () => {
    const input = `<design-references>\n\`\`\`json\n${JSON.stringify(refs)}\n\`\`\`\n</design-references>`;
    const segments = splitOnDesignReferences(input);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: 'design-references',
      refs: { pageSize: 3, items: expect.arrayContaining([expect.objectContaining({ id: 'ref-1' })]) },
    });
  });

  it('paginates, confirms a selected direction, and can reject all', () => {
    const onSelect = vi.fn();
    const view = render(<DesignReferencesGrid refs={refs} projectId="project-1" onSelect={onSelect} />);
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(screen.queryByText('Reference 4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByText('Reference 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Reference 4/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm selection' }));
    expect(onSelect).toHaveBeenCalledWith('[design reference selected — ref-4 — Reference 4]');

    view.unmount();
    render(<DesignReferencesGrid refs={refs} projectId="project-1" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'None of these' }));
    expect(onSelect).toHaveBeenLastCalledWith('[design reference selected — none — none selected]');
  });

  it('deduplicates ids, normalizes page size, and rejects dangerous image URLs', () => {
    const payload = {
      pageSize: 99.8,
      items: [
        { id: 'same', title: 'Safe', image: 'https://images.example/safe.jpg' },
        { id: 'same', title: 'Duplicate', image: 'references/duplicate.jpg' },
        { id: 'js', title: 'Script', image: 'javascript:alert(1)' },
        { id: 'data', title: 'Data', image: 'data:image/svg+xml,<svg />' },
        { id: 'traversal', title: 'Traversal', image: '../secret.png' },
        { id: 'local', title: 'Local', image: 'references/local.png' },
      ],
    };
    const [segment] = splitOnDesignReferences(
      `<design-references>${JSON.stringify(payload)}</design-references>`,
    );
    expect(segment).toMatchObject({
      kind: 'design-references',
      refs: {
        pageSize: 20,
        items: [
          { id: 'same', image: 'https://images.example/safe.jpg' },
          { id: 'local', image: 'references/local.png' },
        ],
      },
    });
  });

  it('resets stale page, pending selection, and submit lock when refs change', () => {
    const onSelect = vi.fn();
    const view = render(<DesignReferencesGrid refs={refs} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /Reference 4/ }));
    expect(screen.getByRole('button', { name: 'Confirm selection' }).hasAttribute('disabled')).toBe(false);

    view.rerender(<DesignReferencesGrid refs={{ pageSize: 3, items: refs.items.slice(0, 2) }} onSelect={onSelect} />);
    expect(screen.getByText('Reference 1')).toBeTruthy();
    expect(screen.queryByText('Reference 4')).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm selection' }).hasAttribute('disabled')).toBe(true);
  });

  it('submits a selection at most once while the parent turn is pending', () => {
    const onSelect = vi.fn();
    render(<DesignReferencesGrid refs={{ items: [refs.items[0]!] }} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Reference 1/ }));
    const confirm = screen.getByRole('button', { name: 'Confirm selection' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('retries a 404 with bounded exponential backoff and cache busting', () => {
    vi.useFakeTimers();
    render(<DesignReferencesGrid refs={{ items: [refs.items[0]!] }} projectId="project-1" />);
    const image = screen.getByRole('img', { name: 'Reference 1' });
    expect(image.getAttribute('src')).toBe('/api/projects/project-1/raw/refs/ref-1.jpg');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      fireEvent.error(image);
      act(() => vi.runOnlyPendingTimers());
      expect(image.getAttribute('src')).toContain(`odRetry=${attempt}`);
    }
    fireEvent.error(image);
    expect(vi.getTimerCount()).toBe(0);
  });
});
