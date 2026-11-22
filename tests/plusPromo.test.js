const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function fixture() {
  const sent = [];
  const issued = [];
  const responses = [];
  const dependencies = {
    "../telegram": {
      sendMessage: async (...args) => sent.push(args),
      answerCallbackQuery: async (...args) => responses.push(args),
    },
    "../plusPayments": {},
    "../plusPlanLimits": {},
    "../plusPlans": {
      promoDurations: { month: 30, year: 365 },
      issuePromo: async (...args) => {
        issued.push(args);
        return "PLUS-EXAMPLE";
      },
    },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, "../lib/handlers/plus.js"), "utf8");
  vm.runInNewContext(source, {
    module,
    require: name => dependencies[name],
    process: { env: { PLUS_ADMIN_TELEGRAM_ID: "7", PLUS_BOT_USERNAME: "test_planner_bot" } },
  });
  return { ...module.exports, issued, sent, responses };
}

test("only the owner in their private chat gets gift duration buttons and can generate gifts", async () => {
  const { handlePromo, handlePromoDuration, issued, sent, responses } = fixture();
  const user = { id: 7 };
  const privateChat = { id: 7, type: "private" };
  await handlePromo({ chat: privateChat, from: user }, "promogive");
  const buttons = sent[0][2].replyMarkup.inline_keyboard[0];
  assert.equal(buttons[0].callback_data, "promo:month");
  assert.equal(buttons[1].callback_data, "promo:year");

  await handlePromoDuration({ id: "stolen", data: "promo:year", from: { id: 8 }, message: { chat: privateChat } });
  await handlePromoDuration({ id: "group", data: "promo:year", from: user, message: { chat: { id: -9, type: "group" } } });
  assert.equal(issued.length, 0);
  assert.match(responses[0][1], /владельцу/);

  await handlePromoDuration({ id: "annual", data: "promo:year", from: user, message: { chat: privateChat } });
  await handlePromoDuration({ id: "monthly", data: "promo:month", from: user, message: { chat: privateChat } });
  assert.deepEqual(issued, [["7", 365], ["7", 30]]);
  assert.match(sent[1][1], /365 дней/);
  assert.match(sent[1][1], /\/promo PLUS-EXAMPLE/);
  assert.match(sent[2][1], /30 дней/);
});

test("owner can issue a monthly campaign with a redemption cap and a Telegram link", async () => {
  const { handlePromo, issued, sent } = fixture();
  const owner = { chat: { id: 7, type: "private" }, from: { id: 7 } };
  const other = { chat: { id: 8, type: "private" }, from: { id: 8 } };
  await handlePromo(other, "promocampaign", "100");
  await handlePromo(owner, "promocampaign", "10001");
  assert.equal(issued.length, 0);

  await handlePromo(owner, "promocampaign", "100");
  assert.deepEqual(issued, [[7, 30, 100]]);
  assert.match(sent[2][1], /до 100 активаций/);
  assert.ok(sent[2][1].includes("https://t.me/test_planner_bot?start=promo_PLUS-EXAMPLE"));
});
