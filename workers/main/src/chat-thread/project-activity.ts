import type { ThreadProjectActivity } from '../../../../src/lib/thread-project-activity';
import type { SyncKvStorage } from './pi-turn-journal';

const THREAD_PROJECT_ACTIVITY_KEY = 'threadProjectActivity:v1';
const THREAD_PROJECT_ACTIVITY_LIMIT = 32;

export interface ChatThreadProjectActivityDeps {
  kv(): SyncKvStorage;
}

export function normalizeThreadProjectActivity(
  value: unknown,
): ThreadProjectActivity[] {
  if (!Array.isArray(value)) return [];

  const normalizedByProjectId = new Map<
    string,
    { activity: ThreadProjectActivity; firstSeenOrder: number }
  >();
  for (const [index, row] of value.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const projectId =
      typeof record.projectId === 'string' ? record.projectId.trim() : '';
    const activityType = record.activityType;
    const lastUsedAt = record.lastUsedAt;
    if (
      !projectId ||
      (activityType !== 'created' && activityType !== 'deployed') ||
      typeof lastUsedAt !== 'number' ||
      !Number.isFinite(lastUsedAt) ||
      lastUsedAt <= 0
    ) {
      continue;
    }
    const existing = normalizedByProjectId.get(projectId);
    if (existing && existing.activity.lastUsedAt >= lastUsedAt) continue;
    normalizedByProjectId.set(projectId, {
      activity: { projectId, activityType, lastUsedAt },
      firstSeenOrder: existing?.firstSeenOrder ?? index,
    });
  }

  return [...normalizedByProjectId.values()]
    .sort((left, right) => {
      if (left.activity.lastUsedAt !== right.activity.lastUsedAt) {
        return right.activity.lastUsedAt - left.activity.lastUsedAt;
      }
      return left.firstSeenOrder - right.firstSeenOrder;
    })
    .slice(0, THREAD_PROJECT_ACTIVITY_LIMIT)
    .map(({ activity }) => activity);
}

export class ChatThreadProjectActivity {
  constructor(private readonly deps: ChatThreadProjectActivityDeps) {}

  recordProjectActivity(activity: ThreadProjectActivity): void {
    const normalizedActivity = normalizeThreadProjectActivity([activity])[0];
    if (!normalizedActivity) return;

    const existing = this.listProjectActivity().filter(
      (row) => row.projectId !== normalizedActivity.projectId,
    );
    this.deps.kv().put(
      THREAD_PROJECT_ACTIVITY_KEY,
      normalizeThreadProjectActivity([normalizedActivity, ...existing]),
    );
  }

  listProjectActivity(): ThreadProjectActivity[] {
    return normalizeThreadProjectActivity(
      this.deps.kv().get<unknown>(THREAD_PROJECT_ACTIVITY_KEY),
    );
  }
}
