import * as vscode from "vscode";
import type { PackedMutationContext } from "../mutation/contextPacker";
import { getAuthService } from "./authService";

// API proxy backend URL (from environment or default)
const API_PROXY_URL = process.env.VANGUARD_API_URL || "http://localhost:3000";

/**
 * Mutation API service that:
 * 1. Sends auth token with each request
 * 2. Checks quota and shows upgrade prompt on 402
 * 3. Streams responses from backend proxy
 */
export class MutationAPIService {
  private context: vscode.ExtensionContext;
  private lastQuotaCheck: { remaining: number; total: number; timestamp: number } | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Call mutation API with authentication and quota checking
   */
  async callMutationWithAuth(input: {
    context: PackedMutationContext;
    prompt: string;
    attempt: number;
    feedback?: string;
  }): Promise<string> {
    const authService = getAuthService();
    
    if (!authService.isAuthenticated()) {
      throw new Error('User not authenticated. Please sign in to use mutations.');
    }

    const sessionToken = authService.getSessionToken();
    if (!sessionToken) {
      throw new Error('Session token missing. Please sign in again.');
    }

    try {
      // Build request payload
      const requestPayload = {
        context: input.context,
        prompt: input.prompt,
        attempt: input.attempt,
        feedback: input.feedback,
      };

      // Call mutation API with streaming
      const response = await fetch(`${API_PROXY_URL}/mutate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(requestPayload),
      });

      // Handle 402 Payment Required (quota exceeded)
      if (response.status === 402) {
        await this.handleQuotaExceeded();
        throw new Error('Mutation limit exceeded');
      }

      // Handle auth errors
      if (response.status === 401) {
        await authService.logout();
        throw new Error('Authentication expired. Please sign in again.');
      }

      // Handle other errors
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error: ${response.statusText} - ${error}`);
      }

      // Stream response text
      if (!response.body) {
        throw new Error('No response body from API');
      }

      return await this.parseStreamResponse(response.body);
    } catch (error) {
      if (error instanceof Error && error.message === 'Mutation limit exceeded') {
        throw error;
      }
      throw new Error(`Mutation API error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check current quota status (non-mutation API call)
   */
  async checkQuota(): Promise<{ tier: string; remaining: number; used: number } | null> {
    const authService = getAuthService();
    
    if (!authService.isAuthenticated()) {
      return null;
    }

    try {
      const sessionToken = authService.getSessionToken();
      const response = await fetch(`${API_PROXY_URL}/status`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
        },
      });

      if (response.ok) {
        const data = await response.json() as any;
        return {
          tier: data.tier,
          remaining: data.mutations_remaining,
          used: data.mutations_used,
        };
      }
    } catch (error) {
      console.error('Failed to check quota:', error);
    }

    return null;
  }

  /**
   * Handle quota exceeded error - show upgrade prompt
   */
  private async handleQuotaExceeded(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      '🎯 You\'ve reached your free tier limit (20 mutations/month)',
      'Upgrade to Pro ($25/mo)',
      'Upgrade to Pro+ ($40/mo)',
      'Learn More'
    );

    if (choice === 'Upgrade to Pro ($25/mo)') {
      await vscode.env.openExternal(vscode.Uri.parse(`${API_PROXY_URL}/checkout/pro`));
    } else if (choice === 'Upgrade to Pro+ ($40/mo)') {
      await vscode.env.openExternal(vscode.Uri.parse(`${API_PROXY_URL}/checkout/pro_plus`));
    } else if (choice === 'Learn More') {
      await vscode.env.openExternal(vscode.Uri.parse('https://vanguard.dev/pricing'));
    }
  }

  /**
   * Parse streaming response from API
   */
  private async parseStreamResponse(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let result = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        
        // Parse SSE events
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'token') {
                result += data.content;
              } else if (data.type === 'error') {
                throw new Error(data.message);
              }
            } catch (e) {
              // Ignore malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return result;
  }

  /**
   * Get current billing status for display in UI
   */
  async getBillingStatus(): Promise<{ tier: string; message: string } | null> {
    const quota = await this.checkQuota();
    if (!quota) {
      return null;
    }

    let message = `Tier: ${quota.tier.toUpperCase()}`;
    
    if (quota.tier === 'free') {
      message += ` | ${quota.remaining}/${20 - quota.used} mutations remaining this month`;
    } else {
      message += ` | Unlimited mutations`;
    }

    return { tier: quota.tier, message };
  }
}

let mutationAPIService: MutationAPIService | null = null;

export function initializeMutationAPIService(context: vscode.ExtensionContext): MutationAPIService {
  mutationAPIService = new MutationAPIService(context);
  return mutationAPIService;
}

export function getMutationAPIService(): MutationAPIService {
  if (!mutationAPIService) {
    throw new Error('Mutation API service not initialized');
  }
  return mutationAPIService;
}
