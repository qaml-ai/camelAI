import { Suspense } from 'react';
import { Await, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.apps';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import {
  setWorkerScriptPublic,
  deleteWorkerScript,
  getWorkerScript,
} from '@/lib/auth-do';
import { deleteDeployedAppRuntime } from '@/lib/deployed-app-delete.server';
import * as chatDO from '@/lib/chat-do.server';
import { refreshWorkerScriptCustomDomainStates } from '@/lib/custom-domain.server';
import { getAppUrlContext } from '@/lib/app-url.server';
import { loadUserProfileSummaries } from '@/lib/user-profiles.server';
import AppsClient from '@/components/pages/apps/apps-client';
import { AppsLoadingSkeleton } from '@/components/pages/apps/apps-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { WorkerScriptWithCreator } from '@/types';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
  };
}

export function meta() {
  return [
    { title: 'Apps - camelAI' },
    { name: 'description', content: 'Your deployed applications' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'setAppPublic') {
    const scriptName = formData.get('scriptName') as string;
    const isPublic = formData.get('isPublic') === 'true';
    const threadId = formData.get('threadId') as string | null;

    if (!scriptName) {
      return { error: 'Script name is required' };
    }

    try {
      await setWorkerScriptPublic(
        authEnv,
        authContext.currentOrg.id,
        scriptName,
        isPublic,
        authContext.user.id
      );

      if (threadId && authContext.currentWorkspace?.id) {
        try {
          const thread = await chatDO.getThread(
            context,
            threadId,
            authContext.currentWorkspace.id,
            { orgId: authContext.currentOrg.id },
          );
          if (thread) {
            await chatDO.setThreadPreviewAppVisibility(context, threadId, scriptName, isPublic);
          }
        } catch (err) {
          console.error('Failed to update preview visibility:', err);
        }
      }

      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to update app' };
    }
  }

  if (intent === 'deleteApp') {
    const scriptName = formData.get('scriptName') as string;

    if (!scriptName) {
      return { error: 'Script name is required' };
    }

    try {
      // First, verify the script belongs to the current org (without deleting)
      const script = await getWorkerScript(
        authEnv,
        authContext.currentOrg.id,
        scriptName
      );

      if (!script) {
        console.warn('[deleteApp] Script not found in org database', {
          scriptName,
          orgId: authContext.currentOrg.id,
        });
        return { error: 'App not found or you do not have permission to delete it' };
      }

      // Remove the served runtime first so a metadata failure can be retried
      // without leaving a public app orphaned.
      await deleteDeployedAppRuntime(env, {
        scriptName,
        orgSlug: authContext.currentOrg.slug,
      });

      // Finally, delete from database and KV index
      await deleteWorkerScript(
        authEnv,
        authContext.currentOrg.id,
        scriptName,
        authContext.user.id
      );

      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete app' };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const hostname = getAppUrlContext(env, request);
  const renderedAt = Date.now();

  // Check filter from URL params
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'this-workspace';

  const workspaceId = authContext.currentWorkspace?.id;
  const appsPromise: Promise<WorkerScriptWithCreator[]> = workspaceId
    ? (async () => {
        const scripts = await authEnv.ORG.get(
          authEnv.ORG.idFromName(authContext.currentOrg.id),
        ).listWorkerScripts();
        const refreshedScripts = await refreshWorkerScriptCustomDomainStates(
          env,
          authContext.currentOrg.id,
          scripts,
          null,
        );

        const filteredScripts = filter === 'all-workspaces'
          ? refreshedScripts
          : refreshedScripts.filter((script) => script.workspace_id === workspaceId);

        const creatorMap = await loadUserProfileSummaries(
          authEnv,
          filteredScripts.map((s) => s.created_by),
          { request, preloadedUsers: [authContext.user] },
        );

        return filteredScripts.map((script) => {
          const creator = creatorMap.get(script.created_by);
          return {
            script_name: script.script_name,
            workspace_id: script.workspace_id,
            created_by: script.created_by,
            created_at: script.created_at,
            updated_at: script.updated_at,
            is_public: script.is_public,
            preview_key: script.preview_key,
            preview_updated_at: script.preview_updated_at,
            preview_status: script.preview_status,
            preview_error: script.preview_error,
            config_path: script.config_path,
            project_id: script.project_id,
            custom_domain_hostname: script.custom_domain_hostname,
            custom_domain_cf_hostname_id: script.custom_domain_cf_hostname_id,
            custom_domain_status: script.custom_domain_status,
            custom_domain_ssl_status: script.custom_domain_ssl_status,
            custom_domain_error: script.custom_domain_error,
            custom_domain_updated_at: script.custom_domain_updated_at,
            creator: creator
              ? {
                  id: creator.id,
                  name: creator.name,
                  email: creator.email,
                  avatar: creator.avatar,
                }
              : undefined,
          };
        });
      })().catch((error) => {
        console.error('Failed to load apps:', error);
        return [];
      })
    : Promise.resolve([]);

  return {
    apps: appsPromise,
    orgId: authContext.currentOrg.id,
    orgSlug: authContext.currentOrg.slug,
    hostname,
    renderedAt,
    hasWorkspace: Boolean(workspaceId),
    orgCustomDomain: null,
  };
}

export default function AppsPage() {
  const {
    apps,
    orgSlug,
    hostname,
    renderedAt,
    hasWorkspace,
    orgCustomDomain,
  } = useLoaderData<typeof loader>();

  if (!hasWorkspace) {
    return <NoWorkspacesError />;
  }

  return (
    <Suspense fallback={<AppsLoadingSkeleton />}>
      <Await resolve={apps}>
        {(resolvedApps) => (
          <AppsClient
            initialApps={resolvedApps}
            orgSlug={orgSlug}
            hostname={hostname}
            initialNow={renderedAt}
            orgCustomDomain={orgCustomDomain}
          />
        )}
      </Await>
    </Suspense>
  );
}

export function HydrateFallback() {
  return <AppsLoadingSkeleton />;
}
