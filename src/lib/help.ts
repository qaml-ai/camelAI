import { z } from 'zod';

export const SUPPORT_EMAIL = 'support@camelai.com';
export const HELP_DESCRIPTION_MAX_LENGTH = 4000;
export const HELP_PAGE_URL_MAX_LENGTH = 2048;
export const HELP_SCREEN_SIZE_MAX_LENGTH = 64;

export const HELP_CATEGORY_VALUES = [
  'bug',
  'feature',
  'question',
  'billing',
  'other',
] as const;

export const HELP_SEVERITY_VALUES = ['low', 'medium', 'high'] as const;

export type HelpCategory = (typeof HELP_CATEGORY_VALUES)[number];
export type HelpSeverity = (typeof HELP_SEVERITY_VALUES)[number];

export const HELP_CATEGORY_LABELS: Record<HelpCategory, string> = {
  bug: 'Bug report',
  feature: 'Feature request',
  question: 'Question',
  billing: 'Account & billing',
  other: 'Other',
};

export const HELP_CATEGORY_SUBJECT_LABELS: Record<HelpCategory, string> = {
  bug: 'Bug',
  feature: 'Feature',
  question: 'Question',
  billing: 'Billing',
  other: 'Other',
};

export const HELP_SEVERITY_LABELS: Record<HelpSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).trimEnd();
}

export function normalizeHelpDescription(value: string): string {
  return truncateText(value.trim(), HELP_DESCRIPTION_MAX_LENGTH);
}

export const getHelpFormSchema = z.object({
  category: z.enum(HELP_CATEGORY_VALUES),
  severity: z.enum(HELP_SEVERITY_VALUES).default('low'),
  description: z
    .string()
    .trim()
    .min(1, 'Please describe your issue')
    .max(
      HELP_DESCRIPTION_MAX_LENGTH,
      `Description must be ${HELP_DESCRIPTION_MAX_LENGTH} characters or less`
    ),
  pageUrl: z
    .string()
    .trim()
    .max(
      HELP_PAGE_URL_MAX_LENGTH,
      `Page URL must be ${HELP_PAGE_URL_MAX_LENGTH} characters or less`
    )
    .optional(),
  screenSize: z
    .string()
    .trim()
    .max(
      HELP_SCREEN_SIZE_MAX_LENGTH,
      `Screen size must be ${HELP_SCREEN_SIZE_MAX_LENGTH} characters or less`
    )
    .optional(),
});
