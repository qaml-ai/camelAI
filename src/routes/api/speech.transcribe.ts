import type { Route } from './+types/speech.transcribe';
import { getEnv } from '@/lib/cloudflare.server';
import { requireAuthContext } from '@/lib/auth.server';
import {
  estimateBase64Bytes,
  transcribeAudioBase64,
} from '../../../workers/main/src/audio-transcription';
import { actionOnlyLoader } from '@/lib/method-not-allowed';

// POST /api/speech/transcribe
// Body: { audio: string (base64 encoded audio) }
// Returns: { text: string }
export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  // Require authentication
  await requireAuthContext(request, context);

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { audio } = body as { audio?: string };

    if (!audio) {
      return Response.json({ error: 'Missing audio data' }, { status: 400 });
    }

    const audioSizeBytes = estimateBase64Bytes(audio);
    const audioSizeMB = audioSizeBytes / (1024 * 1024);
    console.log(`[speech/transcribe] Audio size: ${audioSizeMB.toFixed(2)} MB`);

    if (audioSizeMB > 25) {
      return Response.json(
        { error: 'Audio file too large. Maximum size is 25MB.' },
        { status: 400 }
      );
    }

    const env = getEnv(context);

    const result = await transcribeAudioBase64(env.AI as never, audio);

    return Response.json({ text: result.text });
  } catch (e) {
    console.error('[speech/transcribe] Error:', e);
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    return Response.json(
      { error: `Failed to transcribe audio: ${errorMessage}` },
      { status: 500 }
    );
  }
}
