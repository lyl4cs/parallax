/**
 * Mock Tradovate Service for Development
 * Simulates Tradovate API responses without requiring real credentials
 */
export class TradovateServiceMock {
  constructor(username, password, cid, secret, environment = 'sandbox') {
    this.username = username;
    this.password = password;
    this.cid = cid;
    this.secret = secret;
    this.environment = environment;
    
    this.accessToken = 'mock_token_' + Date.now();
    this.refreshToken = 'mock_refresh_' + Date.now();
    this.tokenExpiry = Date.now() + 3600000; // 1 hour
    this.accountId = cid || 'mock_account_' + Math.random().toString(36).substr(2, 9);
    
    this.ws = null;
    this.listeners = new Map();
    this.mockPositions = [];
    this.mockOrders = [];
    this.wsInterval = null;
    
    // Simulate some initial positions
    this.initMockData();
  }

  initMockData() {
    // Mock positions
    this.mockPositions = [
      {
        id: 'pos_1',
        accountId: this.accountId,
        symbol: 'MES',
        qty: 2,
        avgPrice: 4250.50,
        unrealizedPnl: 125.75
      },
      {
        id: 'pos_2',
        accountId: this.accountId,
        symbol: 'MNQ',
        qty: -1,
        avgPrice: 14500.25,
        unrealizedPnl: -45.50
      }
    ];
    
    // Mock recent orders
    this.mockOrders = [
      {
        id: 'ord_1',
        accountId: this.accountId,
        symbol: 'MES',
        action: 'Buy',
        orderQty: 2,
        filledQty: 2,
        status: 'Filled',
        orderType: 'Market',
        timestamp: Date.now() - 300000
      }
    ];
  }

  async authenticate(accountId = null) {
    // Simulate authentication delay
    await new Promise(resolve => setTimeout(resolve, 300));
    
    this.accountId = accountId || this.accountId;
    return {
      success: true,
      token: this.accessToken,
      userId: this.accountId
    };
  }

  async refreshAccessToken() {
    await new Promise(resolve => setTimeout(resolve, 100));
    this.accessToken = 'mock_token_' + Date.now();
    this.tokenExpiry = Date.now() + 3600000;
    return { success: true, token: this.accessToken };
  }

  async ensureAuthenticated() {
    if (Date.now() > this.tokenExpiry - 300000) {
      await this.refreshAccessToken();
    }
  }

  async getPositions(accountId) {
    await this.ensureAuthenticated();
    await new Promise(resolve => setTimeout(resolve, 150));
    return this.mockPositions.filter(p => p.accountId === accountId);
  }

  async getOrders(accountId) {
    await this.ensureAuthenticated();
    await new Promise(resolve => setTimeout(resolve, 150));
    return this.mockOrders.filter(o => o.accountId === accountId);
  }

  async placeOrder(orderData) {
    await this.ensureAuthenticated();
    
    // Simulate order placement delay
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const orderId = 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Simulate order
    const mockOrder = {
      id: orderId,
      orderId: orderId,
      accountId: orderData.accountId,
      symbol: orderData.symbol,
      action: orderData.action,
      orderQty: orderData.orderQty,
      orderType: orderData.orderType || 'Market',
      status: 'Filled',
      filledQty: orderData.orderQty,
      timestamp: Date.now()
    };
    
    this.mockOrders.unshift(mockOrder);
    
    // Update position based on order
    const existingPos = this.mockPositions.find(
      p => p.accountId === orderData.accountId && p.symbol === orderData.symbol
    );
    
    const qtyChange = orderData.action === 'Buy' || orderData.action === 'BuyToCover' 
      ? orderData.orderQty 
      : -orderData.orderQty;
    
    if (existingPos) {
      existingPos.qty += qtyChange;
    } else if (qtyChange !== 0) {
      this.mockPositions.push({
        id: 'pos_' + Date.now(),
        accountId: orderData.accountId,
        symbol: orderData.symbol,
        qty: qtyChange,
        avgPrice: Math.random() * 1000 + 4000,
        unrealizedPnl: (Math.random() - 0.5) * 200
      });
    }
    
    // Broadcast position update via WebSocket
    if (this.wsInterval) {
      this.broadcastPositionUpdate();
    }
    
    return mockOrder;
  }

  async cancelOrder(orderId) {
    await this.ensureAuthenticated();
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const order = this.mockOrders.find(o => o.id === orderId);
    if (order) {
      order.status = 'Cancelled';
    }
    
    return { success: true, orderId };
  }

  async flattenPosition(accountId, symbol) {
    await this.ensureAuthenticated();
    const positions = this.mockPositions.filter(
      p => p.accountId === accountId && p.symbol === symbol
    );
    
    const results = [];
    for (const position of positions) {
      if (position.qty !== 0) {
        const orderData = {
          accountId: accountId,
          action: position.qty > 0 ? 'Sell' : 'Buy',
          symbol: symbol,
          orderQty: Math.abs(position.qty),
          orderType: 'Market'
        };
        
        const result = await this.placeOrder(orderData);
        results.push({ success: true, order: orderData, result });
      }
    }
    
    return results;
  }

  connectWebSocket(accountId, onMessage, onError, onClose) {
    // Simulate WebSocket connection
    setTimeout(() => {
      if (onMessage) {
        // Send initial account list
        onMessage({
          m: 1,
          i: 1,
          d: [{
            id: this.accountId,
            name: this.username,
            accountType: 'Live'
          }]
        });
        
        // Start periodic updates
        this.wsInterval = setInterval(() => {
          // Randomly send position updates
          if (Math.random() > 0.7) {
            this.broadcastPositionUpdate();
          }
        }, 5000);
      }
    }, 500);
    
    // Store callbacks for mock updates
    this.onMessage = onMessage;
    this.onError = onError;
    this.onClose = onClose;
  }

  broadcastPositionUpdate() {
    if (this.onMessage) {
      this.onMessage({
        m: 1,
        i: Date.now(),
        d: {
          positions: this.mockPositions.map(p => ({
            ...p,
            qty: p.qty + (Math.random() - 0.5) * 0.1 // Slight variation
          })),
          timestamp: Date.now()
        }
      });
    }
  }

  sendWebSocketMessage(message) {
    // In mock mode, simulate message acknowledgment
    if (this.onMessage) {
      setTimeout(() => {
        this.onMessage({
          m: 0,
          i: message.i,
          d: { status: 'acknowledged' }
        });
      }, 50);
    }
  }

  addListener(id, callback) {
    this.listeners.set(id, callback);
  }

  removeListener(id) {
    this.listeners.delete(id);
  }

  disconnect() {
    if (this.wsInterval) {
      clearInterval(this.wsInterval);
      this.wsInterval = null;
    }
    if (this.onClose) {
      this.onClose();
    }
    this.onMessage = null;
    this.onError = null;
    this.onClose = null;
  }
}
