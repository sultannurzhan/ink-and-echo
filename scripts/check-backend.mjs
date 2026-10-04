import { resolveApiUrl } from '../lib/client/api-url.ts';

const origin = process.env.INK_API_ORIGIN;
if (!origin || !origin.startsWith('https://') || new URL(origin).hostname.endsWith('.chatgpt.site')) {
  throw new Error('Set INK_API_ORIGIN to the verified conventional HTTPS Worker origin. Pages cannot run multiplayer by itself.');
}
const response = await fetch(resolveApiUrl('/api/health', origin, true), {
  headers: { Origin: 'https://sultannurzhan.github.io' }, signal: AbortSignal.timeout(15_000),
});
const body = await response.json();
if (!response.ok || body.app !== 'ink-and-echo' || body.database !== 'ready' ||
    response.headers.get('access-control-allow-origin') !== 'https://sultannurzhan.github.io') {
  throw new Error('The multiplayer backend or exact Pages CORS origin is not ready.');
}
console.log('Verified Ink & Echo database readiness and Pages origin.');
