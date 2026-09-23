import { Bot, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { formatTime, useApi, type AgentSummary } from "@/lib/api";
import { Link, navigate } from "@/lib/router";

export function AgentStatus({ agent }: { agent: Pick<AgentSummary, "running" | "connected"> }) {
  if (agent.running) return <Badge>Running</Badge>;
  if (agent.connected) return <Badge variant="secondary">Connected</Badge>;
  return <Badge variant="outline">Asleep</Badge>;
}

export function AgentsPage() {
  const agents = useApi<AgentSummary[]>("/v1/agents", 10_000);
  return (
    <>
      <PageHeader
        title="Agents"
        description="Agents in your tenant. Your application creates them with the SDK or POST /v1/agents."
        actions={<Button variant="outline" size="sm" onClick={() => void agents.reload()}><RefreshCw />Refresh</Button>}
      />
      <ErrorAlert error={agents.error} />
      {agents.loading && !agents.data ? <Skeleton className="h-40 w-full" />
        : agents.data?.length === 0 ? (
          <EmptyState icon={<Bot />} title="No agents yet">
            Add a model key under <Link className="underline" to="models">Models &amp; keys</Link>, then follow the{" "}
            <Link className="underline" to="quickstart">Quickstart</Link> to create one from your app.
          </EmptyState>
        ) : agents.data && (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Type</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Session expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.data.map(agent => (
                  <TableRow key={agent.id} className="cursor-pointer" onClick={() => navigate(`agents/${agent.id}`)}>
                    <TableCell className="font-medium"><Link to={`agents/${agent.id}`}>{agent.name}</Link></TableCell>
                    <TableCell className="text-muted-foreground hidden sm:table-cell">{agent.type}</TableCell>
                    <TableCell className="font-mono text-xs">{agent.model}</TableCell>
                    <TableCell><AgentStatus agent={agent} /></TableCell>
                    <TableCell className="text-muted-foreground hidden lg:table-cell">{formatTime(agent.expiresAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
    </>
  );
}
