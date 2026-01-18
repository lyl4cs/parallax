# Parallax - Trade Copier MVP

A real-time trade copier application that synchronizes trades from a leader account to multiple follower accounts using the Tradovate API.

## Features

- **Real-time Trade Copying**: Automatically copies trades from leader to follower accounts
- **Position Reconciliation**: Periodic sync to ensure positions stay aligned
- **Robust Execution**: Retry logic for order placement with exponential backoff
- **WebSocket Integration**: Real-time updates via WebSocket connections
- **Latency Tracking**: Monitor execution latency for transparency
- **Emergency Controls**: Flatten all positions across all accounts
- **Account Management**: Add, connect, and manage multiple Tradovate accounts

## Tech Stack

- **Frontend**: React 18 + Vite
- **Backend**: Express.js + WebSocket (ws)
- **API**: Tradovate REST + WebSocket API

## Prerequisites

- Node.js 18+ and npm
- Tradovate API credentials (Username, Password, CID, and Secret)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Create a `.env` file in the root directory:
   Copy `.env.example` to `.env` and fill in your credentials:
   ```
   TRADOVATE_USERNAME=your_username_here
   TRADOVATE_PASSWORD=your_password_here
   TRADOVATE_APP_ID=Parallax
   TRADOVATE_CID=your_cid_here
   TRADOVATE_SECRET=your_secret_here
   USE_DEMO=true
   PORT=3001
   ```

3. **Run the application:**
   ```bash
   # Terminal 1 - Start backend server
   npm run server

   # Terminal 2 - Start frontend dev server
   npm run dev
   ```

4. **Access the application:**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3001

## Usage

1. **Add Accounts:**
   - Click "Add Account" in the Accounts tab
   - Enter account name, username, password, CID, and secret
   - Mark as "Leader" if this account's trades should be copied
   - Click "Add Account"

2. **Connect Accounts:**
   - Click "Connect" next to any account
   - The system will authenticate and establish WebSocket connections

3. **Create Copy Groups:**
   - Use the API endpoint to create copy groups:
     ```bash
     POST /api/copy-groups
     {
       "leaderAccountId": "acc-xxx",
       "followerAccountIds": ["acc-yyy", "acc-zzz"]
     }
     ```

4. **Monitor:**
   - Dashboard: View overall statistics and recent activity
   - Positions: Monitor all positions across accounts
   - Trade Log: View trade execution history with latency metrics

5. **Emergency Actions:**
   - **Flatten All**: Closes all positions across all accounts
   - **Force Sync**: Triggers immediate position reconciliation

## API Endpoints

### Accounts
- `POST /api/accounts` - Add new account
- `GET /api/accounts` - List all accounts
- `DELETE /api/accounts/:id` - Remove account
- `POST /api/accounts/:id/connect` - Connect account to Tradovate

### Copy Groups
- `POST /api/copy-groups` - Create copy group
  ```json
  {
    "leaderAccountId": "acc-xxx",
    "followerAccountIds": ["acc-yyy"]
  }
  ```

### Positions & Trades
- `GET /api/positions` - Get all positions
- `GET /api/trade-log` - Get trade history
- `POST /api/flatten-all` - Emergency flatten all positions

## Key Features

### Trade Copier Engine
- Automatic trade copying from leader to followers
- Retry logic with exponential backoff for robust execution
- Position reconciliation every 30 seconds
- Latency tracking for each trade execution

### Tradovate Service
- OAuth/API key authentication
- Automatic token refresh before expiry
- WebSocket reconnection with exponential backoff
- Rate limiting (60 requests per minute)

### Real-time Updates
- WebSocket broadcast for account status changes
- Live position updates
- Trade execution notifications
- Latency metrics in real-time

## Architecture

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   React     │◄───────►│   Express   │◄───────►│  Tradovate  │
│  Frontend   │  HTTP   │   Backend   │  REST/  │     API     │
│             │         │             │  WebSocket│            │
└─────────────┘         └─────────────┘         └─────────────┘
                              │
                              │ WebSocket
                              │
                        ┌─────────────┐
                        │  Trade      │
                        │  Copier     │
                        │  Engine     │
                        └─────────────┘
```

## Important Notes

- **Demo Environment**: By default, the app uses Tradovate's demo environment. Set `USE_DEMO=false` for live trading.
- **Rate Limiting**: The service implements rate limiting to comply with Tradovate's API limits (60 requests/minute).
- **WebSocket Reconnection**: The system automatically reconnects WebSocket connections with exponential backoff.
- **Position Sync**: Positions are reconciled every 30 seconds to prevent desynchronization.

## Troubleshooting

- **WebSocket Disconnection**: Check network connectivity and Tradovate API status
- **Authentication Errors**: Verify API credentials in `.env` file
- **Order Failures**: Check account permissions and available margin
- **Position Desync**: Use "Force Sync" to manually trigger reconciliation

## Development

The project uses ES modules. Make sure your Node.js version supports ES modules (Node 18+).

## License

MIT
