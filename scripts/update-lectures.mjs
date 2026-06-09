import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const SOURCE_BASE = "https://gr.uestc.edu.cn";
const LIST_PATH = "/jiaoxue/145";
const OUTPUT_FILE = new URL("../index.html", import.meta.url);
const SUMMARY_CACHE_FILE = new URL("../data/summary-cache.json", import.meta.url);
const TERM_START = "2026-06-01";
const UPDATE_CUTOFF = "2026-07-12";
const MAX_LIST_PAGES = 8;
const SUMMARY_LIMIT = 180;
const AI_SUMMARY_LIMIT = 180;
const AI_SUMMARY_MODEL = process.env.AI_SUMMARY_MODEL || "@cf/meta/llama-3.1-8b-instruct";
const DRY_RUN = process.argv.includes("--dry-run");
const USER_AGENT = "Mozilla/5.0 lecture-updater (+https://xueshujiangzuo.jasonmumiao.online/)";
const execFileAsync = promisify(execFile);
let preferCurlFetch = process.env.FORCE_CURL_FETCH === "1";

const STAMP_FORM_URL = "https://gr.uestc.edu.cn/attached/papers/116/201905/20190528151913_57363.doc";
const INTERNATIONAL_STAMP_FORM_URL = "https://gr.uestc.edu.cn/attached/papers/116/201905/20190528151919_85988.docx";

const STOP_LABELS = [
  "讲座时间", "报告时间", "活动时间", "时间", "讲座地点", "报告地点", "活动地点", "地点",
  "特邀专家", "主讲人", "报告人", "主讲嘉宾",
  "讲座主题", "报告题目", "题目", "讲座内容简介", "讲座内容", "报告内容", "内容简介", "报告摘要", "课程简介", "讲座简介",
  "主讲人简介", "专家简介", "报告人简介", "嘉宾简介", "个人简介",
  "讲座QQ群", "QQ群", "讲座 QQ 群", "QQ 群", "联系人", "联系方式", "欢迎", "附件",
  "上一篇", "下一篇", "友情链接"
];

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const PERIOD_LABELS = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上"
};

let aiDisabledReason = "";

function nowShanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function todayShanghaiDate() {
  return nowShanghaiDate();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeEntities(value = "") {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&ldquo;", "“")
    .replaceAll("&rdquo;", "”")
    .replaceAll("&mdash;", "—")
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizeText(value = "") {
  return decodeEntities(value)
    .replace(/\u3000/g, " ")
    .replace(/[ \t\r\f]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(html = "") {
  return normalizeText(html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h\d|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, ""));
}

async function fetchText(url, attempt = 1) {
  if (preferCurlFetch) return fetchTextWithCurl(url);

  const maxAttempts = 5;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT
      }
    });
  } catch (error) {
    if (process.env.CI) {
      preferCurlFetch = true;
      console.warn(`Native fetch failed for ${url}: ${error.message}; switching CI run to curl fallback.`);
      return fetchTextWithCurl(url);
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
      return fetchText(url, attempt + 1);
    }
    console.warn(`Native fetch failed for ${url}: ${error.message}; trying curl fallback.`);
    return fetchTextWithCurl(url);
  }

  if (!response) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
    return fetchText(url, attempt + 1);
  }

  if (!response.ok) {
    if (process.env.CI) {
      preferCurlFetch = true;
      console.warn(`Native fetch returned ${response.status} for ${url}; switching CI run to curl fallback.`);
      return fetchTextWithCurl(url);
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
      return fetchText(url, attempt + 1);
    }
    console.warn(`Native fetch returned ${response.status} for ${url}; trying curl fallback.`);
    return fetchTextWithCurl(url);
  }

  return response.text();
}

async function fetchTextWithCurl(url) {
  const { stdout } = await execFileAsync("curl", [
    "-fsSL",
    "--retry", "3",
    "--retry-delay", "2",
    "--connect-timeout", "15",
    "--max-time", "60",
    "-A", USER_AGENT,
    url
  ], {
    maxBuffer: 6 * 1024 * 1024
  });
  return stdout;
}

function parseChineseDate(value) {
  const normalized = normalizeText(value).replace(/\s+/g, " ");
  const match = normalized.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parseListItems(html) {
  const items = [];
  const linkRegex = /<a[^>]+href=["']([^"']*\/jiaoxue\/145\/\d+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]{0,360}?((?:20\d{2})年\d{2}月\d{2}日)/g;
  for (const match of html.matchAll(linkRegex)) {
    const title = stripHtml(match[2]);
    const published = parseChineseDate(match[3]);
    if (!title.includes("交流月") || !title.includes("讲座通知")) continue;
    items.push({
      href: match[1].startsWith("http") ? match[1] : `${SOURCE_BASE}${match[1]}`,
      title,
      published
    });
  }

  return Array.from(new Map(items.map((item) => [item.href, item])).values());
}

async function collectListItems() {
  const collected = [];
  let oldPageCount = 0;
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const html = await fetchText(`${SOURCE_BASE}${LIST_PATH}?page=${page}`);
    const items = parseListItems(html);
    if (!items.length) break;
    collected.push(...items);

    const hasRecent = items.some((item) => item.published >= TERM_START);
    oldPageCount = hasRecent ? 0 : oldPageCount + 1;
    if (oldPageCount >= 2) break;
  }

  return Array.from(new Map(collected.map((item) => [item.href, item])).values());
}

function extractBlock(text, labels, stops = STOP_LABELS) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const startMatch = new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[:：]?\\s*`, "i").exec(text);
  if (!startMatch) return "";

  const start = startMatch.index + startMatch[0].length;
  const rest = text.slice(start);
  const stopPattern = stops
    .filter((label) => !labels.includes(label))
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const stopMatch = new RegExp(`\\n\\s*(?:${stopPattern})\\s*[:：]?\\s*`, "i").exec(rest);
  const block = stopMatch ? rest.slice(0, stopMatch.index) : rest;
  return normalizeText(block);
}

function cleanValue(value = "") {
  return normalizeText(value)
    .replace(/^(：|:)/, "")
    .replace(/^(报告题目|讲座主题|题目)\s*[:：]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, limit = SUMMARY_LIMIT) {
  const text = cleanValue(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/[，。；、：:\s]+$/, "")}...`;
}

function hashText(value = "") {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function readJsonFile(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(url, data) {
  await mkdir(new URL(".", url), { recursive: true });
  await writeFile(url, `${JSON.stringify(data, null, 2)}\n`);
}

function normalizeAiSummary(value = "") {
  const text = cleanValue(value)
    .replace(/^简介\s*[:：]\s*/, "")
    .replace(/^讲座简介\s*[:：]\s*/, "")
    .replace(/^总结\s*[:：]\s*/, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= AI_SUMMARY_LIMIT) return text;
  const sliced = text.slice(0, AI_SUMMARY_LIMIT);
  const punctuation = Math.max(
    sliced.lastIndexOf("。"),
    sliced.lastIndexOf("；"),
    sliced.lastIndexOf("！"),
    sliced.lastIndexOf("？")
  );
  if (punctuation >= 80) return sliced.slice(0, punctuation + 1);
  return sliced.replace(/[，。；、：:\s]+$/, "");
}

function aiCanRun() {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID && !aiDisabledReason);
}

async function summarizeWithCloudflareAi(event, sourceText) {
  if (!aiCanRun()) return "";

  const prompt = [
    "请把下面的学术讲座资料改写成一段中文简介。",
    "要求：约150字，不超过180字；只写一段话；准确说明讲座主题、主要内容和听众能了解什么；不要编造源材料没有的信息；不要列表；不要省略号。",
    "",
    `讲座标题：${event.title}`,
    `主讲人：${event.speaker}`,
    `原始资料：${sourceText}`
  ].join("\n");

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${AI_SUMMARY_MODEL}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: "你是谨慎的中文学术活动简介编辑，只根据输入材料进行概括。"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 260,
      temperature: 0.2
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.map((error) => error.message).join("; ") || `${response.status} ${response.statusText}`;
    if (response.status === 401 || response.status === 403) {
      aiDisabledReason = `Cloudflare Workers AI 权限不可用：${message}`;
      console.warn(`${aiDisabledReason}；本次后续讲座改用缓存或截断简介。`);
      return "";
    }
    console.warn(`AI summary failed for ${event.sourceUrl}: ${message}`);
    return "";
  }

  const result = payload.result || {};
  const text = result.response || result.text || result.output_text || "";
  return normalizeAiSummary(text);
}

async function applySummaries(events) {
  const cache = await readJsonFile(SUMMARY_CACHE_FILE, {});
  let changed = false;

  for (const event of events) {
    const sourceText = cleanValue(event.summarySource || "");
    const fallback = truncate(sourceText || "源网页暂未识别到课程简介。");
    const hash = hashText(`${event.title}\n${sourceText}`);
    const cached = cache[event.sourceUrl];

    if (cached?.hash === hash && cached.summary) {
      event.summary = cached.summary;
      continue;
    }

    const aiSummary = sourceText ? await summarizeWithCloudflareAi(event, sourceText) : "";
    event.summary = aiSummary || fallback;

    if (aiSummary) {
      cache[event.sourceUrl] = {
        hash,
        summary: aiSummary,
        model: AI_SUMMARY_MODEL,
        generatedAt: new Date().toISOString()
      };
      changed = true;
    }
  }

  if (changed) {
    await writeJsonFile(SUMMARY_CACHE_FILE, cache);
  }
}

function parseDateAndTime(value, item) {
  const notes = [];
  const normalized = normalizeText(value).replace(/\s+/g, " ").replace(/：/g, ":");
  const fullDateMatch = normalized.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?|(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const shortDateMatch = fullDateMatch ? null : normalized.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (!fullDateMatch && !shortDateMatch) return { notes: ["时间未能自动识别"] };

  let year = fullDateMatch
    ? Number(fullDateMatch[1] || fullDateMatch[4])
    : Number(item.published?.slice(0, 4) || TERM_START.slice(0, 4));
  const month = fullDateMatch ? Number(fullDateMatch[2] || fullDateMatch[5]) : Number(shortDateMatch[1]);
  const day = fullDateMatch ? Number(fullDateMatch[3] || fullDateMatch[6]) : Number(shortDateMatch[2]);

  if (item.published?.startsWith("2026-") && year !== 2026 && item.title.includes("第11届")) {
    notes.push(`源站原文为 ${year} 年 ${month} 月 ${day} 日；本表按 2026 年修正。`);
    year = 2026;
  }

  const timeMatch = normalized.match(/(?:(上午|下午|晚上|晚间|夜间|中午|凌晨|早上)\s*)?(\d{1,2})\s*(?::\s*(\d{1,2})|点\s*(\d{1,2})?\s*分?)\s*(?:-|~|—|–|至|到)?\s*(?:(上午|下午|晚上|晚间|夜间|中午|凌晨|早上)\s*)?(\d{1,2})?\s*(?::\s*(\d{1,2})|点\s*(\d{1,2})?\s*分?)?/);
  if (!timeMatch) return { notes: [...notes, "开始时间未能自动识别"] };

  const adjustHour = (hour, period) => {
    if (/下午|晚上|晚间|夜间|中午/.test(period) && hour < 12) return hour + 12;
    if (/凌晨/.test(period) && hour === 12) return 0;
    return hour;
  };
  const startPeriod = timeMatch[1] || "";
  const startHour = adjustHour(Number(timeMatch[2]), startPeriod);
  const startMinute = Number(timeMatch[3] || timeMatch[4] || 0);
  const endPeriod = timeMatch[5] || startPeriod;
  const endHour = timeMatch[6] ? adjustHour(Number(timeMatch[6]), endPeriod) : null;
  const endMinute = timeMatch[6] ? Number(timeMatch[7] || timeMatch[8] || 0) : 0;

  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour !== null
    ? endHour * 60 + endMinute
    : startMinutes;
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const startTime = `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`;
  const endTime = endHour !== null ? `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}` : "";

  return { date, startMinutes, endMinutes, startTime, endTime, notes };
}

function periodFromMinutes(minutes) {
  if (minutes < 12 * 60) return "morning";
  if (minutes < 18 * 60) return "afternoon";
  return "evening";
}

function titleParts(title) {
  const cleanTitleText = cleanValue(title);
  const afterBracket = cleanTitleText.replace(/^【[^】]+】/, "");
  const chineseSplit = afterBracket.indexOf("：");
  const englishSplit = afterBracket.indexOf(":");
  const splitIndex = chineseSplit >= 0 && englishSplit >= 0
    ? Math.min(chineseSplit, englishSplit)
    : Math.max(chineseSplit, englishSplit);
  const series = splitIndex >= 0 ? afterBracket.slice(0, splitIndex).trim() : "";
  const topic = splitIndex >= 0 ? afterBracket.slice(splitIndex + 1).trim() : afterBracket;
  const schoolMatch = series.match(/^(.+?学院|.+?研究院|.+?中心|.+?部)/);
  const school = schoolMatch ? schoolMatch[1] : (series || "研究生院");
  return { school, series, topic };
}

function inferFormat(location) {
  return /线上|QQ|腾讯会议|会议号|直播|群课堂/i.test(location) ? "online" : "offline";
}

function durationText(event) {
  if (!event.endTime) return "结束时间未注明";
  const diff = event.endMinutes - event.startMinutes;
  if (diff > 0) return `约 ${diff} 分钟`;
  return "结束时间未注明";
}

function clockText(event) {
  return event.endTime ? `${event.startTime}-${event.endTime}` : event.startTime;
}

async function parseDetail(item) {
  const html = await fetchText(item.href);
  const text = stripHtml(html);
  const { school, series, topic } = titleParts(item.title);
  const timeBlock = extractBlock(text, ["讲座时间", "报告时间", "活动时间", "时间"]);
  const location = cleanValue(extractBlock(text, ["讲座地点", "报告地点", "活动地点", "地点", "形式", "讲座形式"])) || "待确认";
  const speaker = cleanValue(extractBlock(text, ["特邀专家", "主讲人", "报告人", "主讲嘉宾"])) || "待确认";
  const summarySource =
    extractBlock(text, ["讲座内容简介", "讲座内容", "报告内容", "内容简介", "报告摘要", "课程简介", "讲座简介"]) ||
    extractBlock(text, ["讲座主题", "报告题目", "题目"]);
  const parsedTime = parseDateAndTime(timeBlock, item);

  const event = {
    sourceUrl: item.href,
    published: item.published,
    originalTitle: item.title,
    school,
    series: series || "学术交流月讲座",
    title: topic || item.title,
    speaker,
    location,
    format: inferFormat(location),
    summarySource: summarySource || "源网页暂未识别到课程简介。",
    summary: truncate(summarySource || "源网页暂未识别到课程简介。"),
    notes: parsedTime.notes || []
  };

  if (parsedTime.date) {
    Object.assign(event, {
      date: parsedTime.date,
      startMinutes: parsedTime.startMinutes,
      endMinutes: parsedTime.endMinutes,
      startTime: parsedTime.startTime,
      endTime: parsedTime.endTime,
      period: periodFromMinutes(parsedTime.startMinutes)
    });
  }

  return event;
}

function dateLabel(date) {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${month} 月 ${day} 日 · ${WEEKDAYS[weekday]}`;
}

function dateSpan(events) {
  const dates = events.map((event) => event.date).sort();
  if (!dates.length) return "暂无";
  const first = dates[0];
  const last = dates.at(-1);
  return `${Number(first.slice(5, 7))}/${Number(first.slice(8, 10))}-${Number(last.slice(5, 7))}/${Number(last.slice(8, 10))}`;
}

function daySummary(events) {
  const counts = events.reduce((acc, event) => {
    acc[event.period] = (acc[event.period] || 0) + 1;
    return acc;
  }, {});
  return ["morning", "afternoon", "evening"]
    .filter((period) => counts[period])
    .map((period) => `${PERIOD_LABELS[period]} ${counts[period]} 场`)
    .join(" · ");
}

function groupByDate(events) {
  const map = new Map();
  for (const event of events) {
    if (!map.has(event.date)) map.set(event.date, []);
    map.get(event.date).push(event);
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
}

function renderEvent(event) {
  const isOnline = event.format === "online";
  const formatText = isOnline ? "线上" : "线下";
  const locationLabel = isOnline ? "形式" : "地点";
  const noteHtml = event.notes.length
    ? `\n            ${event.notes.map((note) => `<p class="correction">${escapeHtml(note)}</p>`).join("\n            ")}`
    : "";
  return `        <article class="event" data-format="${event.format}" data-period="${event.period}" data-date="${event.date}" data-start="${event.startMinutes}" data-end="${event.endMinutes}">
          <div class="time-cell">
            <span class="period">${PERIOD_LABELS[event.period]}</span>
            <strong class="clock">${escapeHtml(clockText(event))}</strong>
            <div class="duration">${escapeHtml(durationText(event))}</div>
          </div>
          <div class="content-cell">
            <div class="title-row">
              <span class="school">${escapeHtml(event.school)}</span>
              <span class="format${isOnline ? " online" : ""}">${formatText}</span>
            </div>
            <h3>${escapeHtml(event.title)}</h3>
            <p class="speaker">${escapeHtml(event.speaker)}</p>
            <p class="summary">${escapeHtml(event.summary)}</p>
          </div>
          <aside class="meta-cell">
            <p class="meta-line"><strong>${locationLabel}</strong>${escapeHtml(event.location)}</p>
            <p class="meta-line"><strong>系列</strong>${escapeHtml(event.series)}</p>
            <a class="source-link" href="${escapeHtml(event.sourceUrl)}" target="_blank" rel="noopener">查看源网页</a>${noteHtml}
          </aside>
        </article>`;
}

function renderDays(events) {
  return groupByDate(events).map(([date, dayEvents]) => `    <section class="day" data-day-section>
      <div class="day-heading">
        <h2>${dateLabel(date)}</h2>
        <span>${daySummary(dayEvents)}</span>
      </div>
      <div class="event-list">
${dayEvents.map(renderEvent).join("\n\n")}
      </div>
    </section>`).join("\n\n");
}

function extractTagContent(html, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  if (!match) throw new Error(`Cannot find <${tag}> in existing index.html`);
  return match[1];
}

function renderHtml(events, existingHtml) {
  const style = extractTagContent(existingHtml, "style");
  const script = extractTagContent(existingHtml, "script");
  const arrangedDate = todayShanghaiDate();
  const offlineCount = events.filter((event) => event.format === "offline").length;
  const onlineCount = events.filter((event) => event.format === "online").length;
  const notes = events.flatMap((event) => event.notes);
  const correctionNotice = notes.length
    ? `      <p class="notice">${escapeHtml(Array.from(new Set(notes)).join(" "))}</p>\n`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>电子科技大学 2026 年学术交流月讲座表</title>
  <meta name="description" content="电子科技大学研究生院 2026 年第 11 届学术交流月讲座时间、地点、主讲人与内容简介。">
  <link rel="canonical" href="https://xueshujiangzuo.jasonmumiao.online/">
  <style>${style}</style>
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <div class="kicker">第 11 届研究生学术交流月</div>
      <h1>电子科技大学 2026 年学术交流月讲座表</h1>
      <p class="lead">自动整理研究生院已发布的学术交流月讲座通知，突出日期、时段、地点/线上入口和内容简介，适合手机与桌面快速浏览。</p>
      <div class="source-row" aria-label="数据来源">
        <span>数据源：<a href="https://gr.uestc.edu.cn/jiaoxue/145?page=1" target="_blank" rel="noopener">电子科技大学研究生院</a></span>
        <span>整理时间：${arrangedDate}</span>
      </div>
    </div>
  </header>

  <section class="wrap stats" aria-label="讲座统计">
    <div class="stat"><strong>${events.length}</strong><span>场已识别学术交流月讲座</span></div>
    <div class="stat"><strong>${offlineCount}</strong><span>场线下讲座</span></div>
    <div class="stat"><strong>${onlineCount}</strong><span>场线上讲座</span></div>
    <div class="stat"><strong>${dateSpan(events)}</strong><span>讲座日期跨度</span></div>
  </section>

  <div class="controls-band">
    <div class="wrap controls">
      <div class="filters" role="group" aria-label="讲座筛选">
        <button class="filter-button" type="button" data-filter-group="format" data-filter-value="offline" aria-pressed="false">线下</button>
        <button class="filter-button" type="button" data-filter-group="format" data-filter-value="online" aria-pressed="false">线上</button>
        <button class="filter-button" type="button" data-filter-group="period" data-filter-value="morning" aria-pressed="false">上午</button>
        <button class="filter-button" type="button" data-filter-group="period" data-filter-value="afternoon" aria-pressed="false">下午</button>
        <button class="filter-button" type="button" data-filter-group="period" data-filter-value="evening" aria-pressed="false">晚上</button>
      </div>
      <div class="result-count" aria-live="polite"><span id="visible-count">${events.length}</span> / ${events.length} 场</div>
      <div class="range-controls" aria-label="日期和时间筛选">
        <label class="field" for="date-start"><span>开始日期</span><input id="date-start" type="date" min="${TERM_START}" max="${UPDATE_CUTOFF}"></label>
        <label class="field" for="date-end"><span>结束日期</span><input id="date-end" type="date" min="${TERM_START}" max="${UPDATE_CUTOFF}"></label>
        <label class="field" for="time-start"><span>开始时间</span><input id="time-start" type="time" step="900"></label>
        <label class="field" for="time-end"><span>结束时间</span><input id="time-end" type="time" step="900"></label>
        <button class="clear-button" type="button" id="clear-filters">清空筛选</button>
      </div>
    </div>
  </div>

  <main class="wrap">
    <div class="notice-stack">
      <p class="notice good">线下讲座直接按表中地点前往即可，不需要走报名流程；建议提前到场，现场听从学院或工作人员安排。</p>
      <p class="notice info">请带上《电子科技大学研究生学术活动登记表》用于现场盖章/登记。官方下载：<a href="${STAMP_FORM_URL}" target="_blank" rel="noopener">研究生学术活动登记表</a>；留学生版本：<a href="${INTERNATIONAL_STAMP_FORM_URL}" target="_blank" rel="noopener">研究生学术活动登记表（留学生）</a>。</p>
${correctionNotice}    </div>

${renderDays(events)}

    <div class="empty-state" id="empty-state">当前筛选没有匹配的讲座。</div>
  </main>

  <footer>
    <div class="wrap">
      本页为公开通知整理版，时间地点以源网页后续更新为准。源码：<a href="https://github.com/jasonmumiao/uestc-xueshujiangzuo" target="_blank" rel="noopener">GitHub</a>。
    </div>
  </footer>

  <script>${script}</script>
</body>
</html>
`;
}

async function main() {
  if (todayShanghaiDate() > UPDATE_CUTOFF) {
    console.log(`Update cutoff ${UPDATE_CUTOFF} has passed; no changes made.`);
    return;
  }

  const existingHtml = await readFile(OUTPUT_FILE, "utf8");
  let listItems = [];
  try {
    listItems = await collectListItems();
  } catch (error) {
    console.warn(`Source list is temporarily unavailable; keeping existing page. ${error.message}`);
    if (process.env.CI) throw error;
    return;
  }
  const detailEvents = [];

  for (const item of listItems) {
    let event;
    try {
      event = await parseDetail(item);
    } catch (error) {
      console.warn(`Skipped detail page after fetch/parse failure: ${item.href} ${error.message}`);
      continue;
    }
    if (!event.date) {
      console.warn(`Skipped unresolved event time: ${item.title} ${item.href}`);
      continue;
    }
    if (event.date < TERM_START || event.date > UPDATE_CUTOFF) continue;
    detailEvents.push(event);
  }

  const events = Array.from(new Map(detailEvents.map((event) => [event.sourceUrl, event])).values())
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes || a.title.localeCompare(b.title, "zh-CN"));

  if (!events.length) {
    console.warn("No lecture events were parsed; keeping existing page.");
    return;
  }

  if (DRY_RUN) {
    console.log(`Dry run parsed ${events.length} lecture events; no files were written.`);
    return;
  }

  await applySummaries(events);
  await writeFile(OUTPUT_FILE, renderHtml(events, existingHtml));
  console.log(`Updated ${events.length} lecture events.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
