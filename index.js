import { existsSync, mkdirSync, readFileSync, writeFile, writeFileSync } from "fs";
import OpenAI from "openai";
import "dotenv/config";
import * as cheerio from 'cheerio'
import express from "express";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
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
  skillsRequired: [string] (list of required skills as PascalCase),
  skillsOptional: [string] (list of optional skills as PascalCase),
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

const cleanText = (text) => text ? text.replace(/\s\s+/g, ' ').trim() : '';

async function getWazifahaJobDetails(url) {
  try {
    console.log(`Scraping: ${url}`);
    
    // 1. Fetch the HTML
    const html = await fetch(url).then((res) => res.text());
    const $ = cheerio.load(html);

    // Helper to clean whitespace and remove newlines
    const clean = (text) => text ? text.replace(/\s\s+/g, ' ').trim() : '';

    // 2. Extract Title (Remove "Position Title:" prefix)
    let title = clean($('.detail-title').first().text());
    title = title.replace(/^Position Title:\s*/i, '');

    // 3. Extract Table Data
    // We iterate over all rows in the info tables to build a key-value object
    const tableInfo = {};
    $('.table-striped tr').each((i, el) => {
      const key = clean($(el).find('th').text()).replace(':', '').trim();
      const val = clean($(el).find('td').text());
      if (key) {
        // Convert "Job Location" to "jobLocation" (camelCase) for cleaner JSON
        const camelKey = key.toLowerCase().replace(/ [a-z]/g, (lea) => lea.toUpperCase().trim());
        tableInfo[camelKey] = val;
      }
    });

    // 4. Extract Long Text Sections
    // This helper finds a header (<h3>), gets the next content div, 
    // removes ads/iframes, and returns clean text.
    const getSectionContent = (headerSearchText) => {
      const header = $(`h3:contains("${headerSearchText}")`);
      if (header.length === 0) return null;

      // Select the content div immediately following the header
      const contentDiv = header.next('div.job-content'); // or header.next()

      // CLONE the element so we can remove unwanted children (ads) without breaking the DOM
      const tempCheerio = cheerio.load(contentDiv.html() || '', null, false);
      
      // Remove Ads, Iframes, and Widget Scripts inside the content
      tempCheerio('script, style, iframe, ins, .google-auto-placed, .autors-widget').remove();
      
      return clean(tempCheerio.text());
    };

    // 5. Extract Submission Email specifically
    // It is often in a specific spot at the bottom or inside the table
    let email = tableInfo['submissionEmail']; // Try table first
    if (!email) {
      // Try the footer area
      const footerEmail = clean($('div.row:contains("Submission Email") p').first().text());
      if (footerEmail && footerEmail.includes('@')) {
        email = footerEmail;
      }
    }
    // Fallback: Regex search in guidelines
    if (!email) {
      const guidelines = getSectionContent('Submission Guidelines') || '';
      const match = guidelines.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
      if (match) email = match[0];
    }

    // 6. Construct Final Object
    const jobData = {
      title: title,
      company: tableInfo['organization'] || clean($('.text-muted.hidden-xs').first().text()),
      location: tableInfo['jobLocation'] || tableInfo['city'],
      closeDate: tableInfo['closeDate'],
      postedDate: clean($('.job-posted-modern').text()), // Assuming this exists from previous structure
      vacancyNumber: tableInfo['vacancyNumber'],
      
      // Meta details
      details: {
        salary: tableInfo['salary'],
        contractDuration: tableInfo['contractDuration'],
        gender: tableInfo['gender'],
        education: tableInfo['education'],
        experience: tableInfo['yearsOfExperience'],
        category: tableInfo['category'],
        employmentType: tableInfo['employmentType'],
        nationality: tableInfo['nationality'],
        noOfJobs: tableInfo['no.OfJobs']
      },

      // Long text content
      aboutCompany: getSectionContent('About'),
      description: getSectionContent('Job Descriptions'),
      requirements: getSectionContent('Job Requirements'),
      submissionGuideline: getSectionContent('Submission Guidelines'),
      
      submissionEmail: email,
      url: url
    };

    return jobData;

  } catch (error) {
    console.error(`Error parsing ${url}:`, error);
    return null;
  }
}

async function loadWazifahaData() {
  let items = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const url = "https://wazifaha.org?page=" + page;
      console.log(`Fetching: ${url}`);
      
      const html = await fetch(url).then((res) => res.text());
      const $ = cheerio.load(html);

      const total = Number($('h2').text().split(' ')[0])

      if(items.length >= total) break;

      // Select all job cards on the current page
      const cardElements = $('.job-card');

      console.log(cardElements.length)
      // 1. TERMINATION CHECK: If no cards are found, stop the loop
      if (cardElements.length === 0) {
        console.log("No more cards found. Stopping.");
        hasMore = false;
        break;
      }

      // 2. ITERATE: Loop through each card found
      cardElements.each((index, element) => {
        // Wrap the current element in Cheerio to scope selectors to THIS card only
        const card = $(element);

        // Helper to clean up whitespace
        const cleanText = (text) => text ? text.replace(/\s\s+/g, ' ').trim() : '';

        const jobData = {
            title: cleanText(card.find('.job-title.hidden-xs').contents().filter((_, el) => el.type === 'text').text()),
            company: cleanText(card.find('.text-muted.hidden-xs').text()),
            location: cleanText(card.find('span[data-original-title="Location"]').text()),
            postedTime: cleanText(card.find('.job-posted-modern').text()),
            expirationDate: cleanText(card.find('.text-danger').text()),
            link: card.find('.job-box').attr('data-href'),
            badge: cleanText(card.find('.new-badge').text())
        };

        // now fetch the page with wazifaha.org/ + link and extract more data for each item.
        

        items.push(jobData);
      });

      console.log(`Page ${page} processed. Total items: ${items.length}`);
      page += 1;

      // Optional safe-break to prevent infinite loops during testing
      if (page > 20) break; 

    } catch (error) {
      console.error("Error fetching page:", error);
      break;
    }
  }

  console.log("Final Result:", items);
  return items;
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
      structuredJob.url = 'https://jobs.af/jobs/' + newItem.slug
      content.summarized = structuredJob;

      writeFileSync(
        "./data/jobs/" + newItem.slug + ".json",
        JSON.stringify(content, null, 4)
      );
      // notify
      const subs = getSubscribers();

      const job = structuredJob;
      const message = toTelegramMessage(job);
      await sendTelegramMessage(TELEGRAM_CHANNEL_ID, message)

      // for (let user of subs) {
      //   if (!user.wantsDaily) continue; // skip users who opted out
      //   if (!user.fields || !user.locations || !user.gender) continue; // skip incomplete prefs

      //   // const userFields = user.fields.map((f) => f.toLowerCase());
      //   // const jobFields = [
      //   //   ...jobData.educationFields.map((f) => f.toLowerCase()),
      //   //   ...jobData.skillsRequired.map((f) => f.toLowerCase()),
      //   // ];
      //   // const jobSummary = jobData.summary.toLowerCase(); // assuming jobData.summary exists

      //   // const fieldMatch =
      //   //   jobFields.some((f) => userFields.includes(f)) ||
      //   //   userFields.some((uf) => jobSummary.includes(uf));
      //   const locationMatch =
      //     job.locations === "any" ||
      //     job.locations.some((l) => user.locations.includes(l));
      //   const genderMatch = job.gender === "any" || job.gender === user.gender;

      //   if (locationMatch && genderMatch) {
      //     user.sentJobs = user.sentJobs || [];
      //     if (!user.sentJobs.includes(job.slug)) {
      //       const message = toTelegramMessage(job);
      //       await sendTelegramMessage(user.chatId, message);
      //       user.sentJobs.push(job.slug);
      //     }
      //   }
      // }

      // saveSubscribers(subs);
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
    o.skillsRequired.map((s) => `- #${s.replace(/_/g, '_')}`).join("\n"),
    ``,
    `*Optional Skills:*`,
    o.skillsOptional.map((s) => `- #${s.replace(/_/g, '_')}`).join("\n"),
    `*Link:* ` + o.url
  ].join("\n");
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  console.log("send telegram message", chatId, text);
  console.log(TELEGRAM_API);

  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: +chatId,
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

// app.post("/telegram", async (req, res) => {
//   const update = req.body;
//   console.log("new update from telegram: ", update);
//   // if (!update.message) return res.json({ ok: true });

//   const isCallback = !!update.callback_query;
//   const isMessage = !!update.message;

//   console.log({ isCallback, isMessage });
//   if (!isCallback && !isMessage) return res.json({ ok: true });

//   if (isCallback) {
//     const data = update.callback_query.data;
//     const chatId = update.callback_query.message.chat.id;
//     const msgId = update.callback_query.message.message_id;

//     console.log("is callback: ", { data, chatId, msgId });
//     let subs = getSubscribers();
//     let user = subs.find((x) => x.chatId === chatId);

//     console.log("user: ", user);

//     if (data === "start_yes") {
//       if (!user) {
//         user = { chatId, wantsDaily: true, awaitingPreferences: true };
//         subs.push(user);
//       } else {
//         user.wantsDaily = true;
//         user.awaitingPreferences = true;
//       }
//       saveSubscribers(subs);
//       await editTelegramMessage(
//         chatId,
//         msgId,
//         "Great. Please describe what type of jobs you are interested in, your preferred locations, and your gender."
//       );
//     }

//     if (data === "start_no") {
//       if (!user) {
//         user = { chatId, wantsDaily: false, awaitingPreferences: false };
//         subs.push(user);
//       } else {
//         user.wantsDaily = false;
//         user.awaitingPreferences = false;
//       }
//       saveSubscribers(subs);
//       await editTelegramMessage(
//         chatId,
//         msgId,
//         "You will not receive daily notifications."
//       );
//     }

//     return res.json({ ok: true });
//   }

//   if (isMessage) {
//     const chatId = update.message.chat.id;
//     const text = (update.message.text || "").trim();

//     console.log("is message: ", { chatId, text });

//     let subs = getSubscribers();
//     let user = subs.find((x) => x.chatId === chatId);

//     console.log({ user, subs });

//     if (text === "/start") {
//       if (!user) {
//         user = { chatId, wantsDaily: null, awaitingPreferences: false };
//         subs.push(user);
//         saveSubscribers(subs);
//       }

//       await sendTelegramMessage(
//         chatId,
//         "Do you want to receive daily matching job notifications?",
//         {
//           inline_keyboard: [
//             [
//               { text: "Yes", callback_data: "start_yes" },
//               { text: "No", callback_data: "start_no" },
//             ],
//           ],
//         }
//       );
//       return res.json({ ok: true });
//     } else if (text === "/suggest") {
//       if (!user || !user.fields || !user.locations || !user.gender) {
//         await sendTelegramMessage(
//           chatId,
//           "Please set your preferences first using /start."
//         );
//         return res.json({ ok: true });
//       }

//       const allJobs = JSON.parse(readFileSync("./data/jobs.json", "utf-8"));
//       const matchingJobs = [];

//       for (let jobItem of allJobs) {
//         const jobData = JSON.parse(
//           readFileSync(`./data/jobs/${jobItem.slug}.json`, "utf-8")
//         ).summarized;

//         // const userFields = user.fields.map((f) => f.toLowerCase());
//         // const jobFields = [
//         //   ...jobData.educationFields.map((f) => f.toLowerCase()),
//         //   ...jobData.skillsRequired.map((f) => f.toLowerCase()),
//         // ];
//         // const jobSummary = jobData.summary.toLowerCase(); // assuming jobData.summary exists

//         // const fieldMatch =
//         //   jobFields.some((f) => userFields.includes(f)) ||
//         //   userFields.some((uf) => jobSummary.includes(uf));
//         const locationMatch =
//           jobData.locations === "any" ||
//           jobData.locations.some((l) => user.locations.includes(l));
//         const genderMatch =
//           jobData.gender === "any" || jobData.gender === user.gender;

//         if (locationMatch && genderMatch) {
//           matchingJobs.push(jobData);
//         }
//       }

//       matchingJobs.sort((a, b) => b.remainingDays - a.remainingDays); // optional sorting

//       const top5 = matchingJobs.slice(0, 5);

//       for (let job of top5) {
//         user.sentJobs = user.sentJobs || [];
//         if (!user.sentJobs.includes(job.slug)) {
//           const message = toTelegramMessage(job);
//           await sendTelegramMessage(chatId, message);
//           user.sentJobs.push(job.slug);
//         }
//       }
//     }

//     if (user && user.awaitingPreferences) {
//       const sys = `Extract user job preferences. Return JSON only:
// {
//  fields: string[],
//  locations: string[],
//  gender: 'male' | 'female'
// }`;
//       const ai = await openai.chat.completions.create({
//         model: "openai/gpt-4o-mini",
//         response_format: { type: "json_object" },
//         messages: [
//           { role: "system", content: sys },
//           { role: "user", content: text },
//         ],
//       });
//       const raw = ai.choices[0].message.content;
//       const cleaned = raw.replace("```json", "").replace("```", "");
//       const prefs = JSON.parse(cleaned);

//       user.fields = prefs.fields;
//       user.locations = prefs.locations;
//       user.gender = prefs.gender;
//       user.awaitingPreferences = false;
//       saveSubscribers(subs);

//       await sendTelegramMessage(chatId, "Your preferences are saved.");
//       return res.json({ ok: true });
//     }

//     return res.json({ ok: true });
//   }
// });

function run() {
  checkSiteData();
  checkWazifahaData();
  setInterval(() => {
    checkSiteData();
  }, 1 * 1000 * 60 * 60); // every hour
}

run();
app.listen(3000, () => console.log("App started on localhost:" + 3000));

async function checkWazifahaData() {
 
  console.log("Checking Wazifaha data...");

  // 1. Ensure directories and files exist
  if (!existsSync("./data/wazifaha")) {
    mkdirSync("./data/wazifaha");
  }

  if (!existsSync("./data/wazifaha.json")) {
    writeFileSync("./data/wazifaha.json", "[]");
  }

  const prevItems = JSON.parse(readFileSync("./data/wazifaha.json", "utf-8"));
  const prevLinks = new Set(prevItems.map((x) => x.link));

  // 3. Fetch fresh data from the site
  // Note: loadWazifahaData() as defined previously fetches details internally
  const scrapedItems = await loadWazifahaData();

  // 4. Filter new items
  const newItems = [];
  for (let item of scrapedItems) {
    if (!prevLinks.has(item.link)) {
      newItems.push(item);
    }
  }

  console.log(`Found ${newItems.length} new Wazifaha jobs.`);

  if (newItems.length === 0) return;

  // 5. Save the updated list to wazifaha.json
  writeFileSync(
    "./data/wazifaha.json",
    JSON.stringify([...prevItems, ...newItems], null, 2)
  );

  // 6. Process each new item (AI Structure + Notification)
  for (let item of newItems) {
    try {
      // Generate a unique slug from the URL (e.g., /jobs/25664/marketing-officer -> 25664-marketing-officer)
      // Fallback to a timestamp if parsing fails
      const urlParts = item.link.split("/").filter(Boolean);
      const slugId = urlParts.length >= 2 ? urlParts[1] : Date.now().toString();
      const slugTitle = urlParts.length >= 3 ? urlParts[2] : "job";
      const slug = `${slugId}-${slugTitle}`;

      // Prepare data for AI
      // We merge top-level info with details to give the AI full context
      const aiContext = {
        title: item.title,
        company: item.company,
        location: item.location,
        posted: item.postedTime,
        expiration: item.expirationDate,
        ...item.details, // Spread description, requirements, salary, etc.
      };

      const url = `https://wazifaha.org${item.link}`;

      const details = await getWazifahaJobDetails(url)

      aiContext.details = details


      console.log(`Structuring data for: ${slug}`);
      const structuredJob = await getStructuredJobData(aiContext);
      structuredJob.url = url
      

      // Save the full detailed object to a separate file
      const fullRecord = {
        ...item,
        slug: slug,
        summarized: structuredJob,
      };

      writeFileSync(
        `./data/wazifaha/${slug}.json`,
        JSON.stringify(fullRecord, null, 2)
      );

      // Send Telegram Notification
      const message = toTelegramMessage(structuredJob);
      await sendTelegramMessage(TELEGRAM_CHANNEL_ID, message);
      
      // Optional: Add a small delay to avoid hitting rate limits (Telegram/OpenAI)
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (err) {
      console.error(`Error processing Wazifaha item ${item.link}:`, err);
    }
  }
}


// await checkWazifahaData()