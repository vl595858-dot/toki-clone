const limits = {
  free: { event: 30, voice: 30, image: 0 },
  plus: { event: Infinity, voice: 120, image: 30 },
};

const limitMessages = {
  event: "Лимит бесплатного тарифа — 30 новых дел за 30 дней. Твои дела и напоминания доступны. Подробности — /plus.",
  voice: "Лимит голосовых на твоём тарифе исчерпан. Можешь написать текстом. Остаток и тариф — /plus.",
  image: "Разбор фото и скриншотов входит в Плюс. Если Плюс уже активен, проверь остаток в /plus.",
};

module.exports = { limits, limitMessages };
