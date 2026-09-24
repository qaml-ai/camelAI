import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/_app.settings.organization.ai-provider";
import { SettingsHeader } from "@/components/settings/settings-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ByokKeyForm } from "@/components/byok/byok-key-form";
import { RemoveKeyDialog } from "@/components/byok/remove-key-dialog";
import { OpenAiSubscriptionSettings } from "@/components/settings/openai-subscription-settings";
import {
  getAuthEnv,
  requireAuthContext,
  requireOrgAdmin,
} from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  BYOK_PROVIDERS,
  type OnboardingByokProvider,
} from "@/lib/byok-providers";
import { buildPublicLlmProviderConfig } from "@/lib/llm-provider-config";
import { getSelfhostAiProviderStatus } from "@/lib/selfhost-ai-provider";
import type { LlmProviderConfigPublic } from "@/types";

type FetcherIntent = "setProvider" | "deleteProvider" | "testProvider" | null;
type RemoveTrigger = "remove-key" | "switch-to-hosted";

interface ProviderActionResponse {
  success?: boolean;
  error?: string;
  message?: string;
  key_hint?: string;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

export function meta() {
  return [
    { title: "AI Provider - Settings - camelAI" },
    {
      name: "description",
      content:
        "Bring your own AI inference with an API key or OpenAI subscription.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const selfhostAiProvider = getSelfhostAiProviderStatus(env);

  if (selfhostAiProvider.configured) {
    return {
      config: selfhostAiProvider.publicConfig ?? null,
      orgId: authContext.currentOrg.id,
      selfhostAiProvider: {
        configured: true,
        valid: selfhostAiProvider.valid,
        message: selfhostAiProvider.message ?? null,
      },
      openAiSubscription: null,
    };
  }

  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg.id));
  const storedOpenAiSubscription = await orgStub.getOpenAiSubscription();
  const openAiSubscription = storedOpenAiSubscription
    ? {
        accountEmail: storedOpenAiSubscription.account_email,
        planType: storedOpenAiSubscription.plan_type,
        updatedAt: storedOpenAiSubscription.updated_at,
      }
    : null;
  const record = authContext.currentOrgLlmProviderConfig;

  if (!record) {
    return {
      config: null,
      orgId: authContext.currentOrg.id,
      selfhostAiProvider: null,
      openAiSubscription,
    };
  }

  const config: LlmProviderConfigPublic = await buildPublicLlmProviderConfig(
    record,
    env.INTEGRATION_SECRET_KEY,
  );

  return {
    config,
    orgId: authContext.currentOrg.id,
    selfhostAiProvider: null,
    openAiSubscription,
  };
}

function isOnboardingByokProvider(
  value: string,
): value is OnboardingByokProvider {
  return (
    value === "openrouter" ||
    value === "anthropic" ||
    value === "openai" ||
    value === "bedrock" ||
    value === "requesty" ||
    value === "custom"
  );
}

export default function AiProviderPage() {
  const { config, orgId, selfhostAiProvider, openAiSubscription } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ProviderActionResponse>();

  const initialProvider: OnboardingByokProvider =
    config && isOnboardingByokProvider(config.provider)
      ? config.provider
      : "openrouter";

  const [selectedProvider, setSelectedProvider] =
    useState<OnboardingByokProvider>(initialProvider);
  const [apiKey, setApiKey] = useState("");
  const [awsRegion, setAwsRegion] = useState(
    config?.config?.aws_region ?? "us-east-1",
  );
  const [customName, setCustomName] = useState(
    config?.config?.custom_name ?? "",
  );
  const [customBaseUrl, setCustomBaseUrl] = useState(
    config?.config?.custom_base_url ?? "",
  );
  const [customModelId, setCustomModelId] = useState(
    config?.config?.custom_model_id ?? "",
  );
  const [customAuthType, setCustomAuthType] = useState<"bearer" | "x-api-key">(
    config?.config?.custom_auth_type ?? "bearer",
  );
  const [customApi, setCustomApi] = useState<
    "openai-completions" | "openai-responses" | "anthropic-messages"
  >(config?.config?.custom_api ?? "openai-completions");
  const [lastIntent, setLastIntent] = useState<FetcherIntent>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeTrigger, setRemoveTrigger] = useState<RemoveTrigger>("remove-key");

  const fetcherData = fetcher.data;
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (config && isOnboardingByokProvider(config.provider)) {
      setSelectedProvider(config.provider);
    } else if (!config) {
      setSelectedProvider("openrouter");
    }
    setAwsRegion(config?.config?.aws_region ?? "us-east-1");
    setCustomName(config?.config?.custom_name ?? "");
    setCustomBaseUrl(config?.config?.custom_base_url ?? "");
    setCustomModelId(config?.config?.custom_model_id ?? "");
    setCustomAuthType(config?.config?.custom_auth_type ?? "bearer");
    setCustomApi(config?.config?.custom_api ?? "openai-completions");
  }, [config]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcherData) {
      return;
    }

    if (lastIntent === "testProvider" && fetcherData.message) {
      if (fetcherData.success) {
        toast.success(fetcherData.message);
      } else {
        toast.error(fetcherData.message);
      }
      setLastIntent(null);
      return;
    }

    if (lastIntent === "setProvider") {
      if (fetcherData.success) {
        setApiKey("");
        toast.success(
          "API key saved. Active chats will reconnect onto the updated provider credentials automatically.",
        );
        setLastIntent(null);
      } else if (fetcherData.error) {
        // Error stays inline on the form via errorMessage; no toast needed.
      }
      return;
    }

    if (lastIntent === "deleteProvider") {
      if (fetcherData.success) {
        setApiKey("");
        setRemoveOpen(false);
        toast.success(
          removeTrigger === "switch-to-hosted"
            ? "Switched back to camelAI hosted billing."
            : "API key removed.",
        );
        setLastIntent(null);
      }
    }
  }, [fetcher.state, fetcherData, lastIntent, removeTrigger]);

  function handleSave() {
    setLastIntent("setProvider");

    if (selectedProvider === "bedrock") {
      fetcher.submit(
        {
          intent: "setProvider",
          provider: "bedrock",
          ...(apiKey.trim() ? { bearer_token: apiKey.trim() } : {}),
          aws_region: awsRegion,
        },
        {
          method: "POST",
          action: `/api/orgs/${orgId}/llm-provider`,
          encType: "application/json",
        },
      );
      return;
    }

    if (selectedProvider === "custom") {
      fetcher.submit(
        {
          intent: "setProvider",
          provider: "custom",
          api_key: apiKey.trim(),
          custom_name: customName.trim(),
          custom_base_url: customBaseUrl.trim(),
          custom_model_id: customModelId.trim(),
          custom_auth_type: customAuthType,
          custom_api: customApi,
        },
        {
          method: "POST",
          action: `/api/orgs/${orgId}/llm-provider`,
          encType: "application/json",
        },
      );
      return;
    }

    fetcher.submit(
      {
        intent: "setProvider",
        provider: selectedProvider,
        api_key: apiKey.trim(),
      },
      {
        method: "POST",
        action: `/api/orgs/${orgId}/llm-provider`,
        encType: "application/json",
      },
    );
  }

  function handleTest() {
    setLastIntent("testProvider");
    fetcher.submit(
      { intent: "testProvider" },
      {
        method: "POST",
        action: `/api/orgs/${orgId}/llm-provider`,
        encType: "application/json",
      },
    );
  }

  function handleConfirmRemove() {
    setLastIntent("deleteProvider");
    setApiKey("");
    fetcher.submit(
      { intent: "deleteProvider" },
      {
        method: "POST",
        action: `/api/orgs/${orgId}/llm-provider`,
        encType: "application/json",
      },
    );
  }

  const errorMessage =
    fetcher.state === "idle" && lastIntent === "setProvider"
      ? fetcherData?.error
      : undefined;

  const submitLabel = config ? "Replace key" : "Save key";

  const configuredProvider = config?.provider ?? null;
  const configuredProviderLabel =
    configuredProvider === "custom" && config?.config?.custom_name
      ? config.config.custom_name
      : configuredProvider && isOnboardingByokProvider(configuredProvider)
      ? BYOK_PROVIDERS[configuredProvider].label
      : (configuredProvider ?? "");

  const submitDisabled = (() => {
    if (isSubmitting) return true;
    if (selectedProvider === "custom") {
      return (
        apiKey.trim().length === 0 ||
        customName.trim().length === 0 ||
        customBaseUrl.trim().length === 0 ||
        customModelId.trim().length === 0
      );
    }
    if (selectedProvider === "bedrock" && config?.provider === "bedrock") {
      const regionUnchanged = awsRegion === config?.config?.aws_region;
      if (apiKey.trim().length === 0 && regionUnchanged) return true;
      return false;
    }
    return apiKey.trim().length === 0;
  })();

  const removeIsRemoving = isSubmitting && lastIntent === "deleteProvider";

  if (selfhostAiProvider?.configured) {
    return (
      <div className="space-y-6">
        <SettingsHeader
          title="AI Provider"
          description="AI provider credentials are managed by this self-host deployment."
        />
        <Separator />

        <section className="max-w-2xl space-y-4">
          <Alert variant={selfhostAiProvider.valid ? "default" : "destructive"}>
            <AlertTitle>Managed by environment variables</AlertTitle>
            <AlertDescription>
              Set or rotate this provider through the self-host environment. Org
              admins cannot replace it from the UI while SELFHOST_AI_PROVIDER is
              configured.
            </AlertDescription>
          </Alert>

          {config ? (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{configuredProviderLabel}</span>
                <Badge variant="secondary">self-host</Badge>
                <span className="font-mono text-muted-foreground">
                  {config.key_hint}
                </span>
              </div>
              {config.provider === "custom" && config.config.custom_base_url ? (
                <p className="text-muted-foreground">
                  {config.config.custom_base_url}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-destructive">
              {selfhostAiProvider.message ??
                "Self-host AI provider environment variables are incomplete."}
            </p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="AI Provider"
        description="Bring your own AI inference with an API key or OpenAI subscription."
      />
      <Separator />

      <OpenAiSubscriptionSettings orgId={orgId} subscription={openAiSubscription} />

      <Separator />

      {config ? (
        <>
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Active key</h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{configuredProviderLabel}</span>
                  <span className="font-mono text-muted-foreground">
                    {config.key_hint}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Added {dateFormatter.format(new Date(config.updated_at))}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={isSubmitting}
                >
                  {isSubmitting && lastIntent === "testProvider"
                    ? "Testing…"
                    : "Test"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setRemoveTrigger("remove-key");
                    setRemoveOpen(true);
                  }}
                  disabled={isSubmitting}
                >
                  Remove
                </Button>
              </div>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h2 className="text-base font-semibold">Switch to camelAI billing</h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-sm text-muted-foreground">
                Switch back to camelAI hosted credits. Your key is removed and
                camelAI bills you for LLM usage.
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setRemoveTrigger("switch-to-hosted");
                  setRemoveOpen(true);
                }}
                disabled={isSubmitting}
              >
                Use camelAI billing
              </Button>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h2 className="text-base font-semibold">Replace key</h2>
            <ByokKeyForm
              className="max-w-2xl"
              selectedProvider={selectedProvider}
              onProviderChange={setSelectedProvider}
              apiKey={apiKey}
              onApiKeyChange={setApiKey}
              awsRegion={awsRegion}
              onAwsRegionChange={setAwsRegion}
              customName={customName}
              onCustomNameChange={setCustomName}
              customBaseUrl={customBaseUrl}
              onCustomBaseUrlChange={setCustomBaseUrl}
              customModelId={customModelId}
              onCustomModelIdChange={setCustomModelId}
              customAuthType={customAuthType}
              onCustomAuthTypeChange={setCustomAuthType}
              customApi={customApi}
              onCustomApiChange={setCustomApi}
              onSubmit={handleSave}
              isSubmitting={isSubmitting && lastIntent === "setProvider"}
              errorMessage={errorMessage ?? null}
              submitLabel={submitLabel}
              submittingLabel="Saving…"
              submitDisabled={submitDisabled}
              autoFocusApiKey={false}
              apiKeyPlaceholderOverride={
                selectedProvider === configuredProvider ? config.key_hint : null
              }
            />
          </section>
        </>
      ) : (
        <ByokKeyForm
          className="max-w-2xl"
          selectedProvider={selectedProvider}
          onProviderChange={setSelectedProvider}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          awsRegion={awsRegion}
          onAwsRegionChange={setAwsRegion}
          customName={customName}
          onCustomNameChange={setCustomName}
          customBaseUrl={customBaseUrl}
          onCustomBaseUrlChange={setCustomBaseUrl}
          customModelId={customModelId}
          onCustomModelIdChange={setCustomModelId}
          customAuthType={customAuthType}
          onCustomAuthTypeChange={setCustomAuthType}
          customApi={customApi}
          onCustomApiChange={setCustomApi}
          onSubmit={handleSave}
          isSubmitting={isSubmitting && lastIntent === "setProvider"}
          errorMessage={errorMessage ?? null}
          submitLabel={submitLabel}
          submittingLabel="Saving…"
          submitDisabled={submitDisabled}
        />
      )}

      <RemoveKeyDialog
        open={removeOpen}
        onOpenChange={(next) => {
          if (!removeIsRemoving) setRemoveOpen(next);
        }}
        providerLabel={configuredProviderLabel || "API"}
        onConfirm={handleConfirmRemove}
        isRemoving={removeIsRemoving}
        title={
          removeTrigger === "switch-to-hosted"
            ? "Switch back to camelAI billing?"
            : undefined
        }
        description={
          removeTrigger === "switch-to-hosted"
            ? `Your ${configuredProviderLabel || "current"} key will be removed. New chats will use camelAI hosted credits.`
            : undefined
        }
        confirmLabel={
          removeTrigger === "switch-to-hosted"
            ? "Switch to camelAI"
            : undefined
        }
        removingLabel={
          removeTrigger === "switch-to-hosted" ? "Switching…" : undefined
        }
      />
    </div>
  );
}
