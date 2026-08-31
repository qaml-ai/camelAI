import { describe, expect, it, vi } from 'vitest';

import { ChatThreadDO } from '../src/chat-thread-do';
import { ChatThreadProjectActivity } from '../src/chat-thread/project-activity';

function createMemoryKv(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) {
    values.set('threadProjectActivity:v1', initial);
  }
  return {
    get: vi.fn(<T>(key: string) => values.get(key) as T | undefined),
    put: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
    delete: vi.fn((key: string) => values.delete(key)),
  };
}

describe('ChatThreadProjectActivity', () => {
  it('records, normalizes, and returns a fresh activity row', () => {
    const kv = createMemoryKv();
    const activity = new ChatThreadProjectActivity({ kv: () => kv });

    activity.recordProjectActivity({
      projectId: ' project_1 ',
      activityType: 'created',
      lastUsedAt: 10,
    });

    const firstRead = activity.listProjectActivity();
    expect(firstRead).toEqual([
      { projectId: 'project_1', activityType: 'created', lastUsedAt: 10 },
    ]);
    firstRead[0].projectId = 'mutated';
    expect(activity.listProjectActivity()[0].projectId).toBe('project_1');
  });

  it('updates an existing project instead of duplicating it', () => {
    const kv = createMemoryKv();
    const activity = new ChatThreadProjectActivity({ kv: () => kv });

    activity.recordProjectActivity({
      projectId: 'project_1',
      activityType: 'created',
      lastUsedAt: 10,
    });
    activity.recordProjectActivity({
      projectId: 'project_1',
      activityType: 'deployed',
      lastUsedAt: 20,
    });

    expect(activity.listProjectActivity()).toEqual([
      { projectId: 'project_1', activityType: 'deployed', lastUsedAt: 20 },
    ]);
  });

  it('sorts newest-first and caps the rollup at 32 projects', () => {
    const kv = createMemoryKv();
    const activity = new ChatThreadProjectActivity({ kv: () => kv });

    for (let index = 1; index <= 40; index += 1) {
      activity.recordProjectActivity({
        projectId: `project_${index}`,
        activityType: 'created',
        lastUsedAt: index,
      });
    }

    const rows = activity.listProjectActivity();
    expect(rows).toHaveLength(32);
    expect(rows[0].projectId).toBe('project_40');
    expect(rows.at(-1)?.projectId).toBe('project_9');
  });

  it('ignores malformed stored rows safely', () => {
    const kv = createMemoryKv([
      null,
      { projectId: '', activityType: 'created', lastUsedAt: 10 },
      { projectId: 'bad_type', activityType: 'built', lastUsedAt: 20 },
      { projectId: 'bad_time', activityType: 'deployed', lastUsedAt: Infinity },
      { projectId: 'valid', activityType: 'deployed', lastUsedAt: 30 },
    ]);
    const activity = new ChatThreadProjectActivity({ kv: () => kv });

    expect(activity.listProjectActivity()).toEqual([
      { projectId: 'valid', activityType: 'deployed', lastUsedAt: 30 },
    ]);
  });
});

describe('ChatThreadDO project activity RPCs', () => {
  it('assigns the completion time and persists through the thin RPC methods', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1234);
    const kv = createMemoryKv();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { storage: { kv } };

    await ChatThreadDO.prototype.recordProjectActivity.call(fake, {
      projectId: 'project_1',
      activityType: 'created',
    });

    await expect(
      ChatThreadDO.prototype.listProjectActivity.call(fake),
    ).resolves.toEqual([
      { projectId: 'project_1', activityType: 'created', lastUsedAt: 1234 },
    ]);
    vi.useRealTimers();
  });

  it('returns parsed messages and activity from one combined read', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const messages = [
      {
        id: 'message_1',
        thread_id: 'thread_1',
        role: 'user',
        content: 'hello',
        created_at: 10,
        forkEntryId: 'fork_1',
      },
    ];
    const projectActivity = [
      { projectId: 'project_1', activityType: 'created', lastUsedAt: 20 },
    ];
    fake.getPiCoreParsedMessages = vi.fn(async () => messages);
    fake.listProjectActivity = vi.fn(async () => projectActivity);

    await expect(
      ChatThreadDO.prototype.getGroupNewChatRecentSource.call(fake, 'thread_1'),
    ).resolves.toEqual({ messages, projectActivity });
    expect(fake.getPiCoreParsedMessages).toHaveBeenCalledWith('thread_1');
    expect(fake.listProjectActivity).toHaveBeenCalledTimes(1);
  });
});
