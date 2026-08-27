'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppCreator, WorkerScriptWithCreator, WorkspaceWithAccess } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { type AppUrlInput, getPreferredAppUrl } from '@/lib/app-url';
import { getContrastTextColor } from '@/lib/avatar';
import {
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileCode,
  Globe,
  Image,
  Lock,
  Settings,
} from 'lucide-react';

interface AppCardProps {
  app: WorkerScriptWithCreator;
  creator?: AppCreator;
  workspace?: WorkspaceWithAccess | null;
  showWorkspaceBadge?: boolean;
  isAdmin: boolean;
  hostname?: AppUrlInput;
  orgSlug: string;
  orgCustomDomain?: string | null;
  now?: number;
  onOpenSettings: (app: WorkerScriptWithCreator) => void;
  onStartChat: (app: WorkerScriptWithCreator) => void;
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

function getRelativeTime(timestamp: number, referenceTime?: number): string {
  const now = referenceTime ?? Date.now();
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export function AppCard({
  app,
  creator: creatorOverride,
  workspace,
  showWorkspaceBadge,
  isAdmin,
  hostname,
  orgSlug,
  orgCustomDomain,
  now,
  onOpenSettings,
  onStartChat,
}: AppCardProps) {
  const [copied, setCopied] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const previewRef = useRef<HTMLImageElement | null>(null);
  const appUrl = getPreferredAppUrl(app, { hostname, orgSlug, orgCustomDomain });
  const displayUrl = appUrl.replace(/^https?:\/\//, '');
  const creator = creatorOverride ?? app.creator;
  const creatorLabel = getCreatorLabel(creator, app.created_by);
  const creatorAvatar = creator?.avatar ?? null;
  const creatorContent = creatorAvatar?.content ?? getInitials(creatorLabel);
  const creatorFallbackStyle = creatorAvatar?.color
    ? {
        backgroundColor: creatorAvatar.color,
        color: getContrastTextColor(creatorAvatar.color),
      }
    : undefined;
  // Extract filename from config_path (e.g., "/workspace/my-app/wrangler.jsonc" -> "wrangler.jsonc")
  const sourceLabel = app.config_path
    ? app.config_path.split('/').pop() ?? 'wrangler.jsonc'
    : null;
  const previewVersion = app.preview_updated_at ?? app.updated_at;
  const previewUrl = app.preview_status === 'ready' && app.preview_key
    ? `/api/apps/${encodeURIComponent(app.script_name)}/preview?v=${previewVersion}`
    : null;
  const showPreview = Boolean(previewUrl) && !previewFailed;
  const previewLoading = showPreview && !previewLoaded;
  const workspaceBadge = showWorkspaceBadge && workspace ? (
    <Badge
      variant="secondary"
      className="gap-1 pl-1 pr-2 text-[10px] text-muted-foreground max-w-[140px] min-w-0 shrink justify-start"
    >
      <Avatar size="xs">
        <AvatarFallback
          content={workspace.avatar.content}
          style={{
            backgroundColor: workspace.avatar.color,
            color: getContrastTextColor(workspace.avatar.color),
          }}
        >
          {workspace.avatar.content}
        </AvatarFallback>
      </Avatar>
      <span className="truncate min-w-0">{workspace.name}</span>
    </Badge>
  ) : null;

  useEffect(() => {
    if (!copyMessage) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
      setCopyMessage('');
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [copyMessage]);

  useLayoutEffect(() => {
    setPreviewFailed(false);
    setPreviewLoaded(false);
  }, [previewUrl]);

  useLayoutEffect(() => {
    if (!showPreview || previewLoaded || previewFailed) return;
    const img = previewRef.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0) {
      setPreviewLoaded(true);
    } else {
      setPreviewFailed(true);
    }
  }, [previewFailed, previewLoaded, previewUrl, showPreview]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(appUrl);
      setCopied(true);
      setCopyMessage('Copied app URL to clipboard.');
    } catch {
      setCopied(false);
      setCopyMessage('Failed to copy app URL.');
    }
  };

  return (
    <Card className="group gap-0 overflow-hidden p-0">
      {/* Preview section with badges and hover chat button */}
      <div className="relative aspect-video w-full overflow-hidden">
        {/* Workspace badge - top-left */}
        {workspaceBadge ? (
          <div className="absolute left-2 top-2 z-10">
            {workspaceBadge}
          </div>
        ) : null}

        {/* Visibility badge - top-right */}
        <div className="absolute right-2 top-2 z-10">
          <Badge
            variant={app.is_public ? 'default' : 'secondary'}
            className="shrink-0"
          >
            {app.is_public ? <Globe className="size-3" /> : <Lock className="size-3" />}
            {app.is_public ? 'Public' : 'Private'}
          </Badge>
        </div>

        {/* Preview image or placeholder - with zoom on hover */}
        {showPreview ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={previewRef}
              src={previewUrl ?? undefined}
              alt={`${app.script_name} preview`}
              className={`absolute inset-0 h-full w-full object-cover transition-all duration-500 ease-out group-hover:scale-105 group-hover:saturate-110 ${previewLoaded ? 'opacity-100' : 'opacity-0'}`}
              loading="lazy"
              decoding="async"
              onLoad={() => setPreviewLoaded(true)}
              onError={() => {
                setPreviewFailed(true);
                setPreviewLoaded(false);
              }}
            />
            {previewLoading ? (
              <div className="absolute inset-0" aria-hidden="true">
                <Skeleton className="h-full w-full rounded-none" />
              </div>
            ) : null}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted/80 via-muted/40 to-muted/80 transition-transform duration-500 ease-out group-hover:scale-105">
            <Image className="size-8 text-muted-foreground/60" />
          </div>
        )}

        {/* Hover overlay with chat button - bottom-centered with slide-up animation */}
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-4 opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100 group-focus-within:opacity-100">
          <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/70 via-black/40 to-transparent transition-opacity duration-200" />
          <Button
            type="button"
            size="default"
            className="pointer-events-auto relative z-10 translate-y-4 gap-2 bg-white px-6 text-zinc-900 shadow-lg transition-transform duration-300 ease-out hover:bg-zinc-100 group-hover:translate-y-0 cursor-pointer"
            onClick={() => onStartChat(app)}
          >
            New Chat
          </Button>
        </div>
      </div>

      {/* Header: Title + Settings */}
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="truncate text-base font-semibold">
            {app.script_name}
          </CardTitle>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="App settings"
                  disabled={!isAdmin}
                  className="cursor-pointer"
                  onClick={() => onOpenSettings(app)}
                >
                  <Settings className="size-4 text-muted-foreground" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{isAdmin ? 'App settings' : 'Admins only'}</TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>

      {/* Content */}
      <CardContent className="space-y-3 pb-4 pt-0">
        {/* Metadata line: Author, Date, Source (no separators, use gap spacing) */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground overflow-hidden">
          {/* Author with tooltip */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 min-w-0 cursor-default">
                <Avatar size="2xs">
                  <AvatarFallback content={creatorContent} style={creatorFallbackStyle}>
                    {creatorContent}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate max-w-[100px]">
                  {creatorLabel}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{creatorLabel}</TooltipContent>
          </Tooltip>

          {/* Last updated */}
          <div className="flex items-center gap-1 shrink-0">
            <Clock className="size-3" />
            <span>{getRelativeTime(app.updated_at, now)}</span>
          </div>

          {/* Source file tag */}
          {sourceLabel && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  aria-label={`Source file: ${app.config_path}`}
                  className="flex h-6 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none cursor-default focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-[2px]"
                >
                  <FileCode className="size-3" />
                  <span className="truncate max-w-[80px]">{sourceLabel}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent>{app.config_path}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* URL line: Input field with Copy/Open buttons */}
        <div className="relative">
          <Input
            readOnly
            value={displayUrl}
            aria-label="App URL"
            className="h-9 truncate pr-16 text-xs/relaxed text-muted-foreground cursor-text"
          />
          <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={copied ? 'Copied URL' : 'Copy URL'}
                  className="cursor-pointer"
                  onClick={handleCopy}
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copied ? 'Copied!' : 'Copy URL'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open in new tab"
                  className="cursor-pointer"
                  onClick={() => {
                    window.open(appUrl, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in new tab</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <span className="sr-only" aria-live="polite">
          {copyMessage}
        </span>
      </CardContent>
    </Card>
  );
}
