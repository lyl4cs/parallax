import axios from 'axios';
import WebSocket from 'ws';

/**
 * Tradovate API Service
 * Handles OAuth authentication, token refresh, WebSocket connections, and rate limiting
 */
export class TradovateService {
  constructor(apiKey, apiSecret, environment = 'sandbox') {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.environment = environment;
    this.baseUrl = environment === 'production' 
      ? 'https://api.tradovate.com' 
      : 'https://demo.tradovate.com';
    this.wsUrl = environment === 'production'
      ? 'wss://api.tradovate.com/v1/websocket'
      : 'wss://demo.tradovate.com/v1/websocket';
    
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.accountId = null;
    
    this.ws = null;
    this.wsReconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000; // Start with 1 second
    
    // Rate limiting
    this.rateLimit = {
      requestsPerMinute: 60,
      requests: [],
      queue: []
    };
    
    this.listeners = new Map();
  }

  /**
   * Rate limiting helper
   */
  async rateLimitedRequest(fn) {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        const now = Date.now();
        // Remove requests older than 1 minute
        this.rateLimit.requests = this.rateLimit.requests.filter(
          time => now - time < 60000
        );
        
        if (this.rateLimit.requests.length < this.rateLimit.requestsPerMinute) {
          this.rateLimit.requests.push(now);
          try {
            const result = await fn();
            resolve(result);
          } catch (error) {
            reject(error);
          }
          
          // Process next in queue
          if (this.rateLimit.queue.length > 0) {
            const next = this.rateLimit.queue.shift();
            setTimeout(execute, 100); // Small delay between requests
          }
        } else {
          // Queue the request
          this.rateLimit.queue.push(execute);
          const waitTime = 60000 - (now - this.rateLimit.requests[0]);
          setTimeout(execute, Math.max(1000, waitTime));
        }
      };
      
      execute();
    });
  }

  /**
   * Authenticate with Tradovate API
   */
  async authenticate(accountId = null) {
    try {
      const response = await this.rateLimitedRequest(async () => {
        return axios.post(`${this.baseUrl}/v1/auth/accesstokenrequest`, {
          name: this.apiKey,
          password: this.apiSecret,
          appId: 'Parallax',
          appVersion: '1.0.0',
          cid: accountId,
          sec: this.apiSecret
        });
      });

      if (response.data && response.data.accessToken) {
        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        this.tokenExpiry = Date.now() + (response.data.expirationTime || 3600000); // Default 1 hour
        this.accountId = response.data.userId || accountId;
        return { success: true, token: this.accessToken };
      }
      
      throw new Error('Authentication failed: Invalid response');
    } catch (error) {
      console.error('Tradovate authentication error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Refresh access token before expiry
   */
  async refreshAccessToken() {
    if (!this.refreshToken) {
      return await this.authenticate(this.accountId);
    }

    try {
      // Refresh 5 minutes before expiry
      if (this.tokenExpiry && Date.now() < this.tokenExpiry - 300000) {
        return { success: true, token: this.accessToken };
      }

      const response = await this.rateLimitedRequest(async () => {
        return axios.post(`${this.baseUrl}/v1/auth/refreshtokenrequest`, {
          accessToken: this.accessToken,
          refreshToken: this.refreshToken
        });
      });

      if (response.data && response.data.accessToken) {
        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        this.tokenExpiry = Date.now() + (response.data.expirationTime || 3600000);
        return { success: true, token: this.accessToken };
      }

      // If refresh fails, re-authenticate
      return await this.authenticate(this.accountId);
    } catch (error) {
      console.error('Token refresh error:', error.message);
      // Try re-authentication
      return await this.authenticate(this.accountId);
    }
  }

  /**
   * Ensure valid token before API calls
   */
  async ensureAuthenticated() {
    await this.refreshAccessToken();
    if (!this.accessToken) {
      throw new Error('Not authenticated with Tradovate');
    }
  }

  /**
   * Make authenticated API request
   */
  async apiRequest(method, endpoint, data = null) {
    await this.ensureAuthenticated();

    const config = {
      method,
      url: `${this.baseUrl}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      }
    };

    if (data) {
      config.data = data;
    }

    try {
      const response = await this.rateLimitedRequest(async () => {
        return axios(config);
      });
      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        // Token expired, refresh and retry once
        await this.authenticate(this.accountId);
        config.headers['Authorization'] = `Bearer ${this.accessToken}`;
        const retryResponse = await this.rateLimitedRequest(async () => {
          return axios(config);
        });
        return retryResponse.data;
      }
      throw error;
    }
  }

  /**
   * Connect WebSocket with exponential backoff reconnection
   */
  connectWebSocket(accountId, onMessage, onError, onClose) {
    const connect = async () => {
      await this.ensureAuthenticated();

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return;
      }

      try {
        this.ws = new WebSocket(`${this.wsUrl}?token=${this.accessToken}&cid=${accountId}`);

        this.ws.on('open', () => {
          console.log(`WebSocket connected for account ${accountId}`);
          this.wsReconnectAttempts = 0;
          this.reconnectDelay = 1000;

          // Subscribe to positions and orders
          this.sendWebSocketMessage({
            m: 0,
            i: 1,
            n: 'getAccountList'
          });

          this.sendWebSocketMessage({
            m: 0,
            i: 2,
            n: 'subscribe',
            o: JSON.stringify({
              positions: { accountId },
              orders: { accountId }
            })
          });
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (onMessage) {
              onMessage(message);
            }
            
            // Notify all listeners
            this.listeners.forEach((callback) => {
              try {
                callback(message);
              } catch (err) {
                console.error('Error in WebSocket listener:', err);
              }
            });
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          if (onError) {
            onError(error);
          }
          this.ws.close();
        });

        this.ws.on('close', () => {
          console.log(`WebSocket closed for account ${accountId}`);
          if (onClose) {
            onClose();
          }
          
          // Attempt reconnection with exponential backoff
          if (this.wsReconnectAttempts < this.maxReconnectAttempts) {
            const delay = Math.min(
              this.reconnectDelay * Math.pow(2, this.wsReconnectAttempts),
              60000 // Max 60 seconds
            );
            
            console.log(`Reconnecting in ${delay}ms (attempt ${this.wsReconnectAttempts + 1})`);
            
            setTimeout(() => {
              this.wsReconnectAttempts++;
              connect();
            }, delay);
          } else {
            console.error('Max reconnection attempts reached');
          }
        });

      } catch (error) {
        console.error('WebSocket connection error:', error);
        if (onError) {
          onError(error);
        }
      }
    };

    connect();
  }

  /**
   * Send message through WebSocket
   */
  sendWebSocketMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected, message not sent:', message);
    }
  }

  /**
   * Add WebSocket listener
   */
  addListener(id, callback) {
    this.listeners.set(id, callback);
  }

  /**
   * Remove WebSocket listener
   */
  removeListener(id) {
    this.listeners.delete(id);
  }

  /**
   * Get account positions
   */
  async getPositions(accountId) {
    return await this.apiRequest('GET', `/v1/position/list?accountId=${accountId}`);
  }

  /**
   * Get account orders
   */
  async getOrders(accountId) {
    return await this.apiRequest('GET', `/v1/order/list?accountId=${accountId}`);
  }

  /**
   * Place order
   */
  async placeOrder(orderData) {
    return await this.apiRequest('POST', '/v1/order/placeorder', orderData);
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    return await this.apiRequest('POST', '/v1/order/cancelorder', { orderId });
  }

  /**
   * Flatten position (close all for symbol)
   */
  async flattenPosition(accountId, symbol) {
    const positions = await this.getPositions(accountId);
    const symbolPositions = positions.filter(p => p.symbol === symbol);
    
    const orders = [];
    for (const position of symbolPositions) {
      if (position.qty !== 0) {
        orders.push({
          accountId: accountId,
          action: position.qty > 0 ? 'Sell' : 'Buy',
          symbol: symbol,
          orderQty: Math.abs(position.qty),
          orderType: 'Market',
          isAutomated: true
        });
      }
    }
    
    const results = [];
    for (const order of orders) {
      try {
        const result = await this.placeOrder(order);
        results.push({ success: true, order, result });
      } catch (error) {
        results.push({ success: false, order, error: error.message });
      }
    }
    
    return results;
  }

  /**
   * Close WebSocket connection
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
  }
}
