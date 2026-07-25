// ElevenLabs connector (SPEC §5, minimal): one TTS call, briefing text -> mp3.

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // public default voice

export async function textToSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY fehlt (.env)");
  const client = new ElevenLabsClient({ apiKey });

  const stream = await client.textToSpeech.convert(
    process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID,
    { text, modelId: "eleven_multilingual_v2", outputFormat: "mp3_44100_128" },
  );

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
