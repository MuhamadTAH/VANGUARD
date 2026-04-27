import express, { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Extend Express Request type to include userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// Middleware
app.use(express.json());
app.use(express.text({ type: 'text/event-stream' }));

// In-memory database (replace with real DB in production)
const users: Record<string, { id: string; email: string; createdAt: Date }> = {};
const subscriptions: Record<string, { userId: string; tier: 'free' | 'pro' | 'pro_plus'; paddleSubscriptionId?: string; createdAt: Date }> = {};
const mutations: Record<string, { userId: string; createdAt: Date }> = {};
const triplets: Record<string, { userId: string; originalOutput: string; userFeedback: string; finalOutput: string; createdAt: Date }> = {};

/**
 * Mock authentication middleware
 * In production, use @clerk/backend to verify JWT tokens
 */
async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  // Mock token validation (in production: use Clerk)
  if (!token.startsWith('mock_jwt_') && !token.startsWith('sk_')) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Extract user ID from token (mock implementation)
  // In production: decode JWT and validate with Clerk
  const userId = token.includes('user_') ? token.split('_')[1] : 'user_' + Date.now();

  // Ensure user exists
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      email: `user-${userId}@vanguard.local`,
      createdAt: new Date(),
    };
  }

  // Ensure subscription exists
  if (!subscriptions[userId]) {
    subscriptions[userId] = {
      userId,
      tier: 'free',
      createdAt: new Date(),
    };
  }

  req.userId = userId;
  next();
}

// POST /mutate - Stream mutations through quota check
app.post('/mutate', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { context, prompt, attempt } = req.body;

  console.log(`[Mutation] User ${userId} requesting mutation`);

  // Check quota
  const subscription = subscriptions[userId];
  if (!subscription) {
    return res.status(404).json({ error: 'Subscription not found' });
  }

  if (subscription.tier === 'free') {
    const mutationCount = getMutationCountThisMonth(userId);
    console.log(`[Quota] User ${userId}: ${mutationCount}/20 mutations used`);

    if (mutationCount >= 20) {
      return res.status(402).json({
        error: 'quota_exceeded',
        message: 'Free tier limit reached (20/month). Upgrade to Pro for unlimited mutations.',
        mutations_used: mutationCount,
        mutations_limit: 20,
      });
    }
  }

  // Set streaming headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // Proxy to OpenRouter/DeepSeek
    console.log(`[AI] Proxying mutation to OpenRouter for user ${userId}`);

    const systemPrompt = buildSystemPrompt(context);
    const userPrompt = prompt;

    const aiResponse = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-chat',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY || 'test'}`,
          'HTTP-Referer': 'https://vanguard.dev',
          'X-Title': 'Vanguard Engine',
        },
        responseType: 'stream',
      }
    );

    // Stream SSE events to client
    let totalTokens = 0;
    let firstTokenTime = 0;

    aiResponse.data.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      const lines = text.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const json = JSON.parse(line.slice(6));

            if (json.choices?.[0]?.delta?.content) {
              const token = json.choices[0].delta.content;
              totalTokens++;

              if (firstTokenTime === 0) {
                firstTokenTime = Date.now();
              }

              // Send token to client
              res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
            }
          } catch (e) {
            // Ignore JSON parse errors
          }
        }
      }
    });

    aiResponse.data.on('end', async () => {
      console.log(`[Mutation] Completed with ${totalTokens} tokens for user ${userId}`);

      // Increment mutation count
      mutations[uuidv4()] = {
        userId,
        createdAt: new Date(),
      };

      // Send completion marker
      res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
      res.end();

      console.log(`[Quota] User ${userId} now has ${getMutationCountThisMonth(userId)}/20 mutations`);
    });

    aiResponse.data.on('error', (error: Error) => {
      console.error(`[AI Error] ${error.message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
      res.end();
    });
  } catch (error) {
    console.error(`[Error] Mutation failed:`, error);
    res.status(500).json({
      error: 'mutation_failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /status - Return subscription + mutation count
app.get('/status', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const subscription = subscriptions[userId];
  const mutationCount = getMutationCountThisMonth(userId);

  res.json({
    tier: subscription?.tier || 'free',
    mutations_remaining: subscription?.tier === 'free' ? Math.max(0, 20 - mutationCount) : 999999,
    mutations_used: mutationCount,
    createdAt: subscription?.createdAt,
  });
});

// POST /webhook/paddle - Handle Paddle payment events
app.post('/webhook/paddle', express.json(), async (req: Request, res: Response) => {
  const event = req.body;
  console.log(`[Paddle] Webhook: ${event.type}`);

  // In production, verify Paddle webhook signature here
  // For now, accept all events

  if (event.type === 'subscription.created' || event.type === 'subscription.updated') {
    const customerId = event.data?.customer_id;
    const priceId = event.data?.items?.[0]?.price?.id;

    console.log(`[Paddle] Subscription event: customer=${customerId}, price=${priceId}`);

    // Determine tier based on price
    let tier: 'free' | 'pro' | 'pro_plus' = 'free';
    if (priceId === process.env.PADDLE_PRICE_PRO_TIER) {
      tier = 'pro';
    } else if (priceId === process.env.PADDLE_PRICE_PRO_PLUS_TIER) {
      tier = 'pro_plus';
    }

    // Find user by Paddle customer ID
    const userId = Object.entries(subscriptions).find(
      ([_, sub]) => sub.paddleSubscriptionId === customerId
    )?.[0];

    if (userId) {
      subscriptions[userId].tier = tier;
      console.log(`[Paddle] Updated user ${userId} to tier: ${tier}`);
    }
  }

  res.json({ success: true });
});

// POST /collect-triplet - Store mutation triplet data
app.post('/collect-triplet', authMiddleware, express.json(), async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { originalOutput, userFeedback, finalOutput } = req.body;

  if (!originalOutput || !userFeedback || !finalOutput) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const tripletId = uuidv4();
  triplets[tripletId] = {
    userId,
    originalOutput,
    userFeedback,
    finalOutput,
    createdAt: new Date(),
  };

  console.log(`[Triplet] Stored triplet ${tripletId} for user ${userId}`);

  res.json({ id: tripletId, success: true });
});

// GET /checkout/:tier - Redirect to Paddle checkout
app.get('/checkout/:tier', (req: Request, res: Response) => {
  const tier = req.params.tier;
  // In production, generate Paddle checkout URL
  const checkoutUrl = `https://checkout.paddle.com/pay/${
    tier === 'pro' ? process.env.PADDLE_PRICE_PRO_TIER : process.env.PADDLE_PRICE_PRO_PLUS_TIER
  }`;
  res.redirect(checkoutUrl);
});

// GET /health - Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Helper functions
function getMutationCountThisMonth(userId: string): number {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);

  return Object.values(mutations).filter(
    (m) => m.userId === userId && m.createdAt >= firstDay
  ).length;
}

function buildSystemPrompt(context: any): string {
  return `You are Vanguard, an AI engine for component mutations.
Context: ${JSON.stringify(context)}
Return only the mutated component code, no explanation.`;
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Vanguard API Proxy running on http://localhost:${PORT}`);
  console.log(`📊 Endpoints ready: /mutate, /status, /webhook/paddle, /collect-triplet`);
});
