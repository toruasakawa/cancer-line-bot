const express = require("express");
const line = require("@line/bot-sdk");

const config = {
  channelSecret: process.env.CHANNEL_SECRET,
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);
const app = express();

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ status: "ok" }))
    .catch((err) => res.status(500).end());
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: event.message.text, // オウム返し
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot running on port ${port}`));
