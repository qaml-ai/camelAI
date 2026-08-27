import { describe, it, expect, vi } from 'vitest';
import { deleteWorkerScript, setWorkerScriptPublic } from '@/lib/auth-do';

function buildAuthEnv() {
  const orgStub = {
    async getInfo() {
      return { slug: 'acme-85b' };
    },
    async setWorkerScriptPublic() {
      return {
        script_name: 'my-app',
        workspace_id: 'ws-1',
        created_by: 'user-1',
        created_at: 1,
        updated_at: 2,
        is_public: false,
        preview_key: null,
        preview_updated_at: null,
        preview_status: null,
        preview_error: null,
      };
    },
    async deleteWorkerScript() {
      return true;
    },
  };

  const appKv = {
    put: vi.fn(async (_key: string, _value: string) => {}),
    delete: vi.fn(async (_key: string) => {}),
  };

  const env = {
    ORG: {
      idFromName(id: string) {
        return id;
      },
      get() {
        return orgStub;
      },
    },
    APP_KV: appKv,
  } as any;

  return { env, appKv };
}

describe('worker script KV index writes', () => {
  it('delegates visibility updates to the OrgDO that owns the dispatcher index', async () => {
    const { env, appKv } = buildAuthEnv();

    await setWorkerScriptPublic(env, 'org-1', 'my-app', false, 'user-1');

    expect(appKv.put).not.toHaveBeenCalled();
  });

  it('deletes dispatch index entries using script--org dispatch key format', async () => {
    const { env, appKv } = buildAuthEnv();

    await deleteWorkerScript(env, 'org-1', 'my-app', 'user-1');

    const keys = appKv.delete.mock.calls.map((call: [string]) => call[0]);
    expect(keys).toEqual(['script:my-app--acme-85b']);
  });
});
