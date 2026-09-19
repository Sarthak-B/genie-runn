import { roomAction, redisClient } from '../lib/rooms.js';

const DEFAULT_ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// TURN credentials here are short-lived/client-usable relay credentials, never a provider API key.
export function iceServers(env = process.env) {
  if (!env.GENIE_ICE_SERVERS) return DEFAULT_ICE;
  try {
    const servers = JSON.parse(env.GENIE_ICE_SERVERS);
    if (!Array.isArray(servers) || !servers.length || servers.length > 8) return DEFAULT_ICE;
    const clean = servers.map(server => {
      if (!server || typeof server !== 'object') throw new Error('Invalid ICE server');
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== 'string' || url.length > 512 || !/^(stun|stuns|turn|turns):[^\s]+$/i.test(url))) throw new Error('Invalid ICE URL');
      if (server.username !== undefined && (typeof server.username !== 'string' || server.username.length > 512)) throw new Error('Invalid relay username');
      if (server.credential !== undefined && (typeof server.credential !== 'string' || server.credential.length > 512)) throw new Error('Invalid relay credential');
      return { urls: Array.isArray(server.urls) ? urls : urls[0], ...(server.username !== undefined ? { username: server.username } : {}), ...(server.credential !== undefined ? { credential: server.credential } : {}) };
    });
    return clean;
  } catch { return DEFAULT_ICE; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST for friend rooms.' });
  }
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Open friend rooms from the game website.' });
    } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
  }
  let body;
  try {
    let raw = req.body;
    if (raw === undefined) {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 12000) return res.status(413).json({ error: 'Room request is too large.' });
        chunks.push(Buffer.from(chunk));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    if (Buffer.byteLength(typeof raw === 'string' ? raw : JSON.stringify(raw)) > 12000) return res.status(413).json({ error: 'Room request is too large.' });
    body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
  } catch { return res.status(400).json({ error: 'Invalid room request.' }); }
  try {
    const result = await roomAction(body, redisClient());
    // Supply connection configuration only with an authenticated room response.
    if (result.status === 200) result.body.iceServers = iceServers();
    return res.status(result.status).json(result.body);
  } catch { return res.status(503).json({ error: 'Friend connection is temporarily unavailable. Please try again.' }); }
}
