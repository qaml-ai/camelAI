import {
  type RouteConfig,
  route,
  layout,
  index,
} from "@react-router/dev/routes";

export default [
  // Public auth routes
  layout("routes/_auth.tsx", [
    route("login", "routes/_auth.login.tsx"),
    route("signup", "routes/_auth.signup.tsx"),
    route("forgot-password", "routes/_auth.forgot-password.tsx"),
    route("reset-password", "routes/_auth.reset-password.tsx"),
  ]),
  route("signup.", "routes/signup-dot.ts"),
  route("banned", "routes/banned.tsx"),
  // Per-organization direct OIDC authorization entry point.
  route("sso/:slug", "routes/sso.$slug.ts"),

  // Public invitation page (loader fetches optional auth state)
  layout("routes/_invite.tsx", [
    route(
      "invitations/:orgId/:invitationId",
      "routes/invitations.$orgId.$invitationId.tsx",
    ),
  ]),

  // Protected onboarding routes (no app sidebar)
  route("onboarding", "routes/_onboarding.tsx", [
    index("routes/_onboarding.welcome.tsx"),
  ]),

  // Protected app routes
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("chat", "routes/_app.chat._index.tsx"),
    route("chat/:id", "routes/_app.chat.$id.tsx"),
    route("apps", "routes/_app.apps.tsx"),
    route("automations", "routes/_app.automations.tsx"),
    route("history", "routes/_app.history.tsx"),
    route("connections", "routes/_app.connections.tsx"),

    // Settings nested layout
    layout("routes/_app.settings.tsx", [
      route("settings/profile", "routes/_app.settings.profile.tsx"),
      route("settings/organizations", "routes/_app.settings.organizations.tsx"),

      // Organization settings nested layout
      layout("routes/_app.settings.organization.tsx", [
        route(
          "settings/organization/general",
          "routes/_app.settings.organization.general.tsx",
        ),
        route(
          "settings/organization/team",
          "routes/_app.settings.organization.team.tsx",
        ),
        route(
          "settings/organization/billing",
          "routes/_app.settings.organization.billing.tsx",
        ),
        route(
          "settings/organization/workspaces",
          "routes/_app.settings.organization.workspaces.tsx",
        ),
        route(
          "settings/organization/domains",
          "routes/_app.settings.organization.domains.tsx",
        ),
        route(
          "settings/organization/sso",
          "routes/_app.settings.organization.sso.tsx",
        ),
        route(
          "settings/organization/ai-provider",
          "routes/_app.settings.organization.ai-provider.tsx",
        ),
        route(
          "settings/organization/models",
          "routes/_app.settings.organization.models.tsx",
        ),
        route(
          'settings/organization/usage',
          'routes/_app.settings.organization.usage.tsx'
        ),
      ]),

      // Workspace settings nested layout
      layout("routes/_app.settings.workspace.tsx", [
        route(
          "settings/workspace/general",
          "routes/_app.settings.workspace.general.tsx",
        ),
        route(
          "settings/workspace/connections",
          "routes/_app.settings.workspace.connections.tsx",
        ),
        route(
          "settings/workspace/chats",
          "routes/_app.settings.workspace.chats.tsx",
        ),
        route(
          "settings/workspace/apps",
          "routes/_app.settings.workspace.apps.tsx",
        ),
      ]),
    ]),
  ]),

  // Auth API routes
  route("api/auth/login", "routes/api/auth.login.ts"),
  route("api/auth/signup", "routes/api/auth.signup.ts"),
  route("api/auth/forgot-password", "routes/api/auth.forgot-password.ts"),
  route("api/auth/reset-password", "routes/api/auth.reset-password.ts"),
  route("api/auth/verify-email", "routes/api/auth.verify-email.ts"),
  route("api/auth/verify-email/send", "routes/api/auth.verify-email.send.ts"),
  route("api/auth/logout", "routes/api/auth.logout.ts"),
  route(
    "api/auth/enterprise-oidc/callback",
    "routes/api/auth.enterprise-oidc.callback.ts",
  ),
  route(
    "api/auth/enterprise-oidc/link",
    "routes/api/auth.enterprise-oidc.link.ts",
  ),
  route("api/auth/switch-org", "routes/api/auth.switch-org.ts"),
  route("api/auth/switch-workspace", "routes/api/auth.switch-workspace.ts"),
  route("api/orgs", "routes/api/orgs.ts"),
  route("api/onboarding/complete", "routes/api/onboarding.complete.ts"),
  route(
    "api/marketing-attribution",
    "routes/api/marketing-attribution.ts",
  ),
  route(
    "api/marketing-attribution/activate",
    "routes/api/marketing-attribution.activate.ts",
  ),
  route(
    "api/marketing-attribution/purchase",
    "routes/api/marketing-attribution.purchase.ts",
  ),
  route(
    "api/billing/start-subscription",
    "routes/api/billing.start-subscription.ts",
  ),
  route("api/billing/start-payg", "routes/api/billing.start-payg.ts"),
  route(
    "api/billing/chat-credit-status",
    "routes/api/billing.chat-credit-status.ts",
  ),
  route("api/billing/credit-packs", "routes/api/billing.credit-packs.ts"),
  route("api/client-errors", "routes/api/client-errors.ts"),
  route("api/version", "routes/api/version.ts"),
  route("api/help", "routes/api/help.ts"),
  route("api/history", "routes/api/history.tsx"),
  route("api/automations/:id/runs", "routes/api/automations.$id.runs.ts"),
  route("api/chat-groups/:id", "routes/api/chat-groups.$id.ts"),
  route("api/chat-groups/:id/members", "routes/api/chat-groups.$id.members.ts"),
  route(
    "api/chat-groups/:id/members/:threadId",
    "routes/api/chat-groups.$id.members.$threadId.ts",
  ),
  route(
    "api/chat-groups/:id/members/:threadId/reopen",
    "routes/api/chat-groups.$id.members.$threadId.reopen.ts",
  ),
  route(
    "api/chat-groups/:id/reorder-tabs",
    "routes/api/chat-groups.$id.reorder-tabs.ts",
  ),
  route("api/chat-groups/move-thread", "routes/api/chat-groups.move-thread.ts"),
  route("api/threads/:id", "routes/api/threads.$id.ts"),
  route(
    "api/threads/:id/condensed-transcript",
    "routes/api/threads.$id.condensed-transcript.ts",
  ),
  route(
    "api/threads/:id/mark-viewed",
    "routes/api/threads.$id.mark-viewed.ts",
  ),
  // Threads on the hosted agent runtime (plans/runtime-threads-direct.md).
  route("api/threads/:id/token", "routes/api/threads.$id.token.ts"),
  route("api/threads/:id/messages", "routes/api/threads.$id.messages.ts"),
  route(
    "api/threads/:id/inputs/:inputId",
    "routes/api/threads.$id.inputs.$inputId.ts",
  ),
  route("api/threads/:id/stop", "routes/api/threads.$id.stop.ts"),
  route("api/threads/:id/preview", "routes/api/threads.$id.preview.ts"),
  route("api/threads/:id/files/save", "routes/api/threads.$id.files.save.ts"),
  route("api/threads/:id/files/*", "routes/api/threads.$id.files.$.ts"),
  route("api/dev/sent-emails", "routes/api/dev.sent-emails.ts"),
  route("api/dev/sent-emails/:id", "routes/api/dev.sent-emails.$id.ts"),
  route(
    "api/dev/email-verification/latest",
    "routes/api/dev.email-verification.latest.ts",
  ),
  route("api/dev/verify-email", "routes/api/dev.verify-email.ts"),
  route("api/admin/oauth/register", "routes/api/admin.oauth.register.ts"),
  route("api/admin/oauth/authorize", "routes/api/admin.oauth.authorize.tsx"),
  route("api/admin/oauth/token", "routes/api/admin.oauth.token.ts"),
  route("api/admin/oauth/revoke", "routes/api/admin.oauth.revoke.ts"),

  // Workspace filesystem API routes
  route(
    "api/workspaces/:id/file-preview/text",
    "routes/api/workspaces.$id.file-preview.text.ts",
  ),
  route(
    "api/workspaces/:id/fs/content/*",
    "routes/api/workspaces.$id.fs.content.$.ts",
  ),
  route(
    "api/workspaces/:id/projects/:project/fs/content/*",
    "routes/api/workspaces.$id.projects.$project.fs.content.$.ts",
  ),
  route(
    "api/workspaces/:id/projects",
    "routes/api/workspaces.$id.projects.ts",
  ),
  route(
    "api/workspaces/:id/mentions",
    "routes/api/workspaces.$id.mentions.ts",
  ),
  route(
    "api/workspaces/:id/chat/threads",
    "routes/api/workspaces.$id.chat.threads.ts",
  ),
  route(
    "api/workspaces/:id/chat/:threadId/fork",
    "routes/api/workspaces.$id.chat.$threadId.fork.ts",
  ),
  route(
    "api/workspaces/:id/apps/:scriptName/visibility",
    "routes/api/workspaces.$id.apps.$scriptName.visibility.ts",
  ),

  // Workspace file upload API route (R2-based, for chat attachments)
  route("api/workspaces/:id/upload", "routes/api/workspaces.$id.upload.ts"),

  // Workspace output files (agent-created files for user download/preview)
  route(
    "api/workspaces/:id/outputs/*",
    "routes/api/workspaces.$id.outputs.$.ts",
  ),
  route(
    "api/workspaces/:id/uploads/*",
    "routes/api/workspaces.$id.uploads.$.ts",
  ),

  // Apps API routes
  route(
    "api/apps/:scriptName/preview",
    "routes/api/apps.$scriptName.preview.ts",
  ),
  route("api/orgs/:id/custom-domain", "routes/api/orgs.$id.custom-domain.ts"),
  route("api/orgs/:id/sso", "routes/api/orgs.$id.sso.ts"),

  // Speech API routes
  route("api/speech/transcribe", "routes/api/speech.transcribe.ts"),

  // Self-host health/readiness route
  route("api/selfhost/health", "routes/api/selfhost.health.ts"),

  // Organization & invitation API routes
  route("api/orgs/:id/invite", "routes/api/orgs.$id.invite.ts"),
  route("api/orgs/:id/llm-provider", "routes/api/orgs.$id.llm-provider.ts"),
  route(
    "api/invitations/:orgId/:invitationId",
    "routes/api/invitations.$orgId.$invitationId.ts",
  ),
] satisfies RouteConfig;
