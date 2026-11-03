"use client";

import { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, ExternalLink, Mail, MessageCircle, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import type { RuntimeCallArtifact } from '@/lib/runtime-artifacts';
import { cn } from '@/lib/utils';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow, OutputBlock } from './shared';
import { getResultText } from '../tool-utils';

interface JavaScriptDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

type TablePreview = {
  columns: string[];
  rows: Record<string, unknown>[];
};

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function parseTablePreview(output: string): TablePreview | null {
  if (!output.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : null;
  if (!rows || rows.length === 0 || !rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return null;
  }

  const columns = Array.from(new Set(
    rows.flatMap((row) => Object.keys(row as Record<string, unknown>))
  )).filter((column) => rows.some((row) => isScalar((row as Record<string, unknown>)[column]))).slice(0, 6);
  if (columns.length === 0) return null;

  return {
    columns,
    rows: rows.slice(0, 10) as Record<string, unknown>[],
  };
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (isScalar(value)) return String(value);
  return JSON.stringify(value);
}

function ResultTablePreview({ preview }: { preview: TablePreview }) {
  return (
    <div className="mt-2 overflow-auto rounded border border-border/60">
      <table className="w-full min-w-max text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {preview.columns.map((column) => (
              <th key={column} className="px-2 py-1.5 text-left font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, index) => (
            <tr key={index} className="border-t border-border/50">
              {preview.columns.map((column) => (
                <td key={column} className="max-w-52 truncate px-2 py-1.5 text-muted-foreground">
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatArtifactValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function getArtifactDestination(artifact: RuntimeCallArtifact): string {
  const summary = artifact.summary;
  const candidates = [
    summary.to,
    summary.channelName,
    summary.channelId,
    summary.chatTitle,
    summary.chatId,
    summary.threadId,
  ];
  const destination = candidates.find((value) => typeof value === 'string' && value.trim());
  return typeof destination === 'string' ? destination : '';
}

function getArtifactToolLabel(toolName: RuntimeCallArtifact['toolName']): string {
  switch (toolName) {
    case 'send_email':
      return 'Email';
    case 'send_slack_message':
      return 'Slack';
    case 'send_telegram_message':
      return 'Telegram';
    case 'send_discord_message':
      return 'Discord';
  }
}

function getArtifactIcon(kind: RuntimeCallArtifact['kind']) {
  switch (kind) {
    case 'outbound_email':
      return Mail;
    case 'outbound_slack_message':
      return MessageCircle;
    case 'outbound_telegram_message':
      return Send;
    case 'outbound_discord_message':
      return MessageCircle;
  }
}

function RuntimeArtifactToolRow({ artifact }: { artifact: RuntimeCallArtifact }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const previewContext = useChatPreviewContext();
  const Icon = getArtifactIcon(artifact.kind);
  const StatusIcon = artifact.status === 'failed' ? AlertCircle : CheckCircle2;
  const destination = getArtifactDestination(artifact);
  const summaryText = destination ? `${artifact.title} · ${destination}` : artifact.title;
  const statusClass = artifact.status === 'failed' ? 'bg-red-500' : 'bg-green-500';
  const detailEntries = Object.entries({ ...artifact.summary, ...artifact.result })
    .filter(([, value]) => value !== undefined && value !== null && value !== '');

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "tool-call group/toolcall flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-muted-foreground",
            "transition-colors duration-150 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setIsExpanded((prev) => !prev);
            }
          }}
        >
          <span className={cn("tool-call__dot h-1.5 w-1.5 shrink-0 rounded-full", statusClass)} />
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <span className="tool-call__text min-w-0 flex-1 truncate">{summaryText}</span>
          <Badge
            variant={artifact.status === 'failed' ? 'destructive' : 'secondary'}
            className="h-4 px-1.5 text-[0.6rem]"
          >
            {artifact.status}
          </Badge>
          <ChevronRight
            className={cn(
              "tool-call__chevron h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150",
              "group-hover/toolcall:opacity-100",
              isExpanded && "rotate-90 opacity-100"
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "group/details overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none"
        )}
      >
        <div className="ml-3 mt-1 border-l border-border/50 pl-4">
          <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground/80">
            <StatusIcon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                artifact.status === 'failed' ? "text-destructive" : "text-emerald-600"
              )}
            />
            <span className="min-w-0 truncate">{artifact.subtitle ?? getArtifactToolLabel(artifact.toolName)}</span>
            {previewContext ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto h-5 w-5 text-muted-foreground/70"
                    aria-label={`Open ${artifact.title} preview`}
                    onClick={() => previewContext.openPreviewTarget({ kind: 'runtime_artifact', artifact })}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Open preview</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <DetailRow label="Tool:" value={artifact.toolName} mono />
          <DetailRow label="Status:" value={artifact.status} />
          <DetailRow label="Updated:" value={new Date(artifact.updatedAt).toLocaleString()} />
          {detailEntries.map(([key, value]) => (
            <DetailRow
              key={key}
              label={`${key}:`}
              value={formatArtifactValue(value)}
              mono={typeof value !== 'boolean'}
              copyValue={formatArtifactValue(value)}
            />
          ))}
          {artifact.error ? (
            <OutputBlock
              value={artifact.error.message}
              label="Error"
              copyValue={artifact.error.message}
              className="mt-2"
            />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RuntimeArtifactToolCalls({ artifacts }: { artifacts?: RuntimeCallArtifact[] }) {
  if (!artifacts?.length) return null;

  return (
    <div className="mt-2 space-y-1">
      <div className="text-[0.7rem] text-muted-foreground/60">Function calls</div>
      <div className="space-y-0.5">
        {artifacts.map((artifact) => (
          <RuntimeArtifactToolRow key={artifact.id} artifact={artifact} />
        ))}
      </div>
    </div>
  );
}

/** codemode's options: an optional first line `// @options: {"timeout_ms": ..., "max_output_tokens": ...}`. */
function parseCodeOptions(code: string): { timeoutMs?: number; maxOutputTokens?: number } {
  const match = /^\s*\/\/\s*@options:\s*(\{.*\})\s*$/.exec(code.split('\n', 1)[0] ?? '');
  if (!match) return {};
  try {
    const options = JSON.parse(match[1]) as Record<string, unknown>;
    return {
      ...(typeof options.timeout_ms === 'number' ? { timeoutMs: options.timeout_ms } : {}),
      ...(typeof options.max_output_tokens === 'number' ? { maxOutputTokens: options.max_output_tokens } : {}),
    };
  } catch {
    return {};
  }
}

/** codemode's result leads with `Script completed|failed`, the wall time and `Output:`; js_exec's is the output alone. */
function splitScriptResult(text: string): { wallTime?: string; output: string } {
  const match = /^Script (?:completed|failed)\nWall time ([\d.]+ seconds)\nOutput:\n*/.exec(text);
  return match ? { wallTime: match[1], output: text.slice(match[0].length) } : { output: text };
}

export function JavaScriptDetails({ tool, result }: JavaScriptDetailsProps) {
  const input = tool?.input ?? {};
  const description = typeof input.description === 'string' ? input.description : '';
  const code = typeof input.code === 'string' ? input.code : '';
  const options = parseCodeOptions(code);
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : options.timeoutMs;
  const maxOutputCharacters =
    typeof input.maxOutputCharacters === 'number' ? input.maxOutputCharacters : undefined;
  const { wallTime, output } = splitScriptResult(getResultText(result));
  const tablePreview = parseTablePreview(output);
  const artifacts = result?.artifacts;

  return (
    <div className="space-y-1">
      <DetailRow label="Runtime:" value="JavaScript code mode" />
      {description ? <DetailRow label="Description:" value={description} /> : null}
      {timeoutMs !== undefined ? <DetailRow label="Timeout:" value={`${timeoutMs}ms`} /> : null}
      {maxOutputCharacters !== undefined ? (
        <DetailRow label="Output limit:" value={`${maxOutputCharacters} chars`} />
      ) : null}
      {options.maxOutputTokens !== undefined ? (
        <DetailRow label="Output limit:" value={`${options.maxOutputTokens} tokens`} />
      ) : null}
      {wallTime ? <DetailRow label="Wall time:" value={wallTime} /> : null}
      <OutputBlock value={code} label="Code" copyValue={code} />
      <RuntimeArtifactToolCalls artifacts={artifacts} />
      {tablePreview ? <ResultTablePreview preview={tablePreview} /> : null}
      <OutputBlock value={output} label="Output" copyValue={output} />
      {!code && !output ? <DetailRow label="Details:" value="No additional data" /> : null}
    </div>
  );
}
