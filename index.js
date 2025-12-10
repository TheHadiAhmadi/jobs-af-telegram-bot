import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import OpenAI from "openai";
import "dotenv/config";
import express from "express";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

function getSubscribers() {
  console.log("getSubscribers");

  return JSON.parse(readFileSync("./data/subscribers.json", "utf-8"));
}

function saveSubscribers(arr) {
  console.log("saveSubscribers", arr);
  writeFileSync("./data/subscribers.json", JSON.stringify(arr, null, 2));
}

const app = express();
app.use(express.json());

if (!existsSync("./data")) {
  mkdirSync("./data");
}

if (!existsSync("./data/subscribers.json"))
  writeFileSync("./data/subscribers.json", "[]");

if (!existsSync("./data/jobs.json")) {
  writeFileSync("./data/jobs.json", "[]");
}
if (!existsSync("./data/jobs")) {
  mkdirSync("./data/jobs");
}
const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});

async function getJobDescription(slug) {
  const url = "https://jobs.af/api/v2.6/jobs/" + slug;
  console.log(url);

  const result = await fetch(url).then((res) => res.json());

  return result;
}

async function getStructuredJobData(job) {
  const systemPrompt = `You are helpful HR assistant, you should convert unstructured 
job data to structured json object. 
the object should have these fields:

type ProvinceName = string;

{
    position: string,
    remainingDays: number,
    gender: 'male' | 'female' | 'any',
    locations: 'any' | string[],
    company: string,
    summary: string (3 line summary of the job descriptions),
    duration: 'unspecified' | string,
    educationDegree: 'bachelor' | 'master' | '12grade' | 'any',
    educationFields: [string] (computer science, software engineering, ...),
    experienceYears: string (use 0 if experience is not required, '2 years' | '1-3 years' | ...),
    englishRequired: bool (only if english language is 100% required),
    skillsRequired: [string] (list of required skills as camel_case),
    skillsOptional: [string] (list of optional skills as camel_case),
}

skip skills like team work, soft skills, presentation, problem solving...
only include the skills that can be gained, like mysql, react, frontend_design, ...
for skills include maximum 8 and minimum 2 most important items. requiredLanguages field is not accurate. detect language requirement from description

just return json object inside markdown block
no texts after or before.
to calculate remaining days, use current time: ${new Date().toISOString()}
    
    `;
  const result = await openai.chat.completions.create({
    model: "openai/gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Generate structured data for this object: " + JSON.stringify(job),
      },
    ],
  });

  const stringContent = result.choices[0].message.content;

  return JSON.parse(stringContent.replace("```json", "").replace("```", ""));
}

async function loadData() {
  let items = [];
  let page = 1;
  while (true) {
    const url =
      "https://jobs.af/api/v2.6/jobs/latest-jobs?filter=" +
      JSON.stringify({ page });
    const result = await fetch(url).then((res) => res.json());

    for (let item of result.data) {
      items.push(item);
    }
    page += 1;

    if (items.length >= result.total) {
      break;
    }
  }
  return items;
}

async function checkSiteData() {
  const prevItems = JSON.parse(readFileSync("./data/jobs.json", "utf-8"));

  const items = await loadData();
  const prevSlugs = prevItems.map((x) => x.slug);

  const newItems = [];

  for (let item of items) {
    if (!prevSlugs.find((x) => item.slug == x)) {
      newItems.push(item);
    }
  }

  console.log("found new items count: " + newItems.length);

  writeFileSync(
    "./data/jobs.json",
    JSON.stringify([...prevItems, ...newItems])
  );
  for (let newItem of newItems) {
    // read full content
    try {
      const content = await getJobDescription(newItem.slug);
      const structuredJob = await getStructuredJobData(content);
      content.summarized = structuredJob;

      writeFileSync(
        "./data/jobs/" + newItem.slug + ".json",
        JSON.stringify(content, null, 4)
      );
      // notify
      const subs = getSubscribers();
      for (let user of subs) {
        if (!user.wantsDaily) continue; // skip users who opted out
        if (!user.fields || !user.locations || !user.gender) continue; // skip incomplete prefs

        const job = structuredJob;

        // Simple matching: field, location, gender
        const fieldMatch = job.educationFields.some((f) =>
          user.fields.includes(f)
        );
        const locationMatch =
          job.locations === "any" ||
          job.locations.some((l) => user.locations.includes(l));
        const genderMatch = job.gender === "any" || job.gender === user.gender;

        if (fieldMatch && locationMatch && genderMatch) {
          user.sentJobs = user.sentJobs || [];
          if (!user.sentJobs.includes(job.slug)) {
            const message = toTelegramMessage(job);
            await sendTelegramMessage(user.chatId, message);
            user.sentJobs.push(job.slug);
          }
        }
      }

      saveSubscribers(subs);
    } catch (err) {
      console.log(err);
    }
  }
}

function toTelegramMessage(o) {
  const b = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  return [
    `*${o.position}* at *${o.company}*`,
    ``,
    `*Location:* ${
      typeof o.locations === "string" ? "Any" : o.locations.join(", ")
    }`,
    `*Gender:* ${b(o.gender)}`,
    `*Remaining Days:* ${o.remainingDays} Days`,
    `*Duration:* ${o.duration}`,
    `*Education:* ${b(o.educationDegree)} in ${o.educationFields.join(", ")}`,
    `*Experience:* ${o.experienceYears}`,
    `*English Required:* ${o.englishRequired ? "Yes" : "No"}`,
    ``,
    `*Summary:*`,
    o.summary,
    ``,
    `*Required Skills:*`,
    o.skillsRequired.map((s) => `- ${s}`).join("\n"),
    ``,
    `*Optional Skills:*`,
    o.skillsOptional.map((s) => `- ${s}`).join("\n"),
  ].join("\n");
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  console.log("send telegram message", chatId, text);
  console.log(TELEGRAM_API);

  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: replyMarkup || undefined,
    }),
  });
}

async function editTelegramMessage(chatId, messageId, text) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
    }),
  });
}

app.post("/telegram", async (req, res) => {
  const update = req.body;
  console.log("new update from telegram: ", update);
  // if (!update.message) return res.json({ ok: true });

  const isCallback = !!update.callback_query;
  const isMessage = !!update.message;

  console.log({ isCallback, isMessage });
  if (!isCallback && !isMessage) return res.json({ ok: true });

  if (isCallback) {
    const data = update.callback_query.data;
    const chatId = update.callback_query.message.chat.id;
    const msgId = update.callback_query.message.message_id;

    console.log("is callback: ", { data, chatId, msgId });
    let subs = getSubscribers();
    let user = subs.find((x) => x.chatId === chatId);

    console.log("user: ", user);

    if (data === "start_yes") {
      if (!user) {
        user = { chatId, wantsDaily: true, awaitingPreferences: true };
        subs.push(user);
      } else {
        user.wantsDaily = true;
        user.awaitingPreferences = true;
      }
      saveSubscribers(subs);
      await editTelegramMessage(
        chatId,
        msgId,
        "Great. Please describe what type of jobs you are interested in, your preferred locations, and your gender."
      );
    }

    if (data === "start_no") {
      if (!user) {
        user = { chatId, wantsDaily: false, awaitingPreferences: false };
        subs.push(user);
      } else {
        user.wantsDaily = false;
        user.awaitingPreferences = false;
      }
      saveSubscribers(subs);
      await editTelegramMessage(
        chatId,
        msgId,
        "You will not receive daily notifications."
      );
    }

    return res.json({ ok: true });
  }

  if (isMessage) {
    const chatId = update.message.chat.id;
    const text = (update.message.text || "").trim();

    console.log("is message: ", { chatId, text });

    let subs = getSubscribers();
    let user = subs.find((x) => x.chatId === chatId);

    console.log({ user, subs });

    if (text === "/start") {
      if (!user) {
        user = { chatId, wantsDaily: null, awaitingPreferences: false };
        subs.push(user);
        saveSubscribers(subs);
      }

      await sendTelegramMessage(
        chatId,
        "Do you want to receive daily matching job notifications?",
        {
          inline_keyboard: [
            [
              { text: "Yes", callback_data: "start_yes" },
              { text: "No", callback_data: "start_no" },
            ],
          ],
        }
      );
      return res.json({ ok: true });
    } else if (text === "/suggest") {
      if (!user || !user.fields || !user.locations || !user.gender) {
        await sendTelegramMessage(
          chatId,
          "Please set your preferences first using /start."
        );
        return res.json({ ok: true });
      }

      const allJobs = JSON.parse(readFileSync("./data/jobs.json", "utf-8"));
      const matchingJobs = [];

      for (let jobItem of allJobs) {
        const jobData = JSON.parse(
          readFileSync(`./data/jobs/${jobItem.slug}.json`, "utf-8")
        ).summarized;

        const fieldMatch = jobData.educationFields.some((f) =>
          user.fields.includes(f)
        );
        const locationMatch =
          jobData.locations === "any" ||
          jobData.locations.some((l) => user.locations.includes(l));
        const genderMatch =
          jobData.gender === "any" || jobData.gender === user.gender;

        if (fieldMatch && locationMatch && genderMatch) {
          matchingJobs.push(jobData);
        }
      }

      matchingJobs.sort((a, b) => b.remainingDays - a.remainingDays); // optional sorting

      const top5 = matchingJobs.slice(0, 5);

      for (let job of top5) {
        user.sentJobs = user.sentJobs || [];
        if (!user.sentJobs.includes(job.slug)) {
          const message = toTelegramMessage(job);
          await sendTelegramMessage(chatId, message);
          user.sentJobs.push(job.slug);
        }
      }
    }

    if (user && user.awaitingPreferences) {
      const sys = `Extract user job preferences. Return JSON only:
{
 fields: string[],
 locations: string[],
 gender: 'male' | 'female'
}`;
      const ai = await openai.chat.completions.create({
        model: "openai/gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text },
        ],
      });
      const raw = ai.choices[0].message.content;
      const cleaned = raw.replace("```json", "").replace("```", "");
      const prefs = JSON.parse(cleaned);

      user.fields = prefs.fields;
      user.locations = prefs.locations;
      user.gender = prefs.gender;
      user.awaitingPreferences = false;
      saveSubscribers(subs);

      await sendTelegramMessage(chatId, "Your preferences are saved.");
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  }
});

function run() {
  checkSiteData();
  setInterval(() => {
    checkSiteData();
  }, 1 * 1000 * 60 * 60); // every hour
}

run();
app.listen(3000, () => console.log("App started on localhost:" + 3000));
