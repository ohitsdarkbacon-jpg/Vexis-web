# Vexis Notifier — Web Dashboard

Yellow & black Discord-authenticated slot management system with Pro tier, bid auctions, crypto payments, and full admin controls.

## Stack
- **Backend**: Node.js + Express
- **Auth**: Discord OAuth2
- **Keys**: Luarmor API
- **Payments**: NowPayments (BTC + LTC)
- **Deploy**: Railway

---

## Railway Deployment (5 steps)

### 1. Create Discord Application
1. Go to https://discord.com/developers/applications → New Application → name it "Vexis"
2. OAuth2 tab → copy **Client ID** and **Client Secret**
3. Add redirect: `https://YOUR-RAILWAY-DOMAIN.up.railway.app/auth/discord/callback`
4. Bot tab → create bot → copy **Bot Token** (needed for auction winner DMs)

### 2. Create Luarmor Projects
1. Log in to https://luarmor.net
2. Create **two projects**: one for Pro, one for Bid slots
3. Copy each project's UUID and your API key

### 3. Set up NowPayments
1. Sign up at https://nowpayments.io
2. Copy your **API key**
3. In IPN settings, add your webhook URL: `https://YOUR-DOMAIN/webhook/nowpayments`
4. Copy the **IPN Secret**

### 4. Deploy to Railway
```bash
# Push this folder to a GitHub repo, then connect it on Railway
# OR use Railway CLI:
npm install -g @railway/cli
railway login
railway init
railway up
```

### 5. Set Environment Variables on Railway
Go to your Railway service → Variables tab and add:

| Variable | Value |
|---|---|
| `DISCORD_CLIENT_ID` | From Discord Dev Portal |
| `DISCORD_CLIENT_SECRET` | From Discord Dev Portal |
| `DISCORD_BOT_TOKEN` | Bot token (for auction DMs) |
| `BASE_URL` | `https://your-app.up.railway.app` |
| `SESSION_SECRET` | Any long random string |
| `ADMIN_IDS` | Your Discord user ID(s), comma-separated |
| `LUARMOR_API_KEY` | Your Luarmor API key |
| `LUARMOR_PROJECT_ID_PRO` | Pro project UUID |
| `LUARMOR_PROJECT_ID_BID` | Bid project UUID |
| `NOWPAYMENTS_API_KEY` | NowPayments key |
| `NOWPAYMENTS_IPN_SECRET` | NowPayments IPN secret |
| `DATA_DIR` | `/data` (if using Railway volume) |

### 6. (Recommended) Add a Volume
Railway services reset their filesystem on redeploy. To persist user data:
1. Railway dashboard → your service → Volumes → Add volume
2. Mount path: `/data`
3. Set `DATA_DIR=/data` in Variables

---

## Features

### User Dashboard
- **Overview** — credit balance, active slots, global capacity
- **Pro Slot** — activate with credits ($8 = 1 hour), view key, copy key, reset HWID
- **Bid Slots** — live auction with countdown timer, place/update bids, auto-refund losers
- **Credits** — buy with BTC or LTC via NowPayments, QR code invoice
- **Transfer** — send credits to any other Vexis user by Discord ID

### Bid Auction System
- 2 global bid slots (Bid tier)
- Minimum bid: 16 credits ($16)
- Auction starts on first bid, runs for 5 minutes
- Last-second bids (<1 min remaining) extend timer by 1 minute
- Winner gets 2 hours flat; losers are fully refunded
- Slot goes on 2-hour cooldown after winner key expires

### Admin Panel (admin Discord IDs only)
- View all users, credits, active slots
- Give/remove/set credits for any user
- Pause Pro or Bid slots globally
- Search users by ID or username
- Force-end or reset stuck auctions (with full refunds)
- System status at a glance

### Payments
- Credits never expire ($1 = 1 credit)
- NowPayments webhook auto-credits on confirmation
- Fallback polling every 2 minutes for missed webhooks
- Partial payments are prorated

---

## Pricing
| Tier | Price | Slots | Prize |
|---|---|---|---|
| Pro | $8/hr | 6 global | Your key, any duration |
| Bid | $16+ min | 2 global | 2 hours flat (highest bidder wins) |

---

## Local Dev
```bash
cp .env.example .env
# Fill in your .env
npm install
node server.js
```
