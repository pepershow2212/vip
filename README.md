# WARDOGS VIP

Отдельный Discord-бот: ручная оплата → тикет с чеком → админ выдаёт VIP → SteamID в **Reserved Slots** на всех серверах через Wardogs RCON + роль VIP.

## Как работает

1. `/vip-panel` — панель в канал «Поддержи нас» (`PANEL_CHANNEL_ID`)  
2. Игрок жмёт тариф → тикет  
3. Бот пишет: перевод на ЮMoney `4100119612206096`, прикрепить чек  
4. Админ: `/vip-grant @user steam_id days`  
5. Бот:
   - дописывает SteamID в reserved slots на **всех** настроенных `SERVER_*` (сейчас 1 и 2, позже 3+)
   - выдаёт роль VIP
   - пишет в БД + лог
6. За 3 дня до конца — ЛС напоминание  
7. По окончании — снимает слот и роль

VIP **не затирает** чужие reserved (царь горы / другие VIP) — только дописывает/убирает свой SteamID.

## Тарифы

| Цена | Срок |
|------|------|
| 200 ₽ | 7 дней |
| 600 ₽ | 30 дней |
| 1600 ₽ | 90 дней |

## Bothost

1. Создай бота → язык **Node.js / discord.js**
2. Главный файл: `index.js`
3. Включи **«Использовать собственный Dockerfile»**
4. Залей репозиторий / файлы проекта
5. В переменных окружения панели пропиши всё из `.env.example` (токен, guild, роль, RCON…)
6. **Пересобери / деплой**, не просто рестарт
7. Один раз локально или через one-shot: `npm run deploy-commands` (нужны `DISCORD_TOKEN` + `DISCORD_CLIENT_ID` + `DISCORD_GUILD_ID`)

БД VIP: `DATABASE_PATH=/app/data/vip.db` (в Dockerfile уже так).


## Команды

| Команда | Кто | Что |
|---------|-----|-----|
| `/vip-panel` | админ | панель V2 в «Поддержи нас» |
| `/vip-grant steam_id:` | админ | выдать VIP (в тикете user/days сами) |
| `/vip-revoke` | админ | снять досрочно |
| `/vip-status` | все | свой статус |

Лимит активных VIP: `VIP_MAX_SLOTS` (по умолчанию 80). Продление не занимает новый слот.
Тикет после выдачи закрывается через ~12 сек. Логи → `LOG_CHANNEL_ID`.


## RCON

Как в панели http://rcon.wardogs.com/app.html → Server Administration → Reserved Slots:

- читает `/v1/reserved-slots` и `/v1/config`
- пишет `DefaultReservedPlayerIds` через `PUT /v1/config?force=true`
