import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { OrgDO } from '../src/auth';
import { CodeModeDeterministicAutomations } from '../src/code-mode-deterministic-automations';
import type { AutomationRunCursor, WorkspaceCronDO } from '../src/workspace-cron';
import { createOrg, createUser, listUserWorkspaces, type TestEnv } from './test-helpers';

interface TestEnvWithCron extends TestEnv {
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
}

describe('WorkspaceCronDO', () => {
  const testEnv = env as unknown as TestEnvWithCron;
  const testEmail = () => `cron-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const automationSource = (label = 'ok') => `import { WorkflowEntrypoint } from "cloudflare:workers";

export class AutomationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return await step.do("${label}", async () => ({ payload: event.payload }));
  }
}
`;

  afterEach(() => {
    vi.useRealTimers();
  });

  function useFixedTime(iso: string): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  async function expectRemoteRejectionMessage(
    promise: Promise<unknown>,
    expected: string,
  ): Promise<void> {
    let error: unknown;
    try {
      await promise;
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain(expected);
  }

  it('creates, lists, updates, and deletes scheduled prompts', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Cron Owner');
    const { org } = await createOrg(testEnv, 'Cron Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<OrgDO>;

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Daily digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 9 * * *',
      createdBy: userId,
      scheduledByThreadId: 'thread-origin-123',
    });

    expect(created.id).toBeTypeOf('string');
    expect(created.thread_id).toBeTypeOf('string');
    expect(created.scheduled_by_thread_id).toBe('thread-origin-123');
    expect(created.enabled).toBe(true);
    expect(created.next_run_at).toBeTypeOf('number');
    const createdThread = await orgStub.getThread(created.thread_id);
    expect(createdThread?.workspace_id).toBe(workspaceId);
    expect(createdThread?.source).toBe('scheduled');

    const listAfterCreate = await cronStub.listScheduledPrompts(workspaceId!);
    expect(listAfterCreate).toHaveLength(1);
    expect(listAfterCreate[0]?.name).toBe('Daily digest');

    const updated = await cronStub.updateScheduledPrompt({
      workspaceId: workspaceId!,
      id: created.id,
      name: 'Daily summary',
      enabled: false,
    });
    expect(updated?.name).toBe('Daily summary');
    expect(updated?.enabled).toBe(false);
    expect(updated?.next_run_at).toBeNull();

    expect(await orgStub.deleteThread(created.thread_id, userId)).toBe(true);
    const run = await cronStub.runScheduledPromptNow(workspaceId!, created.id);
    expect(run?.prompt.id).toBe(created.id);
    expect(run?.dispatch.thread_id).not.toBe(created.thread_id);
    const repairedThread = run?.dispatch.thread_id
      ? await orgStub.getThread(run.dispatch.thread_id)
      : null;
    expect(repairedThread?.source).toBe('scheduled');
    const runsAfterStart = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const scheduledRuns = runsAfterStart[`scheduled_prompt:${created.id}`] ?? [];
    expect(scheduledRuns).toHaveLength(1);
    expect(scheduledRuns[0]?.kind).toBe('scheduled_prompt');
    expect(scheduledRuns[0]?.trigger).toBe('manual');
    expect(scheduledRuns[0]?.thread_id).toBe(run?.dispatch.thread_id);

    const questionRecorded = await cronStub.recordScheduledPromptRunResult({
      workspaceId: workspaceId!,
      promptId: created.id,
      runId: scheduledRuns[0]!.id,
      status: 'question',
      message: 'Should I continue?',
    });
    expect(questionRecorded).toBe(true);
    const promptsAfterQuestion = await cronStub.listScheduledPrompts(workspaceId!);
    expect(promptsAfterQuestion[0]?.last_run_status).toBe('question');
    expect(promptsAfterQuestion[0]?.last_run_error).toBeNull();
    const runsAfterQuestion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    expect(runsAfterQuestion[`scheduled_prompt:${created.id}`]?.[0]?.status).toBe('question');
    expect(runsAfterQuestion[`scheduled_prompt:${created.id}`]?.[0]?.message).toBe('Should I continue?');
    expect(runsAfterQuestion[`scheduled_prompt:${created.id}`]?.[0]?.completed_at).toBeNull();

    const recorded = await cronStub.recordScheduledPromptRunResult({
      workspaceId: workspaceId!,
      promptId: created.id,
      runId: scheduledRuns[0]!.id,
      status: 'success',
      completedAt: Date.now(),
    });
    expect(recorded).toBe(true);
    const runsAfterCompletion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    expect(runsAfterCompletion[`scheduled_prompt:${created.id}`]?.[0]?.status).toBe('success');

    const deleted = await cronStub.deleteScheduledPrompt(workspaceId!, created.id);
    expect(deleted).toBe(true);
    const listAfterDelete = await cronStub.listScheduledPrompts(workspaceId!);
    expect(listAfterDelete).toHaveLength(0);
    const runsAfterDelete = await cronStub.listAutomationRuns(workspaceId!);
    expect(runsAfterDelete[`scheduled_prompt:${created.id}`]).toBeUndefined();
  });

  it('does not let an older scheduled prompt completion overwrite the latest run summary', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Stale Prompt Owner');
    const { org } = await createOrg(testEnv, 'Stale Prompt Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Stale digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 9 * * *',
      createdBy: userId,
    });

    await cronStub.runScheduledPromptNow(workspaceId!, created.id);
    const runsAfterFirst = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const firstRun = runsAfterFirst[`scheduled_prompt:${created.id}`]?.[0];
    expect(firstRun?.id).toBeTypeOf('string');

    await cronStub.runScheduledPromptNow(workspaceId!, created.id);
    const beforeStaleCompletion = (await cronStub.listScheduledPrompts(workspaceId!))[0];
    expect(beforeStaleCompletion).toBeDefined();

    const staleRecorded = await cronStub.recordScheduledPromptRunResult({
      workspaceId: workspaceId!,
      promptId: created.id,
      runId: firstRun!.id,
      status: 'error',
      message: 'Older run failed late',
    });
    expect(staleRecorded).toBe(true);

    const afterStaleCompletion = (await cronStub.listScheduledPrompts(workspaceId!))[0];
    expect(afterStaleCompletion?.last_run_at).toBe(beforeStaleCompletion?.last_run_at);
    expect(afterStaleCompletion?.last_run_status).toBe(
      beforeStaleCompletion?.last_run_status,
    );
    expect(afterStaleCompletion?.last_run_error).toBe(
      beforeStaleCompletion?.last_run_error,
    );

    const runsAfterStaleCompletion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const firstRunHistory = runsAfterStaleCompletion[
      `scheduled_prompt:${created.id}`
    ]?.find((run) => run.id === firstRun!.id);
    expect(firstRunHistory?.status).toBe('error');
    expect(firstRunHistory?.message).toBe('Older run failed late');
  });

  it('creates, validates, versions, and deletes deterministic automations', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Automation Owner');
    const { org } = await createOrg(testEnv, 'Automation Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const invalid = await cronStub.validateDeterministicAutomationSource('export default {};');
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join('\n')).toContain('AutomationWorkflow');

    const valid = await cronStub.validateDeterministicAutomationSource(automationSource());
    expect(valid).toEqual({ valid: true, errors: [] });

    const automationTools = new CodeModeDeterministicAutomations({
      cronStub,
      workspaceId: workspaceId!,
      userId,
    });

    await expect(
      automationTools.create({
        name: 'Missing description sync',
        source: automationSource(),
        cron_expression: '0 9 * * *',
        enabled: false,
      }),
    ).rejects.toThrow('description is required');

    await expect(
      automationTools.create({
        name: 'Blank description sync',
        description: '   ',
        source: automationSource(),
        cron_expression: '0 9 * * *',
        enabled: false,
      }),
    ).rejects.toThrow('description is required');

    const created = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Daily deterministic sync',
      description: 'Runs deterministic workflow code.',
      source: automationSource(),
      cronExpression: '0 9 * * *',
      createdBy: userId,
      enabled: false,
    });

    expect(created.id).toBeTypeOf('string');
    expect(created.description).toBe('Runs deterministic workflow code.');
    expect(created.source_version).toBe(1);
    expect(created.enabled).toBe(false);
    expect(created.next_run_at).toBeNull();

    const snapshot = await cronStub.getDeterministicAutomationSource(
      workspaceId!,
      created.id,
      1,
    );
    expect(snapshot?.source).toContain('class AutomationWorkflow');
    expect(snapshot?.created_by).toBe(userId);

    await expect(
      automationTools.update({
        workflow_id: created.id,
        description: null,
      } as Record<string, unknown>),
    ).rejects.toThrow('description must be a string');

    const updated = await cronStub.updateDeterministicAutomation({
      workspaceId: workspaceId!,
      id: created.id,
      source: automationSource('updated'),
      enabled: true,
    });
    expect(updated?.source_version).toBe(2);
    expect(updated?.enabled).toBe(true);
    expect(updated?.next_run_at).toBeTypeOf('number');

    await expectRemoteRejectionMessage(
      cronStub.updateDeterministicAutomation({
        workspaceId: workspaceId!,
        id: created.id,
        source: automationSource('stale'),
        expectedSourceVersion: 1,
      }),
      'Automation edit conflict',
    );
    const conditionallyUpdated = await cronStub.updateDeterministicAutomation({
      workspaceId: workspaceId!,
      id: created.id,
      source: automationSource('conditional'),
      expectedSourceVersion: 2,
    });
    expect(conditionallyUpdated?.source_version).toBe(3);

    const previousVersion = await cronStub.getDeterministicAutomationSource(
      workspaceId!,
      created.id,
      1,
    );
    expect(previousVersion?.source).toContain('ok');
    const currentVersion = await cronStub.getDeterministicAutomationSource(
      workspaceId!,
      created.id,
      3,
    );
    expect(currentVersion?.source).toContain('conditional');

    const listAfterCreate = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterCreate).toHaveLength(1);
    expect(listAfterCreate[0]?.name).toBe('Daily deterministic sync');

    const run = await cronStub.runDeterministicAutomationNow(workspaceId!, created.id);
    expect(run?.dispatch.status).toBe('started');
    expect(run?.dispatch.instance_id).toBeTypeOf('string');
    expect(run?.automation.last_run_status).toBe('started');
    const runsAfterStart = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const workflowRuns = runsAfterStart[`deterministic_automation:${created.id}`] ?? [];
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0]?.status).toBe('started');
    expect(workflowRuns[0]?.instance_id).toBe(run?.dispatch.instance_id);

    const staleCompletion = await cronStub.recordDeterministicAutomationRunResult({
      workspaceId: workspaceId!,
      automationId: created.id,
      instanceId: 'different-instance',
      status: 'success',
    });
    expect(staleCompletion).toBe(false);
    const listAfterStaleCompletion = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterStaleCompletion[0]?.last_run_status).toBe('started');

    const completion = await cronStub.recordDeterministicAutomationRunResult({
      workspaceId: workspaceId!,
      automationId: created.id,
      instanceId: run!.dispatch.instance_id!,
      status: 'success',
    });
    expect(completion).toBe(true);
    const listAfterCompletion = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterCompletion[0]?.last_run_status).toBe('success');
    expect(listAfterCompletion[0]?.last_run_error).toBeNull();
    const runsAfterCompletion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    expect(runsAfterCompletion[`deterministic_automation:${created.id}`]?.[0]?.status).toBe('success');
    expect(runsAfterCompletion[`deterministic_automation:${created.id}`]?.[0]?.completed_at).toBeTypeOf('number');

    const deleted = await cronStub.deleteDeterministicAutomation(workspaceId!, created.id);
    expect(deleted).toBe(true);
    const listAfterDelete = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterDelete).toHaveLength(0);
    const runsAfterDelete = await cronStub.listAutomationRuns(workspaceId!);
    expect(runsAfterDelete[`deterministic_automation:${created.id}`]).toBeUndefined();
  });

  it('records stale deterministic completions in run history without overwriting the latest run summary', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Stale Workflow Owner');
    const { org } = await createOrg(testEnv, 'Stale Workflow Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Stale workflow',
      description: 'Runs deterministic workflow code.',
      source: automationSource(),
      cronExpression: '0 9 * * *',
      createdBy: userId,
      enabled: false,
    });

    const first = await cronStub.runDeterministicAutomationNow(workspaceId!, created.id);
    expect(first?.dispatch.instance_id).toBeTypeOf('string');
    const second = await cronStub.runDeterministicAutomationNow(workspaceId!, created.id);
    expect(second?.dispatch.instance_id).toBeTypeOf('string');
    const beforeStaleCompletion = (await cronStub.listDeterministicAutomations(
      workspaceId!,
    ))[0];
    expect(beforeStaleCompletion?.last_instance_id).toBe(second?.dispatch.instance_id);
    expect(beforeStaleCompletion?.last_run_status).toBe('started');

    const staleRecorded = await cronStub.recordDeterministicAutomationRunResult({
      workspaceId: workspaceId!,
      automationId: created.id,
      instanceId: first!.dispatch.instance_id!,
      status: 'success',
    });
    expect(staleRecorded).toBe(true);

    const afterStaleCompletion = (await cronStub.listDeterministicAutomations(
      workspaceId!,
    ))[0];
    expect(afterStaleCompletion?.last_instance_id).toBe(second?.dispatch.instance_id);
    expect(afterStaleCompletion?.last_run_status).toBe('started');

    const runsAfterStaleCompletion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const firstRunHistory = runsAfterStaleCompletion[
      `deterministic_automation:${created.id}`
    ]?.find((run) => run.instance_id === first!.dispatch.instance_id);
    expect(firstRunHistory?.status).toBe('success');
    expect(firstRunHistory?.completed_at).toBeTypeOf('number');
  });

  it('rejects over-frequent scheduled prompts and deterministic automations on payg', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Payg Cron Owner');
    const { org } = await createOrg(testEnv, 'Payg Cron Org', userId, {
      billingPlan: 'payg',
    });
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    await expectRemoteRejectionMessage(
      cronStub.createScheduledPrompt({
        workspaceId: workspaceId!,
        name: 'Minute digest',
        prompt: 'Summarize workspace status.',
        cronExpression: '* * * * *',
        createdBy: userId,
      }),
      'allows automations no more frequent than every 1 day',
    );

    await expectRemoteRejectionMessage(
      cronStub.createDeterministicAutomation({
        workspaceId: workspaceId!,
        name: 'Minute workflow',
        description: 'Runs deterministic workflow code.',
        source: automationSource(),
        cronExpression: '* * * * *',
        createdBy: userId,
      }),
      'allows automations no more frequent than every 1 day',
    );
  });

  it('rejects second enabled daily automation on lower workspace-capped plans', async () => {
    for (const billingPlan of ['free', 'payg', 'starter'] as const) {
      const { userId } = await createUser(testEnv, testEmail(), 'password123', `${billingPlan} Count Owner`);
      const { org } = await createOrg(testEnv, `${billingPlan} Count Org`, userId, {
        billingPlan,
      });
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspaceId = workspaces[0]?.id;
      expect(workspaceId).toBeTypeOf('string');

      const cronStub = testEnv.WORKSPACE_CRON.get(
        testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
      ) as DurableObjectStub<WorkspaceCronDO>;

      await cronStub.createScheduledPrompt({
        workspaceId: workspaceId!,
        name: 'Daily digest',
        prompt: 'Summarize workspace status.',
        cronExpression: '0 9 * * *',
        createdBy: userId,
      });

      await expectRemoteRejectionMessage(
        cronStub.createDeterministicAutomation({
          workspaceId: workspaceId!,
          name: 'Daily workflow',
          description: 'Runs deterministic workflow code.',
          source: automationSource(),
          cronExpression: '0 10 * * *',
          createdBy: userId,
        }),
        'allows 1 automation per workspace',
      );
    }
  });

  it('allows disabled over-frequency automations without consuming enabled quota', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Paused Quota Owner');
    const { org } = await createOrg(testEnv, 'Paused Quota Org', userId, {
      billingPlan: 'payg',
    });
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const pausedPrompt = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Paused minute digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '* * * * *',
      createdBy: userId,
      enabled: false,
    });
    const pausedAutomation = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Paused minute workflow',
      description: 'Runs deterministic workflow code.',
      source: automationSource(),
      cronExpression: '* * * * *',
      createdBy: userId,
      enabled: false,
    });

    expect(pausedPrompt.enabled).toBe(false);
    expect(pausedPrompt.next_run_at).toBeNull();
    expect(pausedAutomation.enabled).toBe(false);
    expect(pausedAutomation.next_run_at).toBeNull();

    const enabledPrompt = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Daily digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 9 * * *',
      createdBy: userId,
    });

    expect(enabledPrompt.enabled).toBe(true);
    expect(enabledPrompt.next_run_at).toBeTypeOf('number');
  });

  it('allows pausing over-frequency legacy automations after downgrade', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Pause Legacy Owner');
    const { org } = await createOrg(testEnv, 'Pause Legacy Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<OrgDO>;
    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const prompt = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Legacy minute digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '* * * * *',
      createdBy: userId,
    });
    const automation = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Legacy minute workflow',
      description: 'Runs deterministic workflow code.',
      source: automationSource(),
      cronExpression: '* * * * *',
      createdBy: userId,
    });

    await orgStub.updateBillingState({
      billing_plan: 'payg',
      billing_status: 'inactive',
    });

    const pausedPrompt = await cronStub.updateScheduledPrompt({
      workspaceId: workspaceId!,
      id: prompt.id,
      enabled: false,
    });
    expect(pausedPrompt?.enabled).toBe(false);
    expect(pausedPrompt?.next_run_at).toBeNull();

    const pausedAutomation = await cronStub.updateDeterministicAutomation({
      workspaceId: workspaceId!,
      id: automation.id,
      enabled: false,
    });
    expect(pausedAutomation?.enabled).toBe(false);
    expect(pausedAutomation?.next_run_at).toBeNull();
  });

  it('blocks and disables a legacy over-frequent scheduled prompt after downgrade', async () => {
    useFixedTime('2030-01-01T00:00:00.000Z');
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Legacy Prompt Owner');
    const { org } = await createOrg(testEnv, 'Legacy Prompt Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<OrgDO>;
    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Legacy minute digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '* * * * *',
      createdBy: userId,
    });

    await orgStub.updateBillingState({
      billing_plan: 'payg',
      billing_status: 'inactive',
    });

    vi.setSystemTime(new Date(created.next_run_at!));
    await cronStub.runDueAutomationsForTest(workspaceId!);

    const runs = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'scheduled_prompt',
      automationId: created.id,
      limit: 5,
    });
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]?.status).toBe('error');
    expect(runs.runs[0]?.thread_id).toBeNull();
    expect(runs.runs[0]?.message).toContain(
      'Blocked by billing plan: your current plan allows automations no more frequent than every 1 day.',
    );

    const afterBlock = (await cronStub.listScheduledPrompts(workspaceId!))[0];
    expect(afterBlock?.enabled).toBe(false);
    expect(afterBlock?.next_run_at).toBeNull();
    expect(afterBlock?.last_run_status).toBe('error');
    expect(afterBlock?.last_run_error).toContain('Blocked by billing plan');

    vi.setSystemTime(new Date(created.next_run_at! + 60_000));
    await cronStub.runDueAutomationsForTest(workspaceId!);
    const runsAfterSecondAlarm = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'scheduled_prompt',
      automationId: created.id,
      limit: 5,
    });
    expect(runsAfterSecondAlarm.runs).toHaveLength(1);
  });

  it('blocks and disables a legacy over-frequent deterministic workflow after downgrade', async () => {
    useFixedTime('2030-01-02T00:00:00.000Z');
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Legacy Workflow Owner');
    const { org } = await createOrg(testEnv, 'Legacy Workflow Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<OrgDO>;
    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Legacy minute workflow',
      description: 'Runs deterministic workflow code.',
      source: automationSource(),
      cronExpression: '* * * * *',
      createdBy: userId,
    });

    await orgStub.updateBillingState({
      billing_plan: 'payg',
      billing_status: 'inactive',
    });

    vi.setSystemTime(new Date(created.next_run_at!));
    await cronStub.runDueAutomationsForTest(workspaceId!);

    const runs = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'deterministic_automation',
      automationId: created.id,
      limit: 5,
    });
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]?.status).toBe('error');
    expect(runs.runs[0]?.instance_id).toBeNull();
    expect(runs.runs[0]?.message).toContain(
      'Blocked by billing plan: your current plan allows automations no more frequent than every 1 day.',
    );

    const afterBlock = (await cronStub.listDeterministicAutomations(workspaceId!))[0];
    expect(afterBlock?.enabled).toBe(false);
    expect(afterBlock?.next_run_at).toBeNull();
    expect(afterBlock?.last_run_status).toBe('error');
    expect(afterBlock?.last_run_error).toContain('Blocked by billing plan');
    expect(afterBlock?.last_instance_id).toBeNull();

    vi.setSystemTime(new Date(created.next_run_at! + 60_000));
    await cronStub.runDueAutomationsForTest(workspaceId!);
    const runsAfterSecondAlarm = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'deterministic_automation',
      automationId: created.id,
      limit: 5,
    });
    expect(runsAfterSecondAlarm.runs).toHaveLength(1);
  });

  it('blocks deterministic automations beyond the downgraded workspace count cap', async () => {
    useFixedTime('2030-01-04T00:00:00.000Z');
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Count Cap Owner');
    const { org } = await createOrg(testEnv, 'Count Cap Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<OrgDO>;
    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const first = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'First workflow',
      description: 'Runs deterministic workflow code.',
      source: automationSource('first'),
      cronExpression: '0 9 * * *',
      createdBy: userId,
    });
    vi.setSystemTime(new Date(Date.now() + 1));
    const second = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Second workflow',
      description: 'Runs deterministic workflow code.',
      source: automationSource('second'),
      cronExpression: '0 9 * * *',
      createdBy: userId,
    });

    await orgStub.updateBillingState({
      billing_plan: 'payg',
      billing_status: 'inactive',
    });

    vi.setSystemTime(new Date(first.next_run_at!));
    await cronStub.runDueAutomationsForTest(workspaceId!);

    const firstRuns = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'deterministic_automation',
      automationId: first.id,
      limit: 5,
    });
    const secondRuns = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'deterministic_automation',
      automationId: second.id,
      limit: 5,
    });

    expect(firstRuns.runs).toHaveLength(1);
    expect(firstRuns.runs[0]?.instance_id).toBeTypeOf('string');
    expect(secondRuns.runs[0]?.status).toBe('error');
    expect(secondRuns.runs[0]?.instance_id).toBeNull();
    expect(secondRuns.runs[0]?.message).toContain(
      'Blocked by billing plan: your current plan allows 1 automation per workspace.',
    );
    expect(secondRuns.runs.every((run) => run.instance_id === null)).toBe(true);

    const afterBlock = (await cronStub.listDeterministicAutomations(workspaceId!))
      .find((automation) => automation.id === second.id);
    expect(afterBlock?.enabled).toBe(false);
    expect(afterBlock?.next_run_at).toBeNull();

    await cronStub.runDueAutomationsForTest(workspaceId!);
    const secondRunsAfterSecondAlarm = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'deterministic_automation',
      automationId: second.id,
      limit: 5,
    });
    expect(secondRunsAfterSecondAlarm.runs).toHaveLength(secondRuns.runs.length);
  });

  it('manual scheduled prompt runs disable noncompliant saved schedules', async () => {
    useFixedTime('2030-01-05T00:00:00.000Z');
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Manual Cadence Owner');
    const { org } = await createOrg(testEnv, 'Manual Cadence Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<OrgDO>;
    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Manual legacy digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '* * * * *',
      createdBy: userId,
    });

    await orgStub.updateBillingState({
      billing_plan: 'payg',
      billing_status: 'inactive',
    });

    vi.setSystemTime(new Date(created.next_run_at!));
    const run = await cronStub.runScheduledPromptNow(workspaceId!, created.id);

    expect(run?.dispatch.thread_id).toBeTypeOf('string');
    expect(run?.prompt.enabled).toBe(false);
    expect(run?.prompt.next_run_at).toBeNull();
    expect(run?.prompt.last_run_status).toBe('error');
    expect(run?.prompt.last_run_error).toContain(
      'Schedule disabled by billing plan:',
    );

    const runsAfterManual = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'scheduled_prompt',
      automationId: created.id,
      limit: 1,
    });
    const runId = runsAfterManual.runs[0]?.id;
    expect(runId).toBeTypeOf('string');

    await cronStub.recordScheduledPromptRunResult({
      workspaceId: workspaceId!,
      promptId: created.id,
      runId: runId!,
      status: 'success',
      completedAt: Date.now(),
    });

    const afterCompletion = (await cronStub.listScheduledPrompts(workspaceId!))
      .find((prompt) => prompt.id === created.id);
    expect(afterCompletion?.enabled).toBe(false);
    expect(afterCompletion?.next_run_at).toBeNull();
    expect(afterCompletion?.last_run_status).toBe('error');
    expect(afterCompletion?.last_run_error).toContain(
      'Schedule disabled by billing plan:',
    );

    const runsAfterCompletion = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'scheduled_prompt',
      automationId: created.id,
      limit: 1,
    });
    expect(runsAfterCompletion.runs[0]?.status).toBe('success');
  });

  it('manual deterministic runs disable noncompliant saved schedules', async () => {
    useFixedTime('2030-01-06T00:00:00.000Z');
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Manual Workflow Owner');
    const { org } = await createOrg(testEnv, 'Manual Workflow Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<OrgDO>;
    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Manual legacy workflow',
      description: 'Runs deterministic workflow code.',
      source: automationSource(),
      cronExpression: '* * * * *',
      createdBy: userId,
    });

    await orgStub.updateBillingState({
      billing_plan: 'payg',
      billing_status: 'inactive',
    });

    vi.setSystemTime(new Date(created.next_run_at!));
    const run = await cronStub.runDeterministicAutomationNow(workspaceId!, created.id);

    expect(run?.dispatch.instance_id).toBeTypeOf('string');
    expect(run?.automation.enabled).toBe(false);
    expect(run?.automation.next_run_at).toBeNull();
    expect(run?.automation.last_run_status).toBe('error');
    expect(run?.automation.last_run_error).toContain(
      'Schedule disabled by billing plan:',
    );

    await cronStub.recordDeterministicAutomationRunResult({
      workspaceId: workspaceId!,
      automationId: created.id,
      instanceId: run!.dispatch.instance_id!,
      status: 'success',
    });

    const afterCompletion = (await cronStub.listDeterministicAutomations(
      workspaceId!,
    )).find((automation) => automation.id === created.id);
    expect(afterCompletion?.enabled).toBe(false);
    expect(afterCompletion?.next_run_at).toBeNull();
    expect(afterCompletion?.last_run_status).toBe('error');
    expect(afterCompletion?.last_run_error).toContain(
      'Schedule disabled by billing plan:',
    );

    const runsAfterCompletion = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'deterministic_automation',
      automationId: created.id,
      limit: 1,
    });
    expect(runsAfterCompletion.runs[0]?.status).toBe('success');
  });

  it('keyset-paginates retained run history with the 20-row cap', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Runs Owner');
    const { org } = await createOrg(testEnv, 'Runs Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Paginated digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 9 * * *',
      createdBy: userId,
    });

    // Each manual run inserts one run-history row. Retention intentionally
    // keeps only the newest 20 rows for this pass.
    const TOTAL = 25;
    const RETAINED = 20;
    for (let i = 0; i < TOTAL; i++) {
      await cronStub.runScheduledPromptNow(workspaceId!, created.id);
    }

    const all = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'scheduled_prompt',
      automationId: created.id,
      limit: 50,
    });
    expect(all.runs).toHaveLength(RETAINED);
    expect(all.nextCursor).toBeNull();

    // Walking small pages must reproduce the canonical newest-first order with
    // no overlap and no gaps, and terminate with a null cursor.
    const paged: string[] = [];
    let cursor: AutomationRunCursor | null = null;
    let pages = 0;
    do {
      const page = await cronStub.listAutomationRunsPage(workspaceId!, {
        kind: 'scheduled_prompt',
        automationId: created.id,
        limit: 5,
        cursor,
      });
      expect(page.runs.length).toBeLessThanOrEqual(5);
      paged.push(...page.runs.map((run) => run.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);

    expect(cursor).toBeNull();
    expect(paged).toEqual(all.runs.map((run) => run.id));
    expect(new Set(paged).size).toBe(RETAINED);

    // An unrelated automation id returns an empty, terminal page.
    const empty = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'scheduled_prompt',
      automationId: 'does-not-exist',
      limit: 5,
    });
    expect(empty.runs).toHaveLength(0);
    expect(empty.nextCursor).toBeNull();
  });

  it('treats a healthy early alarm (before next_run_at) as non-destructive and does not consume the schedule', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Cron Owner');
    const { org } = await createOrg(testEnv, 'Cron Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Hourly digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 * * * *',
      createdBy: userId,
    });
    const nextRun = created.next_run_at!;

    // Wake before the prompt is due: it must not run, advance, or disable.
    useFixedTime(new Date(nextRun - 5_000).toISOString());
    await cronStub.runDueAutomationsForTest(workspaceId!);

    const after = (await cronStub.listScheduledPrompts(workspaceId!))[0];
    expect(after?.enabled).toBe(true);
    expect(after?.next_run_at).toBe(nextRun);
    expect(after?.last_run_at).toBeNull();
    expect(after?.run_count).toBe(0);
  });

  it('does not disable schedules on an early alarm when the workspace lookup fails, but still disables on the real due run', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Cron Owner');
    const { org } = await createOrg(testEnv, 'Cron Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Hourly digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 * * * *',
      createdBy: userId,
    });
    const nextRun = created.next_run_at!;
    expect(nextRun).toBeTypeOf('number');

    // Break the workspace lookup so getWorkspaceInfo throws, WITHOUT going
    // through archive()/delete (which would themselves disable the prompts via a
    // cross-DO call and mask the behavior under test). Deleting the stored info
    // row makes getInfo() return null, exactly like a transient lookup failure.
    const wsStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspaceId!));
    await runInDurableObject(wsStub, async (instance: { ctx: DurableObjectState }) => {
      instance.ctx.storage.sql.exec("DELETE FROM workspace_info WHERE key = 'data'");
    });

    // Early wake (before next_run_at): the failure must NOT disable the
    // schedule — the real run still deserves its chance.
    useFixedTime(new Date(nextRun - 5_000).toISOString());
    await cronStub.runDueAutomationsForTest(workspaceId!);
    const afterLead = (await cronStub.listScheduledPrompts(workspaceId!))[0];
    expect(afterLead?.enabled).toBe(true);
    expect(afterLead?.next_run_at).toBe(nextRun);
    expect(afterLead?.last_run_error).toBeNull();

    // Real due wake (at next_run_at): the same lookup failure is now destructive
    // — this is a genuinely due run against a gone workspace, so it disables.
    useFixedTime(new Date(nextRun).toISOString());
    await cronStub.runDueAutomationsForTest(workspaceId!);
    const afterDue = (await cronStub.listScheduledPrompts(workspaceId!))[0];
    expect(afterDue?.enabled).toBe(false);
    expect(afterDue?.next_run_at).toBeNull();
    expect(afterDue?.last_run_error).toBe('workspace_unavailable');
  });

  describe('billing-failure auto-pause', () => {
    const BILLING_ERROR =
      'Hosted model credits are used up. Buy more credits or add an API key to continue.';
    const PAUSE_PREFIX = 'Schedule paused after repeated billing failures:';

    async function setupPrompt(ownerName: string) {
      const { userId } = await createUser(testEnv, testEmail(), 'password123', ownerName);
      const { org } = await createOrg(testEnv, `${ownerName} Org`, userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspaceId = workspaces[0]?.id;
      expect(workspaceId).toBeTypeOf('string');
      const cronStub = testEnv.WORKSPACE_CRON.get(
        testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
      ) as DurableObjectStub<WorkspaceCronDO>;
      const created = await cronStub.createScheduledPrompt({
        workspaceId: workspaceId!,
        name: 'Hourly digest',
        prompt: 'Summarize workspace status.',
        cronExpression: '0 * * * *',
        createdBy: userId,
      });
      return { cronStub, workspaceId: workspaceId!, promptId: created.id };
    }

    async function latestRunId(
      cronStub: DurableObjectStub<WorkspaceCronDO>,
      workspaceId: string,
      promptId: string,
    ): Promise<string> {
      const page = await cronStub.listAutomationRunsPage(workspaceId, {
        kind: 'scheduled_prompt',
        automationId: promptId,
        limit: 1,
      });
      const runId = page.runs[0]?.id;
      expect(runId).toBeTypeOf('string');
      return runId!;
    }

    async function runAndRecord(
      cronStub: DurableObjectStub<WorkspaceCronDO>,
      workspaceId: string,
      promptId: string,
      status: 'success' | 'error' | 'question' | 'busy',
      message?: string,
    ): Promise<string> {
      await cronStub.runScheduledPromptNow(workspaceId, promptId);
      const runId = await latestRunId(cronStub, workspaceId, promptId);
      const recorded = await cronStub.recordScheduledPromptRunResult({
        workspaceId,
        promptId,
        runId,
        status,
        message,
        completedAt: status === 'question' ? null : Date.now(),
      });
      expect(recorded).toBe(true);
      return runId;
    }

    async function getPrompt(
      cronStub: DurableObjectStub<WorkspaceCronDO>,
      workspaceId: string,
      promptId: string,
    ) {
      const prompt = (await cronStub.listScheduledPrompts(workspaceId)).find(
        (candidate) => candidate.id === promptId,
      );
      expect(prompt).toBeDefined();
      return prompt!;
    }

    it('auto-pauses after three consecutive billing failures and preserves the pause against a late success', async () => {
      const base = Date.parse('2031-01-01T00:00:30.000Z');
      useFixedTime(new Date(base).toISOString());
      const { cronStub, workspaceId, promptId } = await setupPrompt('Pause Streak Owner');

      for (let attempt = 1; attempt <= 2; attempt++) {
        vi.setSystemTime(new Date(base + attempt * 60_000));
        await runAndRecord(cronStub, workspaceId, promptId, 'error', BILLING_ERROR);
        const after = await getPrompt(cronStub, workspaceId, promptId);
        expect(after.consecutive_billing_failures).toBe(attempt);
        expect(after.enabled).toBe(true);
        expect(after.auto_paused).toBe(false);
        expect(after.next_run_at).toBeTypeOf('number');
      }

      vi.setSystemTime(new Date(base + 3 * 60_000));
      const runId3 = await runAndRecord(cronStub, workspaceId, promptId, 'error', BILLING_ERROR);
      const paused = await getPrompt(cronStub, workspaceId, promptId);
      expect(paused.enabled).toBe(false);
      expect(paused.next_run_at).toBeNull();
      expect(paused.auto_paused).toBe(true);
      expect(paused.consecutive_billing_failures).toBe(3);
      expect(paused.last_run_status).toBe('error');
      expect(paused.last_run_error).toContain(PAUSE_PREFIX);
      expect(paused.last_run_error).toContain('credits are used up');

      // The paused schedule must not re-arm: a later alarm wake runs nothing.
      const runCountBefore = paused.run_count;
      vi.setSystemTime(new Date(base + 3 * 60 * 60_000));
      await cronStub.runDueAutomationsForTest(workspaceId);
      const afterAlarm = await getPrompt(cronStub, workspaceId, promptId);
      expect(afterAlarm.enabled).toBe(false);
      expect(afterAlarm.next_run_at).toBeNull();
      expect(afterAlarm.run_count).toBe(runCountBefore);

      // A late duplicate success completion for the final run must not clear
      // the pause summary or the streak.
      const lateSuccess = await cronStub.recordScheduledPromptRunResult({
        workspaceId,
        promptId,
        runId: runId3,
        status: 'success',
        completedAt: Date.now(),
      });
      expect(lateSuccess).toBe(true);
      const afterLateSuccess = await getPrompt(cronStub, workspaceId, promptId);
      expect(afterLateSuccess.enabled).toBe(false);
      expect(afterLateSuccess.auto_paused).toBe(true);
      expect(afterLateSuccess.consecutive_billing_failures).toBe(3);
      expect(afterLateSuccess.last_run_status).toBe('error');
      expect(afterLateSuccess.last_run_error).toContain(PAUSE_PREFIX);
    });

    it('does not count busy or non-billing errors toward the billing pause', async () => {
      const base = Date.parse('2031-01-02T00:00:30.000Z');
      useFixedTime(new Date(base).toISOString());
      const { cronStub, workspaceId, promptId } = await setupPrompt('Transient Owner');

      const outcomes: Array<{ status: 'error' | 'busy'; message: string }> = [
        { status: 'error', message: 'TypeError: fetch failed' },
        { status: 'busy', message: 'Thread is busy with another run' },
        { status: 'error', message: 'Internal error: DO restarted' },
        { status: 'busy', message: 'Thread is busy with another run' },
      ];
      for (const [index, outcome] of outcomes.entries()) {
        vi.setSystemTime(new Date(base + (index + 1) * 60_000));
        await runAndRecord(cronStub, workspaceId, promptId, outcome.status, outcome.message);
        const after = await getPrompt(cronStub, workspaceId, promptId);
        expect(after.consecutive_billing_failures).toBe(0);
        expect(after.enabled).toBe(true);
        expect(after.auto_paused).toBe(false);
      }
    });

    it('success and question outcomes reset the billing-failure streak', async () => {
      const base = Date.parse('2031-01-03T00:00:30.000Z');
      useFixedTime(new Date(base).toISOString());
      const { cronStub, workspaceId, promptId } = await setupPrompt('Reset Owner');

      vi.setSystemTime(new Date(base + 60_000));
      await runAndRecord(cronStub, workspaceId, promptId, 'error', BILLING_ERROR);
      vi.setSystemTime(new Date(base + 2 * 60_000));
      await runAndRecord(cronStub, workspaceId, promptId, 'error', BILLING_ERROR);
      expect(
        (await getPrompt(cronStub, workspaceId, promptId)).consecutive_billing_failures,
      ).toBe(2);

      vi.setSystemTime(new Date(base + 3 * 60_000));
      await runAndRecord(cronStub, workspaceId, promptId, 'success');
      expect(
        (await getPrompt(cronStub, workspaceId, promptId)).consecutive_billing_failures,
      ).toBe(0);

      // A fresh streak after the reset stays below the pause threshold.
      vi.setSystemTime(new Date(base + 4 * 60_000));
      await runAndRecord(cronStub, workspaceId, promptId, 'error', BILLING_ERROR);
      vi.setSystemTime(new Date(base + 5 * 60_000));
      await runAndRecord(cronStub, workspaceId, promptId, 'error', BILLING_ERROR);
      const afterSecondStreak = await getPrompt(cronStub, workspaceId, promptId);
      expect(afterSecondStreak.consecutive_billing_failures).toBe(2);
      expect(afterSecondStreak.enabled).toBe(true);

      vi.setSystemTime(new Date(base + 6 * 60_000));
      await runAndRecord(cronStub, workspaceId, promptId, 'question', 'Should I continue?');
      const afterQuestion = await getPrompt(cronStub, workspaceId, promptId);
      expect(afterQuestion.consecutive_billing_failures).toBe(0);
      expect(afterQuestion.enabled).toBe(true);
    });

    it('stale run completions do not touch the billing-failure streak', async () => {
      const base = Date.parse('2031-01-04T00:00:30.000Z');
      useFixedTime(new Date(base).toISOString());
      const { cronStub, workspaceId, promptId } = await setupPrompt('Stale Streak Owner');

      vi.setSystemTime(new Date(base + 60_000));
      await cronStub.runScheduledPromptNow(workspaceId, promptId);
      const firstRunId = await latestRunId(cronStub, workspaceId, promptId);
      vi.setSystemTime(new Date(base + 2 * 60_000));
      await cronStub.runScheduledPromptNow(workspaceId, promptId);
      const secondRunId = await latestRunId(cronStub, workspaceId, promptId);
      expect(secondRunId).not.toBe(firstRunId);

      // The prompt's current run is the second one; a late billing-error
      // completion for the first run must not move the streak.
      const staleRecorded = await cronStub.recordScheduledPromptRunResult({
        workspaceId,
        promptId,
        runId: firstRunId,
        status: 'error',
        message: BILLING_ERROR,
      });
      expect(staleRecorded).toBe(true);
      const afterStale = await getPrompt(cronStub, workspaceId, promptId);
      expect(afterStale.consecutive_billing_failures).toBe(0);
      expect(afterStale.enabled).toBe(true);

      // The current run still counts normally.
      const currentRecorded = await cronStub.recordScheduledPromptRunResult({
        workspaceId,
        promptId,
        runId: secondRunId,
        status: 'error',
        message: BILLING_ERROR,
      });
      expect(currentRecorded).toBe(true);
      const afterCurrent = await getPrompt(cronStub, workspaceId, promptId);
      expect(afterCurrent.consecutive_billing_failures).toBe(1);
    });

    it('re-enabling a paused schedule clears the billing-failure streak and re-arms it', async () => {
      const base = Date.parse('2031-01-05T00:00:30.000Z');
      useFixedTime(new Date(base).toISOString());
      const { cronStub, workspaceId, promptId } = await setupPrompt('Resume Owner');

      for (let attempt = 1; attempt <= 3; attempt++) {
        vi.setSystemTime(new Date(base + attempt * 60_000));
        await runAndRecord(cronStub, workspaceId, promptId, 'error', BILLING_ERROR);
      }
      const paused = await getPrompt(cronStub, workspaceId, promptId);
      expect(paused.enabled).toBe(false);
      expect(paused.auto_paused).toBe(true);
      expect(paused.consecutive_billing_failures).toBe(3);

      const resumed = await cronStub.updateScheduledPrompt({
        workspaceId,
        id: promptId,
        enabled: true,
      });
      expect(resumed?.enabled).toBe(true);
      expect(resumed?.next_run_at).toBeTypeOf('number');
      expect(resumed?.consecutive_billing_failures).toBe(0);
      expect(resumed?.auto_paused).toBe(false);
    });
  });
});
