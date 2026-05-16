require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const cookieParser = require('cookie-parser');
const axios        = require('axios');
const crypto       = require('crypto');
const QRCode       = require('qrcode');
const fs           = require('fs');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ===== FILE PERSISTENCE =====
const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const fp = f => path.join(DATA_DIR, f);
const readJSON  = (file, def) => { try { return JSON.parse(fs.readFileSync(fp(file))); } catch { return def; } };
const writeJSON = (file, data) => fs.writeFileSync(fp(file), JSON.stringify(data, null, 2));

let users      = readJSON('users.json',      {});
let slots      = readJSON('slots.json',      []);
let auctions   = readJSON('auctions.json',   {});
let payments   = readJSON('payments.json',   {});
let pauseState = readJSON('pause.json',      { pro: false, bid: false });

const saveUsers    = () => writeJSON('users.json',    users);
const saveSlots    = () => writeJSON('slots.json',    slots);
const saveAuctions = () => writeJSON('auctions.json', auctions);
const savePayments = () => writeJSON('payments.json', payments);
const savePause    = () => writeJSON('pause.json',    pauseState);

// ===== CONFIG =====
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID      = process.env.DISCORD_GUILD_ID;
const BASE_URL              = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET        = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_IDS             = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const NOWPAYMENTS_API_KEY   = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET= process.env.NOWPAYMENTS_IPN_SECRET;
const LUARMOR_API_KEY       = process.env.LUARMOR_API_KEY;
const LUARMOR_PROJECT_PRO   = process.env.LUARMOR_PROJECT_ID_PRO;   // Pro tier
const LUARMOR_PROJECT_BID   = process.env.LUARMOR_PROJECT_ID_BID;   // Bid tier

const PRO_CONFIG = {
  name:           'Pro',
  pricePerHour:   8,      // $8/hr => 8 credits/hr
  maxSlots:       6,
  creditToHours:  (c) => c / 8,
  projectId:      LUARMOR_PROJECT_PRO,
};

const BID_CONFIG = {
  name:           'Bid',
  minBid:         16,     // $16 minimum
  prizeHours:     2,      // always 2hr flat
  maxSlots:       2,
  durationMins:   5,
  cooldownMs:     2 * 60 * 60 * 1000,
  projectId:      LUARMOR_PROJECT_BID,
};

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie:            { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ===== HELPERS =====
function ensureUser(userId) {
  if (!users[userId]) users[userId] = { credits: 0, processed: [], pausedSlots: [] };
  if (!users[userId].processed) users[userId].processed = [];
  return users[userId];
}

function getUserIdentifier(userId, username) {
  return crypto.createHash('sha256').update(`${userId}:${username}`).digest('hex').slice(0, 32);
}

function getActiveProSlots() {
  return slots.filter(s => s?.type === 'pro' && s.expiry > Date.now());
}

function formatTime(ms) {
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getAuctionId(slotIndex) { return `bid_slot_${slotIndex}`; }

function ensureAuction(slotIndex) {
  const aId = getAuctionId(slotIndex);
  if (!auctions[aId]) {
    auctions[aId] = { slotIndex, status: 'idle', bids: [], endsAt: null, cooldownUntil: null, lastWinner: null };
    saveAuctions();
  }
  return aId;
}

function getTopBid(auction) {
  if (!auction?.bids?.length) return null;
  return auction.bids.reduce((a, b) => a.amount >= b.amount ? a : b);
}

function isBidSlotOnCooldown(slotIndex) {
  const aId = getAuctionId(slotIndex);
  const a   = auctions[aId];
  return a?.cooldownUntil && a.cooldownUntil > Date.now();
}

async function createLuarmorKey(hours, discordId, username, projectId) {
  const expiryUnix = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
  const identifier = getUserIdentifier(discordId, username);

  const res = await axios.post(
    `https://api.luarmor.net/v3/projects/${projectId}/users`,
    {
      discord_id: discordId,
      identifier,
      auth_expire: expiryUnix,
      note: `${username} (${discordId})`
    },
    {
      headers: {
        Authorization: LUARMOR_API_KEY,
        'Content-Type': 'application/json'
      }
    }
  );

  const findKey = obj => {
    if (typeof obj === 'string' && /^[A-Za-z0-9]{6,}$/.test(obj)) return obj;
    if (typeof obj === 'object' && obj) {
      for (const v of Object.values(obj)) {
        const k = findKey(v);
        if (k) return k;
      }
    }
    return null;
  };

  const shortKey = findKey(res.data);
  if (!shortKey) throw new Error('No key in Luarmor response');

  // 🔥 THIS is what gives you the loadstring behavior
  const LOADER_HASH = 'a956818a26401a68387b022f2525679a';

  const fullLoadstring =
    `script_key="${shortKey}";` +
    `loadstring(game:HttpGet("https://api.luarmor.net/files/v4/loaders/${LOADER_HASH}.lua"))()`;

  return {
    key: fullLoadstring,
    rawKey: shortKey,
    expiry: expiryUnix * 1000
  };
}

async function resetLuarmorHWID(userId, projectId) {
  const identifier = getUserIdentifier(userId, userId);
  await axios.patch(
    `https://api.luarmor.net/v3/projects/${projectId}/users`,
    { identifier, reset_hwid: true },
    { headers: { Authorization: LUARMOR_API_KEY, 'Content-Type': 'application/json' } }
  );
}

function sortObjectKeys(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortObjectKeys(obj[k]); return acc; }, {});
}

function verifyNowPaymentsSignature(rawBody, signature) {
  if (!NOWPAYMENTS_IPN_SECRET) return true;
  if (!signature) return false;
  try {
    const sorted = JSON.stringify(sortObjectKeys(JSON.parse(rawBody)));
    const hmac   = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(sorted).digest('hex');
    return hmac === signature;
  } catch { return false; }
}

async function createNowPayment(userId, currency, usdAmount) {
  const orderId = `${userId}_${Date.now()}`;
  const res = await axios.post(
    'https://api.nowpayments.io/v1/payment',
    {
      price_amount:        usdAmount,
      price_currency:      'usd',
      pay_currency:        currency,
      order_id:            orderId,
      order_description:   userId,
      ipn_callback_url:    `${BASE_URL}/webhook/nowpayments`,
      is_fixed_rate:       false,
      is_fee_paid_by_user: false,
    },
    { headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } }
  );
  return { ...res.data, _orderId: orderId };
}

async function deliverCredits(paymentId, status, actuallyPaid, payCurrency) {
  const record = payments[paymentId];
  if (!record) return;
  const { userId, usdAmount, payAmount } = record;
  ensureUser(userId);
  const dedupKey = `np_${paymentId}`;
  if (users[userId].processed.includes(dedupKey)) return;

  let usdValue = 0;
  if (status === 'finished' || status === 'confirmed') {
    usdValue = parseFloat(usdAmount) || 0;
  } else if (status === 'partially_paid') {
    const paid = parseFloat(actuallyPaid) || 0;
    const exp  = parseFloat(payAmount) || 0;
    if (exp > 0) usdValue = (paid / exp) * parseFloat(usdAmount);
  }

  const credits = Math.floor(usdValue);
  if (credits <= 0) return;

  users[userId].credits += credits;
  users[userId].processed.push(dedupKey);
  saveUsers();
  record.status = 'credited'; record.creditsGiven = credits;
  savePayments();
  console.log(`💰 +${credits} credits → ${userId}`);
}

// ===== AUCTION ENGINE =====
const endingAuctions = new Set();

async function refundBidders(auction, winnerUserId = null) {
  for (const bid of (auction.bids || [])) {
    if (bid.userId === winnerUserId) continue;
    ensureUser(bid.userId);
    users[bid.userId].credits += bid.amount;
  }
  saveUsers();
}

async function endAuction(auctionId) {
  const auction = auctions[auctionId];
  if (!auction || auction.status === 'ended' || auction.status === 'idle') return;
  if (endingAuctions.has(auctionId)) return;
  endingAuctions.add(auctionId);

  auction.status = 'ended';
  saveAuctions();

  const topBid = getTopBid(auction);

  const resetToIdle = (delay = 5000) => {
    setTimeout(() => {
      if (auctions[auctionId]) {
        auctions[auctionId] = { slotIndex: auction.slotIndex, status: 'idle', bids: [], endsAt: null, cooldownUntil: null, lastWinner: null };
        saveAuctions();
      }
      endingAuctions.delete(auctionId);
    }, delay);
  };

  if (!topBid) return resetToIdle(5000);

  ensureUser(topBid.userId);

  let key, expiry;
  try {
    const { data: u } = await axios.get(`https://discord.com/api/v10/users/${topBid.userId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    }).catch(() => ({ data: { username: topBid.userId } }));
    const result = await createLuarmorKey(BID_CONFIG.prizeHours, topBid.userId, u.username || topBid.userId, BID_CONFIG.projectId);
    key = result.key; expiry = result.expiry;
  } catch (err) {
    console.error('Key gen failed for', auctionId, err.message);
    users[topBid.userId].credits += topBid.amount;
    await refundBidders(auction, topBid.userId);
    saveUsers();
    return resetToIdle(5000);
  }

  auction.cooldownUntil = Date.now() + BID_CONFIG.cooldownMs;
  auction.lastWinner    = topBid.userId;
  saveAuctions();

  slots = slots.filter(s => !(s.userId === topBid.userId && s.type === 'bid'));
  slots.push({ userId: topBid.userId, key, expiry, type: 'bid', auctionId, projectId: BID_CONFIG.projectId });
  saveSlots();

  // Store key for dashboard
  ensureUser(topBid.userId);
  if (!users[topBid.userId].bidKeys) users[topBid.userId].bidKeys = [];
  users[topBid.userId].bidKeys.unshift({ key, expiry, auctionId, wonAt: Date.now() });
  users[topBid.userId].bidKeys = users[topBid.userId].bidKeys.slice(0, 5);
  saveUsers();

  await refundBidders(auction, topBid.userId);
  saveUsers();

  console.log(`🏆 ${auctionId} won by ${topBid.userId} for ${topBid.amount}cr — key: ${key}`);
  resetToIdle(BID_CONFIG.cooldownMs);
}

// ===== DISCORD OAUTH =====
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  `${BASE_URL}/auth/discord/callback`,
    response_type: 'code',
    scope:         'identify',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id:     DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  `${BASE_URL}/auth/discord/callback`,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token } = tokenRes.data;
    const userRes = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const { id, username, avatar, discriminator } = userRes.data;
    ensureUser(id);
    users[id].username     = username;
    users[id].discriminator= discriminator;
    users[id].avatar       = avatar;
    users[id].lastLogin    = Date.now();
    saveUsers();

    req.session.user = { id, username, avatar, discriminator };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ===== AUTH MIDDLEWARE =====
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session?.user || !ADMIN_IDS.includes(req.session.user.id)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ===== API: ME =====
app.get('/api/me', requireAuth, (req, res) => {
  const { id } = req.session.user;
  ensureUser(id);
  const u = users[id];
  res.json({
    ...req.session.user,
    credits:   u.credits,
    isAdmin:   ADMIN_IDS.includes(id),
    proSlot:   slots.find(s => s.userId === id && s.type === 'pro' && s.expiry > Date.now()) || null,
    bidSlot:   slots.find(s => s.userId === id && s.type === 'bid' && s.expiry > Date.now()) || null,
    bidKeys:   u.bidKeys || [],
  });
});

// ===== API: STATUS =====
app.get('/api/status', (req, res) => {
  const now = Date.now();
  const proSlots = slots.filter(s => s?.type === 'pro' && s.expiry > now);

  const bidStatus = [1, 2].map(i => {
    const aId = getAuctionId(i);
    const a   = auctions[aId] || {};
    const onCooldown = isBidSlotOnCooldown(i);
    const topBid = getTopBid(a);
    return {
      slotIndex:    i,
      auctionId:    aId,
      status:       onCooldown ? 'cooldown' : (a.status || 'idle'),
      cooldownUntil:a.cooldownUntil || null,
      endsAt:       a.endsAt || null,
      lastWinner:   a.lastWinner || null,
      topBid:       topBid ? { amount: topBid.amount, userId: topBid.userId } : null,
      bidCount:     (a.bids || []).length,
      paused:       pauseState.bid,
    };
  });

  res.json({
    pro: {
      active:    proSlots.length,
      max:       PRO_CONFIG.maxSlots,
      available: proSlots.length < PRO_CONFIG.maxSlots,
      paused:    pauseState.pro,
      slots:     proSlots.map(s => ({ userId: s.userId, expiry: s.expiry })),
    },
    bid:     bidStatus,
    paused:  pauseState,
  });
});

// ===== API: ACTIVATE PRO SLOT =====
app.post('/api/slot/pro/activate', requireAuth, async (req, res) => {
  const { id, username } = req.session.user;
  const { credits } = req.body;
  ensureUser(id);

  if (pauseState.pro) return res.status(400).json({ error: 'Pro slots are currently paused by admin.' });

const creditsNum = parseInt(credits);
if (!creditsNum || creditsNum <= 0) return res.status(400).json({ error: 'Invalid credits amount.' });
if (creditsNum % 8 !== 0) return res.status(400).json({ error: 'Only full hours (multiples of 8 credits).' });
if (creditsNum > users[id].credits) return res.status(400).json({ error: 'Insufficient credits.' });
const hours = creditsNum / 8;   // ← only one declaration
  try {
    const { key, expiry } = await createLuarmorKey(hours, id, username, PRO_CONFIG.projectId);
    slots = slots.filter(s => !(s.userId === id && s.type === 'pro'));
    slots.push({ userId: id, key, expiry, type: 'pro', projectId: PRO_CONFIG.projectId, activatedAt: Date.now() });
    users[id].credits -= creditsNum;
    if (!users[id].proKeys) users[id].proKeys = [];
    users[id].proKeys.unshift({ key, expiry, creditsSpent: creditsNum, activatedAt: Date.now() });
    users[id].proKeys = users[id].proKeys.slice(0, 10);
    saveUsers(); saveSlots();
    res.json({ success: true, key, expiry, hours, creditsSpent: creditsNum, creditsRemaining: users[id].credits });
  } catch (err) {
    console.error('Pro activate error:', err.message);
    res.status(500).json({ error: `Luarmor error: ${err.message}` });
  }
});

// ===== API: RESET HWID =====
app.post('/api/slot/reset-hwid', requireAuth, async (req, res) => {
  const { id } = req.session.user;
  const { type } = req.body;
  const projectId = type === 'pro' ? PRO_CONFIG.projectId : BID_CONFIG.projectId;
  try {
    await resetLuarmorHWID(id, projectId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: TRANSFER CREDITS =====
app.post('/api/credits/transfer', requireAuth, async (req, res) => {
  const { id } = req.session.user;
  const { targetDiscordId, amount } = req.body;
  ensureUser(id);

  const amountNum = parseInt(amount);
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'Invalid amount.' });
  if (amountNum > users[id].credits) return res.status(400).json({ error: 'Insufficient credits.' });
  if (targetDiscordId === id) return res.status(400).json({ error: 'Cannot transfer to yourself.' });

  // Validate target exists
  if (!users[targetDiscordId]) return res.status(404).json({ error: 'User not found. They must have logged in before.' });

  users[id].credits        -= amountNum;
  users[targetDiscordId].credits += amountNum;
  saveUsers();

  // Log transfer
  if (!users[id].transfers) users[id].transfers = [];
  users[id].transfers.unshift({ to: targetDiscordId, amount: amountNum, at: Date.now() });
  users[id].transfers = users[id].transfers.slice(0, 20);
  saveUsers();

  res.json({ success: true, creditsRemaining: users[id].credits, targetBalance: users[targetDiscordId].credits });
});

// ===== API: BUY CRYPTO =====
app.post('/api/payment/create', requireAuth, async (req, res) => {
  const { id } = req.session.user;
  const { currency, usdAmount } = req.body;
  const amt = parseInt(usdAmount);
  if (!amt || amt < 1) return res.status(400).json({ error: 'Minimum $1.' });
  if (!['btc', 'ltc'].includes(currency?.toLowerCase())) return res.status(400).json({ error: 'Only BTC or LTC supported.' });

  try {
    const data = await createNowPayment(id, currency.toLowerCase(), amt);
    const { payment_id, pay_address, pay_amount, pay_currency, expiration_estimate_date } = data;
    if (!payment_id || !pay_address) return res.status(500).json({ error: 'Incomplete NowPayments response.' });

    payments[payment_id] = {
      userId: id, usdAmount: amt, currency: pay_currency || currency,
      payAmount: pay_amount, payAddress: pay_address,
      status: 'waiting', createdAt: Date.now(),
      expiresAt: expiration_estimate_date ? new Date(expiration_estimate_date).getTime() : null,
    };
    savePayments();

    let qrDataUrl = null;
    try { qrDataUrl = await QRCode.toDataURL(pay_address, { width: 200, margin: 2 }); } catch {}

    res.json({ success: true, payment_id, pay_address, pay_amount, pay_currency: pay_currency || currency, expiration_estimate_date, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ===== API: PLACE BID =====
app.post('/api/bid/place', requireAuth, async (req, res) => {
  const { id } = req.session.user;
  const { slotIndex, amount } = req.body;
  const idx = parseInt(slotIndex);
  if (![1, 2].includes(idx)) return res.status(400).json({ error: 'Invalid slot.' });
  if (pauseState.bid) return res.status(400).json({ error: 'Bid slots are paused by admin.' });

  ensureUser(id);
  ensureAuction(idx);
  const aId    = getAuctionId(idx);
  const auction = auctions[aId];

  if (isBidSlotOnCooldown(idx)) return res.status(400).json({ error: `Slot occupied. Unlocks in ${formatTime(auction.cooldownUntil - Date.now())}` });
  if (auction.status === 'ended') return res.status(400).json({ error: 'Auction just ended.' });

  const bidAmt = parseInt(amount);
  if (isNaN(bidAmt) || bidAmt < BID_CONFIG.minBid) return res.status(400).json({ error: `Minimum bid is ${BID_CONFIG.minBid} credits.` });

  const topBid      = getTopBid(auction);
  const minBid      = topBid ? topBid.amount + 1 : BID_CONFIG.minBid;
  if (bidAmt < minBid) return res.status(400).json({ error: `Minimum bid is ${minBid} credits.` });

  const existingBid    = auction.bids.find(b => b.userId === id);
  const existingAmount = existingBid ? existingBid.amount : 0;
  const additionalCost = bidAmt - existingAmount;

  if (additionalCost > users[id].credits) return res.status(400).json({ error: `Need ${additionalCost} more credits (have ${users[id].credits}).` });

  users[id].credits -= additionalCost;
  if (existingBid) existingBid.amount = bidAmt;
  else auction.bids.push({ userId: id, amount: bidAmt });

  const isFirst = auction.status === 'idle';
  if (isFirst) {
    auction.status = 'live';
    auction.endsAt = Date.now() + BID_CONFIG.durationMins * 60000;
    setTimeout(() => endAuction(aId), BID_CONFIG.durationMins * 60000);
  } else {
    const timeLeft = auction.endsAt - Date.now();
    if (timeLeft < 60000) {
      auction.endsAt = Date.now() + 60000;
      endingAuctions.delete(aId);
      setTimeout(() => endAuction(aId), 60000);
    }
  }

  saveAuctions(); saveUsers();
  res.json({ success: true, bidAmount: bidAmt, creditsRemaining: users[id].credits, isFirst, endsAt: auction.endsAt });
});

// ===== API: ADMIN =====
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const allUsers = Object.entries(users).map(([id, u]) => ({
    id, username: u.username, credits: u.credits, lastLogin: u.lastLogin
  })).sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));

  const allSlots = slots.filter(s => s.expiry > Date.now());
  res.json({ users: allUsers, slots: allSlots, pauseState, payments: Object.keys(payments).length });
});

app.post('/api/admin/give-credits', requireAdmin, (req, res) => {
  const { userId, amount } = req.body;
  const amt = parseInt(amount);
  if (!userId || !amt) return res.status(400).json({ error: 'userId and amount required.' });
  ensureUser(userId);
  users[userId].credits += amt;
  saveUsers();
  res.json({ success: true, newBalance: users[userId].credits });
});

app.post('/api/admin/set-credits', requireAdmin, (req, res) => {
  const { userId, amount } = req.body;
  const amt = parseInt(amount);
  if (!userId || isNaN(amt)) return res.status(400).json({ error: 'userId and amount required.' });
  ensureUser(userId);
  users[userId].credits = amt;
  saveUsers();
  res.json({ success: true, newBalance: users[userId].credits });
});

app.post('/api/admin/pause', requireAdmin, (req, res) => {
  const { type, paused } = req.body;
  if (type === 'pro') pauseState.pro = !!paused;
  else if (type === 'bid') pauseState.bid = !!paused;
  savePause();
  res.json({ success: true, pauseState });
});

app.post('/api/admin/revoke-slot', requireAdmin, (req, res) => {
  const { userId, type } = req.body;
  slots = slots.filter(s => !(s.userId === userId && s.type === type));
  saveSlots();
  res.json({ success: true });
});

app.post('/api/admin/reset-auction', requireAdmin, async (req, res) => {
  const { auctionId } = req.body;
  if (!auctions[auctionId]) return res.status(404).json({ error: 'Auction not found.' });
  const auction = auctions[auctionId];
  await refundBidders(auction, null);
  auctions[auctionId] = { slotIndex: auction.slotIndex, status: 'idle', bids: [], endsAt: null, cooldownUntil: null, lastWinner: null };
  endingAuctions.delete(auctionId);
  saveAuctions(); saveUsers();
  res.json({ success: true });
});

app.post('/api/admin/force-end-auction', requireAdmin, async (req, res) => {
  const { auctionId } = req.body;
  if (!auctions[auctionId]) return res.status(404).json({ error: 'Auction not found.' });
  auctions[auctionId].status = 'live';
  endingAuctions.delete(auctionId);
  await endAuction(auctionId);
  res.json({ success: true });
});

// Lookup user by Discord ID or username for admin
app.get('/api/admin/find-user', requireAdmin, (req, res) => {
  const { query } = req.query;
  const results = Object.entries(users)
    .filter(([id, u]) => id.includes(query) || (u.username || '').toLowerCase().includes(query.toLowerCase()))
    .map(([id, u]) => ({ id, username: u.username, credits: u.credits }));
  res.json(results);
});

// ===== NOWPAYMENTS WEBHOOK =====
app.post('/webhook/nowpayments', express.raw({ type: '*/*' }), async (req, res) => {
  res.status(200).json({ ok: true });
  const body = req.body.toString('utf8');
  if (!body) return;
  const sig = req.headers['x-nowpayments-sig'];
  if (!verifyNowPaymentsSignature(body, sig)) return;
  let payload;
  try { payload = JSON.parse(body); } catch { return; }
  const { payment_id, payment_status, actually_paid, pay_currency, order_id, pay_amount, price_amount } = payload;
  if (!payment_id) return;
  if (!payments[payment_id]) {
    const userId = order_id?.split('_')[0];
    if (userId) {
      payments[payment_id] = { userId, usdAmount: price_amount || 0, currency: pay_currency || '', payAmount: pay_amount || 0, payAddress: payload.pay_address || '', status: 'waiting', createdAt: Date.now() };
      savePayments();
    } else return;
  }
  if (['finished', 'confirmed', 'partially_paid'].includes(payment_status)) {
    await deliverCredits(payment_id, payment_status, actually_paid, pay_currency);
  }
});

// ===== POLLING =====
setInterval(async () => {
  const pending = Object.entries(payments).filter(([, p]) => p.status === 'waiting');
  for (const [pid, rec] of pending) {
    if (Date.now() - rec.createdAt < 2 * 60000) continue;
    if (Date.now() - rec.createdAt > 90 * 60000) { payments[pid].status = 'expired'; savePayments(); continue; }
    try {
      const { data } = await axios.get(`https://api.nowpayments.io/v1/payment/${pid}`, { headers: { 'x-api-key': NOWPAYMENTS_API_KEY } });
      if (['finished', 'confirmed', 'partially_paid'].includes(data.payment_status)) {
        await deliverCredits(pid, data.payment_status, data.actually_paid, data.pay_currency);
      } else if (['failed', 'refunded', 'expired'].includes(data.payment_status)) {
        payments[pid].status = data.payment_status; savePayments();
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
}, 2 * 60000);

setInterval(() => {
  const before = slots.length;
  slots = slots.filter(s => s?.expiry > Date.now());
  if (slots.length !== before) saveSlots();
}, 60000);

setInterval(() => {
  for (const [aId, a] of Object.entries(auctions)) {
    if (a.status === 'live' && a.endsAt <= Date.now()) endAuction(aId);
  }
}, 10000);

// ===== OUTBOUND IP LOG =====
const https = require('https');
https.get('https://api.ipify.org?format=json', r => {
  let d = '';
  r.on('data', c => d += c);
  r.on('end', () => { try { console.log('🌐 Outbound IP:', JSON.parse(d).ip); } catch {} });
});

// ===== SERVE SPA =====
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/webhook')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== RESUME =====
for (let i = 1; i <= 2; i++) ensureAuction(i);
for (const [aId, a] of Object.entries(auctions)) {
  if (a.status === 'live') {
    const rem = a.endsAt - Date.now();
    if (rem <= 0) endAuction(aId);
    else { setTimeout(() => endAuction(aId), rem); console.log(`⏰ Resuming ${aId} (${Math.ceil(rem/1000)}s)`); }
  }
  if (a.cooldownUntil && a.cooldownUntil > Date.now()) {
    const rem = a.cooldownUntil - Date.now();
    setTimeout(() => {
      if (auctions[aId]) { auctions[aId] = { slotIndex: a.slotIndex, status: 'idle', bids: [], endsAt: null, cooldownUntil: null, lastWinner: null }; saveAuctions(); }
    }, rem);
  } else if (a.cooldownUntil && a.cooldownUntil <= Date.now() && a.status !== 'idle') {
    auctions[aId] = { slotIndex: a.slotIndex, status: 'idle', bids: [], endsAt: null, cooldownUntil: null, lastWinner: null };
    saveAuctions();
  }
}

app.listen(PORT, () => console.log(`✅ Vexis running on port ${PORT}`));
