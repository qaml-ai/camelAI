import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { BarChart3, Bot, Github, KeyRound, LogOut, Rocket, Boxes, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorAlert } from "@/components/common";
import { api, useApi, type Me } from "@/lib/api";
import { Link, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";
import { AgentsPage } from "@/pages/agents";
import { AgentPage } from "@/pages/agent";
import { ModelsPage } from "@/pages/models";
import { TokensPage } from "@/pages/tokens";
import { UsagePage } from "@/pages/usage";
import { QuickstartPage } from "@/pages/quickstart";
import "./style.css";

const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

const NAV = [
  { to: "agents", label: "Agents", icon: Bot },
  { to: "models", label: "Models & keys", icon: Boxes },
  { to: "tokens", label: "API tokens", icon: KeyRound },
  { to: "usage", label: "Usage", icon: BarChart3 },
  { to: "quickstart", label: "Quickstart", icon: Rocket },
];

function App() {
  const me = useApi<Me>("/v1/me");
  const path = usePath();
  if (me.loading && !me.data) return <div className="text-muted-foreground flex h-dvh items-center justify-center"><Loader2 className="animate-spin" /></div>;
  if (!me.data) return <SignIn onSignedIn={() => void me.reload()} />;
  const [section, ...rest] = path.split("/");
  const page = section === "agents" && rest[0] ? <AgentPage id={rest[0]} />
    : section === "models" ? <ModelsPage me={me.data} />
    : section === "tokens" ? <TokensPage />
    : section === "usage" ? <UsagePage />
    : section === "quickstart" ? <QuickstartPage />
    : <AgentsPage />;
  const active = section || "agents";
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="bg-muted/30 flex shrink-0 flex-col border-b md:sticky md:top-0 md:h-dvh md:w-60 md:border-r md:border-b-0">
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div>
            <div className="text-sm font-semibold">Agent Runtime</div>
            <div className="text-muted-foreground text-xs">{location.host}</div>
          </div>
          <div className="md:hidden"><SignOut /></div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className={cn(
              "hover:bg-muted flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm",
              active === to ? "bg-muted text-foreground font-medium" : "text-muted-foreground",
            )}>
              <Icon className="size-4" />{label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden md:block">
          <Separator />
          <div className="flex items-center justify-between gap-2 px-5 py-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{me.data.login ?? me.data.tenant}</div>
              <div className="text-muted-foreground truncate text-xs">tenant {me.data.tenant}</div>
            </div>
            <SignOut />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto max-w-6xl">{page}</div>
      </main>
    </div>
  );
}

function SignOut() {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={async () => {
      await api("/console/auth/logout", { body: {} });
      location.assign("/console/");
    }}><LogOut /></Button>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const methods = useApi<{ github: boolean; token: boolean; org?: string }>("/console/auth/methods");
  const [token, setToken] = useState("");
  const [error, setError] = useState(new URLSearchParams(location.search).get("error") ?? "");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try { await api("/console/auth/token", { body: { token: token.trim() } }); history.replaceState(null, "", "/console/"); onSignedIn(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Agent Runtime</CardTitle>
          <CardDescription>Sign in to manage your agents, model keys and API tokens.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ErrorAlert error={error || undefined} title="Sign-in failed" />
          {methods.data?.github && (
            <Button asChild>
              <a href="/console/auth/github"><Github />Continue with GitHub</a>
            </Button>
          )}
          {methods.data?.github && <p className="text-muted-foreground -mt-2 text-xs">For members of the {methods.data.org} GitHub organization.</p>}
          {methods.data?.github && <div className="text-muted-foreground flex items-center gap-3 text-xs"><Separator className="flex-1" />or<Separator className="flex-1" /></div>}
          <form onSubmit={submit} className="flex flex-col gap-2">
            <Label htmlFor="token">Operator or API token</Label>
            <Input id="token" type="password" autoComplete="off" placeholder="art_…" value={token} onChange={event => setToken(event.target.value)} />
            <Button type="submit" variant={methods.data?.github ? "outline" : "default"} disabled={!token.trim() || busy}>
              {busy && <Loader2 className="animate-spin" />}Sign in with token
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><TooltipProvider><App /></TooltipProvider></StrictMode>,
);
