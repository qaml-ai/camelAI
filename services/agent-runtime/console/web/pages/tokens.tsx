import { useState, type FormEvent } from "react";
import { KeyRound, Loader2, Plus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CodeBlock, ConfirmButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type ApiToken } from "@/lib/api";

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try { setCreated((await api<{ token: string }>("/v1/tokens", { body: { name: name.trim() } })).token); onCreated(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        {created ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Copy your token now</DialogTitle>
              <DialogDescription>It won't be shown again. Anyone with it can create and control every agent in your tenant.</DialogDescription>
            </DialogHeader>
            <CodeBlock code={created} />
            <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={create} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>New API token</DialogTitle>
              <DialogDescription>Use it as the SDK's <code className="font-mono">apiKey</code>, or as <code className="font-mono">Authorization: Bearer</code> for the REST API.</DialogDescription>
            </DialogHeader>
            <ErrorAlert error={error} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="token-name">Name</Label>
              <Input id="token-name" autoFocus placeholder="e.g. production backend" value={name} onChange={event => setName(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || busy}>{busy && <Loader2 className="animate-spin" />}Create token</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TokensPage() {
  const tokens = useApi<ApiToken[]>("/v1/tokens");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <PageHeader title="API tokens" description="Tokens for your applications and scripts. Each one has full access to your tenant; revoke any you no longer use."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New token</Button>} />
      <ErrorAlert error={tokens.error ?? error} />
      <Alert className="mb-4">
        <KeyRound />
        <AlertTitle>Keep tokens on your backend</AlertTitle>
        <AlertDescription>Never ship a token to a browser or mobile app. Your backend creates agents and hands clients only an agent's scoped session.</AlertDescription>
      </Alert>
      {!tokens.data ? <Skeleton className="h-32 w-full" /> : tokens.data.length === 0 ? (
        <EmptyState icon={<KeyRound />} title="No API tokens">Create one to connect your application.</EmptyState>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Token</TableHead><TableHead>Created</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {tokens.data.map(token => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">{token.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{token.prefix}…</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatTime(token.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <ConfirmButton size="xs" label="Revoke" title={`Revoke “${token.name}”?`} description="Applications using this token stop working immediately." confirm="Revoke token"
                      onConfirm={async () => { try { await api(`/v1/tokens/${token.id}`, { method: "DELETE" }); await tokens.reload(); } catch (caught) { setError((caught as Error).message); } }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {creating && <CreateTokenDialog onClose={() => setCreating(false)} onCreated={() => void tokens.reload()} />}
    </>
  );
}
