import { Link, useFetcher, useLoaderData, redirect } from "react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Route } from "./+types/_admin.orgs.$id";
import { requireSuperuser, getAuthEnv } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import * as adminDO from "@/lib/auth-do.server";
import {
  adminTransferOrgOwnership,
  updateOrgMemberRole,
  getOrg,
  getOrgMembers,
  getOrgInvitations,
} from "@/lib/auth-do";
import { getOrgBanById, type BanRecord } from "../../workers/main/src/ban-list";
import { waitUntil } from "@/lib/wait-until";
import {
  refreshOrgCustomDomainHostnamesForAdmin,
  type AdminCustomDomainRefreshResult,
} from "@/lib/admin-custom-domain.server";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AddOrgMemberDialog } from "@/components/admin/add-org-member-dialog";
import { OrgDangerZone } from "@/components/admin/org-danger-zone";
import { OrgMemberRoleSelect } from "@/components/admin/org-member-role-select";
import { OrgEditForm } from "@/components/admin/org-edit-form";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { parseCreditGrantAmountCents } from "@/lib/admin-credit-grants";
import { getContrastTextColor } from "@/lib/avatar";
import {
  billingStatusBadgeVariant,
  billingStatusLabel,
  formatUsdFromCents,
} from "@/lib/billing";
import { getByokProviderLabel } from "@/lib/byok-providers";
import { buildPublicLlmProviderConfig } from "@/lib/llm-provider-config";
import { cn } from "@/lib/utils";
import type { BillingStatus, LlmProviderConfigPublic } from "@/types";
import { Plus, RefreshCw } from "lucide-react";

const ADMIN_BILLING_STATUSES: BillingStatus[] = [
  "inactive",
  "trialing",
  "active",
  "enterprise",
  "past_due",
  "canceled",
];

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const RECENT_THREAD_LIMIT = 10;
const RECENT_APP_LIMIT = 10;

type AdminOrgActionResult = {
  success?: boolean;
  error?: string;
  customDomainRefresh?: AdminCustomDomainRefreshResult;
  creditGrant?: {
    grantId: string;
    amountCents: number;
    reason: string | null;
    createdAt: number;
    createdBy: string | null;
    source: string | null;
    applied: boolean;
  };
};

type UsageSpend = {
  org_id: string;
  total_cost_usd: number;
  total_requests: number;
  windows: Array<{
    label: string;
    window_ms: number;
    limit_usd: number;
    spent_usd: number;
    exceeded: boolean;
  }>;
} | null;

type UsageLog = {
  entries: Array<{
    id: number;
    model: string;
    provider: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    duration_ms: number;
    created_at_ms: number;
  }>;
} | null;

type CreditSummary = {
  purchaseTotalCents: number;
  grantTotalCents: number;
  totalCreditLimitCents: number;
  chargeableUsageCents: number | null;
  availableCreditsCents: number | null;
};

type CreditGrantRecord = {
  grant_id: string;
  amount_cents: number;
  reason: string | null;
  created_at: number;
  created_by: string | null;
  source: string | null;
};

type CreditGrantUser = {
  id: string;
  email: string;
  name: string | null;
};

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

const roleBadgeClasses: Record<string, string> = {
  owner: "border-amber-500/30 bg-amber-500/15 text-amber-700",
  admin: "border-blue-500/30 bg-blue-500/15 text-blue-700",
  member: "border-slate-500/30 bg-slate-500/10 text-slate-700",
  viewer: "border-muted bg-muted text-muted-foreground",
};

export function meta({ data }: Route.MetaArgs) {
  return [
    {
      title: data?.org
        ? `${data.org.name} - Admin - camelAI`
        : "Organization - Admin - camelAI",
    },
    { name: "description", content: "View organization details" },
  ];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const { id } = params;
  const authEnv = getAuthEnv(getEnv(context));

  // Fetch org first to check existence, then fetch related data in parallel
  const org = await getOrg(authEnv, id);
  if (!org) {
    throw redirect("/qaml-backdoor/orgs");
  }

  const env = getEnv(context);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(id));

  const usagePromise = Promise.all([
    orgStub.getUsageSpend().catch(() => null),
    orgStub.getUsageLog({ limit: 10 }).catch(() => null),
  ]);
  const usageLogSumPromise = orgStub
    .getUsageLogSum(0, Date.now(), true)
    .catch(() => null);
  const creditGrantsResultPromise = orgStub
    .listManualCreditGrants(10)
    .then((grants) => ({ grants, error: null as string | null }))
    .catch((error) => ({
      grants: [] as CreditGrantRecord[],
      error:
        error instanceof Error
          ? error.message
          : "Failed to load credit grants",
    }));

  const [
    members,
    invitations,
    workspaces,
    recentActivity,
    llmProvider,
    customDomainApps,
    [usageSpend, usageLog],
    usageLogSum,
    creditGrantsResult,
    orgBan,
  ] = await Promise.all([
    getOrgMembers(authEnv, id),
    getOrgInvitations(authEnv, id),
    adminDO.adminGetWorkspacesByOrg(context, id),
    adminDO.adminGetOrgRecentActivity(context, id, {
      threadLimit: RECENT_THREAD_LIMIT,
      appLimit: RECENT_APP_LIMIT,
      includeCounts: "cheap",
    }),
    orgStub
      .getLlmProviderConfig()
      .then(async (record) => {
        if (!record) {
          return { config: null, createdByUser: null };
        }
        const [config, createdByUser] = await Promise.all([
          buildPublicLlmProviderConfig(record, env.INTEGRATION_SECRET_KEY),
          authEnv.USER.get(authEnv.USER.idFromName(record.created_by))
            .getProfile()
            .then((user) =>
              user ? { id: user.id, email: user.email } : null,
            )
            .catch(() => null),
        ]);
        return { config, createdByUser };
      }),
    orgStub.listWorkerScripts(),
    usagePromise as Promise<[any, any]>,
    usageLogSumPromise,
    creditGrantsResultPromise,
    getOrgBanById(getEnv(context).APP_KV, id),
  ]);

  const threadCountFromWorkspaces = workspaces.reduce((sum, workspace) => {
    return (
      sum +
      (Number.isFinite(workspace.thread_count) ? workspace.thread_count : 0)
    );
  }, 0);
  const derivedThreadCount = Number.isFinite(threadCountFromWorkspaces)
    ? threadCountFromWorkspaces
    : recentActivity.threadCount;

  // Create plain object for Client Component
  const safeOrg = {
    id: org.id,
    name: org.name,
    slug: org.slug,
    created_by: org.created_by,
    created_at: org.created_at,
    billing_status: org.billing_status,
    billing_customer_id: org.billing_customer_id,
    billing_subscription_id: org.billing_subscription_id,
    billing_subscription_status: org.billing_subscription_status,
    billing_trial_started_at: org.billing_trial_started_at,
    billing_trial_ends_at: org.billing_trial_ends_at,
    billing_credit_purchase_total_cents:
      org.billing_credit_purchase_total_cents,
    billing_credit_grant_total_cents: org.billing_credit_grant_total_cents,
    billing_trial_credit_grant_cents: org.billing_trial_credit_grant_cents,
    billing_trial_credit_granted_at: org.billing_trial_credit_granted_at,
    billing_last_included_credit_invoice_id:
      org.billing_last_included_credit_invoice_id,
    billing_credit_usage_started_at: org.billing_credit_usage_started_at,
    archived: org.archived,
    archived_at: org.archived_at,
    archived_by: org.archived_by ?? null,
  };

  const memberOptions = members.map((member) => ({
    id: member.user.id,
    name: member.user.name,
    email: member.user.email,
    role: member.role,
  }));

  const purchaseTotalCents = org.billing_credit_purchase_total_cents ?? 0;
  const grantTotalCents = org.billing_credit_grant_total_cents ?? 0;
  const totalCreditLimitCents = purchaseTotalCents + grantTotalCents;
  const chargeableUsageCents = usageLogSum
    ? Math.round(Number(usageLogSum.total_cost_usd ?? 0) * 100)
    : null;
  const availableCreditsCents =
    chargeableUsageCents === null
      ? null
      : Math.max(0, totalCreditLimitCents - chargeableUsageCents);
  const creditSummary: CreditSummary = {
    purchaseTotalCents,
    grantTotalCents,
    totalCreditLimitCents,
    chargeableUsageCents,
    availableCreditsCents,
  };

  const creditGrantUserIds = [
    ...new Set(
      creditGrantsResult.grants
        .map((grant) => grant.created_by)
        .filter((userId): userId is string => Boolean(userId)),
    ),
  ];
  const creditGrantUsers = await Promise.all(
    creditGrantUserIds.map(async (userId) => {
      const user = await authEnv.USER.get(authEnv.USER.idFromName(userId))
        .getProfile()
        .catch(() => null);
      return user
        ? { id: user.id, email: user.email, name: user.name }
        : null;
    }),
  );

  return {
    org: safeOrg,
    members,
    invitations,
    workspaces,
    recentThreads: recentActivity.threads,
    recentApps: recentActivity.apps,
    threadCount: derivedThreadCount,
    appCount: recentActivity.appCount,
    llmProviderConfig: llmProvider.config,
    llmProviderCreatedByUser: llmProvider.createdByUser,
    customDomainApps,
    memberOptions,
    orgBan,
    usageSpend: usageSpend as UsageSpend,
    usageLog: usageLog as UsageLog,
    creditSummary,
    creditGrants: creditGrantsResult.grants as CreditGrantRecord[],
    creditGrantsUnavailable: Boolean(creditGrantsResult.error),
    creditGrantsError: creditGrantsResult.error,
    creditGrantUsers: creditGrantUsers.filter(
      (user): user is CreditGrantUser => Boolean(user),
    ),
  };
}

function AdminAiProviderCard({
  config,
  createdByUser,
}: {
  config: LlmProviderConfigPublic | null;
  createdByUser: { id: string; email: string } | null;
}) {
  const providerLabel = config
    ? (getByokProviderLabel(config.provider) ?? config.provider)
    : null;
  const createdByLabel = createdByUser?.email ?? config?.created_by ?? "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Provider</CardTitle>
        <CardDescription>
          Bring-your-own-key provider status for this organization.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {config ? (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">
                Status
              </dt>
              <dd className="text-sm">API key configured</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">
                Provider
              </dt>
              <dd className="text-sm">{providerLabel}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">
                Key Hint
              </dt>
              <dd className="font-mono text-sm">{config.key_hint}</dd>
            </div>
            {config.config.aws_region ? (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  AWS Region
                </dt>
                <dd className="font-mono text-sm">
                  {config.config.aws_region}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-sm font-medium text-muted-foreground">
                Updated
              </dt>
              <dd className="text-sm">{formatTimestamp(config.updated_at)}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">
                Created By
              </dt>
              <dd>
                <Link
                  to={`/qaml-backdoor/users/${config.created_by}`}
                  className="text-sm hover:underline"
                >
                  {createdByLabel}
                </Link>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm">No API key configured</p>
        )}
      </CardContent>
    </Card>
  );
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const authContext = await requireSuperuser(request, context);

  const formData = await request.formData();
  const intent = formData.get("intent");
  const { id: orgId } = params;
  const authEnv = getAuthEnv(getEnv(context));

  if (intent === "grantCredits") {
    const amountResult = parseCreditGrantAmountCents(formData.get("amount"));
    if (amountResult.error || amountResult.amountCents === undefined) {
      return { error: amountResult.error ?? "Invalid credit amount" };
    }

    const rawIdempotencyKey = formData.get("idempotencyKey");
    const idempotencyKey =
      typeof rawIdempotencyKey === "string"
        ? rawIdempotencyKey.trim()
        : "";
    if (!idempotencyKey) {
      return { error: "Idempotency key is required" };
    }
    if (idempotencyKey.length > 200) {
      return { error: "Idempotency key is too long" };
    }

    const reasonValue = formData.get("reason");
    const reason =
      typeof reasonValue === "string" && reasonValue.trim()
        ? reasonValue.trim().slice(0, 500)
        : null;

    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const result = await orgStub.applyManualCreditGrant(
      amountResult.amountCents,
      reason,
      idempotencyKey,
      { createdBy: authContext.user.id, source: "qaml-backdoor" },
    );
    if (!result) {
      return { error: "Failed to grant usage credits" };
    }

    return {
      success: true,
      creditGrant: {
        applied: result.applied,
        grantId: result.grantId,
        amountCents: result.amountCents,
        reason: result.reason,
        createdAt: result.createdAt,
        createdBy: result.createdBy,
        source: result.source,
      },
    };
  }

  if (intent === "addMember") {
    const userId = formData.get("userId") as string;
    const role = formData.get("role") as "admin" | "member";
    if (!userId || !role) {
      return { error: "User ID and role are required" };
    }
    await adminDO.addAdminOrgMember(context, orgId, userId, role);
    return { success: true };
  }

  if (intent === "updateMemberRole") {
    const userId = formData.get("userId") as string;
    const role = formData.get("role") as
      | "admin"
      | "member"
      | "viewer"
      | "owner";
    if (!userId || !role) {
      return { error: "User ID and role are required" };
    }
    await updateOrgMemberRole(authEnv, orgId, userId, role, "system-admin");
    return { success: true };
  }

  if (intent === "transferOwnership") {
    const newOwnerId = formData.get("newOwnerId") as string;
    if (!newOwnerId) {
      return { error: "New owner ID is required" };
    }
    await adminTransferOrgOwnership(authEnv, orgId, newOwnerId, "system-admin");
    return { success: true };
  }

  if (intent === "archiveOrg") {
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.archiveOrg("system-admin");
    return { success: true };
  }

  if (intent === "banOrg") {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      return { error: "Ban reason is required" };
    }
    try {
      const job = await adminDO.startAdminOrgBanAndPurgeWithEnv(
        getEnv(context),
        orgId,
        {
          reason,
          actorId: "system-admin",
        },
      );
      waitUntil(
        adminDO
          .runAdminOrgBanAndPurgeWithEnv(getEnv(context), job, "system-admin")
          .catch((error) => {
            console.error("[admin] org ban purge failed", error);
          }),
      );
      return { success: true, banStarted: true, jobId: job.id };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to ban organization",
      };
    }
  }

  if (intent === "hardDeleteOrg") {
    try {
      const result = await adminDO.hardDeleteAdminOrg(
        context,
        orgId,
        "system-admin",
      );
      return { success: true, warnings: result.warnings };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to permanently delete organization",
      };
    }
  }

  if (intent === "updateOrg") {
    const name = formData.get("name") as string;
    const billingStatus = String(formData.get("billingStatus") ?? "").trim();
    if (!name?.trim()) {
      return { error: "Organization name is required" };
    }
    if (
      !billingStatus ||
      !ADMIN_BILLING_STATUSES.includes(billingStatus as BillingStatus)
    ) {
      return { error: "A valid billing status is required" };
    }
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.updateName(name.trim(), "system-admin");
    await stub.updateBillingState({
      billing_status: billingStatus as BillingStatus,
    });
    return { success: true };
  }

  if (intent === "refreshCustomDomain") {
    try {
      const result = await refreshOrgCustomDomainHostnamesForAdmin(
        getEnv(context),
        orgId,
        {
          includeActive: formData.get("includeActive") === "true",
        },
      );
      if (!result) {
        return { error: "Organization not found" };
      }
      return { success: true, customDomainRefresh: result };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to refresh custom domain hostnames",
      };
    }
  }

  return { error: "Unknown action" };
}

function customDomainStatusVariant(status: string | null | undefined) {
  if (status === "active") return "default";
  if (status === "failed" || status === "expired") return "destructive";
  return "outline";
}

function AdminCustomDomainCard({
  apps,
}: {
  apps: Array<{
    script_name: string;
    custom_domain_hostname: string | null;
    custom_domain_status: string | null;
    custom_domain_ssl_status: string | null;
    custom_domain_error: string | null;
    custom_domain_updated_at: number | null;
  }>;
}) {
  const fetcher = useFetcher<AdminOrgActionResult>();
  const loading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.error) {
      toast.error(fetcher.data.error);
      return;
    }
    const result = fetcher.data.customDomainRefresh;
    if (result) {
      toast.success(
        `Custom domain refresh completed for ${result.refreshed}/${result.attempted} attempted apps`,
      );
    }
  }, [fetcher.state, fetcher.data]);

  const configuredApps = apps.filter((app) => app.custom_domain_hostname);
  const pendingApps = configuredApps.filter(
    (app) =>
      app.custom_domain_status !== "active" ||
      app.custom_domain_ssl_status !== "active",
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Custom Domain</CardTitle>
          <CardDescription>
            Refresh Cloudflare custom hostname validation for apps stuck in
            pending SSL.
          </CardDescription>
        </div>
        {configuredApps.length > 0 ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="refreshCustomDomain" />
            <input type="hidden" name="includeActive" value="false" />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={loading}
            >
              <RefreshCw
                className={cn("size-3.5", loading && "animate-spin")}
              />
              {loading ? "Refreshing" : "Refresh Pending SSL"}
            </Button>
          </fetcher.Form>
        ) : null}
      </CardHeader>
      <CardContent>
        {configuredApps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No custom domain configured for this organization.
          </p>
        ) : (
          <div className="space-y-4">
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Configured Apps
                </dt>
                <dd className="text-sm">{configuredApps.length}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Apps Needing SSL
                </dt>
                <dd className="text-sm">{pendingApps.length}</dd>
              </div>
            </dl>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Hostname</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {configuredApps.map((app) => (
                  <TableRow key={app.script_name}>
                    <TableCell className="font-mono text-xs">
                      {app.script_name}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {app.custom_domain_hostname}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant={customDomainStatusVariant(
                            app.custom_domain_status,
                          )}
                        >
                          {app.custom_domain_status ?? "missing"}
                        </Badge>
                        <Badge
                          variant={customDomainStatusVariant(
                            app.custom_domain_ssl_status,
                          )}
                        >
                          SSL {app.custom_domain_ssl_status ?? "missing"}
                        </Badge>
                      </div>
                      {app.custom_domain_error ? (
                        <p className="mt-1 max-w-md text-xs text-destructive">
                          {app.custom_domain_error}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {app.custom_domain_updated_at
                        ? formatTimestamp(app.custom_domain_updated_at)
                        : "Never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function createCreditGrantIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `grant:${Date.now()}`;
}

function shortId(id: string) {
  return `${id.slice(0, 8)}...`;
}

function formatNullableCents(value: number | null) {
  return value === null ? "Unavailable" : formatUsdFromCents(value);
}

export function AdminAiUsageSpendCard({
  orgId,
  usageSpend,
  usageLog,
  creditSummary,
  creditGrants,
  creditGrantsUnavailable,
  creditGrantsError,
  creditGrantUsers,
}: {
  orgId: string;
  usageSpend: UsageSpend;
  usageLog: UsageLog;
  creditSummary: CreditSummary;
  creditGrants: CreditGrantRecord[];
  creditGrantsUnavailable: boolean;
  creditGrantsError: string | null;
  creditGrantUsers: CreditGrantUser[];
}) {
  const fetcher = useFetcher<AdminOrgActionResult>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const submitting = fetcher.state !== "idle";
  const userById = new Map(creditGrantUsers.map((user) => [user.id, user]));

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    setIdempotencyKey(open ? createCreditGrantIdempotencyKey() : null);
  };

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.error) {
      toast.error(fetcher.data.error);
      return;
    }
    if (fetcher.data.creditGrant) {
      toast.success("Credits granted");
      setDialogOpen(false);
      setIdempotencyKey(null);
    }
  }, [fetcher.state, fetcher.data]);

  const summaryItems = [
    {
      label: "Available",
      value: formatNullableCents(creditSummary.availableCreditsCents),
    },
    {
      label: "Total credits",
      value: formatUsdFromCents(creditSummary.totalCreditLimitCents),
    },
    {
      label: "Granted credits",
      value: formatUsdFromCents(creditSummary.grantTotalCents),
    },
    {
      label: "Purchased credits",
      value: formatUsdFromCents(creditSummary.purchaseTotalCents),
    },
    {
      label: "Chargeable usage",
      value: formatNullableCents(creditSummary.chargeableUsageCents),
    },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>AI Usage &amp; Spend</CardTitle>
          <CardDescription>
            {usageSpend
              ? `$${usageSpend.total_cost_usd.toFixed(2)} lifetime spend across ${usageSpend.total_requests} requests`
              : "Usage tracking unavailable"}
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => handleDialogOpenChange(true)}
        >
          <Plus className="size-3.5" />
          Grant credits
        </Button>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <dl className="grid gap-3 sm:grid-cols-5">
            {summaryItems.map((item) => (
              <div
                key={item.label}
                className="rounded-md border bg-muted/20 px-3 py-2"
              >
                <dt className="text-xs font-medium text-muted-foreground">
                  {item.label}
                </dt>
                <dd className="mt-1 font-mono text-sm">{item.value}</dd>
              </div>
            ))}
          </dl>

          {usageSpend ? (
            usageLog && usageLog.entries.length > 0 ? (
              <div>
                <p className="mb-2 text-sm font-medium text-muted-foreground">
                  Recent requests
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usageLog.entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="font-mono text-xs">
                          {entry.model
                            .replace("claude-", "")
                            .replace(/-\d{8}$/, "")}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {entry.input_tokens.toLocaleString()} in /{" "}
                          {entry.output_tokens.toLocaleString()} out
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          ${entry.cost_usd.toFixed(4)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatTimestamp(entry.created_at_ms)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null
          ) : (
            <p className="text-sm text-muted-foreground">
              Sandbox host is not reachable or usage tracking is not enabled.
            </p>
          )}

          <div className="mt-6">
            <p className="mb-2 text-sm font-medium text-muted-foreground">
              Recent credit grants
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Granted</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {creditGrantsUnavailable ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-sm text-muted-foreground"
                    >
                      Credit grant history unavailable
                      {creditGrantsError ? (
                        <span className="mt-1 block text-xs">
                          {creditGrantsError}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ) : creditGrants.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-sm text-muted-foreground"
                    >
                      No credit grants recorded
                    </TableCell>
                  </TableRow>
                ) : (
                  creditGrants.map((grant) => {
                    const createdByUser = grant.created_by
                      ? userById.get(grant.created_by)
                      : null;
                    return (
                      <TableRow key={grant.grant_id}>
                        <TableCell className="font-mono text-xs">
                          {formatUsdFromCents(grant.amount_cents)}
                        </TableCell>
                        <TableCell className="max-w-xs text-xs">
                          {grant.reason ?? "-"}
                        </TableCell>
                        <TableCell>
                          {grant.created_by ? (
                            createdByUser ? (
                              <Link
                                to={`/qaml-backdoor/users/${grant.created_by}`}
                                className="text-xs hover:underline"
                              >
                                <span className="font-medium">
                                  {createdByUser.name || createdByUser.email}
                                </span>
                                {createdByUser.name ? (
                                  <span className="block text-muted-foreground">
                                    {createdByUser.email}
                                  </span>
                                ) : null}
                                <span className="block font-mono text-muted-foreground">
                                  {shortId(grant.created_by)}
                                </span>
                              </Link>
                            ) : (
                              <span className="font-mono text-xs text-muted-foreground">
                                {shortId(grant.created_by)}
                              </span>
                            )
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {grant.source ?? "system"}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatTimestamp(grant.created_at)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grant usage credits</DialogTitle>
            <DialogDescription>
              Add credits to this organization without creating a Stripe
              transaction.
            </DialogDescription>
          </DialogHeader>
          <fetcher.Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="grantCredits" />
            <input
              type="hidden"
              name="idempotencyKey"
              value={idempotencyKey ?? ""}
            />
            <div className="grid gap-2">
              <Label htmlFor={`credit-amount-${orgId}`}>Amount</Label>
              <Input
                id={`credit-amount-${orgId}`}
                name="amount"
                placeholder="5.00"
                inputMode="decimal"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Enter dollars, for example 5.00 for $5.00.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`credit-reason-${orgId}`}>Reason</Label>
              <Textarea
                id={`credit-reason-${orgId}`}
                name="reason"
                placeholder="Low-credit alert testing"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleDialogOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Granting" : "Grant credits"}
              </Button>
            </div>
          </fetcher.Form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function AdminOrgDetailPage() {
  const {
    org,
    members,
    invitations,
    workspaces,
    recentThreads,
    recentApps,
    threadCount,
    appCount,
    llmProviderConfig,
    llmProviderCreatedByUser,
    customDomainApps,
    memberOptions,
    orgBan,
    usageSpend,
    usageLog,
    creditSummary,
    creditGrants,
    creditGrantsUnavailable,
    creditGrantsError,
    creditGrantUsers,
  } = useLoaderData<typeof loader>();
  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: "Admin", href: "/qaml-backdoor" },
          { label: "Organizations", href: "/qaml-backdoor/orgs" },
          { label: org.name },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Organization Details</CardTitle>
                <CardDescription>
                  View and edit organization information
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      ID
                    </dt>
                    <dd className="font-mono text-sm">{org.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Name
                    </dt>
                    <dd className="text-sm">{org.name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Billing
                    </dt>
                    <dd>
                      <Badge
                        variant={billingStatusBadgeVariant(org.billing_status)}
                      >
                        {billingStatusLabel(org.billing_status)}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Status
                    </dt>
                    <dd>
                      <Badge variant={org.archived ? "secondary" : "outline"}>
                        {org.archived ? "Archived" : "Active"}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Created
                    </dt>
                    <dd className="text-sm">
                      {formatTimestamp(org.created_at)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Created By
                    </dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/users/${org.created_by}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {org.created_by.slice(0, 8)}...
                      </Link>
                    </dd>
                  </div>
                  {org.archived && org.archived_at ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">
                        Archived At
                      </dt>
                      <dd className="text-sm">
                        {formatTimestamp(org.archived_at)}
                      </dd>
                    </div>
                  ) : null}
                  {org.archived && org.archived_by ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">
                        Archived By
                      </dt>
                      <dd>
                        <Link
                          to={`/qaml-backdoor/users/${org.archived_by}`}
                          className="text-sm font-mono hover:underline"
                        >
                          {org.archived_by.slice(0, 8)}...
                        </Link>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </CardContent>
            </Card>

            <AdminAiProviderCard
              config={llmProviderConfig}
              createdByUser={llmProviderCreatedByUser}
            />

            <Card>
              <CardHeader>
                <CardTitle>Edit Organization</CardTitle>
                <CardDescription>Update organization settings</CardDescription>
              </CardHeader>
              <CardContent>
                <OrgEditForm org={org} />
              </CardContent>
            </Card>

            <AdminAiUsageSpendCard
              orgId={org.id}
              usageSpend={usageSpend}
              usageLog={usageLog}
              creditSummary={creditSummary}
              creditGrants={creditGrants}
              creditGrantsUnavailable={creditGrantsUnavailable}
              creditGrantsError={creditGrantsError}
              creditGrantUsers={creditGrantUsers}
            />

            <AdminCustomDomainCard apps={customDomainApps} />

            <Card>
              <CardHeader>
                <CardTitle>Workspaces</CardTitle>
                <CardDescription>
                  {workspaces.length}{" "}
                  {workspaces.length === 1 ? "workspace" : "workspaces"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {workspaces.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No workspaces</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Threads</TableHead>
                        <TableHead>Integrations</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspaces.map((workspace) => (
                        <TableRow key={workspace.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${workspace.id}`}
                              className="flex items-center gap-3 hover:underline"
                            >
                              <Avatar size="default">
                                <AvatarFallback
                                  content={workspace.avatar.content}
                                  style={{
                                    backgroundColor: workspace.avatar.color,
                                    color: getContrastTextColor(
                                      workspace.avatar.color,
                                    ),
                                  }}
                                >
                                  {workspace.avatar.content}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <div className="font-medium">
                                  {workspace.name}
                                </div>
                                <div className="text-xs text-muted-foreground font-mono">
                                  {workspace.id.slice(0, 8)}...
                                </div>
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {workspace.thread_count}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {workspace.integration_count}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                workspace.archived ? "secondary" : "outline"
                              }
                            >
                              {workspace.archived ? "Archived" : "Active"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent Threads</CardTitle>
                <CardDescription>
                  {threadCount === null
                    ? `${recentThreads.length} recent ${recentThreads.length === 1 ? "thread" : "threads"}`
                    : `${threadCount} total ${threadCount === 1 ? "thread" : "threads"} (showing latest ${recentThreads.length})`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {recentThreads.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No threads</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Thread</TableHead>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentThreads.map((thread) => (
                        <TableRow key={thread.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/threads/${thread.id}`}
                              className="hover:underline"
                            >
                              <div className="font-medium">
                                {thread.title || "Untitled"}
                              </div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {thread.id.slice(0, 8)}...
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${thread.workspace_id}`}
                              className="text-sm hover:underline"
                            >
                              {thread.workspace_name || thread.workspace_id}
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(thread.updated_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent Apps</CardTitle>
                <CardDescription>
                  {appCount === null
                    ? `${recentApps.length} recent ${recentApps.length === 1 ? "app" : "apps"}`
                    : `${appCount} total ${appCount === 1 ? "app" : "apps"} (showing latest ${recentApps.length})`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {recentApps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No apps</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>App</TableHead>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Visibility</TableHead>
                        <TableHead>Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentApps.map((app) => (
                        <TableRow key={app.script_name}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/apps/${encodeURIComponent(app.script_name)}`}
                              className="hover:underline font-mono"
                            >
                              {app.script_name}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${app.workspace_id}`}
                              className="text-sm hover:underline"
                            >
                              {app.workspace_name || app.workspace_id}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={app.is_public ? "default" : "secondary"}
                            >
                              {app.is_public ? "Public" : "Private"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(app.updated_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>Members</CardTitle>
                  <CardDescription>
                    {members.length}{" "}
                    {members.length === 1 ? "member" : "members"}
                  </CardDescription>
                </div>
                <AddOrgMemberDialog orgId={org.id} />
              </CardHeader>
              <CardContent>
                {members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No members</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Member</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Joined</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((member) => (
                        <TableRow key={member.user.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/users/${member.user.id}`}
                              className="flex items-center gap-3 hover:underline"
                            >
                              <Avatar size="default">
                                <AvatarFallback
                                  content={member.user.avatar.content}
                                  style={{
                                    backgroundColor: member.user.avatar.color,
                                    color: getContrastTextColor(
                                      member.user.avatar.color,
                                    ),
                                  }}
                                >
                                  {member.user.avatar.content}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <div className="font-medium">
                                  {member.user.name || member.user.email}
                                </div>
                                {member.user.name ? (
                                  <div className="text-xs text-muted-foreground">
                                    {member.user.email}
                                  </div>
                                ) : null}
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={cn(
                                roleBadgeClasses[member.role] || "",
                              )}
                            >
                              {member.role}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(member.joined_at)}
                          </TableCell>
                          <TableCell>
                            <OrgMemberRoleSelect
                              orgId={org.id}
                              userId={member.user.id}
                              currentRole={member.role}
                              disabled={member.role === "owner"}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {invitations.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Pending Invitations</CardTitle>
                  <CardDescription>
                    {invitations.length} pending{" "}
                    {invitations.length === 1 ? "invitation" : "invitations"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Expires</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invitations.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell>
                            <div className="font-medium">{inv.email}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {inv.id.slice(0, 8)}...
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{inv.role}</Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(inv.expires_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Audit Log</CardTitle>
                <CardDescription>
                  Track recent organization changes
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <Link to={`/qaml-backdoor/orgs/${org.id}/audit-log`}>
                    View Audit Log
                  </Link>
                </Button>
              </CardContent>
            </Card>

            <OrgDangerZone
              orgId={org.id}
              orgName={org.name}
              archived={org.archived}
              members={memberOptions}
              workspaceCount={workspaces.length}
              orgBan={orgBan as BanRecord | null}
            />
          </div>
        </div>
      </div>
    </>
  );
}
