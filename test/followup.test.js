// /followup-decision: modo antigo (mode "followup" + usage) e cobrança do
// pedido em aberto (mode "pending"), com o Claude trocado por um dublê.
process.env.ANTHROPIC_API_KEY ||= "teste";
process.env.BRAIN_PROMPT_URL = "";
process.env.MODEL = "claude-sonnet-5";

const test = require("node:test");
const assert = require("node:assert/strict");
const Anthropic = require("@anthropic-ai/sdk");
const bot = require("../bot");

// O cliente do bot.js é outra instância, mas o método vem do mesmo protótipo.
const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
const chamadas = [];
let proximas = [];
messagesProto.create = async function (params) {
    chamadas.push(params);
    const saida = proximas.shift();
    return {
        content: [{ type: "text", text: JSON.stringify(saida) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
};

const NOW = Date.parse("2026-09-30T13:05:00Z");

test("parsePendingRequest: normaliza e ignora o que não é do contrato", () => {
    assert.equal(bot.parsePendingRequest(null), null);
    assert.equal(bot.parsePendingRequest({ text: "  " }), null);
    const p = bot.parsePendingRequest({
        text: "  CNIS; Carta de Concessão  ",
        source: "devolver",
        at: "2026-09-29T12:00:00.000Z",
        flowName: null,
        docsSinceOpened: "2",
        attempt: 0,
        windowClosesAt: "2026-09-30T18:00:00Z",
        lastClientAt: "lixo",
        previousMissing: "CNIS\nCarta",
        byName: "Daniel",
    });
    assert.deepEqual(p, {
        text: "CNIS; Carta de Concessão",
        source: "devolver",
        at: "2026-09-29T12:00:00.000Z",
        flowName: null,
        docsSinceOpened: 2,
        attempt: 1,
        windowClosesAt: "2026-09-30T18:00:00.000Z",
        lastClientAt: null,
        previousMissing: "CNIS Carta",
    });
    assert.equal(bot.parsePendingRequest({ text: "x", source: "outra" }).source, null);
    assert.equal(bot.parsePendingRequest({ text: "a".repeat(2000) }).text.length, 1500 + " […]".length);
});

test("buildPendingFacts: pedido citado, nº da cobrança, janela e último contato", () => {
    const p = bot.parsePendingRequest({
        text: "CNIS\nCTPS Digital",
        source: "lista_atendente",
        at: "2026-09-29T20:00:00Z",
        docsSinceOpened: 1,
        attempt: 2,
        windowClosesAt: "2026-09-30T18:05:00Z",
        lastClientAt: "2026-09-29T18:05:00Z",
        previousMissing: "CTPS Digital",
    });
    const out = bot.buildPendingFacts(p, NOW);
    assert.ok(out.startsWith("PEDIDO DO ATENDENTE EM ABERTO (fatos do sistema):"));
    assert.ok(out.includes("- Cobranças automáticas já enviadas: 1."));
    assert.ok(out.includes("  | CNIS\n  | CTPS Digital"));
    assert.ok(out.includes("COBRANÇA (fatos do sistema):"));
    assert.ok(out.includes("- Esta seria a cobrança nº 2."));
    assert.ok(out.includes("fecha em 30/09 às 15:05 (em cerca de 5 h)"));
    assert.ok(out.includes("- Última mensagem do cliente: 29/09 às 15:05 (há 19 h)."));
    assert.ok(out.includes("- O que faltava na avaliação anterior: CTPS Digital."));
    assert.ok(!out.includes("Daniel"));
});

test("finalizePendingDecision: nudge limpo passa", () => {
    const r = bot.finalizePendingDecision({ action: "nudge", message: "Oi, Ana! Ainda falta a CTPS Digital. Quando conseguir, é só mandar por aqui 😊", missing: "CTPS Digital\nResultado da Perícia", reason: "falta item" });
    assert.deepEqual(r, {
        mode: "pending",
        action: "nudge",
        message: "Oi, Ana! Ainda falta a CTPS Digital. Quando conseguir, é só mandar por aqui 😊",
        missing: "CTPS Digital; Resultado da Perícia",
        reason: "falta item",
        leaked: false,
    });
});

test("finalizePendingDecision: rede de segurança vira silent (senha, encerrar, sistema, repetido)", () => {
    for (const message of [
        "Se preferir, me passa a senha do gov.br que a equipe entra por você.",
        "Me manda o código que chegou no seu celular?",
        "Vou encerrar o atendimento se não mandar hoje.",
        "Esta é uma mensagem automática do sistema.",
    ]) {
        const r = bot.finalizePendingDecision({ action: "nudge", message, missing: "CNIS", reason: "x" });
        assert.equal(r.action, "silent", message);
        assert.equal(r.message, "");
        assert.equal(r.leaked, true);
        assert.match(r.reason, /\[texto descartado: /);
    }
    const repetida = bot.finalizePendingDecision({ action: "nudge", message: "Falta o CNIS, é só mandar por aqui", missing: "", reason: "" }, { lastOutText: "falta o CNIS,  é só mandar por aqui" });
    assert.equal(repetida.action, "silent");
    assert.equal(repetida.leaked, true);
});

test("finalizePendingDecision: handoff sem texto; ação desconhecida = silent", () => {
    const h = bot.finalizePendingDecision({ action: "handoff", message: "tchau", missing: "", reason: "tudo chegou" });
    assert.equal(h.action, "handoff");
    assert.equal(h.message, "");
    assert.equal(bot.finalizePendingDecision({ action: "close", message: "oi" }).action, "silent");
    assert.equal(bot.finalizePendingDecision(null).action, "silent");
});

test("followupDecision com pendingRequest → mode pending, usage, prompt com o pedido", async () => {
    chamadas.length = 0;
    proximas = [{ rationale: "falta CTPS", action: "nudge", message: "Oi! Só falta a Carteira de Trabalho Digital. Quando conseguir, é só mandar por aqui 😊", missing: "CTPS Digital", reason: "falta 1 item" }];
    const r = await bot.followupDecision({
        contact: { name: "Ana Lima" },
        history: [
            { role: "agent", text: "Precisamos do CNIS e da CTPS Digital" },
            { role: "client", text: "[anexo: PDF]" },
            { role: "bot", text: "Recebi o CNIS ✅ Agora só falta a CTPS Digital." },
        ],
        memory: "PEDIDO: CNIS recebido; CTPS pendente",
        state: "coleta_documentos",
        pendingRequest: { text: "CNIS\nCTPS Digital", source: "devolver", at: "2026-09-29T12:00:00Z", attempt: 1, docsSinceOpened: 1, windowClosesAt: "2026-09-30T20:00:00Z", lastClientAt: "2026-09-29T20:00:00Z" },
    });
    assert.equal(r.mode, "pending");
    assert.equal(r.action, "nudge");
    assert.equal(r.missing, "CTPS Digital");
    assert.equal(r.leaked, false);
    assert.deepEqual(r.usage, { model: "claude-sonnet-5", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    assert.equal(chamadas.length, 1);
    const params = chamadas[0];
    assert.equal(params.system, bot.PENDING_FOLLOWUP_SYSTEM);
    assert.deepEqual(params.output_config.format.schema.properties.action.enum, ["nudge", "silent", "handoff"]);
    // Cobrança rápida (revisão de 30/09): raciocínio no esforço low e max_tokens menor.
    assert.equal(params.output_config.effort, "low");
    assert.deepEqual(params.thinking, { type: "adaptive" });
    assert.equal(params.max_tokens, 1500);
    const conteudo = params.messages[0].content;
    assert.ok(conteudo.includes("PEDIDO DO ATENDENTE EM ABERTO (fatos do sistema):"));
    assert.ok(conteudo.includes("[atendente] Precisamos do CNIS"));
    assert.ok(conteudo.includes("[bot] Recebi o CNIS"));
});

test("followupDecision sem pendingRequest → modo antigo com mode 'followup' e usage", async () => {
    chamadas.length = 0;
    proximas = [{ action: "close", message: "", reason: "já se despediu" }];
    const r = await bot.followupDecision({ contact: { name: "Ana" }, history: [{ role: "bot", text: "Boa noite!" }], memory: null, state: "saudacao" });
    assert.deepEqual(r, {
        mode: "followup",
        action: "close",
        message: "",
        reason: "já se despediu",
        usage: { model: "claude-sonnet-5", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    assert.equal(chamadas[0].model, "claude-sonnet-5");
});

test("pendingCallConfig: low effort nas famílias atuais; Haiku com orçamento mínimo; modelo desconhecido como antes", () => {
    assert.deepEqual(bot.pendingCallConfig("claude-sonnet-5"), { max_tokens: 1500, thinking: { type: "adaptive" }, effort: "low" });
    assert.deepEqual(bot.pendingCallConfig("claude-opus-5-5"), { max_tokens: 1500, thinking: { type: "adaptive" }, effort: "low" });
    assert.deepEqual(bot.pendingCallConfig("claude-sonnet-4-6"), { max_tokens: 1500, thinking: { type: "adaptive" }, effort: "low" });
    assert.deepEqual(bot.pendingCallConfig("claude-haiku-4-5"), { max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 }, effort: null });
    assert.deepEqual(bot.pendingCallConfig("modelo-x"), { max_tokens: 3000, thinking: { type: "adaptive" }, effort: null });
});

test("followupDecision com prazo já estourado → erro de prazo sem chamar a IA (o index.js responde 504)", async () => {
    chamadas.length = 0;
    proximas = [];
    await assert.rejects(
        bot.followupDecision({
            contact: { name: "Ana" },
            history: [],
            pendingRequest: { text: "CNIS", source: "devolver", at: "2026-09-29T12:00:00Z", attempt: 1 },
        }, { deadline: Date.now() - 1 }),
        (err) => err?.isDeadline === true,
    );
    assert.equal(chamadas.length, 0);
});

test("PENDING_FOLLOWUP_SYSTEM: três ações, nunca senha/despedida", () => {
    const s = bot.PENDING_FOLLOWUP_SYSTEM;
    for (const t of ['"nudge"', '"silent"', '"handoff"', "senha", "despedida", '"(se tiver)"', '"; "']) assert.ok(s.includes(t), t);
    assert.ok(s.includes("[mensagem automática: cobrança automática do pedido em aberto]"));
});
