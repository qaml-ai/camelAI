import { Link, useLoaderData } from 'react-router';
import type { Route } from './+types/_admin.apps';
import { requireSuperuser } from '@/lib/auth.server';
import * as authDO from '@/lib/auth-do.server';
import { getVanityDomain } from '@/lib/app-url.server';
import { buildAppLabel } from '@/lib/app-url';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { AdminSearch } from '@/components/admin/admin-search';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const LIMIT = 50;

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

export function meta() {
  return [
    { title: 'Apps - Admin - camelAI' },
    { name: 'description', content: 'Manage deployed apps' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);
  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const search = url.searchParams.get('search')?.trim() || '';

  const { items: apps, total } = await authDO.adminGetAppsPaginated(context, {
    offset,
    limit: LIMIT,
    search: search || undefined,
  });

  const baseUrl = search
    ? `/qaml-backdoor/apps?search=${encodeURIComponent(search)}`
    : '/qaml-backdoor/apps';

  const vanityDomain = await getVanityDomain(request);

  return { apps, total, offset, search, baseUrl, vanityDomain };
}

export default function AdminAppsPage() {
  const { apps, total, offset, baseUrl, vanityDomain } = useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Apps' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Apps</h1>
              <p className="text-sm text-muted-foreground">
                {total} deployed {total === 1 ? 'app' : 'apps'}
              </p>
            </div>
            <div className="w-full sm:w-64">
              <AdminSearch placeholder="Search apps" />
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Preview</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      No apps found
                    </TableCell>
                  </TableRow>
                ) : (
                  apps.map((app) => {
                    const appHost = getAdminAppHost(app.script_name, app.org_slug, vanityDomain);
                    return (
                      <TableRow key={app.script_name}>
                        <TableCell>
                          <div className="space-y-1">
                            <Link
                              to={`/qaml-backdoor/apps/${encodeURIComponent(app.script_name)}`}
                              className="block hover:underline"
                            >
                              <div className="font-medium text-foreground font-mono">
                                {app.script_name}
                              </div>
                            </Link>
                            <a
                              href={`https://${appHost}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline font-mono"
                            >
                              {appHost}
                            </a>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/qaml-backdoor/orgs/${app.org_id}`}
                            className="hover:underline"
                          >
                            <div className="font-medium">{app.org_name}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {app.org_id.slice(0, 8)}...
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/qaml-backdoor/workspaces/${app.workspace_id}`}
                            className="hover:underline"
                          >
                            <div className="font-medium">{app.workspace_name}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {app.workspace_id.slice(0, 8)}...
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant={app.is_public ? 'default' : 'secondary'}>
                            {app.is_public ? 'Public' : 'Private'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
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
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="block max-w-[240px] truncate text-xs text-muted-foreground font-mono"
                                    tabIndex={0}
                                  >
                                    {app.preview_error}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs break-words font-mono">
                                  {app.preview_error}
                                </TooltipContent>
                              </Tooltip>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatTimestamp(app.updated_at)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <AdminPagination
            total={total}
            offset={offset}
            limit={LIMIT}
            baseUrl={baseUrl}
          />
        </div>
      </div>
    </>
  );
}
