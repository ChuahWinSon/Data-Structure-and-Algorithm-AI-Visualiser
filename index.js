import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn("Warning: ANTHROPIC_API_KEY is not set in .env — requests will fail.");
}

// Thin pass-through: the frontend sends the same {model, max_tokens, system, messages}
// shape it always has. This just adds the real API key server-side, so the key
// never has to live in the browser.
app.post("/api/chat", async (req, res) => {
  const { model, max_tokens, system, messages } = req.body || {};
  if (!messages) {
    return res.status(400).json({ error: { message: "messages is required" } });
  }
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-6",
        max_tokens: max_tokens || 1000,
        system,
        messages,
      }),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message || "Proxy request failed" } });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
