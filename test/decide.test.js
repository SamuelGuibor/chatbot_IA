// decide() de ponta a ponta com o Claude e o download de mídia trocados por
// dublês: confere o que vai para o modelo (bloco dinâmico, rótulos dos
// anexos, nota por turno) e os campos novos da resposta do /reply.
process.env.ANTHROPIC_API_KEY ||= "teste";
process.env.BRAIN_PROMPT_URL = "";
process.env.MODEL = "claude-sonnet-5";

const test = require("node:test");
const assert = require("node:assert/strict");
const Anthropic = require("@anthropic-ai/sdk");
const bot = require("../bot");

const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
const chamadas = [];
let proxima = null;
messagesProto.create = async function (params) {
    chamadas.push(params);
    return {
        content: [{ type: "text", text: JSON.stringify(proxima) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    };
};
// Download das mídias (URLs pré-assinadas do S3) → bytes fixos.
global.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });

function saida(extra = {}) {
    return {
        rationale: "cliente mandou 2 de 3 itens; falta a CTPS",
        reply: "Recebi o CNIS e a Carta de Concessão ✅ Agora só falta a Carteira de Trabalho Digital.",
        replies: [],
        action: "continue",
        flowName: "",
        closeCategory: "nenhum",
        handoffReason: "",
        handoffAfterFlow: false,
        lookup: "nenhum",
        memory: "PEDIDO DO ATENDENTE:\n- CNIS: recebido\n- Carta de Concessão: recebido\n- CTPS: pendente",
        state: "coleta_documentos",
        intent: "documentos",
        emotion: "neutro",
        understood: true,
        confidence: 0.9,
        optOut: false,
        appliedRules: [],
        silent: false,
        ...extra,
    };
}

const payloadBase = {
    contact: { name: "Ana Lima", phone: "5541999990000" },
    processInfo: { name: "Ana Lima", etapa: "Processo iniciado", service: "INSS" },
    history: [
        { role: "bot", text: "Olá!" },
        { role: "agent", text: "Precisamos do CNIS, da Carta de Concessão e da CTPS Digital" },
    ],
    message: "",
    memory: "",
    state: "encerrando",
    failCount: 0,
    business: { greeting: "bom dia", open: true },
    flows: [],
    priorOutcome: { qualified: true, closeCategory: "qualificado", returnedByAttendant: true, returnedAt: "2026-09-30T12:00:00Z" },
    conversationFacts: {
        docsReceived: 2,
        docsThisTurn: 2,
        registeredClient: true,
        recentAttendant: true,
        attendantRequest: { text: "CNIS\nCarta de Concessão\nCTPS Digital", source: "devolver", at: "2026-09-30T11:59:00Z", returnedToBot: true, docsSinceOpened: 2, nudges: 0 },
    },
    mediaList: [
        { id: "m1", url: "https://s3/x1", mimeType: "application/pdf", fileName: "CNIS.pdf" },
        { id: "m2", url: "https://s3/x2", mimeType: "image/jpeg", fileName: "midia.jpg" },
    ],
};

test("conversa devolvida com lote de 2 arquivos: fatos, rótulos, nota e campos novos", async () => {
    chamadas.length = 0;
    proxima = saida();
    const r = await bot.decide(payloadBase);
    assert.equal(chamadas.length, 1);
    const params = chamadas[0];

    // Bloco estático = fallback (sem BRAIN_PROMPT_URL), com cache; dinâmico com os fatos.
    assert.equal(params.system[0].text, bot.STATIC_SYSTEM_PROMPT);
    assert.deepEqual(params.system[0].cache_control, { type: "ephemeral" });
    const dinamico = params.system[1].text;
    assert.ok(dinamico.includes("CONVERSA DEVOLVIDA PELA EQUIPE (fatos do sistema):"));
    assert.ok(dinamico.includes("- Arquivos (foto/PDF) que chegaram NESTE turno: 2 — 2 aberto(s) e anexado(s) a esta mensagem, 0 NÃO aberto(s)."));
    assert.ok(dinamico.includes("PEDIDO DO ATENDENTE EM ABERTO (fatos do sistema):"));
    assert.ok(dinamico.includes("ETAPA ATUAL DA CONVERSA: nenhuma em andamento (última registrada: encerrando; depois dela a conversa esteve com a equipe)"));
    assert.ok(dinamico.includes("\n(vazia)\n"));

    // Histórico preservado (antes o "encerrando" zerava tudo sem desfecho).
    const ultima = params.messages[params.messages.length - 1];
    assert.equal(params.messages.length, 3);
    assert.deepEqual(ultima.content[0], { type: "text", text: '[anexo 1 de 2: PDF "CNIS.pdf"]' });
    assert.equal(ultima.content[1].type, "document");
    assert.deepEqual(ultima.content[2], { type: "text", text: "[anexo 2 de 2: imagem]" });
    assert.equal(ultima.content[3].type, "image");
    const texto = ultima.content[4].text;
    assert.ok(texto.includes("[FATO DO SISTEMA: a última mensagem enviada ao cliente antes desta foi de um [atendente] da equipe, não sua.]"));
    assert.ok(!texto.includes("CONVERSA QUE ESTAVA COM O ATENDENTE"));

    // Resposta: campos novos.
    assert.equal(r.rationale, "cliente mandou 2 de 3 itens; falta a CTPS");
    assert.equal(r.model, "claude-sonnet-5");
    assert.deepEqual(r.brain, { source: "fallback", instructionsVersion: null, playbookVersion: null, stale: false });
    assert.equal(r.handoffAfterFlow, false);
    assert.equal(r.state, "coleta_documentos");
    assert.equal(r.action, "continue");
    assert.ok(!r.reply.includes("cliente mandou"), "raciocínio nunca no reply");
});

test("'assinei': send_flow + handoffAfterFlow com motivo passa; sem motivo é descartado", async () => {
    proxima = saida({
        reply: "Obrigada! Vou te mandar a lista do que precisamos 👇",
        action: "send_flow",
        flowName: "LISTA DE DOCUMENTOS - INSS",
        handoffReason: "cliente diz que assinou — conferir a assinatura na ZapSign",
        handoffAfterFlow: true,
    });
    const ok = await bot.decide({ ...payloadBase, mediaList: null, message: "assinei" });
    assert.equal(ok.action, "send_flow");
    assert.equal(ok.flowName, "LISTA DE DOCUMENTOS - INSS");
    assert.equal(ok.handoffAfterFlow, true);
    assert.equal(ok.handoffReason, "cliente diz que assinou — conferir a assinatura na ZapSign");

    proxima = saida({ action: "send_flow", flowName: "LISTA DE DOCUMENTOS - INSS", handoffReason: "", handoffAfterFlow: true });
    const semMotivo = await bot.decide({ ...payloadBase, mediaList: null, message: "assinei" });
    assert.equal(semMotivo.handoffAfterFlow, false);

    proxima = saida({ action: "handoff", handoffReason: "x", handoffAfterFlow: true });
    const semFluxo = await bot.decide({ ...payloadBase, mediaList: null, message: "assinei" });
    assert.equal(semFluxo.handoffAfterFlow, false);
});

test("contato novo de verdade continua zerando (sem fatos da equipe)", async () => {
    chamadas.length = 0;
    proxima = saida({ state: "saudacao" });
    await bot.decide({
        ...payloadBase,
        state: null,
        priorOutcome: null,
        conversationFacts: { docsReceived: 0 },
        mediaList: null,
        message: "oi",
        history: [{ role: "bot", text: "conversa velha" }],
    });
    const params = chamadas[0];
    assert.equal(params.messages.length, 1, "histórico zerado");
    assert.ok(params.system[1].text.includes("(vazia — conversa nova)"));
    assert.ok(params.system[1].text.includes("ETAPA ATUAL DA CONVERSA: saudacao"));
});

test("lote maior que o teto: não abertos declarados sem 'o atendente vê todos'", async () => {
    chamadas.length = 0;
    proxima = saida();
    const mediaList = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, url: `https://s3/${i}`, mimeType: "application/pdf", fileName: `doc${i + 1}.pdf` }));
    await bot.decide({ ...payloadBase, mediaList, conversationFacts: { ...payloadBase.conversationFacts, docsThisTurn: 10, docsReceived: 10 } });
    const params = chamadas[0];
    assert.ok(params.system[1].text.includes("NESTE turno: 10 — 8 aberto(s) e anexado(s) a esta mensagem, 2 NÃO aberto(s)."));
    const ultima = params.messages[params.messages.length - 1];
    const rotulos = ultima.content.filter((c) => c.type === "text" && c.text.startsWith("[anexo "));
    assert.equal(rotulos.length, 8);
    assert.equal(rotulos[7].text, '[anexo 8 de 10: PDF "doc8.pdf"]');
    const texto = ultima.content[ultima.content.length - 1].text;
    assert.ok(texto.includes("[mais 2 arquivo(s) deste turno NÃO foram abertos nesta chamada (limite por mensagem) — você não viu o conteúdo deles]"));
    assert.ok(!texto.includes("o atendente humano vê todos"));
});

test("getBrainPrompt sem BRAIN_PROMPT_URL = fallback", async () => {
    const { text, info } = await bot.getBrainPrompt();
    assert.equal(text, bot.STATIC_SYSTEM_PROMPT);
    assert.deepEqual(info, { source: "fallback", instructionsVersion: null, playbookVersion: null, stale: false });
});
