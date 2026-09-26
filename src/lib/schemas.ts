import { z } from 'zod';
import { inviteEmailSchema, MAX_INVITE_EMAILS } from '@/lib/invite-emails';

// Profile - form fields only (for client-side validation)
export const profileFormSchema = z.object({
  name: z.string().max(100, 'Name must be 100 characters or less').optional(),
  avatarColor: z.string().optional(),
  avatarContent: z.string().optional(),
});

// Profile - full submission (for server-side validation)
export const profileSchema = profileFormSchema.extend({
  intent: z.literal('updateProfile'),
});

// Organization - form fields only
export const orgNameFormSchema = z.object({
  name: z.string().min(1, 'Organization name is required').max(100, 'Organization name must be 100 characters or less'),
});

// Organization - full submission
export const orgNameSchema = orgNameFormSchema.extend({
  intent: z.literal('updateOrgName'),
});

// Workspace - form fields only
export const workspaceFormSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100, 'Workspace name must be 100 characters or less'),
  description: z.string().max(200, 'Description must be 200 characters or less').optional(),
  avatarColor: z.string().optional(),
  avatarContent: z.string().optional(),
});

// Workspace - full submission
export const workspaceSchema = workspaceFormSchema.extend({
  intent: z.literal('updateWorkspace'),
});

// Create workspace - form fields only
export const createWorkspaceFormSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100, 'Workspace name must be 100 characters or less'),
  description: z.string().max(200, 'Description must be 200 characters or less').optional(),
});

// Create org - form fields only
export const createOrgFormSchema = z.object({
  name: z.string().min(1, 'Organization name is required').max(100, 'Organization name must be 100 characters or less'),
});

// Invite member - form fields only
export const inviteMemberFormSchema = z.object({
  emails: z.array(inviteEmailSchema).min(1, 'At least one email is required').max(MAX_INVITE_EMAILS, `Invite up to ${MAX_INVITE_EMAILS} people at a time`),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});
