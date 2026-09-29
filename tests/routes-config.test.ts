import { describe, it, expect } from 'vitest';
import routes from '@/routes';

type RouteNode = {
  path?: string;
  file?: string;
  index?: boolean;
  children?: RouteNode[];
};

function findRouteByPath(
  nodes: RouteNode[],
  path: string,
  parent?: RouteNode
): { node: RouteNode; parent?: RouteNode } | null {
  for (const node of nodes) {
    if (node.path === path) {
      return { node, parent };
    }
    if (node.children?.length) {
      const found = findRouteByPath(node.children, path, node);
      if (found) return found;
    }
  }
  return null;
}

describe('route config', () => {
  it('wraps invitation route in the invite layout', () => {
    const inviteRoute = findRouteByPath(
      routes as RouteNode[],
      'invitations/:orgId/:invitationId'
    );

    expect(inviteRoute).not.toBeNull();
    expect(inviteRoute?.parent?.file).toBe('routes/_invite.tsx');
  });

  it('registers invitation API routes', () => {
    const orgInviteRoute = findRouteByPath(
      routes as RouteNode[],
      'api/orgs/:id/invite'
    );
    const invitationRoute = findRouteByPath(
      routes as RouteNode[],
      'api/invitations/:orgId/:invitationId'
    );
    const helpRoute = findRouteByPath(
      routes as RouteNode[],
      'api/help'
    );
    const devSentEmailsRoute = findRouteByPath(
      routes as RouteNode[],
      'api/dev/sent-emails'
    );
    const devSentEmailByIdRoute = findRouteByPath(
      routes as RouteNode[],
      'api/dev/sent-emails/:id'
    );
    const billingStartSubscriptionRoute = findRouteByPath(
      routes as RouteNode[],
      'api/billing/start-subscription'
    );

    expect(orgInviteRoute).not.toBeNull();
    expect(invitationRoute).not.toBeNull();
    expect(helpRoute).not.toBeNull();
    expect(devSentEmailsRoute).not.toBeNull();
    expect(devSentEmailByIdRoute).not.toBeNull();
    expect(billingStartSubscriptionRoute).not.toBeNull();
  });
});
