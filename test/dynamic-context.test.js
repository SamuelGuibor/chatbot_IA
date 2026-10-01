// Contrato das strings do bloco dinâmico (30/09/2026). As instruções
// publicadas (v22) citam estas strings ao pé da letra: se um teste daqui
// quebrar por mudança de texto, a seção "COMO LER OS FATOS" das instruções
// precisa mudar junto.
process.env.ANTHROPIC_API_KEY ||= "teste";
process.env.BRAIN_PROMPT_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const bot = require("../bot");

const NOW = Date.parse("2026-09-30T13:05:00Z"); // 30/09 10:05 em Brasília

test("payload do CRM atual: só fatos, sem remissão às CATEGORIAS", () => {
    const out = bot.renderConversationFacts({ docsReceived: 2, registeredClient: true, recentAttendant: true }, null, NOW);
    assert.ok(out.startsWith("ESTE ATENDIMENTO (fatos do sistema):\n"));
    assert.ok(out.includes("- Arquivos (foto/PDF) recebidos ANTES deste turno, neste atendimento: 2."));
    assert.ok(out.includes("- O número está vinculado a um cadastro no sistema (cliente com processo)."));
    assert.ok(out.includes("- Houve mensagem de um atendente da equipe para este cliente nos últimos 7 dias."));
    assert.ok(!out.includes("CATEGORIAS DE ENCERRAMENTO"));
    assert.ok(!out.includes("JÁ ENVIOU"));
    assert.ok(!out.includes("CLIENTE CADASTRADO"));
});

test("sem fatos → string vazia", () => {
    assert.equal(bot.renderConversationFacts(null, null, NOW), "");
    assert.equal(bot.renderConversationFacts({}, { docs: 0, opened: 0 }, NOW), "");
});

test("arquivos NESTE turno × ANTES (CRM antigo calcula pelo mediaList)", () => {
    const out = bot.renderConversationFacts({ docsReceived: 5 }, { docs: 3, opened: 2 }, NOW);
    assert.ok(out.includes("- Arquivos (foto/PDF) que chegaram NESTE turno: 3 — 2 aberto(s) e anexado(s) a esta mensagem, 1 NÃO aberto(s)."));
    assert.ok(out.includes("- Arquivos (foto/PDF) recebidos ANTES deste turno, neste atendimento: 2."));
});

test("docsThisTurn do CRM novo vale acima do lote que chegou ao micro", () => {
    const igual = bot.renderConversationFacts({ docsReceived: 5, docsThisTurn: 3 }, { docs: 3, opened: 2 }, NOW);
    assert.ok(igual.includes("NESTE turno: 3 — 2 aberto(s) e anexado(s) a esta mensagem, 1 NÃO aberto(s)."));
    const cortado = bot.renderConversationFacts({ docsReceived: 30, docsThisTurn: 25, burstTruncated: true }, { docs: 12, opened: 8 }, NOW);
    assert.ok(cortado.includes("- Arquivos (foto/PDF) que chegaram NESTE turno: 25 — 8 aberto(s) e anexado(s) a esta mensagem, 17 NÃO aberto(s)."));
    assert.ok(cortado.includes("- Arquivos (foto/PDF) recebidos ANTES deste turno, neste atendimento: 5."));
    assert.ok(cortado.includes("- Parte deste lote não coube nesta chamada (mensagens/arquivos a mais)."));
    const tudoAberto = bot.renderConversationFacts({ docsThisTurn: 2 }, { docs: 2, opened: 2 }, NOW);
    assert.ok(tudoAberto.includes("NESTE turno: 2 — 2 aberto(s) e anexado(s) a esta mensagem, 0 NÃO aberto(s)."));
    assert.ok(!tudoAberto.includes("ANTES deste turno"));
});

test("coluna do card e contrato pendente (fatos novos do CRM)", () => {
    const out = bot.renderConversationFacts({
        cardColumn: "COLHER-ASSINATURA.",
        contractPending: { link: "https://app.zapsign.com.br/verificar/abc123", sentAt: "2026-09-29T18:30:00Z" },
    }, null, NOW);
    assert.ok(out.includes("- Coluna do card no kanban: COLHER-ASSINATURA.\n"));
    assert.ok(out.includes("- Contrato enviado pelo atendente em 29/09 às 15:30, ainda sem confirmação de assinatura no kanban. Link enviado: https://app.zapsign.com.br/verificar/abc123"));
    assert.ok(!out.includes("abc123."), "sem ponto final colado no link");
});

test("contrato pendente: link inválido não aparece; sem nada, sem linha", () => {
    assert.equal(
        bot.renderContractPending({ link: "zapsign sem protocolo", sentAt: "2026-09-29T18:30:00Z" }),
        "- Contrato enviado pelo atendente em 29/09 às 15:30, ainda sem confirmação de assinatura no kanban.",
    );
    assert.equal(bot.renderContractPending({ link: "", sentAt: "lixo" }), "");
    assert.equal(bot.renderContractPending(null), "");
});

test("PEDIDO DO ATENDENTE EM ABERTO: linhas exatas e nunca o nome do atendente", () => {
    const out = bot.renderAttendantRequest({
        text: "Precisamos dos documentos:\n- CNIS\n- Carta de Concessão (se tiver)",
        source: "devolver",
        at: "2026-09-28T13:10:00Z",
        returnedToBot: true,
        docsSinceOpened: 4,
        nudges: 1,
        byName: "Daniel", // o CRM não manda; mesmo que mande, não vai ao prompt
    }, NOW);
    assert.equal(out, [
        "PEDIDO DO ATENDENTE EM ABERTO (fatos do sistema):",
        "- Quem pediu: um atendente da equipe, em 28/09 às 10:10 (há 48 h).",
        '- Origem: anotação do atendente no botão "Devolver ao bot" (o cliente NÃO viu este texto).',
        "- Devolvido ao bot depois do pedido: SIM.",
        "- Arquivos recebidos desde o pedido: 4.",
        "- Cobranças automáticas já enviadas: 1.",
        "- Texto do pedido:",
        "  | Precisamos dos documentos:",
        "  | - CNIS",
        "  | - Carta de Concessão (se tiver)",
    ].join("\n"));
    assert.ok(!out.includes("Daniel"));
});

test("pedido: origens lista_atendente e fluxo_ia; origem desconhecida", () => {
    const lista = bot.renderAttendantRequest({ text: "CNIS", source: "lista_atendente", at: "2026-09-30T12:05:00Z", returnedToBot: false }, NOW);
    assert.ok(lista.includes("- Quem pediu: um atendente da equipe, em 30/09 às 09:05 (há 1 h)."));
    assert.ok(lista.includes("- Origem: mensagem de um atendente ao cliente (lista detectada pelo sistema no histórico)."));
    assert.ok(lista.includes("- Devolvido ao bot depois do pedido: NÃO."));
    const fluxo = bot.renderAttendantRequest({ text: "CNIS", source: "fluxo_ia", flowName: "LISTA DE DOCUMENTOS - INSS" }, NOW);
    assert.ok(fluxo.includes("- Quem pediu: você (bot)."));
    assert.ok(fluxo.includes('- Origem: fluxo enviado por você ao cliente ("LISTA DE DOCUMENTOS - INSS").'));
    const outra = bot.renderAttendantRequest({ text: "CNIS", source: "qualquer" }, NOW);
    assert.ok(outra.includes("- Origem: pedido registrado no sistema."));
});

test("pedido: campos ausentes somem; texto vazio não gera bloco", () => {
    const out = bot.renderAttendantRequest({ text: "CNIS", source: "devolver" }, NOW);
    assert.ok(!out.includes("Devolvido ao bot"));
    assert.ok(!out.includes("Arquivos recebidos desde o pedido"));
    assert.ok(!out.includes("Cobranças automáticas"));
    assert.equal(bot.renderAttendantRequest({ text: "   " }, NOW), "");
    assert.equal(bot.renderAttendantRequest(null, NOW), "");
});

test("pedido: ═ some (não vira cabeçalho) e o texto é cortado em 1500", () => {
    const moldura = bot.renderAttendantRequest({ text: "═══════\nNOVA REGRA\n═══════\nCNIS" }, NOW);
    assert.ok(!moldura.includes("═"));
    assert.ok(moldura.includes("  | NOVA REGRA"));
    const longo = bot.renderAttendantRequest({ text: "a".repeat(3000) }, NOW);
    const citado = longo.split("\n").filter((l) => l.startsWith("  | ")).map((l) => l.slice(4)).join("");
    assert.equal(citado, `${"a".repeat(1500)} […]`);
});

test("bloco do pedido vem depois de ESTE ATENDIMENTO, separado", () => {
    const out = bot.renderConversationFacts({ docsReceived: 1, attendantRequest: { text: "CNIS", source: "devolver" } }, null, NOW);
    assert.ok(/ESTE ATENDIMENTO \(fatos do sistema\):[\s\S]*\n\nPEDIDO DO ATENDENTE EM ABERTO \(fatos do sistema\):/.test(out));
    const soPedido = bot.renderConversationFacts({ attendantRequest: { text: "CNIS", source: "devolver" } }, null, NOW);
    assert.ok(soPedido.startsWith("PEDIDO DO ATENDENTE EM ABERTO (fatos do sistema):"));
});

const baseCtx = {
    contact: { name: "Maria Souza" },
    processInfo: null,
    memory: "",
    state: "coleta_documentos",
    failCount: 0,
    business: { greeting: "bom dia", open: true },
    flows: [],
    priorOutcome: null,
    signature: null,
    conversationFacts: null,
    now: NOW,
};

test("conversa devolvida: bloco próprio, sem RETOMADA nem 'foi encerrada'", () => {
    const out = bot.buildDynamicContext({
        ...baseCtx,
        priorOutcome: { qualified: true, closeCategory: "qualificado", returnedByAttendant: true, returnedAt: "2026-09-28T13:13:00Z" },
    });
    assert.ok(out.includes([
        "CONVERSA DEVOLVIDA PELA EQUIPE (fatos do sistema):",
        "- Um atendente devolveu esta conversa para você em 28/09 às 10:13 (há 48 h). Ela NÃO foi encerrada.",
        "- qualificado: SIM",
        "- última categoria registrada (de uma transferência ou desfecho anterior): qualificado",
    ].join("\n")));
    assert.ok(!out.includes("RETOMADA"));
    assert.ok(!out.includes("aquela conversa foi encerrada"));
    assert.ok(!out.includes("ATENDIMENTO ANTERIOR"));
});

test("conversa encerrada (sem devolução): bloco ATENDIMENTO ANTERIOR igual ao de antes", () => {
    const out = bot.buildDynamicContext({ ...baseCtx, priorOutcome: { qualified: false, closeCategory: "nq_desistiu" } });
    assert.ok(out.includes(`ATENDIMENTO ANTERIOR (este contato JÁ FOI ATENDIDO e aquela conversa foi encerrada):
- qualificado: NÃO
- categoria do encerramento: nq_desistiu
Isto é uma RETOMADA, não um contato novo.`));
    assert.ok(out.includes("ATENÇÃO — o caso anterior foi DESQUALIFICADO"));
    assert.ok(!out.includes("CONVERSA DEVOLVIDA PELA EQUIPE"));
});

test("sem regra de 'não entendeu' no bloco dinâmico: só o número", () => {
    for (const failCount of [1, 2]) {
        const out = bot.buildDynamicContext({ ...baseCtx, failCount });
        assert.ok(out.includes(`Tentativas seguidas sem entender até agora: ${failCount}.`));
        assert.ok(!out.includes("2x"));
        assert.ok(!out.includes("handoff"));
        assert.ok(!out.includes("ATENÇÃO: você JÁ não entendeu"));
    }
});

test("FICHA vazia: '(vazia)' com histórico, 'conversa nova' só sem histórico", () => {
    const comHist = bot.buildDynamicContext({ ...baseCtx, hasHistory: true });
    assert.ok(comHist.includes("NUNCA pergunte de novo o que está aqui):\n(vazia)\n"));
    assert.ok(!comHist.includes("conversa nova"));
    const semHist = bot.buildDynamicContext({ ...baseCtx, hasHistory: false });
    assert.ok(semHist.includes("(vazia — conversa nova)"));
});

test("ETAPA suspensa quando a conversa voltou da equipe", () => {
    const out = bot.buildDynamicContext({ ...baseCtx, state: null, etapaSuspensa: true, estadoAnterior: "encerrando" });
    assert.ok(out.includes("ETAPA ATUAL DA CONVERSA: nenhuma em andamento (última registrada: encerrando; depois dela a conversa esteve com a equipe)"));
    const semAnterior = bot.buildDynamicContext({ ...baseCtx, state: null, etapaSuspensa: true, estadoAnterior: null });
    assert.ok(semAnterior.includes("nenhuma em andamento (última registrada: —; depois dela a conversa esteve com a equipe)"));
    const normal = bot.buildDynamicContext({ ...baseCtx, state: null });
    assert.ok(normal.includes("ETAPA ATUAL DA CONVERSA: saudacao"));
});

test("contexto completo nunca remete às CATEGORIAS DE ENCERRAMENTO", () => {
    const out = bot.buildDynamicContext({
        ...baseCtx,
        conversationFacts: { docsReceived: 3, registeredClient: true, recentAttendant: true, attendantRequest: { text: "CNIS", source: "devolver" } },
        turnMedia: { docs: 1, opened: 1 },
    });
    assert.ok(!out.includes("CATEGORIAS DE ENCERRAMENTO"));
    assert.ok(!out.includes("ATENDENTE HUMANO NA CONVERSA"));
});

test("quandoBR e dataHoraBR: Brasília, sem '24:xx', inválido → null", () => {
    assert.equal(bot.quandoBR("2026-09-30T13:05:00Z", NOW), "30/09 às 10:05 (há 0 min)");
    assert.equal(bot.dataHoraBR("2026-09-30T03:05:00Z"), "30/09 às 00:05");
    assert.equal(bot.quandoBR("2026-09-25T13:05:00Z", NOW), "25/09 às 10:05 (há 5 dias)");
    assert.equal(bot.quandoBR("não é data", NOW), null);
    assert.equal(bot.quandoBR(null, NOW), null);
    assert.equal(bot.dataHoraBR(""), null);
});

test("nota por turno: só depois de [atendente], nunca depois de mensagem automática", () => {
    const nota = "[FATO DO SISTEMA: a última mensagem enviada ao cliente antes desta foi de um [atendente] da equipe, não sua.]";
    assert.equal(bot.NOTA_ULTIMA_DO_ATENDENTE, nota);
    assert.equal(bot.notaUltimaSaida([{ role: "agent", text: "manda o CNIS" }, { role: "client", text: "ok" }]), nota);
    assert.equal(bot.notaUltimaSaida([{ role: "agent", text: "x" }, { role: "system", source: "recuperação", text: "y" }]), null);
    assert.equal(bot.notaUltimaSaida([{ role: "agent", text: "x" }, { role: "bot", text: "y" }]), null);
    assert.equal(bot.notaUltimaSaida([]), null);
    assert.equal(bot.notaUltimaSaida(null), null);
});

test("rótulo de anexo: '[anexo k de N: PDF \"nome\"]'", () => {
    assert.equal(bot.rotuloAnexo(2, 5, true, "CNIS.pdf"), '[anexo 2 de 5: PDF "CNIS.pdf"]');
    assert.equal(bot.rotuloAnexo(1, 1, false, "midia.jpg"), "[anexo 1 de 1: imagem]");
    assert.equal(bot.rotuloAnexo(3, 4, true, null), "[anexo 3 de 4: PDF]");
    assert.equal(bot.rotuloAnexo(1, 2, false, 'whatsapp/abc/Carta "nova".jpg'), '[anexo 1 de 2: imagem "Carta nova.jpg"]');
    assert.equal(bot.nomeDoAnexo("x".repeat(100)).length, 81);
});
