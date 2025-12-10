import "dotenv/config";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TELEGRAM_BOT_TOKEN || !WEBHOOK_URL) {
  console.error("Please set TELEGRAM_BOT_TOKEN and WEBHOOK_URL in your .env file");
  process.exit(1);
}

async function setWebhook() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: WEBHOOK_URL }),
      }
    );

    const data = await res.json();
    console.log("Webhook response:", data);
  } catch (err) {
    console.error("Error setting webhook:", err);
  }
}

setWebhook();
