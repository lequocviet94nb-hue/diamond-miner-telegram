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
  status: { type: String, default: 'PENDING' },
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

      // Phải đào đủ 30 kim cương mới lên cấp đất tiếp theo
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

// ================= WEBHOOK S2S MONETAG ĐÃ LỌC VALUED 100% =================
app.get('/webhook/monetag', async (req, res) => {
  try {
    const { secret, user_id, reward_type, tx_id, action } = req.query;

    // 1. Kiểm tra mã bí mật
    if (secret !== MONETAG_SECRET) {
      console.warn('❌ Cảnh báo: Sai Secret Key từ Postback');
      return res.status(403).send('Forbidden');
    }

    // 2. CHỐNG THOÁT SỚM: Chỉ chấp nhận nếu Monetag xác nhận 'valued' (Đã trả tiền)
    if (reward_type && reward_type !== 'valued') {
      console.warn(`⚠️ Bỏ qua lượt xem không hợp lệ (reward_type: ${reward_type}) của user: ${user_id}`);
      return res.status(200).send('Ignored non-valued view');
    }

    // 3. Tìm phiên xem: Khớp theo tx_id hoặc tìm phiên PENDING gần nhất của Telegram ID này
    let session = null;
    if (tx_id && tx_id !== '${ymid}' && tx_id.startsWith('tx_')) {
      session = await AdSession.findOne({ txId: tx_id });
    }
    if (!session && user_id) {
      session = await AdSession.findOne({ 
        telegramId: String(user_id), 
        status: 'PENDING' 
      }).sort({ createdAt: -1 });
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

    // 4. Cộng cuốc hoặc X2 Kim cương
    if (targetAction === 'GET_PICKAXE') {
      await User.updateOne({ telegramId: String(targetUserId) }, { $inc: { adPickaxes: 1 } });
      console.log(`✅ [HỢP LỆ - VALUED] Đã cộng 1 cuốc cho user: ${targetUserId}`);
    } else if (targetAction === 'DOUBLE_DIAMOND' && session && session.diamondAmount > 0) {
      await User.updateOne({ telegramId: String(targetUserId) }, { $inc: { diamonds: session.diamondAmount } });
      console.log(`✅ [HỢP LỆ - VALUED] Đã X2 kim cương cho user: ${targetUserId}`);
    }

    // 5. CHỈ TĂNG BỘ ĐẾM POOL KHI QUẢNG CÁO HỢP LỆ THẬT SỰ
    await Pool.updateOne({ isActive: true }, { $inc: { totalAdsWatched: 1 } });

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Lỗi Webhook Monetag:', err);
    return res.status(500).send('Error');
  }
});

// Kiểm tra phiên xem hoàn thành (Kiểm tra theo txId hoặc kiểm tra theo user)
app.get('/api/ads/check-session/:txId', async (req, res) => {
  const { txId } = req.params;
  const { telegramId } = req.query;

  let session = await AdSession.findOne({ txId });
  if (session && session.status === 'COMPLETED') {
    return res.json({ completed: true });
  }

  // Dự phòng: nếu tìm theo Telegram ID thấy phiên gần nhất đã hoàn tất
  if (telegramId) {
    const latest = await AdSession.findOne({ telegramId: String(telegramId) }).sort({ createdAt: -1 });
    if (latest && latest.status === 'COMPLETED') {
      return res.json({ completed: true });
    }
  }

  return res.json({ completed: false });
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
