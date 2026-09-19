# Genie Run — Vercel edition

The game and multiplayer API deploy together on Vercel. Upstash Redis stores the shared rooms. No ChatGPT hosting or Cloudflare database is used.

## Deploy

1. Extract this folder and upload its contents to a GitHub repository. Keep `api`, `lib`, `public`, `scripts`, `package.json`, and `vercel.json` together at the repository root.
2. In Vercel, choose **Add New → Project** and import that repository. Choose **Other** for the framework. The included configuration sets `npm run build` and the `dist` output folder automatically.
3. Connect an **Upstash Redis** database through your Vercel project's Storage/Marketplace integration. Choose a database region near your Vercel function region.
4. In Vercel's environment variables, confirm `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are available for Production (and Preview if needed). The integration may instead provide `KV_REST_API_URL` and `KV_REST_API_TOKEN`; those names also work. Use the writable token, not the read-only token. Never put tokens in the HTML or commit an `.env` file.
5. Deploy or redeploy after adding the variables. Open your production HTTPS address. Ensure its deployment protection settings let your friend access it.
6. Select **Play with a friend**, copy the invite, and send it to your partner. Your partner opens it on another device. Both select **Ready** to begin.

Alternatively, from this folder use the Vercel CLI: `npx vercel`, connect Redis and the environment variables, then `npx vercel --prod`.

Official setup references: [Vercel Redis integrations](https://vercel.com/docs/redis) and [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js).

## What is included

- Fixed the animation reference that stopped the first frame and caused a black game view.
- Preserved solo play, obstacles, scoring, mobile controls and the existing game design.
- Two genies run side by side with synchronized hurdles, shared pause, collisions and replay.
- Room state persists across Vercel function instances. Atomic updates prevent simultaneous joins or movement updates from overwriting each other.
- Invite links use your deployed address automatically. Opening the standalone HTML supports solo play and explains where to open multiplayer, instead of redirecting to ChatGPT.
- Rooms expire after 30 minutes without activity. Leaving closes the room. The game is cooperative: a collision ends the run for both players.

## Local checks and limitations

Use `npx vercel dev` with your environment variables to run the frontend and API together. Opening `public/index.html` directly runs solo only.

The animation and room service were checked locally, including concurrent joining, ready state, ordered movement, pause/resume, collision/replay and disconnected players. A live Vercel deployment and an actual two-device internet session still need to be verified after deployment.

Multiplayer uses frequent HTTP updates with interpolated movement (approximately every 120 ms plus request time while running). Network latency affects responsiveness. These updates consume Vercel requests and Redis commands; check usage during a public launch. The page also needs internet access to load its existing Three.js library.

If friend rooms report a storage setup error, check the environment variable names, writable Redis token and redeploy. If an invite is closed or full, create a fresh room. No real platform account access or paid rewards are activated by the game.
