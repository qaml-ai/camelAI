import { Link, useLoaderData, redirect } from 'react-router';
import type { Route } from './+types/_admin.threads.$id';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do.server';
import { getVanityDomain } from '@/lib/app-url.server';
import { isLlmModel, THREAD_MODEL_LOCK_MESSAGE } from '@/lib/llm-provider-config';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { ThreadEditForm } from '@/components/admin/thread-edit-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Download } from 'lucide-react';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

function getTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n');
}

export function meta({ data }: Route.MetaArgs) {
  return [
    { title: data?.thread ? `${data.thread.title} - Admin - camelAI` : 'Thread - Admin - camelAI' },
    { name: 'description', content: 'View thread details' },
  ];
}

export async function action({ request, context, params }: Route.ActionArgs) {
  await requireSuperuser(request, context);

  const { id: threadId } = params;
  const formData = await request.formData();
  const intent = formData.get('intent');
  const authEnv = getAuthEnv(getEnv(context));

  if (intent === 'updateThread') {
    const title = formData.get('title') as string;
    const model = formData.get('model');
    const orgId = formData.get('orgId') as string;
    if (!title?.trim()) {
      return { error: 'Thread title is required' };
    }
    if (!orgId) {
      return { error: 'Org ID is required' };
    }
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const existingThread = await stub.getThread(threadId);
    if (!existingThread) {
      return { error: 'Thread not found' };
    }
    if (model !== null && !isLlmModel(model)) {
      return { error: 'Invalid thread model' };
    }
    if (model !== null && model !== existingThread.model) {
      return { error: THREAD_MODEL_LOCK_MESSAGE };
    }
    const updated = await stub.adminUpdateThread(
      threadId,
      {
        title: title.trim(),
        ...(model !== null ? { model } : {}),
      },
      'system-admin'
    );
    try {
      const env = getEnv(context);
      if (typeof env.CHAT_THREAD?.get !== 'function' || typeof env.CHAT_THREAD.idFromName !== 'function') {
        return { success: true };
      }
      const chatThread = env.CHAT_THREAD.get(
        env.CHAT_THREAD.idFromName(threadId)
      ) as unknown as {
        setTitle(title: string, updatedAt?: number): Promise<void>;
        setModel(model: string, updatedAt?: number): Promise<void>;
        refreshRunnerConfig(): Promise<void>;
      };
      await chatThread.setTitle(title.trim(), updated?.updated_at);
      if (model !== null) {
        await chatThread.setModel(model, updated?.updated_at);
        await chatThread.refreshRunnerConfig();
      }
    } catch (error) {
      console.error('Failed to refresh runner after admin thread model update:', error);
    }
    return { success: true };
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const { id } = params;

  const result = await authDO.adminGetThreadWithMessages(context, id);
  if (!result) {
    throw redirect('/qaml-backdoor/threads');
  }

  const { thread, messages, org_id, org_name, workspace_id, workspace_name, preview_target } = result;
  // Create plain object for Client Component
  const safeThread = {
    id: thread.id,
    title: thread.title,
    created_by: thread.created_by,
    model: thread.model,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
  };

  const vanityDomain = await getVanityDomain(request);
  const jsonlDownloadUrl =
    `/api/admin/threads/${encodeURIComponent(safeThread.id)}/jsonl` +
    `?orgId=${encodeURIComponent(org_id)}` +
    `&workspaceId=${encodeURIComponent(workspace_id)}`;

  return {
    thread: safeThread,
    messages,
    org_id,
    org_name,
    workspace_id,
    workspace_name,
    preview_target,
    vanityDomain,
    jsonlDownloadUrl,
  };
}

export default function AdminThreadDetailPage() {
  const {
    thread,
    messages,
    org_id,
    org_name,
    workspace_id,
    workspace_name,
    preview_target,
    vanityDomain,
    jsonlDownloadUrl,
  } = useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Threads', href: '/qaml-backdoor/threads' },
          { label: thread.title },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Thread Details</CardTitle>
                <CardDescription>View and edit thread information</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">ID</dt>
                    <dd className="font-mono text-sm">{thread.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Title</dt>
                    <dd className="text-sm">{thread.title}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Organization</dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/orgs/${org_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {org_name} ({org_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Workspace</dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/workspaces/${workspace_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {workspace_name} ({workspace_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Model</dt>
                    <dd className="text-sm capitalize">{thread.model}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(thread.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Updated</dt>
                    <dd className="text-sm">{formatTimestamp(thread.updated_at)}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex items-center gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to={`/chat/${thread.id}?adminReadonly=1`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View as User
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <a href={jsonlDownloadUrl} download={`${thread.id}.jsonl`}>
                      <Download className="h-4 w-4" />
                      Download JSONL
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Active Preview</CardTitle>
                <CardDescription>Current thread preview target</CardDescription>
              </CardHeader>
              <CardContent>
                {!preview_target ? (
                  <p className="text-sm text-muted-foreground">No active preview target</p>
                ) : preview_target.kind === 'app' ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between p-2 rounded-md bg-muted">
                      <code className="text-sm">{preview_target.scriptName}</code>
                      <a
                        href={`https://${preview_target.scriptName}.${vanityDomain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline"
                      >
                        https://{preview_target.scriptName}.{vanityDomain}
                      </a>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Visibility: {preview_target.isPublic ? 'Public' : 'Private'}
                    </p>
                  </div>
                ) : preview_target.kind === 'runtime_artifact' ? (
                  <div className="space-y-2 text-sm">
                    <div className="font-medium">{preview_target.artifact.title}</div>
                    <div className="text-muted-foreground">Artifact: {preview_target.artifact.kind}</div>
                    <div className="text-muted-foreground">Status: {preview_target.artifact.status}</div>
                  </div>
                ) : (
                  <div className="space-y-2 text-sm">
                    <div className="font-medium">{preview_target.filename || preview_target.path}</div>
                    <div className="text-muted-foreground">Source: {preview_target.source}</div>
                    <div className="text-muted-foreground break-all">Path: {preview_target.path}</div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit Thread</CardTitle>
                <CardDescription>Update thread title and chat model</CardDescription>
              </CardHeader>
              <CardContent>
            <ThreadEditForm thread={thread} orgId={org_id} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Messages</CardTitle>
                <CardDescription>
                  {messages.length} {messages.length === 1 ? 'message' : 'messages'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No messages</p>
                ) : (
                  <ScrollArea className="h-[400px] pr-4">
                    <div className="space-y-4">
                      {messages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`rounded-lg p-3 ${
                            msg.role === 'user'
                              ? 'bg-primary/10 ml-8'
                              : 'bg-muted mr-8'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <Badge variant={msg.role === 'user' ? 'default' : 'secondary'}>
                              {msg.role}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatTimestamp(msg.created_at)}
                            </span>
                          </div>
                          <div className="text-sm whitespace-pre-wrap break-words">
                            {(() => {
                              const text = getTextContent(msg.content);
                              return text.length > 1000 ? text.slice(0, 1000) + '...' : text;
                            })()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
