require("dotenv").config();
const express = require("express");
const { decide, farewell } = require("./bot");

const SECRET = process.env.BOT_SECRET || "";
const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "chatbot-whatsapp", model: process.env.MODEL || "claude-opus-4-8" });
});

// Body: { contact, processInfo, history, message, media?, memory?, state?,
//         failCount?, business?, lookupResult? }             (ver bot.js)
// Resposta: { reply, action, handoffReason?, lookup?, memory, state, intent,
//             emotion, urgent, understood, confidence }
app.post("/reply", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  const { contact, processInfo, history, message, media, memory, state, failCount, business, lookupResult, flows } = req.body || {};
  if ((!message || typeof message !== "string") && !media?.url) {
    return res.status(400).json({ error: "message ou media obrigatórios" });
  }

  try {
    const decision = await decide({
      contact,
      processInfo,
      history,
      message: typeof message === "string" ? message : "",
      media: media ?? null,
      memory: memory ?? null,
      state: state ?? null,
      failCount: Number(failCount) || 0,
      business: business ?? null,
      lookupResult: lookupResult ?? null,
      flows: Array.isArray(flows) ? flows : [],
    });
    console.log(
      `[BOT] ${contact?.phone ?? "?"} → action=${decision.action} intent=${decision.intent}` +
      ` state=${decision.state} urgent=${decision.urgent} understood=${decision.understood}` +
      (decision.lookup ? ` lookup=${decision.lookup}` : "") +
      (decision.handoffReason ? ` (${decision.handoffReason})` : ""),
    );
    console.log("[BOT COMPLETO]:", decision); 
    res.json(decision);
  } catch (err) {
    console.error("[BOT] Erro na IA:", err);
    // Falha da IA → o app Next joga na fila humana SEM mandar mensagem de
    // erro pro cliente. Um erro aqui nunca deixa o cliente falando sozinho.
    res.status(500).json({ error: "ia_error", detail: String(err?.message ?? err) });
  }
});

// Despedida contextual do encerramento por inatividade (cron do app Next).
// Body: { contact, history, memory } → { farewell }
app.post("/farewell", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { contact, history, memory } = req.body || {};
  try {
    const text = await farewell({ contact, history, memory });
    console.log(`[BOT] farewell para ${contact?.name ?? "?"}: ${text.slice(0, 80)}...`);
    res.json({ farewell: text });
  } catch (err) {
    console.error("[BOT] Erro na despedida:", err);
    // O app Next tem fallback de texto fixo — só sinalizamos o erro.
    res.status(500).json({ error: "farewell_error", detail: String(err?.message ?? err) });
  }
});

const port = process.env.PORT || 3003;
const model = process.env.MODEL || "claude-opus-4-8";
app.listen(port, () => console.log(`chatbot-whatsapp up na porta ${port} com modelo ${model}`));
