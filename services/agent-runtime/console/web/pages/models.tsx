import { useMemo, useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton, CopyButton, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatNumber, formatTime, useApi, type Me, type Model, type Provider } from "@/lib/api";

/** Providers most people want, listed first. */
const FEATURED = ["anthropic", "openai", "google", "openrouter"];

function KeyDialog({ provider, onClose, onSaved }: { provider: Provider; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api(`/v1/providers/${provider.id}/key`, { method: "PUT", body: { apiKey: key.trim() } });
      onSaved(); onClose();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{provider.key?.source === "tenant" ? "Replace" : "Add"} {provider.id} key</DialogTitle>
            <DialogDescription>
              The key is checked with {provider.id}, then stored encrypted. It is never shown again; your agents use it for {provider.id} models and usage bills to it.
            </DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} title="The key was not saved" />
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key">API key</Label>
            <Input id="api-key" type="password" autoComplete="off" autoFocus value={key} onChange={event => setKey(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!key.trim() || busy}>{busy && <Loader2 className="animate-spin" />}Verify and save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KeyBadge({ provider }: { provider: Provider }) {
  if (!provider.key) return <Badge variant="outline">No key</Badge>;
  if (provider.key.source === "admin") return <Badge variant="secondary">Set by admin</Badge>;
  return <Badge><CheckCircle2 />…{provider.key.last4}</Badge>;
}

export function ModelsPage({ me }: { me: Me }) {
  const providers = useApi<Provider[]>("/v1/providers");
  const [editing, setEditing] = useState<Provider>();
  const [error, setError] = useState<string>();
  const supported = useMemo(() => (providers.data ?? []).filter(provider => provider.apiKey)
    .sort((a, b) => (FEATURED.indexOf(a.id) + 1 || 99) - (FEATURED.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id)), [providers.data]);
  const unsupported = (providers.data ?? []).filter(provider => !provider.apiKey);
  const [showAll, setShowAll] = useState(false);
  // The main providers and any with a key come first; the long tail is one click away.
  const shown = showAll ? supported : supported.filter(provider => FEATURED.includes(provider.id) || provider.key);
  return (
    <>
      <PageHeader title="Models & keys" description="Add a key for each provider you want to use. Agents in your tenant call models with your keys." />
      <ErrorAlert error={providers.error ?? error} />
      {!me.canStoreKeys && <ErrorAlert title="Keys cannot be stored" error="This runtime has no key encryption configured. Ask an admin to set AGENT_SECRETS_KEY." />}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold">Provider keys</h2>
        {!providers.data ? <Skeleton className="h-48 w-full" /> : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Models</TableHead><TableHead>Key</TableHead><TableHead className="hidden md:table-cell">Updated</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {shown.map(provider => (
                  <TableRow key={provider.id}>
                    <TableCell className="font-medium">{provider.id}</TableCell>
                    <TableCell className="text-muted-foreground">{provider.models}</TableCell>
                    <TableCell><KeyBadge provider={provider} /></TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs md:table-cell">{formatTime(provider.key?.setAt)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="xs" variant="outline" disabled={!me.canStoreKeys} onClick={() => setEditing(provider)}>
                        <KeyRound />{provider.key?.source === "tenant" ? "Replace" : "Add key"}
                      </Button>
                      {provider.key?.source === "tenant" && (
                        <span className="ml-2 inline-block"><ConfirmButton size="xs" variant="ghost" label="Remove" title={`Remove your ${provider.id} key?`}
                          description={`Agents using ${provider.id} models stop working until a key is added again.`} confirm="Remove key"
                          onConfirm={async () => { try { await api(`/v1/providers/${provider.id}/key`, { method: "DELETE" }); await providers.reload(); } catch (caught) { setError((caught as Error).message); } }} /></span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {supported.length > shown.length && (
          <Button variant="link" size="sm" className="mt-1 px-0" onClick={() => setShowAll(true)}>Show all {supported.length} providers</Button>
        )}
        {unsupported.length > 0 && (
          <p className="text-muted-foreground mt-3 text-xs">
            Not available yet (they need more than an API key): {unsupported.map(provider => `${provider.id} (${provider.requires})`).join(", ")}.
          </p>
        )}
      </section>
      <ModelCatalog providers={supported} />
      {editing && <KeyDialog provider={editing} onClose={() => setEditing(undefined)} onSaved={() => void providers.reload()} />}
    </>
  );
}

const perMillion = (value: number) => value ? `$${value.toFixed(2)}` : "—";

function ModelCatalog({ providers }: { providers: Provider[] }) {
  const [provider, setProvider] = useState("anthropic");
  const [query, setQuery] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const models = useApi<Model[]>(`/v1/models?provider=${encodeURIComponent(provider)}`);
  const shown = (models.data ?? []).filter(model => (!onlyAvailable || model.available) && `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Models</h2>
          <p className="text-muted-foreground text-xs">Pass the ID as <code className="font-mono">model</code> when creating or configuring an agent.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{providers.map(entry => <SelectItem key={entry.id} value={entry.id}>{entry.id}</SelectItem>)}</SelectContent>
          </Select>
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input className="w-48 pl-7" placeholder="Filter" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <Button variant={onlyAvailable ? "secondary" : "outline"} size="sm" onClick={() => setOnlyAvailable(!onlyAvailable)}>Usable only</Button>
        </div>
      </div>
      <ErrorAlert error={models.error} />
      {!models.data ? <Skeleton className="h-64 w-full" /> : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model ID</TableHead>
                <TableHead className="text-right">Context</TableHead>
                <TableHead className="hidden text-right md:table-cell">Max output</TableHead>
                <TableHead className="text-right">Input $/M</TableHead>
                <TableHead className="text-right">Output $/M</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(model => (
                <TableRow key={model.id}>
                  <TableCell>
                    <div className="flex items-center gap-1"><span className="font-mono text-xs">{model.id}</span><CopyButton value={model.id} label="Copy model ID" /></div>
                    <div className="text-muted-foreground text-xs">{model.name}{model.reasoning ? " · reasoning" : ""}{model.input.includes("image") ? " · images" : ""}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(model.contextWindow)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{formatNumber(model.maxTokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{perMillion(model.cost.input)}</TableCell>
                  <TableCell className="text-right tabular-nums">{perMillion(model.cost.output)}</TableCell>
                  <TableCell>{model.available ? <Badge>Usable</Badge> : <Badge variant="outline">Needs key</Badge>}</TableCell>
                </TableRow>
              ))}
              {shown.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground py-8 text-center">No matching models.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
