'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { RuntimeAppSecretsPrompt } from '@/lib/agent-runtime-shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
} from 'lucide-react';

interface AppSecretsPromptDialogProps {
  prompt: RuntimeAppSecretsPrompt;
  onResolve: (accepted: boolean) => void;
}

function generateRandomHexSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function AppSecretsPromptDialog({
  prompt,
  onResolve,
}: AppSecretsPromptDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingSet = useMemo(
    () => new Set(prompt.existingKeys),
    [prompt.existingKeys],
  );

  useEffect(() => {
    setValues({});
    setRevealed({});
    setError(null);
    setSaving(false);
  }, [prompt.inputId]);

  const missingRequiredKeys = useMemo(
    () =>
      prompt.keys
        .filter((entry) => entry.required && !existingSet.has(entry.key) && !(values[entry.key] ?? '').trim())
        .map((entry) => entry.key),
    [prompt.keys, existingSet, values],
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;

    if (missingRequiredKeys.length > 0) {
      setError(`Please enter a value for required key${missingRequiredKeys.length > 1 ? 's' : ''}: ${missingRequiredKeys.join(', ')}`);
      return;
    }

    const toSave = prompt.keys
      .map((entry) => ({
        key: entry.key,
        value: values[entry.key] ?? '',
        isSecret: entry.isSecret,
      }))
      .filter((entry) => entry.value.length > 0);

    setSaving(true);
    setError(null);
    try {
      if (toSave.length > 0) {
        const endpoint = `/api/workspaces/${encodeURIComponent(prompt.workspaceId)}/apps/${encodeURIComponent(prompt.scriptName)}/env-vars`;
        const response = await fetch(endpoint, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vars: toSave }),
        });
        const data = (await response.json()) as { error?: string };
        if (!response.ok) {
          setError(data.error ?? 'Failed to save runtime secrets');
          setSaving(false);
          return;
        }
        toast.success(
          `Saved ${toSave.length} runtime ${toSave.length === 1 ? 'secret' : 'secrets'} for ${prompt.scriptName}`,
        );
      }

      // Clear plaintext inputs from React state immediately before resuming the agent.
      setValues({});
      setRevealed({});
      onResolve(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save runtime secrets');
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (saving) return;
    setValues({});
    setRevealed({});
    onResolve(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            Add Runtime Secrets for {prompt.scriptName}
          </DialogTitle>
          <DialogDescription>{prompt.message}</DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Lock className="size-4 shrink-0 mt-0.5 text-primary" />
            <p className="leading-relaxed">
              <span className="font-medium text-foreground">Blind entry:</span>{' '}
              Values are sent directly from your browser to encrypted app storage and injected as{' '}
              <code className="font-mono text-foreground">env.&lt;KEY&gt;</code>. The AI agent only sees which key names are configured — never your secret values.
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-3">
            {prompt.keys.map((entry) => {
              const alreadySet = existingSet.has(entry.key);
              const isRevealed = Boolean(revealed[entry.key]) || !entry.isSecret;
              const currentValue = values[entry.key] ?? '';

              return (
                <div key={entry.key} className="space-y-1.5 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label
                      htmlFor={`blind-secret-${entry.key}`}
                      className="font-mono text-xs font-medium"
                    >
                      {entry.key}
                    </Label>
                    <div className="flex items-center gap-1.5">
                      {alreadySet ? (
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0 h-4 inline-flex items-center gap-1"
                        >
                          <Check className="size-2.5" />
                          Already set
                        </Badge>
                      ) : entry.required ? (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                          Required
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-muted-foreground">
                          Optional
                        </Badge>
                      )}
                      {entry.isSecret && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setValues((prev) => ({
                              ...prev,
                              [entry.key]: generateRandomHexSecret(32),
                            }));
                          }}
                          disabled={saving}
                          title="Generate a random 32-byte hex secret"
                        >
                          <RefreshCw className="size-3" />
                          Generate
                        </Button>
                      )}
                    </div>
                  </div>

                  {entry.description && (
                    <p className="text-xs text-muted-foreground">{entry.description}</p>
                  )}

                  <div className="relative">
                    <Input
                      id={`blind-secret-${entry.key}`}
                      type={isRevealed ? 'text' : 'password'}
                      value={currentValue}
                      onChange={(e) => {
                        const nextVal = e.target.value;
                        setValues((prev) => ({ ...prev, [entry.key]: nextVal }));
                        if (error) setError(null);
                      }}
                      placeholder={
                        alreadySet
                          ? 'Leave blank to keep existing value, or enter a new value to rotate'
                          : entry.isSecret
                            ? `Enter ${entry.key}`
                            : `Enter value for ${entry.key}`
                      }
                      className="h-8 pr-8 font-mono text-xs"
                      autoComplete="new-password"
                      spellCheck={false}
                      disabled={saving}
                    />
                    {entry.isSecret && (
                      <button
                        type="button"
                        onClick={() =>
                          setRevealed((prev) => ({
                            ...prev,
                            [entry.key]: !prev[entry.key],
                          }))
                        }
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        title={isRevealed ? 'Hide value' : 'Show value'}
                        tabIndex={-1}
                      >
                        {isRevealed ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || missingRequiredKeys.length > 0}
            >
              {saving ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Secrets & Continue'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
