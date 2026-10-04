import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { TradovateService } from '../services/tradovate.js';
import { TradovateServiceMock } from '../services/tradovate-mock.js';
import { initEmailService, sendWaitlistConfirmation, sendBulkEmail } from '../services/email.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) {
  console.log('⚠️  Running in MOCK MODE - Tradovate API will be simulated');
}

// Initialize email service
initEmailService();

app.use(cors());
app.use(express.json());

// In-memory storage (replace with database in production)
const accounts = new Map();
const copyGroups = new Map();
const tradeLog = [];
const positions = new Map();
const leaderPositions = new Map();
const waitlist = new Set(); // Email waitlist for beta

// WebSocket server for real-time updates (only when not on Vercel)
let server;
let wss;

// Check if running on Vercel (serverless)
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV;

if (isVercel) {
  // On Vercel, WebSocket is not supported, so skip WebSocket initialization
  console.log('⚠️  Running on Vercel - WebSocket disabled');
  // Create a dummy wss for compatibility
  wss = {
    clients: new Set(),
    on: () => {}
  };
} else {
  // Local development - start server normally
  server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  wss = new WebSocketServer({ server });
}

// Broadcast to all connected clients
function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(message);
      } catch (error) {
        console.error('Error broadcasting to client:', error);
      }
    }
  });
}

/**
 * TradeCopier Class
 * Handles copying trades from leader account to follower accounts
 */
class TradeCopier {
  constructor(leaderAccountId, followerAccountIds, settings = {}) {
    this.leaderAccountId = leaderAccountId;
    this.followerAccountIds = Array.isArray(followerAccountIds) 
      ? followerAccountIds 
      : [followerAccountIds];
    this.isActive = true;
    this.lastSyncTime = Date.now();
    this.pendingOrders = new Map();
    this.positionSyncInterval = null;
    
    // Settings
    this.settings = {
      sizeMultiplier: settings.sizeMultiplier || 1.0, // Multiply position size
      maxPositionSize: settings.maxPositionSize || null, // Max size per symbol
      copyStopLoss: settings.copyStopLoss !== false, // Default true
      copyTakeProfit: settings.copyTakeProfit !== false, // Default true
      ...settings
    };
    
    // Start position reconciliation every 30 seconds
    this.startPositionReconciliation();
  }

  /**
   * Copy trade from leader to followers
   */
  async copyTrade(tradeEvent, leaderService) {
    if (!this.isActive) {
      return { success: false, reason: 'Copying is paused' };
    }

    const timestamp = Date.now();
    const logEntry = {
      id: `trade-${timestamp}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp,
      leaderAccount: this.leaderAccountId,
      event: tradeEvent,
      status: 'processing'
    };

    try {
      // Extract trade information from event
      const { action, symbol, qty, orderType = 'Market', limitPrice, stopPrice } = tradeEvent;

      if (!action || !symbol || !qty) {
        throw new Error('Invalid trade event: missing required fields');
      }

      const results = [];
      const startTime = Date.now();

      // Copy trade to each follower account
      for (const followerId of this.followerAccountIds) {
        const followerAccount = accounts.get(followerId);
        if (!followerAccount || !followerAccount.connected || !followerAccount.service) {
          results.push({
            accountId: followerId,
            success: false,
            error: 'Account not connected'
          });
          continue;
        }

        try {
          // Calculate order quantity with multiplier
          let orderQty = Math.abs(qty) * this.settings.sizeMultiplier;
          
          // Apply max position size limit if set
          if (this.settings.maxPositionSize && orderQty > this.settings.maxPositionSize) {
            orderQty = this.settings.maxPositionSize;
          }
          
          // Round to whole number (futures typically require whole contracts)
          orderQty = Math.floor(orderQty);
          
          if (orderQty <= 0) {
            results.push({
              accountId: followerId,
              success: false,
              error: 'Order size too small after multiplier/limits'
            });
            continue;
          }

          // Build order
          const order = {
            accountId: followerId,
            action: action, // Buy, Sell, BuyToCover, SellShort
            symbol: symbol,
            orderQty: orderQty,
            orderType: orderType,
            isAutomated: true
          };

          if (orderType === 'Limit' && limitPrice) {
            order.limitPrice = limitPrice;
          }
          if (orderType === 'Stop' && stopPrice) {
            order.stopPrice = stopPrice;
          }
          if (orderType === 'StopLimit') {
            if (limitPrice) order.limitPrice = limitPrice;
            if (stopPrice) order.stopPrice = stopPrice;
          }

          // Place order with retry logic
          const orderResult = await this.placeOrderWithRetry(
            followerAccount.service,
            order,
            followerId
          );

          const latency = Date.now() - startTime;

          results.push({
            accountId: followerId,
            success: orderResult.success,
            orderId: orderResult.orderId,
            latency,
            error: orderResult.error
          });

          // Track pending order
          if (orderResult.success && orderResult.orderId) {
            this.pendingOrders.set(orderResult.orderId, {
              followerId,
              order,
              timestamp: Date.now()
            });
          }

        } catch (error) {
          console.error(`Error copying trade to follower ${followerId}:`, error);
          results.push({
            accountId: followerId,
            success: false,
            error: error.message,
            latency: Date.now() - startTime
          });
        }
      }

      const totalLatency = Date.now() - startTime;
      const successCount = results.filter(r => r.success).length;
      const allSuccessful = successCount === this.followerAccountIds.length;

      logEntry.status = allSuccessful ? 'completed' : 'partial';
      logEntry.results = results;
      logEntry.latency = totalLatency;
      logEntry.successCount = successCount;

      tradeLog.push(logEntry);

      // Broadcast detailed update with latency metrics
      broadcast({
        type: 'trade-copied',
        data: {
          ...logEntry,
          timestamp: logEntry.timestamp,
          latency: totalLatency,
          successRate: (successCount / this.followerAccountIds.length) * 100
        }
      });

      return {
        success: allSuccessful,
        results,
        latency: totalLatency,
        logId: logEntry.id
      };

    } catch (error) {
      console.error('Error in copyTrade:', error);
      logEntry.status = 'failed';
      logEntry.error = error.message;
      tradeLog.push(logEntry);

      broadcast({
        type: 'trade-error',
        data: logEntry
      });

      return {
        success: false,
        error: error.message,
        logId: logEntry.id
      };
    }
  }

  /**
   * Place order with retry logic for robust execution
   */
  async placeOrderWithRetry(service, order, accountId, maxRetries = 3) {
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 500ms, 1000ms, 2000ms
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
          console.log(`Retrying order placement (attempt ${attempt + 1}/${maxRetries})`);
        }

        const result = await service.placeOrder(order);

        if (result && result.orderId) {
          return {
            success: true,
            orderId: result.orderId,
            result
          };
        }

        // If no orderId but no error, wait a bit and check
        if (result) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          // Verify order was placed by checking orders
          try {
            const orders = await service.getOrders(accountId);
            const recentOrder = orders.find(o => 
              o.symbol === order.symbol &&
              o.action === order.action &&
              Math.abs(new Date(o.timestamp).getTime() - Date.now()) < 5000
            );
            
            if (recentOrder) {
              return {
                success: true,
                orderId: recentOrder.id,
                result: recentOrder
              };
            }
          } catch (checkError) {
            // Continue to retry
          }
        }

      } catch (error) {
        lastError = error;
        console.error(`Order placement attempt ${attempt + 1} failed:`, error.message);

        // Don't retry on certain errors
        if (error.response?.status === 400) {
          // Bad request, don't retry
          break;
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Failed to place order after retries'
    };
  }

  /**
   * Sync positions between leader and followers
   */
  async syncPositions(leaderService) {
    try {
      // Get leader positions
      const leaderPos = await leaderService.getPositions(this.leaderAccountId);
      const leaderPosMap = new Map();
      
      leaderPos.forEach(pos => {
        const key = `${pos.symbol}-${pos.accountId}`;
        leaderPosMap.set(key, pos);
        leaderPositions.set(key, pos);
      });

      // Sync each follower
      for (const followerId of this.followerAccountIds) {
        const followerAccount = accounts.get(followerId);
        if (!followerAccount || !followerAccount.connected || !followerAccount.service) {
          continue;
        }

        try {
          const followerPos = await followerAccount.service.getPositions(followerId);
          const followerPosMap = new Map();
          
          followerPos.forEach(pos => {
            const key = `${pos.symbol}-${followerId}`;
            followerPosMap.set(key, pos);
          });

          // Compare and adjust positions
          for (const [key, leaderPos] of leaderPosMap.entries()) {
            const followerKey = `${leaderPos.symbol}-${followerId}`;
            const followerPos = followerPosMap.get(followerKey);
            
            const leaderQty = leaderPos.qty || 0;
            const followerQty = followerPos ? (followerPos.qty || 0) : 0;
            const diff = leaderQty - followerQty;

            // If difference is significant, adjust
            if (Math.abs(diff) > 0.01) {
              console.log(`Position desync detected for ${leaderPos.symbol}: Leader=${leaderQty}, Follower=${followerQty}`);
              
              // Place adjustment order
              const adjustmentOrder = {
                accountId: followerId,
                action: diff > 0 ? 'Buy' : 'Sell',
                symbol: leaderPos.symbol,
                orderQty: Math.abs(diff),
                orderType: 'Market',
                isAutomated: true
              };

              await this.placeOrderWithRetry(
                followerAccount.service,
                adjustmentOrder,
                followerId
              );

              tradeLog.push({
                id: `sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                timestamp: Date.now(),
                leaderAccount: this.leaderAccountId,
                followerAccount: followerId,
                event: {
                  type: 'position-reconciliation',
                  symbol: leaderPos.symbol,
                  leaderQty,
                  followerQty,
                  adjustment: diff
                },
                status: 'completed'
              });
            }
          }

          // Update positions cache
          followerPos.forEach(pos => {
            const key = `${pos.symbol}-${followerId}`;
            positions.set(key, pos);
          });

        } catch (error) {
          console.error(`Error syncing positions for follower ${followerId}:`, error);
        }
      }

      this.lastSyncTime = Date.now();

    } catch (error) {
      console.error('Error in position sync:', error);
    }
  }

  /**
   * Start periodic position reconciliation
   */
  startPositionReconciliation() {
    // Clear existing interval if any
    if (this.positionSyncInterval) {
      clearInterval(this.positionSyncInterval);
    }

    // Sync every 30 seconds
    this.positionSyncInterval = setInterval(() => {
      const leaderAccount = accounts.get(this.leaderAccountId);
      if (leaderAccount && leaderAccount.connected && leaderAccount.service) {
        this.syncPositions(leaderAccount.service);
      }
    }, 30000);
  }

  /**
   * Pause trade copying
   */
  pause() {
    this.isActive = false;
    if (this.positionSyncInterval) {
      clearInterval(this.positionSyncInterval);
      this.positionSyncInterval = null;
    }
  }

  /**
   * Resume trade copying
   */
  resume() {
    this.isActive = true;
    this.startPositionReconciliation();
  }

  /**
   * Stop trade copying
   */
  stop() {
    this.pause();
    this.pendingOrders.clear();
  }
}

// REST API Endpoints

// Add new account
app.post('/api/accounts', async (req, res) => {
  try {
    const { name, username, password, cid, secret, isLeader = false } = req.body;

    // Support both old (apiKey/apiSecret) and new (username/password/cid/secret) formats
    const accountUsername = username || req.body.apiKey;
    const accountPassword = password || req.body.apiSecret;
    const accountCid = cid || req.body.cid;
    const accountSecret = secret || req.body.apiSecret;

    if (!name || !accountUsername || !accountPassword) {
      return res.status(400).json({ 
        error: 'Missing required fields: name, username (or apiKey), password (or apiSecret)' 
      });
    }

    const accountId = `acc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const account = {
      id: accountId,
      name,
      username: accountUsername,
      password: accountPassword,
      cid: accountCid,
      secret: accountSecret,
      // Keep legacy fields for backward compatibility
      apiKey: accountUsername,
      apiSecret: accountPassword,
      isLeader,
      connected: false,
      status: 'disconnected',
      service: null,
      createdAt: Date.now()
    };

    accounts.set(accountId, account);

    const accountResponse = {
      id: account.id,
      name: account.name,
      isLeader: account.isLeader,
      connected: account.connected,
      status: account.status,
      createdAt: account.createdAt
    };

    broadcast({
      type: 'account-added',
      data: accountResponse
    });

    res.json({ success: true, account: accountResponse });
  } catch (error) {
    console.error('Error adding account:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all accounts
app.get('/api/accounts', (req, res) => {
  try {
    const accountList = Array.from(accounts.values()).map(acc => ({
      id: acc.id,
      name: acc.name,
      isLeader: acc.isLeader,
      connected: acc.connected,
      status: acc.status,
      createdAt: acc.createdAt
    }));

    res.json({ success: true, accounts: accountList });
  } catch (error) {
    console.error('Error listing accounts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove account
app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const account = accounts.get(id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Disconnect service
    if (account.service) {
      account.service.disconnect();
    }

    // Remove from copy groups
    for (const [groupId, group] of copyGroups.entries()) {
      if (group.leaderAccountId === id) {
        copyGroups.delete(groupId);
      } else {
        group.followerAccountIds = group.followerAccountIds.filter(fid => fid !== id);
        if (group.followerAccountIds.length === 0) {
          copyGroups.delete(groupId);
        } else {
          group.copier.followerAccountIds = group.followerAccountIds;
        }
      }
    }

    accounts.delete(id);

    broadcast({
      type: 'account-removed',
      data: { id }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing account:', error);
    res.status(500).json({ error: error.message });
  }
});

// Connect account to Tradovate
app.post('/api/accounts/:id/connect', async (req, res) => {
  try {
    const { id } = req.params;
    const account = accounts.get(id);

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    if (account.connected) {
      const accountResponse = {
        id: account.id,
        name: account.name,
        isLeader: account.isLeader,
        connected: account.connected,
        status: account.status,
        createdAt: account.createdAt
      };
      return res.json({ success: true, message: 'Already connected', account: accountResponse });
    }

    // Create Tradovate service (use mock if MOCK_MODE is enabled)
    let service;
    if (MOCK_MODE) {
      service = new TradovateServiceMock(
        account.username || account.apiKey,
        account.password || account.apiSecret,
        account.cid,
        account.secret || account.apiSecret,
        process.env.USE_DEMO === 'true' ? 'sandbox' : 'production'
      );
    } else {
      service = new TradovateService(
        account.username || account.apiKey,
        account.password || account.apiSecret,
        process.env.USE_DEMO === 'true' ? 'sandbox' : 'production'
      );
    }

    // Authenticate
    const authResult = await service.authenticate(account.cid);
    if (!authResult.success) {
      return res.status(401).json({ error: 'Authentication failed: ' + authResult.error });
    }

    // Setup WebSocket connection
    service.connectWebSocket(
      id,
      (message) => {
        // Handle incoming WebSocket messages
        broadcast({
          type: 'account-update',
          accountId: id,
          data: message
        });

        // If this is a leader account and we have copy groups, process trades
        if (account.isLeader) {
          const tradeEvent = parseTradeEvent(message);
          if (tradeEvent) {
            for (const [groupId, group] of copyGroups.entries()) {
              if (group.leaderAccountId === id && group.copier) {
                group.copier.copyTrade(tradeEvent, service);
              }
            }
          }
        }

        // Update positions and broadcast
        if (message.positions || message.d?.positions) {
          const posList = message.positions || message.d?.positions || [];
          posList.forEach(pos => {
            const key = `${pos.symbol}-${id}`;
            const positionData = {
              ...pos,
              accountId: id,
              accountName: account.name
            };
            positions.set(key, positionData);
          });

          // Broadcast position updates
          broadcast({
            type: 'positions-updated',
            data: {
              accountId: id,
              positions: posList.map(pos => ({
                ...pos,
                accountId: id,
                accountName: account.name
              }))
            }
          });
        }

        // Handle order fills
        if (message.orders || message.d?.orders) {
          const orderList = message.orders || message.d?.orders || [];
          const filledOrders = orderList.filter(o => 
            o.status === 'Filled' || o.status === 'PartiallyFilled'
          );

          if (filledOrders.length > 0) {
            broadcast({
              type: 'order-filled',
              data: {
                accountId: id,
                orders: filledOrders
              }
            });
          }
        }
      },
      (error) => {
        console.error(`WebSocket error for account ${id}:`, error);
        account.connected = false;
        account.status = 'error';
        broadcast({
          type: 'account-error',
          accountId: id,
          data: { error: error.message }
        });
      },
      () => {
        account.connected = false;
        account.status = 'disconnected';
        broadcast({
          type: 'account-disconnected',
          accountId: id,
          data: { id }
        });
      }
    );

    account.service = service;
    account.connected = true;
    account.status = 'connected';

    const accountResponse = {
      id: account.id,
      name: account.name,
      isLeader: account.isLeader,
      connected: account.connected,
      status: account.status,
      createdAt: account.createdAt
    };

    broadcast({
      type: 'account-connected',
      data: accountResponse
    });

    // Fetch initial positions and broadcast
    try {
      const accountPositions = await service.getPositions(id);
      accountPositions.forEach(pos => {
        const key = `${pos.symbol}-${id}`;
        positions.set(key, { ...pos, accountId: id, accountName: account.name });
      });
      
      broadcast({
        type: 'positions-updated',
        data: {
          accountId: id,
          positions: accountPositions.map(pos => ({ ...pos, accountId: id, accountName: account.name }))
        }
      });
    } catch (error) {
      console.error('Error fetching initial positions:', error);
    }

    res.json({ success: true, account: accountResponse });
  } catch (error) {
    console.error('Error connecting account:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper to parse trade events from WebSocket messages
function parseTradeEvent(message) {
  if (message.orders && Array.isArray(message.orders)) {
    const filledOrder = message.orders.find(o => 
      o.status === 'Filled' || o.status === 'PartiallyFilled'
    );
    
    if (filledOrder) {
      return {
        action: filledOrder.action,
        symbol: filledOrder.symbol,
        qty: filledOrder.orderQty || filledOrder.filledQty,
        orderType: filledOrder.orderType,
        limitPrice: filledOrder.limitPrice,
        stopPrice: filledOrder.stopPrice
      };
    }
  }

  // Check for position changes that indicate a trade
  if (message.positions && Array.isArray(message.positions)) {
    const changedPosition = message.positions.find(p => p.qty !== 0);
    if (changedPosition) {
      // This is a simplified version - in production you'd track position deltas
      return {
        action: changedPosition.qty > 0 ? 'Buy' : 'Sell',
        symbol: changedPosition.symbol,
        qty: Math.abs(changedPosition.qty)
      };
    }
  }

  return null;
}

// Get all copy groups
app.get('/api/copy-groups', (req, res) => {
  try {
    const groupList = Array.from(copyGroups.values()).map(group => {
      const leaderAccount = accounts.get(group.leaderAccountId);
      return {
        id: group.id,
        leaderAccountId: group.leaderAccountId,
        leaderAccountName: leaderAccount?.name || 'Unknown',
        followerAccountIds: group.followerAccountIds,
        followerAccountNames: group.followerAccountIds.map(id => {
          const acc = accounts.get(id);
          return acc?.name || 'Unknown';
        }),
        settings: group.copier?.settings || {
          sizeMultiplier: 1.0,
          maxPositionSize: null,
          copyStopLoss: true,
          copyTakeProfit: true
        },
        isActive: group.copier?.isActive ?? true,
        lastSyncTime: group.copier?.lastSyncTime || group.createdAt,
        createdAt: group.createdAt
      };
    });

    res.json({ success: true, groups: groupList });
  } catch (error) {
    console.error('Error listing copy groups:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create copy group
app.post('/api/copy-groups', (req, res) => {
  try {
    const { 
      leaderAccountId, 
      followerAccountIds,
      settings = {}
    } = req.body;

    if (!leaderAccountId || !followerAccountIds || !Array.isArray(followerAccountIds)) {
      return res.status(400).json({ 
        error: 'Missing required fields: leaderAccountId, followerAccountIds (array)' 
      });
    }

    if (followerAccountIds.length === 0) {
      return res.status(400).json({ 
        error: 'At least one follower account is required' 
      });
    }

    const leaderAccount = accounts.get(leaderAccountId);
    if (!leaderAccount) {
      return res.status(400).json({ error: 'Leader account not found' });
    }

    if (!leaderAccount.isLeader) {
      return res.status(400).json({ error: 'Account must be marked as leader to create copy groups' });
    }

    // Validate follower accounts
    for (const followerId of followerAccountIds) {
      if (!accounts.has(followerId)) {
        return res.status(400).json({ error: `Follower account ${followerId} not found` });
      }
      if (followerId === leaderAccountId) {
        return res.status(400).json({ error: 'Leader account cannot be a follower' });
      }
    }

    const groupId = `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Create TradeCopier with settings
    const copierSettings = {
      sizeMultiplier: parseFloat(settings.sizeMultiplier) || 1.0,
      maxPositionSize: settings.maxPositionSize ? parseFloat(settings.maxPositionSize) : null,
      copyStopLoss: settings.copyStopLoss !== false,
      copyTakeProfit: settings.copyTakeProfit !== false
    };
    
    const copier = new TradeCopier(leaderAccountId, followerAccountIds, copierSettings);
    
    const group = {
      id: groupId,
      leaderAccountId,
      followerAccountIds,
      copier,
      createdAt: Date.now()
    };

    copyGroups.set(groupId, group);

    const groupResponse = {
      id: group.id,
      leaderAccountId: group.leaderAccountId,
      leaderAccountName: leaderAccount.name,
      followerAccountIds: group.followerAccountIds,
      followerAccountNames: group.followerAccountIds.map(id => {
        const acc = accounts.get(id);
        return acc?.name || 'Unknown';
      }),
      settings: copierSettings,
      isActive: copier.isActive,
      lastSyncTime: copier.lastSyncTime,
      createdAt: group.createdAt
    };

    broadcast({
      type: 'copy-group-created',
      data: groupResponse
    });

    res.json({ success: true, group: groupResponse });
  } catch (error) {
    console.error('Error creating copy group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update copy group
app.put('/api/copy-groups/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { followerAccountIds, settings, isActive } = req.body;

    const group = copyGroups.get(id);
    if (!group) {
      return res.status(404).json({ error: 'Copy group not found' });
    }

    // Update followers if provided
    if (followerAccountIds && Array.isArray(followerAccountIds)) {
      // Validate follower accounts
      for (const followerId of followerAccountIds) {
        if (!accounts.has(followerId)) {
          return res.status(400).json({ error: `Follower account ${followerId} not found` });
        }
        if (followerId === group.leaderAccountId) {
          return res.status(400).json({ error: 'Leader account cannot be a follower' });
        }
      }
      
      group.followerAccountIds = followerAccountIds;
      group.copier.followerAccountIds = followerAccountIds;
    }

    // Update settings if provided
    if (settings) {
      if (settings.sizeMultiplier !== undefined) {
        group.copier.settings.sizeMultiplier = parseFloat(settings.sizeMultiplier) || 1.0;
      }
      if (settings.maxPositionSize !== undefined) {
        group.copier.settings.maxPositionSize = settings.maxPositionSize 
          ? parseFloat(settings.maxPositionSize) 
          : null;
      }
      if (settings.copyStopLoss !== undefined) {
        group.copier.settings.copyStopLoss = settings.copyStopLoss !== false;
      }
      if (settings.copyTakeProfit !== undefined) {
        group.copier.settings.copyTakeProfit = settings.copyTakeProfit !== false;
      }
    }

    // Update active status
    if (isActive !== undefined) {
      if (isActive) {
        group.copier.resume();
      } else {
        group.copier.pause();
      }
    }

    const leaderAccount = accounts.get(group.leaderAccountId);
    const groupResponse = {
      id: group.id,
      leaderAccountId: group.leaderAccountId,
      leaderAccountName: leaderAccount?.name || 'Unknown',
      followerAccountIds: group.followerAccountIds,
      followerAccountNames: group.followerAccountIds.map(id => {
        const acc = accounts.get(id);
        return acc?.name || 'Unknown';
      }),
      settings: group.copier.settings,
      isActive: group.copier.isActive,
      lastSyncTime: group.copier.lastSyncTime,
      createdAt: group.createdAt
    };

    broadcast({
      type: 'copy-group-updated',
      data: groupResponse
    });

    res.json({ success: true, group: groupResponse });
  } catch (error) {
    console.error('Error updating copy group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete copy group
app.delete('/api/copy-groups/:id', (req, res) => {
  try {
    const { id } = req.params;
    const group = copyGroups.get(id);

    if (!group) {
      return res.status(404).json({ error: 'Copy group not found' });
    }

    // Stop the copier
    if (group.copier) {
      group.copier.stop();
    }

    copyGroups.delete(id);

    broadcast({
      type: 'copy-group-deleted',
      data: { id }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting copy group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Emergency flatten all positions
app.post('/api/flatten-all', async (req, res) => {
  try {
    const results = [];

    for (const [accountId, account] of accounts.entries()) {
      if (!account.connected || !account.service) {
        continue;
      }

      try {
        const positions = await account.service.getPositions(accountId);
        const symbols = [...new Set(positions.map(p => p.symbol))];

        for (const symbol of symbols) {
          const flattenResults = await account.service.flattenPosition(accountId, symbol);
          results.push({
            accountId,
            symbol,
            results: flattenResults
          });
        }
      } catch (error) {
        results.push({
          accountId,
          success: false,
          error: error.message
        });
      }
    }

    tradeLog.push({
      id: `flatten-${Date.now()}`,
      timestamp: Date.now(),
      event: { type: 'flatten-all' },
      status: 'completed',
      results
    });

    broadcast({
      type: 'flatten-all-completed',
      data: { results }
    });

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error flattening all:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all positions
app.get('/api/positions', async (req, res) => {
  try {
    const allPositions = [];

    for (const [accountId, account] of accounts.entries()) {
      if (account.connected && account.service) {
        try {
          const positions = await account.service.getPositions(accountId);
          positions.forEach(pos => {
            allPositions.push({
              ...pos,
              accountId,
              accountName: account.name
            });
          });
        } catch (error) {
          console.error(`Error fetching positions for account ${accountId}:`, error);
        }
      }
    }

    res.json({ success: true, positions: allPositions });
  } catch (error) {
    console.error('Error getting positions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get trade log
app.get('/api/trade-log', (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const sortedLog = tradeLog
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({ 
      success: true, 
      trades: sortedLog,
      total: tradeLog.length
    });
  } catch (error) {
    console.error('Error getting trade log:', error);
    res.status(500).json({ error: error.message });
  }
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Send initial state
  const accountList = Array.from(accounts.values()).map(acc => ({
    id: acc.id,
    name: acc.name,
    isLeader: acc.isLeader,
    connected: acc.connected,
    status: acc.status,
    createdAt: acc.createdAt
  }));

  const positionList = Array.from(positions.values());

  ws.send(JSON.stringify({
    type: 'connected',
    data: {
      accounts: accountList,
      positions: positionList,
      stats: {
        totalAccounts: accountList.length,
        connectedAccounts: accountList.filter(a => a.connected).length,
        activePositions: positionList.filter(p => Math.abs(p.qty || 0) > 0).length,
        totalTrades: tradeLog.length
      }
    }
  }));
});

// Waitlist endpoints
app.post('/api/waitlist', (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim().toLowerCase())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if email already exists
    if (waitlist.has(normalizedEmail)) {
      return res.status(409).json({ error: 'Email already on waitlist' });
    }

    // Add to waitlist
    waitlist.add(normalizedEmail);

    console.log(`New waitlist signup: ${normalizedEmail} (Total: ${waitlist.size})`);

    // Send confirmation email (non-blocking)
    sendWaitlistConfirmation(normalizedEmail)
      .then(result => {
        if (result.success) {
          console.log(`✅ Confirmation email sent to: ${normalizedEmail}`);
        } else {
          console.warn(`⚠️  Could not send confirmation email to ${normalizedEmail}:`, result.error);
        }
      })
      .catch(err => {
        console.error(`❌ Failed to send confirmation email to ${normalizedEmail}:`, err.message || err);
      });

    broadcast({
      type: 'waitlist-signup',
      data: { email: normalizedEmail, total: waitlist.size }
    });

    res.json({ 
      success: true, 
      message: 'Successfully added to waitlist',
      total: waitlist.size
    });
  } catch (error) {
    console.error('Error adding to waitlist:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get waitlist (for admin/viewing)
app.get('/api/waitlist', (req, res) => {
  try {
    const emails = Array.from(waitlist).sort();
    res.json({ 
      success: true, 
      emails,
      count: emails.length 
    });
  } catch (error) {
    console.error('Error getting waitlist:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export waitlist as CSV
app.get('/api/waitlist/export', (req, res) => {
  try {
    const emails = Array.from(waitlist).sort();
    const csv = 'Email\n' + emails.map(email => `"${email}"`).join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=parallax-beta-waitlist.csv');
    res.send(csv);
  } catch (error) {
    console.error('Error exporting waitlist:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete from waitlist (admin)
app.delete('/api/waitlist/:email', (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    
    if (waitlist.has(email)) {
      waitlist.delete(email);
      res.json({ success: true, message: 'Email removed from waitlist' });
    } else {
      res.status(404).json({ error: 'Email not found in waitlist' });
    }
  } catch (error) {
    console.error('Error removing from waitlist:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send notification to all waitlist members (admin)
app.post('/api/waitlist/notify', async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' });
    }

    if (waitlist.size === 0) {
      return res.status(400).json({ error: 'Waitlist is empty' });
    }

    const emails = Array.from(waitlist);
    
    // Convert message to HTML (simple formatting)
    const htmlMessage = message.replace(/\n/g, '<br>');

    // Send emails in background (don't wait for all to complete)
    sendBulkEmail(emails, subject, `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 32px;">Parallax</h1>
        </div>
        <div style="background: white; padding: 40px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          ${htmlMessage}
          <p style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #999; font-size: 14px;">
            Best regards,<br>
            <strong>The Parallax Team</strong>
          </p>
        </div>
        <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
          <p>You're receiving this email because you're on the Parallax Beta Waitlist.</p>
        </div>
      </body>
      </html>
    `, message).then(results => {
      if (results && typeof results === 'object') {
        console.log(`📧 Notification sent: ${results.success || 0} successful, ${results.failed || 0} failed`);
        if (results.errors && Array.isArray(results.errors) && results.errors.length > 0) {
          console.error('Email errors:', results.errors);
        }
      } else {
        console.log('📧 Notification queued for sending');
      }
    }).catch(error => {
      console.error('❌ Error sending bulk email:', error);
    });

    res.json({ 
      success: true, 
      message: `Sending notification to ${emails.length} waitlist members...`,
      total: emails.length
    });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test email endpoint (for debugging)
app.post('/api/test-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    console.log('🧪 Testing email service...');
    const result = await sendWaitlistConfirmation(email);
    
    res.json({
      success: result.success,
      message: result.success 
        ? 'Test email sent successfully! Check your inbox.' 
        : `Failed to send: ${result.error}`,
      error: result.error
    });
  } catch (error) {
    console.error('❌ Test email error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

console.log('Parallax Trade Copier Server initialized');

// Export for Vercel serverless functions
export default app;
