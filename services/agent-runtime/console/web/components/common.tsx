import { useState, type ReactNode } from "react";
import { AlertCircle, Check, Copy } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorAlert({ error, title = "Something went wrong" }: { error?: { message: string } | string; title?: string }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" className="mb-4">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{typeof error === "string" ? error : error.message}</AlertDescription>
    </Alert>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} onClick={async () => {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="bg-muted/60 relative rounded-md border">
      {language && <span className="text-muted-foreground absolute top-2 left-3 text-[10px] uppercase tracking-wider">{language}</span>}
      <div className="absolute top-1 right-1"><CopyButton value={code} /></div>
      <pre className="overflow-x-auto p-3 pt-7 font-mono text-xs leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

/** A destructive action behind an explicit confirmation. */
export function ConfirmButton({ label, title, description, confirm, onConfirm, variant = "outline", size = "sm", icon }: {
  label: string; title: string; description: ReactNode; confirm: string; onConfirm: () => Promise<void> | void;
  variant?: "outline" | "destructive" | "ghost"; size?: "sm" | "xs" | "default"; icon?: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild><Button variant={variant} size={size}>{icon}{label}</Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void onConfirm()}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="[&_svg]:size-6">{icon}</div>
      <p className="text-foreground text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm">{children}</div>}
    </div>
  );
}
