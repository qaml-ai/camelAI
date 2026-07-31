import { BillingService } from "./billing.ts";
import { ProjectFilesystem } from "./filesystem.ts";
import { IdentityService } from "./identity.ts";
import { Store, resolveDataDir, type StoreOptions } from "./store.ts";

export { BillingService, type BillingAccount } from "./billing.ts";
export {
  ProjectFilesystem,
  type FsEntry,
  type ProjectFilesystemOptions,
} from "./filesystem.ts";
export {
  IdentityService,
  type DemoTenant,
  type Org,
  type Thread,
  type User,
  type Workspace,
} from "./identity.ts";
export { Store, resolveDataDir, type StoreOptions } from "./store.ts";

export type PlatformOptions = StoreOptions & {
  /** Seed the demo org/workspace/user on create. Default false. */
  ensureDemoTenant?: boolean;
  /** Initial demo credit grant in cents when seeding. Default 1000 ($10). */
  demoCreditCents?: number;
};

export type Platform = {
  dataDir: string;
  store: Store;
  identity: IdentityService;
  billing: BillingService;
  /** Open a project filesystem under DATA_DIR/projects/{workspaceId}/{projectId}. */
  projectFilesystem: (
    workspaceId: string,
    projectId: string,
  ) => ProjectFilesystem;
};

/** Create the in-process platform services sharing one Store. */
export function createPlatform(options: PlatformOptions = {}): Platform {
  const store = new Store({
    dataDir: options.dataDir,
    filename: options.filename,
  });
  const identity = new IdentityService(store);
  const billing = new BillingService(store);

  if (options.ensureDemoTenant) {
    const demo = identity.ensureDemoTenant();
    const grant = options.demoCreditCents ?? 1000;
    if (grant > 0 && billing.getCreditBalance(demo.org.id) <= 0) {
      billing.grantCredits(demo.org.id, grant);
    }
  }

  return {
    dataDir: store.dataDir,
    store,
    identity,
    billing,
    projectFilesystem: (workspaceId, projectId) =>
      new ProjectFilesystem({
        dataDir: store.dataDir,
        workspaceId,
        projectId,
      }),
  };
}
