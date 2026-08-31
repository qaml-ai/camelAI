import { describe, expect, it, vi } from 'vitest';
import { ChatThreadDO } from '../src/chat-thread-do';
import type { PreviewTarget } from '../../../src/types';

// Regression coverage for the DO-side preview target normalizer.
// set_preview with a DO-backed project file (`source: "project"` — the primary
// path for executed notebooks) used to be rejected by normalizePreviewTarget,
// which setPreviewTarget treats as "clear the preview": it wiped all tabs and
// the browser panel collapsed even though the tool reported success.

function createPreviewFake() {
  const fake = Object.create(ChatThreadDO.prototype) as any;
  fake.previewTabs = [];
  fake.previewActiveTabId = null;
  fake.previewTarget = null;
  fake.previewVersion = 0;
  fake.ctx = {
    storage: { kv: { get: vi.fn(() => undefined), put: vi.fn(), delete: vi.fn() } },
  };
  fake.syncAgentState = vi.fn();
  return fake;
}

describe('ChatThreadDO.setPreviewTarget', () => {
  it('keeps a DO-backed project file target (e.g. an executed notebook) as the active tab', async () => {
    const fake = createPreviewFake();
    const target: PreviewTarget = {
      kind: 'file',
      source: 'project',
      workspaceId: 'ws1',
      path: '/analysis.ipynb',
      project: 'sales-analysis',
      filename: 'analysis.ipynb',
      contentType: 'application/x-ipynb+json',
    };

    await fake.setPreviewTarget(target);

    expect(fake.previewTabs).toEqual([target]);
    expect(fake.previewActiveTabId).toBe(
      'file:ws1:project:sales-analysis:/analysis.ipynb',
    );
    expect(fake.previewTarget).toEqual(target);
  });

  it('rejects a project target without a project name (falls back to the explicit-clear contract)', async () => {
    const fake = createPreviewFake();
    await fake.setPreviewTarget({
      kind: 'file',
      source: 'workspace',
      workspaceId: 'ws1',
      path: '/notes.md',
    } satisfies PreviewTarget);
    expect(fake.previewTabs).toHaveLength(1);

    // Missing project name is still rejected (and clears, matching the
    // explicit-clear contract of setPreviewTarget(null)).
    await fake.setPreviewTarget({
      kind: 'file',
      source: 'project',
      workspaceId: 'ws1',
      path: '/analysis.ipynb',
    } as PreviewTarget);
    expect(fake.previewTabs).toEqual([]);
  });

});
