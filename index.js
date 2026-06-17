require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard, session, InputFile } = require("grammy");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const express = require("express"); // HTTP Server uchun qo'shildi

// --- 0. EXPRESS VEB SERVER INTEGRATSIYASI (KOYEB VA PORT UCHUN) ---
const app = express();
const PORT = process.env.PORT || 3000; // Hosting beradigan port, yo'q bo'lsa 3000

// Saytga kirganda xuddi rasmdagidek yozuv chiqishi uchun:
app.get("/", (req, res) => {
    res.send("Bot ishlayapti");
});

// Serverni ishga tushirish (Koyeb o'chirib qo'ymasligi uchun)
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
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    createdAt: { type: Date, default: Date.now }
}));

const Attendance = mongoose.model("Attendance", new mongoose.Schema({
    telegramId: Number,
    objectId: String,
    date: { type: String, required: true }, // YYYY-MM-DD
    timestamp: { type: Date, default: Date.now },
    status: { type: String, enum: ['full', 'half', 'absent'] }
}));

const Payment = mongoose.model("Payment", new mongoose.Schema({
    telegramId: Number,
    objectId: String,
    amount: Number,
    date: { type: Date, default: Date.now }
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
        targetObjId: null
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

// --- YORDAMCHI FUNKSIYALAR ---
function formatPhoneNumber(text) {
    if (!text) return null;
    let cleaned = text.replace(/\D/g, '');
    if (cleaned.startsWith('998') && cleaned.length === 12) return `+${cleaned}`;
    if (cleaned.length === 9) return `+998${cleaned}`;
    return null;
}

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

function formatDate(dateObj) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatMoney(amount) {
    return new Intl.NumberFormat('fr-FR').format(amount) + " so'm";
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

function generateDaysRange(filterType, firstAttendanceDate) {
    const dates = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (filterType === 'week') {
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(today.getDate() - i);
            dates.push(formatDate(d));
        }
        return dates;
    }

    if (filterType === 'month') {
        for (let i = 0; i < 30; i++) {
            const d = new Date();
            d.setDate(today.getDate() - i);
            dates.push(formatDate(d));
        }
        return dates;
    }

    if (filterType === 'all') {
        let start = new Date();
        if (firstAttendanceDate) {
            start = new Date(firstAttendanceDate);
        }
        start.setHours(0, 0, 0, 0);

        while (start <= today) {
            dates.push(formatDate(start));
            start.setDate(start.getDate() + 1);
        }
        return dates.reverse();
    }

    return dates;
}

async function getWorkerObjectStats(telegramId, objectId, dailyRate, filterType = 'all') {
    let query = { telegramId, objectId };
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (filterType === 'week') {
        const weekAgo = new Date();
        weekAgo.setDate(today.getDate() - 7);
        query.timestamp = { $gte: weekAgo };
    } else if (filterType === 'month') {
        const monthAgo = new Date();
        monthAgo.setDate(today.getDate() - 30);
        query.timestamp = { $gte: monthAgo };
    }

    const attendances = await Attendance.find(query);

    let totalEarnedDays = 0;
    attendances.forEach(a => {
        if (a.status === 'full') totalEarnedDays += 1;
        if (a.status === 'half') totalEarnedDays += 0.5;
    });

    const totalEarnedMoney = totalEarnedDays * dailyRate;
    const payments = await Payment.find({ telegramId, objectId });
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

// --- CSV HISOBOT GENERATORI ---
async function generateCSVReport(obj, workers, filterType = 'all') {
    let csvLines = [];
    csvLines.push("sep=;");

    let filterLabel = filterType === 'week' ? "Haftalik" : filterType === 'month' ? "Oylik" : "Umumiy";
    let headerCells = [`Ishchi Ismi (${filterLabel})`, "Telefon Raqami", "Kunlik Stavka", "Ishlagan Smenasi", "Ish Haqi", "Olingan Pul (Avans)", "Pul Berilgan Kunlar", "Qolgan Ish Kuni", "Qolgan Jami Pul"];
    csvLines.push(headerCells.map(cell => `"${cell}"`).join(";"));

    for (const worker of workers) {
        const stats = await getWorkerObjectStats(worker.telegramId, obj.objectId, worker.dailyRate || 0, filterType);

        let safeName = worker.fullName ? worker.fullName.replace(/"/g, '""') : "Ismsiz";
        let safePhone = worker.phone ? worker.phone.replace(/"/g, '""') : "-";

        let rowCells = [
            safeName, safePhone, `${worker.dailyRate || 0} so'm`,
            `${stats.totalEarnedDays} kun`, `${stats.totalEarnedMoney} so'm`,
            `${stats.totalPaidMoney} so'm`, `${stats.paidDays} kun`,
            `${stats.remainingDays} kun`, `${stats.remainingMoney} so'm`
        ];
        csvLines.push(rowCells.map(cell => `"${cell}"`).join(";"));
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

// --- START RAUNDI ---
bot.command("start", async (ctx) => {
    const userId = ctx.from.id;
    const startPayload = ctx.match;
    const username = ctx.from.username ? `@${ctx.from.username}` : "Mavjud emas";

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
            await CompanyObject.findOneAndUpdate({ objectId: startPayload }, { $addToSet: { workers: userId } });
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

// --- MATNLI XABARLAR PROTSESSORI ---
bot.on("message", async (ctx) => {
    const userId = ctx.from.id;
    const step = ctx.session?.step;
    const text = ctx.message?.text || "";
    const contact = ctx.message?.contact;

    if (systemButtons.includes(text) && step !== 'give_money_input' && step !== 'create_object_name') {
        ctx.session.step = null;
    }

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
        const rate = parseInt(text.replace(/\s/g, ''));
        if (isNaN(rate) || rate < 0) return ctx.reply("⚠️ Iltimos, faqat musbat raqam kiriting:");

        const objectId = ctx.session.payload;
        const username = ctx.from.username ? `@${ctx.from.username}` : "Mavjud emas";

        await User.create({
            telegramId: userId, role: 'user', phone: ctx.session.phone, fullName: ctx.session.fullName, username, dailyRate: rate
        });

        if (objectId) {
            const obj = await CompanyObject.findOne({ objectId });
            if (obj && obj.status === 'closed') {
                ctx.session.step = null;
                return ctx.reply("🚫 Tizimdan o'tdingiz, lekin havoladagi obyekt yopilgan.", { reply_markup: getMainMenu('user') });
            }
            await CompanyObject.findOneAndUpdate({ objectId }, { $addToSet: { workers: userId } });
            ctx.session.step = null;
            return ctx.reply(`🎉 Ro'yxatdan o'tdingiz va **"${obj?.name || 'Obyekt'}"** obyektiga qo'shildingiz!`, { reply_markup: getMainMenu('user') });
        }

        ctx.session.step = null;
        return ctx.reply(`🎉 Ro'yxatdan muvaffaqiyatli o'tdingiz!`, { reply_markup: getMainMenu('user') });
    }

    if (step === 'create_object_name' && text) {
        if (systemButtons.includes(text)) {
            return ctx.reply("⚠️ **Tugma matnini obyekt nomi sifatida saqlab bo'lmaydi!**\n\nIltimos, firma yoki obyekt nomini yozib yuboring:");
        }

        const objectId = "obj_" + Math.random().toString(36).substr(2, 9);
        await CompanyObject.create({ objectId, name: text.trim(), creatorId: userId, workers: [userId], status: 'active' });
        ctx.session.step = null;
        const botInfo = await bot.api.getMe();
        const user = await User.findOne({ telegramId: userId });
        return ctx.reply(`🏗 **Obyekt yaratildi:** *${text.trim()}*\n\nBoshqalarni qo'shish uchun havola:\n\`https://t.me/${botInfo.username}?start=${objectId}\``, {
            parse_mode: "Markdown", reply_markup: getMainMenu(user.role)
        });
    }

    if (step === 'give_money_input' && text) {
        const amount = parseInt(text.replace(/\s/g, ''));
        if (isNaN(amount) || amount <= 0) return ctx.reply("⚠️ Iltimos, to'g'ri summani kiriting:");

        await Payment.create({
            telegramId: ctx.session.targetWorkerId,
            objectId: ctx.session.targetObjId,
            amount: amount
        });

        ctx.session.step = null;
        ctx.reply(`✅ Pul kiritildi! Ishchining umumiy balansidan chegirildi.`);
        try {
            await bot.api.sendMessage(ctx.session.targetWorkerId, `💰 Sizga obyekt bo'yicha **${formatMoney(amount)}** avans berildi.`);
        } catch (e) { }
        return;
    }

    if (text === "🏢 Yangi Obyekt Ochish") {
        ctx.session.step = 'create_object_name';
        return ctx.reply("🏢 **Yangi obyekt nomini kiriting:**");
    }

    if (text === "📂 Mening Obyektlarim") {
        const myObjects = await CompanyObject.find({ creatorId: userId, status: 'active' });
        if (myObjects.length === 0) return ctx.reply("📭 Siz ochgan faol obyektlar mavjud emas.");

        const keyboard = new InlineKeyboard();
        myObjects.forEach(obj => {
            keyboard.text(`🏗 ${obj.name}`, `manage-obj_${obj.objectId}_all`).row();
        });
        return ctx.reply("🏗 **O'zingiz ochgan obyektlardan birini tanlang:**", { reply_markup: keyboard });
    }

    if (text === "🤝 Qo'shilgan Obyektlarim") {
        const joinedObjects = await CompanyObject.find({ workers: userId, creatorId: { $ne: userId }, status: 'active' });
        if (joinedObjects.length === 0) return ctx.reply("📭 Siz hozirda boshqa faol obyektlarga qo'shilmagansiz.");

        let outText = "🤝 **Siz qo'shilgan obyektlar ro'yxati va umumiy hisob-kitoblar:**\n\n";
        for (const obj of joinedObjects) {
            const owner = await User.findOne({ telegramId: obj.creatorId });
            const me = await User.findOne({ telegramId: userId });
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
        return ctx.reply(outText, { parse_mode: "Markdown" });
    }

    if (text === "📅 Bugungi Davomat") {
        const myObjects = await CompanyObject.find({ workers: userId, status: 'active' });
        if (myObjects.length === 0) return ctx.reply("⚠️ Siz hech qaysi faol obyekt a'zosi emassiz.");

        const keyboard = new InlineKeyboard();
        myObjects.forEach(obj => {
            keyboard.text(`👷‍♂️ ${obj.name}`, `mark-att_${obj.objectId}`).row();
        });
        return ctx.reply("📅 **Bugungi davomatni qaysi obyekt bo'yicha kiritasiz? Obyektni tanlang:**", { reply_markup: keyboard });
    }

    if (text === "📝 Mening kunlarim (Tahrirlash)") {
        const myObjects = await CompanyObject.find({ workers: userId, status: 'active' });
        if (myObjects.length === 0) return ctx.reply("📭 Aktiv ishtirok etayotgan obyektlaringiz topilmadi.");

        const keyboard = new InlineKeyboard();
        myObjects.forEach(obj => {
            keyboard.text(`📁 ${obj.name}`, `select-obj-edit_${obj.objectId}_week`).row();
        });
        return ctx.reply("📝 **Qaysi obyektdagi kunlaringizni ko'rib tahrirlamoqchisiz?**", { reply_markup: keyboard });
    }

    if (text === "⚙️ Sozlamalar") {
        const user = await User.findOne({ telegramId: userId });
        ctx.session.step = 'change_rate_input';
        return ctx.reply(`👤 **Ism:** ${user.fullName}\n💰 **Joriy kunlik stavka:** ${formatMoney(user.dailyRate)}\n\n🔄 Yangi kunlik stavkani faqat raqamlarda kiriting:`);
    }

    if (ctx.session?.step === 'change_rate_input' && text) {
        const rate = parseInt(text.replace(/\s/g, ''));
        if (isNaN(rate) || rate < 0) return ctx.reply("⚠️ Faqat raqam kiriting:");
        await User.findOneAndUpdate({ telegramId: userId }, { dailyRate: rate });
        ctx.session.step = null;
        const u = await User.findOne({ telegramId: userId });
        return ctx.reply(`✅ Stavka muvaffaqiyatli yangilandi!`, { reply_markup: getMainMenu(u.role) });
    }

    if (text === "📊 Global Statistika") {
        const user = await User.findOne({ telegramId: userId });
        if (user?.role !== 'super_admin') return;
        const totalUsers = await User.countDocuments();
        const totalObjects = await CompanyObject.countDocuments();
        return ctx.reply(`📊 **Tizim statistikasi:**\n\n👥 Ro'yxatdan o'tganlar: ${totalUsers}\n🏗 Obyektlar jami: ${totalObjects}`);
    }
});

// --- 6. INLINE CALLBACK QUERY PROCESSORS ---

bot.callbackQuery(/^select-obj-edit_(.+)_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const filterType = ctx.match[2];
    await ctx.answerCallbackQuery();

    const obj = await CompanyObject.findOne({ objectId });
    if (!obj) return ctx.reply("⚠️ Obyekt topilmadi.");

    const existAttendances = await Attendance.find({ telegramId: ctx.from.id, objectId });
    const attMap = {};
    existAttendances.forEach(att => { attMap[att.date] = att; });

    const firstAttendance = await Attendance.findOne({ telegramId: ctx.from.id, objectId }).sort({ date: 1 });
    const allDays = generateDaysRange(filterType, firstAttendance ? firstAttendance.date : null);

    const keyboard = new InlineKeyboard();
    keyboard.text(filterType === 'week' ? "• 1 Hafta •" : "1 Hafta", `select-obj-edit_${objectId}_week`)
        .text(filterType === 'month' ? "• 1 Oy •" : "1 Oy", `select-obj-edit_${objectId}_month`)
        .text(filterType === 'all' ? "• Umumiy kunlar •" : "Umumiy kunlar", `select-obj-edit_${objectId}_all`).row();

    try {
        if (allDays.length === 0) {
            return await ctx.editMessageText("📭 Ushbu tanlangan davrda kunlar mavjud emas.", { reply_markup: keyboard });
        }

        allDays.forEach(dateStr => {
            const att = attMap[dateStr];
            let icon = "⚪️";
            let label = "Belgilanmagan";
            // CHALKAShLIKNI OLDINI OLISh UChUN BU YERDA ICHKI AJRATUVCHINI COLLON (:) QILDIM
            let callbackData = `edit-day-choice:${objectId}:${dateStr}`;

            if (att) {
                icon = statusIcon(att.status);
                label = statusLabel(att.status);
                callbackData = `edit-day-choice:ID:${att._id}`;
            }
            keyboard.text(`📅 ${dateStr} ➡️ ${icon} ${label}`, callbackData).row();
        });

        return await ctx.editMessageText("📆 **Tahrirlamoqchi yoki belgilamoqchi bo'lgan kuningizni tanlang:**\n\n*(Belgilanmagan kunlar ⚪️ bo'lib turadi, ustiga bosib kiritishingiz mumkin)*", { reply_markup: keyboard });
    } catch (error) {
        if (error.description && error.description.includes("message is not modified")) return;
        console.error(error);
    }
});

// IKKI NUQTA (:) BILAN YANGI PARSER REGEXI
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
            .text("Ishlamadim (O'chirish) ❌", `update-day-save:EXIST:${attId}:absent`);

        return ctx.reply(`🔄 **Sana:** ${att.date}\n**Joriy Holat:** ${statusLabel(att.status)}\n\nO'zgartirish variantini tanlang:`, { reply_markup: keyboard });
    } else {
        const [objId, dateStr] = payload.split(":");

        keyboard.text("To'liq kun ✅", `update-day-save:NEW:${objId}:${dateStr}:full`)
            .text("Yarim smena 🟡", `update-day-save:NEW:${objId}:${dateStr}:half`).row()
            .text("Kelmadi (O'tkazib yuborish) ❌", `update-day-save:NEW:${objId}:${dateStr}:absent`);

        return ctx.reply(`📝 **Sana:** ${dateStr}\nUshbu kun uchun hali davomat belgilanmagan.\n\nHolat kiritasizmi?`, { reply_markup: keyboard });
    }
});

// SAQLASh TUGMASIDA HAM (:) BIZNES LOGIKASI TO'G'RILANDI
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
        return ctx.reply(`✨ **${att.date}** sanasidagi holat muvaffaqiyatli **${statusLabel(newStatus)}** deb o'zgartirildi!`);
    } else {
        // parts[0] === "NEW" -> NEW:obj_12345:2026-06-17:full
        const objId = parts[1];
        const dateStr = parts[2];
        const newStatus = parts[3];

        await Attendance.findOneAndUpdate(
            { telegramId: ctx.from.id, objectId: objId, date: dateStr },
            { status: newStatus, timestamp: new Date() },
            { upsert: true }
        );
        return ctx.reply(`✨ **${dateStr}** kuni **${statusLabel(newStatus)}** bo'lib tizimga kiritildi!`);
    }
});

bot.callbackQuery(/^manage-obj_(.+)_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const filterType = ctx.match[2];
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj || obj.status === 'closed') return ctx.answerCallbackQuery("Obyekt faol emas yoki yopilgan.");
    await ctx.answerCallbackQuery();

    const workers = await User.find({ telegramId: { $in: obj.workers } });

    let filterLabel = filterType === 'week' ? "1 Haftalik" : filterType === 'month' ? "1 Oylik" : "Umumiy Loyiha";
    let text = `🏗 **Obyekt:** ${obj.name}\n📊 **Hisobot Filtri:** ${filterLabel}\n\n👥 **Ishchilar va hisobotlar:**\n\n`;

    const keyboard = new InlineKeyboard();
    keyboard.text(filterType === 'week' ? "• 1 Hafta •" : "1 Hafta", `manage-obj_${objectId}_week`)
        .text(filterType === 'month' ? "• 1 Oy •" : "1 Oy", `manage-obj_${objectId}_month`)
        .text(filterType === 'all' ? "• Umumiy •" : "Umumiy", `manage-obj_${objectId}_all`).row();

    for (const worker of workers) {
        const stats = await getWorkerObjectStats(worker.telegramId, objectId, worker.dailyRate || 0, filterType);
        text += `👤 **${worker.fullName}**\n`;
        text += `├ Davrdagi smenasi: *${stats.totalEarnedDays} kun* (${formatMoney(stats.totalEarnedMoney)})\n`;
        text += `├ Berilgan jami avans: *${formatMoney(stats.totalPaidMoney)}* (${stats.paidDays} kunlik)\n`;
        text += `├ **Qolgan ish kuni:** *${stats.remainingDays} kun*\n`;
        text += `└ **Sof beriladigan pul:** **${formatMoney(stats.remainingMoney)}**\n---------------------\n`;

        keyboard.text(`💵 ${worker.fullName}-ga pul berish`, `pay_${objectId}_${worker.telegramId}`).row();
    }

    keyboard.text(`📥 ${filterLabel} Excel CSV Yuklash`, `csv_${objectId}_${filterType}`).row();
    keyboard.text("🛑 Obyektni Yopish va Yakuniy Hisobot", `close-obj_${objectId}`);

    try {
        return await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (error) {
        if (error.description && error.description.includes("message is not modified")) return;
        console.error(error);
    }
});

bot.callbackQuery(/^pay_(.+)_(.+)$/, async (ctx) => {
    ctx.session.step = 'give_money_input';
    ctx.session.targetObjId = ctx.match[1];
    ctx.session.targetWorkerId = parseInt(ctx.match[2]);
    await ctx.answerCallbackQuery();
    return ctx.reply("💰 **Ishchiga berilgan naqd pul summasini yozing (Faqat raqamda):**");
});

bot.callbackQuery(/^csv_(.+)_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const filterType = ctx.match[2];
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj) return ctx.answerCallbackQuery("Obyekt topilmadi.");
    await ctx.answerCallbackQuery("Excel tayyorlanmoqda...");

    const workers = await User.find({ telegramId: { $in: obj.workers } });
    try {
        const { filePath } = await generateCSVReport(obj, workers, filterType);
        await ctx.replyWithDocument(new InputFile(filePath), { caption: `📊 **"${obj.name}"** obyektining ${filterType} hisobot Excel jadvali.` });
        fs.unlinkSync(filePath);
    } catch (err) { ctx.reply("⚠️ Hisobot yaratishda muammo chiqdi."); }
});

bot.callbackQuery(/^close-obj_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const obj = await CompanyObject.findOne({ objectId });
    if (!obj || obj.status === 'closed') return ctx.answerCallbackQuery("Ushbu obyekt allaqachon yopilgan.");

    await ctx.answerCallbackQuery("Yakuniy hisobotlar tayyorlanmoqda...");
    const workers = await User.find({ telegramId: { $in: obj.workers } });

    try {
        const adminReport = await generateCSVReport(obj, workers, 'all');
        await ctx.replyWithDocument(new InputFile(adminReport.filePath), {
            caption: `🛑 **"${obj.name}"** obyekti yopildi.\n\nProrab uchun jami ishchilarning yakuniy to'liq Excel hisoboti.`
        });
        fs.unlinkSync(adminReport.filePath);

        for (const worker of workers) {
            if (worker.telegramId !== obj.creatorId) {
                try {
                    const personalReport = await generateCSVReport(obj, [worker], 'all');
                    await bot.api.sendDocument(worker.telegramId, new InputFile(personalReport.filePath), {
                        caption: `🛑 **"${obj.name}"** obyekti yopildi.\n\nSizning ushbu obyektdagi shaxsiy yakuniy moliyaviy hisobot faylingiz.`
                    });
                    fs.unlinkSync(personalReport.filePath);
                } catch (e) {
                    console.error(e);
                }
            }
        }

        obj.status = 'closed';
        await obj.save();

        return ctx.reply("✨ Obyekt muvaffaqiyatli yopildi! Sizga to'liq hisobot, ishchilarga esa faqat o'zlariga tegishli shaxsiy Excel fayllari yuborildi.");
    } catch (err) {
        console.error(err);
        ctx.reply("⚠️ Yopish jarayonida muammo yuz berdi.");
    }
});

bot.callbackQuery(/^mark-att_(.+)$/, async (ctx) => {
    const objectId = ctx.match[1];
    const today = todayStr();

    const alreadyMarked = await Attendance.findOne({ telegramId: ctx.from.id, objectId, date: today });

    if (alreadyMarked) {
        await ctx.answerCallbackQuery("Ta'qiqlangan!");
        return ctx.reply(`🚫 **Ushbu obyektda bugun uchun davomat kiritib bo'lingan!**\n\n*Joriy holat:* ${statusLabel(alreadyMarked.status)}\n\n🔄 Agar o'zgartirmoqchi bo'lsangiz, menyudagi **"📝 Mening kunlarim (Tahrirlash)"** bo'limiga o'ting.`, { parse_mode: "Markdown" });
    }

    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard()
        .text("To'liq kun ✅", `save-att_${objectId}_full`)
        .text("Yarim smena 🟡", `save-att_${objectId}_half`).row()
        .text("Ishlamadim ❌", `save-att_${objectId}_absent`);

    return ctx.reply(`📅 **Bugun ushbu obyektda ishladingizmi?**`, { reply_markup: keyboard });
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

bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`🔴 Error: ${ctx.update.update_id}:`);
    const e = err.error;
    if (e.description && e.description.includes("message is not modified")) return;
    console.error(e);
});

bot.start();