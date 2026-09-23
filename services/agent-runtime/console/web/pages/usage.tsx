import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { formatCost, formatNumber, useApi, type Usage } from "@/lib/api";

export function UsagePage() {
  const [days, setDays] = useState("30");
  const usage = useApi<Usage>(`/v1/usage?days=${days}`);
  const totals = usage.data?.totals;
  return (
    <>
      <PageHeader title="Usage" description="Model responses from your agents, billed to your provider keys. Costs are estimates from list prices."
        actions={
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24 hours</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        } />
      <ErrorAlert error={usage.error} />
      {!usage.data ? <Skeleton className="h-64 w-full" /> : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Responses", formatNumber(totals!.responses)],
              ["Input tokens", formatNumber(totals!.input + totals!.cacheRead + totals!.cacheWrite)],
              ["Output tokens", formatNumber(totals!.output)],
              ["Estimated cost", formatCost(totals!.cost)],
            ].map(([label, value]) => (
              <Card key={label} size="sm">
                <CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{value}</CardTitle></CardHeader>
              </Card>
            ))}
          </div>
          {usage.data.days.length === 0 ? <EmptyState icon={<BarChart3 />} title="No usage in this period" /> : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Day</TableHead><TableHead>Model</TableHead><TableHead className="text-right">Responses</TableHead>
                      <TableHead className="text-right">Input</TableHead><TableHead className="text-right">Cached</TableHead>
                      <TableHead className="text-right">Output</TableHead><TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...usage.data.days].reverse().map(row => (
                      <TableRow key={`${row.day} ${row.model}`}>
                        <TableCell className="tabular-nums">{row.day}</TableCell>
                        <TableCell className="font-mono text-xs">{row.model}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(row.responses)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(row.input)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(row.cacheRead)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(row.output)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCost(row.cost)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </>
  );
}
