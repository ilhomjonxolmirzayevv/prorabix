require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session, InputFile } = require("grammy");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cron = require("node-cron");

// --- 0. EXPRESS VEB SERVER (KOYEB VA PORT UCHUN) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("Bot ishlayapti");
});

app.listen(PORT, () => {
    console.log(`🌐 Veb server ${PORT}-portda muvaffaqiyatli ishlamoqda.`);
});

// --- 1. MONGODB MODELLARI ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("🟢 MongoDB-ga muvaffaqiyatli ulanildi."))
    .catch(err => console.error("🔴 MongoDB ulanishida xatolik:", err));

const User = mongoose.model("User", new mongoose.Schema({
    telegramId: { type: Number, unique: true, required: true },
    role: { type: String, enum: ['super_admin', 'user'], default: 'user' },
    phone: String,
    fullName: String,
    username: String,
    dailyRate: { type: Number, default: 0 }
}));

const CompanyObject = mongoose.model("CompanyObject", new mongoose.Schema({
    objectId: { type: String, unique: true, required: true },
    name: String,
    creatorId: Number,
    workers: [Number],
    formerWorkers: { type: [Number], default: [] }, // obyektdan chiqarilgan ishchilar (tarixi saqlanadi)
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    createdAt: { type: Date, default: Date.now }
}));

const Attendance = mongoose.model("Attendance", new mongoose.Schema({
    telegramId: Number,
    objectId: String,
    date: { type: String, required: true }, // YYYY-MM-DD
    timestamp: { type: Date, default: Date.now },
    status: { type: String, enum: ['full', 'half', 'absent'] },
    markedBy: Number // brigadir ishchi o'rniga belgilagan bo'lsa, brigadir telegramId
}));

const Payment = mongoose.model("Payment", new mongoose.Schema({
    telegramId: Number,
    objectId: String,
    amount: Number,
    date: { type: Date, default: Date.now }, // yozuv kiritilgan vaqt
    dateStr: String,   // YYYY-MM-DD (pul berilgan kun)
    givenBy: Number    // pulni bergan brigadir telegramId
}));

// --- 2. BOTNI ISHGA TUSHIRISH ---
const bot = new Bot(process.env.BOT_TOKEN);

bot.use(session({
    initial: () => ({
        step: null,
        phone: null,
        fullName: null,
        payload: null,
        targetWorkerId: null,
        targetObjId: null,
        payAmount: null
    })
}));

const systemButtons = [
    "🏢 Yangi Obyekt Ochish",
    "📂 Mening Obyektlarim",
    "🤝 Qo'shilgan Obyektlarim",
    "📅 Bugungi Davomat",
    "📝 Mening kunlarim (Tahrirlash)",
    "⚙️ Sozlamalar",
    "📊 Global Statistika"
];

const CANCEL_TEXT = "🔙 Orqaga";
const REG_STEPS = ['get_phone', 'get_name', 'get_rate'];

// --- YORDAMCHI FUNKSIYALAR ---
const TZ = "Asia/Tashkent";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatPhoneNumber(text) {
    if (!text) return null;
    let cleaned = text.replace(/\D/g, '');
    if (cleaned.startsWith('998') && cleaned.length === 12) return `+${cleaned}`;
    if (cleaned.length === 9) return `+998${cleaned}`;
    return null;
}

// Summani o'qish: "200 000", "200,000", "200.000" -> 200000; noto'g'ri bo'lsa NaN
function parseAmount(text) {
    const d = (text || "").replace(/[\s,._]/g, '');
    if (!/^\d+$/.test(d)) return NaN;
    return parseInt(d, 10);
}

// Toshkent vaqti bo'yicha bugungi sana (YYYY-MM-DD)
function todayStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// Hafta kuni qisqartmasi
const WEEKDAYS = ["Yak", "Du", "Se", "Chor", "Pay", "Juma", "Shan"];
function weekdayShort(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().split('T')[0];
}

// "2026-10-05" yoki "05.10.2026" -> "2026-10-05"; noto'g'ri bo'lsa null
function parseDateInput(text) {
    const t = (text || "").trim();
    let y, m, d;
    let mt = t.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
    if (mt) {
        y = +mt[1]; m = +mt[2]; d = +mt[3];
    } else {
        mt = t.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/);
        if (!mt) return null;
        d = +mt[1]; m = +mt[2]; y = +mt[3];
    }
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().split('T')[0];
}

function formatMoney(amount) {
    return new Intl.NumberFormat('fr-FR').format(amount || 0) + " so'm";
}

function statusIcon(status) {
    if (status === 'full') return "✅";
    if (status === 'half') return "🟡";
    if (status === 'absent') return "❌";
    return "⚪️";
}

function statusLabel(status) {
    if (status === 'full') return "To'liq kun";
    if (status === 'half') return "Yarim smena";
    if (status === 'absent') return "Kelmadi";
    return "Belgilanmagan";
}

// Pul berilgan sana (eski yozuvlarda dateStr bo'lmasa, date dan olinadi)
function paymentDateStr(p) {
    return p.dateStr || new Date(p.date).toLocaleDateString('en-CA', { timeZone: TZ });
}

function comparePayments(a, b) {
    const da = paymentDateStr(a), db = paymentDateStr(b);
    if (da !== db) return da < db ? -1 : 1;
    return new Date(a.date) - new Date(b.date);
}

// Telegram 4096 belgi limiti uchun matnni bo'laklarga ajratish
function chunkText(header, lines) {
    const chunks = [];
    let cur = header;
    for (const line of lines) {
        if ((cur + "\n" + line).length > 3800) {
            chunks.push(cur);
            cur = line;
        } else {
            cur += "\n" + line;
        }
    }
    chunks.push(cur);
    return chunks;
}

// --- DAVRLAR (hafta, 30 kun, shu oy, o'tgan oy, umumiy) ---
function periodTitle(f) {
    if (f === 'week') return "1 Haftalik";
    if (f === 'month') return "30 kunlik";
    if (f === 'thismonth') return "Shu oy";
    if (f === 'lastmonth') return "O'tgan oy";
    return "Umumiy Loyiha";
}

// { from, to } (YYYY-MM-DD) yoki null (umumiy)
function periodRange(f) {
    const today = todayStr();
    if (f === 'week') return { from: addDays(today, -6), to: today };
    if (f === 'month') return { from: addDays(today, -29), to: today };
    if (f === 'thismonth') return { from: today.slice(0, 8) + "01", to: today };
    if (f === 'lastmonth') {
        const [y, m] = today.split("-").map(Number);
        const first = new Date(Date.UTC(y, m - 2, 1));
        const last = new Date(Date.UTC(y, m - 1, 0));
        return { from: first.toISOString().split('T')[0], to: last.toISOString().split('T')[0] };
    }
    return null;
}

function addFilterButtons(kb, prefix, objectId, current) {
    const items = [["week", "1 Hafta"], ["month", "30 kun"], ["thismonth", "Shu oy"], ["lastmonth", "O'tgan oy"], ["all", "Umumiy"]];
    items.forEach(([key, label], i) => {
        kb.text(current === key ? `• ${label} •` : label, `${prefix}_${objectId}_${key}`);
        if (i === 2) kb.row();
    });
    kb.row();
}

function generateDaysRange(filterType, firstAttendanceDate) {
    const today = todayStr();
    const dates = [];

    if (filterType === 'week' || filterType === 'month') {
        const count = filterType === 'week' ? 7 : 30;
        for (let i = 0; i < count; i++) dates.push(addDays(today, -i));
        return dates;
    }

    if (filterType === 'all') {
        let cur = firstAttendanceDate || today;
        while (cur <= today) {
            dates.push(cur);
            cur = addDays(cur, 1);
        }
        return dates.reverse();
    }

    return dates;
}

// Davr bo'yicha berilgan pullar (sana bo'yicha tartiblangan)
async function getPaymentsInPeriod(telegramId, objectId, filterType = 'all') {
    const range = periodRange(filterType);
    const all = await Payment.find({ telegramId, objectId });
    const list = range
        ? all.filter(p => {
            const d = paymentDateStr(p);
            return d >= range.from && d <= range.to;
        })
        : all;
    return list.sort(comparePayments);
}

async function getWorkerObjectStats(telegramId, objectId, dailyRate, filterType = 'all') {
    const query = { telegramId, objectId };
    const range = periodRange(filterType);
    if (range) query.date = { $gte: range.from, $lte: range.to };

    const attendances = await Attendance.find(query);

    let totalEarnedDays = 0;
    attendances.forEach(a => {
        if (a.status === 'full') totalEarnedDays += 1;
        if (a.status === 'half') totalEarnedDays += 0.5;
    });

    const totalEarnedMoney = totalEarnedDays * dailyRate;
    const payments = await getPaymentsInPeriod(telegramId, objectId, filterType);
    const totalPaidMoney = payments.reduce((sum, p) => sum + p.amount, 0);
    const paidDays = dailyRate > 0 ? (totalPaidMoney / dailyRate) : 0;

    const remainingDays = totalEarnedDays - paidDays;
    const remainingMoney = totalEarnedMoney - totalPaidMoney;

    return {
        totalEarnedDays,
        totalEarnedMoney,
        totalPaidMoney,
        paidDays: parseFloat(paidDays.toFixed(1)),
        remainingDays: parseFloat(remainingDays.toFixed(1)),
        remainingMoney
    };
}

// Obyektning barcha ishchilari (hozirgi + chiqarilganlar)
function allWorkerIds(obj) {
    return [...obj.workers, ...(obj.formerWorkers || [])];
}

// --- CSV HISOBOT GENERATORI ---
async function generateCSVReport(obj, workers, filterType = 'all') {
    const q = (cell) => `"${String(cell).replace(/"/g, '""')}"`;
    const csvLines = ["sep=;"];

    const headerCells = [`Ishchi Ismi (${periodTitle(filterType)})`, "Telefon Raqami", "Kunlik Stavka", "Ishlagan Smenasi", "Ish Haqi", "Olingan Pul (Avans)", "Pul Berilgan Kunlar", "Qolgan Ish Kuni", "Qolgan Jami Pul"];
    csvLines.push(headerCells.map(q).join(";"));

    const paymentRows = [];

    for (const worker of workers) {
        const stats = await getWorkerObjectStats(worker.telegramId, obj.objectId, worker.dailyRate || 0, filterType);
        const former = (obj.formerWorkers || []).includes(worker.telegramId);
        const name = (worker.fullName || "Ismsiz") + (former ? " (chiqqan)" : "");
        const phone = worker.phone || "-";

        const rowCells = [
            name, phone, `${worker.dailyRate || 0} so'm`,
            `${stats.totalEarnedDays} kun`, `${stats.totalEarnedMoney} so'm`,
            `${stats.totalPaidMoney} so'm`, `${stats.paidDays} kun`,
            `${stats.remainingDays} kun`, `${stats.remainingMoney} so'm`
        ];
        csvLines.push(rowCells.map(q).join(";"));

        const pays = await getPaymentsInPeriod(worker.telegramId, obj.objectId, filterType);
        pays.forEach(p => {
            const d = paymentDateStr(p);
            paymentRows.push([name, d, weekdayShort(d), `${p.amount} so'm`]);
        });
    }

    csvLines.push("");
    csvLines.push(q("Berilgan pullar (sanasi bilan)"));
    csvLines.push(["Ishchi Ismi", "Sana", "Hafta kuni", "Summa"].map(q).join(";"));
    if (paymentRows.length === 0) {
        csvLines.push(q("Bu davrda pul berilmagan"));
    } else {
        paymentRows.forEach(r => csvLines.push(r.map(q).join(";")));
    }

    const csvContent = "\uFEFF" + csvLines.join("\r\n");
    const fileName = `${obj.name.replace(/[^a-z0-9]/gi, '_')}_${filterType}_hisobot_${Math.floor(Math.random() * 1000)}.csv`;
    const filePath = path.join(__dirname, fileName);

    fs.writeFileSync(filePath, csvContent, "utf-8");
    return { filePath, fileName };
}

function getMainMenu(role) {
    const keyboard = new Keyboard();
    keyboard.text("🏢 Yangi Obyekt Ochish").text("📂 Mening Obyektlarim").row();
    keyboard.text("🤝 Qo'shilgan Obyektlarim").text("📅 Bugungi Davomat").row();
    keyboard.text("📝 Mening kunlarim (Tahrirlash)").text("⚙️ Sozlamalar");

    if (role === 'super_admin') {
        keyboard.row().text("📊 Global Statistika");
    }
    return keyboard.resized();
}

// Matn kutilayotgan bosqichlarda chiqadigan "Orqaga" tugmasi
function cancelKeyboard() {
    return new Keyboard().text(CANCEL_TEXT).resized();
}

// Brigadirning obyektlar ro'yxati ko'rinishi (faol + yopilganlar tugmasi)
async function buildMyObjectsView(userId) {
    const [active, closedCount] = await Promise.all([
        CompanyObject.find({ creatorId: userId, status: 'active' }),
        CompanyObject.countDocuments({ creatorId: userId, status: 'closed' })
    ]);
    if (active.length === 0 && closedCount === 0) return null;

    const kb = new InlineKeyboard();
    active.forEach(o => kb.text(`🏗 ${o.name}`, `manage-obj_${o.objectId}_all`).row());
    if (closedCount > 0) kb.text(`🗄 Yopilgan obyektlar (${closedCount})`, "closed-objs").row();

    const text = active.length
        ? "🏗 **O'zingiz ochgan obyektlardan birini tanlang:**"
        : "📭 Faol obyektlar yo'q. Yopilganlarini qayta ochishingiz mumkin:";
    return { text, kb, single: active.length === 1 ? active[0] : null };
}

// Callback uchun: obyekt shu foydalanuvchiniki va faolmi? Aks holda callbackni rad etadi.
async function getOwnedActiveObject(ctx, objectId) {
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj || obj.creatorId !== ctx.from.id || obj.status !== 'active') {
        await ctx.answerCallbackQuery("Ruxsat yo'q yoki obyekt faol emas.");
        return null;
    }
    return obj;
}

// --- ESLATMA VA XULOSA (HAR KUNI 18:30) ---
// Ishchilarga: bugun davomat kiritmaganlarga eslatma
async function sendReminders() {
    const today = todayStr();
    const objects = await CompanyObject.find({ status: 'active' });
    const pending = {}; // telegramId -> [obj, ...]

    for (const obj of objects) {
        const marked = (await Attendance.find({ objectId: obj.objectId, date: today }, 'telegramId'))
            .map(a => a.telegramId);
        for (const wid of obj.workers) {
            if (!marked.includes(wid)) {
                (pending[wid] = pending[wid] || []).push(obj);
            }
        }
    }

    let sent = 0, failed = 0;
    for (const [telegramId, objs] of Object.entries(pending)) {
        const kb = new InlineKeyboard();
        objs.forEach(o => kb.text(`👷‍♂️ ${o.name}`, `mark-att_${o.objectId}`).row());
        try {
            await bot.api.sendMessage(
                Number(telegramId),
                `⏰ *Eslatma!*\nBugun (${today}, ${weekdayShort(today)}) davomatni kiritmadingiz. Obyektni tanlang:`,
                { parse_mode: "Markdown", reply_markup: kb }
            );
            sent++;
        } catch (e) {
            failed++;
        }
        await sleep(50); // Telegram limitlari uchun
    }
    return { sent, failed };
}

// Brigadirlarga: bugungi davomat xulosasi (kim kiritdi, kim kiritmadi)
async function sendForemanSummaries() {
    const today = todayStr();
    const objects = await CompanyObject.find({ status: 'active' });
    const byCreator = {};
    objects.forEach(o => { (byCreator[o.creatorId] = byCreator[o.creatorId] || []).push(o); });

    let sent = 0, failed = 0;
    for (const [creatorId, objs] of Object.entries(byCreator)) {
        const lines = [`📋 Bugungi davomat xulosasi (${today}, ${weekdayShort(today)})`];
        const kb = new InlineKeyboard();
        let hasButtons = false;

        for (const obj of objs) {
            const marked = (await Attendance.find({ objectId: obj.objectId, date: today }, 'telegramId'))
                .map(a => a.telegramId);
            const missingIds = obj.workers.filter(w => !marked.includes(w));
            const total = obj.workers.length;

            lines.push(`\n🏗 ${obj.name}: ${total - missingIds.length}/${total} ishchi kiritdi`);
            if (missingIds.length > 0) {
                const users = await User.find({ telegramId: { $in: missingIds } }, 'fullName');
                lines.push(`❌ Kiritmadi: ${users.map(u => u.fullName || "Ismsiz").join(", ")}`);
                kb.text(`✍️ ${obj.name} — belgilash`, `fm-list:${obj.objectId}:${today}`).row();
                hasButtons = true;
            } else {
                lines.push("✅ Hammasi kiritdi");
            }
        }

        try {
            await bot.api.sendMessage(Number(creatorId), lines.join("\n"), hasButtons ? { reply_markup: kb } : undefined);
            sent++;
        } catch (e) {
            failed++;
        }
        await sleep(50);
    }
    return { sent, failed };
}

async function runEveningJobs() {
    const reminders = await sendReminders();
    const summaries = await sendForemanSummaries();
    return { reminders, summaries };
}

// --- ADMIN YORDAMCHILARI ---
async function isAdmin(ctx) {
    const u = await User.findOne({ telegramId: ctx.from.id });
    return u?.role === 'super_admin';
}

function adminMenu() {
    return new InlineKeyboard()
        .text("📊 Statistika", "adm_stats").text("👥 Foydalanuvchilar", "adm_users").row()
        .text("🏗 Obyektlar", "adm_objects").text("🔒 Yopilgan obyektlar", "adm_closed").row()
        .text("📢 Xabar yuborish", "adm_broadcast").text("🔔 Eslatmani hozir yuborish", "adm_remind");
}

const backToAdmin = () => new InlineKeyboard().text("🔙 Admin menyu", "adm_menu");

// --- PUL BERISHNI YAKUNLASH (sana tanlangandan keyin) ---
async function finalizePayment(ctx, given) {
    const userId = ctx.from.id;
    const me = await User.findOne({ telegramId: userId });
    const workerId = ctx.session.targetWorkerId;
    const objId = ctx.session.targetObjId;
    const amount = ctx.session.payAmount;

    ctx.session.step = null;
    ctx.session.payAmount = null;
    ctx.session.targetWorkerId = null;
    ctx.session.targetObjId = null;

    if (!workerId || !objId || !amount) {
        return ctx.reply("⚠️ Ma'lumot eskirgan. Iltimos, qaytadan urinib ko'ring.", { reply_markup: getMainMenu(me?.role || 'user') });
    }

    await Payment.create({
        telegramId: workerId,
        objectId: objId,
        amount,
        dateStr: given,
        givenBy: userId
    });

    const worker = await User.findOne({ telegramId: workerId });
    const obj = await CompanyObject.findOne({ objectId: objId });
    const dateLine = `${given} (${weekdayShort(given)})`;

    await ctx.reply(
        `✅ Pul kiritildi!\n\n👤 Ishchi: ${worker?.fullName || "Noma'lum"}\n🏗 Obyekt: ${obj?.name || "-"}\n💵 Summa: ${formatMoney(amount)}\n📅 Sana: ${dateLine}\n\nIshchining umumiy balansidan chegirildi.`,
        { reply_markup: getMainMenu(me?.role || 'user') }
    );
    try {
        await bot.api.sendMessage(
            workerId,
            `💰 Sizga "${obj?.name || 'obyekt'}" obyekti bo'yicha ${formatMoney(amount)} avans berildi.\n📅 Sana: ${dateLine}`
        );
    } catch (e) { }
}

// --- BRIGADIR: ISHCHI O'RNIGA DAVOMAT BELGILASH (ro'yxat ko'rinishi) ---
async function renderFmList(ctx, obj, date, note = "") {
    const workers = await User.find({ telegramId: { $in: obj.workers } });
    const atts = await Attendance.find({ objectId: obj.objectId, date });
    const map = {};
    atts.forEach(a => { map[a.telegramId] = a.status; });

    const today = todayStr();
    const kb = new InlineKeyboard();
    workers.forEach(w => {
        kb.text(`${statusIcon(map[w.telegramId])} ${w.fullName || "Ismsiz"}`, `fm-w:${obj.objectId}:${w.telegramId}:${date}`).row();
    });
    kb.text(`◀️ ${addDays(date, -1)}`, `fm-list:${obj.objectId}:${addDays(date, -1)}`);
    if (date < today) kb.text(`${addDays(date, 1)} ▶️`, `fm-list:${obj.objectId}:${addDays(date, 1)}`);
    kb.row().text("🔙 Obyektga qaytish", `manage-obj_${obj.objectId}_all`);

    return ctx.editMessageText(
        `${note}✍️ ${obj.name}\n📅 Sana: ${date} (${weekdayShort(date)})\n\nIshchini tanlang (⚪️ — belgilanmagan):`,
        { reply_markup: kb }
    );
}

// --- START ---
bot.command("start", async (ctx) => {
    const userId = ctx.from.id;
    const startPayload = ctx.match;
    const username = ctx.from.username ? `@${ctx.from.username}` : "Mavjud emas";
    ctx.session.step = null;

    const usersCount = await User.countDocuments();
    if (usersCount === 0) {
        await User.create({ telegramId: userId, role: 'super_admin', fullName: "Asosiy Admin", username, dailyRate: 0 });
        return ctx.reply("👑 **Muvaffaqiyatli Tizim Asosiy Admini bo'ldingiz!**", { reply_markup: getMainMenu('super_admin') });
    }

    const user = await User.findOne({ telegramId: userId });

    if (startPayload && startPayload.startsWith("obj_")) {
        const obj = await CompanyObject.findOne({ objectId: startPayload });

        if (obj && obj.status === 'closed') {
            return ctx.reply("🚫 **Ushbu obyekt/firma faoliyati butunlay yopilgan!**\nUnga havola orqali kirish imkonsiz.");
        }

        if (user) {
            await CompanyObject.findOneAndUpdate(
                { objectId: startPayload },
                { $addToSet: { workers: userId }, $pull: { formerWorkers: userId } }
            );
            return ctx.reply(`🏢 Siz yangi: **"${obj?.name || 'Obyekt'}"** obyektiga muvaffaqiyatli a'zo bo'ldingiz!`, {
                reply_markup: getMainMenu(user.role)
            });
        } else {
            ctx.session.step = 'get_phone';
            ctx.session.payload = startPayload;
            const phoneKeyboard = new Keyboard().requestContact("📞 Telefon yuborish").resized().oneTime();
            return ctx.reply("👋 **Xush kelibsiz!**\nObyektga qo'shilish uchun avval telefon raqamingizni yuboring:", { reply_markup: phoneKeyboard });
        }
    }

    if (!user) {
        ctx.session.step = 'get_phone';
        const phoneKeyboard = new Keyboard().requestContact("📞 Telefon yuborish").resized().oneTime();
        return ctx.reply("👋 **Xush kelibsiz!**\nBotdan foydalanish uchun telefon raqamingizni yuboring:", { reply_markup: phoneKeyboard });
    }

    return ctx.reply(`👋 **Xush kelibsiz, ${user.fullName}!**`, { reply_markup: getMainMenu(user.role) });
});

// --- /cancel ---
bot.command("cancel", async (ctx) => {
    if (REG_STEPS.includes(ctx.session.step)) return;
    ctx.session.step = null;
    ctx.session.payAmount = null;
    const u = await User.findOne({ telegramId: ctx.from.id });
    return ctx.reply("🏠 Asosiy menyu", { reply_markup: getMainMenu(u?.role || 'user') });
});

// --- /admin PANEL ---
bot.command("admin", async (ctx) => {
    if (!(await isAdmin(ctx))) return ctx.reply("🚫 Sizda ruxsat yo'q.");
    ctx.session.step = null;
    return ctx.reply("👑 Admin panel", { reply_markup: adminMenu() });
});

bot.callbackQuery(/^adm_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery("Ruxsat yo'q");
    const action = ctx.match[1];
    await ctx.answerCallbackQuery();

    if (action === "stats") {
        const [users, active, closed, todayAtt] = await Promise.all([
            User.countDocuments(),
            CompanyObject.countDocuments({ status: 'active' }),
            CompanyObject.countDocuments({ status: 'closed' }),
            Attendance.countDocuments({ date: todayStr() })
        ]);
        return ctx.reply(
            `📊 Statistika\n\n👥 Foydalanuvchilar: ${users}\n🏗 Faol obyektlar: ${active}\n🔒 Yopilgan obyektlar: ${closed}\n📅 Bugungi davomat yozuvlari: ${todayAtt}`,
            { reply_markup: backToAdmin() }
        );
    }

    if (action === "users") {
        const users = await User.find().sort({ _id: -1 }).limit(30);
        const list = users.map((u, i) =>
            `${i + 1}. ${u.fullName || "Ismsiz"} — ${u.phone || "-"} ${u.role === 'super_admin' ? "👑" : ""}`
        ).join("\n");
        return ctx.reply(`👥 So'nggi 30 ta foydalanuvchi:\n\n${list || "Bo'sh"}`, { reply_markup: backToAdmin() });
    }

    if (action === "objects") {
        const objs = await CompanyObject.find().sort({ createdAt: -1 }).limit(40);
        const list = objs.map((o, i) =>
            `${i + 1}. ${o.status === 'active' ? "🟢" : "🔒"} ${o.name} — ${o.workers.length} ishchi`
        ).join("\n");
        return ctx.reply(`🏗 Obyektlar:\n\n${list || "Bo'sh"}`, { reply_markup: backToAdmin() });
    }

    if (action === "closed") {
        const objs = await CompanyObject.find({ status: 'closed' }).sort({ createdAt: -1 }).limit(50);
        if (objs.length === 0) {
            return ctx.reply("📭 Yopilgan obyektlar yo'q.", { reply_markup: backToAdmin() });
        }
        const owners = await User.find({ telegramId: { $in: [...new Set(objs.map(o => o.creatorId))] } }, 'telegramId fullName');
        const ownerOf = {};
        owners.forEach(u => { ownerOf[u.telegramId] = u.fullName || "Ismsiz"; });

        const kb = new InlineKeyboard();
        objs.forEach(o => kb.text(`🔒 ${o.name} · ${(ownerOf[o.creatorId] || "Noma'lum").slice(0, 14)}`, `adm-ro_${o.objectId}`).row());
        kb.text("🔙 Admin menyu", "adm_menu");
        return ctx.reply(`🔒 Yopilgan obyektlar (${objs.length} ta). Qayta ochish uchun tanlang:`, { reply_markup: kb });
    }

    if (action === "broadcast") {
        ctx.session.step = 'admin_broadcast';
        return ctx.reply("📢 Hammaga yuboriladigan xabar matnini yozing:", { reply_markup: cancelKeyboard() });
    }

    if (action === "remind") {
        const r = await runEveningJobs();
        return ctx.reply(
            `🔔 Ishchilarga eslatma: ${r.reminders.sent} ta, xato: ${r.reminders.failed} ta\n📋 Brigadirlarga xulosa: ${r.summaries.sent} ta, xato: ${r.summaries.failed} ta`,
            { reply_markup: backToAdmin() }
        );
    }

    if (action === "menu") {
        return ctx.reply("👑 Admin panel", { reply_markup: adminMenu() });
    }
});

// Admin: yopilgan obyektni qayta ochish (tasdiqlash)
bot.callbackQuery(/^adm-ro_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery("Ruxsat yo'q");
    const obj = await CompanyObject.findOne({ objectId: ctx.match[1] });
    if (!obj || obj.status !== 'closed') return ctx.answerCallbackQuery("Obyekt topilmadi yoki allaqachon ochiq.");
    await ctx.answerCallbackQuery();

    const owner = await User.findOne({ telegramId: obj.creatorId });
    const kb = new InlineKeyboard()
        .text("♻️ Qayta ochish", `adm-rook_${obj.objectId}`).row()
        .text("🔙 Yopilgan obyektlar", "adm_closed");
    return ctx.editMessageText(
        `🔒 "${obj.name}"\n👤 Egasi: ${owner?.fullName || "Noma'lum"}\n👥 Ishchilar: ${obj.workers.length} ta\n\nQayta ochasizmi? Egasiga va ishchilarga xabar yuboriladi.`,
        { reply_markup: kb }
    );
});

// Admin: yopilgan obyektni qayta ochish
bot.callbackQuery(/^adm-rook_(.+)$/, async (ctx) => {
    if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery("Ruxsat yo'q");
    const obj = await CompanyObject.findOne({ objectId: ctx.match[1] });
    if (!obj || obj.status !== 'closed') return ctx.answerCallbackQuery("Obyekt topilmadi yoki allaqachon ochiq.");
    await ctx.answerCallbackQuery("Qayta ochildi");

    obj.status = 'active';
    await obj.save();

    for (const wid of obj.workers) {
        try {
            await bot.api.sendMessage(wid, `🔓 "${obj.name}" obyekti admin tomonidan qayta ochildi.`);
        } catch (e) { }
        await sleep(50);
    }

    return ctx.editMessageText(
        `✅ "${obj.name}" obyekti qayta ochildi.`,
        { reply_markup: new InlineKeyboard().text("🔙 Yopilgan obyektlar", "adm_closed") }
    );
});

// --- MATNLI XABARLAR PROTSESSORI ---
bot.on("message", async (ctx) => {
    const userId = ctx.from.id;
    let step = ctx.session?.step;
    const text = ctx.message?.text || "";
    const contact = ctx.message?.contact;

    // "Orqaga" tugmasi
    if (text === CANCEL_TEXT && !REG_STEPS.includes(step)) {
        ctx.session.step = null;
        ctx.session.payAmount = null;
        const u = await User.findOne({ telegramId: userId });
        return ctx.reply("🏠 Asosiy menyu", { reply_markup: getMainMenu(u?.role || 'user') });
    }

    // Istalgan menyu tugmasi bosilsa, kutilayotgan bosqich bekor bo'ladi
    if (systemButtons.includes(text) && !REG_STEPS.includes(step)) {
        ctx.session.step = null;
        step = null;
    }

    // --- Ro'yxatdan o'tish bosqichlari ---
    if (step === 'get_phone') {
        let rawPhone = contact ? contact.phone_number : text;
        const formattedPhone = formatPhoneNumber(rawPhone);
        if (!formattedPhone) return ctx.reply("⚠️ Xato format. Telefon raqamingizni qaytadan kiriting:");
        ctx.session.phone = formattedPhone;
        ctx.session.step = 'get_name';
        return ctx.reply("📥 Ism va familiyangizni kiriting:");
    }

    if (step === 'get_name' && text) {
        if (systemButtons.includes(text)) return ctx.reply("⚠️ Iltimos, tugma matnini emas, haqiqiy ism-familiyangizni kiriting:");
        ctx.session.fullName = text.trim();
        ctx.session.step = 'get_rate';
        return ctx.reply("💰 **Kunlik ish haqi stavkangizni kiriting (Faqat raqamda):**");
    }

    if (step === 'get_rate' && text) {
        const rate = parseAmount(text);
        if (isNaN(rate)) return ctx.reply("⚠️ Iltimos, faqat musbat raqam kiriting:");

        const objectId = ctx.session.payload;
        const username = ctx.from.username ? `@${ctx.from.username}` : "Mavjud emas";

        await User.create({
            telegramId: userId, role: 'user', phone: ctx.session.phone, fullName: ctx.session.fullName, username, dailyRate: rate
        });

        if (objectId) {
            const obj = await CompanyObject.findOne({ objectId });
            if (obj && obj.status === 'closed') {
                ctx.session.step = null;
                ctx.session.payload = null;
                return ctx.reply("🚫 Tizimdan o'tdingiz, lekin havoladagi obyekt yopilgan.", { reply_markup: getMainMenu('user') });
            }
            await CompanyObject.findOneAndUpdate(
                { objectId },
                { $addToSet: { workers: userId }, $pull: { formerWorkers: userId } }
            );
            ctx.session.step = null;
            ctx.session.payload = null;
            return ctx.reply(`🎉 Ro'yxatdan o'tdingiz va **"${obj?.name || 'Obyekt'}"** obyektiga qo'shildingiz!`, { reply_markup: getMainMenu('user') });
        }

        ctx.session.step = null;
        return ctx.reply(`🎉 Ro'yxatdan muvaffaqiyatli o'tdingiz!`, { reply_markup: getMainMenu('user') });
    }

    // Ro'yxatdan o'tmagan foydalanuvchilar uchun himoya
    const me = await User.findOne({ telegramId: userId });
    if (!me) {
        return ctx.reply("⚠️ Avval ro'yxatdan o'ting. /start buyrug'ini yuboring.");
    }

    // --- Matn kutilayotgan bosqichlar ---
    if (step === 'create_object_name' && text) {
        const objectId = "obj_" + Math.random().toString(36).substr(2, 9);
        await CompanyObject.create({ objectId, name: text.trim(), creatorId: userId, workers: [userId], status: 'active' });
        ctx.session.step = null;
        const botInfo = await bot.api.getMe();
        return ctx.reply(`🏗 **Obyekt yaratildi:** *${text.trim()}*\n\nBoshqalarni qo'shish uchun havola:\n\`https://t.me/${botInfo.username}?start=${objectId}\``, {
            parse_mode: "Markdown", reply_markup: getMainMenu(me.role)
        });
    }

    if (step === 'rename_obj' && text) {
        const newName = text.trim();
        if (newName.length < 2 || newName.length > 60) {
            return ctx.reply("⚠️ Nom 2 dan 60 tagacha belgidan iborat bo'lishi kerak. Qaytadan yozing:");
        }
        const obj = await CompanyObject.findOne({ objectId: ctx.session.targetObjId });
        ctx.session.step = null;
        ctx.session.targetObjId = null;
        if (!obj || obj.creatorId !== userId) {
            return ctx.reply("⚠️ Obyekt topilmadi.", { reply_markup: getMainMenu(me.role) });
        }
        const oldName = obj.name;
        obj.name = newName;
        await obj.save();
        return ctx.reply(`✅ Obyekt nomi o'zgartirildi:\n${oldName} ➡️ ${newName}`, { reply_markup: getMainMenu(me.role) });
    }

    if (step === 'admin_broadcast' && text) {
        if (me.role !== 'super_admin') { ctx.session.step = null; return; }

        const users = await User.find({}, 'telegramId');
        await ctx.reply(`📤 Yuborilmoqda... (${users.length} ta)`);
        let ok = 0, fail = 0;
        for (const u of users) {
            try { await bot.api.sendMessage(u.telegramId, `📢 ${text}`); ok++; }
            catch (e) { fail++; }
            await sleep(50);
        }
        ctx.session.step = null;
        return ctx.reply(`✅ Yuborildi: ${ok}\n❌ Xato: ${fail}`, { reply_markup: getMainMenu(me.role) });
    }

    // 1-qadam: pul summasi
    if (step === 'give_money_input' && text) {
        const amount = parseAmount(text);
        if (isNaN(amount) || amount <= 0) return ctx.reply("⚠️ Iltimos, to'g'ri summani kiriting:");

        ctx.session.payAmount = amount;
        ctx.session.step = 'give_money_pick';

        const t = todayStr();
        const y = addDays(t, -1);
        const kb = new InlineKeyboard()
            .text(`📅 Bugun (${t}, ${weekdayShort(t)})`, "paydate_today").row()
            .text(`📅 Kecha (${y}, ${weekdayShort(y)})`, "paydate_yest").row()
            .text("✏️ Boshqa sana", "paydate_other");
        return ctx.reply(`💵 Summa: ${formatMoney(amount)}\n\nPul qaysi sanada berilgan?`, { reply_markup: kb });
    }

    // 2-qadam: sana tugmasi kutilmoqda
    if (step === 'give_money_pick') {
        return ctx.reply("☝️ Iltimos, yuqoridagi tugmalardan sanani tanlang yoki \"🔙 Orqaga\" ni bosing.");
    }

    // 3-qadam (ixtiyoriy): sanani qo'lda kiritish
    if (step === 'give_money_date' && text) {
        const parsed = parseDateInput(text);
        if (!parsed) return ctx.reply("⚠️ Sana noto'g'ri. Masalan: 2026-10-05 yoki 05.10.2026\nQaytadan yozing:");
        if (parsed > todayStr()) return ctx.reply("⚠️ Kelajak sanasini kiritib bo'lmaydi. Qaytadan yozing:");
        return finalizePayment(ctx, parsed);
    }

    if (step === 'change_rate_input' && text) {
        const rate = parseAmount(text);
        if (isNaN(rate)) return ctx.reply("⚠️ Faqat raqam kiriting:");
        await User.findOneAndUpdate({ telegramId: userId }, { dailyRate: rate });
        ctx.session.step = null;
        return ctx.reply(`✅ Stavka muvaffaqiyatli yangilandi!`, { reply_markup: getMainMenu(me.role) });
    }

    // --- Menyu tugmalari ---
    if (text === "🏢 Yangi Obyekt Ochish") {
        ctx.session.step = 'create_object_name';
        return ctx.reply("🏢 **Yangi obyekt nomini kiriting:**", { reply_markup: cancelKeyboard() });
    }

    if (text === "📂 Mening Obyektlarim") {
        const view = await buildMyObjectsView(userId);
        if (!view) return ctx.reply("📭 Siz ochgan faol obyektlar mavjud emas.");
        if (view.single) {
            const mv = await buildManageView(view.single, 'all');
            return ctx.reply(mv.text, { parse_mode: "Markdown", reply_markup: mv.kb });
        }
        return ctx.reply(view.text, { reply_markup: view.kb });
    }

    if (text === "🤝 Qo'shilgan Obyektlarim") {
        const joinedObjects = await CompanyObject.find({ workers: userId, creatorId: { $ne: userId }, status: 'active' });
        if (joinedObjects.length === 0) return ctx.reply("📭 Siz hozirda boshqa faol obyektlarga qo'shilmagansiz.");

        let outText = "🤝 **Siz qo'shilgan obyektlar ro'yxati va umumiy hisob-kitoblar:**\n\n";
        for (const obj of joinedObjects) {
            const owner = await User.findOne({ telegramId: obj.creatorId });
            const stats = await getWorkerObjectStats(userId, obj.objectId, me.dailyRate || 0, 'all');

            outText += `🏢 **Obyekt nomi:** ${obj.name}\n`;
            outText += `👤 **Obyekt egasi:** [Profilga o'tish](tg://user?id=${obj.creatorId}) (${owner ? owner.fullName : "Noma'lum"})\n`;
            outText += `├ Kunlik stavkangiz: *${formatMoney(me.dailyRate)}*\n`;
            outText += `├ Jami ishlagan smenangiz: *${stats.totalEarnedDays} kun*\n`;
            outText += `├ Olingan jami avans: *${formatMoney(stats.totalPaidMoney)}* (${stats.paidDays} kunlik)\n`;
            outText += `├ **Qolgan ish kunlari:** *${stats.remainingDays} kun*\n`;
            outText += `└ 💵 **Olinadigan jami sof pul:** **${formatMoney(stats.remainingMoney)}**\n`;
            outText += `\`----------------------------\`\n\n`;
        }
        const payKb = new InlineKeyboard();
        joinedObjects.forEach(o => payKb.text(`💰 ${o.name} — olgan pullarim`, `my-pay_${o.objectId}`).row());
        return ctx.reply(outText, { parse_mode: "Markdown", reply_markup: payKb });
    }

    if (text === "📅 Bugungi Davomat") {
        const myObjects = await CompanyObject.find({ workers: userId, status: 'active' });
        if (myObjects.length === 0) return ctx.reply("⚠️ Siz hech qaysi faol obyekt a'zosi emassiz.");
        if (myObjects.length === 1) {
            const v = await buildMarkAttView(userId, myObjects[0].objectId);
            return ctx.reply(v.text, v.blocked ? { parse_mode: "Markdown" } : { reply_markup: v.kb });
        }

        const keyboard = new InlineKeyboard();
        myObjects.forEach(obj => {
            keyboard.text(`👷‍♂️ ${obj.name}`, `mark-att_${obj.objectId}`).row();
        });
        const t = todayStr();
        return ctx.reply(`📅 **Bugungi davomat (${t}, ${weekdayShort(t)}) qaysi obyekt bo'yicha kiritiladi? Obyektni tanlang:**`, { reply_markup: keyboard });
    }

    if (text === "📝 Mening kunlarim (Tahrirlash)") {
        const myObjects = await CompanyObject.find({ workers: userId, status: 'active' });
        if (myObjects.length === 0) return ctx.reply("📭 Aktiv ishtirok etayotgan obyektlaringiz topilmadi.");
        if (myObjects.length === 1) {
            const dv = await buildEditDaysView(userId, myObjects[0].objectId, 'week');
            if (dv) return ctx.reply(dv.text, { reply_markup: dv.kb });
        }

        const keyboard = new InlineKeyboard();
        myObjects.forEach(obj => {
            keyboard.text(`📁 ${obj.name}`, `select-obj-edit_${obj.objectId}_week`).row();
        });
        return ctx.reply("📝 **Qaysi obyektdagi kunlaringizni ko'rib tahrirlamoqchisiz?**", { reply_markup: keyboard });
    }

    if (text === "⚙️ Sozlamalar") {
        ctx.session.step = 'change_rate_input';
        return ctx.reply(`👤 **Ism:** ${me.fullName}\n💰 **Joriy kunlik stavka:** ${formatMoney(me.dailyRate)}\n\n🔄 Yangi kunlik stavkani faqat raqamlarda kiriting:`, { reply_markup: cancelKeyboard() });
    }

    if (text === "📊 Global Statistika") {
        if (me.role !== 'super_admin') return;
        const totalUsers = await User.countDocuments();
        const totalObjects = await CompanyObject.countDocuments();
        return ctx.reply(`📊 **Tizim statistikasi:**\n\n👥 Ro'yxatdan o'tganlar: ${totalUsers}\n🏗 Obyektlar jami: ${totalObjects}`);
    }
});

// --- 6. INLINE CALLBACK QUERY PROCESSORS ---

// Orqaga: brigadirning obyektlar ro'yxati
bot.callbackQuery("my-objs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await buildMyObjectsView(ctx.from.id);
    if (!view) return ctx.editMessageText("📭 Siz ochgan faol obyektlar mavjud emas.");
    return ctx.editMessageText(view.text, { reply_markup: view.kb });
});

// Orqaga: kunlarni tahrirlash uchun obyektlar ro'yxati
bot.callbackQuery("edit-objs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const objs = await CompanyObject.find({ workers: ctx.from.id, status: 'active' });
    if (objs.length === 0) return ctx.editMessageText("📭 Aktiv ishtirok etayotgan obyektlaringiz topilmadi.");

    const kb = new InlineKeyboard();
    objs.forEach(o => kb.text(`📁 ${o.name}`, `select-obj-edit_${o.objectId}_week`).row());
    return ctx.editMessageText("📝 **Qaysi obyektdagi kunlaringizni ko'rib tahrirlamoqchisiz?**", { reply_markup: kb });
});

// Xabarni yopish (o'chirish)
bot.callbackQuery("close-msg", async (ctx) => {
    await ctx.answerCallbackQuery();
    try { await ctx.deleteMessage(); } catch (e) { }
});

// Kunlar ro'yxati (tahrirlash) ko'rinishini yig'ish
async function buildEditDaysView(userId, objectId, filterType) {
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj) return null;

    const existAttendances = await Attendance.find({ telegramId: userId, objectId });
    const attMap = {};
    existAttendances.forEach(att => { attMap[att.date] = att; });

    const firstAttendance = await Attendance.findOne({ telegramId: userId, objectId }).sort({ date: 1 });
    const allDays = generateDaysRange(filterType, firstAttendance ? firstAttendance.date : null);

    const keyboard = new InlineKeyboard();
    keyboard.text(filterType === 'week' ? "• 1 Hafta •" : "1 Hafta", `select-obj-edit_${objectId}_week`)
        .text(filterType === 'month' ? "• 1 Oy •" : "1 Oy", `select-obj-edit_${objectId}_month`)
        .text(filterType === 'all' ? "• Umumiy kunlar •" : "Umumiy kunlar", `select-obj-edit_${objectId}_all`).row();
    keyboard.text("🔙 Obyektlar ro'yxati", "edit-objs").row();

    if (allDays.length === 0) {
        return { text: "📭 Ushbu tanlangan davrda kunlar mavjud emas.", kb: keyboard };
    }

    allDays.forEach(dateStr => {
        const att = attMap[dateStr];
        let icon = "⚪️";
        let label = "Belgilanmagan";
        let callbackData = `edit-day-choice:${objectId}:${dateStr}`;

        if (att) {
            icon = statusIcon(att.status);
            label = statusLabel(att.status);
            callbackData = `edit-day-choice:ID:${att._id}`;
        }
        keyboard.text(`📅 ${dateStr} (${weekdayShort(dateStr)}) ➡️ ${icon} ${label}`, callbackData).row();
    });

    return {
        text: "📆 **Tahrirlamoqchi yoki belgilamoqchi bo'lgan kuningizni tanlang:**\n\n*(Belgilanmagan kunlar ⚪️ bo'lib turadi, ustiga bosib kiritishingiz mumkin)*",
        kb: keyboard
    };
}

bot.callbackQuery(/^select-obj-edit_(.+)_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await buildEditDaysView(ctx.from.id, ctx.match[1], ctx.match[2]);
    if (!view) return ctx.reply("⚠️ Obyekt topilmadi.");

    try {
        return await ctx.editMessageText(view.text, { reply_markup: view.kb });
    } catch (error) {
        if (error.description && error.description.includes("message is not modified")) return;
        console.error(error);
    }
});

bot.callbackQuery(/^edit-day-choice:(.+)$/, async (ctx) => {
    const payload = ctx.match[1];
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();

    if (payload.startsWith("ID:")) {
        const attId = payload.replace("ID:", "");
        const att = await Attendance.findById(attId);
        if (!att) return ctx.reply("⚠️ Ma'lumot topilmadi.");

        keyboard.text("To'liq kun ✅", `update-day-save:EXIST:${attId}:full`)
            .text("Yarim smena 🟡", `update-day-save:EXIST:${attId}:half`).row()
            .text("Ishlamadim (O'chirish) ❌", `update-day-save:EXIST:${attId}:absent`).row()
            .text("🔙 Kunlar ro'yxati", `select-obj-edit_${att.objectId}_week`);

        return ctx.editMessageText(`🔄 **Sana:** ${att.date} (${weekdayShort(att.date)})\n**Joriy Holat:** ${statusLabel(att.status)}\n\nO'zgartirish variantini tanlang:`, { reply_markup: keyboard });
    } else {
        const [objId, dateStr] = payload.split(":");

        keyboard.text("To'liq kun ✅", `update-day-save:NEW:${objId}:${dateStr}:full`)
            .text("Yarim smena 🟡", `update-day-save:NEW:${objId}:${dateStr}:half`).row()
            .text("Kelmadi (O'tkazib yuborish) ❌", `update-day-save:NEW:${objId}:${dateStr}:absent`).row()
            .text("🔙 Kunlar ro'yxati", `select-obj-edit_${objId}_week`);

        return ctx.editMessageText(`📝 **Sana:** ${dateStr} (${weekdayShort(dateStr)})\nUshbu kun uchun hali davomat belgilanmagan.\n\nHolat kiritasizmi?`, { reply_markup: keyboard });
    }
});

bot.callbackQuery(/^update-day-save:(.+)$/, async (ctx) => {
    const actionType = ctx.match[1];
    await ctx.answerCallbackQuery();

    const parts = actionType.split(":");

    if (parts[0] === "EXIST") {
        const attId = parts[1];
        const newStatus = parts[2];
        const att = await Attendance.findById(attId);
        if (!att) return ctx.reply("⚠️ Xatolik.");

        att.status = newStatus;
        await att.save();
        return ctx.editMessageText(
            `✨ **${att.date} (${weekdayShort(att.date)})** sanasidagi holat muvaffaqiyatli **${statusLabel(newStatus)}** deb o'zgartirildi!`,
            { reply_markup: new InlineKeyboard().text("🔙 Kunlar ro'yxati", `select-obj-edit_${att.objectId}_week`) }
        );
    } else {
        // NEW:obj_12345:2026-06-17:full
        const objId = parts[1];
        const dateStr = parts[2];
        const newStatus = parts[3];

        await Attendance.findOneAndUpdate(
            { telegramId: ctx.from.id, objectId: objId, date: dateStr },
            { status: newStatus, timestamp: new Date() },
            { upsert: true }
        );
        return ctx.editMessageText(
            `✨ **${dateStr} (${weekdayShort(dateStr)})** kuni **${statusLabel(newStatus)}** bo'lib tizimga kiritildi!`,
            { reply_markup: new InlineKeyboard().text("🔙 Kunlar ro'yxati", `select-obj-edit_${objId}_week`) }
        );
    }
});

// --- OBYEKT BOSHQARUVI ---
async function buildManageView(obj, filterType) {
    const objectId = obj.objectId;
    const former = obj.formerWorkers || [];
    const workers = await User.find({ telegramId: { $in: allWorkerIds(obj) } });

    let text = `🏗 **Obyekt:** ${obj.name}\n📊 **Hisobot Filtri:** ${periodTitle(filterType)}\n\n👥 **Ishchilar va hisobotlar:**\n\n`;

    const keyboard = new InlineKeyboard();
    addFilterButtons(keyboard, "manage-obj", objectId, filterType);

    for (const worker of workers) {
        const isFormer = former.includes(worker.telegramId);
        const stats = await getWorkerObjectStats(worker.telegramId, objectId, worker.dailyRate || 0, filterType);
        text += `👤 **${worker.fullName}**${isFormer ? " _(chiqqan)_" : ""}\n`;
        text += `├ Davrdagi smenasi: *${stats.totalEarnedDays} kun* (${formatMoney(stats.totalEarnedMoney)})\n`;
        text += `├ Berilgan avans: *${formatMoney(stats.totalPaidMoney)}* (${stats.paidDays} kunlik)\n`;
        text += `├ **Qolgan ish kuni:** *${stats.remainingDays} kun*\n`;
        text += `└ **Sof beriladigan pul:** **${formatMoney(stats.remainingMoney)}**\n---------------------\n`;

        keyboard.text(`💵 ${worker.fullName}-ga pul berish${isFormer ? " (chiqqan)" : ""}`, `pay_${objectId}_${worker.telegramId}`).row();
    }

    keyboard.text("✍️ Ishchi o'rniga davomat belgilash", `fm-list:${objectId}:${todayStr()}`).row();
    keyboard.text("💸 Berilgan pullar tarixi", `pay-hist_${objectId}`).row();
    keyboard.text("👥 Ishchini chiqarish", `rm-list_${objectId}`).text("✏️ Nomini o'zgartirish", `rename_${objectId}`).row();
    keyboard.text(`📥 ${periodTitle(filterType)} CSV Yuklash`, `csv_${objectId}_${filterType}`).row();
    keyboard.text("🛑 Obyektni Yopish va Yakuniy Hisobot", `close-obj_${objectId}`).row();
    keyboard.text("🔙 Obyektlar ro'yxati", "my-objs");

    return { text, kb: keyboard };
}

bot.callbackQuery(/^manage-obj_(.+)_(.+)$/, async (ctx) => {
    const obj = await CompanyObject.findOne({ objectId: ctx.match[1] });
    if (!obj || obj.status === 'closed') return ctx.answerCallbackQuery("Obyekt faol emas yoki yopilgan.");
    await ctx.answerCallbackQuery();

    const view = await buildManageView(obj, ctx.match[2]);
    try {
        return await ctx.editMessageText(view.text, { parse_mode: "Markdown", reply_markup: view.kb });
    } catch (error) {
        if (error.description && error.description.includes("message is not modified")) return;
        console.error(error);
    }
});

// --- PUL BERISH ---
bot.callbackQuery(/^pay_(.+)_(.+)$/, async (ctx) => {
    const payObj = await getOwnedActiveObject(ctx, ctx.match[1]);
    if (!payObj) return;
    ctx.session.step = 'give_money_input';
    ctx.session.targetObjId = ctx.match[1];
    ctx.session.targetWorkerId = parseInt(ctx.match[2]);
    ctx.session.payAmount = null;
    await ctx.answerCallbackQuery();
    return ctx.reply("💰 **Ishchiga berilgan naqd pul summasini yozing (Faqat raqamda):**", { reply_markup: cancelKeyboard() });
});

// Pul berish sanasini tanlash: Bugun / Kecha / Boshqa sana
bot.callbackQuery(/^paydate_(today|yest|other)$/, async (ctx) => {
    if (ctx.session.step !== 'give_money_pick') {
        return ctx.answerCallbackQuery("So'rov eskirgan. Qaytadan boshlang.");
    }
    const choice = ctx.match[1];
    await ctx.answerCallbackQuery();

    if (choice === 'other') {
        ctx.session.step = 'give_money_date';
        return ctx.reply("📅 Pul berilgan sanani yozing (masalan: 2026-10-05 yoki 05.10.2026):");
    }

    const date = choice === 'today' ? todayStr() : addDays(todayStr(), -1);
    try { await ctx.deleteMessage(); } catch (e) { }
    return finalizePayment(ctx, date);
});

// --- BERILGAN PULLAR TARIXI (BRIGADIR) ---
bot.callbackQuery(/^pay-hist_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj) return ctx.answerCallbackQuery("Obyekt topilmadi.");
    if (obj.creatorId !== ctx.from.id) return ctx.answerCallbackQuery("Ruxsat yo'q.");
    await ctx.answerCallbackQuery();

    const backKb = new InlineKeyboard().text("🔙 Obyektga qaytish", `manage-obj_${objectId}_all`);

    const payments = (await Payment.find({ objectId })).sort(comparePayments);
    if (payments.length === 0) {
        return ctx.reply(`📭 "${obj.name}" obyektida hali pul berilmagan.`, { reply_markup: backKb });
    }

    const workerIds = [...new Set(payments.map(p => p.telegramId))];
    const workers = await User.find({ telegramId: { $in: workerIds } });
    const nameOf = {};
    workers.forEach(w => { nameOf[w.telegramId] = w.fullName; });

    const byWorker = {};
    payments.forEach(p => { (byWorker[p.telegramId] = byWorker[p.telegramId] || []).push(p); });

    const lines = [];
    let grand = 0;
    for (const [wid, list] of Object.entries(byWorker)) {
        const sum = list.reduce((s, p) => s + p.amount, 0);
        grand += sum;
        lines.push(`\n👤 ${nameOf[wid] || "Noma'lum"} — jami ${formatMoney(sum)}`);
        list.forEach((p, i) => {
            const d = paymentDateStr(p);
            lines.push(`   ${i + 1}. ${d} (${weekdayShort(d)}) — ${formatMoney(p.amount)}`);
        });
    }
    lines.push(`\n💰 Obyekt bo'yicha jami berilgan: ${formatMoney(grand)}`);

    const lastKb = new InlineKeyboard()
        .text("🗑 Pulni bekor qilish", `pay-dl_${objectId}`).row()
        .text("🔙 Obyektga qaytish", `manage-obj_${objectId}_all`);

    const histChunks = chunkText(`💸 "${obj.name}" — berilgan pullar tarixi`, lines);
    for (let i = 0; i < histChunks.length; i++) {
        const isLast = i === histChunks.length - 1;
        await ctx.reply(histChunks[i], isLast ? { reply_markup: lastKb } : undefined);
    }
});

// Bekor qilish uchun so'nggi to'lovlar ro'yxati
bot.callbackQuery(/^pay-dl_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj) return ctx.answerCallbackQuery("Obyekt topilmadi.");
    if (obj.creatorId !== ctx.from.id) return ctx.answerCallbackQuery("Ruxsat yo'q.");
    await ctx.answerCallbackQuery();

    const payments = (await Payment.find({ objectId })).sort(comparePayments).reverse().slice(0, 20);
    if (payments.length === 0) {
        return ctx.editMessageText("📭 Bekor qilinadigan to'lov qolmadi.", {
            reply_markup: new InlineKeyboard().text("🔙 Obyektga qaytish", `manage-obj_${objectId}_all`)
        });
    }

    const users = await User.find({ telegramId: { $in: [...new Set(payments.map(p => p.telegramId))] } });
    const nameOf = {};
    users.forEach(u => { nameOf[u.telegramId] = u.fullName || "Ismsiz"; });

    const kb = new InlineKeyboard();
    payments.forEach(p => {
        const d = paymentDateStr(p);
        const shortName = (nameOf[p.telegramId] || "Noma'lum").slice(0, 14);
        kb.text(`🗑 ${shortName} · ${d.slice(5)} · ${formatMoney(p.amount)}`, `pay-del_${p._id}`).row();
    });
    kb.text("🔙 Tarixga qaytish", `pay-hist_${objectId}`);

    return ctx.editMessageText(`🗑 "${obj.name}" — qaysi to'lovni bekor qilasiz?\n(So'nggi ${payments.length} ta ko'rsatilgan)`, { reply_markup: kb });
});

// Bekor qilishni tasdiqlash
bot.callbackQuery(/^pay-del_(.+)$/, async (ctx) => {
    const p = await Payment.findById(ctx.match[1]).catch(() => null);
    if (!p) return ctx.answerCallbackQuery("To'lov topilmadi (allaqachon o'chirilgan).");
    const obj = await CompanyObject.findOne({ objectId: p.objectId });
    if (!obj || obj.creatorId !== ctx.from.id) return ctx.answerCallbackQuery("Ruxsat yo'q.");
    await ctx.answerCallbackQuery();

    const worker = await User.findOne({ telegramId: p.telegramId });
    const d = paymentDateStr(p);
    const kb = new InlineKeyboard()
        .text("✅ Ha, o'chirish", `pay-delok_${p._id}`).row()
        .text("❌ Yo'q", `pay-dl_${obj.objectId}`);

    return ctx.editMessageText(
        `⚠️ Ushbu to'lovni bekor qilasizmi?\n\n👤 Ishchi: ${worker?.fullName || "Noma'lum"}\n🏗 Obyekt: ${obj.name}\n💵 Summa: ${formatMoney(p.amount)}\n📅 Sana: ${d} (${weekdayShort(d)})\n\nIshchiga xabar yuboriladi.`,
        { reply_markup: kb }
    );
});

// Bekor qilish (o'chirish)
bot.callbackQuery(/^pay-delok_(.+)$/, async (ctx) => {
    const p = await Payment.findById(ctx.match[1]).catch(() => null);
    if (!p) return ctx.answerCallbackQuery("To'lov allaqachon o'chirilgan.");
    const obj = await CompanyObject.findOne({ objectId: p.objectId });
    if (!obj || obj.creatorId !== ctx.from.id) return ctx.answerCallbackQuery("Ruxsat yo'q.");
    await ctx.answerCallbackQuery("O'chirildi");

    const d = paymentDateStr(p);
    const amount = p.amount;
    const workerId = p.telegramId;
    const worker = await User.findOne({ telegramId: workerId });
    await Payment.findByIdAndDelete(p._id);

    try {
        await bot.api.sendMessage(
            workerId,
            `🗑 "${obj.name}" obyekti bo'yicha ${d} (${weekdayShort(d)}) sanasidagi ${formatMoney(amount)} avans yozuvi brigadir tomonidan bekor qilindi.`
        );
    } catch (e) { }

    return ctx.editMessageText(
        `✅ To'lov bekor qilindi.\n\n👤 ${worker?.fullName || "Noma'lum"} — ${formatMoney(amount)} (${d})`,
        { reply_markup: new InlineKeyboard().text("🔙 To'lovlar ro'yxati", `pay-dl_${obj.objectId}`) }
    );
});

// Ishchi: shu obyekt bo'yicha o'zi olgan pullar (sanasi bilan)
bot.callbackQuery(/^my-pay_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj) return ctx.answerCallbackQuery("Obyekt topilmadi.");
    await ctx.answerCallbackQuery();

    const payments = await getPaymentsInPeriod(ctx.from.id, objectId, 'all');
    if (payments.length === 0) return ctx.reply(`📭 "${obj.name}" obyektidan hali pul olmagansiz.`);

    let total = 0;
    const lines = payments.map((p, i) => {
        total += p.amount;
        const d = paymentDateStr(p);
        return `${i + 1}. ${d} (${weekdayShort(d)}) — ${formatMoney(p.amount)}`;
    });
    lines.push(`\n💰 Jami olgan: ${formatMoney(total)}`);

    const myChunks = chunkText(`💰 "${obj.name}" — olgan pullaringiz`, lines);
    for (let i = 0; i < myChunks.length; i++) {
        const isLast = i === myChunks.length - 1;
        await ctx.reply(myChunks[i], isLast
            ? { reply_markup: new InlineKeyboard().text("🔙 Yopish", "close-msg") }
            : undefined);
    }
});

// --- BRIGADIR: ISHCHI O'RNIGA DAVOMAT BELGILASH ---
bot.callbackQuery(/^fm-list:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const obj = await getOwnedActiveObject(ctx, ctx.match[1]);
    if (!obj) return;
    await ctx.answerCallbackQuery();
    const date = ctx.match[2] > todayStr() ? todayStr() : ctx.match[2];
    return renderFmList(ctx, obj, date);
});

bot.callbackQuery(/^fm-w:(.+):(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const obj = await getOwnedActiveObject(ctx, ctx.match[1]);
    if (!obj) return;
    const workerId = parseInt(ctx.match[2]);
    const date = ctx.match[3];
    if (!obj.workers.includes(workerId)) return ctx.answerCallbackQuery("Ishchi bu obyektda emas.");
    if (date > todayStr()) return ctx.answerCallbackQuery("Kelajak sanasini belgilab bo'lmaydi.");
    await ctx.answerCallbackQuery();

    const worker = await User.findOne({ telegramId: workerId });
    const att = await Attendance.findOne({ telegramId: workerId, objectId: obj.objectId, date });
    const today = todayStr();

    const kb = new InlineKeyboard()
        .text("To'liq kun ✅", `fm-s:${obj.objectId}:${workerId}:${date}:full`)
        .text("Yarim smena 🟡", `fm-s:${obj.objectId}:${workerId}:${date}:half`).row()
        .text("Kelmadi ❌", `fm-s:${obj.objectId}:${workerId}:${date}:absent`).row();
    kb.text(`◀️ ${addDays(date, -1)}`, `fm-w:${obj.objectId}:${workerId}:${addDays(date, -1)}`);
    if (date < today) kb.text(`${addDays(date, 1)} ▶️`, `fm-w:${obj.objectId}:${workerId}:${addDays(date, 1)}`);
    kb.row().text("🔙 Ishchilar ro'yxati", `fm-list:${obj.objectId}:${date}`);

    return ctx.editMessageText(
        `✍️ Ishchi: ${worker?.fullName || "Noma'lum"}\n🏗 Obyekt: ${obj.name}\n📅 Sana: ${date} (${weekdayShort(date)})\nJoriy holat: ${statusIcon(att?.status)} ${statusLabel(att?.status)}\n\nHolatni tanlang:`,
        { reply_markup: kb }
    );
});

bot.callbackQuery(/^fm-s:(.+):(\d+):(\d{4}-\d{2}-\d{2}):(full|half|absent)$/, async (ctx) => {
    const obj = await getOwnedActiveObject(ctx, ctx.match[1]);
    if (!obj) return;
    const workerId = parseInt(ctx.match[2]);
    const date = ctx.match[3];
    const status = ctx.match[4];
    if (!obj.workers.includes(workerId)) return ctx.answerCallbackQuery("Ishchi bu obyektda emas.");
    if (date > todayStr()) return ctx.answerCallbackQuery("Kelajak sanasini belgilab bo'lmaydi.");
    await ctx.answerCallbackQuery("Saqlandi!");

    await Attendance.findOneAndUpdate(
        { telegramId: workerId, objectId: obj.objectId, date },
        { status, timestamp: new Date(), markedBy: ctx.from.id },
        { upsert: true }
    );

    const worker = await User.findOne({ telegramId: workerId });

    if (workerId !== ctx.from.id) {
        try {
            await bot.api.sendMessage(
                workerId,
                `👷 Brigadir sizning "${obj.name}" obyektidagi ${date} (${weekdayShort(date)}) kuningizni "${statusLabel(status)}" deb belgiladi.\n\nAgar xato bo'lsa, "📝 Mening kunlarim (Tahrirlash)" bo'limida o'zgartirishingiz mumkin.`
            );
        } catch (e) { }
    }

    return renderFmList(ctx, obj, date, `✅ ${worker?.fullName || "Ishchi"}: ${statusLabel(status)} deb belgilandi\n\n`);
});

// --- ISHCHINI OBYEKTDAN CHIQARISH ---
bot.callbackQuery(/^rm-list_(.+)$/, async (ctx) => {
    const obj = await getOwnedActiveObject(ctx, ctx.match[1]);
    if (!obj) return;
    await ctx.answerCallbackQuery();

    const backKb = new InlineKeyboard().text("🔙 Obyektga qaytish", `manage-obj_${obj.objectId}_all`);
    const others = obj.workers.filter(w => w !== obj.creatorId);
    if (others.length === 0) {
        return ctx.editMessageText("📭 Chiqariladigan ishchi yo'q.", { reply_markup: backKb });
    }

    const users = await User.find({ telegramId: { $in: others } });
    const kb = new InlineKeyboard();
    users.forEach(u => kb.text(`🚪 ${u.fullName || "Ismsiz"}`, `rm-ask:${obj.objectId}:${u.telegramId}`).row());
    kb.text("🔙 Obyektga qaytish", `manage-obj_${obj.objectId}_all`);

    return ctx.editMessageText("👥 Qaysi ishchini obyektdan chiqarasiz?", { reply_markup: kb });
});

bot.callbackQuery(/^rm-ask:(.+):(\d+)$/, async (ctx) => {
    const obj = await getOwnedActiveObject(ctx, ctx.match[1]);
    if (!obj) return;
    const workerId = parseInt(ctx.match[2]);
    if (!obj.workers.includes(workerId) || workerId === obj.creatorId) {
        return ctx.answerCallbackQuery("Bu ishchini chiqarib bo'lmaydi.");
    }
    await ctx.answerCallbackQuery();

    const worker = await User.findOne({ telegramId: workerId });
    const kb = new InlineKeyboard()
        .text("✅ Ha, chiqarish", `rm-ok:${obj.objectId}:${workerId}`).row()
        .text("❌ Yo'q", `rm-list_${obj.objectId}`);

    return ctx.editMessageText(
        `⚠️ ${worker?.fullName || "Ishchi"} ni "${obj.name}" obyektidan chiqarasizmi?\n\n• Unga eslatma va davomat kiritish yo'qoladi\n• Davomat va pul tarixi saqlanadi, hisobotda "(chiqqan)" deb ko'rinadi\n• Qolgan pulini hali berishingiz mumkin\n• Ishchiga xabar yuboriladi`,
        { reply_markup: kb }
    );
});

bot.callbackQuery(/^rm-ok:(.+):(\d+)$/, async (ctx) => {
    const obj = await getOwnedActiveObject(ctx, ctx.match[1]);
    if (!obj) return;
    const workerId = parseInt(ctx.match[2]);
    if (!obj.workers.includes(workerId) || workerId === obj.creatorId) {
        return ctx.answerCallbackQuery("Bu ishchini chiqarib bo'lmaydi.");
    }
    await ctx.answerCallbackQuery("Chiqarildi");

    await CompanyObject.updateOne(
        { objectId: obj.objectId },
        { $pull: { workers: workerId }, $addToSet: { formerWorkers: workerId } }
    );

    const worker = await User.findOne({ telegramId: workerId });
    try {
        await bot.api.sendMessage(workerId, `🚪 Siz "${obj.name}" obyektidan chiqarildingiz. Avvalgi davomat va pul tarixingiz saqlanib qoladi.`);
    } catch (e) { }

    return ctx.editMessageText(
        `✅ ${worker?.fullName || "Ishchi"} "${obj.name}" obyektidan chiqarildi.`,
        { reply_markup: new InlineKeyboard().text("🔙 Obyektga qaytish", `manage-obj_${obj.objectId}_all`) }
    );
});

// --- OBYEKT NOMINI O'ZGARTIRISH ---
bot.callbackQuery(/^rename_(.+)$/, async (ctx) => {
    const obj = await getOwnedActiveObject(ctx, ctx.match[1]);
    if (!obj) return;
    ctx.session.step = 'rename_obj';
    ctx.session.targetObjId = obj.objectId;
    await ctx.answerCallbackQuery();
    return ctx.reply(`✏️ "${obj.name}" uchun yangi nomni yozing:`, { reply_markup: cancelKeyboard() });
});

// --- YOPILGAN OBYEKTLARNI QAYTA OCHISH ---
bot.callbackQuery("closed-objs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const objs = await CompanyObject.find({ creatorId: ctx.from.id, status: 'closed' }).sort({ createdAt: -1 });
    const kb = new InlineKeyboard();
    if (objs.length === 0) {
        kb.text("🔙 Obyektlar ro'yxati", "my-objs");
        return ctx.editMessageText("📭 Yopilgan obyektlar yo'q.", { reply_markup: kb });
    }
    objs.forEach(o => kb.text(`🔒 ${o.name}`, `reopen-ask_${o.objectId}`).row());
    kb.text("🔙 Obyektlar ro'yxati", "my-objs");
    return ctx.editMessageText("🗄 Yopilgan obyektlar. Qaytadan ochmoqchi bo'lganingizni tanlang:", { reply_markup: kb });
});

bot.callbackQuery(/^reopen-ask_(.+)$/, async (ctx) => {
    const obj = await CompanyObject.findOne({ objectId: ctx.match[1] });
    if (!obj || obj.creatorId !== ctx.from.id || obj.status !== 'closed') {
        return ctx.answerCallbackQuery("Obyekt topilmadi yoki allaqachon ochiq.");
    }
    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard()
        .text("♻️ Qayta ochish", `reopen-ok_${obj.objectId}`).row()
        .text("🔙 Yopilgan obyektlar", "closed-objs");
    return ctx.editMessageText(
        `🔒 "${obj.name}" obyektini qayta ochasizmi?\n\nIshchilarga xabar yuboriladi, ular yana davomat kirita oladi.`,
        { reply_markup: kb }
    );
});

bot.callbackQuery(/^reopen-ok_(.+)$/, async (ctx) => {
    const obj = await CompanyObject.findOne({ objectId: ctx.match[1] });
    if (!obj || obj.creatorId !== ctx.from.id || obj.status !== 'closed') {
        return ctx.answerCallbackQuery("Obyekt topilmadi yoki allaqachon ochiq.");
    }
    await ctx.answerCallbackQuery("Qayta ochildi");

    obj.status = 'active';
    await obj.save();

    for (const wid of obj.workers) {
        if (wid === obj.creatorId) continue;
        try {
            await bot.api.sendMessage(wid, `🔓 "${obj.name}" obyekti qayta ochildi. Davomatni yana kiritishingiz mumkin.`);
        } catch (e) { }
        await sleep(50);
    }

    return ctx.editMessageText(
        `✅ "${obj.name}" obyekti qayta ochildi.`,
        { reply_markup: new InlineKeyboard().text("🏗 Obyektni ochish", `manage-obj_${obj.objectId}_all`).row().text("🔙 Obyektlar ro'yxati", "my-objs") }
    );
});

// --- CSV VA YOPISH ---
bot.callbackQuery(/^csv_(.+)_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const filterType = ctx.match[2];
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj) return ctx.answerCallbackQuery("Obyekt topilmadi.");
    await ctx.answerCallbackQuery("Excel tayyorlanmoqda...");

    const workers = await User.find({ telegramId: { $in: allWorkerIds(obj) } });
    try {
        const { filePath } = await generateCSVReport(obj, workers, filterType);
        await ctx.replyWithDocument(new InputFile(filePath), { caption: `📊 "${obj.name}" obyektining ${periodTitle(filterType)} hisobot jadvali.` });
        fs.unlinkSync(filePath);
    } catch (err) {
        console.error(err);
        ctx.reply("⚠️ Hisobot yaratishda muammo chiqdi.");
    }
});

bot.callbackQuery(/^close-obj_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj || obj.status === 'closed') return ctx.answerCallbackQuery("Ushbu obyekt allaqachon yopilgan.");
    if (obj.creatorId !== ctx.from.id) return ctx.answerCallbackQuery("Ruxsat yo'q.");

    await ctx.answerCallbackQuery("Yakuniy hisobotlar tayyorlanmoqda...");
    const workers = await User.find({ telegramId: { $in: allWorkerIds(obj) } });

    try {
        const adminReport = await generateCSVReport(obj, workers, 'all');
        await ctx.replyWithDocument(new InputFile(adminReport.filePath), {
            caption: `🛑 "${obj.name}" obyekti yopildi.\n\nProrab uchun jami ishchilarning yakuniy to'liq Excel hisoboti.`
        });
        fs.unlinkSync(adminReport.filePath);

        for (const worker of workers) {
            if (worker.telegramId !== obj.creatorId) {
                try {
                    const personalReport = await generateCSVReport(obj, [worker], 'all');
                    await bot.api.sendDocument(worker.telegramId, new InputFile(personalReport.filePath), {
                        caption: `🛑 "${obj.name}" obyekti yopildi.\n\nSizning ushbu obyektdagi shaxsiy yakuniy moliyaviy hisobot faylingiz.`
                    });
                    fs.unlinkSync(personalReport.filePath);
                } catch (e) {
                    console.error(e);
                }
            }
        }

        obj.status = 'closed';
        await obj.save();

        return ctx.reply("✨ Obyekt muvaffaqiyatli yopildi! Sizga to'liq hisobot, ishchilarga esa faqat o'zlariga tegishli shaxsiy Excel fayllari yuborildi.\n\nKerak bo'lsa, \"📂 Mening Obyektlarim\" → \"🗄 Yopilgan obyektlar\" orqali qayta ochishingiz mumkin.");
    } catch (err) {
        console.error(err);
        ctx.reply("⚠️ Yopish jarayonida muammo yuz berdi.");
    }
});

// --- ISHCHI DAVOMATI ---
async function buildMarkAttView(userId, objectId) {
    const today = todayStr();
    const alreadyMarked = await Attendance.findOne({ telegramId: userId, objectId, date: today });

    if (alreadyMarked) {
        return {
            blocked: true,
            text: `🚫 **Ushbu obyektda bugun uchun davomat kiritib bo'lingan!**\n\n*Joriy holat:* ${statusLabel(alreadyMarked.status)}\n\n🔄 Agar o'zgartirmoqchi bo'lsangiz, menyudagi **"📝 Mening kunlarim (Tahrirlash)"** bo'limiga o'ting.`
        };
    }

    const kb = new InlineKeyboard()
        .text("To'liq kun ✅", `save-att_${objectId}_full`)
        .text("Yarim smena 🟡", `save-att_${objectId}_half`).row()
        .text("Ishlamadim ❌", `save-att_${objectId}_absent`);

    return {
        blocked: false,
        text: `📅 **Bugun (${today}, ${weekdayShort(today)}) ushbu obyektda ishladingizmi?**`,
        kb
    };
}

bot.callbackQuery(/^mark-att_(.+)$/, async (ctx) => {
    const v = await buildMarkAttView(ctx.from.id, ctx.match[1]);

    if (v.blocked) {
        await ctx.answerCallbackQuery("Ta'qiqlangan!");
        return ctx.reply(v.text, { parse_mode: "Markdown" });
    }

    await ctx.answerCallbackQuery();
    return ctx.reply(v.text, { reply_markup: v.kb });
});

bot.callbackQuery(/^save-att_(.+)_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const status = ctx.match[2];
    const today = todayStr();

    const alreadyMarked = await Attendance.findOne({ telegramId: ctx.from.id, objectId, date: today });
    if (alreadyMarked) {
        await ctx.answerCallbackQuery("Allaqachon saqlangan!");
        return ctx.reply("⚠️ Bugungi davomatingiz allaqachon tizimda mavjud.");
    }

    await Attendance.findOneAndUpdate(
        { telegramId: ctx.from.id, objectId, date: today },
        { status, timestamp: new Date() },
        { upsert: true }
    );
    await ctx.answerCallbackQuery("Saqlandi!");
    return ctx.reply(`✨ Bugungi davomatingiz muvaffaqiyatli kiritildi: **${statusLabel(status)}**`);
});

// --- HAR KUNI 18:30 (TOSHKENT VAQTI): ISHCHILARGA ESLATMA + BRIGADIRLARGA XULOSA ---
cron.schedule('30 18 * * *', () => {
    runEveningJobs()
        .then(r => console.log(`⏰ Eslatma: ${r.reminders.sent} ta, xulosa: ${r.summaries.sent} ta`))
        .catch(console.error);
}, { timezone: TZ });

bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`🔴 Error: ${ctx.update.update_id}:`);
    const e = err.error;
    if (e.description && e.description.includes("message is not modified")) return;
    console.error(e);
});

bot.start();
