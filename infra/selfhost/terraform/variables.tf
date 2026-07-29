variable "aws_region" {
  description = "AWS region for the EC2 instance and supporting resources."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for the single-node installation."
  type        = string
  default     = "camelai-selfhost"
}

variable "vpc_id" {
  description = "VPC for the instance. Leave blank to use the account's default VPC."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Public subnet for the instance. Leave blank to select a subnet in the chosen/default VPC."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type. Four vCPUs and 8 GiB RAM are the supported minimum."
  type        = string
  default     = "t3a.xlarge"
}

variable "root_volume_size_gb" {
  description = "Size of the disposable encrypted root EBS volume."
  type        = number
  default     = 30
}

variable "data_volume_size_gb" {
  description = "Size of the encrypted persistent EBS volume holding Docker state, the checkout, and backups."
  type        = number
  default     = 100
}

variable "ebs_kms_key_id" {
  description = "Optional KMS key ARN/id for EBS encryption. The AWS-managed EBS key is used when blank."
  type        = string
  default     = ""
}

variable "repository_url" {
  description = "Git repository containing camelAI and docker-compose.selfhost.yml. It must be readable by the instance."
  type        = string
  default     = "https://github.com/qaml-ai/camelAI.git"
}

variable "repository_ref" {
  description = "Pinned camelAI tag or commit SHA to install. A moving branch is allowed for evaluation but is not recommended for production."
  type        = string
}

variable "app_image" {
  description = "Immutable ghcr.io/qaml-ai/camelai-selfhost-app release image reference. Digest-pinned references are recommended."
  type        = string
  validation {
    condition     = var.app_image != "" && !endswith(lower(var.app_image), ":latest")
    error_message = "app_image must be a non-latest release tag or digest."
  }
}

variable "local_artifacts_image" {
  description = "Immutable ghcr.io/qaml-ai/camelai-selfhost-local-artifacts release image reference."
  type        = string
  validation {
    condition     = var.local_artifacts_image != "" && !endswith(lower(var.local_artifacts_image), ":latest")
    error_message = "local_artifacts_image must be a non-latest release tag or digest."
  }
}

variable "project_build_image" {
  description = "Immutable ghcr.io/qaml-ai/camelai-selfhost-project-build release image reference."
  type        = string
  validation {
    condition     = var.project_build_image != "" && !endswith(lower(var.project_build_image), ":latest")
    error_message = "project_build_image must be a non-latest release tag or digest."
  }
}

variable "analysis_image" {
  description = "Immutable ghcr.io/qaml-ai/camelai-selfhost-analysis release image reference."
  type        = string
  validation {
    condition     = var.analysis_image != "" && !endswith(lower(var.analysis_image), ":latest")
    error_message = "analysis_image must be a non-latest release tag or digest."
  }
}

variable "db_query_image" {
  description = "Immutable ghcr.io/qaml-ai/camelai-selfhost-db-query release image reference."
  type        = string
  validation {
    condition     = var.db_query_image != "" && !endswith(lower(var.db_query_image), ":latest")
    error_message = "db_query_image must be a non-latest release tag or digest."
  }
}

variable "container_egress_image" {
  description = "Immutable ghcr.io/qaml-ai/camelai-selfhost-container-egress release image reference."
  type        = string
  validation {
    condition     = var.container_egress_image != "" && !endswith(lower(var.container_egress_image), ":latest")
    error_message = "container_egress_image must be a non-latest release tag or digest."
  }
}

variable "caddy_image" {
  description = "Immutable ghcr.io/qaml-ai/camelai-selfhost-caddy image with Cloudflare and Route53 DNS modules."
  type        = string
  validation {
    condition     = var.caddy_image != "" && !endswith(lower(var.caddy_image), ":latest")
    error_message = "caddy_image must be a non-latest release tag or digest."
  }
}

variable "main_hostname" {
  description = "Public camelAI hostname without scheme, for example camel.example.com."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", lower(var.main_hostname)))
    error_message = "main_hostname must be a DNS hostname without a scheme or path."
  }
}

variable "app_vanity_domain" {
  description = "Wildcard app domain root without '*.', for example apps.example.com."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", lower(var.app_vanity_domain)))
    error_message = "app_vanity_domain must be a DNS hostname without '*.', scheme, or path."
  }
}

variable "app_iframe_domain" {
  description = "Optional separate iframe domain root. Defaults to app_vanity_domain."
  type        = string
  default     = ""
}

variable "tls_mode" {
  description = "automatic obtains and renews a wildcard certificate through Route53 DNS; provided reads PEM secrets; external exposes an HTTP origin to a trusted TLS proxy."
  type        = string
  default     = "automatic"
  validation {
    condition     = contains(["automatic", "provided", "external"], var.tls_mode)
    error_message = "tls_mode must be automatic, provided, or external."
  }
}

variable "tls_certificate_secret_arn" {
  description = "Secrets Manager ARN whose SecretString is a PEM certificate chain covering main_hostname and *.app_vanity_domain."
  type        = string
  default     = ""
}

variable "tls_private_key_secret_arn" {
  description = "Secrets Manager ARN whose SecretString is the matching PEM private key."
  type        = string
  default     = ""
}

variable "web_ingress_cidrs" {
  description = "CIDRs allowed to reach Caddy. Restrict these to the trusted upstream proxy when tls_mode=external."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_ingress_cidrs" {
  description = "Optional CIDRs allowed to reach SSH. Prefer SSM Session Manager and leave this empty."
  type        = list(string)
  default     = []
}

variable "ssh_key_name" {
  description = "Optional existing EC2 key pair name. Not needed for SSM Session Manager."
  type        = string
  default     = ""
}

variable "create_route53_records" {
  description = "Create A records for main_hostname and *.app_vanity_domain pointing to the instance Elastic IP."
  type        = bool
  default     = false
}

variable "route53_zone_id" {
  description = "Route53 public hosted zone id used for automatic DNS-01 TLS and optional DNS records."
  type        = string
  default     = ""
}

variable "auth_provider" {
  description = "Authentication mode. bundled-pomerium is the turnkey default; pomerium and cloudflare-access use an operator-managed identity proxy."
  type        = string
  default     = "bundled-pomerium"
  validation {
    condition     = contains(["bundled-pomerium", "pomerium", "cloudflare-access"], var.auth_provider)
    error_message = "auth_provider must be bundled-pomerium, pomerium, or cloudflare-access."
  }
}

variable "auth_default_org_name" {
  description = "Organization created for authenticated users when no group mapping is configured."
  type        = string
}

variable "cloudflare_access_team_domain" {
  description = "Cloudflare Access team domain, including https://."
  type        = string
  default     = ""
}

variable "cloudflare_access_aud" {
  description = "Cloudflare Access application audience."
  type        = string
  default     = ""
}

variable "pomerium_authenticate_url" {
  description = "Pomerium authenticate service URL, including https://."
  type        = string
  default     = ""
}

variable "pomerium_authenticate_hostname" {
  description = "Pomerium authenticate hostname without scheme. Required for bundled Pomerium and must match pomerium_authenticate_url."
  type        = string
  default     = ""
  validation {
    condition = var.pomerium_authenticate_hostname == "" || can(
      regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", lower(var.pomerium_authenticate_hostname))
    )
    error_message = "pomerium_authenticate_hostname must be a DNS hostname without a scheme or path."
  }
}

variable "pomerium_image" {
  description = "Immutable Pomerium Core image reference used by the bundled mode."
  type        = string
  default     = "pomerium/pomerium@sha256:aae6010af6ba4c864bbd3f748cf37843a140b1ddef74d7d2ac1aa87660f8da1f"
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.pomerium_image))
    error_message = "pomerium_image must be pinned by sha256 digest."
  }
}

variable "pomerium_jwks_url" {
  description = "Optional explicit Pomerium JWKS URL."
  type        = string
  default     = ""
}

variable "pomerium_idp_provider" {
  description = "Pomerium identity provider type. Use oidc for a generic OpenID Connect provider."
  type        = string
  default     = "oidc"
}

variable "pomerium_idp_provider_url" {
  description = "OIDC issuer URL used by bundled Pomerium."
  type        = string
  default     = ""
}

variable "pomerium_idp_client_id" {
  description = "OIDC client id used by bundled Pomerium."
  type        = string
  default     = ""
}

variable "pomerium_idp_client_secret_arn" {
  description = "Secrets Manager ARN whose SecretString is the OIDC client secret used by bundled Pomerium."
  type        = string
  default     = ""
}

variable "pomerium_issuer" {
  description = "Expected Pomerium assertion issuer."
  type        = string
  default     = ""
}

variable "pomerium_audience" {
  description = "Expected Pomerium assertion audience."
  type        = string
  default     = ""
}

variable "selfhost_ai_provider" {
  description = "Key-backed AI provider: bedrock, anthropic, openai, openrouter, or custom."
  type        = string
  default     = "bedrock"
  validation {
    condition     = contains(["bedrock", "anthropic", "openai", "openrouter", "custom"], var.selfhost_ai_provider)
    error_message = "selfhost_ai_provider must be bedrock, anthropic, openai, openrouter, or custom."
  }
}

variable "selfhost_ai_api_key_secret_arn" {
  description = "Secrets Manager ARN whose SecretString is the provider API key. Bedrock also requires an API key; EC2 instance-profile SigV4 is not used."
  type        = string
}

variable "selfhost_ai_aws_region" {
  description = "Bedrock region used by the Bedrock Mantle compatibility API."
  type        = string
  default     = "us-east-1"
}

variable "selfhost_ai_base_url" {
  description = "Base URL for SELFHOST_AI_PROVIDER=custom."
  type        = string
  default     = ""
}

variable "selfhost_ai_model" {
  description = "Model id for SELFHOST_AI_PROVIDER=custom."
  type        = string
  default     = ""
}

variable "selfhost_ai_name" {
  description = "Display name for SELFHOST_AI_PROVIDER=custom."
  type        = string
  default     = ""
}

variable "selfhost_ai_api" {
  description = "Custom provider API protocol."
  type        = string
  default     = "openai-completions"
  validation {
    condition     = contains(["openai-completions", "openai-responses", "anthropic-messages"], var.selfhost_ai_api)
    error_message = "selfhost_ai_api must be openai-completions, openai-responses, or anthropic-messages."
  }
}

variable "selfhost_ai_auth_type" {
  description = "Custom provider auth header style."
  type        = string
  default     = "bearer"
  validation {
    condition     = contains(["bearer", "x-api-key"], var.selfhost_ai_auth_type)
    error_message = "selfhost_ai_auth_type must be bearer or x-api-key."
  }
}

variable "tags" {
  description = "Additional AWS resource tags."
  type        = map(string)
  default     = {}
}
