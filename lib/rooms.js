import { randomBytes, randomInt } from 'node:crypto';
const token=()=>randomBytes(24).toString('hex');
const seed=()=>randomInt(0,4294967296);
const validToken=v=>typeof v==='string'&&/^[a-f0-9]{48}$/.test(v);
const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
function validState(s,host){
 if(s&&((s.vx!==undefined&&!finite(s.vx,-100,100))||(s.vy!==undefined&&!finite(s.vy,-100,100))||(s.lane!==undefined&&(!Number.isInteger(s.lane)||s.lane < -1||s.lane > 1))||(s.slideT!==undefined&&!finite(s.slideT,-1,2))))return false;
 if(!s||!finite(s.x,-5,5)||!finite(s.y,0,20)||!finite(s.phase,0,1e12)||!finite(s.slide,0,1)||!finite(s.run,0,1)||!finite(s.pitch,-2,2)||!finite(s.rotation,-7,7)||!finite(s.score,0,1e12))return false;
 if(host&&((s.wave!==undefined&&(!Number.isInteger(s.wave)||s.wave<0))||(s.spawnAt!==undefined&&!finite(s.spawnAt,0,1e10))))return false;
 if(host&&(!finite(s.distance,0,1e9)||!finite(s.speed,0,1e7)||!Array.isArray(s.obstacles)||s.obstacles.length>48))return false;
 return !host||s.obstacles.every(o=>Array.isArray(o)&&o.length===5&&Number.isInteger(o[0])&&o[0]>=0&&o[0]<48&&Number.isInteger(o[1])&&o[1]>=0&&o[1]<8&&Number.isInteger(o[2])&&o[2]>=-1&&o[2]<=1&&finite(o[3],-100,20)&&Number.isSafeInteger(o[4])&&o[4]>=0);
}
function view(r,role,now){
 return {room:r.id,role,phase:r.phase,round:r.round,seed:r.seed,startAt:r.start_at,serverTime:now,selfSeq:r[role+'_seq'],otherSeq:r[(role==='host'?'guest':'host')+'_seq'],otherTime:r[(role==='host'?'guest':'host')+'_state_at']??null,worldTime:r.host_state_at??null,hostReady:!!r.host_ready,guestReady:!!r.guest_ready,joined:!!r.guest_token,hostSeen:r.host_seen,guestSeen:r.guest_seen,hit:r.hit,reason:r.reason,other:JSON.parse((role==='host'?r.guest_state:r.host_state)||'null'),self:JSON.parse((role==='host'?r.host_state:r.guest_state)||'null'),world:JSON.parse(r.host_state||'null')};
}

const reply=(error,status)=>({status,body:{error}});
const CAS="if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1 else return 0 end";
export function redisClient(env=process.env) {
 const url=env.UPSTASH_REDIS_REST_URL||env.KV_REST_API_URL;
 const secret=env.UPSTASH_REDIS_REST_TOKEN||env.KV_REST_API_TOKEN;
 if(!url||!secret)return null;
 return async (...command)=>{
  const res=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(6000)});
  if(!res.ok)throw new Error('Room storage unavailable');
  const data=await res.json();if(data.error)throw new Error('Room storage command failed');return data.result;
 };
}
export async function roomAction(b,redis,now=Date.now()) {
 if(!redis)return reply('Friend rooms need an Upstash Redis connection in Vercel. Solo play still works.',503);
 if(b.action==='create'){
  const r={id:token(),host_token:token(),guest_token:null,phase:'waiting',round:0,seed:seed(),host_ready:0,guest_ready:0,start_at:0,host_seen:now,guest_seen:0,host_state:null,guest_state:null,host_seq:-1,guest_seq:-1,hit:0,reason:''};
  await redis('SET','genie:room:'+r.id,JSON.stringify(r),'EX',1800,'NX');
  return {status:200,body:{...view(r,'host',now),token:r.host_token}};
 }
 if(!validToken(b.room))return reply('This invite is not valid.',400);
 const key='genie:room:'+b.room;
 for(let attempt=0;attempt<12;attempt++){
  const raw=await redis('GET',key);
  if(!raw)return reply('This room has closed. Ask your friend for a new invite.',404);
  const r=JSON.parse(raw);
  if(r.phase==='closed')return reply('This room has closed. Ask your friend for a new invite.',404);
  let role,secret;
  if(b.action==='join'){
   if(r.guest_token||r.phase!=='waiting')return reply('This room already has two players.',409);
   role='guest';secret=token();r.guest_token=secret;r.guest_seen=now;
  }else{
   role=validToken(b.token)&&(b.token===r.host_token?'host':b.token===r.guest_token?'guest':null);
   if(!role)return reply('Your room session is no longer valid. Open a fresh invite.',401);
   if(!['sync','ready','pause','resume','end','leave'].includes(b.action))return reply('Unknown room action.',400);
   r[role+'_seen']=now;
   const sameRound=b.round===r.round;
   if(b.action==='sync'&&b.state){
    if(!validState(b.state,role==='host')||!Number.isSafeInteger(b.seq)||b.seq<0)return reply('Invalid player movement.',400);
    if(sameRound&&b.seq>r[role+'_seq']&&['countdown','running','paused'].includes(r.phase)){
     r[role+'_state']=JSON.stringify(b.state);r[role+'_seq']=b.seq;r[role+'_state_at']=now;
    }
   }
   if(b.action==='ready'&&['waiting','over'].includes(r.phase))r[role+'_ready']=1;
   if(b.action==='pause'&&sameRound&&['countdown','running'].includes(r.phase)){r.phase='paused';r.reason=role+' paused the run';}
   if(b.action==='resume'&&sameRound&&r.phase==='paused'&&r.host_seen>now-6000&&r.guest_seen>now-6000){r.phase='running';r.reason='';}
   // Legacy clients may still report a hit. Hits never terminate a shared run.
   if(b.action==='leave')r.phase='closed';
   if(['waiting','over'].includes(r.phase)&&r.host_ready&&r.guest_ready&&r.guest_token&&r.host_seen>now-6000&&r.guest_seen>now-6000){
    r.phase='countdown';r.round++;r.seed=seed();r.start_at=now+4000;r.host_state=null;r.guest_state=null;r.host_seq=-1;r.guest_seq=-1;r.host_state_at=null;r.guest_state_at=null;r.reason='';
   }
   if(r.phase==='countdown'&&r.start_at<=now)r.phase='running';
   if(r.phase==='paused'&&r.reason==='Waiting for your friend to reconnect'&&r.host_seen>now-6000&&r.guest_seen>now-6000){r.phase='running';r.reason='';}
   if(r.phase==='running'&&(r.host_seen<now-15000||r.guest_seen<now-15000)){r.phase='paused';r.reason='Waiting for your friend to reconnect';}
  }
  if(await redis('EVAL',CAS,1,key,raw,JSON.stringify(r),r.phase==='closed'?60:1800)){
   return {status:200,body:{...view(r,role,now),...(secret?{token:secret}:{})}};
  }
 }
 return reply('Room is busy. Please try again.',503);
}
