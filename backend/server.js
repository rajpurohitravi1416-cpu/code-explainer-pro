// backend/server.js
console.log(
  "🔑 Loaded API Key:",
  process.env.OPENROUTER_API_KEY ? "✅ Found" : "❌ Missing"
);

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
import { registerUser, loginUser, verifyToken } from "./auth.js";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const __dirname = path.resolve();

// ========== RATE LIMITING ==========
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // adjust as needed
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply limiter to all AI endpoints
app.use(
  [
    "/explain",
    "/scan-code",
    "/explain-line",
    "/convert",
    "/optimize",
    "/prompt-to-code",
    "/fill-code",
    "/convert-image",
    "/optimize-image",
    "/fill-image",
  ],
  aiLimiter
);

// ========== FILE SETUP ==========
const upload = multer({ dest: "uploads/" });
const USERS_FILE = path.join(__dirname, "users.json");
const HISTORY_FILE = path.join(__dirname, "user_history.json");
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, "[]");

// ========== AUTH ROUTES ==========
app.post("/register", (req, res) => {
  const { email, password } = req.body;
  const result = registerUser(email, password);
  res.json(result);
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  const result = loginUser(email, password);
  res.json(result);
});

// ========== OPENROUTER HELPERS ==========
function buildExplainMessages({ code, language = "unknown", mode = "explain" }) {
  const trimmedCode = String(code).slice(0, 8000);

  let modeInstruction = "";

  switch (mode) {
    case "debug":
      modeInstruction = `
Find bugs, logical errors, and edge cases.
Explain why they are problems and how to fix them.`;
      break;

    case "optimize":
      modeInstruction = `
Improve performance and readability.
Suggest a better version and explain improvements.`;
      break;

    case "comment":
      modeInstruction = `
Add clean inline comments or docstrings.
Return mostly commented code.`;
      break;

    default:
      modeInstruction = `
Explain code step-by-step in simple language.
Start with a short summary.`;
  }

  return [
    { role: "system", content: "You are an expert programming tutor." },
    {
      role: "user",
      content: `
Language: ${language}
Mode: ${mode}

${modeInstruction}

Code:
\`\`\`${language}
${trimmedCode}
\`\`\`
`,
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

// ========== EXPLAIN ROUTE WITH MODES ==========
app.post("/explain", async (req, res) => {
  const { code, language = "unknown", mode = "explain" } = req.body;
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);

  if (!user) return res.status(403).json({ error: "Unauthorized" });
  if (!code?.trim()) return res.status(400).json({ error: "Code is required" });

  try {
    const messages = buildExplainMessages({ code, language, mode });
    const explanation = await callOpenRouter(messages);

    const histories = JSON.parse(fs.readFileSync(HISTORY_FILE));
    histories.unshift({
      id: uuidv4(),
      email: user.email,
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

// ========== EXPLAIN-LINE (single-line with small context) ==========
app.post("/explain-line", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    const user = verifyToken(token);
    if (!user) return res.status(403).json({ error: "Unauthorized" });

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

    const prompt = `
You are an expert programming tutor. Explain the following single line of code (line ${lineNumber}) in plain English.
- Provide a one-sentence summary of what the line does.
- Mention potential pitfalls or edge-cases.
- Suggest a short improved version if relevant.
Assume the language is ${language}.
Only use the code inside the "Context" for reference.

Context:
\`\`\`${language}
${contextSnippet}
\`\`\`
`;

    const messages = [
      { role: "system", content: "You are an expert programming tutor." },
      { role: "user", content: prompt },
    ];

    const explanation = await callOpenRouter(messages);
    res.json({ explanation });
  } catch (err) {
    console.error("❌ explain-line error:", err);
    res.status(500).json({ error: "Failed to explain line", details: err.message });
  }
});

// ========== CONVERTER (code -> code) ==========
app.post("/convert", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });

  const { code, from = "unknown", to = "unknown" } = req.body;
  if (!code) return res.status(400).json({ error: "Code is required" });

  try {
    const prompt = `
Convert the following code written in ${from} into ${to}.
Preserve behavior and idiomatic style for ${to}. Only return the converted code (no extra commentary).
Code:
\`\`\`${from}
${code}
\`\`\`
`;
    const messages = [
      { role: "system", content: "You are a helpful code conversion assistant." },
      { role: "user", content: prompt },
    ];
    const converted = await callOpenRouter(messages);
    res.json({ result: converted });
  } catch (err) {
    console.error("❌ convert error:", err);
    res.status(500).json({ error: "Conversion failed", details: err.message });
  }
});

// ========== OPTIMIZE ==========
app.post("/optimize", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });

  const { code, language = "unknown" } = req.body;
  if (!code) return res.status(400).json({ error: "Code is required" });

  try {
    const messages = [
      { role: "system", content: "You are an expert developer who writes optimized code." },
      {
        role: "user",
        content: `
Language: ${language}
Optimize the following code for performance and clarity. Explain the changes briefly and provide the improved code.

Code:
\`\`\`${language}
${code}
\`\`\`
`,
      },
    ];
    const optimized = await callOpenRouter(messages);
    res.json({ result: optimized });
  } catch (err) {
    console.error("❌ optimize error:", err);
    res.status(500).json({ error: "Optimization failed", details: err.message });
  }
});

// ========== PROMPT → CODE ==========
app.post("/prompt-to-code", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });

  const { prompt, language = "Python" } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });

  try {
    const messages = [
      { role: "system", content: "You generate clear, runnable code from user prompts." },
      {
        role: "user",
        content: `Language: ${language}\nConvert this prompt into runnable ${language} code. Be concise and return only code unless asked otherwise.\n\nPrompt:\n${prompt}`,
      },
    ];
    const code = await callOpenRouter(messages, { temperature: 0.2 });
    res.json({ result: code });
  } catch (err) {
    console.error("❌ prompt-to-code error:", err);
    res.status(500).json({ error: "Failed to generate code", details: err.message });
  }
});

// ========== FILL CODE ==========
app.post("/fill-code", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });

  const { code, language = "unknown" } = req.body;
  if (!code) return res.status(400).json({ error: "Code is required" });

  try {
    const messages = [
      { role: "system", content: "You complete partial code and fill TODOs while preserving style." },
      {
        role: "user",
        content: `
Language: ${language}
Fill the TODOs or placeholders in the following partial code. Provide the completed code and briefly explain any assumptions.

Partial code:
\`\`\`${language}
${code}
\`\`\`
`,
      },
    ];
    const filled = await callOpenRouter(messages);
    res.json({ result: filled });
  } catch (err) {
    console.error("❌ fill-code error:", err);
    res.status(500).json({ error: "Failed to fill code", details: err.message });
  }
});

// ========== IMAGE HANDLERS (OCR -> respective flow) ==========
async function ocrFileAndDelete(filePath) {
  const { data } = await Tesseract.recognize(filePath, "eng");
  // delete temp file
  fs.unlink(filePath, () => {});
  return data?.text || "";
}

app.post("/convert-image", upload.single("file"), async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });

  try {
    const text = await ocrFileAndDelete(req.file.path);
    if (!text.trim()) return res.status(400).json({ error: "No readable code found" });

    const { from = "unknown", to = "unknown" } = req.body;
    const prompt = `
Convert the following ${from} code into ${to}. Return only the converted code.

Code:
\`\`\`${from}
${text}
\`\`\`
`;
    const messages = [
      { role: "system", content: "You are a code conversion assistant." },
      { role: "user", content: prompt },
    ];
    const converted = await callOpenRouter(messages);
    res.json({ extractedCode: text.trim(), result: converted });
  } catch (err) {
    console.error("❌ convert-image error:", err);
    res.status(500).json({ error: "Convert image failed", details: err.message });
  }
});

app.post("/optimize-image", upload.single("file"), async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });

  try {
    const text = await ocrFileAndDelete(req.file.path);
    if (!text.trim()) return res.status(400).json({ error: "No readable code found" });

    const { language = "unknown" } = req.body;
    const messages = [
      { role: "system", content: "You are an expert developer who writes optimized code." },
      {
        role: "user",
        content: `
Language: ${language}
Optimize the following code for performance and clarity. Explain changes briefly and provide the improved code.

Code:
\`\`\`${language}
${text}
\`\`\`
`,
      },
    ];
    const optimized = await callOpenRouter(messages);
    res.json({ extractedCode: text.trim(), result: optimized });
  } catch (err) {
    console.error("❌ optimize-image error:", err);
    res.status(500).json({ error: "Optimize image failed", details: err.message });
  }
});

app.post("/fill-image", upload.single("file"), async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });

  try {
    const text = await ocrFileAndDelete(req.file.path);
    if (!text.trim()) return res.status(400).json({ error: "No readable code found" });

    const { language = "unknown" } = req.body;
    const messages = [
      { role: "system", content: "You complete partial code and fill TODOs while preserving style." },
      {
        role: "user",
        content: `
Language: ${language}
Fill the TODOs or placeholders in the following partial code. Provide the completed code and briefly explain assumptions.

Partial code:
\`\`\`${language}
${text}
\`\`\`
`,
      },
    ];
    const filled = await callOpenRouter(messages);
    res.json({ extractedCode: text.trim(), result: filled });
  } catch (err) {
    console.error("❌ fill-image error:", err);
    res.status(500).json({ error: "Fill image failed", details: err.message });
  }
});

// ========== HISTORY ROUTES ==========
app.get("/history", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });

  const histories = JSON.parse(fs.readFileSync(HISTORY_FILE));
  const userHist = histories.filter((h) => h.email === user.email);
  res.json({ history: userHist });
});

app.delete("/history", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = verifyToken(token);
  if (!user) return res.status(403).json({ error: "Unauthorized" });

  const histories = JSON.parse(fs.readFileSync(HISTORY_FILE));
  const newHist = histories.filter((h) => h.email !== user.email);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(newHist, null, 2));

  res.json({ message: "History cleared successfully" });
});

// ========== FRONTEND ==========
// Splash screen as starting page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/splash.html"));
});
// Serve all other static frontend files
app.use(express.static(path.join(__dirname, "../frontend")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
