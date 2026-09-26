import { Alert, AlertDescription } from "@/components/ui/alert";
import { ByokProviderInfoCard } from "@/components/byok/byok-provider-info-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  AWS_REGIONS,
  BYOK_PROVIDER_ORDER,
  BYOK_PROVIDERS,
  type OnboardingByokProvider,
} from "@/lib/byok-providers";

interface ByokKeyFormProps {
  selectedProvider: OnboardingByokProvider;
  onProviderChange: (provider: OnboardingByokProvider) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  awsRegion: string;
  onAwsRegionChange: (region: string) => void;
  customName?: string;
  onCustomNameChange?: (name: string) => void;
  customBaseUrl?: string;
  onCustomBaseUrlChange?: (url: string) => void;
  customModelId?: string;
  onCustomModelIdChange?: (modelId: string) => void;
  customAuthType?: "bearer" | "x-api-key";
  onCustomAuthTypeChange?: (authType: "bearer" | "x-api-key") => void;
  customApi?: "openai-completions" | "openai-responses" | "anthropic-messages";
  onCustomApiChange?: (
    api: "openai-completions" | "openai-responses" | "anthropic-messages",
  ) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  errorMessage?: string | null;
  submitLabel: string;
  submittingLabel?: string;
  apiKeyPlaceholderOverride?: string | null;
  submitDisabled?: boolean;
  autoFocusApiKey?: boolean;
  footer?: React.ReactNode;
  className?: string;
}

export function ByokKeyForm({
  selectedProvider,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  awsRegion,
  onAwsRegionChange,
  customName = "",
  onCustomNameChange,
  customBaseUrl = "",
  onCustomBaseUrlChange,
  customModelId = "",
  onCustomModelIdChange,
  customAuthType = "bearer",
  onCustomAuthTypeChange,
  customApi = "openai-completions",
  onCustomApiChange,
  onSubmit,
  isSubmitting,
  errorMessage,
  submitLabel,
  submittingLabel,
  apiKeyPlaceholderOverride,
  submitDisabled,
  autoFocusApiKey = true,
  footer,
  className,
}: ByokKeyFormProps) {
  const provider = BYOK_PROVIDERS[selectedProvider];
  const disabled =
    submitDisabled !== undefined
      ? submitDisabled || isSubmitting
      : isSubmitting || apiKey.trim().length === 0;

  return (
    <form
      className={cn("space-y-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <div className="space-y-2">
        <Label className="text-sm">Provider</Label>
        <ToggleGroup
          type="single"
          value={selectedProvider}
          onValueChange={(value) => {
            if (value) {
              onProviderChange(value as OnboardingByokProvider);
            }
          }}
          variant="outline"
          size="lg"
          className="!grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {BYOK_PROVIDER_ORDER.map((key) => (
            <ToggleGroupItem
              key={key}
              value={key}
              className="px-3 text-sm font-medium data-[state=on]:ring-2 data-[state=on]:ring-primary"
            >
              {BYOK_PROVIDERS[key].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <ByokProviderInfoCard provider={provider} />

      {selectedProvider === "custom" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="byok-custom-name" className="text-sm">
              Provider name
            </Label>
            <Input
              id="byok-custom-name"
              value={customName}
              placeholder="Acme AI"
              onChange={(event) => onCustomNameChange?.(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="byok-custom-base-url" className="text-sm">
              Base URL
            </Label>
            <Input
              id="byok-custom-base-url"
              value={customBaseUrl}
              placeholder={
                customApi === "anthropic-messages"
                  ? "https://api.example.com"
                  : "https://api.example.com/v1"
              }
              onChange={(event) => onCustomBaseUrlChange?.(event.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="byok-custom-auth-type" className="text-sm">
              Auth header
            </Label>
            <Select
              value={customAuthType}
              onValueChange={(value) =>
                onCustomAuthTypeChange?.(value as "bearer" | "x-api-key")
              }
            >
              <SelectTrigger id="byok-custom-auth-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bearer">Authorization: Bearer</SelectItem>
                <SelectItem value="x-api-key">x-api-key</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="byok-custom-model-id" className="text-sm">
              Model ID
            </Label>
            <Input
              id="byok-custom-model-id"
              value={customModelId}
              placeholder={
                customApi === "anthropic-messages"
                  ? "claude-sonnet-5"
                  : "gpt-4o"
              }
              onChange={(event) => onCustomModelIdChange?.(event.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="byok-custom-api" className="text-sm">
              API mode
            </Label>
            <Select
              value={customApi}
              onValueChange={(value) =>
                onCustomApiChange?.(
                  value as
                    | "openai-completions"
                    | "openai-responses"
                    | "anthropic-messages",
                )
              }
            >
              <SelectTrigger id="byok-custom-api" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-completions">Chat Completions</SelectItem>
                <SelectItem value="openai-responses">Responses</SelectItem>
                <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="byok-api-key" className="text-sm">
          {provider.fieldLabel}
        </Label>
        <Input
          id="byok-api-key"
          type="password"
          autoComplete="off"
          autoFocus={autoFocusApiKey}
          value={apiKey}
          placeholder={apiKeyPlaceholderOverride ?? provider.placeholder}
          aria-invalid={errorMessage ? true : undefined}
          onChange={(event) => onApiKeyChange(event.target.value)}
          className="font-mono text-sm"
        />

        {provider.requiresRegion ? (
          <div className="space-y-2 pt-2">
            <Label htmlFor="byok-aws-region" className="text-sm">
              AWS Region
            </Label>
            <Select value={awsRegion} onValueChange={onAwsRegionChange}>
              <SelectTrigger id="byok-aws-region" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AWS_REGIONS.map((region) => (
                  <SelectItem key={region.value} value={region.value}>
                    {region.label} ({region.value})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {errorMessage ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {footer ?? (
        <div className="flex justify-end">
          <Button type="submit" disabled={disabled}>
            {isSubmitting ? (submittingLabel ?? "Saving…") : submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
