import { describe, expect, it } from 'vitest';
import {
  buildImageAgentExport,
  buildPdfAgentExport,
  buildPptxAgentExport,
} from '../../src/components/export-agent-delegation';

describe('agent export delegation', () => {
  it('injects the PPTX skill and keeps editable/screenshot outputs distinct', () => {
    const editable = buildPptxAgentExport({
      fileName: 'decks/launch.html',
      title: '发布计划',
      editable: true,
    });
    const screenshot = buildPptxAgentExport({
      fileName: 'decks/launch.html',
      title: '发布计划',
      editable: false,
    });

    expect(editable.skillIds).toEqual(['html-to-pptx']);
    expect(editable.outputName).toBe('发布计划-可编辑版.pptx');
    expect(screenshot.outputName).toBe('发布计划-截图版.pptx');
    expect(editable.prompt).toContain('scripts/setup-env.sh');
    expect(editable.prompt).toContain('--editable');
  });

  it('uses format-distinct safe full-page image names', () => {
    const image = buildImageAgentExport({
      fileName: 'pages/home.html',
      title: '../unsafe/name',
      format: 'jpeg',
      deck: false,
    });

    expect(image.skillIds).toEqual(['html-to-image']);
    expect(image.outputName).toBe('-unsafe-name-full-page.jpg');
    expect(image.outputName).not.toContain('/');
    expect(image.prompt).toContain('whole scrollable page');
    expect(image.prompt).not.toContain('with --deck');
  });

  it('forces deck rendering when the viewer identifies a slide deck', () => {
    const image = buildImageAgentExport({
      fileName: 'decks/launch.html',
      title: 'Launch',
      format: 'png',
      deck: true,
    });

    expect(image.prompt).toContain('invoke render-image.mjs with --deck');
    expect(image.prompt).toContain('every slide is captured and stitched');
  });

  it('delegates PDF through sandbox Chromium with selectable text and deck pagination', () => {
    const pdf = buildPdfAgentExport({ fileName: 'deck.html', title: 'Quarterly', deck: true });

    expect(pdf.skillIds).toEqual(['html-to-pdf']);
    expect(pdf.outputName).toBe('Quarterly.pdf');
    expect(pdf.prompt).toContain('render-pdf.mjs');
    expect(pdf.prompt).toContain('pass --deck');
    expect(pdf.prompt).toContain('text-preserving PDF page');
    expect(pdf.prompt).not.toContain('html-to-image skill');
    expect(pdf.prompt).toContain('do not use Electron');
  });
});
