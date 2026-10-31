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
  bombTiles: [Number],
  dugTiles: [{ 
    tileIndex: Number, 
    type: { type: String, enum: ['EMPTY', 'DIAMOND', 'BOMB'] } 
  }],
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
  status: { type: String, default: 'PENDING' }, // PENDING, COMPLETED, REJECTED
  postbackReceived: { type: Boolean, default: false }, // Đã nhận tín hiệu từ Monetag chưa
  diamondAmount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 3600 }
});
const AdSession = mongoose.model('AdSession', AdSessionSchema);

function generateLandTiles() {
  const allUsed = new Set();
  const diamondTiles = [];
  const bombTiles = [];

  while (diamondTiles.length < 30) {
    const r = Math.floor(Math.random() * 200);
    if (!allUsed.has(r)) {
      allUsed.add(r);
      diamondTiles.push(r);
    }
  }

  while (bombTiles.length < 10) {
    const r = Math.floor(Math.random() * 200);
    if (!allUsed.has(r)) {
      allUsed.add(r);
      bombTiles.push(r);
    }
  }

  return { diamondTiles, bombTiles };
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
      const { diamondTiles, bombTiles } = generateLandTiles();
      land = await Land.create({
        telegramId,
        landLevel: user.landLevel,
        diamondTiles,
        bombTiles,
        dugTiles: [],
        diamondsFound: 0
      });
    }

    const pool = await getActivePool();
    const leaderboard = await User.find().sort({ diamonds: -1 }).limit(3).select('username telegramId diamonds');

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

    const isHitDiamond = land.diamondTiles.includes(tileIndex);
    const isHitBomb = land.bombTiles && land.bombTiles.includes(tileIndex);

    let resultType = 'EMPTY';
    let diamondsGained = 0;
    let leveledUp = false;
    let newLevel = user.landLevel;

    if (isHitBomb) {
      resultType = 'BOMB';
      user.diamonds -= 20; // Bị nổ bom trừ 20 điểm (cho phép âm)
    } else if (isHitDiamond) {
      resultType = 'DIAMOND';
      diamondsGained = user.landLevel * 10;
      user.diamonds += diamondsGained;
      land.diamondsFound += 1;

      if (land.diamondsFound >= 30 && user.landLevel < 10) {
        user.landLevel += 1;
        newLevel = user.landLevel;
        leveledUp = true;
        const nextTiles = generateLandTiles();
        await Land.create({
          telegramId,
          landLevel: newLevel,
          diamondTiles: nextTiles.diamondTiles,
          bombTiles: nextTiles.bombTiles,
          dugTiles: [],
          diamondsFound: 0
        });
      }
    }

    land.dugTiles.push({ tileIndex, type: resultType });

    await user.save();
    await land.save();

    res.json({
      success: true,
      type: resultType,
      hitDiamond: isHitDiamond,
      hitBomb: isHitBomb,
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

app.post('/api/ads/create-session', async (req, res) => {
  try {
    const { telegramId, action, diamondAmount } = req.body;
    const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    await AdSession.create({
      txId,
      telegramId: String(telegramId).replace(/^\$/, ''),
      action: action || 'GET_PICKAXE',
      diamondAmount: diamondAmount || 0,
      status: 'PENDING',
      postbackReceived: false,
      createdAt: new Date()
    });

    res.json({ success: true, txId });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi tạo phiên' });
  }
});

// ================= WEBHOOK S2S MONETAG =================
app.get('/webhook/monetag', async (req, res) => {
  try {
    const { secret, user_id, reward_type, tx_id } = req.query;

    if (secret !== MONETAG_SECRET) {
      return res.status(403).send('Forbidden');
    }

    const cleanRewardType = String(reward_type || '').replace(/^\$/, '').trim();
    const cleanUserId = String(user_id || '').replace(/^\$/, '').trim();
    const cleanTxId = String(tx_id || '').replace(/^\$/, '').trim();

    if (cleanRewardType !== 'valued') {
      console.warn(`⚠️ Bỏ qua lượt xem không hợp lệ (reward_type: ${cleanRewardType}) của user: ${cleanUserId}`);
      return res.status(200).send('Ignored non-valued');
    }

    // Đánh dấu phiên này Monetag đã ghi nhận trả tiền
    let session = null;
    if (cleanTxId && cleanTxId.startsWith('tx_')) {
      session = await AdSession.findOne({ txId: cleanTxId });
    }
    if (!session && cleanUserId) {
      session = await AdSession.findOne({ 
        telegramId: cleanUserId, 
        status: 'PENDING' 
      }).sort({ createdAt: -1 });
    }

    if (session) {
      session.postbackReceived = true; // Đã nhận tín hiệu Monetag
      await session.save();
      console.log(`📡 Đã nhận tín hiệu Monetag cho phiên: ${session.txId}`);
    }

    return res.status(200).send('OK');
  } catch (err) {
    return res.status(500).send('Error');
  }
});

// ================= KIỂM TRA THỜI GIAN VÀ CỘNG THƯỞNG (CHẶT CHẼ 100%) =================
app.get('/api/ads/check-session/:txId', async (req, res) => {
  try {
    const { txId } = req.params;
    const { telegramId } = req.query;
    const cleanUser = String(telegramId || '').replace(/^\$/, '').trim();

    let session = await AdSession.findOne({ txId });
    if (!session && cleanUser) {
      session = await AdSession.findOne({ telegramId: cleanUser }).sort({ createdAt: -1 });
    }

    if (!session) {
      return res.json({ completed: false });
    }

    if (session.status === 'COMPLETED') {
      return res.json({ completed: true });
    }

    if (session.status === 'REJECTED') {
      return res.json({ completed: false, rejected: true, message: 'Bạn đã tắt quảng cáo quá sớm!' });
    }

    // ĐO THỜI GIAN THỰC TẾ NGƯỜI CHƠI XEM QUẢNG CÁO (TÍNH BẰNG GIÂY)
    const elapsedSeconds = (Date.now() - new Date(session.createdAt).getTime()) / 1000;

    // 1. NẾU THOÁT RA QUÁ SỚM (DƯỚI 15 GIÂY) -> HỦY BỎ NGAY LẬP TỨC!
    if (elapsedSeconds < 15) {
      session.status = 'REJECTED';
      await session.save();
      console.warn(`🚫 [CHẶN GIAN LẬN] User ${session.telegramId} tắt sớm (${elapsedSeconds.toFixed(1)}s < 15s) -> HỦY BỎ!`);
      return res.json({ 
        completed: false, 
        rejected: true, 
        message: `Bạn đã tắt quảng cáo quá sớm (mới được ${Math.floor(elapsedSeconds)} giây)! Phải xem ít nhất 15 giây mới được tính!` 
      });
    }

    // 2. BẮT BUỘC: ĐÃ ĐỦ 15 GIÂY VÀ MONETAG ĐÃ GỬI TÍN HIỆU XÁC NHẬN TRẢ TIỀN
    if (session.postbackReceived && session.status === 'PENDING') {
      session.status = 'COMPLETED';
      await session.save();

      // CỘNG CUỐC HOẶC X2
      if (session.action === 'GET_PICKAXE') {
        await User.updateOne({ telegramId: session.telegramId }, { $inc: { adPickaxes: 1 } });
        console.log(`🎉 [XEM ĐỦ 15S + HỢP LỆ] ĐÃ CỘNG 1 CUỐC CHO USER: ${session.telegramId}`);
      } else if (session.action === 'DOUBLE_DIAMOND' && session.diamondAmount > 0) {
        await User.updateOne({ telegramId: session.telegramId }, { $inc: { diamonds: session.diamondAmount } });
        console.log(`🎉 [XEM ĐỦ 15S + HỢP LỆ] ĐÃ X2 CHO USER: ${session.telegramId}`);
      }

      // CHỈ KHI XEM ĐỦ 15S HỢP LỆ MỚI TĂNG TIẾN ĐỘ QUỸ THƯỞNG 15.000 ADS
      await Pool.updateOne({ isActive: true }, { $inc: { totalAdsWatched: 1 } });

      return res.json({ completed: true });
    }

    return res.json({ completed: false });
  } catch (err) {
    return res.status(500).json({ error: 'Lỗi check' });
  }
});

// ================= CRON JOB 3 NGÀY =================
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
