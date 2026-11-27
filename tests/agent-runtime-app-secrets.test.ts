import { describe, expect, it } from 'vitest';
import {
  runtimeInputAppSecrets,
  runtimeInputQuestions,
  type RuntimeInput,
} from '../src/lib/agent-runtime-shared';

describe('runtimeInputAppSecrets', () => {
  it('parses a blind app_secrets form elicitation and does not collide with runtimeInputQuestions', () => {
    const input: RuntimeInput = {
      id: 'inp_123',
      kind: 'form',
      message: 'Configure runtime secrets for inventreetracker',
      detail: {
        requestedSchema: {
          type: 'object',
          'x-camelai-kind': 'app_secrets',
          'x-camelai-app-secrets': {
            workspaceId: 'ws-1',
            scriptName: 'inventreetracker',
            message: 'Add SESSION_SECRET and ADMIN_API_KEY',
            existingKeys: ['SESSION_SECRET'],
            keys: [
              {
                key: 'SESSION_SECRET',
                description: 'Cookie signing key',
                required: true,
                isSecret: true,
              },
              {
                key: 'ADMIN_API_KEY',
                required: true,
                isSecret: true,
              },
            ],
          },
          properties: {
            saved: { type: 'boolean', title: 'Saved' },
          },
        },
      },
    };

    expect(runtimeInputQuestions(input)).toBeNull();
    expect(runtimeInputAppSecrets(input)).toEqual({
      inputId: 'inp_123',
      workspaceId: 'ws-1',
      scriptName: 'inventreetracker',
      message: 'Add SESSION_SECRET and ADMIN_API_KEY',
      existingKeys: ['SESSION_SECRET'],
      keys: [
        {
          key: 'SESSION_SECRET',
          description: 'Cookie signing key',
          required: true,
          isSecret: true,
        },
        {
          key: 'ADMIN_API_KEY',
          required: true,
          isSecret: true,
        },
      ],
    });
  });

  it('returns null for ordinary forms and non-form inputs', () => {
    expect(
      runtimeInputAppSecrets({
        id: 'inp_2',
        kind: 'form',
        message: 'Confirm?',
        detail: { requestedSchema: { type: 'object', properties: {} } },
      }),
    ).toBeNull();

    expect(
      runtimeInputAppSecrets({
        id: 'inp_3',
        kind: 'question',
        message: 'Pick one',
        detail: { questions: [] },
      }),
    ).toBeNull();
  });
});
