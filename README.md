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

`GET /health` → `{ ok: true }`.

## Deploy no Railway

1. Criar novo serviço apontando para esta pasta (repo próprio ou monorepo).
2. Setar `GOOGLE_API_KEY` e `BOT_SECRET`.
3. No Vercel do app Next, setar `CHATBOT_URL` = URL pública deste serviço,
   `CHATBOT_SECRET` = o mesmo `BOT_SECRET` e `CRON_SECRET` (cron de silêncio).
