// backend/server.js - No Auth / Direct Access Version
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import "dotenv/config";
import multer from "multer";
import Tesseract from "tesseract.js";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const PORT = process.env.PORT || 3000;

// ========== RATE LIMITING ==========
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(
  [
    "/explain", "/scan-code", "/explain-line", "/convert",
    "/optimize", "/prompt-to-code", "/fill-code",
    "/convert-image", "/optimize-image", "/fill-image",
  ],
  aiLimiter
);

// ========== FILE SETUP ==========
const upload = multer({ dest: "uploads/" });
const HISTORY_FILE = path.join(__dirname, "user_history.json");

if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, "[]");
}

if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
}

// ========== OPENROUTER HELPERS ==========
function buildExplainMessages({ code, language = "unknown", mode = "explain" }) {
  const trimmedCode = String(code).slice(0, 8000);
  let modeInstruction = "";

  switch (mode) {
    case "debug":
      modeInstruction = `Find bugs, logical errors, and edge cases.\nExplain why they are problems and how to fix them.`;
      break;
    case "optimize":
      modeInstruction = `Improve performance and readability.\nSuggest a better version and explain improvements.`;
      break;
    case "comment":
      modeInstruction = `Add clean inline comments or docstrings.\nReturn mostly commented code.`;
      break;
    default:
      modeInstruction = `Explain code step-by-step in simple language.\nStart with a short summary.`;
  }

  return [
    { role: "system", content: "You are an expert programming tutor." },
    {
      role: "user",
      content: `Language: ${language}\nMode: ${mode}\n\n${modeInstruction}\n\nCode:\n\`\`\`${language}\n${trimmedCode}\n\`\`\`\n`,
    },
  ];
}

async function callOpenRouter(messages, opts = {}) {
  const body = {
    model: opts.model || "gpt-3.5-turbo",
    messages,
    max_tokens: opts.max_tokens || 900,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.3,
  };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Code Explainer Pro",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data?.choices?.[0]?.message?.content || "No explanation generated.";
}

// ========== API ROUTES (No Auth) ==========

app.post("/explain", async (req, res) => {
  const { code, language = "unknown", mode = "explain" } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: "Code is required" });

  try {
    const messages = buildExplainMessages({ code, language, mode });
    const explanation = await callOpenRouter(messages);

    // Save to generic history (no specific user email)
    const histories = JSON.parse(fs.readFileSync(HISTORY_FILE));
    histories.unshift({
      id: uuidv4(),
      email: "guest",
      language,
      mode: mode || "explain",
      code,
      explanation,
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(histories, null, 2));

    res.json({ explanation, mode: mode || "explain" });
  } catch (err) {
    console.error("❌ Explain Error:", err);
    res.status(500).json({ error: "Failed to generate explanation", details: err.message });
  }
});

app.post("/explain-line", async (req, res) => {
  try {
    const { code, lineNumber, language = "unknown" } = req.body;
    if (!code || !lineNumber) return res.status(400).json({ error: "Missing code or lineNumber" });

    const lines = String(code).split(/\r?\n/);
    const idx = Number(lineNumber) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= lines.length) {
      return res.status(400).json({ error: "Invalid lineNumber" });
    }

    const start = Math.max(0, idx - 2);
    const end = Math.min(lines.length, idx + 3);
    const contextSnippet = lines.slice(start, end).join("\n");

    const prompt = `You are an expert programming tutor. Explain line ${lineNumber} in plain English.\nAssume language is ${language}.\nContext:\n\`\`\`${language}\n${contextSnippet}\n\`\`\``;

    const messages = [{ role: "system", content: "You are an expert programming tutor." }, { role: "user", content: prompt }];
    const explanation = await callOpenRouter(messages);
    res.json({ explanation });
  } catch (err) {
    console.error("❌ explain-line error:", err);
    res.status(500).json({ error: "Failed to explain line", details: err.message });
  }
});

app.post("/convert", async (req, res) => {
  const { code, from = "unknown", to = "unknown" } = req.body;
  if (!code) return res.status(400).json({ error: "Code is required" });

  try {
    const prompt = `Convert the following code written in ${from} into ${to}.\nPreserve behavior and idiomatic style. Return only code.\nCode:\n\`\`\`${from}\n${code}\n\`\`\``;
    const messages = [{ role: "system", content: "You are a helpful code conversion assistant." }, { role: "user", content: prompt }];
    const converted = await callOpenRouter(messages);
    res.json({ result: converted });
  } catch (err) {
    console.error("❌ convert error:", err);
    res.status(500).json({ error: "Conversion failed", details: err.message });
  }
});

app.post("/optimize", async (req, res) => {
  const { code, language = "unknown" } = req.body;
  if (!code) return res.status(400).json({ error: "Code is required" });

  try {
    const messages = [
      { role: "system", content: "You are an expert developer who writes optimized code." },
      { role: "user", content: `Language: ${language}\nOptimize for performance/clarity. Explain changes briefly.\nCode:\n\`\`\`${language}\n${code}\n\`\`\`` },
    ];
    const optimized = await callOpenRouter(messages);
    res.json({ result: optimized });
  } catch (err) {
    console.error("❌ optimize error:", err);
    res.status(500).json({ error: "Optimization failed", details: err.message });
  }
});

app.post("/prompt-to-code", async (req, res) => {
  const { prompt, language = "Python" } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });

  try {
    const messages = [
      { role: "system", content: "You generate clear, runnable code from user prompts." },
      { role: "user", content: `Language: ${language}\nConvert this prompt into runnable code. Return only code.\nPrompt:\n${prompt}` },
    ];
    const code = await callOpenRouter(messages, { temperature: 0.2 });
    res.json({ result: code });
  } catch (err) {
    console.error("❌ prompt-to-code error:", err);
    res.status(500).json({ error: "Failed to generate code", details: err.message });
  }
});

app.post("/fill-code", async (req, res) => {
  const { code, language = "unknown" } = req.body;
  if (!code) return res.status(400).json({ error: "Code is required" });

  try {
    const messages = [
      { role: "system", content: "You complete partial code and fill TODOs." },
      { role: "user", content: `Language: ${language}\nFill the TODOs/placeholders.\nPartial code:\n\`\`\`${language}\n${code}\n\`\`\`` },
    ];
    const filled = await callOpenRouter(messages);
    res.json({ result: filled });
  } catch (err) {
    console.error("❌ fill-code error:", err);
    res.status(500).json({ error: "Failed to fill code", details: err.message });
  }
});

// ========== IMAGE HANDLERS ==========
async function ocrFileAndDelete(filePath) {
  const { data } = await Tesseract.recognize(filePath, "eng");
  fs.unlink(filePath, () => {});
  return data?.text || "";
}

app.post("/scan-code", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  try {
    const text = await ocrFileAndDelete(req.file.path);
    if (!text.trim()) return res.status(400).json({ error: "No readable code found" });
    const { language = "unknown" } = req.body;
    const messages = buildExplainMessages({ code: text, language, mode: "explain" });
    const explanation = await callOpenRouter(messages);
    res.json({ extractedCode: text.trim(), explanation });
  } catch (err) {
    console.error("❌ scan-code error:", err);
    res.status(500).json({ error: "Image processing failed", details: err.message });
  }
});

app.post("/convert-image", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  try {
    const text = await ocrFileAndDelete(req.file.path);
    if (!text.trim()) return res.status(400).json({ error: "No readable code found" });
    const { from = "unknown", to = "unknown" } = req.body;
    const prompt = `Convert this ${from} code to ${to}. Return only code.\nCode:\n\`\`\`${from}\n${text}\n\`\`\``;
    const messages = [{ role: "system", content: "You are a code conversion assistant." }, { role: "user", content: prompt }];
    const converted = await callOpenRouter(messages);
    res.json({ extractedCode: text.trim(), result: converted });
  } catch (err) {
    console.error("❌ convert-image error:", err);
    res.status(500).json({ error: "Convert image failed", details: err.message });
  }
});

app.post("/optimize-image", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  try {
    const text = await ocrFileAndDelete(req.file.path);
    if (!text.trim()) return res.status(400).json({ error: "No readable code found" });
    const { language = "unknown" } = req.body;
    const messages = [{ role: "system", content: "You are an expert developer." }, { role: "user", content: `Optimize this ${language} code:\n\`\`\`${language}\n${text}\n\`\`\`` }];
    const optimized = await callOpenRouter(messages);
    res.json({ extractedCode: text.trim(), result: optimized });
  } catch (err) {
    console.error("❌ optimize-image error:", err);
    res.status(500).json({ error: "Optimize image failed", details: err.message });
  }
});

app.post("/fill-image", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  try {
    const text = await ocrFileAndDelete(req.file.path);
    if (!text.trim()) return res.status(400).json({ error: "No readable code found" });
    const { language = "unknown" } = req.body;
    const messages = [{ role: "system", content: "You complete partial code." }, { role: "user", content: `Fill TODOs in this ${language} code:\n\`\`\`${language}\n${text}\n\`\`\`` }];
    const filled = await callOpenRouter(messages);
    res.json({ extractedCode: text.trim(), result: filled });
  } catch (err) {
    console.error("❌ fill-image error:", err);
    res.status(500).json({ error: "Fill image failed", details: err.message });
  }
});

// ========== HISTORY (Guest Only) ==========
app.get("/history", (req, res) => {
  const histories = JSON.parse(fs.readFileSync(HISTORY_FILE));
  res.json({ history: histories });
});

app.delete("/history", (req, res) => {
  fs.writeFileSync(HISTORY_FILE, "[]");
  res.json({ message: "History cleared successfully" });
});

// ========== FRONTEND SERVING ==========
const frontendPath = path.join(__dirname, '../frontend');

if (fs.existsSync(frontendPath)) {
  console.log("✅ Frontend directory found, serving static files");
  app.use(express.static(frontendPath));

  // Serve the MAIN APP at root
  app.get("/", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });

  // Catch-all redirect to index
  app.get("*", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });
} else {
  console.log("⚠️ Frontend directory not found, serving API only");
  app.get("/", (req, res) => res.json({ message: "Code Explainer Pro API is running (No Frontend)" }));
}

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});