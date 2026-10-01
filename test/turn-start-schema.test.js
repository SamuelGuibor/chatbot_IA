// Início do turno (resolveTurnStart), campo handoffAfterFlow e o fallback
// STATIC_SYSTEM_PROMPT (30/09/2026).
process.env.ANTHROPIC_API_KEY ||= "teste";
process.env.BRAIN_PROMPT_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const bot = require("../bot");

const hist = [{ role: "agent", text: "Manda o CNIS e a carta de concessão" }, { role: "client", text: "ok" }];

test("resolveTurnStart: etapa em andamento não muda", () => {
    const r = bot.resolveTurnStart({ state: "triagem_lesao", memory: "Nome: Ana", history: hist });
    assert.deepEqual(r, { effState: "triagem_lesao", effMemory: "Nome: Ana", effHistory: hist, etapaSuspensa: false, motivo: null });
});

test("resolveTurnStart: 'encerrando' + atendente recente → nada zerado, etapa suspensa", () => {
    const r = bot.resolveTurnStart({ state: "encerrando", memory: "Nome: Ana", history: hist, conversationFacts: { recentAttendant: true } });
    assert.equal(r.effState, null);
    assert.equal(r.effMemory, "Nome: Ana");
    assert.equal(r.effHistory, hist);
    assert.equal(r.etapaSuspensa, true);
    assert.equal(r.motivo, "voltou_da_equipe");
});

test("resolveTurnStart: etapa vazia, sem desfecho, com pedido em aberto → nada zerado", () => {
    const r = bot.resolveTurnStart({ state: null, memory: null, history: hist, conversationFacts: { attendantRequest: { text: "CNIS" } } });
    assert.equal(r.effHistory, hist);
    assert.equal(r.etapaSuspensa, true);
});

test("resolveTurnStart: conversa devolvida (returnedByAttendant) → nada zerado", () => {
    const r = bot.resolveTurnStart({ state: "", memory: "x", history: hist, priorOutcome: { closeCategory: "transferido", returnedByAttendant: true } });
    assert.equal(r.etapaSuspensa, true);
    assert.equal(r.effMemory, "x");
});

test("resolveTurnStart: pedido com texto vazio não conta", () => {
    const r = bot.resolveTurnStart({ state: null, memory: "x", history: hist, conversationFacts: { attendantRequest: { text: "  " } } });
    assert.equal(r.motivo, "novo");
});

test("resolveTurnStart: sem desfecho e sem fatos → atendimento novo (zera ficha e histórico)", () => {
    const r = bot.resolveTurnStart({ state: null, memory: "velha", history: hist });
    assert.deepEqual(r, { effState: "saudacao", effMemory: null, effHistory: [], etapaSuspensa: false, motivo: "novo" });
});

test("resolveTurnStart: com desfecho e sem atendente → retomada (comportamento de 30/07)", () => {
    const r = bot.resolveTurnStart({ state: null, memory: "ficha", history: hist, priorOutcome: { qualified: true } });
    assert.deepEqual(r, { effState: "saudacao", effMemory: "ficha", effHistory: hist, etapaSuspensa: false, motivo: "retomada" });
});

test("responseSchema tem handoffAfterFlow boolean e obrigatório", () => {
    assert.equal(bot.responseSchema.properties.handoffAfterFlow.type, "boolean");
    assert.ok(bot.responseSchema.required.includes("handoffAfterFlow"));
    // Nenhum state/action/closeCategory novo nesta mudança.
    assert.deepEqual(bot.responseSchema.properties.action.enum, ["continue", "qualify", "disqualify", "handoff", "lookup", "send_flow", "resolve"]);
});

test("sanitizeHandoffAfterFlow: só com send_flow + flowName + handoffReason", () => {
    const ok = { action: "send_flow", flowName: "LISTA DE DOCUMENTOS - INSS", handoffReason: "cliente diz que assinou — conferir a assinatura na ZapSign", handoffAfterFlow: true };
    assert.equal(bot.sanitizeHandoffAfterFlow(ok), true);
    assert.equal(bot.sanitizeHandoffAfterFlow({ ...ok, handoffAfterFlow: false }), false);
    assert.equal(bot.sanitizeHandoffAfterFlow({ ...ok, handoffAfterFlow: "true" }), false);
    assert.equal(bot.sanitizeHandoffAfterFlow({ ...ok, action: "handoff" }), false);
    assert.equal(bot.sanitizeHandoffAfterFlow({ ...ok, action: "continue" }), false);
    assert.equal(bot.sanitizeHandoffAfterFlow({ ...ok, flowName: "  " }), false);
    assert.equal(bot.sanitizeHandoffAfterFlow({ ...ok, flowName: null }), false);
    assert.equal(bot.sanitizeHandoffAfterFlow({ ...ok, handoffReason: "" }), false);
    assert.equal(bot.sanitizeHandoffAfterFlow({ ...ok, handoffReason: undefined }), false);
});

test("fallback: pedido em aberto, Meu INSS, assinei, senha, honorários e 3ª vez", () => {
    const p = bot.STATIC_SYSTEM_PROMPT;
    assert.ok(p.includes("PEDIDO DO ATENDENTE EM ABERTO"));
    assert.ok(p.includes('flowName="LISTA DE DOCUMENTOS - INSS"'));
    assert.ok(p.includes('você NÃO pergunta "tem Meu INSS?"'));
    assert.ok(p.includes("se ainda não tiver o app, instale o Meu INSS e entre com a sua conta gov.br"));
    assert.ok(p.includes("handoffAfterFlow=true"));
    assert.ok(p.includes("acesso gov.br enviado — login pela equipe"));
    assert.ok(p.includes('flowName="Dúvidas sobre os honorários (valores que cobramos)"'));
    assert.ok(p.includes("handoffReason=\"IA não entendeu o cliente 3x seguidas\""));
    assert.ok(p.includes("CONVERSA DEVOLVIDA PELA EQUIPE"));
    assert.ok(!p.includes("2x seguidas"));
    assert.ok(!p.includes("ofereça que a equipe acessa"));
    assert.ok(!p.includes("CPF + senha do gov.br"));
});

test("responseSchema tem keepRequest boolean e obrigatório; sanitizeKeepRequest só com handoff", () => {
    assert.equal(bot.responseSchema.properties.keepRequest.type, "boolean");
    assert.ok(bot.responseSchema.required.includes("keepRequest"));
    assert.equal(bot.sanitizeKeepRequest({ action: "handoff", keepRequest: true }), true);
    assert.equal(bot.sanitizeKeepRequest({ action: "handoff", keepRequest: false }), false);
    assert.equal(bot.sanitizeKeepRequest({ action: "handoff", keepRequest: "true" }), false);
    for (const action of ["continue", "send_flow", "qualify", "disqualify", "resolve"]) {
        assert.equal(bot.sanitizeKeepRequest({ action, keepRequest: true }), false, action);
    }
});

test("fallback: keepRequest no 'assinei' com a LISTA já mandada, marcadores de senha e Área do Cliente sem senha", () => {
    const p = bot.STATIC_SYSTEM_PROMPT;
    assert.ok(p.includes('action="handoff", keepRequest=true'));
    assert.ok(p.includes("keepRequest=false"));
    assert.ok(p.includes('"[senha omitida]" ou "[código omitido]"'));
    assert.ok(p.includes('handoffReason="cliente pediu o acesso à Área do Cliente"'));
    assert.ok(p.includes("NUNCA informe senha de acesso"));
    assert.ok(!p.includes("segurosparana1"));
    assert.ok(!p.includes("senha padrão"));
});
