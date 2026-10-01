# Chatbot WhatsApp — DPVAT Paraná

Microserviço de IA do atendimento por WhatsApp (mesmo padrão do `docx-converter`:
Node + Express, deploy no Railway, 1 instância).

## O que ele faz (e o que NÃO faz)

```
Meta Cloud API ──webhook──▶ app Next (Vercel)
                              │ grava mensagem no Postgres + broadcast SSE
                              │ conversa em modo "bot"?
                              ▼
                        POST /reply AQUI ──▶ Gemini decide
                              │
                              ◀── { reply, action, memory, state, ... }
                              │
             Next envia pro WhatsApp (com delay humanizado), persiste a
             memória/estado da conversa e executa a ação:
               qualify     → fila de espera + tag "Qualificada"
               disqualify  → encerra o ticket como "não qualificada"
               handoff     → fila de distribuição
               lookup      → roda a consulta pedida e chama /reply de novo
```

- **Faz:** triagem de elegibilidade (auxílio-acidente), coleta de dados,
  detecção de intenção/emoção/urgência, entende **áudio** (Gemini multimodal),
  memória de fatos + estado da conversa (devolvidos pra persistência no Next),
  validação de CPF/email/data em código.
- **Não faz:** não acessa banco, não fala com a API do WhatsApp, não guarda
  estado. Se este serviço cair ou der erro, o app Next joga a conversa DIRETO
  na fila de distribuição — **sem** mandar mensagem de erro pro cliente.

## Rodar local

```bash
nvm use 20.2.0   # o serviço exige Node >= 18.18
npm install
npm start        # porta 3003
```

## Variáveis de ambiente (.env)

| Nome | O quê |
|------|-------|
| `GOOGLE_API_KEY` | mesma chave Gemini do app Next |
| `BOT_SECRET` | segredo compartilhado com o app Next (`CHATBOT_SECRET` lá) |
| `GEMINI_MODEL` | opcional, default `gemini-2.5-flash` |
| `TRANSCRIBE_THINKING_BUDGET` | opcional; sem ela o Gemini da transcrição pensa no padrão do modelo. `0` desliga o thinking (mais rápido): só depois de A/B de qualidade no staging |
| `PORT` | fornecido pelo Railway (local: 3003) |

## Contrato

`POST /reply` (header `x-bot-secret`):

```json
{
  "contact": { "name": "Maria", "phone": "5541999999999" },
  "processInfo": { "name": "Maria da Silva", "etapa": "Solicitar Prontuário", "service": "DPVAT" },
  "history": [{ "role": "client", "text": "oi" }, { "role": "bot", "text": "Olá!" }],
  "message": "como anda meu processo?",
  "media": { "url": "https://s3...presigned", "mimeType": "audio/ogg" },
  "memory": "Nome: João | Cidade: Curitiba | Acidente: moto 03/2025",
  "state": "triagem_sequela",
  "failCount": 0,
  "business": { "open": false, "reopens": "amanhã às 08h" },
  "lookupResult": { "kind": "documentos_enviados", "data": { "quantidade": 3 } }
}
```

`message` pode ser `""` quando a mensagem é só áudio (`media`). `lookupResult`
só vai na segunda chamada, quando a primeira devolveu `action: "lookup"`.

Header opcional `x-bot-budget-ms`: quanto o `/reply` pode gastar (o CRM manda
o timeout da tentativa menos 3 s; sem o header, 40 s; limitado a 5–60 s).
Estourou o prazo, ou o CRM desconectou, o trabalho em andamento é abortado
(nenhuma chamada nova ao Claude/Gemini sai) e a resposta é
`504 { "error": "deadline", "detail": "prazo do CRM esgotado" }`, que o CRM
conta como timeout. Os áudios do lote são transcritos em paralelo.

Resposta:

```json
{
  "reply": "…",
  "action": "continue | qualify | disqualify | handoff | lookup",
  "handoffReason": "…",
  "lookup": "status_processo | dados_cadastro | documentos_enviados | null",
  "memory": "ficha completa atualizada",
  "state": "coleta_cpf",
  "intent": "novo_lead | cliente_existente | duvida | financeiro | suporte | documentos | reclamacao | outro",
  "emotion": "neutro | triste | irritado | ansioso | confuso | feliz",
  "urgent": false,
  "understood": true,
  "confidence": 0.9
}
```

### Pedido do atendente em aberto (30/09/2026)

Campos novos, todos opcionais e DENTRO de objetos que o `index.js` já repassa
inteiros (campo novo de topo precisa entrar no destructuring do `index.js`):

- `conversationFacts.attendantRequest`: `{ text (≤1500), source: "devolver" | "lista_atendente" | "fluxo_ia", at (ISO), returnedToBot, docsSinceOpened, nudges, flowName? }`
- `conversationFacts.docsThisTurn` (foto/PDF desde a última saída, sem teto), `burstTruncated`, `cardColumn` (nome da coluna do card), `contractPending: { link, sentAt }` (último link da ZapSign mandado por atendente)
- `priorOutcome.returnedByAttendant`, `priorOutcome.returnedAt`
- `mediaList[].fileName` (`midia.*` = sem nome)

Resposta do `/reply` ganha `handoffAfterFlow` (boolean; só vale com
`action: "send_flow"` + `flowName` + `handoffReason`: o CRM manda o fluxo e
depois transfere, sem texto de transferência — caso "assinei"), `keepRequest`
(boolean; só vale com `action: "handoff"`: o CRM transfere MANTENDO o pedido
em aberto — "assinei" com a LISTA já mandada, cliente ocupado/pede ligação),
`rationale` (≤600 caracteres, NUNCA vai ao cliente), `model` e
`brain: { source: "crm" | "fallback", instructionsVersion, playbookVersion, stale }`.

`/followup-decision` aceita o header `x-bot-budget-ms` (como o `/reply`; a
cobrança do pedido em aberto do CRM manda ~32 s): estourou ou o CRM
desconectou → 504 `{ error: "deadline" }`. A cobrança roda com raciocínio no
esforço `low` e `max_tokens` 1500 (`pendingCallConfig`).

**As instruções publicadas citam estas strings do bloco dinâmico ao pé da
letra** (`renderConversationFacts`, `renderAttendantRequest`,
`renderReturnedByTeam` em `bot.js`; os testes em `test/` travam o texto):

- `ESTE ATENDIMENTO (fatos do sistema):`
- `- Arquivos (foto/PDF) que chegaram NESTE turno: N — K aberto(s) e anexado(s) a esta mensagem, M NÃO aberto(s).`
- `- Arquivos (foto/PDF) recebidos ANTES deste turno, neste atendimento: N.`
- `- Parte deste lote não coube nesta chamada (mensagens/arquivos a mais).`
- `- O número está vinculado a um cadastro no sistema (cliente com processo).`
- `- Coluna do card no kanban: X.`
- `- Contrato enviado pelo atendente em DD/MM às HH:MM, ainda sem confirmação de assinatura no kanban. Link enviado: <link>`
- `- Houve mensagem de um atendente da equipe para este cliente nos últimos 7 dias.`
- `PEDIDO DO ATENDENTE EM ABERTO (fatos do sistema):` com `- Quem pediu:`, `- Origem:`, `- Devolvido ao bot depois do pedido:`, `- Arquivos recebidos desde o pedido:`, `- Cobranças automáticas já enviadas:`, `- Texto do pedido:` (linhas citadas com `  | `)
- `CONVERSA DEVOLVIDA PELA EQUIPE (fatos do sistema):`
- ETAPA `nenhuma em andamento (última registrada: X; depois dela a conversa esteve com a equipe)`; FICHA `(vazia)`; `Tentativas seguidas sem entender até agora: N.`
- nota por turno `[FATO DO SISTEMA: a última mensagem enviada ao cliente antes desta foi de um [atendente] da equipe, não sua.]`
- rótulo de anexo `[anexo k de N: PDF "nome"]`

`POST /followup-decision` aceita `pendingRequest: { text, source, at,
flowName?, docsSinceOpened, attempt, windowClosesAt, lastClientAt,
previousMissing? }` (cobrança do pedido em aberto) e devolve
`{ mode: "pending", action: "nudge" | "silent" | "handoff", message, missing, reason, leaked, usage }`.
Sem `pendingRequest`, o modo antigo devolve
`{ mode: "followup", action: "nudge" | "close", message, reason, usage }`.

`GET /health` → `{ ok: true }`.

## Testes

```bash
npm test   # node --test: funções puras + decide()/followupDecision() com o Claude trocado por dublê
```

## Deploy no Railway

1. Criar novo serviço apontando para esta pasta (repo próprio ou monorepo).
2. Setar `GOOGLE_API_KEY` e `BOT_SECRET`.
3. No Vercel do app Next, setar `CHATBOT_URL` = URL pública deste serviço,
   `CHATBOT_SECRET` = o mesmo `BOT_SECRET` e `CRON_SECRET` (cron de silêncio).
