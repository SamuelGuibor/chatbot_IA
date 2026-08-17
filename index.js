require("dotenv").config();
const express = require("express");
const { decide, farewell, followupDecision, recoveryMessage, suggest, summarize, transcribeAudio, distillLesson, consolidatePlaybook } = require("./bot");

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

  // priorOutcome ficava de fora do destructuring e era jogado fora — o prompt
  // manda o modelo checar priorOutcome.qualified, mas o dado nunca chegava.
  const { contact, processInfo, history, message, media, mediaList, memory, state, failCount, business, lookupResult, flows, priorOutcome } = req.body || {};
  const hasMediaList = Array.isArray(mediaList) && mediaList.some((m) => m?.url);
  if ((!message || typeof message !== "string") && !media?.url && !hasMediaList) {
    return res.status(400).json({ error: "message, media ou mediaList obrigatórios" });
  }

  try {
    const decision = await decide({
      contact,
      processInfo,
      history,
      message: typeof message === "string" ? message : "",
      media: media ?? null,
      mediaList: hasMediaList ? mediaList : null,
      memory: memory ?? null,
      state: state ?? null,
      failCount: Number(failCount) || 0,
      business: business ?? null,
      lookupResult: lookupResult ?? null,
      flows: Array.isArray(flows) ? flows : [],
      priorOutcome: priorOutcome ?? null,
    });
    console.log(
      `[BOT] ${contact?.phone ?? "?"} → action=${decision.action} intent=${decision.intent}` +
      ` state=${decision.state} urgent=${decision.urgent} understood=${decision.understood}` +
      (decision.lookup ? ` lookup=${decision.lookup}` : "") +
      (decision.handoffReason ? ` (${decision.handoffReason})` : ""),
    );
    // NÃO logar `decision` inteira: `memory` é a ficha do cliente (pode conter
    // CPF/endereço) — o próprio prompt proíbe expor esses dados; log não é
    // exceção. Loga o resto + só o TAMANHO da ficha.
    const { memory: _memory, reply: _reply, replies: _replies, ...meta } = decision;
    console.log("[BOT COMPLETO]:", {
      ...meta,
      reply: String(_reply ?? "").slice(0, 120),
      repliesCount: Array.isArray(_replies) ? _replies.length : 0,
      memoryChars: String(_memory ?? "").length,
    });
    res.json(decision);
  } catch (err) {
    console.error("[BOT] Erro na IA:", err);
    // Falha da IA → o app Next joga na fila humana SEM mandar mensagem de
    // erro pro cliente. Um erro aqui nunca deixa o cliente falando sozinho.
    // detail já vem traduzido pro humano (ver classifyClaudeError em bot.js)
    // quando o erro veio da Anthropic; claudeStatus/claudeErrorType dão pro
    // dashboard distinguir "sobrecarga" de "sem saldo" de "chave inválida".
    res.status(500).json({
      error: "ia_error",
      detail: String(err?.message ?? err),
      claudeStatus: err?.status ?? null,
      claudeErrorType: err?.claudeErrorType ?? null,
    });
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

// Provocação de RECUPERAÇÃO (cron do app Next): conversa em standby chegou na
// hora da tentativa. Devolve o texto contextual (janela aberta) e a pendência
// curta usada como variável do template (janela fechada).
// Body: { contact, history, memory, state, attempt, maxAttempts } → { message, pending }
app.post("/recovery-message", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { contact, history, memory, state, attempt, maxAttempts } = req.body || {};
  try {
    const out = await recoveryMessage({ contact, history, memory, state, attempt, maxAttempts });
    console.log(`[BOT] recovery ${contact?.name ?? "?"} (tentativa ${attempt ?? 1}): ${out.message.slice(0, 80)}...`);
    res.json(out);
  } catch (err) {
    console.error("[BOT] Erro na provocação de recuperação:", err);
    // O app Next tem fallback de textos fixos — só sinalizamos o erro.
    res.status(500).json({ error: "recovery_error", detail: String(err?.message ?? err) });
  }
});

// Decisão de follow-up do cron (app Next): quando o cliente sumiu 30min+ e a
// última mensagem foi do bot, a IA decide se ainda cabe cutucar ou se a conversa
// já teve fecho natural (encerrar em silêncio).
// Body: { contact, history, memory, state } → { action: "nudge"|"close", message, reason }
app.post("/followup-decision", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { contact, history, memory, state } = req.body || {};
  try {
    const decision = await followupDecision({ contact, history, memory, state });
    console.log(`[BOT] follow-up ${contact?.name ?? "?"}: ${decision.action}${decision.reason ? ` (${decision.reason})` : ""}`);
    res.json(decision);
  } catch (err) {
    console.error("[BOT] Erro na decisão de follow-up:", err);
    // O app Next tem fallback (heurística local) — só sinalizamos o erro.
    res.status(500).json({ error: "followup_error", detail: String(err?.message ?? err) });
  }
});

// Sugestão de resposta para o ATENDENTE HUMANO (agent-assist do inbox).
// Body: { contact, processInfo, history, memory?, agentName? }
// Resposta: { suggestion, usage }
app.post("/suggest", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { contact, processInfo, history, memory, agentName } = req.body || {};
  try {
    const out = await suggest({
      contact,
      processInfo: processInfo ?? null,
      history: Array.isArray(history) ? history : [],
      memory: memory ?? null,
      agentName: agentName ?? null,
    });
    console.log(`[BOT] suggest para ${contact?.name ?? contact?.phone ?? "?"}: ${out.suggestion.slice(0, 80)}...`);
    res.json(out);
  } catch (err) {
    console.error("[BOT] Erro na sugestão:", err);
    res.status(500).json({ error: "suggest_error", detail: String(err?.message ?? err) });
  }
});

// Resumo BEM CURTO da conversa (vira comentário no card ao vincular contato).
// Body: { contact, history, memory? } → { summary, usage }
app.post("/summarize", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { contact, history, memory } = req.body || {};
  try {
    const out = await summarize({
      contact,
      history: Array.isArray(history) ? history : [],
      memory: memory ?? null,
    });
    console.log(`[BOT] summarize para ${contact?.name ?? contact?.phone ?? "?"} (${out.summary.length} chars).`);
    res.json(out);
  } catch (err) {
    console.error("[BOT] Erro no resumo:", err);
    res.status(500).json({ error: "summarize_error", detail: String(err?.message ?? err) });
  }
});

// Transcrição de áudio avulsa (botão "transcrever" do atendimento humano).
// Body: { url, mimeType } → { transcript }  (url = pré-assinada do S3)
app.post("/transcribe", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { url, mimeType } = req.body || {};
  if (!url || !mimeType) {
    return res.status(400).json({ error: "url e mimeType obrigatórios" });
  }
  try {
    const transcript = await transcribeAudio({ url, mimeType });
    if (!transcript) throw new Error("transcrição vazia");
    console.log(`[BOT] transcribe ok (${transcript.length} chars).`);
    res.json({ transcript });
  } catch (err) {
    console.error("[BOT] Erro na transcrição:", err);
    res.status(500).json({ error: "transcribe_error", detail: String(err?.message ?? err) });
  }
});

// CÉREBRO passo A — extrai a lição de UMA revisão humana (chamado pelo CRM logo
// que o supervisor salva o julgamento).
// Body: { contact, history, memory?, review } → { lesson, states, section, usage }
// lesson VAZIA é resposta válida: significa "não há nada novo a aprender aqui".
app.post("/distill-lesson", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { contact, history, memory, review } = req.body || {};
  if (!review?.verdict) {
    return res.status(400).json({ error: "review.verdict obrigatório" });
  }
  try {
    const out = await distillLesson({
      contact: contact ?? null,
      history: Array.isArray(history) ? history : [],
      memory: memory ?? null,
      review,
    });
    console.log(
      `[BRAIN] distill (${review.verdict}) → ` +
      (out.lesson ? `"${out.lesson.slice(0, 80)}..." [${out.section}]` : "sem lição (nada novo)"),
    );
    res.json(out);
  } catch (err) {
    console.error("[BRAIN] Erro ao destilar lição:", err);
    res.status(500).json({ error: "distill_error", detail: String(err?.message ?? err) });
  }
});

// CÉREBRO passo B — consolida as lições soltas no playbook (lote, sob demanda).
// Body: { lessons: [...], current?, maxRules? }
//   → { sections, rulesCount, changeNote, usage }
app.post("/consolidate-playbook", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { lessons, current, maxRules } = req.body || {};
  if (!Array.isArray(lessons) || !lessons.length) {
    return res.status(400).json({ error: "lessons obrigatório (array não vazio)" });
  }
  try {
    const out = await consolidatePlaybook({
      lessons,
      current: current ?? null,
      maxRules: Number(maxRules) || 80,
    });
    console.log(`[BRAIN] consolidate: ${lessons.length} lições → ${out.rulesCount} regras. ${out.changeNote}`);
    res.json(out);
  } catch (err) {
    console.error("[BRAIN] Erro ao consolidar playbook:", err);
    res.status(500).json({ error: "consolidate_error", detail: String(err?.message ?? err) });
  }
});

const port = process.env.PORT || 3003;
const model = process.env.MODEL || "claude-opus-4-8";
app.listen(port, () => console.log(`chatbot-whatsapp up na porta ${port} com modelo ${model}`));
