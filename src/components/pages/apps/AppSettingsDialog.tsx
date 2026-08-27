'use client';

import { useLayoutEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import type { AppCreator, WorkerScriptWithCreator } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { AlertCircle, ExternalLink, Trash2 } from 'lucide-react';
import { type AppUrlInput, getPreferredAppUrl } from '@/lib/app-url';
import { getContrastTextColor } from '@/lib/avatar';
import { buildSetAppPublicPayload } from '@/lib/app-visibility';

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: WorkerScriptWithCreator;
  orgSlug: string;
  isAdmin: boolean;
  hostname?: AppUrlInput;
  orgCustomDomain?: string | null;
  onSuccess: () => void;
}

type PendingAppAction = 'save' | 'delete' | null;

interface AppSettingsDialogState {
  isPublic: boolean;
  error: string | null;
  confirmDeleteOpen: boolean;
  pendingAction: PendingAppAction;
}

function getInitialDialogState(app: WorkerScriptWithCreator): AppSettingsDialogState {
  return {
    isPublic: app.is_public,
    error: null,
    confirmDeleteOpen: false,
    pendingAction: null,
  };
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function getCreatorLabel(creator: AppCreator | undefined, createdBy: string): string {
  const trimmedName = creator?.name?.trim();
  if (trimmedName) return trimmedName;
  const trimmedEmail = creator?.email?.trim();
  if (trimmedEmail) return trimmedEmail;
  if (createdBy?.startsWith('system')) return 'System';
  return 'Unknown';
}

function getInitials(label: string): string {
  const parts = label.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase() || '?';
}

export function AppSettingsDialog({
  open,
  onOpenChange,
  app,
  orgSlug,
  isAdmin,
  hostname,
  orgCustomDomain,
  onSuccess,
}: AppSettingsDialogProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [dialogState, setDialogState] = useState(() => getInitialDialogState(app));
  const { isPublic, error, confirmDeleteOpen, pendingAction } = dialogState;
  const submitting = fetcher.state !== 'idle' && pendingAction === 'save';
  const deleting = fetcher.state !== 'idle' && pendingAction === 'delete';

  const appUrl = getPreferredAppUrl(app, { hostname, orgSlug, orgCustomDomain });
  const creator = app.creator;
  const creatorLabel = getCreatorLabel(creator, app.created_by);
  const creatorAvatar = creator?.avatar ?? null;
  const creatorContent = creatorAvatar?.content ?? getInitials(creatorLabel);
  const creatorFallbackStyle = creatorAvatar?.color
    ? {
        backgroundColor: creatorAvatar.color,
        color: getContrastTextColor(creatorAvatar.color),
      }
    : undefined;

  useLayoutEffect(() => {
    setDialogState(getInitialDialogState(app));
  }, [app]);

  useLayoutEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data && pendingAction) {
      if (fetcher.data.success) {
        onSuccess();
        handleClose();
      } else if (fetcher.data.error) {
        setDialogState((prev) => ({
          ...prev,
          error: fetcher.data?.error ?? null,
          pendingAction: null,
        }));
      } else {
        setDialogState((prev) => ({ ...prev, pendingAction: null }));
      }
    }
  }, [fetcher.state, fetcher.data, pendingAction, onSuccess]);

  const handleClose = () => {
    setDialogState(getInitialDialogState(app));
    onOpenChange(false);
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      handleClose();
    }
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    setDialogState((prev) => ({ ...prev, error: null }));

    if (isPublic === app.is_public) {
      onSuccess();
      handleClose();
      return;
    }

    setDialogState((prev) => ({ ...prev, pendingAction: 'save' }));
    fetcher.submit(
      buildSetAppPublicPayload({
        scriptName: app.script_name,
        isPublic,
      }),
      { method: 'POST', action: '/apps' }
    );
  };

  const handleDelete = () => {
    setDialogState((prev) => ({ ...prev, error: null, pendingAction: 'delete' }));
    fetcher.submit(
      {
        intent: 'deleteApp',
        scriptName: app.script_name,
      },
      { method: 'POST', action: '/apps' }
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>App Settings</DialogTitle>
            <DialogDescription>
              Manage settings for {app.script_name}.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSave}>
            <div className="grid gap-5 py-2">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-3">
                <p className="text-sm font-medium">Info</p>
                <div className="grid gap-4 rounded-lg border p-4 text-sm">
                  <div className="grid gap-1.5">
                    <Label className="text-muted-foreground">URL</Label>
                    <a
                      href={appUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-primary hover:underline"
                    >
                      {appUrl}
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-muted-foreground">Created</Label>
                    <p>{formatDate(app.created_at)}</p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-muted-foreground">Last Updated</Label>
                    <p>{formatDate(app.updated_at)}</p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-muted-foreground">Created By</Label>
                    <div className="flex items-center gap-2">
                      <Avatar size="sm">
                        <AvatarFallback
                          content={creatorContent}
                          style={creatorFallbackStyle}
                        >
                          {creatorContent}
                        </AvatarFallback>
                      </Avatar>
                      <span>{creatorLabel}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-sm font-medium">Access</p>
                <div className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <Label htmlFor="public-access">Public Access</Label>
                      <p className="text-sm text-muted-foreground">
                        {isPublic
                          ? 'Anyone on the internet can view this app.'
                          : 'Only members of this workspace can access this app.'}
                        {!isAdmin ? ' Only admins can change visibility.' : ''}
                      </p>
                    </div>
                    <Switch
                      id="public-access"
                      checked={isPublic}
                      onCheckedChange={(nextIsPublic) =>
                        setDialogState((prev) => ({
                          ...prev,
                          isPublic: nextIsPublic,
                        }))
                      }
                      disabled={!isAdmin || submitting}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-sm font-medium text-destructive">Danger Zone</p>
                <div className="grid gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Delete App</p>
                    <p className="text-sm text-muted-foreground">
                      Permanently delete this app and its deployment. This action cannot be undone.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="w-fit"
                    onClick={() =>
                      setDialogState((prev) => ({
                        ...prev,
                        confirmDeleteOpen: true,
                      }))
                    }
                    disabled={!isAdmin || deleting}
                  >
                    <Trash2 className="size-3.5" />
                    Delete App
                  </Button>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!isAdmin || submitting}>
                {submitting ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={(nextOpen) =>
          setDialogState((prev) => ({
            ...prev,
            confirmDeleteOpen: nextOpen,
          }))
        }
        title="Delete app?"
        description={`This will permanently remove the deployment at ${appUrl}. Any existing links to this URL will stop working. You can redeploy the app later, but it will be treated as a new deployment.`}
        confirmLabel="Delete App"
        variant="destructive"
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </>
  );
}
