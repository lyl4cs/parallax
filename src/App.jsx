import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = '/api';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [accounts, setAccounts] = useState([]);
  const [positions, setPositions] = useState([]);
  const [tradeLog, setTradeLog] = useState([]);
  const [copyGroups, setCopyGroups] = useState([]);
  const [stats, setStats] = useState({
    totalAccounts: 0,
    connectedAccounts: 0,
    activePositions: 0,
    totalTrades: 0
  });
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  // Update stats helper
  const updateStats = (accountsData = null, positionsData = null, tradesData = null) => {
    setStats(prev => {
      const newStats = { ...prev };
      if (accountsData) {
        newStats.totalAccounts = accountsData.length;
        newStats.connectedAccounts = accountsData.filter(a => a.connected).length;
      }
      if (positionsData) {
        newStats.activePositions = positionsData.filter(p => Math.abs(p.qty || 0) > 0).length;
      }
      if (tradesData) {
        newStats.totalTrades = tradesData.length;
      }
      return newStats;
    });
  };

  // Fetch functions - defined early to avoid circular dependencies
  const fetchAccounts = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/accounts`, { timeout: 3000 });
      if (response && response.data && response.data.success) {
        setAccounts(response.data.accounts || []);
        updateStats(response.data.accounts || []);
      } else {
        setAccounts([]);
      }
    } catch (error) {
      console.error('Error fetching accounts:', error);
      setAccounts([]);
    }
    return Promise.resolve(); // Always resolve to prevent hanging
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/positions`, { timeout: 3000 });
      if (response && response.data && response.data.success) {
        setPositions(response.data.positions || []);
        updateStats(null, response.data.positions || []);
      } else {
        setPositions([]);
      }
    } catch (error) {
      console.error('Error fetching positions:', error);
      setPositions([]);
    }
    return Promise.resolve(); // Always resolve to prevent hanging
  }, []);

  const fetchTradeLog = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/trade-log?limit=50`, { timeout: 3000 });
      if (response && response.data && response.data.success) {
        setTradeLog(response.data.trades || []);
        updateStats(null, null, response.data.trades || []);
      } else {
        setTradeLog([]);
      }
    } catch (error) {
      console.error('Error fetching trade log:', error);
      setTradeLog([]);
    }
    return Promise.resolve(); // Always resolve to prevent hanging
  }, []);

  const fetchCopyGroups = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/copy-groups`, { timeout: 3000 });
      if (response && response.data && response.data.success) {
        setCopyGroups(response.data.groups || []);
      } else {
        setCopyGroups([]);
      }
    } catch (error) {
      console.error('Error fetching copy groups:', error);
      setCopyGroups([]);
    }
    return Promise.resolve(); // Always resolve to prevent hanging
  }, []);

  // Handle WebSocket messages - MUST be defined before WebSocket useEffect
  const handleWebSocketMessage = useCallback((message) => {
    console.log('WebSocket message received:', message.type, message.data);
    
    switch (message.type) {
      case 'connected':
        // Initial connection - update state with server data
        if (message.data.accounts) {
          setAccounts(message.data.accounts);
          setStats(prev => {
            const newStats = { ...prev };
            newStats.totalAccounts = message.data.accounts.length;
            newStats.connectedAccounts = message.data.accounts.filter(a => a.connected).length;
            return newStats;
          });
        }
        if (message.data.positions) {
          setPositions(message.data.positions);
          setStats(prev => ({
            ...prev,
            activePositions: message.data.positions.filter(p => Math.abs(p.qty || 0) > 0).length
          }));
        }
        if (message.data.stats) {
          setStats(prev => ({ ...prev, ...message.data.stats }));
        }
        break;
        
      case 'account-added':
        // Add account to state directly
        if (message.data) {
          setAccounts(prev => [...prev.filter(a => a.id !== message.data.id), message.data]);
          setStats(prev => ({
            ...prev,
            totalAccounts: prev.totalAccounts + 1
          }));
        } else {
          fetchAccounts();
        }
        break;
        
      case 'account-connected':
      case 'account-disconnected':
      case 'account-error':
        // Update account status directly
        if (message.data) {
          setAccounts(prev => {
            const updated = prev.map(acc => 
              acc.id === message.data.id 
                ? { ...acc, ...message.data }
                : acc
            );
            // Update stats with the new accounts array
            setStats(prevStats => {
              const newStats = { ...prevStats };
              newStats.totalAccounts = updated.length;
              newStats.connectedAccounts = updated.filter(a => a.connected).length;
              return newStats;
            });
            return updated;
          });
        } else {
          fetchAccounts();
        }
        break;
        
      case 'account-removed':
        // Remove account from state directly
        if (message.data?.id) {
          setAccounts(prev => prev.filter(a => a.id !== message.data.id));
          setStats(prev => ({
            ...prev,
            totalAccounts: Math.max(0, prev.totalAccounts - 1)
          }));
        } else {
          fetchAccounts();
        }
        break;
        
      case 'positions-updated':
        // Update positions directly from WebSocket
        if (message.data?.positions) {
          setPositions(prev => {
            // Remove old positions for this account
            const filtered = prev.filter(p => p.accountId !== message.data.accountId);
            // Add new positions
            const updated = [...filtered, ...message.data.positions];
            // Update stats with the updated positions
            setStats(prevStats => ({
              ...prevStats,
              activePositions: updated.filter(p => Math.abs(p.qty || 0) > 0).length
            }));
            return updated;
          });
        }
        break;
        
      case 'order-filled':
        // Order filled - update positions and trade log
        if (message.data?.orders) {
          fetchPositions();
          // Add to trade log immediately
          message.data.orders.forEach(order => {
            setTradeLog(prev => [{
              id: `fill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: Date.now(),
              leaderAccount: message.data.accountId,
              event: {
                symbol: order.symbol,
                action: order.action,
                qty: order.filledQty || order.orderQty
              },
              status: 'completed',
              latency: order.latency || 0
            }, ...prev]);
          });
        }
        break;
        
      case 'trade-copied':
      case 'trade-error':
        // Trade copied - update trade log directly
        if (message.data) {
          setTradeLog(prev => {
            const existing = prev.find(t => t.id === message.data.id);
            if (existing) {
              return prev.map(t => t.id === message.data.id ? message.data : t);
            }
            return [message.data, ...prev];
          });
          // Update stats
          setStats(prev => ({
            ...prev,
            totalTrades: prev.totalTrades + 1
          }));
        }
        fetchPositions(); // Refresh positions after trade
        break;
        
      case 'flatten-all-completed':
        // Flatten completed - refresh positions
        fetchPositions();
        fetchTradeLog();
        break;
        
      case 'copy-group-created':
      case 'copy-group-updated':
      case 'copy-group-deleted':
        // Update copy groups directly
        if (message.type === 'copy-group-deleted') {
          setCopyGroups(prev => prev.filter(g => g.id !== message.data.id));
        } else if (message.data) {
          setCopyGroups(prev => {
            const existing = prev.find(g => g.id === message.data.id);
            if (existing) {
              return prev.map(g => g.id === message.data.id ? message.data : g);
            }
            return [...prev, message.data];
          });
        } else {
          fetchCopyGroups();
        }
        break;
        
      case 'account-update':
        // Generic account update - refresh positions
        fetchPositions();
        break;
        
      default:
        console.log('Unhandled WebSocket message type:', message.type);
        break;
    }
    // Note: fetchAccounts, fetchPositions, etc. are stable useCallback functions
    // They don't need to be in the dependency array since they never change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array - fetch functions are stable

  // WebSocket connection - MUST come after handleWebSocketMessage definition
  useEffect(() => {
    // Create WebSocket connection
    let ws = null;
    let reconnectTimeout = null;
    let reconnectAttempts = 0;
    let isMounted = true;
    const maxReconnectAttempts = 10;

    const connect = () => {
      if (!isMounted) return; // Don't reconnect if component unmounted
      
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          return; // Already connected
        }

        ws = new WebSocket(`ws://localhost:3001`);

        ws.onopen = () => {
          if (!isMounted) return;
          console.log('WebSocket connected');
          setWsConnected(true);
          reconnectAttempts = 0; // Reset on successful connection
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        };

        ws.onerror = (error) => {
          if (!isMounted) return;
          console.error('WebSocket error:', error);
          setWsConnected(false);
        };

        ws.onclose = (event) => {
          if (!isMounted) return;
          
          console.log('WebSocket disconnected', event.code, event.reason);
          setWsConnected(false);
          
          // Only reconnect if it wasn't a manual close (code 1000)
          if (event.code !== 1000 && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            const delay = Math.min(1000 * reconnectAttempts, 5000); // Exponential backoff, max 5s
            console.log(`Attempting WebSocket reconnection ${reconnectAttempts}/${maxReconnectAttempts} in ${delay}ms...`);
            
            reconnectTimeout = setTimeout(() => {
              if (isMounted) {
                connect(); // Reconnect
              }
            }, delay);
          } else if (reconnectAttempts >= maxReconnectAttempts) {
            console.error('Max WebSocket reconnection attempts reached. Connection will retry on next interaction.');
          }
        };
      } catch (error) {
        console.error('Failed to create WebSocket:', error);
        if (isMounted) {
          setWsConnected(false);
        }
      }
    };

    // Only connect if backend is running (don't spam connections)
    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close(1000, 'Component unmounting'); // Normal closure
        ws = null;
      }
    };
  }, [handleWebSocketMessage]);

  // Track if initial load has completed - use ref to persist across renders
  const hasInitialLoadCompleted = useRef(false);

  // Initial data fetch - only run once on mount
  useEffect(() => {
    // Prevent multiple loads
    if (hasInitialLoadCompleted.current) {
      return;
    }

    const loadData = async () => {
      if (hasInitialLoadCompleted.current) return; // Double check
      
      setLoading(true);
      try {
        // Use Promise.allSettled so all requests complete even if some fail
        await Promise.allSettled([
          fetchAccounts(),
          fetchPositions(),
          fetchTradeLog(),
          fetchCopyGroups()
        ]);
        hasInitialLoadCompleted.current = true;
      } catch (error) {
        console.error('Error loading initial data:', error);
        hasInitialLoadCompleted.current = true; // Mark as completed even on error
      } finally {
        // Always set loading to false, even if there are errors
        setLoading(false);
      }
    };
    
    loadData();
    // Only run once on mount - empty dependency array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Add account
  const handleAddAccount = async (formData) => {
    try {
      const response = await axios.post(`${API_BASE}/accounts`, formData);
      if (response.data && response.data.success) {
        setShowAddAccount(false);
        // Fetch accounts to update state immediately
        fetchAccounts();
        // WebSocket will also update, but we don't wait for it
      } else {
        alert('Failed to add account. Please try again.');
      }
    } catch (error) {
      console.error('Error adding account:', error);
      const errorMessage = error.response?.data?.error || error.message || 'Unknown error';
      alert('Error adding account: ' + errorMessage);
      // Don't close modal on error so user can retry
    }
  };

  // Connect account
  const handleConnectAccount = async (accountId) => {
    try {
      // Update UI optimistically
      setAccounts(prev => prev.map(acc => 
        acc.id === accountId 
          ? { ...acc, status: 'connecting', connected: false }
          : acc
      ));
      
      const response = await axios.post(`${API_BASE}/accounts/${accountId}/connect`);
      if (response.data.success) {
        // WebSocket will update state, but refresh if needed
        setTimeout(() => {
          fetchAccounts();
          fetchPositions();
        }, 1000);
      }
    } catch (error) {
      console.error('Error connecting account:', error);
      // Revert optimistic update
      setAccounts(prev => prev.map(acc => 
        acc.id === accountId 
          ? { ...acc, status: 'disconnected', connected: false }
          : acc
      ));
      alert('Error connecting account: ' + (error.response?.data?.error || error.message));
    }
  };

  // Remove account
  const handleRemoveAccount = async (accountId) => {
    if (!confirm('Are you sure you want to remove this account?')) {
      return;
    }
    try {
      const response = await axios.delete(`${API_BASE}/accounts/${accountId}`);
      if (response.data.success) {
        await fetchAccounts();
      }
    } catch (error) {
      console.error('Error removing account:', error);
      alert('Error removing account: ' + (error.response?.data?.error || error.message));
    }
  };

  // Flatten all positions
  const handleFlattenAll = async () => {
    if (!confirm('Emergency flatten all positions? This will close ALL positions across ALL accounts.')) {
      return;
    }
    try {
      const response = await axios.post(`${API_BASE}/flatten-all`);
      if (response.data.success) {
        alert('Flatten all executed');
        await fetchPositions();
        await fetchTradeLog();
      }
    } catch (error) {
      console.error('Error flattening all:', error);
      alert('Error flattening all: ' + (error.response?.data?.error || error.message));
    }
  };

  // Force sync
  const handleForceSync = async () => {
    try {
      // Trigger position refresh
      await fetchPositions();
      await fetchAccounts();
      alert('Force sync completed');
    } catch (error) {
      console.error('Error force syncing:', error);
      alert('Error force syncing: ' + error.message);
    }
  };

  // Format latency
  const formatLatency = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // Format timestamp
  const formatTimestamp = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  // Add a timeout to force loading to false after 2 seconds max
  useEffect(() => {
    if (loading) {
      const timeout = setTimeout(() => {
        console.warn('Loading timeout - forcing loading to false');
        setLoading(false);
      }, 2000); // Reduced to 2 seconds
      return () => clearTimeout(timeout);
    }
  }, [loading]);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner"></div>
        <p>Loading Parallax...</p>
        <button 
          onClick={() => setLoading(false)}
          style={{
            marginTop: '20px',
            padding: '10px 20px',
            background: '#667eea',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer'
          }}
        >
          Skip Loading
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>Parallax</h1>
          <div className={`ws-status ${wsConnected ? 'connected' : 'disconnected'}`}>
            <span className="ws-indicator"></span>
            {wsConnected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        
        <nav className="sidebar-nav">
          <button
            className={activeTab === 'dashboard' ? 'active' : ''}
            onClick={() => setActiveTab('dashboard')}
          >
            📊 Dashboard
          </button>
          <button
            className={activeTab === 'accounts' ? 'active' : ''}
            onClick={() => setActiveTab('accounts')}
          >
            👥 Accounts
          </button>
          <button
            className={activeTab === 'positions' ? 'active' : ''}
            onClick={() => setActiveTab('positions')}
          >
            📈 Positions
          </button>
          <button
            className={activeTab === 'trades' ? 'active' : ''}
            onClick={() => setActiveTab('trades')}
          >
            📋 Trade Log
          </button>
          <button
            className={activeTab === 'groups' ? 'active' : ''}
            onClick={() => setActiveTab('groups')}
          >
            🔗 Copy Groups
          </button>
        </nav>

        <div className="sidebar-footer">
          <button className="btn-flatten" onClick={handleFlattenAll}>
            🚨 Flatten All
          </button>
          <button className="btn-sync" onClick={handleForceSync}>
            🔄 Force Sync
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        {/* Dashboard */}
        {activeTab === 'dashboard' && (
          <div className="dashboard">
            <h2>Dashboard</h2>
            
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Total Accounts</div>
                <div className="stat-value">{stats.totalAccounts}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Connected</div>
                <div className="stat-value">{stats.connectedAccounts}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Active Positions</div>
                <div className="stat-value">{stats.activePositions}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Total Trades</div>
                <div className="stat-value">{stats.totalTrades}</div>
              </div>
            </div>

            <div className="dashboard-section">
              <h3>Recent Activity</h3>
              <div className="activity-list">
                {tradeLog.slice(0, 10).map((trade) => (
                  <div key={trade.id} className="activity-item">
                    <span className="activity-time">{formatTimestamp(trade.timestamp)}</span>
                    <span className={`activity-status ${trade.status}`}>
                      {trade.status}
                    </span>
                    <span className="activity-details">
                      {trade.event?.symbol} - {trade.event?.action} {trade.event?.qty}
                    </span>
                    {trade.latency && (
                      <span className="activity-latency">
                        {formatLatency(trade.latency)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Accounts */}
        {activeTab === 'accounts' && (
          <div className="accounts">
            <div className="page-header">
              <h2>Accounts</h2>
              <button className="btn-primary" onClick={() => setShowAddAccount(true)}>
                + Add Account
              </button>
            </div>

            <div className="accounts-list">
              {Array.isArray(accounts) && accounts.length > 0 ? (
                accounts.map((account) => {
                  if (!account || !account.id) return null;
                  return (
                    <div key={account.id} className="account-card">
                      <div className="account-header">
                        <div className="account-name">
                          <strong>{account.name || 'Unnamed Account'}</strong>
                          {account.isLeader && <span className="badge-leader">LEADER</span>}
                        </div>
                        <div className={`status-indicator ${account.status || 'disconnected'}`}>
                          {account.status || 'disconnected'}
                        </div>
                      </div>
                      
                      <div className="account-actions">
                        {!account.connected && (
                          <button
                            className="btn-connect"
                            onClick={() => handleConnectAccount(account.id)}
                          >
                            Connect
                          </button>
                        )}
                        <button
                          className="btn-remove"
                          onClick={() => handleRemoveAccount(account.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="empty-state">
                  <p>No accounts configured</p>
                  <button className="btn-primary" onClick={() => setShowAddAccount(true)}>
                    Add Your First Account
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Positions */}
        {activeTab === 'positions' && (
          <div className="positions">
            <h2>Positions</h2>
            
            <div className="positions-table">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Symbol</th>
                    <th>Quantity</th>
                    <th>Avg Price</th>
                    <th>Unrealized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions
                    .filter(p => Math.abs(p.qty || 0) > 0)
                    .map((position, idx) => (
                      <tr key={`${position.accountId}-${position.symbol}-${idx}`}>
                        <td>{position.accountName || position.accountId}</td>
                        <td>{position.symbol}</td>
                        <td className={position.qty > 0 ? 'positive' : 'negative'}>
                          {position.qty}
                        </td>
                        <td>${position.avgPrice?.toFixed(2) || 'N/A'}</td>
                        <td className={position.unrealizedPnl >= 0 ? 'positive' : 'negative'}>
                          ${position.unrealizedPnl?.toFixed(2) || '0.00'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>

              {positions.filter(p => Math.abs(p.qty || 0) > 0).length === 0 && (
                <div className="empty-state">
                  <p>No active positions</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Trade Log */}
        {activeTab === 'trades' && (
          <div className="trades">
            <h2>Trade Log</h2>
            
            <div className="trade-log">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Leader</th>
                    <th>Symbol</th>
                    <th>Action</th>
                    <th>Quantity</th>
                    <th>Status</th>
                    <th>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeLog.map((trade) => (
                    <tr key={trade.id}>
                      <td>{formatTimestamp(trade.timestamp)}</td>
                      <td>{trade.leaderAccount || 'N/A'}</td>
                      <td>{trade.event?.symbol || 'N/A'}</td>
                      <td>{trade.event?.action || 'N/A'}</td>
                      <td>{trade.event?.qty || 'N/A'}</td>
                      <td>
                        <span className={`status-badge ${trade.status}`}>
                          {trade.status}
                        </span>
                      </td>
                      <td>
                        {trade.latency ? (
                          <span className={`latency ${trade.latency < 1000 ? 'fast' : trade.latency < 3000 ? 'medium' : 'slow'}`}>
                            {formatLatency(trade.latency)}
                          </span>
                        ) : 'N/A'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {tradeLog.length === 0 && (
                <div className="empty-state">
                  <p>No trades yet</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Copy Groups Tab */}
      {activeTab === 'groups' && (
        <div className="copy-groups">
          <div className="page-header">
            <h2>Copy Groups</h2>
            <button className="btn-primary" onClick={() => setShowCreateGroup(true)}>
              + Create Group
            </button>
          </div>

          <div className="groups-list">
            {copyGroups.map((group) => (
              <div key={group.id} className="group-card">
                <div className="group-header">
                  <div className="group-title">
                    <strong>{group.leaderAccountName}</strong>
                    <span className="group-arrow">→</span>
                    <span>{group.followerAccountNames.join(', ')}</span>
                  </div>
                  <div className="group-status">
                    <span className={`status-indicator ${group.isActive ? 'active' : 'paused'}`}>
                      {group.isActive ? 'Active' : 'Paused'}
                    </span>
                    <span className="sync-time">
                      Last sync: {formatTimestamp(group.lastSyncTime)}
                    </span>
                  </div>
                </div>

                <div className="group-settings">
                  <div className="setting-item">
                    <span className="setting-label">Size Multiplier:</span>
                    <span className="setting-value">{group.settings.sizeMultiplier}x</span>
                  </div>
                  {group.settings.maxPositionSize && (
                    <div className="setting-item">
                      <span className="setting-label">Max Position Size:</span>
                      <span className="setting-value">{group.settings.maxPositionSize}</span>
                    </div>
                  )}
                  <div className="setting-item">
                    <span className="setting-label">Copy SL:</span>
                    <span className="setting-value">
                      {group.settings.copyStopLoss ? '✓' : '✗'}
                    </span>
                  </div>
                  <div className="setting-item">
                    <span className="setting-label">Copy TP:</span>
                    <span className="setting-value">
                      {group.settings.copyTakeProfit ? '✓' : '✗'}
                    </span>
                  </div>
                </div>

                <div className="group-actions">
                  <button
                    className="btn-edit"
                    onClick={() => setEditingGroup(group)}
                  >
                    Edit
                  </button>
                  <button
                    className={group.isActive ? 'btn-pause' : 'btn-resume'}
                    onClick={async () => {
                      try {
                        await axios.put(`${API_BASE}/copy-groups/${group.id}`, {
                          isActive: !group.isActive
                        });
                        await fetchCopyGroups();
                      } catch (error) {
                        alert('Error updating group: ' + error.message);
                      }
                    }}
                  >
                    {group.isActive ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    className="btn-remove"
                    onClick={async () => {
                      if (!confirm('Are you sure you want to delete this copy group?')) {
                        return;
                      }
                      try {
                        await axios.delete(`${API_BASE}/copy-groups/${group.id}`);
                        await fetchCopyGroups();
                      } catch (error) {
                        alert('Error deleting group: ' + error.message);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}

            {copyGroups.length === 0 && (
              <div className="empty-state">
                <p>No copy groups configured</p>
                <button className="btn-primary" onClick={() => setShowCreateGroup(true)}>
                  Create Your First Copy Group
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add Account Modal */}
      {showAddAccount && (
        <AddAccountModal
          onClose={() => setShowAddAccount(false)}
          onAdd={handleAddAccount}
        />
      )}

      {/* Create/Edit Copy Group Modal */}
      {(showCreateGroup || editingGroup) && (
        <CopyGroupModal
          onClose={() => {
            setShowCreateGroup(false);
            setEditingGroup(null);
          }}
          onSave={async (groupData) => {
            try {
              if (editingGroup) {
                await axios.put(`${API_BASE}/copy-groups/${editingGroup.id}`, groupData);
              } else {
                await axios.post(`${API_BASE}/copy-groups`, groupData);
              }
              setShowCreateGroup(false);
              setEditingGroup(null);
              await fetchCopyGroups();
            } catch (error) {
              alert('Error saving group: ' + (error.response?.data?.error || error.message));
            }
          }}
          accounts={accounts}
          group={editingGroup}
        />
      )}
    </div>
  );
}

// Add Account Modal Component
function AddAccountModal({ onClose, onAdd }) {
  const [formData, setFormData] = useState({
    name: '',
    username: '',
    password: '',
    cid: '',
    secret: '',
    isLeader: false
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validation
    if (!formData.name || !formData.name.trim()) {
      alert('Please enter an account name');
      return;
    }
    
    if (!formData.username || !formData.username.trim()) {
      alert('Please enter a username');
      return;
    }
    
    if (!formData.password || !formData.password.trim()) {
      alert('Please enter a password');
      return;
    }
    
    setIsSubmitting(true);
    try {
      await onAdd({
        name: formData.name.trim(),
        username: formData.username.trim(),
        password: formData.password,
        cid: formData.cid.trim() || undefined,
        secret: formData.secret.trim() || undefined,
        isLeader: formData.isLeader
      });
      // Reset form on success
      setFormData({
        name: '',
        username: '',
        password: '',
        cid: '',
        secret: '',
        isLeader: false
      });
    } catch (error) {
      console.error('Error in form submission:', error);
      // Error is already handled in handleAddAccount
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add Account</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Account Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g., Main Account"
              required
            />
          </div>
          
          <div className="form-group">
            <label>Username</label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              placeholder="Tradovate username"
              required
            />
          </div>
          
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              placeholder="Tradovate password"
              required
            />
          </div>
          
          <div className="form-group">
            <label>CID (Account ID)</label>
            <input
              type="text"
              value={formData.cid}
              onChange={(e) => setFormData({ ...formData, cid: e.target.value })}
              placeholder="Optional - Account ID"
            />
          </div>
          
          <div className="form-group">
            <label>Secret</label>
            <input
              type="password"
              value={formData.secret}
              onChange={(e) => setFormData({ ...formData, secret: e.target.value })}
              placeholder="Optional - API Secret"
            />
          </div>
          
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={formData.isLeader}
                onChange={(e) => setFormData({ ...formData, isLeader: e.target.checked })}
              />
              Leader Account (trades from this account will be copied)
            </label>
          </div>
          
          <div className="form-actions">
            <button type="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button 
              type="submit" 
              className="btn-primary" 
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Adding...' : 'Add Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Copy Group Modal Component
function CopyGroupModal({ onClose, onSave, accounts, group = null }) {
  const [formData, setFormData] = useState({
    leaderAccountId: group?.leaderAccountId || '',
    followerAccountIds: group?.followerAccountIds || [],
    sizeMultiplier: group?.settings?.sizeMultiplier || 1.0,
    maxPositionSize: group?.settings?.maxPositionSize || '',
    copyStopLoss: group?.settings?.copyStopLoss !== false,
    copyTakeProfit: group?.settings?.copyTakeProfit !== false
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const leaderAccounts = accounts.filter(a => a.isLeader);
  const followerAccounts = accounts.filter(a => !a.isLeader || (group && a.id === group.leaderAccountId));

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.leaderAccountId) {
      alert('Please select a leader account');
      return;
    }
    
    if (formData.followerAccountIds.length === 0) {
      alert('Please select at least one follower account');
      return;
    }

    setIsSubmitting(true);
    try {
      const groupData = {
        leaderAccountId: formData.leaderAccountId,
        followerAccountIds: formData.followerAccountIds,
        settings: {
          sizeMultiplier: parseFloat(formData.sizeMultiplier) || 1.0,
          maxPositionSize: formData.maxPositionSize ? parseFloat(formData.maxPositionSize) : null,
          copyStopLoss: formData.copyStopLoss,
          copyTakeProfit: formData.copyTakeProfit
        }
      };
      
      await onSave(groupData);
    } catch (error) {
      console.error('Error saving group:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleFollower = (accountId) => {
    setFormData(prev => ({
      ...prev,
      followerAccountIds: prev.followerAccountIds.includes(accountId)
        ? prev.followerAccountIds.filter(id => id !== accountId)
        : [...prev.followerAccountIds, accountId]
    }));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{group ? 'Edit Copy Group' : 'Create Copy Group'}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Leader Account *</label>
            <select
              value={formData.leaderAccountId}
              onChange={(e) => setFormData({ ...formData, leaderAccountId: e.target.value })}
              required
              disabled={!!group}
            >
              <option value="">Select a leader account</option>
              {leaderAccounts.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} {acc.isLeader && '(Leader)'}
                </option>
              ))}
            </select>
            {leaderAccounts.length === 0 && (
              <p className="form-help">No leader accounts available. Mark an account as leader first.</p>
            )}
          </div>

          <div className="form-group">
            <label>Follower Accounts *</label>
            <div className="checkbox-group">
              {followerAccounts
                .filter(acc => acc.id !== formData.leaderAccountId)
                .map(acc => (
                  <label key={acc.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={formData.followerAccountIds.includes(acc.id)}
                      onChange={() => toggleFollower(acc.id)}
                    />
                    <span>{acc.name}</span>
                    {!acc.connected && (
                      <span className="checkbox-warning"> (Not connected)</span>
                    )}
                  </label>
                ))}
            </div>
            {followerAccounts.filter(acc => acc.id !== formData.leaderAccountId).length === 0 && (
              <p className="form-help">No follower accounts available. Add more accounts first.</p>
            )}
          </div>

          <div className="form-section">
            <h4>Settings</h4>
            
            <div className="form-group">
              <label>Size Multiplier</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                value={formData.sizeMultiplier}
                onChange={(e) => setFormData({ ...formData, sizeMultiplier: e.target.value })}
                placeholder="1.0"
              />
              <p className="form-help">Multiply position size by this factor (e.g., 1.5x = 50% larger positions)</p>
            </div>

            <div className="form-group">
              <label>Max Position Size (Optional)</label>
              <input
                type="number"
                step="1"
                min="1"
                value={formData.maxPositionSize}
                onChange={(e) => setFormData({ ...formData, maxPositionSize: e.target.value })}
                placeholder="Leave empty for no limit"
              />
              <p className="form-help">Maximum position size per symbol (contracts)</p>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={formData.copyStopLoss}
                  onChange={(e) => setFormData({ ...formData, copyStopLoss: e.target.checked })}
                />
                Copy Stop Loss Orders
              </label>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={formData.copyTakeProfit}
                  onChange={(e) => setFormData({ ...formData, copyTakeProfit: e.target.checked })}
                />
                Copy Take Profit Orders
              </label>
            </div>
          </div>
          
          <div className="form-actions">
            <button type="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : (group ? 'Update Group' : 'Create Group')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default App;
