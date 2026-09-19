import { roomAction, redisClient } from '../lib/rooms.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='POST')return res.status(405).json({error:'Use POST.'});
 const origin=req.headers.origin;
 if(origin){try{if(new URL(origin).host!==req.headers.host)return res.status(403).json({error:'Open the game on its own website.'});}catch{return res.status(403).json({error:'Invalid origin.'});}}
 try{
  const raw=typeof req.body==='string'?req.body:JSON.stringify(req.body??{});
  if(Buffer.byteLength(raw)>12000)return res.status(413).json({error:'Message too large.'});
  let body;try{body=JSON.parse(raw);}catch{return res.status(400).json({error:'Invalid message.'});}
  if(!body||typeof body!=='object'||Array.isArray(body))return res.status(400).json({error:'Invalid message.'});
  const redis=redisClient();
  if(redis&&body.action==='create'){
   const ip=String(req.headers['x-real-ip']||req.socket?.remoteAddress||'unknown');
   const bucket='genie:limit:'+ip+':'+Math.floor(Date.now()/60000);
   const count=await redis('EVAL',"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],120) end; return n",1,bucket);
   if(count>10)return res.status(429).json({error:'Please wait a minute before creating another room.'});
  }
  const result=await roomAction(body,redis);return res.status(result.status).json(result.body);
 }catch{return res.status(503).json({error:'Connection interrupted. Please try again.'});}
}
