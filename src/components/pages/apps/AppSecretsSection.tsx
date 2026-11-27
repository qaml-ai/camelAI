'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Trash2,
} from 'lucide-react';

export interface AppEnvVarItem {
  key: string;
  isSecret: boolean;
  value?: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

interface AppSecretsSectionProps {
  workspaceId: string;
  scriptName: string;
  active: boolean;
}

export function AppSecretsSection({
  workspaceId,
  scriptName,
  active,
}: AppSecretsSectionProps) {
  const [vars, setVars] = useState<AppEnvVarItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [keyInput, setKeyInput] = useState('');
  const [valueInput, setValueInput] = useState('');
  const [isSecret, setIsSecret] = useState(true);
  const [showValue, setShowValue] = useState(false);

  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(scriptName)}/env-vars`;

  const loadVars = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { credentials: 'same-origin' });
      const data = (await response.json()) as {
        vars?: AppEnvVarItem[];
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? 'Failed to load environment variables');
        return;
      }
      setVars(Array.isArray(data.vars) ? data.vars : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load environment variables');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    if (!active) return;
    void loadVars();
  }, [active, loadVars]);

  const handleSaveVar = async () => {
    const trimmedKey = keyInput.trim();
    if (!trimmedKey) {
      setError('Enter a variable name (e.g. SESSION_SECRET).');
      return;
    }
    if (!valueInput) {
      setError(`Enter a value for ${trimmedKey}.`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: trimmedKey,
          value: valueInput,
          isSecret,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        vars?: AppEnvVarItem[];
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? 'Failed to save variable');
        return;
      }
      setVars(Array.isArray(data.vars) ? data.vars : []);
      setKeyInput('');
      setValueInput('');
      setShowValue(false);
      toast.success(`Saved ${trimmedKey}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save variable');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteVar = async (key: string) => {
    setDeletingKey(key);
    setError(null);
    try {
      const response = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = (await response.json()) as {
        ok?: boolean;
        vars?: AppEnvVarItem[];
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? `Failed to delete ${key}`);
        return;
      }
      setVars(Array.isArray(data.vars) ? data.vars : []);
      toast.success(`Removed ${key}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to delete ${key}`);
    } finally {
      setDeletingKey(null);
    }
  };

  const handleSelectForUpdate = (item: AppEnvVarItem) => {
    setKeyInput(item.key);
    setValueInput(item.isSecret ? '' : (item.value ?? ''));
    setIsSecret(item.isSecret);
    setShowValue(!item.isSecret);
    setError(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium flex items-center gap-1.5">
          <KeyRound className="size-3.5 text-muted-foreground" />
          Runtime Secrets &amp; Environment Variables
        </p>
        {vars.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {vars.length} configured
          </span>
        )}
      </div>

      <div className="space-y-4 rounded-lg border p-4 text-sm">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Encrypted at rest and injected as <code className="font-mono text-foreground">env.&lt;KEY&gt;</code> on every request.
          Persists across all redeployments without resetting Durable Object storage.
        </p>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading variables...
          </div>
        ) : vars.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            No runtime secrets or environment variables configured yet.
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {vars.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium truncate">
                      {item.key}
                    </span>
                    <Badge
                      variant={item.isSecret ? 'secondary' : 'outline'}
                      className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                    >
                      {item.isSecret ? (
                        <span className="inline-flex items-center gap-1">
                          <Lock className="size-2.5" />
                          Secret
                        </span>
                      ) : (
                        'Plain'
                      )}
                    </Badge>
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground truncate">
                    {item.isSecret ? '••••••••••••' : (item.value ?? '')}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleSelectForUpdate(item)}
                    disabled={saving || deletingKey === item.key}
                  >
                    {item.isSecret ? 'Rotate' : 'Edit'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      void handleDeleteVar(item.key);
                    }}
                    disabled={saving || deletingKey === item.key}
                    title={`Remove ${item.key}`}
                  >
                    {deletingKey === item.key ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3 rounded-md bg-muted/40 p-3">
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="app-env-key" className="text-xs">
                Variable Name
              </Label>
              <Input
                id="app-env-key"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="SESSION_SECRET"
                className="h-8 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="app-env-value" className="text-xs">
                Value
              </Label>
              <div className="relative">
                <Input
                  id="app-env-value"
                  type={isSecret && !showValue ? 'password' : 'text'}
                  value={valueInput}
                  onChange={(e) => setValueInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSaveVar();
                    }
                  }}
                  placeholder={isSecret ? 'Enter secret value' : 'Enter value'}
                  className="h-8 pr-8 font-mono text-xs"
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={saving}
                />
                {isSecret && (
                  <button
                    type="button"
                    onClick={() => setShowValue((prev) => !prev)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    title={showValue ? 'Hide value' : 'Show value'}
                    tabIndex={-1}
                  >
                    {showValue ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="app-env-is-secret"
              className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none"
            >
              <Switch
                id="app-env-is-secret"
                checked={isSecret}
                onCheckedChange={(checked) => {
                  setIsSecret(checked);
                  if (!checked) setShowValue(true);
                }}
                disabled={saving}
              />
              <span>Secret (write-only, hidden after saving)</span>
            </label>
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => {
                void handleSaveVar();
              }}
              disabled={saving || !keyInput.trim() || !valueInput}
            >
              {saving ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Plus className="size-3" />
                  {vars.some((v) => v.key === keyInput.trim()) ? 'Update' : 'Add'}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
