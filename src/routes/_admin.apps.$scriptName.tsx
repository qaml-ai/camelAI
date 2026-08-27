import { Link, useLoaderData, redirect } from 'react-router';
import type { Route } from './+types/_admin.apps.$scriptName';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do.server';
import { setWorkerScriptPublic, deleteWorkerScript } from '@/lib/auth-do';
import { deleteDeployedAppRuntime } from '@/lib/deployed-app-delete.server';
import { getVanityDomain } from '@/lib/app-url.server';
import { buildAppLabel } from '@/lib/app-url';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AppEditForm } from '@/components/admin/app-edit-form';
import { AppDangerZone } from '@/components/admin/app-danger-zone';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ExternalLink } from 'lucide-react';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

function getAdminAppHost(scriptName: string, orgSlug: string | null, vanityDomain: string) {
  return orgSlug
    ? `${buildAppLabel(scriptName, orgSlug)}.${vanityDomain}`
    : `${scriptName}.${vanityDomain}`;
}

export function meta({ data }: Route.MetaArgs) {
  return [
    { title: data?.app ? `${data.app.script_name} - Admin - camelAI` : 'App - Admin - camelAI' },
    { name: 'description', content: 'View app details' },
  ];
}

export async function action({ request, context, params }: Route.ActionArgs) {
  await requireSuperuser(request, context);

  const { scriptName } = params;
  const decodedScriptName = decodeURIComponent(scriptName);
  const formData = await request.formData();
  const intent = formData.get('intent');

  // Get app to find org_id
  const app = await authDO.adminGetAppDetail(context, decodedScriptName);
  if (!app) {
    return { error: 'App not found' };
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  if (intent === 'updateApp') {
    const isPublic = formData.get('isPublic') === 'true';
    await setWorkerScriptPublic(authEnv, app.org_id, decodedScriptName, isPublic, 'system-admin');
    return { success: true };
  }

  if (intent === 'deleteApp') {
    if (!app.org_slug) {
      return { error: 'Organization slug is required to delete this app' };
    }

    try {
      await deleteDeployedAppRuntime(env, {
        scriptName: decodedScriptName,
        orgSlug: app.org_slug,
      });

      // Then, delete from database and KV index
      await deleteWorkerScript(authEnv, app.org_id, decodedScriptName, 'system-admin');
      return redirect('/qaml-backdoor/apps');
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Failed to delete app',
      };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const { scriptName } = params;
  const decodedScriptName = decodeURIComponent(scriptName);

  const app = await authDO.adminGetAppDetail(context, decodedScriptName);
  if (!app) {
    throw redirect('/qaml-backdoor/apps');
  }

  // Create plain object for Client Component
  const safeApp = {
    script_name: app.script_name,
    workspace_id: app.workspace_id,
    workspace_name: app.workspace_name,
    org_id: app.org_id,
    org_name: app.org_name,
    org_slug: app.org_slug,
    created_by: app.created_by,
    created_by_name: app.created_by_name,
    created_by_email: app.created_by_email,
    created_at: app.created_at,
    updated_at: app.updated_at,
    is_public: app.is_public,
    preview_status: app.preview_status,
    preview_error: app.preview_error,
  };

  const vanityDomain = await getVanityDomain(request);

  return { app: safeApp, vanityDomain };
}

export default function AdminAppDetailPage() {
  const { app, vanityDomain } = useLoaderData<typeof loader>();
  const appHost = getAdminAppHost(app.script_name, app.org_slug, vanityDomain);

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Apps', href: '/qaml-backdoor/apps' },
          { label: app.script_name },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>App Details</CardTitle>
                <CardDescription>View and manage deployed app</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Script Name</dt>
                    <dd className="font-mono text-sm">{app.script_name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Live URL</dt>
                    <dd>
                      <a
                        href={`https://${appHost}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        {appHost}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Organization</dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/orgs/${app.org_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {app.org_name} ({app.org_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Workspace</dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/workspaces/${app.workspace_id}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {app.workspace_name} ({app.workspace_id.slice(0, 8)}...)
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created By</dt>
                    <dd className="text-sm">
                      {app.created_by.startsWith('system:') ? (
                        <span className="font-mono text-muted-foreground">{app.created_by}</span>
                      ) : (
                        <Link
                          to={`/qaml-backdoor/users/${app.created_by}`}
                          className="hover:underline"
                        >
                          {app.created_by_name || app.created_by_email || `${app.created_by.slice(0, 8)}...`}
                        </Link>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                    <dd>
                      <Badge variant={app.is_public ? 'default' : 'secondary'}>
                        {app.is_public ? 'Public' : 'Private'}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Preview</dt>
                    <dd className="space-y-1">
                      <Badge
                        variant={
                          app.preview_status === 'ready'
                            ? 'default'
                            : app.preview_status === 'failed'
                              ? 'destructive'
                              : app.preview_status === 'pending'
                                ? 'secondary'
                                : 'outline'
                        }
                      >
                        {app.preview_status ?? 'Unknown'}
                      </Badge>
                      {app.preview_status === 'failed' && app.preview_error ? (
                        <div className="text-xs text-muted-foreground font-mono break-words">
                          {app.preview_error}
                        </div>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatTimestamp(app.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Updated</dt>
                    <dd className="text-sm">{formatTimestamp(app.updated_at)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit App</CardTitle>
                <CardDescription>Update app visibility</CardDescription>
              </CardHeader>
              <CardContent>
                <AppEditForm app={app} />
              </CardContent>
            </Card>

            <AppDangerZone app={app} />
          </div>
        </div>
      </div>
    </>
  );
}
