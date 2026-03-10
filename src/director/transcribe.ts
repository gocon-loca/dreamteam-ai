/**
 * Voice Transcription Service
 * Uses OpenAI Whisper API to transcribe voice notes from Telegram
 */

import OpenAI from 'openai';
import { createReadStream, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let openai: OpenAI | null = null;

export function initTranscription(apiKey: string): void {
  openai = new OpenAI({ apiKey });
}

export function isTranscriptionEnabled(): boolean {
  return openai !== null;
}

/**
 * Transcribe audio buffer to text using Whisper
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'voice.ogg'
): Promise<string> {
  if (!openai) {
    throw new Error('Transcription not initialized - missing OpenAI API key');
  }

  // Write buffer to temp file (Whisper API needs a file)
  const tempPath = join(tmpdir(), `dreamteam-voice-${Date.now()}.ogg`);

  try {
    writeFileSync(tempPath, audioBuffer);

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(tempPath),
      model: 'whisper-1',
      language: 'en', // Can be made configurable
      response_format: 'text',
    });

    return transcription.trim();
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Download file from Telegram and transcribe
 */
export async function transcribeTelegramVoice(
  fileUrl: string
): Promise<string> {
  // Download the file
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download voice file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return transcribeAudio(buffer);
}
