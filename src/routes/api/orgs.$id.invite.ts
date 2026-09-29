import type { Route } from './+types/orgs.$id.invite';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import { getSession } from '@/lib/auth.server';
import {
  createInvitations,
  getInvitation,
  isOrgAdmin,
} from '@/lib/auth-do';
import { inviteEmailSchema } from '@/lib/invite-emails';
import { z } from 'zod';
import {
  buildInvitationUrl,
  resolveAppBaseUrl,
  sendOrgInvitationEmail,
} from '@/lib/email.server';
import { requireAccessMappedOrg } from '@/lib/cloudflare-access-auth.server';
import { actionOnlyLoader } from '@/lib/method-not-allowed';

const legacyInviteMemberFormSchema = z.object({
  email: inviteEmailSchema,
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

function isSeatCapacityError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message.startsWith('Your current billing plan includes ')
  );
}

export const loader = actionOnlyLoader('POST', 'DELETE');

export async function action({ request, context, params }: Route.ActionArgs) {
  const orgId = params.id;
  if (!orgId) {
    return Response.json({ error: 'Organization ID is required' }, { status: 400 });
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const sessionContext = await getSession(request, context);
  if (!sessionContext) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const session = sessionContext.session;
  const mappedOrgError = await requireAccessMappedOrg(
    request,
    env,
    session,
    orgId,
  );
  if (mappedOrgError) return mappedOrgError;

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const parsed = legacyInviteMemberFormSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: 'Valid email and role are required' }, { status: 400 });
      }

      const isAdmin = await isOrgAdmin(authEnv, session.user_id, orgId);
      if (!isAdmin) {
        return Response.json({ error: 'Insufficient permissions' }, { status: 403 });
      }

      const email = parsed.data.email.toLowerCase().trim();
      const role = parsed.data.role;

      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      const existingInvitation = await orgStub.getInvitationByEmail(email);
      if (existingInvitation) {
        return Response.json(
          { error: `An active invitation already exists for ${email}` },
          { status: 409 },
        );
      }

      const org = await orgStub.getInfo();
      if (!org) {
        return Response.json({ error: 'Organization not found' }, { status: 404 });
      }
      const invitation = (await createInvitations(
        authEnv,
        orgId,
        [email],
        role,
        session.user_id,
      ))[0];
      const inviter = await authEnv.USER.get(
        authEnv.USER.idFromName(session.user_id)
      ).getProfile();

      const baseUrl = resolveAppBaseUrl(env, new URL(request.url));
      const invitationUrl = buildInvitationUrl(baseUrl, orgId, invitation.id);
      const emailDelivery = await sendOrgInvitationEmail({
        env,
        to: email,
        orgName: org?.name ?? 'your organization',
        inviterName: inviter?.name ?? inviter?.email ?? null,
        role,
        invitationUrl,
        expiresAt: invitation.expires_at,
      });

      return Response.json({
        id: invitation.id,
        email,
        role,
        expires_at: invitation.expires_at,
        invitation_url: invitationUrl,
        email_delivery: emailDelivery.status,
        email_delivery_reason: emailDelivery.reason ?? null,
      });
    } catch (error) {
      console.error('Create invitation error:', error);
      if (isSeatCapacityError(error)) {
        return Response.json(
          {
            error: 'insufficient_paid_seats',
            message: error.message,
          },
          { status: 409 },
        );
      }
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to create invitation',
        },
        { status: 500 },
      );
    }
  }

  if (request.method === 'DELETE') {
    try {
      const body = await request.json().catch(() => null);
      const invitationId =
        body && typeof body === 'object'
          ? (body as { invitation_id?: string }).invitation_id
          : undefined;

      if (!invitationId) {
        return Response.json({ error: 'Invitation ID is required' }, { status: 400 });
      }

      const invitation = await getInvitation(authEnv, orgId, invitationId);
      if (!invitation) {
        return Response.json({ error: 'Invitation not found' }, { status: 404 });
      }

      const user = await authEnv.USER.get(
        authEnv.USER.idFromName(session.user_id)
      ).getProfile();
      if (!user) {
        return Response.json({ error: 'Not authenticated' }, { status: 401 });
      }

      const isAdmin = await isOrgAdmin(authEnv, session.user_id, orgId);
      const isInvitee = user.email.toLowerCase() === invitation.email.toLowerCase();
      if (!isAdmin && !isInvitee) {
        return Response.json({ error: 'Insufficient permissions' }, { status: 403 });
      }

      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      await orgStub.deleteInvitation(invitationId);

      return Response.json({ success: true });
    } catch (error) {
      console.error('Delete invitation error:', error);
      return Response.json({ error: 'Failed to delete invitation' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
