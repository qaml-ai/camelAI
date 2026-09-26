import type { BillingStatus, Organization } from "@/types";

export function isBillingActive(
  status: BillingStatus | null | undefined,
): boolean {
  return (
    status === "trialing" || status === "active" || status === "enterprise"
  );
}

export function canUsePaidWorkspace(
  status: BillingStatus | null | undefined,
): boolean {
  return isBillingActive(status);
}

export function billingStatusLabel(
  status: BillingStatus | null | undefined,
): string {
  switch (status) {
    case "trialing":
      return "Trial";
    case "active":
      return "Active";
    case "enterprise":
      return "Enterprise";
    case "past_due":
      return "Past due";
    case "canceled":
      return "Canceled";
    case "inactive":
    default:
      return "Free";
  }
}

export function billingStatusBadgeVariant(
  status: BillingStatus | null | undefined,
): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "trialing":
    case "active":
    case "enterprise":
      return "default";
    case "past_due":
      return "destructive";
    case "canceled":
      return "outline";
    case "inactive":
    default:
      return "secondary";
  }
}

export function formatCreditAmount(
  credits: number,
  options: {
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  } = {},
): string {
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: options.minimumFractionDigits ?? 2,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  });
  return `${formatter.format(credits)} credits`;
}

export function formatCreditBalance(cents: number): string {
  return formatCreditAmount(cents / 100);
}

export function formatCreditsFromUsd(
  usd: number,
  maximumFractionDigits = 4,
): string {
  return formatCreditAmount(usd, {
    minimumFractionDigits: maximumFractionDigits,
    maximumFractionDigits,
  });
}

export function formatUsdFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function getBillingStatusDescription(
  org: Pick<Organization, "billing_status">,
): string {
  switch (org.billing_status) {
    case "trialing":
      return "Your subscription is active with capped included credits.";
    case "active":
      return "Your subscription is active with included credits.";
    case "enterprise":
      return "Your organization is billed outside Stripe and does not need a subscription or credits.";
    case "past_due":
      return "Your payment is past due. Fix it to restore premium models.";
    case "canceled":
      return "Your subscription was canceled.";
    case "inactive":
    default:
      return "Pay as you go uses prepaid credits or your own API key.";
  }
}
