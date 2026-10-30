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

// ================= ĐỊNH NGHĨA DỮ LIỆU (SCHEMAS) =================
// 1. Người chơi
const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, default: 'Thợ Mỏ' },
  diamonds: { type: Number, default: 0 },
  freePickaxes: { type: Number, default: 5 },
  lastRegen: { type: Date, default: Date.now },
  adPickaxes: { type: Number, default: 0 },
  landLevel: { type: Number, default: 1 } // Cấp đất 1 đến 10
});
const User = mongoose.model('User', UserSchema);

// 2. Mảnh đất của người chơi (200 ô, giấu kín 30 kim cương trên server)
const LandSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  landLevel: { type: Number, default: 1 },
  diamondTiles: [Number], // 30 vị trí bí mật (0 đến 199)
  dugTiles: [{ tileIndex: Number, hasDiamond: Boolean }], // Các ô đã đào
  diamondsFound: { type: Number, default: 0 } // Đào đủ 30 thì lên cấp đất
});
const Land = mongoose.model('Land', LandSchema);

// 3. Quản lý Pool Thưởng 3 ngày & 15.000 Ads
const PoolSchema = new mongoose.Schema({
  cycleId: { type: String, required: true },
  totalAdsWatched: { type: Number, default: 0 },
  targetAds: { type: Number, default: 15000 },
  endDate: { type: Date, required: true },
  isActive: { type: Boolean, default: true }
});
const Pool = mongoose.model('Pool', PoolSchema);

// 4. Quản lý phiên xem Ads & chống xem trùng
const AdSessionSchema = new mongoose.Schema({
  txId: { type: String, required: true, unique: true },
  telegramId: { type: String, required: true },
  action: { type: String, enum: ['GET_PICKAXE', 'DOUBLE_DIAMOND'] },
  status: { type: String, default: 'PENDING' },
  diamondAmount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 3600 }
});
const AdSession = mongoose.model('AdSession', AdSessionSchema);

// ================= HÀM TIỆN ÍCH =================
// Tạo 30 ô kim cương ngẫu nhiên trong 200 ô
function generateDiamondTiles() {
  const set = new Set();
  while (set.size < 30) {
    set.add(Math.floor(Math.random() * 200));
  }
  return Array.from(set);
}

// Lấy hoặc tạo Pool 3 ngày đang chạy
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

// ================= CÁC API CỦA GAME =================

// 1. Khởi động game & Đồng bộ dữ liệu
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

    // Tính toán hồi cuốc tự động (1 cuốc / 30 phút, tối đa 5)
    const now = new Date();
    const elapsedMinutes = (now - new Date(user.lastRegen)) / (1000 * 60);
    const regenCount = Math.floor(elapsedMinutes / 30);
    if (regenCount > 0 && user.freePickaxes < 5) {
      user.freePickaxes = Math.min(5, user.freePickaxes + regenCount);
      user.lastRegen = new Date(now - ((elapsedMinutes % 30) * 60 * 1000));
      await user.save();
    }

    // Lấy mảnh đất hiện tại
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
        dugTiles: land.dugTiles, // CHỈ gửi các ô ĐÃ đào, giấu 30 ô kim cương còn lại
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
    console.error('Lỗi Init:', err);
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

// 2. Hành động Đào đất
app.post('/api/dig', async (req, res) => {
  try {
    const { telegramId, tileIndex } = req.body;
    if (tileIndex < 0 || tileIndex >= 200) return res.status(400).json({ error: 'Ô đào không hợp lệ' });

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: 'Không tìm thấy người chơi' });

    // Kiểm tra còn cuốc không
    const totalPickaxes = user.freePickaxes + user.adPickaxes;
    if (totalPickaxes <= 0) {
      return res.status(400).json({ error: 'HẾT_CUỐC' });
    }

    // Lấy mảnh đất
    const land = await Land.findOne({ telegramId, landLevel: user.landLevel });
    if (!land) return res.status(404).json({ error: 'Không tìm thấy mảnh đất' });

    // Kiểm tra ô này đã đào chưa
    const alreadyDug = land.dugTiles.some(t => t.tileIndex === tileIndex);
    if (alreadyDug) return res.status(400).json({ error: 'Ô này đã đào rồi' });

    // Trừ 1 cuốc (ưu tiên trừ free trước, hết free trừ adPickaxes)
    if (user.freePickaxes > 0) {
      user.freePickaxes -= 1;
    } else {
      user.adPickaxes -= 1;
    }

    // Kiểm tra trúng kim cương hay trượt
    const isHit = land.diamondTiles.includes(tileIndex);
    land.dugTiles.push({ tileIndex, hasDiamond: isHit });

    let diamondsGained = 0;
    let leveledUp = false;
    let newLevel = user.landLevel;

    if (isHit) {
      // Kim cương nhận được = Cấp đất * 10
      diamondsGained = user.landLevel * 10;
      user.diamonds += diamondsGained;
      land.diamondsFound += 1;

      // Nếu đã đào hết 30 viên kim cương của mảnh này -> Lên cấp đất tiếp theo!
      if (land.diamondsFound >= 30 && user.landLevel < 10) {
        user.landLevel += 1;
        newLevel = user.landLevel;
        leveledUp = true;
        // Tạo sẵn mảnh đất mới cho cấp tiếp theo
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
    console.error('Lỗi Dig:', err);
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

// 3. Tạo mã phiên xem Ads trước khi hiển thị video
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
    res.status(500).json({ error: 'Lỗi tạo phiên xem ad' });
  }
});

// 4. WEBHOOK: Nhận S2S Postback từ Monetag khi người chơi xem xong video
app.get('/webhook/monetag', async (req, res) => {
  try {
    const { secret, user_id, tx_id, action } = req.query;

    // 1. Xác thực Secret Key
    if (secret !== MONETAG_SECRET) {
      return res.status(403).send('Forbidden: Sai Secret Key');
    }

    // 2. Tìm phiên xem Ads
    const session = await AdSession.findOne({ txId: tx_id });
    if (!session || session.status === 'COMPLETED') {
      return res.status(200).send('Session invalid or already rewarded');
    }

    session.status = 'COMPLETED';
    await session.save();

    // 3. Trao thưởng theo hành động
    const targetUserId = session.telegramId || user_id;
    if (session.action === 'GET_PICKAXE' || action === 'GET_PICKAXE') {
      // Cộng 1 Cuốc
      await User.updateOne({ telegramId: targetUserId }, { $inc: { adPickaxes: 1 } });
    } else if (session.action === 'DOUBLE_DIAMOND' || action === 'DOUBLE_DIAMOND') {
      // Nhân đôi kim cương (Cộng thêm đúng số kim cương vừa trúng)
      if (session.diamondAmount > 0) {
        await User.updateOne({ telegramId: targetUserId }, { $inc: { diamonds: session.diamondAmount } });
      }
    }

    // 4. Cộng dồn vào tiến độ 15.000 Ads của toàn Server
    await Pool.updateOne({ isActive: true }, { $inc: { totalAdsWatched: 1 } });

    console.log(`🎉 [POSTBACK THÀNH CÔNG] User ${targetUserId} đã hoàn thành xem video: ${session.action}`);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Lỗi Webhook Monetag:', err);
    return res.status(500).send('Internal Error');
  }
});

// 5. API Kiểm tra trạng thái phiên Ads (dùng để game tự động cộng cuốc trên màn hình)
app.get('/api/ads/check-session/:txId', async (req, res) => {
  const session = await AdSession.findOne({ txId: req.params.txId });
  if (session && session.status === 'COMPLETED') {
    return res.json({ completed: true, action: session.action });
  }
  return res.json({ completed: false });
});

// ================= CRON JOB 3 NGÀY QUẢN LÝ POOL =================
cron.schedule('0 0 */3 * *', async () => {
  console.log('⏰ [CRON JOB] Đang kiểm tra chu kỳ Pool thưởng 3 ngày...');
  const pool = await getActivePool();
  
  if (pool.totalAdsWatched >= 15000) {
    console.log('🏆 [POOL THÀNH CÔNG] Đạt mốc 15.000 Ads! Phát thưởng Top 3.');
    // Đánh dấu hoàn thành Pool cũ
    pool.isActive = false;
    await pool.save();

    // Reset kim cương toàn bộ người chơi về 0 để bắt đầu chu kỳ mới
    await User.updateMany({}, { $set: { diamonds: 0 } });

    // Tạo Pool 3 ngày mới
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
    console.log(`⚠️ [CHƯA ĐỦ 15.000 ADS] Hiện có: ${pool.totalAdsWatched}. Tự động cộng dồn thêm 3 ngày!`);
    const newEnd = new Date(pool.endDate);
    newEnd.setDate(newEnd.getDate() + 3);
    pool.endDate = newEnd;
    await pool.save();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Game Server đang chạy tại cổng ${PORT}`);
});
