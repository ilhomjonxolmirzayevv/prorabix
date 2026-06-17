# 🏗 Construction Attendance & Payroll Telegram Bot

Ushbu Telegram bot qurilish obyektlari, firmalar yoki ishlab chiqarish korxonalarida ishchilarning kunlik davomatini yuritish, avans (pul) berish tizimini nazorat qilish va yakuniy moliyaviy hisobotlarni avtomatik hisoblash uchun mo'ljallangan. Loyiha **Koyeb**, **Heroku** yoki boshqa bulutli hostinglarda 24/7 uzluksiz ishlashi uchun Express HTTP server (port binding) bilan ta'minlangan.

## 🚀 Imkoniyatlari

* **Obyektlar Boshqaruvi:** Prorab (admin) yangi obyektlar ochishi va ishchilarga taklif havolasi (link) orqali ulashishi mumkin.
* **Moslashuvchan Davomat:** Ishchilar har kuni o'z davomatlarini (To'liq kun ✅, Yarim smena 🟡, Kelmadi ❌) belgilashlari mumkin.
* **Kunlarni Tahrirlash:** Oxirgi 1 hafta, 1 oy yoki loyiha boshlanganidan beri bo'lgan barcha kunlarni kalendar ko'rinishida ko'rish va kiritilmagan kunlarni qaytadan belgilash imkoniyati.
* **Moliyaviy Nazorat:** Kunlik stavka asosida ish haqi avtomatik hisoblanadi. Admin ishchilarga berilgan avanslarni kiritib boradi.
* **Eksport va Hisobotlar:** Haftalik, oylik va umumiy hisobotlarni chiroyli `Excel CSV` formatida yuklab olish.
* **Obyektni Yopish:** Obyekt yopilganda prorabga umumiy, ishchilarga esa faqat o'zlariga tegishli shaxsiy yakuniy hisobot fayllari avtomat yuboriladi.

## 🛠 Texnologiyalar

* **Language:** Node.js (v16+)
* **Framework:** [GrammY](https://grammy.dev/) (Telegram Bot API)
* **Database:** MongoDB (Mongoose ORM)
* **Server:** Express.js (Port binding va Web-check uchun)

## 📦 O'rnatish va Ishga Tushirish

### 1. Loyihani yuklab olish va modullarni o'rnatish
```bash
git clone <repository-url>
cd <repository-folder>
npm install
