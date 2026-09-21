import { randomBytes, randomInt } from 'node:crypto';

const token = () => randomBytes(24).toString('hex');
const seed = () => randomInt(0, 4294967296);
const validToken = v => typeof v === 'string' && /^[a-f0-9]{48}$/.test(v);
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const validSession = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
const HIT_PENALTY = 12;
const LOSING_GAP = 36;

function raceView(r) {
  const hostPenalty = (r.host_hits || 0) * HIT_PENALTY;
  const guestPenalty = (r.guest_hits || 0) * HIT_PENALTY;
  return { hostPenalty, guestPenalty, gap: hostPenalty - guestPenalty,
    winner: r.winner || null, lastHitBy: r.hit_by || null, lastHit: r.hit ?? null,
    hostEvent: r.host_hit_event || 0, guestEvent: r.guest_hit_event || 0 };
}

function validState(s, host) {
  if (s && ((s.vx !== undefined && !finite(s.vx, -100, 100)) || (s.vy !== undefined && !finite(s.vy, -100, 100)) || (s.lane !== undefined && (!Number.isInteger(s.lane) || s.lane < -1 || s.lane > 1)) || (s.slideT !== undefined && !finite(s.slideT, -1, 2)))) return false;
  if (!s || !finite(s.x, -5, 5) || !finite(s.y, 0, 20) || !finite(s.phase, 0, 1e12) || !finite(s.slide, 0, 1) || !finite(s.run, 0, 1) || !finite(s.pitch, -2, 2) || !finite(s.rotation, -7, 7) || !finite(s.score, 0, 1e12)) return false;
  // Older clients may omit these fields; validate them for either player when present.
  if ((s.distance !== undefined && !finite(s.distance, 0, 1e9)) ||
      (s.speed !== undefined && !finite(s.speed, 0, 1e7)) ||
      (s.racePenalty !== undefined && !finite(s.racePenalty, 0, 1e9)) ||
      (s.setbackLeft !== undefined && !finite(s.setbackLeft, 0, 1e9)) ||
      (s.slideQueued !== undefined && typeof s.slideQueued !== 'boolean')) return false;
  if (host && ((s.wave !== undefined && (!Number.isInteger(s.wave) || s.wave < 0)) || (s.spawnAt !== undefined && !finite(s.spawnAt, 0, 1e10)))) return false;
  if (host && (!finite(s.distance, 0, 1e9) || !finite(s.speed, 0, 1e7) || !Array.isArray(s.obstacles) || s.obstacles.length > 48)) return false;
  return !host || s.obstacles.every(o => Array.isArray(o) && o.length === 5 && Number.isInteger(o[0]) && o[0] >= 0 && o[0] < 48 && Number.isInteger(o[1]) && o[1] >= 0 && o[1] < 8 && Number.isInteger(o[2]) && o[2] >= -1 && o[2] <= 1 && finite(o[3], -100, 20) && Number.isSafeInteger(o[4]) && o[4] >= 0);
}

function validPeer(p, role) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !validSession(p.session)) return false;
  if (!['hello', 'offer', 'answer'].includes(p.kind)) return false;
  if (p.kind === 'offer' && role !== 'host' || p.kind === 'answer' && role !== 'guest') return false;
  if (p.target !== undefined && !validSession(p.target)) return false;
  if (p.sdp !== undefined && (typeof p.sdp !== 'string' || p.sdp.length > 9000)) return false;
  if (p.kind !== 'hello' && (!p.sdp || !p.target)) return false;
  return true;
}

function view(r, role, now) {
  const other = role === 'host' ? 'guest' : 'host';
  return {
    protocol: 'race-5', room: r.id, role, phase: r.phase, round: r.round,
    revision: r.revision || 0,
    seed: r.seed, startAt: r.start_at, serverTime: now,
    selfSeq: r[role + '_seq'], otherSeq: r[other + '_seq'],
    selfTime: r[role + '_state_at'] ?? null,
    otherTime: r[other + '_state_at'] ?? null, worldTime: r.host_state_at ?? null,
    hostReady: !!r.host_ready, guestReady: !!r.guest_ready, joined: !!r.guest_token,
    hostSeen: r.host_seen, guestSeen: r.guest_seen, hit: r.hit,
    hitBy: r.hit_by ?? null, reason: r.reason, race: raceView(r), otherPeer: r[other + '_peer'] ?? null,
    other: JSON.parse(r[other + '_state'] || 'null'),
    self: JSON.parse(r[role + '_state'] || 'null'),
    world: JSON.parse(r.host_state || 'null')
  };
}

const reply = (error, status) => ({ status, body: { error } });
const CAS = "if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1 else return 0 end";

export function redisClient(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const secret = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !secret) return null;
  return async (...command) => {
    const res = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) throw new Error('Room storage unavailable');
    const data = await res.json();
    if (data.error) throw new Error('Room storage command failed');
    return data.result;
  };
}

export async function roomAction(b, redis, now = Date.now()) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return reply('Invalid room request.', 400);
  if (!redis) return reply('Friend rooms need an Upstash Redis connection in Vercel. Solo play still works.', 503);
  if (b.action === 'create') {
    const r = {
      id: token(), host_token: token(), guest_token: null, phase: 'waiting', round: 0, seed: seed(), revision: 0,
      host_ready: 0, guest_ready: 0, start_at: 0, host_seen: now, guest_seen: 0,
      host_state: null, guest_state: null, host_seq: -1, guest_seq: -1,
      host_peer: null, guest_peer: null, hit: null, hit_by: null, reason: '',
      host_hits: 0, guest_hits: 0, host_hit_event: 0, guest_hit_event: 0,
      winner: null
    };
    const created = await redis('SET', 'genie:room:' + r.id, JSON.stringify(r), 'EX', 1800, 'NX');
    if (!created) return reply('Please try creating the room again.', 503);
    return { status: 200, body: { ...view(r, 'host', now), token: r.host_token } };
  }
  if (!validToken(b.room)) return reply('This invite is not valid.', 400);
  const key = 'genie:room:' + b.room;
  for (let attempt = 0; attempt < 12; attempt++) {
    const raw = await redis('GET', key);
    if (!raw) return reply('This room has closed. Ask your friend for a new invite.', 404);
    const r = JSON.parse(raw);
    if (r.phase === 'closed') return reply('This room has closed. Ask your friend for a new invite.', 404);
    let role, secret;
    if (b.action === 'join') {
      if (r.guest_token || r.phase !== 'waiting') return reply('This room already has two players.', 409);
      role = 'guest'; secret = token(); r.guest_token = secret; r.guest_seen = now;
    } else {
      role = validToken(b.token) && (b.token === r.host_token ? 'host' : b.token === r.guest_token ? 'guest' : null);
      if (!role) return reply('Your room session is no longer valid. Open a fresh invite.', 401);
      if (!['sync', 'ready', 'pause', 'resume', 'hit', 'leave', 'signal'].includes(b.action)) return reply('Unknown room action.', 400);
      r[role + '_seen'] = now;
      const sameRound = b.round === r.round;
      if (r.phase === 'countdown' && r.start_at <= now) r.phase = 'running';

      if (b.action === 'signal') {
        if (!validPeer(b.peer, role)) return reply('Invalid connection signal.', 400);
        const p = b.peer;
        // Copy only the bounded signalling fields; no arbitrary caller properties enter room state.
        r[role + '_peer'] = { session: p.session, kind: p.kind, ...(p.target ? { target: p.target } : {}), ...(p.sdp ? { sdp: p.sdp } : {}) };
      }
      if (b.action === 'sync' && b.state) {
        if (!validState(b.state, role === 'host') || !Number.isSafeInteger(b.seq) || b.seq < 0) return reply('Invalid player movement.', 400);
        if (sameRound && b.seq > r[role + '_seq'] && ['countdown', 'running', 'paused'].includes(r.phase)) {
          r[role + '_state'] = JSON.stringify(b.state); r[role + '_seq'] = b.seq; r[role + '_state_at'] = now;
        }
      }
      if (b.action === 'ready' && sameRound && ['waiting', 'over'].includes(r.phase)) r[role + '_ready'] = 1;
      if (b.action === 'pause' && sameRound && ['countdown', 'running'].includes(r.phase)) {
        r.phase = 'paused'; r.reason = role + ' paused the run';
      }
      if (b.action === 'resume' && sameRound && r.phase === 'paused') { r.phase = 'running'; r.reason = ''; }
      if (b.action === 'hit') {
        if (!Number.isInteger(b.hit) || b.hit < 0 || b.hit > 7) return reply('Invalid obstacle collision.', 400);
        if (!Number.isSafeInteger(b.event) || b.event < 1) return reply('Invalid collision event.', 400);
        // A reliable peer message and an HTTP retry can describe the same collision.
        // Acknowledge it once, including during a concurrent manual pause.
        if (sameRound && ['running', 'paused'].includes(r.phase) && b.event > (r[role + '_hit_event'] || 0)) {
          r[role + '_hit_event'] = b.event;
          r[role + '_hits'] = (r[role + '_hits'] || 0) + 1;
          r.hit = b.hit; r.hit_by = role;
          const gap = ((r.host_hits || 0) - (r.guest_hits || 0)) * HIT_PENALTY;
          if (Math.abs(gap) >= LOSING_GAP) {
            r.phase = 'over'; r.winner = gap > 0 ? 'guest' : 'host';
            r.host_ready = 0; r.guest_ready = 0; r.reason = 'lead';
          }
        }
      }
      if (b.action === 'leave') r.phase = 'closed';
      if (['waiting', 'over'].includes(r.phase) && r.host_ready && r.guest_ready && r.guest_token && r.host_seen > now - 6000 && r.guest_seen > now - 6000) {
        r.phase = 'countdown'; r.round++; r.seed = seed(); r.start_at = now + 4000;
        r.host_state = null; r.guest_state = null; r.host_seq = -1; r.guest_seq = -1;
        r.host_state_at = null; r.guest_state_at = null; r.hit = null; r.hit_by = null; r.reason = '';
        r.host_hits = 0; r.guest_hits = 0; r.host_hit_event = 0; r.guest_hit_event = 0;
        r.winner = null;
      }
      // Missed heartbeats only affect connection indicators. They never end or pause a run.
    }
    // The committed revision orders replies even when concurrent requests return out of order.
    // A failed CAS retries from the latest stored revision, including pre-revision rooms.
    r.revision = (Number.isSafeInteger(r.revision) && r.revision >= 0 ? r.revision : 0) + 1;
    if (await redis('EVAL', CAS, 1, key, raw, JSON.stringify(r), r.phase === 'closed' ? 60 : 1800)) {
      return { status: 200, body: { ...view(r, role, now), ...(secret ? { token: secret } : {}) } };
    }
  }
  return reply('Room is busy. Please try again.', 503);
}
