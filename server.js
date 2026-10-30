const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONETAG_SECRET = process.env.MONETAG_SECRET || 'DiaM0nd_Secr3t_2026';

// ================= KẾT NỐI DATABASE =================
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Đã kết nối thành công MongoDB Atlas!'))
  .catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

// ================= SCHEMAS =================
const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, default: 'Thợ Mỏ' },
  diamonds: { type: Number, default: 0 },
  freePickaxes: { type: Number, default: 5 },
  lastRegen: { type: Date, default: Date.now },
  adPickaxes: { type: Number, default: 0 },
  landLevel: { type: Number, default: 1 }
});
const User = mongoose.model('User', UserSchema);

const LandSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  landLevel: { type: Number, default: 1 },
  diamondTiles: [Number],
  dugTiles: [{ tileIndex: Number, hasDiamond: Boolean }],
  diamondsFound: { type: Number, default: 0 }
});
const Land = mongoose.model('Land', LandSchema);

const PoolSchema = new mongoose.Schema({
  cycleId: { type: String, required: true },
  totalAdsWatched: { type: Number, default: 0 },
  targetAds: { type: Number, default: 15000 },
  endDate: { type: Date, required: true },
  isActive: { type: Boolean, default: true }
});
const Pool = mongoose.model('Pool', PoolSchema);

const AdSessionSchema = new mongoose.Schema({
  txId: { type: String, required: true, unique: true },
  telegramId: { type: String, required: true },
  action: { type: String, enum: ['GET_PICKAXE', 'DOUBLE_DIAMOND'] },
  status: { type: String, default: 'PENDING' },
  diamondAmount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 3600 }
});
const AdSession = mongoose.model('AdSession', AdSessionSchema);

function generateDiamondTiles() {
  const set = new Set();
  while (set.size < 30) {
    set.add(Math.floor(Math.random() * 200));
  }
  return Array.from(set);
}

async function getActivePool() {
  let pool = await Pool.findOne({ isActive: true });
  if (!pool) {
    const end = new Date();
    end.setDate(end.getDate() + 3);
    pool = await Pool.create({
      cycleId: 'cycle_' + Date.now(),
      totalAdsWatched: 0,
      targetAds: 15000,
      endDate: end,
      isActive: true
    });
  }
  return pool;
}

// ================= APIS =================

// 1. Khởi động game
app.post('/api/init', async (req, res) => {
  try {
    const { telegramId, username } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Thiếu telegramId' });

    let user = await User.findOne({ telegramId });
    if (!user) {
      user = await User.create({ telegramId, username: username || 'Thợ Mỏ' });
    } else if (username && user.username !== username) {
      user.username = username;
      await user.save();
    }

    const now = new Date();
    const elapsedMinutes = (now - new Date(user.lastRegen)) / (1000 * 60);
    const regenCount = Math.floor(elapsedMinutes / 30);
    if (regenCount > 0 && user.freePickaxes < 5) {
      user.freePickaxes = Math.min(5, user.freePickaxes + regenCount);
      user.lastRegen = new Date(now - ((elapsedMinutes % 30) * 60 * 1000));
      await user.save();
    }

    let land = await Land.findOne({ telegramId, landLevel: user.landLevel });
    if (!land) {
      land = await Land.create({
        telegramId,
        landLevel: user.landLevel,
        diamondTiles: generateDiamondTiles(),
        dugTiles: [],
        diamondsFound: 0
      });
    }

    const pool = await getActivePool();
    const leaderboard = await User.find().sort({ diamonds: -1 }).limit(3).select('username diamonds');

    res.json({
      success: true,
      user: {
        telegramId: user.telegramId,
        username: user.username,
        diamonds: user.diamonds,
        freePickaxes: user.freePickaxes,
        adPickaxes: user.adPickaxes,
        landLevel: user.landLevel
      },
      land: {
        level: land.landLevel,
        dugTiles: land.dugTiles,
        diamondsFound: land.diamondsFound
      },
      pool: {
        totalAdsWatched: pool.totalAdsWatched,
        targetAds: pool.targetAds,
        endDate: pool.endDate
      },
      leaderboard
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// 2. Đào đất
app.post('/api/dig', async (req, res) => {
  try {
    const { telegramId, tileIndex } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.freePickaxes + user.adPickaxes <= 0) {
      return res.status(400).json({ error: 'HẾT_CUỐC' });
    }

    const land = await Land.findOne({ telegramId, landLevel: user.landLevel });
    if (!land || land.dugTiles.some(t => t.tileIndex === tileIndex)) {
      return res.status(400).json({ error: 'Ô này đã đào rồi' });
    }

    if (user.freePickaxes > 0) {
      user.freePickaxes -= 1;
    } else {
      user.adPickaxes -= 1;
    }

    const isHit = land.diamondTiles.includes(tileIndex);
    land.dugTiles.push({ tileIndex, hasDiamond: isHit });

    let diamondsGained = 0;
    let leveledUp = false;
    let newLevel = user.landLevel;

    if (isHit) {
      diamondsGained = user.landLevel * 10;
      user.diamonds += diamondsGained;
      land.diamondsFound += 1;

      if (land.diamondsFound >= 30 && user.landLevel < 10) {
        user.landLevel += 1;
        newLevel = user.landLevel;
        leveledUp = true;
        await Land.create({
          telegramId,
          landLevel: newLevel,
          diamondTiles: generateDiamondTiles(),
          dugTiles: [],
          diamondsFound: 0
        });
      }
    }

    await user.save();
    await land.save();

    res.json({
      success: true,
      hit: isHit,
      diamondsGained,
      user: {
        diamonds: user.diamonds,
        freePickaxes: user.freePickaxes,
        adPickaxes: user.adPickaxes,
        landLevel: user.landLevel
      },
      diamondsFound: land.diamondsFound,
      leveledUp,
      newLevel
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi đào đất' });
  }
});

// 3. Tạo phiên xem Ads
app.post('/api/ads/create-session', async (req, res) => {
  try {
    const { telegramId, action, diamondAmount } = req.body;
    const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    await AdSession.create({
      txId,
      telegramId,
      action: action || 'GET_PICKAXE',
      diamondAmount: diamondAmount || 0,
      status: 'PENDING'
    });

    res.json({ success: true, txId });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi tạo phiên' });
  }
});

// 4. WEBHOOK S2S DUY NHẤT ĐƯỢC PHÉP CỘNG THƯỞNG (CHỐNG GIAN LẬN 100%)
app.get('/webhook/monetag', async (req, res) => {
  try {
    const { secret, user_id, tx_id, action } = req.query;

    if (secret !== MONETAG_SECRET) {
      console.warn('❌ Cảnh báo: Sai Secret Key từ Postback');
      return res.status(403).send('Forbidden');
    }

    let session = null;
    if (tx_id) {
      session = await AdSession.findOne({ txId: tx_id });
    }

    if (session && session.status === 'COMPLETED') {
      return res.status(200).send('Already rewarded');
    }

    const targetUserId = session ? session.telegramId : user_id;
    const targetAction = session ? session.action : (action || 'GET_PICKAXE');

    if (session) {
      session.status = 'COMPLETED';
      await session.save();
    }

    if (targetAction === 'GET_PICKAXE') {
      await User.updateOne({ telegramId: String(targetUserId) }, { $inc: { adPickaxes: 1 } });
      console.log(`✅ [S2S POSTBACK THẬT] Monetag xác nhận cộng 1 cuốc cho: ${targetUserId}`);
    } else if (targetAction === 'DOUBLE_DIAMOND' && session && session.diamondAmount > 0) {
      await User.updateOne({ telegramId: String(targetUserId) }, { $inc: { diamonds: session.diamondAmount } });
      console.log(`✅ [S2S POSTBACK THẬT] Monetag xác nhận X2 cho: ${targetUserId}`);
    }

    await Pool.updateOne({ isActive: true }, { $inc: { totalAdsWatched: 1 } });
    return res.status(200).send('OK');
  } catch (err) {
    return res.status(500).send('Error');
  }
});

// 5. Kiểm tra trạng thái phiên xem (game polling hỏi server)
app.get('/api/ads/check-session/:txId', async (req, res) => {
  const session = await AdSession.findOne({ txId: req.params.txId });
  if (session && session.status === 'COMPLETED') {
    return res.json({ completed: true, action: session.action });
  }
  return res.json({ completed: false });
});

// ================= CRON JOB 3 NGÀY QUẢN LÝ POOL =================
cron.schedule('0 0 */3 * *', async () => {
  const pool = await getActivePool();
  if (pool.totalAdsWatched >= 15000) {
    pool.isActive = false;
    await pool.save();
    await User.updateMany({}, { $set: { diamonds: 0 } });
    const end = new Date();
    end.setDate(end.getDate() + 3);
    await Pool.create({
      cycleId: 'cycle_' + Date.now(),
      totalAdsWatched: 0,
      targetAds: 15000,
      endDate: end,
      isActive: true
    });
  } else {
    const newEnd = new Date(pool.endDate);
    newEnd.setDate(newEnd.getDate() + 3);
    pool.endDate = newEnd;
    await pool.save();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Game Server đang chạy tại cổng ${PORT}`);
});
