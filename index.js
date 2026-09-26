require("dotenv").config();
const express = require("express");
const { decide, farewell, followupDecision, recoveryMessage, suggest, summarize, transcribeAudio, distillLesson, consolidatePlaybook , extractContractData, confirmContractReply, deadlineError } = require("./bot");

const SECRET = process.env.BOT_SECRET || "";
const app = express();
app.use(express.json({ limit: "10mb" }));

// Orçamento do /reply (26/09/2026): o CRM espera 45 s por tentativa e manda
// no header x-bot-budget-ms quanto o micro pode gastar (relativo: não depende
// do relógio dos dois lados). Sem o header (CRM antigo), 40 s. Estourou →
// 504 "prazo do CRM esgotado", que o CRM conta como timeout (mesma política
// de retry de antes). Antes o micro seguia pagando Claude/Gemini depois de o
// CRM já ter desistido.
const DEFAULT_REPLY_BUDGET_MS = 40_000;
const MIN_REPLY_BUDGET_MS = 5_000;
const MAX_REPLY_BUDGET_MS = 60_000;

function replyBudgetMs(header) {
  const n = Number(header);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REPLY_BUDGET_MS;
  return Math.min(Math.max(Math.round(n), MIN_REPLY_BUDGET_MS), MAX_REPLY_BUDGET_MS);
}

/**
 * Aborta `controller` se o CRM desconectar antes de a resposta sair.
 * res.on("close"), NUNCA req.on("close"): no Node ≥ 16 o "close" do req
 * dispara quando o corpo termina de ser lido (logo depois do express.json) e
 * abortaria toda chamada. writableFinished = a resposta já saiu inteira (o
 * "close" normal). Atrás do proxy do Railway o aviso de desconexão pode não
 * chegar: a proteção principal é o prazo; isto é bônus.
 */
function abortOnClientGone(res, controller, what) {
  res.on("close", () => {
    if (!res.writableFinished && !controller.signal.aborted) {
      controller.abort(deadlineError(`o CRM desconectou antes ${what}`));
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "chatbot-whatsapp", model: process.env.MODEL || "claude-sonnet-5" });
});

// Body: { contact, processInfo, history, message, media?, memory?, state?,
//         failCount?, business?, lookupResult?, conversationFacts? }  (ver bot.js)
// conversationFacts = { docsReceived, registeredClient, recentAttendant? }:
// vai inteiro para o bloco "ESTE ATENDIMENTO" (renderConversationFacts), então
// fato novo lá dentro não precisa entrar no destructuring abaixo.
// Resposta: { reply, action, handoffReason?, lookup?, memory, state, intent,
//             emotion, understood, confidence }
// Header opcional x-bot-budget-ms: orçamento em ms (ver replyBudgetMs);
// estourou ou o CRM desconectou → 504 { error: "deadline" }.
app.post("/reply", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  // priorOutcome ficava de fora do destructuring e era jogado fora — o prompt
  // manda o modelo checar priorOutcome.qualified, mas o dado nunca chegava.
  const { contact, processInfo, history, message, media, mediaList, memory, state, failCount, business, lookupResult, flows, priorOutcome, signature, conversationFacts } = req.body || {};
  const hasMediaList = Array.isArray(mediaList) && mediaList.some((m) => m?.url);
  if ((!message || typeof message !== "string") && !media?.url && !hasMediaList) {
    return res.status(400).json({ error: "message, media ou mediaList obrigatórios" });
  }

  const startedAt = Date.now();
  const budgetMs = replyBudgetMs(req.headers["x-bot-budget-ms"]);
  const ac = new AbortController();
  const deadlineTimer = setTimeout(() => ac.abort(deadlineError()), budgetMs);
  abortOnClientGone(res, ac, "da resposta");

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
      signature: signature ?? null,
      conversationFacts: conversationFacts ?? null,
      deadline: startedAt + budgetMs,
      signal: ac.signal,
    });
    console.log(
      `[BOT] ${contact?.phone ?? "?"} → action=${decision.action} intent=${decision.intent}` +
      ` state=${decision.state} understood=${decision.understood}` +
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
    // Prazo estourado ou CRM desconectado: nenhuma chamada nova sai (o sinal
    // já abortou tudo) e o CRM recebe 504, que ele trata como timeout.
    if (err?.isDeadline || ac.signal.aborted) {
      console.warn(
        `[BOT] ${contact?.phone ?? "?"} → /reply abortado após ${Date.now() - startedAt} ms ` +
        `(orçamento ${budgetMs} ms): ${String(err?.message ?? err)}`,
      );
      if (!res.headersSent && !res.writableEnded) {
        res.status(504).json({ error: "deadline", detail: "prazo do CRM esgotado" });
      }
      return;
    }
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
  } finally {
    clearTimeout(deadlineTimer);
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
// Body: { url, mimeType } → { transcript, usage }  (url = pré-assinada do S3;
// usage = tokens do Gemini para o CRM gravar no log wa_transcribe)
app.post("/transcribe", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { url, mimeType } = req.body || {};
  if (!url || !mimeType) {
    return res.status(400).json({ error: "url e mimeType obrigatórios" });
  }
  // O CRM também chama aqui na chegada do áudio (transcrição antecipada do
  // bot) e desiste depois de alguns segundos: sem o aborto, as tentativas
  // seguintes do Gemini sairiam para ninguém.
  const ac = new AbortController();
  abortOnClientGone(res, ac, "da transcrição");
  try {
    const out = await transcribeAudio({ url, mimeType }, { signal: ac.signal });
    const transcript = out.text;
    if (!transcript) throw new Error("transcrição vazia");
    console.log(`[BOT] transcribe ok (${transcript.length} chars).`);
    res.json({ transcript, usage: out.usage });
  } catch (err) {
    if (ac.signal.aborted) {
      console.warn(`[BOT] transcribe abortado: ${String(err?.message ?? err)}`);
      return;
    }
    console.error("[BOT] Erro na transcrição:", err);
    res.status(500).json({ error: "transcribe_error", detail: String(err?.message ?? err) });
  }
});

// EXTRAÇÃO DOS DADOS DA PROCURAÇÃO (assinatura eletrônica própria): lê a
// ficha + conversa + documentos (RG/CNH via URLs pré-assinadas do S3) e devolve
// os campos do KIT_PREV_CSS, cada um com { value, confidence, source }.
// Body: { contact, history, memory?, documents: [{ url, mimeType }] }
//   → { fields: { name, nacionalidade, ..., estado }, documentsRead, usage }
app.post("/extract-contract-data", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { contact, history, memory, documents } = req.body || {};
  try {
    const out = await extractContractData({
      contact: contact ?? null,
      history: Array.isArray(history) ? history : [],
      memory: memory ?? null,
      documents: Array.isArray(documents) ? documents : [],
    });
    const resumo = Object.entries(out.fields)
      .map(([k, f]) => `${k}=${f.source}${f.value ? "" : "(vazio)"}`)
      .join(" ");
    console.log(`[BOT] extract-contract-data ${contact?.name ?? contact?.phone ?? "?"} (${out.documentsRead} docs): ${resumo}`);
    res.json(out);
  } catch (err) {
    console.error("[BOT] Erro na extração de dados do contrato:", err);
    // O app Next trata erro mandando a conversa pra revisão humana.
    res.status(500).json({ error: "extract_error", detail: String(err?.message ?? err) });
  }
});

// CONFIRMAÇÃO dos dados do contrato: interpreta a resposta do cliente ao
// resumo (sim/correção/áudio/confuso) antes de gerar o documento.
// Body: { contact, extracted, message?, media? }
//   → { decision: confirmado|corrigir|atendente|nao_entendi, corrections, reply, usage }
app.post("/confirm-contract-data", async (req, res) => {
  if (!SECRET || req.headers["x-bot-secret"] !== SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { contact, extracted, message, media } = req.body || {};
  try {
    const out = await confirmContractReply({
      contact: contact ?? null,
      extracted: extracted ?? {},
      message: typeof message === "string" ? message : "",
      media: media ?? null,
    });
    console.log(`[BOT] confirm-contract ${contact?.name ?? contact?.phone ?? "?"} → ${out.decision}${out.corrections.length ? ` (${out.corrections.map((c) => c.field).join(",")})` : ""}`);
    res.json(out);
  } catch (err) {
    console.error("[BOT] Erro na confirmação de dados:", err);
    // O app Next trata erro mandando pra revisão humana.
    res.status(500).json({ error: "confirm_error", detail: String(err?.message ?? err) });
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
const model = process.env.MODEL || "claude-sonnet-5";
app.listen(port, () => console.log(`chatbot-whatsapp up na porta ${port} com modelo ${model}`));
