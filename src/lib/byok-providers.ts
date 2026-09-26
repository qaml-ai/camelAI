import type { LlmProvider } from "@/types";

export type OnboardingByokProvider = Extract<
  LlmProvider,
  "anthropic" | "bedrock" | "custom" | "openai" | "openrouter" | "requesty"
>;

export interface ByokProviderMeta {
  value: OnboardingByokProvider;
  label: string;
  fieldLabel: string;
  placeholder: string;
  getKeyUrl?: string;
  getKeyLinkLabel?: string;
  settingsLinkLabel?: string;
  requiresRegion: boolean;
  description: string;
  steps?: string[];
  enterpriseNote?: string;
  warning: {
    title: string;
    body: string;
    helpUrl?: string;
    helpLinkLabel?: string;
  };
}

export const BYOK_PROVIDERS: Record<OnboardingByokProvider, ByokProviderMeta> =
  {
    openrouter: {
      value: "openrouter",
      label: "OpenRouter",
      fieldLabel: "OpenRouter API key",
      placeholder: "sk-or-v1...",
      getKeyUrl: "https://openrouter.ai/settings/keys",
      getKeyLinkLabel: "Get a key",
      settingsLinkLabel: "Open OpenRouter API settings",
      requiresRegion: false,
      description:
        "OpenRouter gives you access to Claude, GPT, Gemini, Grok, and many open-source models through a single key.",
      steps: [
        "Create an OpenRouter account",
        "Load credits onto your account",
        "Generate an API key",
      ],
      warning: {
        title: "Your API key needs credits to work",
        body: "OpenRouter lets you generate a key without adding a payment method, but it won't process messages until you add a card and purchase credits.",
      },
    },
    requesty: {
      value: "requesty",
      label: "Requesty",
      fieldLabel: "Requesty API key",
      placeholder: "rqsty-...",
      getKeyUrl: "https://app.requesty.ai/api-keys",
      getKeyLinkLabel: "Get a key",
      settingsLinkLabel: "Open Requesty API settings",
      requiresRegion: false,
      description:
        "Requesty is an LLM gateway that gives you access to Claude, GPT, Gemini, Grok, and many open-source models through a single key.",
      steps: [
        "Create a Requesty account",
        "Load credits onto your account",
        "Generate an API key",
      ],
      warning: {
        title: "Your API key needs credits to work",
        body: "Requesty lets you generate a key before adding a payment method, but it won't process messages until your account has credits.",
      },
    },
    anthropic: {
      value: "anthropic",
      label: "Anthropic",
      fieldLabel: "Anthropic API key",
      placeholder: "sk-ant-...",
      getKeyUrl: "https://console.anthropic.com/settings/keys",
      getKeyLinkLabel: "Get a key",
      settingsLinkLabel: "Open Anthropic API settings",
      requiresRegion: false,
      description:
        "Anthropic gives you direct access to the Claude family — Sonnet, Opus, and Haiku.",
      steps: [
        "Create an Anthropic Console account",
        "Add a payment method and load credits",
        "Generate an API key",
      ],
      warning: {
        title: "Your API key needs credits to work",
        body: "Anthropic lets you generate a key without adding a payment method, but it won't process messages until you load credits in the Console.",
      },
    },
    openai: {
      value: "openai",
      label: "OpenAI",
      fieldLabel: "OpenAI API key",
      placeholder: "sk-...",
      getKeyUrl: "https://platform.openai.com/api-keys",
      getKeyLinkLabel: "Get a key",
      settingsLinkLabel: "Open OpenAI API settings",
      requiresRegion: false,
      description:
        "OpenAI gives you direct access to GPT and Codex models from the makers of ChatGPT.",
      steps: [
        "Create an OpenAI Platform account",
        "Add a payment method and load credits",
        "Generate an API key",
      ],
      warning: {
        title: "Your API key needs credits to work",
        body: "OpenAI lets you generate a key without adding a payment method, but it won't process messages until you load credits on the Platform.",
      },
    },
    bedrock: {
      value: "bedrock",
      label: "Bedrock",
      fieldLabel: "Bedrock API key",
      placeholder: "Enter your AWS Bedrock API key",
      getKeyUrl: "https://console.aws.amazon.com/bedrock/",
      getKeyLinkLabel: "Open the AWS Bedrock console",
      settingsLinkLabel: "Open the AWS Bedrock console",
      requiresRegion: true,
      description:
        "Bedrock runs Claude plus supported GPT models inside your own AWS account, billed through your existing AWS bill.",
      enterpriseNote:
        "Best suited for teams already using AWS. Setting up Bedrock involves an AWS account, IAM permissions, and granting model access in the region you'll use. Claude Fable 5 requires Bedrock Mantle data retention mode provider_data_share at the account or project level. GPT-5.6 Sol and Terra use Bedrock's bedrock-mantle Responses endpoint and have narrower regional availability than Claude.",
      warning: {
        title: "Bedrock requires model access",
        body: "AWS will bill usage on your account automatically, but your key won't return responses until you request model access in the Bedrock console for the region you select below. Claude Fable 5 also requires an AWS admin to grant bedrock-mantle:PutAccountDataRetention and set Bedrock Mantle data retention to provider_data_share with PUT https://bedrock-mantle.<region>.api.aws/v1/data_retention, or on a Bedrock Mantle project with POST https://bedrock-mantle.<region>.api.aws/v1/organization/projects/{project_id}. GPT-5.6 Sol is available in us-east-1/us-east-2; GPT-5.6 Terra is available in us-east-1/us-east-2/us-west-2.",
        helpUrl:
          "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html",
        helpLinkLabel: "Open AWS data retention docs",
      },
    },
    custom: {
      value: "custom",
      label: "Custom",
      fieldLabel: "API key",
      placeholder: "Enter an API key",
      requiresRegion: false,
      description:
        "Connect any OpenAI-compatible or Anthropic-compatible provider endpoint supported by Pi.",
      warning: {
        title: "Use a provider endpoint that supports agent traffic",
        body: "The endpoint must support streaming and tool calls for the API mode you choose below.",
      },
    },
  };

export const BYOK_PROVIDER_ORDER: OnboardingByokProvider[] = [
  "openrouter",
  "anthropic",
  "openai",
  "bedrock",
  "requesty",
  "custom",
];

export function getByokProviderLabel(
  provider: string | null | undefined,
): string | null {
  if (!provider || !(provider in BYOK_PROVIDERS)) {
    return null;
  }
  return BYOK_PROVIDERS[provider as OnboardingByokProvider].label;
}

export function parseByokProvider(
  provider: unknown,
): OnboardingByokProvider | null {
  if (typeof provider !== "string" || !(provider in BYOK_PROVIDERS)) {
    return null;
  }
  return provider as OnboardingByokProvider;
}

export const AWS_REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia)" },
  { value: "us-east-2", label: "US East (Ohio)" },
  { value: "us-west-2", label: "US West (Oregon)" },
  { value: "us-gov-west-1", label: "AWS GovCloud (US-West)" },
  { value: "eu-west-1", label: "EU (Ireland)" },
  { value: "eu-west-2", label: "EU (London)" },
  { value: "eu-west-3", label: "EU (Paris)" },
  { value: "eu-central-1", label: "EU (Frankfurt)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
  { value: "sa-east-1", label: "South America (Sao Paulo)" },
  { value: "ca-central-1", label: "Canada (Central)" },
] as const;
