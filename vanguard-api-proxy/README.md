# Vanguard API Proxy

Backend API proxy for handling authentication, billing, and mutation streaming.

## Features

- ✅ Clerk authentication integration
- ✅ Paddle billing tier enforcement
- ✅ Mutation quota tracking (20/month for free tier)
- ✅ Streaming SSE support for mutations
- ✅ Triplet data collection for ML training
- ✅ Webhook support for payment updates

## Development

```bash
npm install
npm run dev
```

Server will run on `http://localhost:3000`

## Environment Variables

```env
PORT=3000
OPENROUTER_API_KEY=sk_...
PADDLE_SANDBOX_CLIENT_TOKEN=test_...
PADDLE_PRICE_PRO_TIER=pri_...
PADDLE_PRICE_PRO_PLUS_TIER=pri_...
```

## Deployment to Railway

1. Install Railway CLI: `npm i -g railway`
2. Link project: `railway link`
3. Set environment variables:
   ```
   railway variable set PORT=3000
   railway variable set OPENROUTER_API_KEY=sk_...
   railway variable set PADDLE_SANDBOX_CLIENT_TOKEN=test_...
   ```
4. Deploy: `railway up`
5. Get public URL: `railway open`

## API Endpoints

### POST /mutate
Proxy mutations through quota check with streaming response.

**Headers:**
- `Authorization: Bearer <sessionToken>`

**Body:**
```json
{
  "context": { ... },
  "prompt": "...",
  "attempt": 1
}
```

**Response:**
- 200: Streaming SSE with tokens
- 402: Quota exceeded (free tier limit)
- 401: Authentication failed

### GET /status
Get user's current subscription tier and mutation count.

**Headers:**
- `Authorization: Bearer <sessionToken>`

**Response:**
```json
{
  "tier": "free|pro|pro_plus",
  "mutations_remaining": 20,
  "mutations_used": 10
}
```

### POST /webhook/paddle
Handle payment events from Paddle.

**Body:**
Paddle event payload with subscription updates

### POST /collect-triplet
Store anonymized mutation triplet data.

**Headers:**
- `Authorization: Bearer <sessionToken>`

**Body:**
```json
{
  "originalOutput": "...",
  "userFeedback": "...",
  "finalOutput": "..."
}
```

## Production Considerations

- Replace in-memory DB with PostgreSQL/MongoDB
- Implement proper Clerk JWT verification
- Add Paddle webhook signature verification
- Add rate limiting and abuse prevention
- Use Redis for quota caching
- Implement request logging and monitoring
- Add health checks and auto-scaling
