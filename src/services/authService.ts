import * as vscode from 'vscode';

/**
 * Authentication service for Clerk integration.
 * Manages login flows and session token storage via SecretStorage.
 */
export class AuthService {
  private context: vscode.ExtensionContext;
  private sessionToken: string | null = null;
  private userId: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Initialize auth service - check if user has existing session
   */
  async initialize(): Promise<boolean> {
    const token = await this.context.secrets.get('vanguard.sessionToken');
    const userId = await this.context.secrets.get('vanguard.userId');
    
    if (token && userId) {
      this.sessionToken = token;
      this.userId = userId;
      return true;
    }
    return false;
  }

  /**
   * Show Clerk login webview panel
   */
  async showLoginPanel(): Promise<boolean> {
    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        'vanguardLogin',
        'Vanguard Login',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
        }
      );

      panel.webview.html = this.getLoginHTML();

      // Listen for token message from webview
      const messageHandler = async (message: any) => {
        if (message.type === 'tokenReady') {
          // User successfully logged in
          this.sessionToken = message.token;
          this.userId = message.userId;

          // Store in SecretStorage (OS keychain)
          await this.context.secrets.store('vanguard.sessionToken', message.token);
          await this.context.secrets.store('vanguard.userId', message.userId);

          panel.dispose();
          resolve(true);
        }
      };

      panel.webview.onDidReceiveMessage(messageHandler);

      // If user closes panel without logging in
      panel.onDidDispose(() => {
        resolve(false);
      });
    });
  }

  /**
   * Get the HTML for Clerk login webview
   */
  private getLoginHTML(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Vanguard Login</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 40px;
            max-width: 400px;
            width: 100%;
            text-align: center;
          }
          h1 {
            color: #1a1a1a;
            font-size: 28px;
            margin-bottom: 10px;
          }
          .subtitle {
            color: #666;
            font-size: 14px;
            margin-bottom: 30px;
          }
          #clerk-container {
            margin: 30px 0;
          }
          .error {
            background: #fee;
            color: #c00;
            padding: 12px;
            border-radius: 6px;
            margin: 20px 0;
            font-size: 14px;
            display: none;
          }
          .loading {
            color: #667eea;
            font-size: 14px;
            margin-top: 20px;
            display: none;
          }
          .spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid #667eea;
            border-top: 2px solid transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Vanguard</h1>
          <p class="subtitle">AI-Powered Component Mutations</p>
          <div id="clerk-container"></div>
          <div class="error" id="error-message"></div>
          <div class="loading" id="loading">
            <div class="spinner"></div> Signing in...
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          
          // Check if Clerk is available in VS Code environment
          // If not, show manual token entry
          window.addEventListener('load', () => {
            initializeAuth();
          });

          async function initializeAuth() {
            try {
              // For now, we'll use a simple mock implementation
              // In production, you'd integrate with Clerk's web SDK
              showMockLogin();
            } catch (err) {
              showError('Failed to initialize authentication');
            }
          }

          function showMockLogin() {
            const container = document.getElementById('clerk-container');
            container.innerHTML = \`
              <div style="padding: 20px; background: #f5f5f5; border-radius: 8px;">
                <p style="margin-bottom: 15px; color: #666; font-size: 14px;">
                  VS Code Login (Development Mode)
                </p>
                <input 
                  type="email" 
                  id="email" 
                  placeholder="Email" 
                  style="width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;"
                />
                <button 
                  onclick="handleMockLogin()"
                  style="
                    width: 100%;
                    padding: 10px;
                    background: #667eea;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    font-weight: 600;
                    cursor: pointer;
                    font-size: 14px;
                    margin-top: 10px;
                  "
                >
                  Sign In
                </button>
              </div>
            \`;
          }

          async function handleMockLogin() {
            const email = document.getElementById('email')?.value;
            if (!email) {
              showError('Please enter your email');
              return;
            }

            document.getElementById('loading').style.display = 'block';
            
            // Simulate auth delay
            await new Promise(r => setTimeout(r, 1000));

            // Generate mock tokens for testing
            // In production, this comes from Clerk's API
            const mockToken = 'mock_jwt_' + Date.now();
            const mockUserId = 'user_' + Math.random().toString(36).substr(2, 9);

            // Send token to extension
            vscode.postMessage({
              type: 'tokenReady',
              token: mockToken,
              userId: mockUserId,
              email: email
            });
          }

          function showError(message) {
            const errorDiv = document.getElementById('error-message');
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
            document.getElementById('loading').style.display = 'none';
          }

          // Allow Enter key to submit
          document.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
              handleMockLogin();
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  /**
   * Get current session token
   */
  getSessionToken(): string | null {
    return this.sessionToken;
  }

  /**
   * Get current user ID
   */
  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return !!this.sessionToken && !!this.userId;
  }

  /**
   * Logout and clear stored credentials
   */
  async logout(): Promise<void> {
    this.sessionToken = null;
    this.userId = null;
    await this.context.secrets.delete('vanguard.sessionToken');
    await this.context.secrets.delete('vanguard.userId');
  }
}

let authService: AuthService | null = null;

/**
 * Initialize global auth service
 */
export function initializeAuthService(context: vscode.ExtensionContext): AuthService {
  authService = new AuthService(context);
  return authService;
}

/**
 * Get global auth service instance
 */
export function getAuthService(): AuthService {
  if (!authService) {
    throw new Error('Auth service not initialized');
  }
  return authService;
}
