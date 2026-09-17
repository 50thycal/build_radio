/**
 * Test environment.
 *
 * Set before any module under test is imported, because lib/config.ts reads
 * process.env once at import time — the same way it does in production.
 */
process.env.DATABASE_URL = 'file::memory:';
process.env.MEDIA_STORE_DRIVER = 'local';
process.env.ELEVENLABS_API_KEY = 'test-key-0123456789abcdef';
process.env.ELEVENLABS_HOST_VOICE_ID = 'voice-host';
process.env.ELEVENLABS_GUEST_VOICE_ID = 'voice-guest';
process.env.ELEVENLABS_MODEL_ID = 'eleven_v3';
process.env.ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
process.env.INTERNAL_GENERATION_SECRET = 'test-internal-secret';
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
