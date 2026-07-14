// Lógica de IA do atendimento — API do Claude (Anthropic)
//
// Migrado do Gemini para o Claude:
//   - Decisão/resposta: Claude (structured outputs com json_schema estrito)
//   - Áudio: o Claude não aceita áudio como entrada, então a transcrição
//     continua no Gemini (mesma GOOGLE_API_KEY). Se a transcrição falhar,
//     devolvemos understood=false para o fluxo de fail do app Next.
//
// Correção do loop de qualificação: o roteiro de vendas agora é rastreado
// pelo campo "state" (enum fechado) e existe critério de saída obrigatório —
// no máximo 2 tentativas de contornar objeção; depois disso o bot DECIDE
// (qualify ou disqualify). Nunca fica preso "conduzindo" para sempre.
//
// PROMPT CACHING: o system prompt é dividido em dois blocos — o ESTÁTICO
// (todas as instruções/roteiro, idêntico em toda chamada, marcado com
// cache_control) e o DINÂMICO (nome, dados do sistema, ficha, etapa, fluxos).
// O bloco estático é ~90% do input; com o cache da Anthropic ele é lido a
// custo de cache-read (10% do preço) em toda mensagem dentro do TTL de 5min.
//
// PODA POR ORÇAMENTO DE TOKENS: o histórico e a memória não entram mais "no
// bruto" — cada mensagem do histórico é clipada e o total respeita um budget;
// a ficha (memory) acima do limite é COMPACTADA por um modelo pequeno antes de
// entrar no prompt (os fatos não se perdem — são reescritos de forma densa).

const Anthropic = require("@anthropic-ai/sdk");
const { GoogleGenAI } = require("@google/genai");

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// Gemini só para transcrever áudio (Claude não recebe áudio).
const genAI = process.env.GOOGLE_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY })
    : null;

const MAX_AUDIO_BYTES = 18 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Orçamento de tokens (estimativa ~3.5 chars/token para pt-BR)
// ---------------------------------------------------------------------------
const HISTORY_TOKEN_BUDGET = 1800; // teto do histórico dentro do prompt
const HISTORY_MSG_MAX_CHARS = 600; // uma mensagem gigante não come o budget todo
const MEMORY_SOFT_CHARS = 2600;    // acima disto a ficha é compactada pela IA
const MEMORY_HARD_CHARS = 4000;    // teto absoluto (fallback se a compactação falhar)

function estTokens(text) {
    return Math.ceil((text?.length ?? 0) / 3.5);
}

function clipText(text, max) {
    if (!text || text.length <= max) return text;
    return text.slice(0, max) + " […]";
}

/**
 * Poda o histórico por orçamento de tokens: anda do MAIS NOVO para o mais
 * antigo somando tokens estimados e corta quando estoura o budget. Cada
 * mensagem individual também é clipada (HISTORY_MSG_MAX_CHARS).
 */
function pruneHistory(history, budget = HISTORY_TOKEN_BUDGET) {
    const out = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        const text = clipText(String(h.text ?? ""), HISTORY_MSG_MAX_CHARS);
        if (!text) continue;
        const cost = estTokens(text) + 4; // overhead por turno
        if (used + cost > budget && out.length > 0) break;
        used += cost;
        out.unshift({ ...h, text });
    }
    return out;
}

/**
 * Ficha (memory) acima do limite → compacta com um modelo pequeno, mantendo
 * TODOS os fatos (reescritos de forma densa, uma linha por fato). O resultado
 * compactado volta no campo `memory` da resposta e é PERSISTIDO pelo app Next,
 * então a compactação acontece no máximo uma vez por "estouro".
 */
async function compactMemory(memory) {
    const model = process.env.MODEL_SMALL || "claude-haiku-4-5-20251001";
    try {
        const response = await anthropic.messages.create({
            model,
            max_tokens: 700,
            system:
                "Você compacta fichas de atendimento de WhatsApp. Reescreva a ficha " +
                "abaixo preservando TODOS os fatos objetivos (nome, cidade, datas, " +
                "acidente, lesões, INSS, decisões, pendências), uma linha por fato, " +
                "sem comentários nem repetições. Máximo de 1200 caracteres. " +
                "Responda SOMENTE com a ficha compactada.",
            messages: [{ role: "user", content: memory }],
        });
        const text = response.content.find((b) => b.type === "text")?.text?.trim();
        if (text) {
            console.log(`[BOT] Ficha compactada: ${memory.length} → ${text.length} chars.`);
            return text;
        }
    } catch (err) {
        console.warn("[BOT] Compactação da ficha falhou (usando corte duro):", err.message);
    }
    return memory.slice(0, MEMORY_HARD_CHARS);
}

// ---------------------------------------------------------------------------
// Estados da conversa (enum fechado — é assim que o roteiro não se perde)
// ---------------------------------------------------------------------------
const STATES = [
    "saudacao",
    "coleta_nome",
    "triagem_quando_onde",
    "triagem_lesao",
    "triagem_inss",
    "script_beneficio_1",
    "script_beneficio_2",
    "script_beneficio_3",
    "script_honorarios",
    "script_fechamento",
    "pergunta_interesse",
    "contornando_objecao_1",
    "contornando_objecao_2",
    "encerrando",
];

// ---------------------------------------------------------------------------
// Schema da resposta (structured outputs — o Claude é obrigado a seguir)
// ---------------------------------------------------------------------------
const responseSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        reply: {
            type: "string",
            description: "Mensagem ÚNICA a enviar ao cliente pelo WhatsApp (pt-BR). Vazia quando action=lookup OU quando você usa 'replies' (disparo do roteiro comercial inteiro).",
        },
        replies: {
            type: "array",
            items: { type: "string" },
            description: "Lista de mensagens a enviar em SEQUÊNCIA, cada uma como uma mensagem SEPARADA no WhatsApp, SEM esperar o cliente responder entre elas. Use SOMENTE ao qualificar o lead, para disparar o roteiro comercial inteiro de uma vez (Bloco 1 até a pergunta de interesse). Nos demais casos, deixe [] e use 'reply'.",
        },
        action: {
            type: "string",
            enum: ["continue", "qualify", "disqualify", "handoff", "lookup", "send_flow", "resolve"],
            description: "continue=segue a conversa; qualify=lead novo qualificado→fila humana; disqualify=lead sem direito/interesse→encerra; handoff=transfere pra atendente humano; lookup=consulta o banco (deixe reply=\"\"); send_flow=dispara um fluxo cadastrado (preencha flowName); resolve=assunto resolvido pelo bot (dúvida/status)→encerra como 'perguntas'.",
        },
        flowName: {
            type: "string",
            description: "Nome EXATO de um fluxo cadastrado (ver FLUXOS DISPONÍVEIS) a disparar quando action=send_flow. Vazio nos outros casos.",
        },
        closeCategory: {
            type: "string",
            enum: ["qualificado", "nao_qualificado", "perguntas", "novo_acidente", "transferido", "nenhum"],
            description: "Categoria de encerramento do assunto. Use ao qualify/disqualify/handoff/resolve; 'nenhum' quando a conversa continua.",
        },
        handoffReason: {
            type: "string",
            description: "Motivo curto da transferência/qualificação. Vazio se não se aplica.",
        },
        lookup: {
            type: "string",
            enum: ["status_processo", "dados_cadastro", "documentos_enviados", "nenhum"],
        },
        memory: {
            type: "string",
            description: "FICHA COMPLETA e atualizada dos fatos da conversa (fatos antigos + novos), uma linha por fato.",
        },
        state: {
            type: "string",
            enum: STATES,
            description: "Etapa em que a conversa ESTÁ agora, após esta resposta.",
        },
        intent: {
            type: "string",
            enum: ["novo_lead", "cliente_existente", "duvida", "financeiro", "suporte", "documentos", "reclamacao", "outro"],
        },
        emotion: {
            type: "string",
            enum: ["neutro", "triste", "irritado", "ansioso", "confuso", "feliz"],
        },
        urgent: { type: "boolean" },
        understood: { type: "boolean" },
        confidence: { type: "number" },
        optOut: {
            type: "boolean",
            description: "true SOMENTE se o cliente pediu CLARAMENTE, pelo contexto, para PARAR de receber mensagens/ser descadastrado (ex.: 'não quero mais receber', 'me tira dessa lista', 'para de me mandar mensagem'). NÃO marque true quando 'sair'/'parar' aparecem em outro sentido (ex.: 'vou precisar sair, mas já volto', 'quero sair da fila do INSS', 'pode parar de me ligar' — ligação não é WhatsApp). Na dúvida, deixe false.",
        },
    },
    required: [
        "reply", "replies", "action", "flowName", "closeCategory", "handoffReason",
        "lookup", "memory", "state", "intent", "emotion", "urgent", "understood", "confidence", "optOut",
    ],
};

// ---------------------------------------------------------------------------
// Validação CPF / email / data em código (a IA recebe como nota de sistema)
// ---------------------------------------------------------------------------
function isValidCPF(raw) {
    const cpf = raw.replace(/\D/g, "");
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    for (const len of [9, 10]) {
        let sum = 0;
        for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
        const digit = ((sum * 10) % 11) % 10;
        if (digit !== Number(cpf[len])) return false;
    }
    return true;
}

function validationNotes(text) {
    const notes = [];
    if (!text) return notes;

    const cpfMatch = text.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
    if (cpfMatch) {
        notes.push(isValidCPF(cpfMatch[0])
            ? `NOTA DO SISTEMA: o CPF ${cpfMatch[0]} é válido.`
            : `NOTA DO SISTEMA: o CPF ${cpfMatch[0]} parece inválido. Peça confirmação ao cliente.`);
    }

    const emailMatch = text.match(/\S+@\S+/);
    if (emailMatch && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailMatch[0])) {
        notes.push(`NOTA DO SISTEMA: o email ${emailMatch[0]} parece inválido.`);
    }

    const dateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
    if (dateMatch) {
        const [, d, m] = dateMatch;
        if (Number(d) > 31 || Number(m) > 12) {
            notes.push(`NOTA DO SISTEMA: a data ${dateMatch[0]} parece inválida.`);
        }
    }

    return notes;
}

// ---------------------------------------------------------------------------
// System Prompt — BLOCO ESTÁTICO (idêntico em toda chamada → prompt caching).
//
// Regra de ouro desta constante: NADA dinâmico aqui dentro. Nome do cliente,
// dados do sistema, ficha, etapa, fluxos e horário entram no bloco DINÂMICO
// (buildDynamicContext). Nos exemplos, "[nome]" e "[saudação do horário]" são
// placeholders que a IA substitui pelos valores do bloco de dados.
// ---------------------------------------------------------------------------
const STATIC_SYSTEM_PROMPT = `
Você é a assistente virtual de um escritório que ajuda vítimas de acidente a
conseguir o AUXÍLIO-ACIDENTE do INSS. Você conversa com CLIENTES pelo WhatsApp.
Seja humana, calorosa e natural — nunca robótica. Mensagens CURTAS (é WhatsApp).

Ao final destas instruções há um bloco "DADOS DA CONVERSA" com: o nome do
cliente (se conhecido), os dados do sistema, a ficha de fatos, a etapa atual,
os fluxos disponíveis e o horário. Nos exemplos abaixo, substitua "[nome]"
pelo nome do cliente (só o primeiro nome) e "[saudação do horário]" pela
saudação indicada nos dados (bom dia / boa tarde / boa noite). Se você ainda
não sabe o nome, cumprimente sem ele.

EMOJI — USE COM MODERAÇÃO: no máximo 1 emoji a cada 2-3 mensagens, nunca mais
de um emoji na MESMA mensagem. A maioria das suas respostas deve sair SEM
nenhum emoji — trate os emojis dos exemplos abaixo como opcionais/ilustrativos,
não como obrigatórios em toda resposta. Mensagens seguidas com emoji em todas
soam artificiais e cansam o cliente.

═══════════════════════════════════════
REGRAS ANTI-SPAM (OBRIGATÓRIAS — a conta pode ser punida pela Meta):
═══════════════════════════════════════

- NUNCA repita uma mensagem que você já enviou. Se você já cumprimentou ou já
  ofereceu ajuda e o cliente ainda não respondeu de forma clara, NÃO reenvie a
  mesma saudação/oferta — apenas reformule de forma breve UMA vez, ou aguarde.
- Olhe o HISTÓRICO: se a sua última mensagem já foi uma saudação/oferta, não
  mande outra igual. Reenviar a mesma coisa várias vezes é tratado como SPAM.
- DESCADASTRO (optOut): marque o campo optOut=true SOMENTE quando o cliente
  pedir CLARAMENTE, PELO CONTEXTO, para parar de receber suas mensagens. Ex.
  reais de opt-out: "não quero mais receber", "me tira dessa lista", "para de
  me mandar mensagem", "não me manda mais nada". Nesses casos: optOut=true,
  action="disqualify", state="encerrando", reply=despedida curta e respeitosa.
  ATENÇÃO — NÃO é opt-out (deixe optOut=false) quando a palavra aparece em outro
  sentido, por exemplo: "vou precisar sair, mas já volto", "quero sair da fila
  do INSS", "pode parar de me ligar" (ligação ≠ WhatsApp), "parar o processo".
  Julgue pela INTENÇÃO na conversa, não pela palavra isolada. Na dúvida, false.
- Não envie sequências longas de mensagens sem o cliente pedir. Prefira poucas
  mensagens e sempre com propósito.

═══════════════════════════════════════
COMO USAR O CAMPO "state" (OBRIGATÓRIO):
═══════════════════════════════════════

O campo "state" rastreia EXATAMENTE onde a conversa está. Etapas, em ordem:

1. saudacao             → cumprimente o cliente pelo nome (se souber) ("Olá, [nome]! Como o que eu posso te ajudar ?")
2. coleta_nome          → Somente se não souber o nome do cliente, pergunte ("Como posso te chamar?"). NÃO peça outros dados pessoais.
3. triagem_quando_onde  → "1️⃣ Quando e onde foi o acidente?"
4. triagem_lesao        → "2️⃣ O que você machucou?"
5. triagem_inss         → "3️⃣ Ficou afastado pelo INSS na época?"
6. script_beneficio_1   → enviou a Mensagem 1 do roteiro
7. script_beneficio_2   → enviou a Mensagem 2
8. script_beneficio_3   → enviou a Mensagem 3
9. script_honorarios    → enviou a Mensagem 4
10. script_fechamento   → enviou a Mensagem 5
11. pergunta_interesse  → perguntou se quer falar com atendente
12. contornando_objecao_1 → 1ª tentativa de contornar dúvida/objeção
13. contornando_objecao_2 → 2ª (e ÚLTIMA) tentativa
14. encerrando          → decisão tomada (qualify/disqualify/handoff)

REGRA DE OURO: olhe a ETAPA ATUAL (nos DADOS DA CONVERSA) e avance UMA etapa
por resposta. Nunca repita uma etapa já concluída (os fatos já coletados estão
na FICHA). EXCEÇÃO: ao QUALIFICAR o lead, você salta direto da triagem para
"pergunta_interesse" disparando TODOS os blocos do roteiro comercial de uma
vez pelo campo "replies" (ver CRITÉRIO DE QUALIFICAÇÃO).

═══════════════════════════════════════
PRIORIDADE Nº 0 — O CLIENTE JÁ É CADASTRADO? (RETORNO)
═══════════════════════════════════════

Olhe os DADOS DO SISTEMA (no bloco de dados). Se o número JÁ ESTÁ VINCULADO A
UM CADASTRO, este NÃO é um lead novo — é um CLIENTE EXISTENTE voltando a falar.
Cada conversa começa do ZERO: o assunto anterior (encaminhamento, qualificação,
triagem) já foi ENCERRADO. Você mantém APENAS o nome do cliente.

Neste caso, IGNORE por completo o roteiro de vendas de lead novo (triagem de
acidente, mensagens de benefício, honorários). Faça assim:

- Na saudação / 1ª mensagem, CUMPRIMENTE pelo nome com a saudação do horário,
  diga que viu que ele já tem cadastro, e OFEREÇA verificar a situação do
  processo. Ex.: "Olá, [nome], [saudação do horário]! Vi aqui que você já é
  nosso cliente. Gostaria que eu verificasse como está a situação do seu
  processo?"
- Se ele confirmar que quer saber do processo → action="lookup",
  lookup="status_processo", reply="" (veja "CONSULTA DE STATUS DO PROCESSO"
  abaixo para como responder: mensagem formatada OU disparar um fluxo).
- Se ele trouxer um ASSUNTO NOVO — ex.: sofreu um NOVO acidente e quer nova
  análise — NÃO faça a triagem sozinha: encaminhe para um atendente humano
  (action="handoff", state="encerrando", closeCategory="novo_acidente",
  handoffReason="cliente já cadastrado solicita análise de novo acidente").
- NUNCA repita frases de um atendimento anterior ("já te encaminhei", "estamos
  cuidando do seu caso") — aquilo é passado; este é um contato NOVO.
- Enquanto só cumprimenta e oferece ajuda, use state="saudacao".

Se o número NÃO tem cadastro, ele é um LEAD NOVO — siga a triagem abaixo.

═══════════════════════════════════════
ETAPA - TRIAGEM DE NOVOS CLIENTES:
═══════════════════════════════════════

O objetivo inicial é APENAS descobrir se o cliente tem potencial direito ao
Auxílio-Acidente. NÃO peça CPF, RG, endereço, documentos ou dados pessoais.

Na primeira pergunta da triagem, introduza:

"Quero ver se você tem direito a algum tipo de indenização.

Para eu analisar seu caso, preciso que você responda só essas perguntas:"

Sempre faça essas perguntas para a triagem, nunca esqueça de pular as perguntas, e sempre UMA por vez (etapas 3, 4 e 5). Aguarde cada resposta.

═══════════════════════════════════════
CRITÉRIO DE QUALIFICAÇÃO:
═══════════════════════════════════════

Após as 3 respostas da triagem, analise se existe possibilidade de
Auxílio-Acidente. Sinais positivos:
- Acidente de qualquer natureza  (de trânsito, de trabalho, doméstico ou até de lazer)
- Houve lesão, com fratura, que trouxe incapacidade laboral, mesmo que com sequela mínima e parcial!
- Houve afastamento pelo INSS, recebeu auxílio a época do acidente! Ou caso tenha trabalhado com registro em carteira de trabalho até 12 meses antes do acidente, pode ter direito a receber o auxílio Acidente!
- Caso o Acidente tenha ocorrido nos últimos 20 anos (apartir de 2006) existe a possibilidade de trabalharmos na ação!

Se o caso parecer compatível: NÃO peça mais informações, NÃO faça novas
perguntas. O lead já está QUALIFICADO.

⚠️ DISPARE O ROTEIRO COMERCIAL INTEIRO DE UMA VEZ (sem esperar o cliente
responder entre as mensagens). Para isso, na MESMA resposta:
- Coloque CADA bloco abaixo como um item SEPARADO do campo "replies", NESTA
  ordem (Bloco 1, 2, 3, 4, 5 e por último a pergunta de interesse). Cada item
  vira uma mensagem separada no WhatsApp, enviada em sequência.
- Deixe "reply" = "" (você está usando "replies", não "reply").
- Defina state = "pergunta_interesse" (você JÁ fez a pergunta de interesse) e
  action = "continue".
A PRÓXIMA mensagem do cliente já é a resposta à pergunta de interesse — vá
direto para a DECISÃO FINAL.

Conteúdo dos blocos (um por item de "replies", nesta ordem):

Bloco 1:
"Pelo seu caso, você tem grande chance de conseguir um benefício chamado Auxílio-Acidente."

Bloco 2:
"Quando a pessoa sofre um acidente (como o seu) e fica com alguma sequela — mesmo que tenha voltado a trabalhar — ela pode ter direito ao Auxílio-Acidente do INSS."

Bloco 3:
"Esse benefício é:

- Um valor pago todo mês
- Em média 50% do seu salário
- Você pode trabalhar e receber ao mesmo tempo
- E ele vai até a sua aposentadoria

Além disso, podem existir valores atrasados desde quando o INSS parou seu auxílio-doença."

Bloco 4:
"A gente resolve tudo pra você, sem burocracia.

- Não cobramos nada antecipado
- Você só paga se ganhar

E funciona assim:

- Apenas as 5 primeiras parcelas do benefício

E CASO tenha valores atrasados para receber:
- 30% somente do valor que o juiz determinar.

Depois disso, você continua recebendo normalmente, sem pagar mais nada."

Bloco 5:
"E o melhor: a análise inicial do seu caso é gratuita."

Bloco 6 (pergunta de interesse):
"Você tem interesse em seguir com a gente e conversar com um dos nossos atendentes para analisar melhor seu caso?"

═══════════════════════════════════════
DECISÃO FINAL (CRITÉRIO DE SAÍDA OBRIGATÓRIO):
═══════════════════════════════════════

Depois de pergunta_interesse:

1. Cliente demonstra interesse ("sim", "quero", "pode ser", "como funciona
   pra fechar") → action="qualify", state="encerrando",
   reply: "Perfeito! Vou te encaminhar para um dos nossos atendentes para continuar o atendimento."

2. Cliente recusa claramente ("não", "não quero", "sem interesse")
   → action="disqualify", state="encerrando",
   reply: "Sem problema, obrigado por conversar com a gente. Caso mude de ideia no futuro, estaremos à disposição."

3. Cliente demonstra dúvida SEM negar (ex.: "não sei", "vou pensar", "depois
   eu vejo") → tente contornar NO MÁXIMO 2 VEZES:
   - 1ª vez → state="contornando_objecao_1". Exemplo:
     "Entendo. Mas pelo que você me contou, pode existir uma oportunidade importante no seu caso.
     Vale a pena conversar com um especialista para confirmar se você realmente tem direito. Posso te encaminhar?"
   - 2ª vez → state="contornando_objecao_2" (última tentativa, reformule).
   - Se o state atual JÁ É contornando_objecao_2 e o cliente continuar em
     dúvida ou não responder claramente: PARE de insistir. Se ele demonstrou
     qualquer abertura, action="qualify" (a equipe humana continua). Se não,
     action="disqualify". NUNCA fique em loop tentando convencer.

4. Cliente pede atendente/humano/advogado em QUALQUER etapa
   → action="handoff", state="encerrando".

═══════════════════════════════════════
CASOS NÃO QUALIFICADOS:
═══════════════════════════════════════

Se ficar claro que:
- Não houve acidente.
- Não teve nenhuma lesão.
- Não existe qualquer possibilidade de sequela.

Explique com educação que provavelmente não se enquadra e marque
action="disqualify", state="encerrando". Não transfira para atendente.

═══════════════════════════════════════
CONSULTAS DISPONÍVEIS (action="lookup" + campo "lookup"):
═══════════════════════════════════════
- "status_processo": etapa e tipo de serviço do processo do cliente.
- "dados_cadastro": se o número tem cadastro e o nome registrado.
- "documentos_enviados": QUANTOS documentos o cliente já enviou (nunca o conteúdo).
Use lookup quando o cliente perguntar algo que essas consultas respondem e o
dado ainda não estiver nos DADOS DO SISTEMA. Com action="lookup", deixe reply="".

═══════════════════════════════════════
CONSULTA DE STATUS DO PROCESSO (cliente cadastrado):
═══════════════════════════════════════

Quando o cliente cadastrado quiser saber do processo, faça action="lookup",
lookup="status_processo", reply="". Ao receber o RESULTADO DA CONSULTA:

1. Se encontrou (encontrado=true), você tem a ETAPA e o SERVIÇO. Então escolha:
   a) RESPOSTA FORMATADA: uma mensagem curta, calorosa e clara com a etapa
      atual. Ex.:
      "Prontinho, [nome]! Seu processo ([serviço]) está atualmente na etapa: *[etapa]*.
      Assim que houver uma nova atualização, a gente te avisa por aqui."
   b) OU, se houver um FLUXO cadastrado cuja DESCRIÇÃO se encaixa melhor nessa
      etapa/situação, dispare-o: action="send_flow", flowName="<nome exato>".
      (Escolha o fluxo pela descrição — é ela que diz para qual situação ele
      serve. Só use send_flow se realmente casar; senão, use a resposta (a).)
   Depois de informar, pergunte se ele precisa de mais alguma coisa.
2. Se NÃO encontrou (encontrado=false / sem status), NÃO invente: passe para um
   atendente humano verificar → action="handoff", closeCategory="perguntas",
   handoffReason="cliente cadastrado pediu status e não há processo/etapa no
   sistema — atendente verifica".
3. Se o cliente disser que NÃO precisa de mais nada, encerre educadamente:
   action="resolve", closeCategory="perguntas", state="encerrando",
   reply="Perfeito! Qualquer coisa é só chamar por aqui. Tenha um ótimo dia."

═══════════════════════════════════════
FLUXOS DISPONÍVEIS (você pode disparar com action="send_flow" + flowName):
═══════════════════════════════════════

A lista de fluxos cadastrados está nos DADOS DA CONVERSA. Cada fluxo tem uma
DESCRIÇÃO que diz PARA QUAL SITUAÇÃO ele serve. Quando a situação do cliente
se encaixar numa descrição, você pode disparar o fluxo com action="send_flow"
e flowName EXATAMENTE igual ao nome listado. Se nenhum fluxo se encaixa,
responda normalmente por texto.

═══════════════════════════════════════
CATEGORIAS DE ENCERRAMENTO (campo closeCategory):
═══════════════════════════════════════
- "qualificado"      → lead novo com potencial direito (foi para a fila humana).
- "nao_qualificado"  → lead sem direito ou sem interesse.
- "perguntas"        → cliente (geralmente cadastrado) só tirou dúvida/status.
- "novo_acidente"    → cliente cadastrado quer análise de um NOVO acidente.
- "transferido"      → transferido ao atendente por outro motivo.
- "nenhum"           → a conversa continua (não encerrou).
Preencha closeCategory sempre que qualify/disqualify/handoff/resolve; use
"nenhum" quando action=continue/lookup/send_flow.

═══════════════════════════════════════
O QUE VOCÊ NUNCA PODE FAZER:
═══════════════════════════════════════

- NUNCA prometa que um atendente vai LIGAR, retornar "em breve", "em X minutos"
  ou em qualquer prazo. Você NÃO controla a agenda de ninguém. Ao transferir,
  diga apenas que um atendente vai continuar a conversa POR AQUI, pelo WhatsApp.
- NUNCA invente status do processo, prazos, valores ou aprovação.
- NUNCA revele CPF, RG, endereço ou dados sensíveis armazenados — nem para o
  próprio cliente (não dá pra confirmar identidade por WhatsApp). Pode informar
  apenas: status/etapa do processo, tipo de serviço e quantidade de documentos.
- NUNCA dê aconselhamento jurídico específico — papel do time humano.

═══════════════════════════════════════
FICHA (memory):
═══════════════════════════════════════

A FICHA ATUAL (fatos já coletados) está nos DADOS DA CONVERSA — NUNCA pergunte
de novo o que já está nela. Em TODA resposta, devolva no campo "memory" a
ficha COMPLETA atualizada (copie os fatos antigos e acrescente os novos).

═══════════════════════════════════════
REGRAS IMPORTANTES:
═══════════════════════════════════════

- Na TRIAGEM (antes de qualificar): sempre UMA pergunta por vez, esperando a resposta do cliente entre elas.
- Ao QUALIFICAR: dispare o roteiro comercial INTEIRO de uma vez pelo campo "replies" (Blocos 1 a 6), como mensagens separadas, SEM esperar resposta entre elas.
- O objetivo é criar conexão e desejo antes do qualify.
- Nunca prometa que ele vai ganhar.
- Use "grande chance", "possibilidade", "pode ter direito".
- Nunca invente valores ou aprovação.
- Seja humana, calorosa e natural.
- WhatsApp: mensagens curtas.
- RESPOSTAS CURTAS do cliente ("sim", "isso", "aham") = confirmação do que você perguntou.
- Se não entendeu a mensagem, understood=false e peça com jeito para repetir.
  (O número de tentativas seguidas sem entender está nos DADOS DA CONVERSA.)
`.trim();

// ---------------------------------------------------------------------------
// Bloco DINÂMICO do system prompt — tudo que muda por conversa/mensagem.
// ---------------------------------------------------------------------------
function buildDynamicContext({ contact, processInfo, memory, state, failCount, business, flows }) {
    const nome = contact?.name ? contact.name.split(" ")[0] : null;

    const flowsList = Array.isArray(flows) && flows.length
        ? flows.map((f) => `- "${f.name}": ${f.description}`).join("\n")
        : "(nenhum fluxo cadastrado)";

    return `
═══════════════════════════════════════
DADOS DA CONVERSA (fonte única da verdade — NUNCA invente além disto):
═══════════════════════════════════════

NOME DO CLIENTE: ${nome ?? "(ainda não informado — você não sabe o nome)"}
SAUDAÇÃO DO HORÁRIO: ${business?.greeting ?? "olá"}

DADOS DO SISTEMA:
${processInfo ? `- Cliente CADASTRADO no sistema.
- Nome no cadastro: ${processInfo.name ?? "—"}
- Etapa atual do processo: ${processInfo.etapa ?? "—"}
- Tipo de serviço: ${processInfo.service ?? "—"}` : "- Este número NÃO está vinculado a nenhum cadastro."}

FLUXOS DISPONÍVEIS:
${flowsList}

FICHA ATUAL (fatos já coletados — NUNCA pergunte de novo o que está aqui):
${memory || "(vazia — conversa nova)"}

ETAPA ATUAL DA CONVERSA: ${state || "saudacao"}

Tentativas seguidas sem entender até agora: ${failCount || 0}.
${business && !business.open ? `HORÁRIO: estamos FORA do horário comercial. Faça a triagem normalmente,
mas ao transferir avise: "Nossa equipe responderá ${business.reopens}."` : ""}
`.trim();
}

/**
 * Monta o array `system` com o bloco estático CACHEADO (cache_control) e o
 * bloco dinâmico por fora do cache. O dashboard já lê cacheReadTokens do
 * usage — com isto ele passa a mostrar leitura de cache de verdade.
 */
function buildSystemBlocks(params) {
    return [
        { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: buildDynamicContext(params) },
    ];
}

// ---------------------------------------------------------------------------
// Áudio: Claude não aceita áudio — transcreve no Gemini e usa como texto.
// (Também exposto no endpoint /transcribe para o botão "transcrever" do inbox.)
// ---------------------------------------------------------------------------
async function transcribeAudio(media) {
    if (!media?.url || !media?.mimeType) return null;
    if (!genAI) throw new Error("transcrição indisponível: GOOGLE_API_KEY ausente");

    const res = await fetch(media.url);
    if (!res.ok) throw new Error(`download da mídia falhou: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_AUDIO_BYTES) throw new Error("mídia grande demais para a IA");

    const response = await genAI.models.generateContent({
        model: process.env.TRANSCRIBE_MODEL || "gemini-2.5-flash",
        contents: [{
            role: "user",
            parts: [
                { text: "Transcreva este áudio em português do Brasil. Responda SOMENTE com a transcrição, sem comentários." },
                { inlineData: { mimeType: media.mimeType, data: buf.toString("base64") } },
            ],
        }],
    });

    const text = typeof response.text === "string"
        ? response.text
        : response.candidates?.[0]?.content?.parts?.[0]?.text;
    return (text ?? "").trim() || null;
}

// ---------------------------------------------------------------------------
// Uso de tokens (comum a todas as chamadas)
// ---------------------------------------------------------------------------
function usageFrom(response, model) {
    return response.usage
        ? {
            model,
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
            cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        }
        : null;
}

// ---------------------------------------------------------------------------
// Decide resposta da IA
// ---------------------------------------------------------------------------
async function decide({
    contact,
    processInfo,
    history = [],
    message = "",
    media = null,
    memory = null,
    state = null,
    failCount = 0,
    business = null,
    lookupResult = null,
    flows = [],
}) {
    const model = process.env.MODEL || "claude-sonnet-5";

    // ---- Auto-reset de ticket encerrado -------------------------------------
    // Se a etapa que chega é "encerrando", o atendimento ANTERIOR já terminou
    // (qualificado, não qualificado ou transferido). Uma mensagem nova aqui =
    // NOVO atendimento. Zeramos memória, estado e histórico para o bot não
    // ficar preso no contexto velho nem responder como se ainda estivesse
    // fechando. A ficha do cliente (nome/CPF/etapa) NÃO se perde: ela vem do
    // card via processInfo a cada chamada. Devolver memory="" + state="saudacao"
    // faz o app Next persistir o reset.
    let effMemory = memory;
    let effState = state;
    let effHistory = history;
    // Início de um NOVO atendimento. Dois casos:
    //  - state="encerrando": o ticket anterior acabou nesta mesma conversa.
    //  - state vazio/null: o encerramento (atendente ou desqualificação) JÁ
    //    zerou memória e estado, mas o histórico de mensagens antigas ainda
    //    chega aqui — e faria a IA repetir o assunto velho ("já te encaminhei").
    // Nos dois casos começamos do ZERO, mantendo só o NOME (vem do contato).
    const novoAtendimento = !state || state === "encerrando";
    if (novoAtendimento) {
        console.log(`[BOT] ${contact?.phone ?? "?"} → NOVO atendimento (memória e histórico anteriores zerados).`);
        effMemory = null;
        effState = "saudacao";
        effHistory = [];
    }

    // Ficha estourou o limite? Compacta ANTES de montar o prompt (o resultado
    // volta em `memory` e o app Next persiste — compacta 1x por estouro).
    if (effMemory && effMemory.length > MEMORY_SOFT_CHARS) {
        effMemory = await compactMemory(effMemory);
    }

    // Áudio → transcrição via Gemini. Se falhar, devolve "não entendi"
    // (o app Next cuida do failCount e do handoff após 2 falhas).
    let clientText = message;
    if (media?.url) {
        let transcript = null;
        try {
            transcript = await transcribeAudio(media);
        } catch (err) {
            console.error("[BOT] Falha ao transcrever áudio:", err.message);
        }
        if (transcript) {
            clientText = clientText ? `${clientText}\n[áudio transcrito] ${transcript}` : transcript;
        } else {
            return {
                reply: "Não consegui ouvir direito seu áudio 😅 Pode repetir ou mandar por escrito?",
                replies: [],
                action: "continue",
                handoffReason: undefined,
                lookup: null,
                memory: String(effMemory ?? ""),
                state: String(effState ?? "saudacao"),
                intent: "outro",
                emotion: "neutro",
                urgent: false,
                understood: false,
                confidence: 0.3,
            };
        }
    }

    // Histórico no formato do Claude: cliente = user; bot/atendente = assistant.
    // Poda por orçamento de tokens (mais recente primeiro) + clip por mensagem.
    const messages = pruneHistory(effHistory).map((h) => ({
        role: h.role === "client" ? "user" : "assistant",
        content: h.role === "agent" ? `[atendente humano] ${h.text}` : h.text,
    })).filter((m) => m.content);

    // Mensagem atual + notas de validação do sistema.
    const parts = [clientText || "(mensagem vazia)"];
    for (const note of validationNotes(clientText)) parts.push(note);
    if (lookupResult) {
        parts.push(`RESULTADO DA CONSULTA QUE VOCÊ PEDIU (${lookupResult.kind}):\n${JSON.stringify(lookupResult.data)}\nUse este resultado para responder AGORA (não peça a mesma consulta de novo).`);
    }
    messages.push({ role: "user", content: parts.join("\n\n") });

    const response = await anthropic.messages.create({
        model,
        max_tokens: 8192,
        system: buildSystemBlocks({ contact, processInfo, memory: effMemory, state: effState, failCount, business, flows }),
        output_config: {
            format: { type: "json_schema", schema: responseSchema },
        },
        messages,
    });
    if (response.stop_reason === "refusal") {
        // Segurança do modelo recusou — cai pra fila humana sem quebrar.
        throw new Error("modelo recusou a solicitação (refusal)");
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock?.text) throw new Error("resposta do Claude sem texto");

    let parsed;
    try {
        parsed = JSON.parse(textBlock.text);
    } catch (err) {
        console.error("Erro convertendo JSON Claude:", textBlock.text);
        throw err;
    }

    // Uso de tokens da chamada ao Claude — o app Next grava no log wa_bot e
    // calcula o gasto (semanal/mensal) no dashboard "Desempenho do Chatbot".
    const usage = usageFrom(response, model);
    if (usage) {
        console.log(`[BOT] tokens: in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} cacheWrite=${usage.cacheWriteTokens}`);
    }

    return {
        usage,
        reply: String(parsed.reply ?? "").trim(),
        replies: Array.isArray(parsed.replies)
            ? parsed.replies.map((r) => String(r).trim()).filter(Boolean)
            : [],
        action: ["continue", "qualify", "disqualify", "handoff", "lookup", "send_flow", "resolve"].includes(parsed.action)
            ? parsed.action
            : "continue",
        flowName: parsed.flowName ? String(parsed.flowName).trim() : null,
        closeCategory: parsed.closeCategory && parsed.closeCategory !== "nenhum" ? String(parsed.closeCategory) : null,
        handoffReason: parsed.handoffReason ? String(parsed.handoffReason) : undefined,
        lookup: parsed.lookup && parsed.lookup !== "nenhum" ? String(parsed.lookup) : null,
        memory: String(parsed.memory ?? effMemory ?? "").slice(0, MEMORY_HARD_CHARS),
        state: STATES.includes(parsed.state) ? parsed.state : String(effState ?? "saudacao"),
        intent: String(parsed.intent ?? "outro"),
        emotion: String(parsed.emotion ?? "neutro"),
        urgent: Boolean(parsed.urgent),
        understood: parsed.understood !== false,
        confidence: Math.min(Math.max(Number(parsed.confidence ?? 0.8), 0), 1),
        optOut: Boolean(parsed.optOut),
    };
}

// ---------------------------------------------------------------------------
// SUGESTÃO DE RESPOSTA para o ATENDENTE HUMANO (agent-assist).
// A IA propõe a próxima mensagem; o humano revisa, edita e envia.
// ---------------------------------------------------------------------------
async function suggest({ contact, processInfo, history = [], memory = null, agentName = null }) {
    const model = process.env.MODEL || "claude-sonnet-5";
    const nome = contact?.name ? contact.name.split(" ")[0] : null;

    const transcript = pruneHistory(history, 2200)
        .map((h) => `${h.role === "client" ? "Cliente" : h.role === "agent" ? "Atendente" : "Bot"}: ${h.text}`)
        .join("\n");

    const response = await anthropic.messages.create({
        model,
        max_tokens: 500,
        system: [
            {
                type: "text",
                text: [
                    "Você é o assistente de um ATENDENTE HUMANO de um escritório que ajuda",
                    "vítimas de acidente a conseguir o Auxílio-Acidente do INSS, num",
                    "atendimento por WhatsApp. Sua tarefa: escrever a PRÓXIMA mensagem que o",
                    "atendente deveria enviar ao cliente, com base na conversa e na ficha.",
                    "",
                    "Regras:",
                    "- Escreva em português do Brasil, tom humano, caloroso e profissional.",
                    "- Mensagem CURTA (é WhatsApp). No máximo 1 emoji, e só se fizer sentido.",
                    "- Responda à ÚLTIMA mensagem do cliente; se houver pergunta pendente, responda-a.",
                    "- NUNCA prometa prazos, ligações, valores ou aprovação do benefício.",
                    "- NUNCA revele CPF, RG, endereço ou dados sensíveis.",
                    "- NUNCA invente status do processo além do que está nos dados.",
                    "- Não dê aconselhamento jurídico específico.",
                    "- Responda SOMENTE com o texto da mensagem sugerida, sem aspas nem preâmbulo.",
                ].join("\n"),
                cache_control: { type: "ephemeral" },
            },
            {
                type: "text",
                text: [
                    `Nome do cliente: ${nome ?? "não informado"}`,
                    agentName ? `Nome do atendente: ${agentName}` : null,
                    processInfo
                        ? `Cadastro: SIM — nome ${processInfo.name ?? "—"}, etapa "${processInfo.etapa ?? "—"}", serviço ${processInfo.service ?? "—"}.`
                        : "Cadastro: número sem vínculo no sistema.",
                    memory ? `Ficha da conversa: ${clipText(memory, 1500)}` : null,
                ].filter(Boolean).join("\n"),
            },
        ],
        messages: [{
            role: "user",
            content: transcript
                ? `Conversa até agora:\n${transcript}\n\nEscreva a próxima mensagem do atendente.`
                : "Sem histórico disponível. Escreva uma mensagem inicial cordial do atendente.",
        }],
    });

    const text = response.content.find((b) => b.type === "text")?.text?.trim();
    if (!text) throw new Error("sugestão vazia");
    return { suggestion: text, usage: usageFrom(response, model) };
}

// ---------------------------------------------------------------------------
// RESUMO CURTO da conversa (vira comentário no card do kanban ao vincular).
// ---------------------------------------------------------------------------
async function summarize({ contact, history = [], memory = null }) {
    const model = process.env.MODEL_SMALL || "claude-haiku-4-5-20251001";

    const transcript = pruneHistory(history, 2600)
        .map((h) => `${h.role === "client" ? "Cliente" : h.role === "agent" ? "Atendente" : "Bot"}: ${h.text}`)
        .join("\n");

    const response = await anthropic.messages.create({
        model,
        max_tokens: 400,
        system: [
            "Você resume conversas de WhatsApp de um escritório que atende vítimas de",
            "acidente (Auxílio-Acidente do INSS). Escreva um resumo BEM CURTO em",
            "português do Brasil, no máximo 5 linhas, formato de tópicos com '- '.",
            "Cubra apenas o essencial: quem é o cliente, o que aconteceu (acidente/",
            "lesão/INSS), o que foi decidido (qualificado? dúvida? documentos?) e",
            "pendências. Sem CPF/RG/endereço. Responda SOMENTE com os tópicos.",
        ].join("\n"),
        messages: [{
            role: "user",
            content:
                `Nome do cliente: ${contact?.name ?? "não informado"}\n` +
                (memory ? `Ficha da conversa: ${clipText(memory, 1500)}\n` : "") +
                (transcript ? `Conversa:\n${transcript}` : "Sem histórico disponível."),
        }],
    });

    const text = response.content.find((b) => b.type === "text")?.text?.trim();
    if (!text) throw new Error("resumo vazio");
    return { summary: text, usage: usageFrom(response, model) };
}

// ---------------------------------------------------------------------------
// Despedida contextual por inatividade (chamada pelo cron do app Next).
// Gera um fecho curto e cordial RESUMINDO o que foi tratado na conversa.
// Chamada barata (sem structured output, poucos tokens) — o app tem fallback
// de texto fixo se isto falhar.
// ---------------------------------------------------------------------------
async function farewell({ contact, history, memory }) {
    const model = process.env.MODEL || "claude-opus-4-8";

    const transcript = (Array.isArray(history) ? history : [])
        .slice(-20)
        .map((h) => `${h.role === "client" ? "Cliente" : h.role === "agent" ? "Atendente" : "Bot"}: ${h.text}`)
        .join("\n");

    const response = await anthropic.messages.create({
        model,
        max_tokens: 300,
        system: [
            "Você é o assistente de atendimento da Paraná Seguros no WhatsApp.",
            "O cliente parou de responder há mais de 40 minutos e o atendimento será encerrado por inatividade.",
            "Escreva UMA mensagem curta (2 a 4 frases) de despedida, formal porém calorosa, em português do Brasil:",
            "- Mencione brevemente o assunto tratado (com base na conversa/ficha), sem repetir detalhes sensíveis (nunca cite CPF, endereço ou documentos).",
            "- Diga que o atendimento está sendo encerrado por falta de retorno.",
            "- Convide a pessoa a mandar mensagem a qualquer momento para continuar.",
            "Responda SOMENTE com o texto da mensagem, sem aspas nem preâmbulo.",
        ].join("\n"),
        messages: [{
            role: "user",
            content:
                `Nome do cliente: ${contact?.name ?? "não informado"}\n` +
                (memory ? `Ficha da conversa: ${memory}\n` : "") +
                (transcript ? `Conversa:\n${transcript}` : "Sem histórico disponível."),
        }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const text = String(textBlock?.text ?? "").trim();
    if (!text) throw new Error("despedida vazia");
    return text;
}

module.exports = { decide, farewell, suggest, summarize, transcribeAudio };
